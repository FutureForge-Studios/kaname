import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from "@kaname/db";
import {
  auditEvents,
  firewallRules,
  firewallState,
  servers,
  sshConfigs,
  sshKeys,
  threatEvents,
} from "@kaname/db/schema";
import {
  applyFirewallInput,
  applySshConfigInput,
  auditEventListQuery,
  createFirewallRuleInput,
  createIpBlockInput,
  createSshKeyInput,
  firewallRuleListQuery,
  idParam,
  ipAddress,
  sshKeyListQuery,
  threatEventListQuery,
  threatSummaryQuery,
  updateFirewallRuleInput,
  uuid,
  type AuditEvent,
  type AuditEventListQuery,
  type AuditVerification,
  type FirewallRule,
  type FirewallStatus,
  type Job,
  type SshConfig,
  type SshKey,
  type SshSession,
  type ThreatEvent,
  type ThreatSummary,
  type TimeRange,
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
  requireServerId,
} from "../http/plugin.js";
import { ApiException, badRequest, conflict, notFound } from "../lib/errors.js";
import {
  combine,
  enqueueFanOut,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  visibleServerIds,
  type ServerRow,
} from "./_shared.js";
import { rangeMs } from "./servers.js";

/* ------------------------------------------------------------------ *
 * Security — firewall, threat protection, SSH and audit.
 *
 * Two things here are not like the rest of the API. The firewall and
 * sshd apply paths carry a rollback window, because the operator can
 * lock themselves out of the box they are administering; every response
 * on those paths says out loud what will happen and when. And the audit
 * trail is read-only by construction (KD-009) — there is no route in
 * this file, or anywhere else, that writes to it directly.
 * ------------------------------------------------------------------ */

const SORTABLE_RULES = {
  priority: firewallRules.priority,
  action: firewallRules.action,
  direction: firewallRules.direction,
  protocol: firewallRules.protocol,
  port_spec: firewallRules.portSpec,
  hit_count: firewallRules.hitCount,
  server: servers.name,
  created_at: firewallRules.createdAt,
} as const;

const SORTABLE_THREATS = {
  last_seen: threatEvents.lastSeen,
  first_seen: threatEvents.firstSeen,
  attempts: threatEvents.attempts,
  kind: threatEvents.kind,
  source_ip: threatEvents.sourceIp,
  server: servers.name,
} as const;

const SORTABLE_KEYS = {
  name: sshKeys.name,
  type: sshKeys.type,
  fingerprint: sshKeys.fingerprint,
  last_used_at: sshKeys.lastUsedAt,
  created_at: sshKeys.createdAt,
} as const;

const SORTABLE_AUDIT = {
  ts: auditEvents.ts,
  action: auditEvents.action,
  actor: auditEvents.actorName,
  target_type: auditEvents.targetType,
  seq: auditEvents.seq,
} as const;

const serverBody = z.object({ server_id: uuid });
const ipParam = z.object({ ip: ipAddress });
const fleetTargetBody = z.object({ server_id: uuid.nullable().default(null) });

