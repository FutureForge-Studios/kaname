import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, lt, sql } from "@kaname/db";
import { servers, services } from "@kaname/db/schema";
import {
  idParam,
  isoDate,
  serverIdQuery,
  serviceAction,
  serviceListQuery,
  uuid,
  type MethodParams,
  type Permission,
  type Service,
  type ServiceInfo,
} from "@kaname/contract";
import { logRecord, type LogRecord } from "@kaname/contract/agent";
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
  requireServerId,
} from "../http/plugin.js";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import {
  ApiException,
  agentOffline,
  agentUnsupported,
  fromAgentError,
  notFound,
} from "../lib/errors.js";
import {
  combine,
  enqueueFanOut,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  type ServerRow,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Services — systemd units.
 *
 * The list is served from the `services` cache with `last_synced_at` on
 * every row: fanning live RPCs across the fleet is fine with three hosts
 * and unusable with thirty, and one dead box would take the whole page
 * with it (KD-012). Every unit state change is a job (KD-008); only the
 * journal passes through live, because a read has no side effect to lose.
 * ------------------------------------------------------------------ */

const SORTABLE = {
  unit: services.unit,
  description: services.description,
  active_state: services.activeState,
  enabled: services.enabled,
  last_synced_at: services.lastSyncedAt,
  server: servers.name,
} as const;

/** A slow host must not hold an HTTP request open. */
const READ_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 20_000;
/** A tail is bounded so a forgotten tab cannot pin a stream open forever; SSE reconnects. */
const FOLLOW_TIMEOUT_MS = 6 * 60 * 60_000;
const KEEPALIVE_MS = 20_000;

const logsQuery = z.object({
  lines: z.coerce.number().int().min(1).max(10000).default(200),
  follow: z.coerce.boolean().default(false),
  since: isoDate.optional(),
});

const bulkInput = z.object({
  action: serviceAction,
  ids: z.array(uuid).min(1).max(500),
});

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/services", async (req, reply) => {
    const q = parseQuery(req, serviceListQuery);
    helpers(req).authorize("infra.services:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "infra.services:read", services.serverId),
      q.server_id ? eq(services.serverId, q.server_id) : null,
      q.active_state ? eq(services.activeState, q.active_state) : null,
      q.enabled !== undefined ? eq(services.enabled, q.enabled) : null,
      term
        ? sql`(lower(${services.unit}) like ${term} or lower(${services.description}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "unit");
    const rows = await req.ctx.db
      .select({ service: services, serverName: servers.name })
      .from(services)
      .innerJoin(servers, eq(services.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [counted] = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(services)
      .where(where);

    return list(
      reply,
      rows.map((r) => toApi(r.service, r.serverName)),
      paginate(counted?.total ?? 0, q.page, q.per_page),
    );
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/services/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { service, server } = await loadService(req, id, "infra.services:read");
    return item(reply, toApi(service, server.name));
  });

  /* ----------------------------- actions ---------------------------- */

  for (const action of serviceAction.options) {
    app.post(`/services/:id/${action}`, async (req, reply) => {
      const { id } = parseParams(req, idParam);
      const { service, server } = await loadService(req, id, "infra.services:exec");

      const job = await enqueueServerJob(req, {
        type: `service.${action}`,
        server,
        targetType: "service",
        targetId: service.id,
        targetLabel: service.unit,
        params: { unit: service.unit },
      });
      return accepted(reply, job);
    });
  }

  /* ------------------------------ bulk ------------------------------ */

  app.post("/services/bulk", async (req, reply) => {
    const body = parseBody(req, bulkInput);
    helpers(req).authorize("infra.services:exec");

    const rows = await req.ctx.db.select().from(services).where(inArray(services.id, body.ids));
    const missing = body.ids.filter((id) => !rows.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new ApiException(
        "not_found",
        `${missing.length} of the ${body.ids.length} selected units no longer exist.`,
        {
          detail: { missing },
          remediation: {
            summary: "The cached unit list is out of date. Re-sync the server, then reselect.",
            actions: [{ label: "Sync services", action: "services.sync" }],
          },
        },
      );
    }

    // One load per server rather than per unit: the scope check is the
    // same answer for every unit on the same host.
    const seen = new Map<string, ServerRow>();
    const targets: Parameters<typeof enqueueFanOut>[2] = [];
    for (const row of rows) {
      let server = seen.get(row.serverId);
      if (!server) {
        server = await loadServer(req, row.serverId, "infra.services:exec");
        seen.set(row.serverId, server);
      }
      targets.push({ server, params: { unit: row.unit }, targetId: row.id, targetLabel: row.unit });
    }

    const fanOut = await enqueueFanOut(req, `service.${body.action}`, targets);
    return item(reply, fanOut, 202);
  });

  /* ------------------------------ sync ------------------------------ */

  app.post("/services/sync", async (req, reply) => {
    const serverId = requireServerId(parseQuery(req, serverIdQuery).server_id);
    const server = await loadConnectedServer(req, serverId, "infra.services:read");
    requireSystemd(req, server);
    const h = helpers(req);

    const result = await agentRead(server, () =>
      req.ctx.hub.call(server.id, "service.list", {}, { timeoutMs: SYNC_TIMEOUT_MS }),
    );
    const units: ServiceInfo[] = result.services;

    const now = new Date();
    for (const unit of units) {
      const values = {
        description: unit.description,
        loadState: unit.load_state,
        activeState: unit.active_state,
        subState: unit.sub_state,
        enabled: unit.enabled,
        mainPid: unit.main_pid,
        memoryCurrent: unit.memory_current,
        activeSince: unit.active_since ? new Date(unit.active_since) : null,
        restartCount: unit.restart_count,
        lastSyncedAt: now,
      };
      await req.ctx.db
        .insert(services)
        .values({ serverId: server.id, unit: unit.unit, ...values })
        .onConflictDoUpdate({
          target: [services.serverId, services.unit],
          set: { ...values, updatedAt: now },
        });
    }
    // Units that vanished from the host vanish from the panel.
    await req.ctx.db
      .delete(services)
      .where(and(eq(services.serverId, server.id), lt(services.lastSyncedAt, now)));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "service.synced",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
      metadata: { units: units.length },
    });
    req.ctx.events.publish(
      "services",
      "service.synced",
      { server_id: server.id, units: units.length },
      server.id,
    );

    return item(reply, {
      server_id: server.id,
      units: units.length,
      synced_at: now.toISOString(),
    });
  });

  /* ------------------------------ logs ------------------------------ */

  app.get("/services/:id/logs", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, logsQuery);
    const { service, server } = await loadService(req, id, "infra.services:read", {
      connected: true,
    });
    requireSystemd(req, server);

    const params: MethodParams<"service.logs"> = {
      unit: service.unit,
      lines: q.lines,
      follow: q.follow,
      since: q.since,
    };

    if (q.follow) return followLogs(req, reply, server, service.unit, params);

    const collected: LogRecord[] = [];
    const handle = req.ctx.hub.stream(
      server.id,
      "service.logs",
      params,
      (data) => collected.push(...toRecords(data, service.unit)),
      { timeoutMs: READ_TIMEOUT_MS },
    );
    const result = await agentRead(server, () => handle.done);
    const batch: LogRecord[] = result?.records ?? [];

    // A journal may arrive as chunks and end empty, or as one final batch.
    return item(reply, {
      server_id: server.id,
      unit: service.unit,
      records: collected.length > 0 ? collected : batch,
    });
  });
}

/* ------------------------------------------------------------------ */

/**
 * Loads a unit and asserts the caller holds `permission` on its host.
 * The scope lives on the server, which is not knowable before the read,
 * so the unscoped check gates the read and the scoped one gates the row.
 */
async function loadService(
  req: FastifyRequest,
  id: string,
  permission: Permission,
  opts: { connected?: boolean } = {},
): Promise<{ service: typeof services.$inferSelect; server: ServerRow }> {
  helpers(req).authorize(permission);

  const rows = await req.ctx.db.select().from(services).where(eq(services.id, id)).limit(1);
  const service = rows[0];
  if (!service) throw notFound("Service", id);

  const server = opts.connected
    ? await loadConnectedServer(req, service.serverId, permission)
    : await loadServer(req, service.serverId, permission);
  return { service, server };
}

function requireSystemd(req: FastifyRequest, server: ServerRow): void {
  if (!req.ctx.hub.capabilities(server.id).includes("systemd")) {
    throw agentUnsupported(server.name, "systemd");
  }
}

/** Read-only pass-through: allowed inline because it has no side effect to lose (KD-008). */
async function agentRead<T>(server: ServerRow, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AgentRpcError) throw fromAgentError(server.name, err.agentError);
    if (err instanceof AgentOfflineError) throw agentOffline(server.name, server.lastSeenAt);
    throw err;
  }
}

/** Follows a journal over SSE, framed exactly like GET /events. */
function followLogs(
  req: FastifyRequest,
  reply: FastifyReply,
  server: ServerRow,
  source: string,
  params: MethodParams<"service.logs">,
): FastifyReply {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx buffers SSE by default and makes the tail look frozen.
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(`retry: 3000\n\n`);

  let live = true;
  const write = (event: string, data: unknown) => {
    if (!live) return;
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const handle = req.ctx.hub.stream(
    server.id,
    "service.logs",
    params,
    (data) => {
      for (const record of toRecords(data, source)) write("log", record);
    },
    { timeoutMs: FOLLOW_TIMEOUT_MS },
  );

  const keepalive = setInterval(() => {
    if (live) reply.raw.write(`: keepalive\n\n`);
  }, KEEPALIVE_MS);
  keepalive.unref?.();

  const stop = () => {
    if (!live) return;
    live = false;
    clearInterval(keepalive);
  };
  const abandon = () => {
    stop();
    handle.cancel();
  };
  req.raw.on("close", abandon);
  req.raw.on("error", abandon);

  void handle.done
    .then(() => {
      write("end", { server_id: server.id, source });
      stop();
      reply.raw.end();
    })
    .catch((err: unknown) => {
      write("error", streamError(server, err));
      stop();
      reply.raw.end();
    });

  // Never resolves: the reply belongs to the stream until the client leaves.
  return reply;
}

function streamError(server: ServerRow, err: unknown): unknown {
  if (err instanceof AgentRpcError)
    return fromAgentError(server.name, err.agentError).toJSON().error;
  if (err instanceof AgentOfflineError)
    return agentOffline(server.name, server.lastSeenAt).toJSON().error;
  return {
    code: "internal_error",
    message: `The log stream from ${server.name} ended unexpectedly.`,
  };
}

/** The agent frames the journal as NDJSON; anything else is still a line the operator needs. */
function toRecords(data: string, source: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(logRecord.parse(JSON.parse(line)));
    } catch {
      out.push({ ts: new Date().toISOString(), level: "info", source, message: line });
    }
  }
  return out;
}

function toApi(row: typeof services.$inferSelect, serverName: string): Service {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: serverName,
    unit: row.unit,
    description: row.description,
    load_state: row.loadState,
    active_state: row.activeState,
    sub_state: row.subState,
    enabled: row.enabled,
    main_pid: row.mainPid,
    memory_current: row.memoryCurrent,
    active_since: row.activeSince?.toISOString() ?? null,
    restart_count: row.restartCount,
    last_synced_at: row.lastSyncedAt.toISOString(),
  };
}
