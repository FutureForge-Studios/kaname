import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, sql, type Database } from "@kaname/db";
import {
  certificates,
  containers,
  dbDatabases,
  enrollmentTokens,
  mailboxes,
  serverMetrics,
  servers,
  services,
  sites,
} from "@kaname/db/schema";
import {
  createServerInput,
  idParam,
  seriesQuery,
  serverListQuery,
  updateServerInput,
  type Server,
} from "@kaname/contract";
import { z } from "zod";
import {
  accepted,
  helpers,
  item,
  list,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { conflict, notFound } from "../lib/errors.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import type { AppContext } from "../context.js";
import {
  combine,
  enqueueServerJob,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Servers — the reference route module.
 *
 * Every other module follows this shape: a list route that respects the
 * caller's server scope, a detail route, control-plane-only mutations
 * that return the resource, and host-touching mutations that return
 * 202 with a job.
 * ------------------------------------------------------------------ */

const SORTABLE = {
  name: servers.name,
  hostname: servers.hostname,
  connection: servers.connection,
  health: servers.health,
  last_seen_at: servers.lastSeenAt,
  created_at: servers.createdAt,
} as const;

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/servers", async (req, reply) => {
    const q = parseQuery(req, serverListQuery);
    const h = helpers(req);
    h.authorize("infra.servers:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "infra.servers:read", servers.id),
      q.connection ? eq(servers.connection, q.connection) : null,
      q.health ? eq(servers.health, q.health) : null,
      q.capability ? sql`${q.capability} = any(${servers.capabilities})` : null,
      q.label ? sql`${servers.labels} ? ${q.label}` : null,
      term
        ? sql`(lower(${servers.name}) like ${term} or lower(${servers.hostname}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "name");
    const rows = await req.ctx.db
      .select()
      .from(servers)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(servers)
      .where(where);
    const total = counted[0]?.total ?? 0;

    const enriched = await Promise.all(rows.map((row) => toApi(req.ctx.db, row, { counts: true })));
    return list(reply, enriched, paginate(total, q.page, q.per_page));
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/servers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:read");
    return item(reply, await toApi(req.ctx.db, server, { counts: true }));
  });

  /* ----------------------------- create ----------------------------- */

  app.post("/servers", async (req, reply) => {
    const body = parseBody(req, createServerInput);
    const h = helpers(req);
    h.authorize("infra.servers:write");

    const existing = await req.ctx.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.name, body.name))
      .limit(1);
    if (existing[0]) {
      throw conflict(`A server named "${body.name}" already exists.`, {
        summary: "Server names are unique across the fleet.",
        actions: [{ label: "Open it", href: `/infrastructure/servers/${existing[0].id}` }],
      });
    }

    const [row] = await req.ctx.db
      .insert(servers)
      .values({
        name: body.name,
        hostname: body.hostname,
        address: body.address ?? null,
        provider: body.provider ?? null,
        labels: body.labels,
        notes: body.notes ?? null,
        connection: "never_enrolled",
        health: "unknown",
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "server.created",
      targetType: "server",
      targetId: row!.id,
      targetLabel: row!.name,
      serverId: row!.id,
      after: body,
    });
    req.ctx.events.publish("servers", "server.created", { server_id: row!.id }, row!.id);

    return item(reply, await toApi(req.ctx.db, row!), 201);
  });

  /* ----------------------------- update ----------------------------- */

  app.patch("/servers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateServerInput);
    const before = await loadServer(req, id, "infra.servers:write");
    const h = helpers(req);

    const [row] = await req.ctx.db
      .update(servers)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.provider !== undefined ? { provider: body.provider } : {}),
        ...(body.labels !== undefined ? { labels: body.labels } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(servers.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "server.updated",
      targetType: "server",
      targetId: id,
      targetLabel: row!.name,
      serverId: id,
      before: {
        name: before.name,
        hostname: before.hostname,
        labels: before.labels,
        notes: before.notes,
      },
      after: body,
    });

    return item(reply, await toApi(req.ctx.db, row!));
  });

  /* ----------------------------- delete ----------------------------- */

  app.delete("/servers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:delete");
    const h = helpers(req);

    req.ctx.hub.disconnect(id, "server removed from Kaname");
    await req.ctx.db.delete(servers).where(eq(servers.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "server.deleted",
      targetType: "server",
      targetId: id,
      targetLabel: server.name,
      before: { name: server.name, hostname: server.hostname },
    });
    req.ctx.events.publish("servers", "server.deleted", { server_id: id }, id);

    return reply.status(204).send();
  });

  /* -------------------------- enrollment ---------------------------- */

  app.post("/servers/:id/enroll-token", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:write");
    const h = helpers(req);
    const principal = h.requirePrincipal();

    const issued = await issueEnrollmentToken(
      req.ctx,
      id,
      principal.kind === "user" ? principal.id : null,
    );

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "server.enrollment_token_issued",
      targetType: "server",
      targetId: id,
      targetLabel: server.name,
      serverId: id,
    });

    return item(reply, {
      server_id: id,
      token: issued.token,
      expires_at: issued.expiresAt.toISOString(),
      control_plane_url: issued.controlPlaneUrl,
      command: issued.command,
      fingerprint: server.certFingerprint ?? "",
    });
  });

  app.post("/servers/:id/revoke", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:write");
    const h = helpers(req);

    req.ctx.hub.disconnect(id, "certificate revoked");
    await req.ctx.db
      .update(servers)
      .set({ revokedAt: new Date(), connection: "revoked", updatedAt: new Date() })
      .where(eq(servers.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "server.revoked",
      targetType: "server",
      targetId: id,
      targetLabel: server.name,
      serverId: id,
    });

    return item(
      reply,
      await toApi(req.ctx.db, { ...server, revokedAt: new Date(), connection: "revoked" }),
    );
  });

  /* ---------------------------- actions ----------------------------- */

  app.post("/servers/:id/reboot", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({ delay_seconds: z.number().int().min(0).max(3600).default(0) }),
    );
    const server = await loadServer(req, id, "infra.servers:write");

    const job = await enqueueServerJob(req, {
      type: "system.reboot",
      server,
      targetType: "server",
      targetId: id,
      targetLabel: server.name,
      params: body,
    });
    return accepted(reply, job);
  });

  app.post("/servers/:id/sync", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:read");
    const job = await enqueueServerJob(req, {
      type: "system.sync",
      server,
      targetType: "server",
      targetId: id,
      targetLabel: server.name,
    });
    return accepted(reply, job);
  });

  /* ---------------------------- metrics ----------------------------- */

  app.get("/servers/:id/metrics", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, seriesQuery.partial({ metric: true }));
    await loadServer(req, id, "monitoring.metrics:read");

    const since = new Date(Date.now() - rangeMs(q.range ?? "24h"));
    const rows = await req.ctx.db
      .select()
      .from(serverMetrics)
      .where(and(eq(serverMetrics.serverId, id), gte(serverMetrics.ts, since)))
      .orderBy(asc(serverMetrics.ts))
      .limit(2000);

    return item(reply, {
      server_id: id,
      range: q.range ?? "24h",
      samples: rows.map((r) => ({
        ts: r.ts.toISOString(),
        cpu_percent: r.cpuPercent,
        memory_used: r.memoryUsed,
        memory_total: r.memoryTotal,
        swap_used: r.swapUsed,
        load1: r.load1,
        load5: r.load5,
        load15: r.load15,
        processes: r.processes,
        net_rx_rate: r.netRxRate,
        net_tx_rate: r.netTxRate,
        disks: r.disks,
      })),
    });
  });
}

/* ------------------------------------------------------------------ */

export function rangeMs(range: string): number {
  const table: Record<string, number> = {
    "1h": 3_600_000,
    "6h": 6 * 3_600_000,
    "24h": 24 * 3_600_000,
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
    "90d": 90 * 86_400_000,
  };
  return table[range] ?? table["24h"]!;
}

/** Row to API shape, including the denormalised latest sample. */
export async function toApi(
  db: Database,
  row: typeof servers.$inferSelect,
  opts: { counts?: boolean } = {},
): Promise<Server> {
  const latestRows = await db
    .select()
    .from(serverMetrics)
    .where(eq(serverMetrics.serverId, row.id))
    .orderBy(desc(serverMetrics.ts))
    .limit(1);
  const latest = latestRows[0];

  let counts: Server["counts"];
  if (opts.counts) {
    const rows = await db
      .select({
        sites: sql<number>`(select count(*) from sites where server_id = ${row.id})::int`,
        containers: sql<number>`(select count(*) from containers where server_id = ${row.id})::int`,
        services_failed: sql<number>`(select count(*) from services where server_id = ${row.id} and active_state = 'failed')::int`,
        mailboxes: sql<number>`(select count(*) from mailboxes where server_id = ${row.id})::int`,
        databases: sql<number>`(select count(*) from db_databases where server_id = ${row.id})::int`,
        open_alerts: sql<number>`(select count(*) from alerts where server_id = ${row.id} and resolved_at is null)::int`,
      })
      .from(sql`(select 1) as one`);
    counts = rows[0] as Server["counts"];
  }

  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    address: row.address,
    provider: row.provider,
    os: row.os,
    os_family: (row.osFamily as Server["os_family"]) ?? null,
    os_version: row.osVersion,
    arch: (row.arch as Server["arch"]) ?? null,
    kernel: row.kernel,
    cpu_model: row.cpuModel,
    cpu_cores: row.cpuCores,
    memory_total: row.memoryTotal,
    timezone: row.timezone,
    agent_version: row.agentVersion,
    capabilities: row.capabilities,
    connection: row.connection,
    health: row.health,
    health_reasons: row.healthReasons,
    simulated: row.simulated,
    last_seen_at: row.lastSeenAt?.toISOString() ?? null,
    enrolled_at: row.enrolledAt?.toISOString() ?? null,
    cert_expires_at: row.certExpiresAt?.toISOString() ?? null,
    boot_time: row.bootTime?.toISOString() ?? null,
    uptime_seconds: row.bootTime ? Math.floor((Date.now() - row.bootTime.getTime()) / 1000) : null,
    labels: row.labels,
    notes: row.notes,
    latest: latest
      ? {
          cpu_percent: latest.cpuPercent,
          memory_used: latest.memoryUsed,
          memory_total: latest.memoryTotal,
          swap_used: latest.swapUsed,
          load1: latest.load1,
          disks: latest.disks,
          net_rx_rate: latest.netRxRate,
          net_tx_rate: latest.netTxRate,
          sampled_at: latest.ts.toISOString(),
        }
      : null,
    counts,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Enrollment
 *
 * Shared with onboarding, which needs exactly the same thing under a
 * different name: a token that is single-use, expires in minutes rather
 * than hours, and is scoped to one server row. A long-lived pairing
 * token that leaked would join a stranger's agent to the fleet, so there
 * is only one implementation of it.
 * ------------------------------------------------------------------ */

export interface IssuedEnrollment {
  token: string;
  expiresAt: Date;
  controlPlaneUrl: string;
  command: string;
}

export async function issueEnrollmentToken(
  ctx: AppContext,
  serverId: string,
  createdBy: string | null,
): Promise<IssuedEnrollment> {
  // A previous unused token is superseded, so only one is ever live.
  await ctx.db
    .update(enrollmentTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(enrollmentTokens.serverId, serverId), sql`${enrollmentTokens.usedAt} is null`));

  const token = generateToken("kn_enroll");
  const expiresAt = new Date(Date.now() + ctx.config.ENROLLMENT_TOKEN_TTL_MINUTES * 60_000);

  await ctx.db.insert(enrollmentTokens).values({
    serverId,
    tokenHash: hashToken(token),
    expiresAt,
    createdBy,
  });

  const url = ctx.config.agentUrl;
  return {
    token,
    expiresAt,
    controlPlaneUrl: url,
    command: `curl -fsSL ${url}/install.sh | sudo sh -s -- --agent-only --token=${token} --control-plane=${url}`,
  };
}
