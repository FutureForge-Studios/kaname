import { and, eq, inArray, sql } from "@kaname/db";
import { appInstalls, appMonitors, certificates, servers } from "@kaname/db/schema";
import { APP_ALERT_KIND_LABELS, type AppAlertKind } from "@kaname/contract";
import type { AppContext } from "../context.js";
import { COMPARATOR, type RuleRow, type Window } from "./alerts.js";

/* ------------------------------------------------------------------ *
 * App rules, as windows the alert engine can judge.
 *
 * An app rule goes through exactly the lifecycle a server rule does
 * (services/alerts.ts: pending → firing → resolved, one open alert per
 * rule and server, edges published on the bus). What differs is where
 * its numbers come from: the install's health samples, written by the
 * app monitor (services/app-health.ts), instead of server_metrics.
 *
 * Two shapes of kind:
 *   - counted ones (app_down, app_restart_loop, app_cert_expiring)
 *     already carry their own duration in the value — N failures in a
 *     row, N restarts in the window, N days left — so they are judged
 *     on the latest value alone;
 *   - sustained ones (app_slow, app_container_unhealthy, app_memory,
 *     app_cpu) use the server rule's semantics: the worst sample in the
 *     window must breach, and the window must be covered.
 * ------------------------------------------------------------------ */

export interface AppTarget {
  installId: string;
  appName: string;
  domain: string;
  serverId: string;
  serverName: string;
  certificateId: string | null;
  consecutiveFailures: number;
  probed: boolean;
  lastStatusCode: number | null;
  lastError: string | null;
}

/** Slack for the window's coverage: probes are a minute apart, container polls two. */
const COVERAGE_SLACK_S = 150;
const DAY_MS = 24 * 3_600_000;

/** Active installs the given app rules point at, with their monitor's running verdict. */
export async function appTargets(
  ctx: AppContext,
  rules: readonly RuleRow[],
): Promise<Map<string, AppTarget>> {
  const ids = [...new Set(rules.map((r) => r.appInstallId).filter((id): id is string => !!id))];
  const out = new Map<string, AppTarget>();
  if (ids.length === 0) return out;
  const rows = await ctx.db
    .select({ install: appInstalls, monitor: appMonitors, serverName: servers.name })
    .from(appInstalls)
    .innerJoin(servers, eq(appInstalls.serverId, servers.id))
    .leftJoin(appMonitors, eq(appMonitors.appInstallId, appInstalls.id))
    .where(and(inArray(appInstalls.id, ids), eq(appInstalls.status, "active")));
  for (const { install, monitor, serverName } of rows) {
    out.set(install.id, {
      installId: install.id,
      appName: install.appName,
      domain: install.domain,
      serverId: install.serverId,
      serverName,
      certificateId: install.certificateId,
      consecutiveFailures: monitor?.consecutiveFailures ?? 0,
      probed: Boolean(monitor?.probeEnabled && monitor.lastCheckedAt),
      lastStatusCode: monitor?.lastStatusCode ?? null,
      lastError: monitor?.lastError ?? null,
    });
  }
  return out;
}

const EMPTY: Window = { lo: null, hi: null, latest: null, covered: false };

const point = (value: number): Window => ({ lo: value, hi: value, latest: value, covered: true });

/** The SQL per sustained kind: the value one container sample stands for. */
const CONTAINER_SQL: Partial<Record<AppAlertKind, string>> = {
  app_container_unhealthy:
    "(coalesce(containers_total, 0) - coalesce(containers_running, 0)) + coalesce(containers_unhealthy, 0)",
  app_memory: "memory_bytes * 100.0 / nullif(memory_limit, 0)",
  app_cpu: "cpu_percent",
};

export async function appWindow(ctx: AppContext, rule: RuleRow, target: AppTarget): Promise<Window> {
  const kind = rule.metric as AppAlertKind;
  switch (kind) {
    case "app_down":
      // Probing off or not yet probed: no data, so nothing opens (and
      // an alert already open stays as it is until the next probe).
      return target.probed ? point(target.consecutiveFailures) : EMPTY;

    case "app_cert_expiring": {
      if (!target.certificateId) return EMPTY;
      const rows = await ctx.db
        .select({ expiresAt: certificates.expiresAt })
        .from(certificates)
        .where(eq(certificates.id, target.certificateId))
        .limit(1);
      const expires = rows[0]?.expiresAt;
      if (!expires) return EMPTY;
      return point(Math.max(0, Math.floor((expires.getTime() - Date.now()) / DAY_MS)));
    }

    case "app_restart_loop": {
      const seconds = Math.max(120, rule.durationSeconds);
      const result = await ctx.db.execute(sql`
        select min(restart_count)::int as first_count,
               (select restart_count from app_health_samples
                  where app_install_id = ${target.installId} and kind = 'containers'
                  order by ts desc limit 1)::int as last_count,
               count(*)::int as n
        from app_health_samples
        where app_install_id = ${target.installId} and kind = 'containers'
          and ts > now() - make_interval(secs => ${seconds})
      `);
      const row = firstRow(result);
      if (!row || Number(row.n) === 0 || row.last_count === null) return EMPTY;
      // A container recreated by an update starts counting from zero
      // again; never report a negative number of restarts.
      return point(Math.max(0, Number(row.last_count) - Number(row.first_count ?? 0)));
    }

    case "app_slow":
      return sustained(
        ctx,
        target.installId,
        "http",
        "latency_ms",
        "ok is true and latency_ms is not null",
        rule.durationSeconds,
      );

    case "app_container_unhealthy":
    case "app_memory":
    case "app_cpu":
      return sustained(
        ctx,
        target.installId,
        "containers",
        CONTAINER_SQL[kind]!,
        "true",
        rule.durationSeconds,
      );
  }
}