export async function securityRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- firewall ---------------------------- */

  app.get("/firewall", async (req, reply) => {
    const q = parseQuery(req, firewallRuleListQuery);
    helpers(req).authorize("security.firewall:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "security.firewall:read", firewallRules.serverId),
      q.server_id ? eq(firewallRules.serverId, q.server_id) : null,
      q.action ? eq(firewallRules.action, q.action) : null,
      q.direction ? eq(firewallRules.direction, q.direction) : null,
      q.protocol ? eq(firewallRules.protocol, q.protocol) : null,
      q.managed_by ? eq(firewallRules.managedBy, q.managed_by) : null,
      q.enabled !== undefined ? eq(firewallRules.enabled, q.enabled) : null,
      term
        ? sql`(lower(coalesce(${firewallRules.comment}, '')) like ${term} or coalesce(${firewallRules.portSpec}, '') like ${term} or coalesce(${firewallRules.sourceCidr}, '') like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_RULES, q.sort, "priority");
    const rows = await req.ctx.db
      .select({ rule: firewallRules, serverName: servers.name })
      .from(firewallRules)
      .innerJoin(servers, eq(firewallRules.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(firewallRules)
      .innerJoin(servers, eq(firewallRules.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toRule(r.rule, r.serverName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/firewall/status", async (req, reply) => {
    const q = parseQuery(req, z.object({ server_id: uuid.optional() }));
    const serverId = requireServerId(q.server_id);
    const server = await loadServer(req, serverId, "security.firewall:read");

    const state = await firewallStateRow(req, serverId);
    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(firewallRules)
      .where(eq(firewallRules.serverId, serverId));

    // A rule edited since the last apply exists in Kaname but not on the
    // host. Counting them is what stops the page claiming a rule is live
    // when it is only saved.
    const [pending] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(firewallRules)
      .where(
        combine(
          eq(firewallRules.serverId, serverId),
          state?.lastAppliedAt ? gt(firewallRules.updatedAt, state.lastAppliedAt) : null,
        ),
      );

    return item(reply, toStatus(server, state, total?.n ?? 0, pending?.n ?? 0));
  });

  app.post("/firewall", async (req, reply) => {
    const body = parseBody(req, createFirewallRuleInput);
    const server = await loadServer(req, body.server_id, "security.firewall:write");
    const h = helpers(req);

    const [row] = await req.ctx.db
      .insert(firewallRules)
      .values({
        serverId: body.server_id,
        priority: body.priority,
        action: body.action,
        direction: body.direction,
        protocol: body.protocol,
        portSpec: body.port_spec ?? null,
        sourceCidr: body.source_cidr ?? null,
        destCidr: body.dest_cidr ?? null,
        comment: body.comment ?? null,
        enabled: body.enabled,
        managedBy: "kaname",
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "firewall.rule_created",
      targetType: "firewall_rule",
      targetId: row!.id,
      targetLabel: describeRule(row!),
      serverId: server.id,
      after: body,
    });
    req.ctx.events.publish(
      "servers",
      "firewall.rule_created",
      { rule_id: row!.id, server_id: server.id },
      server.id,
    );

    // Rules are staged until /firewall/apply, so the warning is advance
    // notice rather than a post-mortem.
    const lockout = await assessLockout(req, server);
    return reply.status(201).send({ data: { rule: toRule(row!, server.name), lockout } });
  });

  app.patch("/firewall/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateFirewallRuleInput);
    const { rule, server } = await loadRule(req, id, "security.firewall:write");
    const h = helpers(req);

    const [row] = await req.ctx.db
      .update(firewallRules)
      .set({
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
        ...(body.direction !== undefined ? { direction: body.direction } : {}),
        ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
        ...(body.port_spec !== undefined ? { portSpec: body.port_spec } : {}),
        ...(body.source_cidr !== undefined ? { sourceCidr: body.source_cidr } : {}),
        ...(body.dest_cidr !== undefined ? { destCidr: body.dest_cidr } : {}),
        ...(body.comment !== undefined ? { comment: body.comment } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(firewallRules.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "firewall.rule_updated",
      targetType: "firewall_rule",
      targetId: id,
      targetLabel: describeRule(row!),
      serverId: server.id,
      before: { rule: describeRule(rule) },
      after: body,
    });
    req.ctx.events.publish("servers", "firewall.rule_updated", { rule_id: id }, server.id);

    const lockout = await assessLockout(req, server);
    return item(reply, { rule: toRule(row!, server.name), lockout });
  });

  app.delete("/firewall/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { rule, server } = await loadRule(req, id, "security.firewall:write");
    const h = helpers(req);

    await req.ctx.db.delete(firewallRules).where(eq(firewallRules.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "firewall.rule_deleted",
      targetType: "firewall_rule",
      targetId: id,
      targetLabel: describeRule(rule),
      serverId: server.id,
      before: { rule: describeRule(rule) },
    });
    req.ctx.events.publish("servers", "firewall.rule_deleted", { rule_id: id }, server.id);

    return noContent(reply);
  });

  /**
   * Replaces the rule set on the host. The agent applies it, then reverts
   * unless `/firewall/confirm` arrives inside `rollback_seconds` — which
   * is the only thing standing between a typo and losing the box.
   */
  app.post("/firewall/apply", async (req, reply) => {
    const body = parseBody(req, applyFirewallInput);
    const server = await loadServer(req, body.server_id, "security.firewall:write");
    const h = helpers(req);

    const proposed: ProposedRule[] = body.rules.map((rule) => ({
      priority: rule.priority,
      action: rule.action,
      direction: rule.direction,
      protocol: rule.protocol,
      port_spec: rule.port_spec ?? null,
      source_cidr: rule.source_cidr ?? null,
      dest_cidr: rule.dest_cidr ?? null,
      comment: rule.comment ?? null,
      enabled: rule.enabled,
    }));

    const lockout = await assessProposal(
      req,
      server,
      proposed,
      body.default_inbound,
      body.default_outbound,
    );

    // A rule set that cuts us off AND has no rollback window is not a
    // warning, it is an outage with no way back. Refuse it by name.
    if (lockout.locks_out && body.rollback_seconds === 0) {
      throw new ApiException(
        "precondition_failed",
        `This rule set would cut Kaname off from ${server.name} and you asked for no rollback window.`,
        {
          detail: lockout,
          remediation: {
            summary:
              "Set rollback_seconds to at least 30 so the host reverts on its own if you lose access, or add the allow rules named in the checks below.",
            actions: [
              { label: "Review rules", href: `/security/firewall?server_id=${server.id}` },
              { label: "Copy suggested rule", copy: lockout.checks[0]?.remediation ?? "" },
            ],
          },
        },
      );
    }

    await req.ctx.db.delete(firewallRules).where(eq(firewallRules.serverId, server.id));
    for (const rule of proposed) {
      await req.ctx.db.insert(firewallRules).values({
        serverId: server.id,
        priority: rule.priority,
        action: rule.action,
        direction: rule.direction,
        protocol: rule.protocol,
        portSpec: rule.port_spec,
        sourceCidr: rule.source_cidr,
        destCidr: rule.dest_cidr,
        comment: rule.comment,
        enabled: rule.enabled,
        managedBy: "kaname",
      });
    }

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "firewall.applied",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
      metadata: {
        rules: proposed.length,
        default_inbound: body.default_inbound,
        default_outbound: body.default_outbound,
        rollback_seconds: body.rollback_seconds,
        locks_out: lockout.locks_out,
      },
      after: { rules: proposed.map(describeProposed) },
    });

    const job = await enqueueServerJob(req, {
      type: "fw.apply",
      server,
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      params: {
        default_inbound: body.default_inbound,
        default_outbound: body.default_outbound,
        rollback_seconds: body.rollback_seconds,
        rules: proposed.map((rule) => ({
          priority: rule.priority,
          action: rule.action,
          direction: rule.direction,
          protocol: rule.protocol,
          port_spec: rule.port_spec,
          source: rule.source_cidr,
          destination: rule.dest_cidr,
          comment: rule.comment,
        })),
      },
    });

    return reply.status(202).send({
      data: {
        job,
        lockout,
        rollback: {
          seconds: body.rollback_seconds,
          confirm_action: "firewall.confirm",
          confirm_href: `/api/v1/firewall/confirm`,
          summary:
            body.rollback_seconds > 0
              ? `${server.name} reverts to its previous rule set in ${body.rollback_seconds} seconds unless you confirm. Check that you can still reach the host first — if you cannot, do nothing and it comes back on its own.`
              : "No rollback window was requested. These rules stay in place even if they lock you out.",
        },
      },
    });
  });

  /**
   * Cancels the pending revert. This is the one host-touching call in the
   * API that is not a job: the window is at most 300 seconds and a queue
   * cannot promise to land inside it, and a confirmation that is lost is
   * not lost work — the rules revert, which is the safe outcome the
   * window exists to guarantee (KD-008).
   */
  app.post("/firewall/confirm", async (req, reply) => {
    const body = parseBody(req, serverBody);
    const server = await loadConnectedServer(req, body.server_id, "security.firewall:write");
    const h = helpers(req);

    const state = await firewallStateRow(req, server.id);
    if (!state?.pendingRollbackToken) {
      throw conflict(`${server.name} has no firewall rule set waiting to be confirmed.`, {
        summary: "Either it was already confirmed, or the window closed and the host reverted.",
        actions: [{ label: "Firewall status", href: `/security/firewall?server_id=${server.id}` }],
      });
    }
    if (state.pendingRollbackUntil && state.pendingRollbackUntil.getTime() < Date.now()) {
      throw conflict(
        `The rollback window on ${server.name} closed at ${state.pendingRollbackUntil.toISOString()}.`,
        {
          summary:
            "The host has already reverted to its previous rule set. Apply the rules again, then confirm inside the window.",
          actions: [{ label: "Apply rules", action: "firewall.apply" }],
        },
      );
    }

    await req.ctx.hub.call(
      server.id,
      "fw.confirm",
      { rollback_token: state.pendingRollbackToken },
      { timeoutMs: 10_000 },
    );

    const now = new Date();
    await req.ctx.db
      .update(firewallState)
      .set({ pendingRollbackToken: null, pendingRollbackUntil: null, updatedAt: now })
      .where(eq(firewallState.serverId, server.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "firewall.confirmed",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
    });
    req.ctx.events.publish("servers", "firewall.confirmed", { server_id: server.id }, server.id);

    const [counts] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(firewallRules)
      .where(eq(firewallRules.serverId, server.id));

    return item(
      reply,
      toStatus(
        server,
        { ...state, pendingRollbackToken: null, pendingRollbackUntil: null, lastAppliedAt: now },
        counts?.n ?? 0,
        0,
      ),
    );
  });

  /* ----------------------------- threats ---------------------------- */

  app.get("/threats", async (req, reply) => {
    const q = parseQuery(req, threatEventListQuery);
    helpers(req).authorize("security.threats:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "security.threats:read", threatEvents.serverId),
      q.server_id ? eq(threatEvents.serverId, q.server_id) : null,
      q.kind ? eq(threatEvents.kind, q.kind) : null,
      q.disposition ? eq(threatEvents.disposition, q.disposition) : null,
      q.source_ip ? eq(threatEvents.sourceIp, q.source_ip) : null,
      q.from ? gte(threatEvents.lastSeen, new Date(q.from)) : null,
      q.to ? lte(threatEvents.lastSeen, new Date(q.to)) : null,
      term
        ? sql`(host(${threatEvents.sourceIp}) like ${term} or lower(${threatEvents.target}) like ${term} or lower(${threatEvents.kind}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_THREATS, q.sort, "last_seen");
    const rows = await req.ctx.db
      .select({ threat: threatEvents, serverName: servers.name })
      .from(threatEvents)
      .innerJoin(servers, eq(threatEvents.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(threatEvents)
      .innerJoin(servers, eq(threatEvents.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toThreat(r.threat, r.serverName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  /**
   * Counts over a window and nothing else. Background SSH scanning is
   * weather; a page that dramatises it teaches the operator to ignore the
   * day it matters.
   */
  app.get("/threats/summary", async (req, reply) => {
    const q = parseQuery(req, threatSummaryQuery);
    helpers(req).authorize("security.threats:read");

    const since = new Date(Date.now() - rangeMs(q.window));
    const where = combine(
      scopeFilter(req, "security.threats:read", threatEvents.serverId),
      q.server_id ? eq(threatEvents.serverId, q.server_id) : null,
      gte(threatEvents.lastSeen, since),
    );

    const banned = sql<number>`sum(case when ${threatEvents.disposition} = 'banned' then ${threatEvents.attempts} else 0 end)::int`;
    const [totals] = await req.ctx.db
      .select({
        attempts: sql<number>`coalesce(sum(${threatEvents.attempts}), 0)::int`,
        sources: sql<number>`count(distinct ${threatEvents.sourceIp})::int`,
        banned: sql<number>`coalesce(sum(case when ${threatEvents.disposition} = 'banned' then 1 else 0 end), 0)::int`,
      })
      .from(threatEvents)
      .where(where);

    // Attempts rather than rows, so the parts add up to total_attempts.
    const byKind = await req.ctx.db
      .select({
        kind: threatEvents.kind,
        count: sql<number>`coalesce(sum(${threatEvents.attempts}), 0)::int`,
      })
      .from(threatEvents)
      .where(where)
      .groupBy(threatEvents.kind);

    const topSources = await req.ctx.db
      .select({
        ip: sql<string>`host(${threatEvents.sourceIp})`,
        country: threatEvents.sourceCountry,
        kind: threatEvents.kind,
        attempts: sql<number>`coalesce(sum(${threatEvents.attempts}), 0)::int`,
        banned: sql<number>`coalesce(max(case when ${threatEvents.disposition} = 'banned' then 1 else 0 end), 0)::int`,
      })
      .from(threatEvents)
      .where(where)
      .groupBy(threatEvents.sourceIp, threatEvents.sourceCountry, threatEvents.kind)
      .orderBy(desc(sql`coalesce(sum(${threatEvents.attempts}), 0)`))
      .limit(10);

    // sql.raw for the trunc unit: as a bind parameter it lands as a
    // different placeholder in SELECT and GROUP BY, and Postgres then
    // cannot see the two expressions as the same one. The value comes
    // from a fixed lookup keyed by a validated enum, never from input.
    const bucket = TIMELINE_BUCKET[q.window];
    const bucketExpr = sql<string>`date_trunc('${sql.raw(bucket)}', ${threatEvents.lastSeen})`;
    const timeline = await req.ctx.db
      .select({
        ts: bucketExpr,
        attempts: sql<number>`coalesce(sum(${threatEvents.attempts}), 0)::int`,
        banned: sql<number>`coalesce(${banned}, 0)::int`,
      })
      .from(threatEvents)
      .where(where)
      .groupBy(bucketExpr)
      .orderBy(asc(bucketExpr));

    const summary: ThreatSummary = {
      window: q.window,
      total_attempts: totals?.attempts ?? 0,
      unique_sources: totals?.sources ?? 0,
      banned_count: totals?.banned ?? 0,
      by_kind: byKind.map((row) => ({ kind: row.kind, count: row.count })),
      top_sources: topSources.map((row) => ({
        ip: row.ip,
        country: row.country,
        attempts: row.attempts,
        kind: row.kind,
        banned: row.banned > 0,
      })),
      timeline: timeline.map((row) => ({
        ts: new Date(row.ts).toISOString(),
        attempts: row.attempts,
        banned: row.banned,
      })),
    };
    return item(reply, summary);
  });

  app.post("/threats/:ip/ban", async (req, reply) => {
    const { ip } = parseParams(req, ipParam);
    const body = parseBody(req, createIpBlockInput.omit({ target: true }));
    const target = normalizeCidr(ip);
    const targets = await banTargets(req, body.server_id);

    const fan = await enqueueFanOut(
      req,
      "fw.ban",
      targets.map((server) => ({
        server,
        targetId: server.id,
        targetLabel: `${target} on ${server.name}`,
        params: { target, duration_seconds: body.duration_seconds, reason: body.reason },
      })),
    );

    await markDisposition(req, ip, targets, "banned");
    req.ctx.events.publish("threats", "ip.ban_requested", {
      cidr: target,
      servers: targets.map((s) => s.id),
    });

    return fanOutReply(reply, fan);
  });

  app.post("/threats/:ip/unban", async (req, reply) => {
    const { ip } = parseParams(req, ipParam);
    const body = parseBody(req, fleetTargetBody);
    const target = normalizeCidr(ip);
    const targets = await banTargets(req, body.server_id);

    const fan = await enqueueFanOut(
      req,
      "fw.unban",
      targets.map((server) => ({
        server,
        targetId: server.id,
        targetLabel: `${target} on ${server.name}`,
        params: { target },
      })),
    );

    await markDisposition(req, ip, targets, "observed");
    req.ctx.events.publish("threats", "ip.unban_requested", {
      cidr: target,
      servers: targets.map((s) => s.id),
    });

    return fanOutReply(reply, fan);
  });

  /**
   * Control-plane only: an ignored source stops surfacing in the list and
   * the summary, but nothing changes on the host. Nobody is fooled into
   * thinking the traffic stopped.
   */
  app.post("/threats/:ip/ignore", async (req, reply) => {
    const { ip } = parseParams(req, ipParam);
    const body = parseBody(req, fleetTargetBody);
    const h = helpers(req);

    const targets = await banTargets(req, body.server_id);
    const updated = await markDisposition(req, ip, targets, "ignored");

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "threat.ignored",
      targetType: "threat_source",
      targetId: null,
      targetLabel: ip,
      serverId: body.server_id,
      after: { source_ip: ip, events: updated, servers: targets.map((s) => s.name) },
    });
    req.ctx.events.publish("threats", "threat.ignored", { source_ip: ip, events: updated });

    return item(reply, {
      source_ip: ip,
      disposition: "ignored",
      events_updated: updated,
      note: "Ignored in Kaname only. The host still sees this traffic and the firewall is unchanged.",
    });
  });

  /* ------------------------------- ssh ------------------------------ */

  app.get("/ssh/keys", async (req, reply) => {
    const q = parseQuery(req, sshKeyListQuery);
    helpers(req).authorize("security.ssh:read");

    const term = searchTerm(q.q);
    const where = combine(
      sshKeyScope(req, "security.ssh:read"),
      q.server_id ? sql`${q.server_id}::uuid = any(${sshKeys.serverIds})` : null,
      q.user_id ? eq(sshKeys.userId, q.user_id) : null,
      q.type ? eq(sshKeys.type, q.type) : null,
      term
        ? sql`(lower(${sshKeys.name}) like ${term} or lower(${sshKeys.comment}) like ${term} or lower(${sshKeys.fingerprint}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_KEYS, q.sort, "name");
    const rows = await req.ctx.db
      .select()
      .from(sshKeys)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sshKeys)
      .where(where);

    return list(reply, rows.map(toSshKey), paginate(total?.n ?? 0, q.page, q.per_page));
  });

  app.post("/ssh/keys", async (req, reply) => {
    const body = parseBody(req, createSshKeyInput);
    const h = helpers(req);
    h.authorize("security.ssh:write");

    const parsed = parsePublicKey(body.public_key);
    const clash = await req.ctx.db
      .select({ id: sshKeys.id, name: sshKeys.name })
      .from(sshKeys)
      .where(eq(sshKeys.fingerprint, parsed.fingerprint))
      .limit(1);
    if (clash[0]) {
      throw conflict(`That key is already registered as "${clash[0].name}".`, {
        summary: `A fingerprint names exactly one key. ${parsed.fingerprint} is already in Kaname.`,
        actions: [{ label: "Open it", href: `/security/ssh/keys/${clash[0].id}` }],
      });
    }

    // Every target server is authorised before the key row exists, so a
    // key can never be written naming a host the caller may not touch.
    const targets: ServerRow[] = [];
    for (const serverId of body.server_ids) {
      targets.push(await loadServer(req, serverId, "security.ssh:write"));
    }

    const [row] = await req.ctx.db
      .insert(sshKeys)
      .values({
        name: body.name,
        publicKey: parsed.normalized,
        fingerprint: parsed.fingerprint,
        type: parsed.type,
        comment: parsed.comment,
        userId: body.user_id,
        serverIds: body.server_ids,
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "ssh_key.created",
      targetType: "ssh_key",
      targetId: row!.id,
      targetLabel: `${body.name} (${parsed.fingerprint})`,
      after: {
        name: body.name,
        fingerprint: parsed.fingerprint,
        servers: targets.map((s) => s.name),
      },
    });
    req.ctx.events.publish("servers", "ssh_key.created", { ssh_key_id: row!.id });

    if (targets.length === 0) {
      return reply.status(201).send({ data: { ssh_key: toSshKey(row!), jobs: [] } });
    }

    const correlationId = crypto.randomUUID();
    const jobs = await pushAuthorizedKeys(req, targets, correlationId);
    return reply.status(202).send({
      data: { job: jobs[0] ?? null, jobs, correlation_id: correlationId, ssh_key: toSshKey(row!) },
    });
  });

  app.delete("/ssh/keys/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("security.ssh:write");

    const rows = await req.ctx.db.select().from(sshKeys).where(eq(sshKeys.id, id)).limit(1);
    const key = rows[0];
    if (!key) throw notFound("SSH key", id);

    const targets: ServerRow[] = [];
    for (const serverId of key.serverIds) {
      targets.push(await loadServer(req, serverId, "security.ssh:write"));
    }

    await req.ctx.db.delete(sshKeys).where(eq(sshKeys.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "ssh_key.deleted",
      targetType: "ssh_key",
      targetId: id,
      targetLabel: `${key.name} (${key.fingerprint})`,
      before: { name: key.name, fingerprint: key.fingerprint, servers: targets.map((s) => s.name) },
    });
    req.ctx.events.publish("servers", "ssh_key.deleted", { ssh_key_id: id });

    if (targets.length === 0) return noContent(reply);

    // The key is gone from Kaname, but it is still in authorized_keys
    // until the host is rewritten — so that rewrite is the real work.
    const correlationId = crypto.randomUUID();
    const jobs = await pushAuthorizedKeys(req, targets, correlationId);
    return reply.status(202).send({
      data: { job: jobs[0] ?? null, jobs, correlation_id: correlationId },
    });
  });

  app.get("/ssh/config", async (req, reply) => {
    const q = parseQuery(
      req,
      z.object({ server_id: uuid.optional(), refresh: z.coerce.boolean().default(false) }),
    );
    const serverId = requireServerId(q.server_id);
    const server = await loadServer(req, serverId, "security.ssh:read");

    const cached = await sshConfigRow(req, serverId);
    if (cached && !q.refresh) return item(reply, toSshConfig(server, cached));

    // Reading sshd's effective config has no side effect, so it passes
    // through rather than becoming a job (KD-008).
    await loadConnectedServer(req, serverId, "security.ssh:read");
    const live = await req.ctx.hub.call(server.id, "ssh.config.read", {}, { timeoutMs: 15_000 });
    const now = new Date();

    const [row] = await req.ctx.db
      .insert(sshConfigs)
      .values({
        serverId,
        port: live.port,
        permitRootLogin: live.permit_root_login,
        passwordAuthentication: live.password_authentication,
        pubkeyAuthentication: live.pubkey_authentication,
        maxAuthTries: live.max_auth_tries,
        allowUsers: live.allow_users,
        allowGroups: live.allow_groups,
        x11Forwarding: live.x11_forwarding,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: sshConfigs.serverId,
        set: {
          port: live.port,
          permitRootLogin: live.permit_root_login,
          passwordAuthentication: live.password_authentication,
          pubkeyAuthentication: live.pubkey_authentication,
          maxAuthTries: live.max_auth_tries,
          allowUsers: live.allow_users,
          allowGroups: live.allow_groups,
          x11Forwarding: live.x11_forwarding,
          lastSyncedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    return item(reply, toSshConfig(server, row!));
  });

  /**
   * Same lockout guard as the firewall: sshd is applied with a rollback
   * window, and the response says what reverts and when.
   */
  app.put("/ssh/config", async (req, reply) => {
    const q = parseQuery(req, z.object({ server_id: uuid.optional() }));
    const body = parseBody(req, applySshConfigInput);
    const serverId = requireServerId(q.server_id);
    const server = await loadServer(req, serverId, "security.ssh:write");
    const h = helpers(req);

    const current = await sshConfigRow(req, serverId);
    const warnings = await assessSshLockout(req, server, current, body);

    const { rollback_seconds, ...desired } = body;
    const params = Object.fromEntries(
      Object.entries({
        port: desired.port,
        permit_root_login: desired.permit_root_login,
        password_authentication: desired.password_authentication,
        pubkey_authentication: desired.pubkey_authentication,
        max_auth_tries: desired.max_auth_tries,
        allow_users: desired.allow_users,
        allow_groups: desired.allow_groups,
        x11_forwarding: desired.x11_forwarding,
      }).filter(([, value]) => value !== undefined),
    );

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "ssh.config_apply_requested",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
      before: current ? toSshConfig(server, current) : null,
      after: { ...params, rollback_seconds },
      metadata: { warnings: warnings.checks.map((c) => c.code) },
    });

    const job = await enqueueServerJob(req, {
      type: "ssh.config.apply",
      server,
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      params: { ...params, rollback_seconds },
    });

    return reply.status(202).send({
      data: {
        job,
        lockout: warnings,
        rollback: {
          seconds: rollback_seconds,
          summary:
            rollback_seconds > 0
              ? `sshd on ${server.name} reverts to its current configuration in ${rollback_seconds} seconds unless the new one holds. Open a second SSH session before you close this one.`
              : "No rollback window was requested. If the new sshd configuration locks you out, it stays that way.",
        },
      },
    });
  });

  /** Live, never cached — a session list is only true at the instant it is read. */
  app.get("/ssh/sessions", async (req, reply) => {
    const q = parseQuery(req, z.object({ server_id: uuid.optional() }));
    const serverId = requireServerId(q.server_id);
    const server = await loadConnectedServer(req, serverId, "security.ssh:read");

    const live = await req.ctx.hub.call(server.id, "ssh.sessions.list", {}, { timeoutMs: 15_000 });
    const sessions: SshSession[] = live.sessions.map((s) => ({
      server_id: server.id,
      server_name: server.name,
      user: s.user,
      from_ip: s.from_ip,
      tty: s.tty,
      pid: s.pid,
      started_at: new Date(s.started_at).toISOString(),
      idle_seconds: s.idle_seconds,
    }));

    return list(reply, sessions, paginate(sessions.length, 1, Math.max(sessions.length, 1)));
  });

  /* ------------------------------ audit ----------------------------- */

  app.get("/audit", async (req, reply) => {
    const q = parseQuery(req, auditEventListQuery);
    helpers(req).authorize("security.audit:read");

    const where = auditFilter(req, q);
    const column = sortColumn(SORTABLE_AUDIT, q.sort, "ts");
    const rows = await req.ctx.db
      .select({ event: auditEvents, serverName: servers.name })
      .from(auditEvents)
      .leftJoin(servers, eq(auditEvents.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEvents)
      .leftJoin(servers, eq(auditEvents.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toAuditEvent(r.event, r.serverName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  /**
   * Walks the hash chain from genesis. This is what makes the Audit page
   * an assertion rather than a list: an attacker who deletes a row makes
   * every later row fail to chain, and `broken_at` names the first one.
   */
  app.get("/audit/verify", async (req, reply) => {
    helpers(req).authorize("security.audit:read");
    const result = await req.ctx.audit.verify();

    const verification: AuditVerification = {
      verified: result.verified,
      events_checked: result.eventsChecked,
      first_event_at: result.firstEventAt,
      last_event_at: result.lastEventAt,
      broken_at: result.brokenAt,
      checked_at: result.checkedAt,
    };
    return item(reply, verification);
  });

  /** NDJSON so the whole trail streams without ever being held in memory. */
  app.get("/audit/export", async (req, reply) => {
    const q = parseQuery(req, auditEventListQuery);
    const h = helpers(req);
    h.authorize("security.audit:read");

    const where = auditFilter(req, q);
    const stamp = new Date().toISOString().slice(0, 10);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "audit.exported",
      targetType: "audit",
      targetId: null,
      targetLabel: "audit trail",
      metadata: { filters: q },
    });

    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="kaname-audit-${stamp}.ndjson"`,
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });

    let after = 0;
    for (;;) {
      const batch = await req.ctx.db
        .select({ event: auditEvents, serverName: servers.name })
        .from(auditEvents)
        .leftJoin(servers, eq(auditEvents.serverId, servers.id))
        .where(combine(where, gt(auditEvents.seq, after)))
        .orderBy(asc(auditEvents.seq))
        .limit(EXPORT_BATCH);
      if (batch.length === 0) break;

      for (const row of batch) {
        reply.raw.write(`${JSON.stringify(toAuditEvent(row.event, row.serverName))}\n`);
      }
      after = batch[batch.length - 1]!.event.seq;
      if (batch.length < EXPORT_BATCH) break;
    }

    reply.raw.end();
    return reply;
  });
}

const EXPORT_BATCH = 1000;

const TIMELINE_BUCKET: Record<TimeRange, string> = {
  "1h": "minute",
  "6h": "hour",
  "24h": "hour",
  "7d": "day",
  "30d": "day",
  "90d": "day",
};

/* ------------------------------------------------------------------ *
 * Loaders and scopes
 * ------------------------------------------------------------------ */

type RuleRow = typeof firewallRules.$inferSelect;
type StateRow = typeof firewallState.$inferSelect;
type SshConfigRow = typeof sshConfigs.$inferSelect;

async function loadRule(
  req: FastifyRequest,
  id: string,
  permission: "security.firewall:read" | "security.firewall:write",
): Promise<{ rule: RuleRow; server: ServerRow }> {
  helpers(req).authorize(permission);
  const rows = await req.ctx.db
    .select()
    .from(firewallRules)
    .where(eq(firewallRules.id, id))
    .limit(1);
  const rule = rows[0];
  if (!rule) throw notFound("Firewall rule", id);
  const server = await loadServer(req, rule.serverId, permission);
  return { rule, server };
}

async function firewallStateRow(req: FastifyRequest, serverId: string): Promise<StateRow | null> {
  const rows = await req.ctx.db
    .select()
    .from(firewallState)
    .where(eq(firewallState.serverId, serverId))
    .limit(1);
  return rows[0] ?? null;
}

async function sshConfigRow(req: FastifyRequest, serverId: string): Promise<SshConfigRow | null> {
  const rows = await req.ctx.db
    .select()
    .from(sshConfigs)
    .where(eq(sshConfigs.serverId, serverId))
    .limit(1);
  return rows[0] ?? null;
}

/** A key with no servers is fleet-wide and visible to anyone with the read grant. */
function sshKeyScope(req: FastifyRequest, permission: "security.ssh:read"): SQL | null {
  const scope = visibleServerIds(req, permission);
  if (scope === "global") return null;
  const unassigned = sql`cardinality(${sshKeys.serverIds}) = 0`;
  if (scope.length === 0) return unassigned;
  return or(unassigned, ...scope.map((id) => sql`${id}::uuid = any(${sshKeys.serverIds})`))!;
}

function auditFilter(req: FastifyRequest, q: AuditEventListQuery): SQL | undefined {
  const scope = scopeFilter(req, "security.audit:read", auditEvents.serverId);
  const term = searchTerm(q.q);
  return combine(
    // Fleet-wide entries have no server, and belong to everyone who may read the trail.
    scope ? or(isNull(auditEvents.serverId), scope)! : null,
    q.actor_type ? eq(auditEvents.actorType, q.actor_type) : null,
    q.actor_id ? eq(auditEvents.actorId, q.actor_id) : null,
    q.action ? sql`${auditEvents.action} like ${`${q.action}%`}` : null,
    q.target_type ? eq(auditEvents.targetType, q.target_type) : null,
    q.target_id ? eq(auditEvents.targetId, q.target_id) : null,
    q.server_id ? eq(auditEvents.serverId, q.server_id) : null,
    q.from ? gte(auditEvents.ts, new Date(q.from)) : null,
    q.to ? lte(auditEvents.ts, new Date(q.to)) : null,
    term
      ? sql`(lower(${auditEvents.action}) like ${term} or lower(${auditEvents.targetLabel}) like ${term} or lower(${auditEvents.actorName}) like ${term})`
      : null,
  );
}

/* ------------------------------------------------------------------ *
 * Threat actions
 * ------------------------------------------------------------------ */

/** One server, or every server the caller may act on when the ban is fleet-wide. */
async function banTargets(req: FastifyRequest, serverId: string | null): Promise<ServerRow[]> {
  if (serverId) return [await loadServer(req, serverId, "security.threats:write")];

  helpers(req).authorize("security.threats:write");
  const rows = await req.ctx.db
    .select()
    .from(servers)
    .where(scopeFilter(req, "security.threats:write", servers.id) ?? undefined)
    .orderBy(asc(servers.name));

  if (rows.length === 0) {
    throw badRequest("There are no servers in your scope to apply this to.", {
      server_id: "no server is both enrolled and within your security.threats:write scope",
    });
  }
  return rows;
}

async function markDisposition(
  req: FastifyRequest,
  ip: string,
  targets: ServerRow[],
  disposition: "banned" | "observed" | "ignored",
): Promise<number> {
  const rows = await req.ctx.db
    .update(threatEvents)
    .set({ disposition, updatedAt: new Date() })
    .where(
      and(
        eq(threatEvents.sourceIp, ip),
        inArray(
          threatEvents.serverId,
          targets.map((s) => s.id),
        ),
      ),
    )
    .returning({ id: threatEvents.id });
  return rows.length;
}

/** 202 shaped like `accepted`, widened so a fan-out can name all its children. */
function fanOutReply(
  reply: FastifyReply,
  fan: { correlation_id: string; jobs: Job[] },
): FastifyReply {
  return reply.status(202).send({
    data: { job: fan.jobs[0] ?? null, jobs: fan.jobs, correlation_id: fan.correlation_id },
  });
}

/** Single addresses become /32 or /128, so one column covers both forms. */
function normalizeCidr(ip: string): string {
  return ip.includes(":") ? `${ip}/128` : `${ip}/32`;
}

/* ------------------------------------------------------------------ *
 * SSH keys
 * ------------------------------------------------------------------ */

/**
 * `ssh.keys.apply` replaces a POSIX user's authorized_keys wholesale, so
 * every change to any key means resending that user's whole set.
 */
async function pushAuthorizedKeys(
  req: FastifyRequest,
  targets: ServerRow[],
  correlationId: string,
): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const server of targets) {
    const rows = await req.ctx.db
      .select()
      .from(sshKeys)
      .where(sql`${server.id}::uuid = any(${sshKeys.serverIds})`);

    const byUser = new Map<string, { public_key: string; comment: string }[]>();
    for (const key of rows) {
      const bucket = byUser.get(key.posixUser) ?? [];
      bucket.push({ public_key: key.publicKey, comment: key.comment });
      byUser.set(key.posixUser, bucket);
    }
    // A server that just lost its last key still needs the empty set pushed.
    if (byUser.size === 0) byUser.set("root", []);

    for (const [user, keys] of byUser) {
      jobs.push(
        await enqueueServerJob(req, {
          type: "ssh.keys.apply",
          server,
          targetType: "server",
          targetId: server.id,
          targetLabel: `${keys.length} key(s) for ${user}@${server.name}`,
          correlationId,
          params: { user, keys },
        }),
      );
    }
  }
  return jobs;
}

/** OpenSSH's own SHA256 fingerprint, so it matches `ssh-keygen -lf`. */
function parsePublicKey(publicKey: string): {
  normalized: string;
  type: string;
  comment: string;
  fingerprint: string;
} {
  const parts = publicKey.trim().split(/\s+/);
  const [type, blob] = parts;
  if (!type || !blob) {
    throw badRequest("That does not look like an OpenSSH public key.", {
      public_key: 'expected "<type> <base64> [comment]"',
    });
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(blob, "base64");
  } catch {
    raw = Buffer.alloc(0);
  }
  if (raw.length === 0) {
    throw badRequest("The key body is not valid base64.", {
      public_key: "unreadable key material",
    });
  }

  const digest = createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
  return {
    normalized: `${type} ${blob}`,
    type,
    comment: parts.slice(2).join(" "),
    fingerprint: `SHA256:${digest}`,
  };
}

/* ------------------------------------------------------------------ *
 * Lockout assessment
 *
 * The one thing an operator cannot undo from the panel is losing the
 * panel's own way in. These checks are evaluated against the address the
 * request came from, so the warning names the connection that would
 * actually break.
 * ------------------------------------------------------------------ */

interface LockoutCheck {
  code: string;
  severity: "critical" | "warning";
  message: string;
  remediation: string;
}

interface LockoutAssessment {
  locks_out: boolean;
  checked_from: string | null;
  checks: LockoutCheck[];
}

interface ProposedRule {
  priority: number;
  action: "allow" | "deny" | "reject";
  direction: "inbound" | "outbound";
  protocol: "tcp" | "udp" | "icmp" | "any";
  port_spec: string | null;
  source_cidr: string | null;
  dest_cidr: string | null;
  comment: string | null;
  enabled: boolean;
}

/** Assesses the rules currently staged for a server. */
async function assessLockout(req: FastifyRequest, server: ServerRow): Promise<LockoutAssessment> {
  const rules = await req.ctx.db
    .select()
    .from(firewallRules)
    .where(eq(firewallRules.serverId, server.id));
  const state = await firewallStateRow(req, server.id);

  return assessProposal(
    req,
    server,
    rules.map(toProposed),
    state?.defaultInbound ?? "deny",
    state?.defaultOutbound ?? "allow",
  );
}

function toProposed(row: RuleRow): ProposedRule {
  return {
    priority: row.priority,
    action: row.action,
    direction: row.direction,
    protocol: row.protocol,
    port_spec: row.portSpec,
    source_cidr: row.sourceCidr,
    dest_cidr: row.destCidr,
    comment: row.comment,
    enabled: row.enabled,
  };
}

async function assessProposal(
  req: FastifyRequest,
  server: ServerRow,
  rules: ProposedRule[],
  defaultInbound: "allow" | "deny",
  defaultOutbound: "allow" | "deny",
): Promise<LockoutAssessment> {
  const from = req.ip || null;
  const checks: LockoutCheck[] = [];

  const config = await sshConfigRow(req, server.id);
  const sshPort = config?.port ?? 22;
  const panel = panelPort(req.ctx.config.KANAME_PUBLIC_URL);

  if (from && !matches(rules, "inbound", "tcp", sshPort, from, defaultInbound)) {
    checks.push({
      code: "ssh_lockout",
      severity: "critical",
      message: `This rule set drops inbound TCP ${sshPort} from ${from} — the address this request came from. Applying it ends your SSH access to ${server.name}.`,
      remediation: `allow inbound tcp ${sshPort} from ${normalizeCidr(from)}`,
    });
  }

  // Null destination: the control plane may be anywhere, so a rule that
  // narrows the destination is treated as not covering it. That errs
  // towards warning, which is the right direction for a lockout check.
  if (!matches(rules, "outbound", "tcp", panel, null, defaultOutbound)) {
    checks.push({
      code: "agent_lockout",
      severity: "critical",
      message: `This rule set blocks outbound TCP ${panel}. The agent dials Kaname out on that port, so ${server.name} would stop answering the panel — including the panel's own way to undo this.`,
      remediation: `allow outbound tcp ${panel}`,
    });
  }

  if (from && !matches(rules, "inbound", "tcp", panel, from, defaultInbound)) {
    checks.push({
      code: "panel_port_closed",
      severity: "warning",
      message: `Inbound TCP ${panel} from ${from} is dropped. That only matters if Kaname itself is served from ${server.name}, but if it is, this is how you would lose the panel.`,
      remediation: `allow inbound tcp ${panel} from ${normalizeCidr(from)}`,
    });
  }

  return {
    locks_out: checks.some((c) => c.severity === "critical"),
    checked_from: from,
    checks,
  };
}

async function assessSshLockout(
  req: FastifyRequest,
  server: ServerRow,
  current: SshConfigRow | null,
  desired: {
    port?: number;
    password_authentication?: boolean;
    permit_root_login?: string;
    allow_users?: string[];
  },
): Promise<LockoutAssessment> {
  const checks: LockoutCheck[] = [];
  const from = req.ip || null;

  if (desired.password_authentication === false) {
    const [keys] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sshKeys)
      .where(sql`${server.id}::uuid = any(${sshKeys.serverIds})`);
    if ((keys?.n ?? 0) === 0) {
      checks.push({
        code: "no_key_no_password",
        severity: "critical",
        message: `Turning off password authentication on ${server.name} leaves no way in: Kaname has no SSH key assigned to this host.`,
        remediation: "add an SSH key for this server before disabling passwords",
      });
    }
  }

  const newPort = desired.port;
  if (newPort !== undefined && newPort !== (current?.port ?? 22)) {
    const state = await firewallStateRow(req, server.id);
    const rules = await req.ctx.db
      .select()
      .from(firewallRules)
      .where(eq(firewallRules.serverId, server.id));
    const reachable =
      !state?.enabled ||
      !from ||
      matches(rules.map(toProposed), "inbound", "tcp", newPort, from, state.defaultInbound);
    if (!reachable) {
      checks.push({
        code: "ssh_port_firewalled",
        severity: "critical",
        message: `sshd would move to port ${newPort}, but the firewall on ${server.name} does not allow inbound TCP ${newPort} from ${from}.`,
        remediation: `allow inbound tcp ${newPort} from ${normalizeCidr(from!)} before applying`,
      });
    }
  }

  if (
    desired.permit_root_login === "no" &&
    (desired.allow_users ?? current?.allowUsers ?? []).length === 0
  ) {
    checks.push({
      code: "root_denied_no_allow_users",
      severity: "warning",
      message: `Root login is being denied on ${server.name} and no AllowUsers list names a replacement account.`,
      remediation: "set allow_users to an account that exists on the host and has a key",
    });
  }

  return { locks_out: checks.some((c) => c.severity === "critical"), checked_from: from, checks };
}

/** First matching rule wins, lowest priority first — the backend's own order. */
function matches(
  rules: ProposedRule[],
  direction: "inbound" | "outbound",
  protocol: "tcp" | "udp",
  port: number,
  address: string | null,
  fallback: "allow" | "deny",
): boolean {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (rule.direction !== direction) continue;
    if (rule.protocol !== protocol && rule.protocol !== "any") continue;
    if (!portInSpec(rule.port_spec, port)) continue;
    const cidr = direction === "inbound" ? rule.source_cidr : rule.dest_cidr;
    if (cidr && (!address || !inCidr(address, cidr))) continue;
    return rule.action === "allow";
  }
  return fallback === "allow";
}

/** A null spec means the rule covers every port. */
function portInSpec(spec: string | null, port: number): boolean {
  if (!spec) return true;
  return spec.split(",").some((part) => {
    const [low, high] = part.split("-");
    const from = Number(low);
    const to = high === undefined ? from : Number(high);
    return Number.isFinite(from) && Number.isFinite(to) && port >= from && port <= to;
  });
}

function inCidr(address: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return address === cidr;

  const network = parseIp(cidr.slice(0, slash));
  const target = parseIp(address);
  const prefix = Number(cidr.slice(slash + 1));
  if (!network || !target || !Number.isFinite(prefix)) return false;
  if (network.bits !== target.bits) return false;
  if (prefix <= 0) return true;
  if (prefix > network.bits) return false;

  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(network.bits - prefix);
  return (network.value & mask) === (target.value & mask);
}

function parseIp(address: string): { value: bigint; bits: number } | null {
  return address.includes(":") ? parseIpv6(address) : parseIpv4(address);
}

function parseIpv4(address: string): { value: bigint; bits: number } | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  let value = 0n;
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return { value, bits: 32 };
}

