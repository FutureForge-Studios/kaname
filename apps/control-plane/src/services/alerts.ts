import { and, eq, isNull, sql } from "@kaname/db";
import { alertRules, alerts, servers } from "@kaname/db/schema";
import type { AlertRuleMetric, MetricName } from "@kaname/contract";
import type { AppContext } from "../context.js";
import { AppHealthMonitor } from "./app-health.js";
import { appTargets, appWindow, describeApp, type AppTarget } from "./alerts-apps.js";

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

export interface RuleRow {
  id: string;
  name: string;
  metric: AlertRuleMetric;
  comparator: "gt" | "gte" | "lt" | "lte";
  threshold: number;
  durationSeconds: number;
  severity: "info" | "warning" | "critical";
  scope:
    | { kind: "fleet" }
    | { kind: "servers"; server_ids: string[] }
    | { kind: "app"; app_install_id: string };
  channels: string[];
  appInstallId: string | null;
}

/**
 * What a rule is checked against over its window. `lo`/`hi` bound the
 * window's samples; `latest` is the newest; `covered` says the window
 * reaches back far enough for a breach in it to count as sustained.
 */
export interface Window {
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

export const COMPARATOR: Record<RuleRow["comparator"], string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

export class AlertEvaluator {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;
  /** Collects the samples app rules read (HTTP probes, containers). */
  readonly apps: AppHealthMonitor;

  constructor(private readonly ctx: AppContext) {
    this.apps = new AppHealthMonitor(ctx);
  }

  start(): void {
    if (this.timer) return;
    this.apps.start();
    this.timer = setInterval(() => void this.evaluate(), TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.evaluate(), FIRST_TICK_MS);
    this.first.unref?.();
  }

  stop(): void {
    this.apps.stop();
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

      const appRules = rules.filter((rule) => rule.appInstallId !== null);
      if (appRules.length > 0) {
        const targets = await appTargets(this.ctx, appRules);
        for (const rule of appRules) {
          const target = targets.get(rule.appInstallId!);
          if (!target) continue;
          try {
            await this.evaluateApp(rule, target);
          } catch (err) {
            this.ctx.log.warn(
              { err, rule: rule.name, appInstallId: rule.appInstallId },
              "app alert evaluation failed",
            );
          }
        }
      }

      for (const rule of rules) {
        if (rule.appInstallId !== null) continue;
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
    await this.transition(rule, server, window, {
      describe: (value) => describe(rule, value),
      resolvedSuffix: (value) => format(rule, value),
      extra: {},
    });
  }

  /** An app rule: the same lifecycle, read from the install's health samples. */
  private async evaluateApp(rule: RuleRow, target: AppTarget): Promise<void> {
    const window = await appWindow(this.ctx, rule, target);
    const app = describeApp(rule, target);
    await this.transition(rule, { id: target.serverId, name: target.serverName }, window, {
      describe: app.describe,
      resolvedSuffix: app.format,
      extra: app.extra,
    });
  }

  /**
   * The one open/resolve lifecycle every rule goes through. At most one
   * open alert per (rule, server) — the alerts_open_key index — which is
   * also what dedups: a breach that persists updates its row instead of
   * opening another, and only the edges (firing, resolved) are published.
   */
  private async transition(
    rule: RuleRow,
    server: { id: string; name: string },
    window: Window,
    text: {
      describe: (value: number) => string;
      resolvedSuffix: (value: number) => string;
      extra: Record<string, unknown>;
    },
  ): Promise<void> {
    const { db, events } = this.ctx;
    const describe = text.describe;

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
      const message = describe(worst!);
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
          this.payload(row!.id, rule, server, worst!, message, text.extra),
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
          this.payload(open.id, rule, server, worst!, message, text.extra),
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
          message: describe(window.latest),
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
        const message = `${describe(open.value)} — back to ${text.resolvedSuffix(window.latest)}.`;
        events.publish(
          "alerts",
          "alert.resolved",
          this.payload(open.id, rule, server, window.latest, message, text.extra),
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
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...extra,
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
    const expr = sql.raw(METRIC_SQL[rule.metric as MetricName]);
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

export function breaches(
  rule: Pick<RuleRow, "comparator" | "threshold">,
  value: number,
): boolean {
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
  const [, unit] = METRIC_LABEL[rule.metric as MetricName];
  const rounded = Math.abs(value) >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded}${unit}`;
}

function describe(rule: RuleRow, value: number): string {
  const [label] = METRIC_LABEL[rule.metric as MetricName];
  return `${label} ${format(rule, value)} ${COMPARATOR[rule.comparator]} ${format(rule, rule.threshold)} for ${rule.durationSeconds}s`;
}
