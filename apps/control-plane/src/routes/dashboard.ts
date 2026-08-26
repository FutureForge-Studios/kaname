import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "@kaname/db";
import {
  alerts,
  auditEvents,
  backupRuns,
  backupSchedules,
  certificates,
  domains,
  jobs,
  mailAuthChecks,
  mailDomains,
  restorePoints,
  servers,
  services,
  threatEvents,
} from "@kaname/db/schema";
import {
  CERT_EXPIRY_SOON_DAYS,
  certificateUrgency,
  type AuditEvent,
  type CommandCenterSummary,
  type Permission,
} from "@kaname/contract";
import { helpers, item } from "../http/plugin.js";
import { combine, scopeFilter, visibleServerIds } from "./_shared.js";
import { latestSamples, rollup } from "./monitoring.js";

/* ------------------------------------------------------------------ *
 * Command Center.
 *
 * The first screen an operator sees, and the only one whose job is to
 * answer "what needs me right now" without scrolling. Everything here
 * is a fact the control plane already holds — no route on this page
 * fans a live RPC across the fleet, because one slow host must not make
 * the dashboard slow (KD-012).
 *
 * Each block is separately scoped: a Developer who cannot read the
 * audit trail or the firewall simply gets a shorter page, never a 403.
 * ------------------------------------------------------------------ */

type Attention = CommandCenterSummary["attention"][number];

