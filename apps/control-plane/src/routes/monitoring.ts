import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, sql, type Database } from "@kaname/db";
import { alertRules, alerts, serverMetrics, serverMetrics5m, servers } from "@kaname/db/schema";
import {
  alertSeverity,
  alertState,
  createAlertRuleInput,
  idParam,
  listQuery,
  seriesQuery,
  uuid,
  type Alert,
  type AlertRule,
  type MetricName,
  type MetricSeries,
  type MonitoringOverview,
} from "@kaname/contract";
import { z } from "zod";
import {
  helpers,
  item,
  list,
  noContent,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { ApiException, notFound } from "../lib/errors.js";
import {
  combine,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  visibleServerIds,
  type ServerRow,
} from "./_shared.js";
import { rangeMs } from "./servers.js";

/* ------------------------------------------------------------------ *
 * Monitoring.
 *
 * Every series is bucketed in Postgres, never in the browser: the
 * client asks for a range and receives at most a couple of hundred
 * points regardless of whether that range holds 90 samples or 90 days
 * of them. Short ranges read the raw table, long ranges the 5-minute
 * rollup, so a 90-day chart never scans a million rows.
 * ------------------------------------------------------------------ */

const SPARKLINE_POINTS = 96;
const SPARKLINE_WINDOW_MS = 24 * 3_600_000;

/** Bucket size per range, chosen so every chart lands near 100–200 points. */
const DEFAULT_STEP_SECONDS: Record<string, number> = {
  "1h": 60,
  "6h": 300,
  "24h": 900,
  "7d": 3600,
  "30d": 14_400,
  "90d": 43_200,
};

/**
 * Per-metric SQL. `row` is evaluated per sample and `agg` collapses a
 * bucket. Both halves come from this frozen table and never from user
 * input, which is what makes the raw fragments safe.
 */
const METRIC_SOURCES: Record<
  MetricName,
  { row: string; agg: "avg" | "max"; unit: MetricSeries["unit"] }
> = {
  cpu: { row: "cpu_percent", agg: "avg", unit: "percent" },
  memory: { row: "memory_used", agg: "avg", unit: "bytes" },
  swap: { row: "swap_used", agg: "avg", unit: "bytes" },
  disk: {
    row: "coalesce((select max((d->>'used_percent')::float8) from jsonb_array_elements(disks) d), 0)",
    agg: "max",
    unit: "percent",
  },
  disk_io: {
    row: "coalesce(disk_read_rate, 0) + coalesce(disk_write_rate, 0)",
    agg: "avg",
    unit: "bytes_per_second",
  },
  network_rx: { row: "net_rx_rate", agg: "avg", unit: "bytes_per_second" },
  network_tx: { row: "net_tx_rate", agg: "avg", unit: "bytes_per_second" },
  load1: { row: "load1", agg: "avg", unit: "load" },
  load5: { row: "load5", agg: "avg", unit: "load" },
  load15: { row: "load15", agg: "avg", unit: "load" },
  processes: { row: "processes", agg: "avg", unit: "count" },
};

/** An alert rule targets the fleet or a server list — not an RBAC scope. */
type AlertRuleScope = AlertRule["scope"];

const SORTABLE_ALERTS = {
  started_at: alerts.startedAt,
  severity: alerts.severity,
  state: alerts.state,
  value: alerts.value,
} as const;

const SORTABLE_RULES = {
  name: alertRules.name,
  metric: alertRules.metric,
  severity: alertRules.severity,
  created_at: alertRules.createdAt,
} as const;

const alertListQuery = listQuery.extend({
  server_id: uuid.optional(),
  state: alertState.optional(),
  severity: alertSeverity.optional(),
  acknowledged: z.coerce.boolean().optional(),
});

const alertRuleListQuery = listQuery.extend({
  enabled: z.coerce.boolean().optional(),
  severity: alertSeverity.optional(),
});

const updateAlertRuleInput = createAlertRuleInput.partial();

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- overview ---------------------------- */

  app.get("/monitoring/overview", async (req, reply) => {
    helpers(req).authorize("monitoring.metrics:read");

    const rows = await req.ctx.db
      .select()
      .from(servers)
      .where(combine(scopeFilter(req, "monitoring.metrics:read", servers.id)))
      .orderBy(asc(servers.name));

    const ids = rows.map((r) => r.id);
    const latest = await latestSamples(req.ctx.db, ids);

    const openAlerts =
      ids.length === 0
        ? 0
        : ((
            await req.ctx.db
              .select({ n: sql<number>`count(*)::int` })
              .from(alerts)
              .where(and(inArray(alerts.serverId, ids), isNull(alerts.resolvedAt)))
          )[0]?.n ?? 0);

    const sparklines = await bucketedSeries(req.ctx.db, {
      metric: "cpu",
      serverIds: ids,
      since: new Date(Date.now() - SPARKLINE_WINDOW_MS),
      stepSeconds: SPARKLINE_WINDOW_MS / 1000 / SPARKLINE_POINTS,
      raw: false,
    });

    const overview: MonitoringOverview = {
      fleet: rollup(rows, latest, openAlerts),
      servers: rows.map((row) => {
        const sample = latest.get(row.id);
        return {
          server_id: row.id,
          name: row.name,
          connection: row.connection,
          health: row.health,
          cpu_percent: clampPercent(sample?.cpuPercent ?? 0),
          memory_percent: clampPercent(ratio(sample?.memoryUsed, sample?.memoryTotal)),
          disk_percent: clampPercent(worstDisk(sample)),
          load1: sample?.load1 ?? 0,
          uptime_seconds: row.bootTime
            ? Math.floor((Date.now() - row.bootTime.getTime()) / 1000)
            : null,
          sparkline: (sparklines.get(row.id) ?? []).map((p) => p.value).slice(-SPARKLINE_POINTS),
        };
      }),
    };

    return item(reply, overview);
  });

  /* ----------------------------- series ----------------------------- */

  app.get("/monitoring/series", async (req, reply) => {
    const q = parseQuery(req, seriesQuery);
    helpers(req).authorize("monitoring.metrics:read");

    let targets: ServerRow[];
    if (q.server_id) {
      targets = [await loadServer(req, q.server_id, "monitoring.metrics:read")];
    } else {
      targets = await req.ctx.db
        .select()
        .from(servers)
        .where(combine(scopeFilter(req, "monitoring.metrics:read", servers.id)))
        .orderBy(asc(servers.name));
    }

    const span = rangeMs(q.range);
    // The raw table is pruned aggressively, so anything older than its
    // retention has to come from the rollup or it would simply be empty.
    const raw = span <= req.ctx.config.RAW_METRICS_RETENTION_HOURS * 3_600_000;
    const floorStep = raw ? 10 : 300;
    const stepSeconds = Math.max(q.step ?? DEFAULT_STEP_SECONDS[q.range] ?? 900, floorStep);

    const points = await bucketedSeries(req.ctx.db, {
      metric: q.metric,
      serverIds: targets.map((s) => s.id),
      since: new Date(Date.now() - span),
      stepSeconds,
      raw,
    });

    const series: MetricSeries[] = targets.map((server) => ({
      server_id: server.id,
      server_name: server.name,
      metric: q.metric,
      unit: METRIC_SOURCES[q.metric].unit,
      points: points.get(server.id) ?? [],
    }));

    return item(reply, {
      metric: q.metric,
      range: q.range,
      step_seconds: stepSeconds,
      resolution: raw ? "raw" : "5m",
      unit: METRIC_SOURCES[q.metric].unit,
      series,
    });
  });

  /* ----------------------------- alerts ----------------------------- */

  app.get("/monitoring/alerts", async (req, reply) => {
    const q = parseQuery(req, alertListQuery);
    helpers(req).authorize("monitoring.alerts:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "monitoring.alerts:read", alerts.serverId),
      q.server_id ? eq(alerts.serverId, q.server_id) : null,
      q.state ? eq(alerts.state, q.state) : null,
      q.severity ? eq(alerts.severity, q.severity) : null,
      q.acknowledged === true ? sql`${alerts.acknowledgedAt} is not null` : null,
      q.acknowledged === false ? isNull(alerts.acknowledgedAt) : null,
      term
        ? sql`(lower(${alerts.message}) like ${term} or lower(${alertRules.name}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_ALERTS, q.sort, "started_at");
    const rows = await req.ctx.db
      .select({ alert: alerts, ruleName: alertRules.name, serverName: servers.name })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(servers, eq(alerts.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(servers, eq(alerts.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toAlert(r.alert, r.ruleName, r.serverName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.post("/monitoring/alerts/:id/acknowledge", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);

    const rows = await req.ctx.db
      .select({ alert: alerts, ruleName: alertRules.name, serverName: servers.name })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(servers, eq(alerts.serverId, servers.id))
      .where(eq(alerts.id, id))
      .limit(1);

    const found = rows[0];
    if (!found) throw notFound("Alert", id);
    const principal = h.authorize("monitoring.alerts:write", found.alert.serverId);

    if (found.alert.acknowledgedAt) {
      throw new ApiException("conflict", `This alert was already acknowledged.`, {
        detail: { acknowledged_at: found.alert.acknowledgedAt.toISOString() },
        remediation: {
          summary: "Nothing more to do here — resolve the underlying condition to clear the alert.",
          actions: [{ label: "Open monitoring", href: "/monitoring" }],
        },
      });
    }

    const [row] = await req.ctx.db
      .update(alerts)
      .set({
        acknowledgedAt: new Date(),
        acknowledgedBy: principal.kind === "user" ? principal.id : null,
        updatedAt: new Date(),
      })
      .where(eq(alerts.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "alert.acknowledged",
      targetType: "alert",
      targetId: id,
      targetLabel: found.ruleName,
      serverId: found.alert.serverId,
      metadata: { severity: found.alert.severity, value: found.alert.value },
    });
    req.ctx.events.publish("alerts", "alert.acknowledged", { alert_id: id }, found.alert.serverId);

    return item(reply, toAlert(row!, found.ruleName, found.serverName));
  });

  /* --------------------------- alert rules -------------------------- */

  app.get("/monitoring/alert-rules", async (req, reply) => {
    const q = parseQuery(req, alertRuleListQuery);
    helpers(req).authorize("monitoring.alerts:read");

    const term = searchTerm(q.q);
    const where = combine(
      q.enabled !== undefined ? eq(alertRules.enabled, q.enabled) : null,
      q.severity ? eq(alertRules.severity, q.severity) : null,
      term
        ? sql`(lower(${alertRules.name}) like ${term} or lower(${alertRules.metric}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_RULES, q.sort, "name");
    const rows = await req.ctx.db
      .select()
      .from(alertRules)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(alertRules)
      .where(where);

    // A rule scoped to servers the caller cannot see would leak their ids.
    const visible = visibleServerIds(req, "monitoring.alerts:read");
    return list(
      reply,
      rows.filter((r) => ruleIsVisible(r.scope, visible)).map(toRule),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/monitoring/alert-rules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("monitoring.alerts:read");

    const rule = await loadRule(req, id);
    if (!ruleIsVisible(rule.scope, visibleServerIds(req, "monitoring.alerts:read"))) {
      throw notFound("Alert rule", id);
    }
    return item(reply, toRule(rule));
  });

  app.post("/monitoring/alert-rules", async (req, reply) => {
    const body = parseBody(req, createAlertRuleInput);
    const h = helpers(req);
    h.authorize("monitoring.alerts:write");
    assertRuleScope(req, body.scope);

    const [row] = await req.ctx.db
      .insert(alertRules)
      .values({
        name: body.name,
        metric: body.metric,
        comparator: body.comparator,
        threshold: body.threshold,
        durationSeconds: body.duration_seconds,
        severity: body.severity,
        scope: body.scope,
        enabled: body.enabled ?? true,
        channels: body.channels ?? [],
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "alert_rule.created",
      targetType: "alert_rule",
      targetId: row!.id,
      targetLabel: row!.name,
      after: body,
    });
    req.ctx.events.publish("alerts", "alert_rule.created", { rule_id: row!.id });

    return item(reply, toRule(row!), 201);
  });

  app.patch("/monitoring/alert-rules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateAlertRuleInput);
    const h = helpers(req);
    h.authorize("monitoring.alerts:write");

    const before = await loadRule(req, id);
    assertRuleScope(req, before.scope);
    if (body.scope) assertRuleScope(req, body.scope);

    const [row] = await req.ctx.db
      .update(alertRules)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.metric !== undefined ? { metric: body.metric } : {}),
        ...(body.comparator !== undefined ? { comparator: body.comparator } : {}),
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        ...(body.duration_seconds !== undefined ? { durationSeconds: body.duration_seconds } : {}),
        ...(body.severity !== undefined ? { severity: body.severity } : {}),
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.channels !== undefined ? { channels: body.channels } : {}),
        updatedAt: new Date(),
      })
      .where(eq(alertRules.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "alert_rule.updated",
      targetType: "alert_rule",
      targetId: id,
      targetLabel: row!.name,
      before: toRule(before),
      after: body,
    });
    req.ctx.events.publish("alerts", "alert_rule.updated", { rule_id: id });

    return item(reply, toRule(row!));
  });

  app.delete("/monitoring/alert-rules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("monitoring.alerts:write");

    const rule = await loadRule(req, id);
    assertRuleScope(req, rule.scope);

    await req.ctx.db.delete(alertRules).where(eq(alertRules.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "alert_rule.deleted",
      targetType: "alert_rule",
      targetId: id,
      targetLabel: rule.name,
      before: toRule(rule),
    });
    req.ctx.events.publish("alerts", "alert_rule.deleted", { rule_id: id });

    return noContent(reply);
  });
}

