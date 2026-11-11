import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "@kaname/db";
import {
  alertRules,
  alerts,
  appInstalls,
  appMonitors,
  certificates,
  servers,
} from "@kaname/db/schema";
import {
  can,
  createAppAlertRuleInput,
  defaultHealthPath,
  idParam,
  updateAppAlertRuleInput,
  updateAppMonitorInput,
  uuid,
  type AppHealth,
  type AppHealthStatus,
  type AppHealthSummary,
  type Permission,
} from "@kaname/contract";
import { z } from "zod";
import { helpers, item, list, paginate, parseBody, parseParams, parseQuery } from "../http/plugin.js";
import { ApiException, conflict, notFound } from "../lib/errors.js";
import {
  applicableKinds,
  appRuleValues,
  ensureAppMonitoring,
  isImageInstall,
  probeUrl,
} from "../services/app-health.js";
import { combine, scopeFilter } from "./_shared.js";
import { isOwnedBy, ownership } from "./_ownership.js";
import { resolveOpenAlerts, toAlert, toRule } from "./monitoring.js";

/* ------------------------------------------------------------------ *
 * App health — the installed app's own view of its monitoring.
 *
 * These routes sit beside the installer's (routes/apps.ts) and follow
 * its access model rather than Monitoring's: `apps.installs:read` to
 * look, ownership-filtered (KD-039), so a reseller or client sees the
 * health and alerts of the apps it owns and nothing else. Tuning or
 * muting an app's rules takes `apps.installs:write` on its server (what
 * an owner has) or `monitoring.alerts:write` (what an operator who runs
 * alerting has). Routing — which channels a rule notifies — stays in
 * Monitoring → Alert rules, operator-only: there is no per-user
 * channel, so an app alert goes to the operator's alert channels.
 * ------------------------------------------------------------------ */

type InstallRow = typeof appInstalls.$inferSelect;

const ruleParams = z.object({ id: uuid, ruleId: uuid });
const summaryQuery = z.object({ server_id: uuid.optional() });

const LATENCY_STEP_SECONDS = 900;
const RECENT_ALERTS = 8;