/** Lo/hi/latest over the window, from one fixed expression of a fixed table (never user input). */
async function sustained(
  ctx: AppContext,
  installId: string,
  kind: "http" | "containers",
  expression: string,
  filter: string,
  durationSeconds: number,
): Promise<Window> {
  const seconds = Math.max(60, durationSeconds);
  const expr = sql.raw(expression);
  const where = sql.raw(filter);
  const slack = Math.max(0, seconds - COVERAGE_SLACK_S);
  const result = await ctx.db.execute(sql`
    select
      min(${expr})::float as lo,
      max(${expr})::float as hi,
      (select ${expr}::float from app_health_samples
         where app_install_id = ${installId} and kind = ${kind} and ${where}
         order by ts desc limit 1) as latest,
      (min(ts) <= now() - make_interval(secs => ${slack})) as covered
    from app_health_samples
    where app_install_id = ${installId} and kind = ${kind} and ${where}
      and ts > now() - make_interval(secs => ${seconds})
  `);
  const row = firstRow(result) ?? {};
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return { lo: num(row.lo), hi: num(row.hi), latest: num(row.latest), covered: row.covered === true };
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  const rows = (result as { rows?: unknown[] })?.rows ?? (result as unknown[]);
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

/* ------------------------------ text ------------------------------- */

export function formatAppValue(kind: AppAlertKind, value: number): string {
  const n = Math.abs(value) >= 100 ? Math.round(value).toString() : String(Math.round(value * 10) / 10);
  switch (kind) {
    case "app_down":
      return `${n} failed check${value === 1 ? "" : "s"}`;
    case "app_slow":
      return `${n} ms`;
    case "app_restart_loop":
      return `${n} restart${value === 1 ? "" : "s"}`;
    case "app_container_unhealthy":
      return `${n} container${value === 1 ? "" : "s"} down`;
    case "app_memory":
    case "app_cpu":
      return `${n}%`;
    case "app_cert_expiring":
      return `${n} day${value === 1 ? "" : "s"}`;
  }
}

function minutes(seconds: number): string {
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
}

/** Messages, display values and the extra bus payload for one app rule. */
export function describeApp(
  rule: RuleRow,
  target: Pick<AppTarget, "installId" | "appName" | "domain" | "lastStatusCode" | "lastError">,
): {
  describe: (value: number) => string;
  format: (value: number) => string;
  extra: Record<string, unknown>;
} {
  const kind = rule.metric as AppAlertKind;
  const app = `${target.appName} on ${target.domain}`;
  const fmt = (value: number) => formatAppValue(kind, value);
  const describe = (value: number): string => {
    switch (kind) {
      case "app_down": {
        const why =
          target.lastStatusCode !== null
            ? `HTTP ${target.lastStatusCode}`
            : (target.lastError ?? "no answer");
        return `${app} failed ${fmt(value).replace(" failed", "")} in a row (last: ${why})`;
      }
      case "app_restart_loop":
        return `${app}: ${fmt(value)} in ${minutes(rule.durationSeconds)}`;
      case "app_cert_expiring":
        return `${app}: certificate expires in ${fmt(value)}`;
      case "app_container_unhealthy":
        return `${app}: ${fmt(value)} for ${minutes(rule.durationSeconds)}`;
      case "app_slow":
        return `${app}: responses ${fmt(value)} ${COMPARATOR[rule.comparator]} ${fmt(rule.threshold)} for ${minutes(rule.durationSeconds)}`;
      case "app_memory":
      case "app_cpu":
        return `${app}: ${kind === "app_cpu" ? "CPU" : "memory"} ${fmt(value)} ${COMPARATOR[rule.comparator]} ${fmt(rule.threshold)} for ${minutes(rule.durationSeconds)}`;
    }
  };
  return {
    describe,
    format: fmt,
    extra: {
      app_install_id: target.installId,
      app_name: app,
      app_kind: kind,
      kind_label: APP_ALERT_KIND_LABELS[kind],
      href: `/apps/installs/${target.installId}`,
      // The certificate sweep (services/notifications.ts) already sends
      // the expiry warning for every certificate, this one included; the
      // app rule exists to show it on the app, not to send it twice.
      notify: kind !== "app_cert_expiring",
    },
  };
}
