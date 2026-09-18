import { and, eq, isNull, sql } from "@kaname/db";
import { alertRules, alerts, servers } from "@kaname/db/schema";
import type { MetricName } from "@kaname/contract";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * Alert rules, evaluated.
 *
 * A rule says "metric, comparator, threshold, for this long". Every
 * minute each enabled rule is checked against every server in its
 * scope using the raw samples the reconciler keeps: the condition has
 * to hold across the whole window to fire (the worst sample in the
 * window is compared, not the average, so one quiet second cannot mask
 * a sustained breach and one spike cannot fake one), and it resolves
 * the moment the latest sample is back inside the line. Both edges are
 * published on the bus, which is how the panel and the notifier learn
 * about them; a rule's own channel list narrows who is told.
 * ------------------------------------------------------------------ */

const TICK_MS = 60_000;
const FIRST_TICK_MS = 30_000;
/** Samples arrive every 15 s; the window counts as covered a bit short of its full length. */
const COVERAGE_SLACK_S = 30;

interface RuleRow {
  id: string;
  name: string;
  metric: MetricName;
  comparator: "gt" | "gte" | "lt" | "lte";
  threshold: number;
  durationSeconds: number;
  severity: "info" | "warning" | "critical";
  scope: { kind: "fleet" } | { kind: "servers"; server_ids: string[] };
  channels: string[];
}

interface Window {
  lo: number | null;
  hi: number | null;
  latest: number | null;
  covered: boolean;
}

/** The SQL that turns a sample row into the number a rule compares. */
const METRIC_SQL: Record<MetricName, string> = {
  cpu: "cpu_percent",
  memory: "memory_used * 100.0 / nullif(memory_total, 0)",
  swap: "swap_used * 100.0 / nullif(swap_total, 0)",
  disk: "(select max((d->>'used_percent')::float) from jsonb_array_elements(disks) d)",
  disk_io: "coalesce(disk_read_rate, 0) + coalesce(disk_write_rate, 0)",
  network_rx: "net_rx_rate",
  network_tx: "net_tx_rate",
  load1: "load1",
  load5: "load5",
  load15: "load15",
  processes: "processes",
};

const METRIC_LABEL: Record<MetricName, [label: string, unit: string]> = {
  cpu: ["CPU", "%"],
  memory: ["memory", "%"],
  swap: ["swap", "%"],
  disk: ["disk", "% full"],
  disk_io: ["disk I/O", " B/s"],
  network_rx: ["network in", " B/s"],
  network_tx: ["network out", " B/s"],
  load1: ["load (1m)", ""],
  load5: ["load (5m)", ""],
  load15: ["load (15m)", ""],
  processes: ["processes", ""],
};

const COMPARATOR: Record<RuleRow["comparator"], string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