export async function appHealthRoutes(app: FastifyInstance): Promise<void> {
  /** Status per visible install, for the Installed list and the homes. */
  app.get("/apps/health", async (req, reply) => {
    const own = ownership(req);
    const q = parseQuery(req, summaryQuery);
    helpers(req).authorize("apps.installs:read", q.server_id ?? null);

    const rows = await req.ctx.db
      .select({ install: appInstalls, monitor: appMonitors })
      .from(appInstalls)
      .leftJoin(appMonitors, eq(appMonitors.appInstallId, appInstalls.id))
      .where(
        combine(
          scopeFilter(req, "apps.installs:read", appInstalls.serverId),
          own.account ? installsOwnedBy(own.account.ownerIds) : null,
          q.server_id ? eq(appInstalls.serverId, q.server_id) : null,
        ),
      )
      .orderBy(desc(appInstalls.createdAt))
      .limit(500);

    const ids = rows.map((r) => r.install.id);
    const [uptime, open] = await Promise.all([
      uptimeByInstall(req, ids, 24),
      openByInstall(req, ids),
    ]);

    const data: AppHealthSummary[] = rows.map(({ install, monitor }) => ({
      install_id: install.id,
      app_name: install.appName,
      domain: install.domain,
      status: statusOf(install, monitor, open.get(install.id)),
      uptime_24h: uptime.get(install.id) ?? null,
      latency_ms: monitor?.lastLatencyMs ?? null,
      last_checked_at: monitor?.lastCheckedAt?.toISOString() ?? null,
      open_alerts: open.get(install.id)?.total ?? 0,
    }));
    return list(reply, data, paginate(data.length, 1, Math.max(1, data.length)));
  });

  app.get("/apps/installs/:id/health", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const install = await loadVisibleInstall(req, id);
    return item(reply, await healthOf(req, install));
  });

  /** Probe path and on/off. */
  app.patch("/apps/installs/:id/monitor", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const body = parseBody(req, updateAppMonitorInput);
    const install = await loadVisibleInstall(req, id);
    assertCanManage(req, install);
    const before = await ensureAppMonitoring(req.ctx, install);

    await req.ctx.db
      .update(appMonitors)
      .set({
        ...(body.probe_path !== undefined ? { probePath: body.probe_path } : {}),
        ...(body.probe_enabled !== undefined ? { probeEnabled: body.probe_enabled } : {}),
        // A new path or a pause starts the count again: the old failures
        // were about something else.
        ...(body.probe_path !== undefined || body.probe_enabled === false
          ? { consecutiveFailures: 0, status: "unknown" as const }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(appMonitors.appInstallId, id));

    if (body.probe_enabled === false) {
      // Nothing will probe it, so an open "down" alert could never resolve.
      const down = await req.ctx.db
        .select({ id: alertRules.id })
        .from(alertRules)
        .where(and(eq(alertRules.appInstallId, id), eq(alertRules.metric, "app_down")));
      for (const rule of down) await resolveOpenAlerts(req.ctx.db, rule.id);
    }

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "app_monitor.updated",
      targetType: "app_install",
      targetId: id,
      targetLabel: `${install.appName} on ${install.domain}`,
      serverId: install.serverId,
      before: { probe_path: before.probePath, probe_enabled: before.probeEnabled },
      after: body,
    });
    req.ctx.events.publish("alerts", "app_health.changed", { app_install_id: id }, install.serverId);
    return item(reply, await healthOf(req, install));
  });

  /** Adds one of the kinds this app has no rule for yet, from its template. */
  app.post("/apps/installs/:id/alert-rules", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const body = parseBody(req, createAppAlertRuleInput);
    const install = await loadVisibleInstall(req, id);
    assertCanManage(req, install);

    if (!applicableKinds(install).includes(body.kind)) {
      throw new ApiException("validation_failed", `That alert does not apply to ${install.appName}.`, {
        fields: { kind: "needs containers or HTTPS this install does not have" },
      });
    }
    const existing = await req.ctx.db
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(and(eq(alertRules.appInstallId, id), eq(alertRules.metric, body.kind)))
      .limit(1);
    if (existing[0]) throw conflict(`This app already has that alert rule.`);

    const [row] = await req.ctx.db
      .insert(alertRules)
      .values(appRuleValues(body.kind, install, true))
      .returning();
    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "alert_rule.created",
      targetType: "alert_rule",
      targetId: row!.id,
      targetLabel: row!.name,
      serverId: install.serverId,
      after: { kind: body.kind, app_install_id: id },
    });
    req.ctx.events.publish("alerts", "alert_rule.created", { rule_id: row!.id }, install.serverId);
    return item(reply, toRule(row!, `${install.appName} on ${install.domain}`), 201);
  });

  /** Tune (threshold, duration, severity) or mute (enabled: false) one of the app's rules. */
  app.patch("/apps/installs/:id/alert-rules/:ruleId", async (req, reply) => {
    const { id, ruleId } = parseParams(req, ruleParams);
    ownership(req);
    const body = parseBody(req, updateAppAlertRuleInput);
    const install = await loadVisibleInstall(req, id);
    assertCanManage(req, install);

    const rows = await req.ctx.db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.id, ruleId), eq(alertRules.appInstallId, id)))
      .limit(1);
    const before = rows[0];
    if (!before) throw notFound("Alert rule", ruleId);

    const [row] = await req.ctx.db
      .update(alertRules)
      .set({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        ...(body.duration_seconds !== undefined ? { durationSeconds: body.duration_seconds } : {}),
        ...(body.severity !== undefined ? { severity: body.severity } : {}),
        updatedAt: new Date(),
      })
      .where(eq(alertRules.id, ruleId))
      .returning();
    if (body.enabled === false) await resolveOpenAlerts(req.ctx.db, ruleId);

    const label = `${install.appName} on ${install.domain}`;
    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: body.enabled === false ? "alert_rule.muted" : "alert_rule.updated",
      targetType: "alert_rule",
      targetId: ruleId,
      targetLabel: before.name,
      serverId: install.serverId,
      before: toRule(before, label),
      after: body,
    });
    req.ctx.events.publish("alerts", "alert_rule.updated", { rule_id: ruleId }, install.serverId);
    return item(reply, toRule(row!, label));
  });
}

/* ------------------------------------------------------------------ */