function parseIpv6(address: string): { value: bigint; bits: number } | null {
  // An IPv4-mapped tail (::ffff:1.2.3.4) is rewritten to two hex groups first.
  const mapped = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let text = address;
  if (mapped) {
    const v4 = parseIpv4(mapped[2]!);
    if (!v4) return null;
    const high = (v4.value >> 16n).toString(16);
    const low = (v4.value & 0xffffn).toString(16);
    text = `${mapped[1]}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":").filter(Boolean) : []) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;

  const groups =
    halves.length === 1 ? head : [...head, ...Array<string>(missing).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return { value, bits: 128 };
}

function panelPort(publicUrl: string): number {
  try {
    const url = new URL(publicUrl);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return 443;
  }
}

/* ------------------------------------------------------------------ *
 * Row to API shape
 * ------------------------------------------------------------------ */

function describeRule(rule: RuleRow): string {
  return `${rule.action} ${rule.direction} ${rule.protocol}${rule.portSpec ? ` ${rule.portSpec}` : ""}${rule.sourceCidr ? ` from ${rule.sourceCidr}` : ""}`;
}

function describeProposed(rule: ProposedRule): string {
  return `${rule.action} ${rule.direction} ${rule.protocol}${rule.port_spec ? ` ${rule.port_spec}` : ""}${rule.source_cidr ? ` from ${rule.source_cidr}` : ""}`;
}

function toRule(row: RuleRow, serverName: string): FirewallRule {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: serverName,
    priority: row.priority,
    action: row.action,
    direction: row.direction,
    protocol: row.protocol,
    port_spec: row.portSpec,
    source_cidr: row.sourceCidr,
    dest_cidr: row.destCidr,
    comment: row.comment,
    enabled: row.enabled,
    managed_by: row.managedBy,
    hit_count: row.hitCount,
    last_synced_at: row.updatedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toStatus(
  server: ServerRow,
  state: StateRow | null,
  ruleCount: number,
  pending: number,
): FirewallStatus {
  return {
    server_id: server.id,
    server_name: server.name,
    backend: (state?.backend as FirewallStatus["backend"]) ?? "nftables",
    enabled: state?.enabled ?? false,
    default_inbound: state?.defaultInbound ?? "deny",
    default_outbound: state?.defaultOutbound ?? "allow",
    rule_count: ruleCount,
    last_applied_at: state?.lastAppliedAt?.toISOString() ?? null,
    pending_changes: pending,
    last_synced_at: (state?.updatedAt ?? new Date()).toISOString(),
  };
}

function toThreat(row: typeof threatEvents.$inferSelect, serverName: string): ThreatEvent {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: serverName,
    kind: row.kind,
    source_ip: row.sourceIp,
    source_country: row.sourceCountry,
    source_asn: row.sourceAsn,
    target: row.target,
    attempts: row.attempts,
    first_seen: row.firstSeen.toISOString(),
    last_seen: row.lastSeen.toISOString(),
    disposition: row.disposition,
    sample: row.sample,
    last_synced_at: row.updatedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toSshKey(row: typeof sshKeys.$inferSelect): SshKey {
  return {
    id: row.id,
    name: row.name,
    public_key: row.publicKey,
    fingerprint: row.fingerprint,
    type: row.type as SshKey["type"],
    comment: row.comment || null,
    user_id: row.userId,
    server_ids: row.serverIds,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toSshConfig(server: ServerRow, row: SshConfigRow): SshConfig {
  return {
    server_id: server.id,
    server_name: server.name,
    port: row.port,
    permit_root_login: row.permitRootLogin,
    password_authentication: row.passwordAuthentication,
    pubkey_authentication: row.pubkeyAuthentication,
    max_auth_tries: row.maxAuthTries,
    allow_users: row.allowUsers,
    allow_groups: row.allowGroups,
    x11_forwarding: row.x11Forwarding,
    last_applied_at: row.lastAppliedAt?.toISOString() ?? null,
    last_synced_at: (row.lastSyncedAt ?? row.updatedAt).toISOString(),
  };
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