export class AlertEvaluator {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.evaluate(), TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.evaluate(), FIRST_TICK_MS);
    this.first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
  }

  /** One pass over every enabled rule. Safe to call directly; ticks never overlap. */
  async evaluate(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rules = (await this.ctx.db
        .select()
        .from(alertRules)
        .where(eq(alertRules.enabled, true))) as unknown as RuleRow[];
      if (rules.length === 0) return;

      const fleet = await this.ctx.db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .where(and(isNull(servers.revokedAt), sql`${servers.enrolledAt} is not null`));

      for (const rule of rules) {
        const targets =
          rule.scope.kind === "fleet"
            ? fleet
            : fleet.filter(
                (server) =>
                  rule.scope.kind === "servers" && rule.scope.server_ids.includes(server.id),
              );
        for (const server of targets) {
          try {
            await this.evaluateOne(rule, server);
          } catch (err) {
            this.ctx.log.warn(
              { err, rule: rule.name, serverId: server.id },
              "alert evaluation failed",
            );
          }
        }
      }
    } catch (err) {
      this.ctx.log.warn({ err }, "alert evaluation failed");
    } finally {
      this.running = false;
    }
  }

  private async evaluateOne(rule: RuleRow, server: { id: string; name: string }): Promise<void> {
    const window = await this.window(rule, server.id);
    const { db, events } = this.ctx;

    const [open] = await db
      .select()
      .from(alerts)
      .where(
        and(eq(alerts.ruleId, rule.id), eq(alerts.serverId, server.id), isNull(alerts.resolvedAt)),
      )
      .limit(1);

    // No sample in the window: a host that is not reporting is the
    // reconciler's business (it goes "unknown"), not a metric breach.
    if (window.latest === null) return;

    const worst = rule.comparator === "gt" || rule.comparator === "gte" ? window.lo : window.hi;
    const breachedNow = breaches(rule, window.latest);
    const sustained = breachedNow && worst !== null && breaches(rule, worst) && window.covered;

    if (sustained) {
      const message = describe(rule, worst!);
      if (!open) {
        const [row] = await db
          .insert(alerts)
          .values({
            ruleId: rule.id,
            serverId: server.id,
            state: "firing",
            severity: rule.severity,
            value: worst!,
            threshold: rule.threshold,
            message,
          })
          .returning({ id: alerts.id });
        events.publish(
          "alerts",
          "alert.firing",
          this.payload(row!.id, rule, server, worst!, message),
          server.id,
        );
        return;
      }
      if (open.state === "pending") {
        await db
          .update(alerts)
          .set({ state: "firing", value: worst!, message, updatedAt: new Date() })
          .where(eq(alerts.id, open.id));
        events.publish(
          "alerts",
          "alert.firing",
          this.payload(open.id, rule, server, worst!, message),
          server.id,
        );
        return;
      }
      if (open.state === "firing" && open.value !== worst) {
        await db
          .update(alerts)
          .set({ value: worst!, message, updatedAt: new Date() })
          .where(eq(alerts.id, open.id));
      }
      return;
    }

    if (breachedNow) {
      // Over the line right now, but not for long enough yet.
      if (!open) {
        await db.insert(alerts).values({
          ruleId: rule.id,
          serverId: server.id,
          state: "pending",
          severity: rule.severity,
          value: window.latest,
          threshold: rule.threshold,
          message: describe(rule, window.latest),
        });
      }
      return;
    }

    if (open) {
      const wasFiring = open.state === "firing";
      await db
        .update(alerts)
        .set({
          state: "resolved",
          resolvedAt: new Date(),
          value: window.latest,
          updatedAt: new Date(),
        })
        .where(eq(alerts.id, open.id));
      if (wasFiring) {
        const message = `${describe(rule, open.value)} — back to ${format(rule, window.latest)}.`;
        events.publish(
          "alerts",
          "alert.resolved",
          this.payload(open.id, rule, server, window.latest, message),
          server.id,
        );
      }
    }
  }

  private payload(
    alertId: string,
    rule: RuleRow,
    server: { id: string; name: string },
    value: number,
    message: string,
  ): Record<string, unknown> {
    return {
      alert_id: alertId,
      rule_id: rule.id,
      rule_name: rule.name,
      title: rule.name,
      server_id: server.id,
      server_name: server.name,
      severity: rule.severity,
      value,
      threshold: rule.threshold,
      message,
      channels: rule.channels,
    };
  }

  private async window(rule: RuleRow, serverId: string): Promise<Window> {
    const expr = sql.raw(METRIC_SQL[rule.metric]);
    const seconds = Math.max(15, rule.durationSeconds);
    const since = sql.raw(`now() - interval '${seconds} seconds'`);
    const slack = sql.raw(`now() - interval '${Math.max(0, seconds - COVERAGE_SLACK_S)} seconds'`);
    const result = (await this.ctx.db.execute(sql`
      select
        min(${expr})::float as lo,
        max(${expr})::float as hi,
        (select ${expr}::float from server_metrics
           where server_id = ${serverId} order by ts desc limit 1) as latest,
        (min(ts) <= ${slack}) as covered
      from server_metrics
      where server_id = ${serverId} and ts > ${since}
    `)) as { rows?: Record<string, unknown>[] };
    const row = result.rows?.[0] ?? {};
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return {
      lo: num(row.lo),
      hi: num(row.hi),
      latest: num(row.latest),
      covered: row.covered === true,
    };
  }
}

function breaches(rule: RuleRow, value: number): boolean {
  switch (rule.comparator) {
    case "gt":
      return value > rule.threshold;
    case "gte":
      return value >= rule.threshold;
    case "lt":
      return value < rule.threshold;
    case "lte":
      return value <= rule.threshold;
  }
}

function format(rule: RuleRow, value: number): string {
  const [, unit] = METRIC_LABEL[rule.metric];
  const rounded = Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded}${unit}`;
}

function describe(rule: RuleRow, value: number): string {
  const [label] = METRIC_LABEL[rule.metric];
  return `${label} ${format(rule, value)} ${COMPARATOR[rule.comparator]} ${format(rule, rule.threshold)} for ${rule.durationSeconds}s`;
}
