import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, sql, type Database } from "@kaname/db";
import {
  alertRules,
  alerts,
  appInstalls,
  notificationChannels,
  serverMetrics,
  serverMetrics5m,
  servers,
} from "@kaname/db/schema";
import {
  alertSeverity,
  alertState,
  createAlertRuleInput,
  idParam,
  isAppAlertKind,
  listQuery,
  seriesQuery,
  uuid,
  type Alert,
  type AlertRule,
  type AlertRuleChannel,
  type MetricName,
  type MetricSeries,
  type MonitoringOverview,
  queryBoolean,
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

/** An alert rule targets the fleet, a server list or one app — not an RBAC scope. */
type AlertRuleScope = AlertRule["scope"];

/** "any" narrows a list to app rules (or their alerts) without naming one. */
const appFilter = z.union([uuid, z.literal("any")]);

/** "App on domain", the label app rules and their alerts carry. */
const appLabel = sql<string | null>`case when ${appInstalls.id} is null then null
  else ${appInstalls.appName} || ' on ' || ${appInstalls.domain} end`;

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
  acknowledged: queryBoolean.optional(),
  app_install_id: appFilter.optional(),
});

const alertRuleListQuery = listQuery.extend({
  enabled: queryBoolean.optional(),
  severity: alertSeverity.optional(),
  app_install_id: appFilter.optional(),
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
      q.app_install_id === "any"
        ? sql`${alertRules.appInstallId} is not null`
        : q.app_install_id
          ? eq(alertRules.appInstallId, q.app_install_id)
          : null,
      term
        ? sql`(lower(${alerts.message}) like ${term} or lower(${alertRules.name}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_ALERTS, q.sort, "started_at");
    const rows = await req.ctx.db
      .select({
        alert: alerts,
        ruleName: alertRules.name,
        serverName: servers.name,
        appInstallId: alertRules.appInstallId,
        appName: appLabel,
      })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(servers, eq(alerts.serverId, servers.id))
      .leftJoin(appInstalls, eq(alertRules.appInstallId, appInstalls.id))
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
      rows.map((r) => toAlert(r.alert, r.ruleName, r.serverName, r.appInstallId, r.appName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.post("/monitoring/alerts/:id/acknowledge", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);

    const rows = await req.ctx.db
      .select({
        alert: alerts,
        ruleName: alertRules.name,
        serverName: servers.name,
        appInstallId: alertRules.appInstallId,
        appName: appLabel,
      })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(servers, eq(alerts.serverId, servers.id))
      .leftJoin(appInstalls, eq(alertRules.appInstallId, appInstalls.id))
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

    return item(
      reply,
      toAlert(row!, found.ruleName, found.serverName, found.appInstallId, found.appName),
    );
  });

  /* --------------------------- alert rules -------------------------- */

  /**
   * The channels a rule can send to, for the rule form. Names and kinds
   * only: a channel's address or webhook URL stays behind
   * admin.settings:read, so a monitoring role can route its alerts
   * without being shown where a Slack webhook points.
   */
  app.get("/monitoring/alert-channels", async (req, reply) => {
    helpers(req).authorize("monitoring.alerts:read");
    const rows = await req.ctx.db
      .select({
        id: notificationChannels.id,
        name: notificationChannels.name,
        kind: notificationChannels.kind,
        enabled: notificationChannels.enabled,
        events: notificationChannels.events,
      })
      .from(notificationChannels)
      .orderBy(asc(notificationChannels.name));
    const data: AlertRuleChannel[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled,
      receives_alerts: row.events.includes("alert_firing"),
    }));
    return list(reply, data, paginate(data.length, 1, Math.max(1, data.length)));
  });

  app.get("/monitoring/alert-rules", async (req, reply) => {
    const q = parseQuery(req, alertRuleListQuery);
    helpers(req).authorize("monitoring.alerts:read");

    const term = searchTerm(q.q);
    const where = combine(
      q.enabled !== undefined ? eq(alertRules.enabled, q.enabled) : null,
      q.severity ? eq(alertRules.severity, q.severity) : null,
      q.app_install_id === "any"
        ? sql`${alertRules.appInstallId} is not null`
        : q.app_install_id
          ? eq(alertRules.appInstallId, q.app_install_id)
          : null,
      term
        ? sql`(lower(${alertRules.name}) like ${term} or lower(${alertRules.metric}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_RULES, q.sort, "name");
    const rows = await req.ctx.db
      .select({ rule: alertRules, appName: appLabel, appServerId: appInstalls.serverId })
      .from(alertRules)
      .leftJoin(appInstalls, eq(alertRules.appInstallId, appInstalls.id))
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
      rows
        .filter((r) => ruleIsVisible(r.rule.scope, visible, r.appServerId))
        .map((r) => toRule(r.rule, r.appName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/monitoring/alert-rules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("monitoring.alerts:read");

    const rule = await loadRule(req, id);
    const app = await ruleApp(req, rule.appInstallId);
    if (!ruleIsVisible(rule.scope, visibleServerIds(req, "monitoring.alerts:read"), app?.serverId)) {
      throw notFound("Alert rule", id);
    }
    return item(reply, toRule(rule, app?.label ?? null));
  });

  app.post("/monitoring/alert-rules", async (req, reply) => {
    const body = parseBody(req, createAlertRuleInput);
    const h = helpers(req);
    h.authorize("monitoring.alerts:write");
    assertRuleShape(body.metric, body.scope);
    const app = await assertRuleScope(req, body.scope);
    await assertChannelsExist(req, body.channels);

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
        appInstallId: app?.id ?? null,
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

    return item(reply, toRule(row!, app?.label ?? null), 201);
  });

  app.patch("/monitoring/alert-rules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateAlertRuleInput);
    const h = helpers(req);
    h.authorize("monitoring.alerts:write");

    const before = await loadRule(req, id);
    const app = await assertRuleScope(req, before.scope);
    if (body.scope || body.metric) {
      const scope = body.scope ?? before.scope;
      assertRuleShape(body.metric ?? before.metric, scope);
      // An app rule belongs to its install for good: moving it to
      // another app or to servers would orphan the default it replaced.
      if (before.appInstallId && (scope.kind !== "app" || scope.app_install_id !== before.appInstallId)) {
        throw new ApiException("validation_failed", "An app rule cannot be moved to another target.", {
          fields: { scope: "must stay on the same app" },
        });
      }
      if (!before.appInstallId && scope.kind === "app") {
        throw new ApiException("validation_failed", "A server rule cannot be turned into an app rule.", {
          fields: { scope: "create an app rule instead" },
        });
      }
    }
    if (body.scope) await assertRuleScope(req, body.scope);
    await assertChannelsExist(req, body.channels);

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

    if (before.appInstallId && body.enabled === false) {
      await resolveOpenAlerts(req.ctx.db, id);
    }

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "alert_rule.updated",
      targetType: "alert_rule",
      targetId: id,
      targetLabel: row!.name,
      before: toRule(before, app?.label ?? null),
      after: body,
    });
    req.ctx.events.publish("alerts", "alert_rule.updated", { rule_id: id });

    return item(reply, toRule(row!, app?.label ?? null));
  });

  app.delete("/monitoring/alert-rules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("monitoring.alerts:write");

    const rule = await loadRule(req, id);
    const app = await assertRuleScope(req, rule.scope);

    await req.ctx.db.delete(alertRules).where(eq(alertRules.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "alert_rule.deleted",
      targetType: "alert_rule",
      targetId: id,
      targetLabel: rule.name,
      before: toRule(rule, app?.label ?? null),
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
/**
 * A rule's channels are ids, and an id that names no channel was stored
 * happily and then matched nothing — so the rule told nobody while the
 * form claimed it notified someone. Refused by name instead.
 */
async function assertChannelsExist(
  req: FastifyRequest,
  channels: readonly string[] | undefined,
): Promise<void> {
  if (!channels || channels.length === 0) return;
  const unique = [...new Set(channels)];
  const found = await req.ctx.db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(inArray(notificationChannels.id, unique));
  const known = new Set(found.map((row) => row.id));
  const missing = unique.filter((id) => !known.has(id));
  if (missing.length === 0) return;
  throw new ApiException(
    "validation_failed",
    `${missing.length === 1 ? "A selected notification channel no longer exists" : `${missing.length} selected notification channels no longer exist`}.`,
    {
      fields: { channels: `unknown channel: ${missing.join(", ")}` },
      remediation: {
        summary: "Pick channels from the list, or add one under Settings → Notifications first.",
        actions: [{ label: "Notification settings", href: "/administration/settings#notifications" }],
      },
    },
  );
}

async function assertRuleScope(
  req: FastifyRequest,
  scope: AlertRuleScope,
): Promise<{ id: string; serverId: string; label: string } | null> {
  const principal = helpers(req).requirePrincipal();

  if (scope.kind === "servers") {
    for (const serverId of scope.server_ids) {
      helpers(req).authorize("monitoring.alerts:write", serverId);
    }
    return null;
  }

  if (scope.kind === "app") {
    const app = await ruleApp(req, scope.app_install_id);
    if (!app) throw notFound("App install", scope.app_install_id);
    helpers(req).authorize("monitoring.alerts:write", app.serverId);
    return app;
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
  return null;
}

/** App kinds go with an app scope, server metrics with a fleet or server scope — never crossed. */
function assertRuleShape(metric: string, scope: AlertRuleScope): void {
  const app = isAppAlertKind(metric);
  if (app === (scope.kind === "app")) return;
  throw new ApiException(
    "validation_failed",
    app
      ? "An app alert kind needs an app scope."
      : "A server metric cannot be scoped to an app; use an app alert kind.",
    { fields: { metric: app ? "app kinds watch one app" : "server metrics watch servers" } },
  );
}

/** The install an app rule watches: its server (for RBAC) and its display label. */
async function ruleApp(
  req: FastifyRequest,
  installId: string | null,
): Promise<{ id: string; serverId: string; label: string } | null> {
  if (!installId) return null;
  const rows = await req.ctx.db
    .select({
      id: appInstalls.id,
      serverId: appInstalls.serverId,
      appName: appInstalls.appName,
      domain: appInstalls.domain,
    })
    .from(appInstalls)
    .where(eq(appInstalls.id, installId))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, serverId: row.serverId, label: `${row.appName} on ${row.domain}` } : null;
}

/** A muted app rule closes what it had open, quietly: nobody muted it to be told it resolved. */
export async function resolveOpenAlerts(db: Database, ruleId: string): Promise<void> {
  await db
    .update(alerts)
    .set({ state: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(alerts.ruleId, ruleId), isNull(alerts.resolvedAt)));
}

function ruleIsVisible(
  scope: AlertRuleScope,
  visible: "global" | readonly string[],
  appServerId?: string | null,
): boolean {
  if (visible === "global") return true;
  if (scope.kind === "fleet") return false;
  if (scope.kind === "app") return !!appServerId && visible.includes(appServerId);
  return scope.server_ids.some((id) => visible.includes(id));
}

export function toRule(row: typeof alertRules.$inferSelect, appName: string | null): AlertRule {
  return {
    id: row.id,
    name: row.name,
    metric: row.metric as AlertRule["metric"],
    comparator: row.comparator,
    threshold: row.threshold,
    duration_seconds: row.durationSeconds,
    severity: row.severity,
    scope: row.scope,
    enabled: row.enabled,
    channels: row.channels,
    app_install_id: row.appInstallId,
    app_name: appName,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toAlert(
  row: typeof alerts.$inferSelect,
  ruleName: string,
  serverName: string | null,
  appInstallId: string | null = null,
  appName: string | null = null,
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
    app_install_id: appInstallId,
    app_name: appName,
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