const DAY_MS = 24 * 3_600_000;
const MAX_ATTENTION = 25;
/** Background SSH scanning is weather; this is the line where it is news. */
const THREAT_SPIKE_ATTEMPTS = 500;
const SEVERITY_RANK: Record<Attention["severity"], number> = { critical: 0, warning: 1, info: 2 };

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/dashboard", async (req, reply) => {
    helpers(req).authorize("infra.servers:read");

    const since = new Date(Date.now() - DAY_MS);
    const fleetRows = await req.ctx.db
      .select()
      .from(servers)
      .where(combine(scopeFilter(req, "infra.servers:read", servers.id)))
      .orderBy(asc(servers.name));

    const ids = fleetRows.map((r) => r.id);
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

    const attention: Attention[] = [];

    /* ------------------------- agents offline ------------------------ */

    for (const server of fleetRows) {
      // A host that never finished enrolment is a setup task, not an
      // incident, and belongs on the server page rather than here.
      if (!server.enrolledAt) continue;
      if (server.connection !== "disconnected" && server.connection !== "degraded") continue;

      const silentFor = server.lastSeenAt ? Date.now() - server.lastSeenAt.getTime() : null;
      attention.push({
        kind: "agent_offline",
        severity: server.connection === "disconnected" ? "critical" : "warning",
        title: `${server.name} is ${server.connection}`,
        detail: silentFor
          ? `No agent heartbeat for ${humanDuration(silentFor)}.`
          : "The agent has not checked in since it was enrolled.",
        server_id: server.id,
        server_name: server.name,
        href: `/infrastructure/servers/${server.id}`,
        since: (server.lastSeenAt ?? server.updatedAt).toISOString(),
      });
    }

    /* -------------------------- disk pressure ------------------------ */

    for (const server of fleetRows) {
      // Reuse the reconciler's own thresholds so this page and the
      // server's health badge can never disagree about what is full.
      for (const reason of server.healthReasons) {
        if (!reason.includes("disk")) continue;
        const [level, text] = splitReason(reason);
        attention.push({
          kind: "disk_pressure",
          severity: level === "critical" ? "critical" : "warning",
          title: `${server.name} is running out of disk`,
          detail: capitalize(text),
          server_id: server.id,
          server_name: server.name,
          href: `/files/storage?server_id=${server.id}`,
          since: server.updatedAt.toISOString(),
        });
      }
    }

    /* ------------------------- failed services ----------------------- */

    if (holds(req, "infra.services:read")) {
      const rows = await req.ctx.db
        .select({
          serverId: servers.id,
          serverName: servers.name,
          failed: sql<number>`count(*)::int`,
          sample: sql<string>`min(${services.unit})`,
          seen: sql<string>`max(${services.lastSyncedAt})`,
        })
        .from(services)
        .innerJoin(servers, eq(services.serverId, servers.id))
        .where(
          combine(
            eq(services.activeState, "failed"),
            scopeFilter(req, "infra.services:read", services.serverId),
          ),
        )
        .groupBy(servers.id, servers.name);

      for (const row of rows) {
        attention.push({
          kind: "service_failed",
          severity: "critical",
          title: `${row.failed} failed ${row.failed === 1 ? "unit" : "units"} on ${row.serverName}`,
          detail:
            row.failed === 1
              ? `${row.sample} is in a failed state.`
              : `${row.sample} and ${row.failed - 1} more are in a failed state.`,
          server_id: row.serverId,
          server_name: row.serverName,
          href: `/infrastructure/services?server_id=${row.serverId}&active_state=failed`,
          since: isoOf(row.seen),
        });
      }
    }

    /* --------------------------- certificates ------------------------ */

    const certificatesExpiring: CommandCenterSummary["certificates_expiring"] = [];
    if (holds(req, "websites.ssl:read")) {
      const horizon = new Date(Date.now() + CERT_EXPIRY_SOON_DAYS * DAY_MS);
      const rows = await req.ctx.db
        .select({
          id: certificates.id,
          subject: certificates.subject,
          expiresAt: certificates.expiresAt,
          autoRenew: certificates.autoRenew,
          lastError: certificates.lastError,
          serverId: certificates.serverId,
          serverName: servers.name,
        })
        .from(certificates)
        .innerJoin(servers, eq(certificates.serverId, servers.id))
        .where(
          combine(
            scopeFilter(req, "websites.ssl:read", certificates.serverId),
            isNotNull(certificates.expiresAt),
            lte(certificates.expiresAt, horizon),
          ),
        )
        .orderBy(asc(certificates.expiresAt))
        .limit(20);

      for (const row of rows) {
        const expiresAt = row.expiresAt!;
        const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / DAY_MS);
        certificatesExpiring.push({
          id: row.id,
          subject: row.subject,
          expires_at: expiresAt.toISOString(),
          days_left: daysLeft,
        });

        const urgency = certificateUrgency(daysLeft);
        // An auto-renewing certificate three weeks out is ACME doing its
        // job. Only a stalled or unattended renewal is the operator's.
        if (urgency === "soon" && row.autoRenew && !row.lastError) continue;

        attention.push({
          kind: "cert_expiring",
          severity: urgency === "expired" || urgency === "urgent" ? "critical" : "warning",
          title:
            urgency === "expired"
              ? `Certificate for ${row.subject} has expired`
              : `Certificate for ${row.subject} expires in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`,
          detail: row.lastError
            ? `Last renewal failed: ${row.lastError}`
            : row.autoRenew
              ? "Automatic renewal has not completed yet."
              : "Automatic renewal is off, so this one needs a hand.",
          server_id: row.serverId,
          server_name: row.serverName,
          href: `/websites/ssl?certificate_id=${row.id}`,
          since: expiresAt.toISOString(),
        });
      }
    }

    /* ----------------------------- backups --------------------------- */

    let backups: CommandCenterSummary["backups"] = {
      last_success_at: null,
      failing_schedules: 0,
      protected_bytes: 0,
    };

    if (holds(req, "backups.schedules:read")) {
      const schedules = await req.ctx.db
        .select({
          id: backupSchedules.id,
          name: backupSchedules.name,
          serverId: backupSchedules.serverId,
          serverName: servers.name,
          lastRunAt: backupSchedules.lastRunAt,
          lastRunStatus: backupSchedules.lastRunStatus,
        })
        .from(backupSchedules)
        .innerJoin(servers, eq(backupSchedules.serverId, servers.id))
        .where(
          combine(
            eq(backupSchedules.enabled, true),
            scopeFilter(req, "backups.schedules:read", backupSchedules.serverId),
          ),
        );

      const failing = schedules.filter(
        (s) => s.lastRunStatus === "failed" || s.lastRunStatus === "partial",
      );

      for (const schedule of failing) {
        attention.push({
          kind: "backup_failed",
          severity: schedule.lastRunStatus === "failed" ? "critical" : "warning",
          title: `Backup "${schedule.name}" ${schedule.lastRunStatus === "failed" ? "failed" : "completed partially"}`,
          detail: schedule.lastRunAt
            ? `Last run ${humanDuration(Date.now() - schedule.lastRunAt.getTime())} ago on ${schedule.serverName}.`
            : `No successful run recorded on ${schedule.serverName}.`,
          server_id: schedule.serverId,
          server_name: schedule.serverName,
          href: `/backups?schedule_id=${schedule.id}`,
          since: (schedule.lastRunAt ?? new Date()).toISOString(),
        });
      }

      const [success] = await req.ctx.db
        .select({ at: sql<string>`max(${backupRuns.finishedAt})` })
        .from(backupRuns)
        .where(
          combine(
            eq(backupRuns.status, "succeeded"),
            scopeFilter(req, "backups.schedules:read", backupRuns.serverId),
          ),
        );

      const [protectedBytes] = await req.ctx.db
        .select({ bytes: sql<number>`coalesce(sum(${restorePoints.bytes}), 0)::bigint` })
        .from(restorePoints)
        .where(combine(scopeFilter(req, "backups.schedules:read", restorePoints.serverId)));

      backups = {
        last_success_at: success?.at ? isoOf(success.at) : null,
        failing_schedules: failing.length,
        protected_bytes: Number(protectedBytes?.bytes ?? 0),
      };
    }

    /* -------------------------- mail DNS auth ------------------------ */

    if (holds(req, "email.auth:read")) {
      const rows = await req.ctx.db
        .select({
          domainName: domains.name,
          serverId: mailDomains.serverId,
          serverName: servers.name,
          failing: sql<number>`count(*)::int`,
          sample: sql<string>`min(${mailAuthChecks.check})`,
          checkedAt: sql<string>`max(${mailAuthChecks.checkedAt})`,
        })
        .from(mailAuthChecks)
        .innerJoin(mailDomains, eq(mailAuthChecks.mailDomainId, mailDomains.id))
        .innerJoin(domains, eq(mailDomains.domainId, domains.id))
        .innerJoin(servers, eq(mailDomains.serverId, servers.id))
        .where(
          combine(
            eq(mailAuthChecks.status, "fail"),
            scopeFilter(req, "email.auth:read", mailDomains.serverId),
          ),
        )
        .groupBy(domains.name, mailDomains.serverId, servers.name);

      for (const row of rows) {
        attention.push({
          kind: "mail_auth_failing",
          severity: "warning",
          title: `Mail authentication is failing for ${row.domainName}`,
          detail:
            row.failing === 1
              ? `The ${row.sample.toUpperCase()} check fails — mail from this domain will be treated as spam.`
              : `${row.failing} checks fail, starting with ${row.sample.toUpperCase()}.`,
          server_id: row.serverId,
          server_name: row.serverName,
          href: `/email/authentication?domain=${encodeURIComponent(row.domainName)}`,
          since: isoOf(row.checkedAt),
        });
      }
    }

    /* ----------------------------- threats --------------------------- */

    let threats: CommandCenterSummary["threats_24h"] = {
      blocked: 0,
      observed: 0,
      top_sources: [],
    };

    if (holds(req, "security.threats:read")) {
      const threatWindow = combine(
        gte(threatEvents.lastSeen, since),
        scopeFilter(req, "security.threats:read", threatEvents.serverId),
      );

      const perServer = await req.ctx.db
        .select({
          serverId: servers.id,
          serverName: servers.name,
          blocked: sql<number>`coalesce(sum(case when ${threatEvents.disposition} = 'banned' then ${threatEvents.attempts} else 0 end), 0)::int`,
          observed: sql<number>`coalesce(sum(case when ${threatEvents.disposition} <> 'banned' then ${threatEvents.attempts} else 0 end), 0)::int`,
          lastSeen: sql<string>`max(${threatEvents.lastSeen})`,
        })
        .from(threatEvents)
        .innerJoin(servers, eq(threatEvents.serverId, servers.id))
        .where(threatWindow)
        .groupBy(servers.id, servers.name);

      const topSources = await req.ctx.db
        .select({
          // host() rather than a text cast: inet renders a /32 suffix that
          // the API contract's ip field would reject.
          ip: sql<string>`host(${threatEvents.sourceIp})`,
          attempts: sql<number>`sum(${threatEvents.attempts})::int`,
          country: sql<string | null>`max(${threatEvents.sourceCountry})`,
        })
        .from(threatEvents)
        .where(threatWindow)
        .groupBy(threatEvents.sourceIp)
        .orderBy(desc(sql`sum(${threatEvents.attempts})`))
        .limit(5);

      threats = {
        blocked: perServer.reduce((n, r) => n + r.blocked, 0),
        observed: perServer.reduce((n, r) => n + r.observed, 0),
        top_sources: topSources.map((r) => ({
          ip: r.ip,
          attempts: r.attempts,
          country: r.country,
        })),
      };

      for (const row of perServer) {
        const total = row.blocked + row.observed;
        if (total < THREAT_SPIKE_ATTEMPTS) continue;
        attention.push({
          kind: "threat_spike",
          severity: "warning",
          title: `${total.toLocaleString("en-US")} intrusion attempts on ${row.serverName}`,
          detail: `${row.blocked.toLocaleString("en-US")} blocked, ${row.observed.toLocaleString("en-US")} observed in the last 24 hours.`,
          server_id: row.serverId,
          server_name: row.serverName,
          href: `/security/threats?server_id=${row.serverId}`,
          since: isoOf(row.lastSeen),
        });
      }
    }

    /* ------------------------------ jobs ----------------------------- */

    const jobScope = scopeFilter(req, "infra.servers:read", jobs.serverId);

    const failedJobs = await req.ctx.db
      .select({ job: jobs, serverName: servers.name })
      .from(jobs)
      .leftJoin(servers, eq(jobs.serverId, servers.id))
      .where(
        combine(
          jobScope,
          inArray(jobs.status, ["failed", "timed_out"]),
          gte(jobs.finishedAt, since),
        ),
      )
      .orderBy(desc(jobs.finishedAt))
      .limit(5);

    for (const row of failedJobs) {
      const job = req.ctx.queue.toApi(row.job, row.serverName);
      attention.push({
        kind: "job_failed",
        severity: "warning",
        title: `${job.label} failed${row.serverName ? ` on ${row.serverName}` : ""}`,
        detail: job.error?.message ?? "The job finished without reporting a reason.",
        server_id: row.job.serverId,
        server_name: row.serverName,
        href: `/jobs/${job.id}`,
        since: job.finished_at ?? job.created_at,
      });
    }

    const recentJobs = await req.ctx.db
      .select({ job: jobs, serverName: servers.name })
      .from(jobs)
      .leftJoin(servers, eq(jobs.serverId, servers.id))
      .where(combine(jobScope))
      .orderBy(desc(jobs.createdAt))
      .limit(10);

    /* --------------------------- agent updates ----------------------- */

    /*
     * Counting outstanding OS packages would mean an RPC to every host
     * on every dashboard load, which is exactly the fan-out KD-012 rules
     * out. The agent version is the update signal the control plane
     * already holds, and a stale agent is the one that actually blocks
     * new panel features.
     */
    const panelVersion = process.env.npm_package_version ?? "0.1.0";
    for (const server of fleetRows) {
      if (!server.agentVersion || !isOlder(server.agentVersion, panelVersion)) continue;
      attention.push({
        kind: "update_available",
        severity: "info",
        title: `${server.name} is running an older agent`,
        detail: `Agent ${server.agentVersion}; this control plane ships ${panelVersion}.`,
        server_id: server.id,
        server_name: server.name,
        href: `/infrastructure/servers/${server.id}`,
        since: server.updatedAt.toISOString(),
      });
    }

    /* ------------------------------ audit ---------------------------- */

    const recentAudit: AuditEvent[] = [];
    if (holds(req, "security.audit:read")) {
      const rows = await req.ctx.db
        .select({ event: auditEvents, serverName: servers.name })
        .from(auditEvents)
        .leftJoin(servers, eq(auditEvents.serverId, servers.id))
        .where(combine(scopeFilter(req, "security.audit:read", auditEvents.serverId)))
        .orderBy(desc(auditEvents.seq))
        .limit(10);

      for (const row of rows) recentAudit.push(toAuditEvent(row.event, row.serverName));
    }

    /* ---------------------------- assemble --------------------------- */

    attention.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.since < b.since ? 1 : a.since > b.since ? -1 : 0),
    );

    const summary: CommandCenterSummary = {
      fleet: rollup(fleetRows, latest, openAlerts),
      attention: attention.slice(0, MAX_ATTENTION),
      recent_jobs: recentJobs.map((r) => req.ctx.queue.toApi(r.job, r.serverName)),
      recent_audit: recentAudit,
      certificates_expiring: certificatesExpiring,
      backups,
      threats_24h: threats,
    };

    return item(reply, summary);
  });
}