/* ------------------------------------------------------------------ *
 * Shared with the Command Center, so the two screens can never
 * disagree about what the fleet numbers are.
 * ------------------------------------------------------------------ */

export interface LatestSample {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  swapUsed: number;
  load1: number;
  netRxRate: number;
  netTxRate: number;
  disks: { mount: string; total: number; used: number; used_percent: number }[];
  ts: Date;
}

/** One row per server: the newest sample, in a single DISTINCT ON query. */
export async function latestSamples(
  db: Database,
  serverIds: string[],
): Promise<Map<string, LatestSample>> {
  if (serverIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([serverMetrics.serverId], {
      serverId: serverMetrics.serverId,
      ts: serverMetrics.ts,
      cpuPercent: serverMetrics.cpuPercent,
      memoryUsed: serverMetrics.memoryUsed,
      memoryTotal: serverMetrics.memoryTotal,
      swapUsed: serverMetrics.swapUsed,
      load1: serverMetrics.load1,
      netRxRate: serverMetrics.netRxRate,
      netTxRate: serverMetrics.netTxRate,
      disks: serverMetrics.disks,
    })
    .from(serverMetrics)
    .where(inArray(serverMetrics.serverId, serverIds))
    .orderBy(serverMetrics.serverId, desc(serverMetrics.ts));

  return new Map(
    rows.map((r) => [
      r.serverId,
      {
        cpuPercent: r.cpuPercent,
        memoryUsed: r.memoryUsed,
        memoryTotal: r.memoryTotal,
        swapUsed: r.swapUsed,
        load1: r.load1,
        netRxRate: r.netRxRate,
        netTxRate: r.netTxRate,
        disks: r.disks,
        ts: r.ts,
      },
    ]),
  );
}

export function rollup(
  rows: ServerRow[],
  latest: Map<string, LatestSample>,
  openAlerts: number,
): MonitoringOverview["fleet"] {
  let cpuTotal = 0;
  let cpuSamples = 0;
  let memoryUsed = 0;
  let memoryTotal = 0;
  let diskUsed = 0;
  let diskTotal = 0;
  let netRx = 0;
  let netTx = 0;

  for (const row of rows) {
    const sample = latest.get(row.id);
    if (!sample) continue;
    cpuTotal += sample.cpuPercent;
    cpuSamples += 1;
    memoryUsed += sample.memoryUsed;
    memoryTotal += sample.memoryTotal;
    netRx += sample.netRxRate;
    netTx += sample.netTxRate;
    for (const disk of sample.disks ?? []) {
      diskUsed += disk.used;
      diskTotal += disk.total;
    }
  }

  return {
    servers_total: rows.length,
    servers_connected: rows.filter((r) => r.connection === "connected").length,
    servers_unhealthy: rows.filter((r) => r.health === "warning" || r.health === "critical").length,
    cpu_percent_avg: cpuSamples > 0 ? clampPercent(cpuTotal / cpuSamples) : 0,
    memory_used: Math.round(memoryUsed),
    memory_total: Math.round(memoryTotal),
    disk_used: Math.round(diskUsed),
    disk_total: Math.round(diskTotal),
    net_rx_rate: netRx,
    net_tx_rate: netTx,
    open_alerts: openAlerts,
  };
}

/**
 * Bucketing happens here rather than in the browser: a 90-day chart is
 * ~180 points off the wire instead of ~26,000 that the client would then
 * have to throw away.
 */
async function bucketedSeries(
  db: Database,
  opts: { metric: MetricName; serverIds: string[]; since: Date; stepSeconds: number; raw: boolean },
): Promise<Map<string, { ts: string; value: number }[]>> {
  const out = new Map<string, { ts: string; value: number }[]>();
  if (opts.serverIds.length === 0) return out;

  const spec = METRIC_SOURCES[opts.metric];
  const table = opts.raw ? serverMetrics : serverMetrics5m;
  const timeColumn = opts.raw ? serverMetrics.ts : serverMetrics5m.bucket;
  const step = sql.raw(String(Math.trunc(opts.stepSeconds)));
  const ids = sql.join(
    opts.serverIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const result = await db.execute(sql`
    select server_id, bucket_epoch, ${sql.raw(spec.agg)}(value)::float8 as value
    from (
      select server_id::text as server_id,
             (floor(extract(epoch from ${timeColumn}) / ${step}) * ${step})::float8 as bucket_epoch,
             (${sql.raw(spec.row)})::float8 as value
      from ${table}
      where ${timeColumn} >= ${opts.since.toISOString()}::timestamptz
        and server_id in (${ids})
    ) samples
    group by server_id, bucket_epoch
    order by server_id, bucket_epoch
  `);

  for (const raw of resultRows(result)) {
    const serverId = String(raw.server_id);
    const bucket = Number(raw.bucket_epoch);
    const value = Number(raw.value);
    if (!Number.isFinite(bucket) || !Number.isFinite(value)) continue;
    const points = out.get(serverId) ?? [];
    points.push({ ts: new Date(bucket * 1000).toISOString(), value });
    out.set(serverId, points);
  }
  return out;
}

/* Drizzle's execute() returns a driver-shaped result; normalise it. */
function resultRows(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown[] })?.rows ?? (result as unknown[]);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/* ------------------------------------------------------------------ */

async function loadRule(req: FastifyRequest, id: string): Promise<typeof alertRules.$inferSelect> {
  const rows = await req.ctx.db.select().from(alertRules).where(eq(alertRules.id, id)).limit(1);
  const rule = rows[0];
  if (!rule) throw notFound("Alert rule", id);
  return rule;
}

/**
 * A fleet-wide rule fires on servers outside a scoped grant, so writing
 * one needs the permission across the whole fleet — not merely somewhere.
 */
function assertRuleScope(req: FastifyRequest, scope: AlertRuleScope): void {
  const principal = helpers(req).requirePrincipal();

  if (scope.kind === "servers") {
    for (const serverId of scope.server_ids) {
      helpers(req).authorize("monitoring.alerts:write", serverId);
    }
    return;
  }

  if (req.ctx.auth.scope(principal, "monitoring.alerts:write") !== "global") {
    throw new ApiException(
      "forbidden",
      "A fleet-wide alert rule requires monitoring.alerts:write across the whole fleet.",
      {
        remediation: {
          summary: "Scope this rule to the servers you manage, or ask an owner for a global grant.",
          actions: [{ label: "View roles", href: "/administration/roles" }],
        },
      },
    );
  }
}

function ruleIsVisible(scope: AlertRuleScope, visible: "global" | readonly string[]): boolean {
  if (visible === "global") return true;
  if (scope.kind === "fleet") return false;
  return scope.server_ids.some((id) => visible.includes(id));
}

function toRule(row: typeof alertRules.$inferSelect): AlertRule {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric as MetricName,
    comparator: row.comparator,
    threshold: row.threshold,
    duration_seconds: row.durationSeconds,
    severity: row.severity,
    scope: row.scope,
    enabled: row.enabled,
    channels: row.channels,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toAlert(
  row: typeof alerts.$inferSelect,
  ruleName: string,
  serverName: string | null,
): Alert {
  return {
    id: row.id,
    rule_id: row.ruleId,
    rule_name: ruleName,
    server_id: row.serverId,
    server_name: serverName,
    state: row.state,
    severity: row.severity,
    value: row.value,
    threshold: row.threshold,
    message: row.message,
    started_at: row.startedAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    acknowledged_by: row.acknowledgedBy,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function ratio(used: number | undefined, total: number | undefined): number {
  if (!used || !total) return 0;
  return (used / total) * 100;
}

function worstDisk(sample: LatestSample | undefined): number {
  if (!sample?.disks?.length) return 0;
  return sample.disks.reduce((worst, d) => Math.max(worst, d.used_percent), 0);
}