function holds(req: FastifyRequest, permission: Permission, serverId: string): boolean {
  const principal = req.principal;
  if (!principal) return false;
  const grants = principal.scoped && req.ownershipScoped ? principal.scoped.grants : principal.grants;
  return can(grants, permission, serverId);
}

function canManage(req: FastifyRequest, install: InstallRow): boolean {
  return (
    holds(req, "apps.installs:write", install.serverId) ||
    holds(req, "monitoring.alerts:write", install.serverId)
  );
}

function assertCanManage(req: FastifyRequest, install: InstallRow): void {
  if (canManage(req, install)) return;
  // Raises the standard forbidden error for the permission an owner holds.
  helpers(req).authorize("apps.installs:write", install.serverId);
}

/** The installer's visibility rule: a scoped account sees installs it started or whose site it owns. */
async function loadVisibleInstall(req: FastifyRequest, id: string): Promise<InstallRow> {
  const rows = await req.ctx.db.select().from(appInstalls).where(eq(appInstalls.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("App install", id);
  helpers(req).authorize("apps.installs:read", row.serverId);
  const account = req.principal?.scoped;
  if (account) {
    const mine =
      (row.createdBy !== null && account.ownerIds.includes(row.createdBy)) ||
      (row.siteId !== null && (await isOwnedBy(req.ctx.db, "site", row.siteId, account.ownerIds)));
    if (!mine) throw notFound("App install", id);
  }
  return row;
}

function installsOwnedBy(ownerIds: readonly string[]): SQL {
  if (ownerIds.length === 0) return sql`false`;
  return or(
    inArray(appInstalls.createdBy, [...ownerIds]),
    sql`exists (select 1 from resource_owners o
      where o.kind = 'site' and o.resource_id = ${appInstalls.siteId}
        and o.owner_id in (${sql.join(
          ownerIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}))`,
  )!;
}

interface OpenCounts {
  total: number;
  /** Firing (not pending) alerts, which is what makes an app "degraded". */
  firing: number;
}

async function openByInstall(req: FastifyRequest, ids: readonly string[]): Promise<Map<string, OpenCounts>> {
  const out = new Map<string, OpenCounts>();
  if (ids.length === 0) return out;
  const rows = await req.ctx.db
    .select({
      installId: alertRules.appInstallId,
      total: sql<number>`count(*)::int`,
      firing: sql<number>`(count(*) filter (where ${alerts.state} = 'firing'))::int`,
    })
    .from(alerts)
    .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
    .where(and(inArray(alertRules.appInstallId, [...ids]), isNull(alerts.resolvedAt)))
    .groupBy(alertRules.appInstallId);
  for (const row of rows) {
    if (row.installId) out.set(row.installId, { total: row.total, firing: row.firing });
  }
  return out;
}

async function uptimeByInstall(
  req: FastifyRequest,
  ids: readonly string[],
  hours: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const result = await req.ctx.db.execute(sql`
    select app_install_id::text as id,
           (count(*) filter (where ok)) * 100.0 / count(*) as uptime
    from app_health_samples
    where kind = 'http'
      and ts > now() - make_interval(hours => ${hours})
      and app_install_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    group by app_install_id
  `);
  for (const row of rowsOf(result)) out.set(String(row.id), Number(row.uptime));
  return out;
}

function statusOf(
  install: InstallRow,
  monitor: typeof appMonitors.$inferSelect | null,
  open: OpenCounts | undefined,
): AppHealthStatus {
  if (install.status !== "active" || !monitor || !monitor.probeEnabled || !monitor.lastCheckedAt) {
    return "unknown";
  }
  if (monitor.status === "down") return "down";
  if (open && open.firing > 0) return "degraded";
  return monitor.status === "up" ? "up" : "unknown";
}

async function healthOf(req: FastifyRequest, install: InstallRow): Promise<AppHealth> {
  const { db } = req.ctx;
  const monitor =
    install.status === "active"
      ? await ensureAppMonitoring(req.ctx, install)
      : ((await db.select().from(appMonitors).where(eq(appMonitors.appInstallId, install.id)).limit(1))[0] ??
        null);
  const label = `${install.appName} on ${install.domain}`;

  const [uptime24, uptime7, open, latency, ruleRows, alertRows, cert] = await Promise.all([
    uptimeByInstall(req, [install.id], 24),
    uptimeByInstall(req, [install.id], 24 * 7),
    openByInstall(req, [install.id]),
    db.execute(sql`
      select (floor(extract(epoch from ts) / ${LATENCY_STEP_SECONDS}) * ${LATENCY_STEP_SECONDS})::float8 as bucket,
             avg(latency_ms)::float8 as value
      from app_health_samples
      where app_install_id = ${install.id} and kind = 'http' and ok and latency_ms is not null
        and ts > now() - interval '24 hours'
      group by 1 order by 1
    `),
    db
      .select()
      .from(alertRules)
      .where(eq(alertRules.appInstallId, install.id))
      .orderBy(alertRules.createdAt),
    db
      .select({ alert: alerts, ruleName: alertRules.name, serverName: servers.name })
      .from(alerts)
      .innerJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(servers, eq(alerts.serverId, servers.id))
      .where(eq(alertRules.appInstallId, install.id))
      .orderBy(desc(alerts.startedAt))
      .limit(RECENT_ALERTS),
    install.certificateId
      ? db
          .select({ id: certificates.id, subject: certificates.subject, expiresAt: certificates.expiresAt })
          .from(certificates)
          .where(eq(certificates.id, install.certificateId))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const image = isImageInstall(install);
  const haveKinds = new Set(ruleRows.map((r) => r.metric));
  const items = monitor?.containers ?? [];
  const certRow = cert[0];
  const days = certRow?.expiresAt
    ? Math.floor((certRow.expiresAt.getTime() - Date.now()) / (24 * 3_600_000))
    : null;

  return {
    install_id: install.id,
    status: statusOf(install, monitor, open.get(install.id)),
    probe: {
      url: probeUrl(install, monitor?.probePath ?? defaultHealthPath(install.appId)),
      path: monitor?.probePath ?? defaultHealthPath(install.appId),
      default_path: defaultHealthPath(install.appId),
      enabled: monitor?.probeEnabled ?? true,
      last_checked_at: monitor?.lastCheckedAt?.toISOString() ?? null,
      status_code: monitor?.lastStatusCode ?? null,
      latency_ms: monitor?.lastLatencyMs ?? null,
      error: monitor?.lastError ?? null,
      consecutive_failures: monitor?.consecutiveFailures ?? 0,
    },
    uptime_24h: uptime24.get(install.id) ?? null,
    uptime_7d: uptime7.get(install.id) ?? null,
    latency: rowsOf(latency).map((r) => ({
      ts: new Date(Number(r.bucket) * 1000).toISOString(),
      value: Math.round(Number(r.value)),
    })),
    containers: image
      ? {
          sampled_at: monitor?.containersSampledAt?.toISOString() ?? null,
          total: items.length,
          running: items.filter((c) => c.state === "running").length,
          unhealthy: items.filter((c) => c.health === "unhealthy").length,
          restart_count: items.reduce((a, c) => a + c.restart_count, 0),
          cpu_percent: sumOrNull(items.map((c) => c.cpu_percent)),
          memory_bytes: sumOrNull(items.map((c) => c.memory_bytes)),
          memory_limit: sumOrNull(items.map((c) => c.memory_limit)),
          items,
        }
      : null,
    certificate: certRow
      ? {
          id: certRow.id,
          subject: certRow.subject,
          expires_at: certRow.expiresAt?.toISOString() ?? null,
          days_left: days,
        }
      : null,
    data:
      monitor?.dataBytes !== null && monitor?.dataBytes !== undefined && monitor.dataMeasuredAt
        ? { bytes: monitor.dataBytes, measured_at: monitor.dataMeasuredAt.toISOString() }
        : null,
    open_alerts: open.get(install.id)?.total ?? 0,
    recent_alerts: alertRows.map((r) =>
      toAlert(r.alert, r.ruleName, r.serverName, install.id, label),
    ),
    rules: ruleRows.map((r) => toRule(r, label)),
    available_kinds: applicableKinds(install).filter((k) => !haveKinds.has(k)),
    can_manage: canManage(req, install),
  };
}

function sumOrNull(values: (number | null)[]): number | null {
  return values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown[] })?.rows ?? (result as unknown[]);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}