/* ------------------------------------------------------------------ */

/** True when the caller holds the permission anywhere at all. */
function holds(req: FastifyRequest, permission: Permission): boolean {
  const scope = visibleServerIds(req, permission);
  return scope === "global" || scope.length > 0;
}

/** Health reasons are written as "critical:disk / 95% full" by the reconciler. */
function splitReason(reason: string): [string, string] {
  const index = reason.indexOf(":");
  if (index < 0) return ["warning", reason];
  return [reason.slice(0, index), reason.slice(index + 1)];
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function humanDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Aggregates come back as a Date or a string depending on the driver. */
function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/** Numeric-prefix comparison; a build suffix never makes a version newer. */
function isOlder(version: string, reference: string): boolean {
  const left = version.split(/[.\-+]/).map((p) => Number.parseInt(p, 10));
  const right = reference.split(/[.\-+]/).map((p) => Number.parseInt(p, 10));

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || Number.isNaN(a)) return b !== undefined && !Number.isNaN(b) && b > 0;
    if (b === undefined || Number.isNaN(b)) return false;
    if (a !== b) return a < b;
  }
  return false;
}

function toAuditEvent(row: typeof auditEvents.$inferSelect, serverName: string | null): AuditEvent {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    actor_type: row.actorType,
    actor_id: row.actorId,
    actor_name: row.actorName,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    target_label: row.targetLabel,
    server_id: row.serverId,
    server_name: serverName,
    ip: row.ip,
    user_agent: row.userAgent,
    metadata: row.metadata,
    diff: row.diff as AuditEvent["diff"],
    job_id: row.jobId,
    prev_hash: row.prevHash,
    hash: row.hash,
  };
}
