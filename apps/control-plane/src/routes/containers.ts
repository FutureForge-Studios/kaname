import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, lt, sql } from "@kaname/db";
import { containers, servers } from "@kaname/db/schema";
import {
  containerListQuery,
  idParam,
  isoDate,
  listQuery,
  serverIdQuery,
  uuid,
  type Container,
  type ContainerInfo,
  type MethodParams,
  type Permission,
} from "@kaname/contract";
import { imageInfo, logRecord, type LogRecord } from "@kaname/contract/agent";
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
  agentOffline,
  agentUnsupported,
  conflict,
  fromAgentError,
  notFound,
} from "../lib/errors.js";
import {
  combine,
  drained,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  type ServerRow,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Containers.
 *
 * The list reads the cache so that thirty hosts cost one query and one
 * unreachable host costs one stale row rather than the page (KD-012);
 * the detail view merges a live inspect over it, because that is one
 * host and the operator asked for it. Everything that changes a
 * container is a job (KD-008).
 * ------------------------------------------------------------------ */

const SORTABLE = {
  name: containers.name,
  image: containers.image,
  state: containers.state,
  created_at: containers.createdAtHost,
  last_synced_at: containers.lastSyncedAt,
  server: servers.name,
} as const;

type ImageRow = z.infer<typeof imageInfo>;

/** Comparators are whitelisted for the same reason columns are: `sort` is user input. */
const IMAGE_SORTABLE = {
  size: (a: ImageRow, b: ImageRow) => a.size - b.size,
  created_at: (a: ImageRow, b: ImageRow) => a.created_at.localeCompare(b.created_at),
  tags: (a: ImageRow, b: ImageRow) => (a.tags[0] ?? "").localeCompare(b.tags[0] ?? ""),
} as const;

/** A slow host must not hold an HTTP request open. */
const READ_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 20_000;
/** A tail is bounded so a forgotten tab cannot pin a stream open forever; SSE reconnects. */
const FOLLOW_TIMEOUT_MS = 6 * 60 * 60_000;
const KEEPALIVE_MS = 20_000;

const LIFECYCLE_ACTIONS = ["start", "stop", "restart"] as const;

/** The grace period before a stop becomes a kill. `start` has nothing to wait for. */
const lifecycleInput = z
  .object({ timeout_seconds: z.number().int().min(0).max(600).default(10) })
  .default({});

const removeQuery = z.object({
  force: z.coerce.boolean().default(false),
  remove_volumes: z.coerce.boolean().default(false),
});

const pruneInput = z.object({
  server_id: uuid,
  include_images: z.boolean().default(false),
  include_volumes: z.boolean().default(false),
});

const logsQuery = z.object({
  lines: z.coerce.number().int().min(1).max(10000).default(200),
  follow: z.coerce.boolean().default(false),
  since: isoDate.optional(),
});

export async function containerRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/containers", async (req, reply) => {
    const q = parseQuery(req, containerListQuery);
    helpers(req).authorize("infra.containers:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "infra.containers:read", containers.serverId),
      q.server_id ? eq(containers.serverId, q.server_id) : null,
      q.state ? eq(containers.state, q.state) : null,
      q.image ? sql`lower(${containers.image}) like ${`%${q.image.toLowerCase()}%`}` : null,
      term
        ? sql`(lower(${containers.name}) like ${term} or lower(${containers.image}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "name");
    const rows = await req.ctx.db
      .select({ container: containers, serverName: servers.name })
      .from(containers)
      .innerJoin(servers, eq(containers.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [counted] = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(containers)
      .where(where);

    return list(
      reply,
      rows.map((r) => toApi(r.container, r.serverName)),
      paginate(counted?.total ?? 0, q.page, q.per_page),
    );
  });

  /* ----------------------------- images ----------------------------- */

  // Registered before /containers/:id so the intent is obvious, though the
  // router would prefer the static segment either way.
  app.get("/containers/images", async (req, reply) => {
    const q = parseQuery(req, listQuery.merge(serverIdQuery));
    const serverId = requireServerId(q.server_id);
    const server = await loadConnectedServer(req, serverId, "infra.containers:read");
    requireRuntime(req, server);

    const result = await agentRead(server, () =>
      req.ctx.hub.call(server.id, "container.images.list", {}, { timeoutMs: READ_TIMEOUT_MS }),
    );
    const images: ImageRow[] = result.images;

    const term = q.q?.trim().toLowerCase();
    const compare = sortColumn(IMAGE_SORTABLE, q.sort, "size");
    const matched = images
      .filter(
        (image) =>
          !term ||
          image.id.toLowerCase().includes(term) ||
          image.tags.some((tag) => tag.toLowerCase().includes(term)),
      )
      .sort((a, b) => (q.order === "asc" ? compare(a, b) : -compare(a, b)));

    const start = offset(q.page, q.per_page);
    return list(
      reply,
      matched.slice(start, start + q.per_page).map((image) => ({ server_id: server.id, ...image })),
      paginate(matched.length, q.page, q.per_page),
    );
  });

  /* ------------------------------ prune ----------------------------- */

  app.post("/containers/prune", async (req, reply) => {
    const body = parseBody(req, pruneInput);
    const server = await loadServer(req, body.server_id, "infra.containers:delete");

    const job = await enqueueServerJob(req, {
      type: "container.prune",
      server,
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      params: { include_images: body.include_images, include_volumes: body.include_volumes },
    });
    return accepted(reply, job);
  });

  /* ------------------------------ sync ------------------------------ */

  app.post("/containers/sync", async (req, reply) => {
    const serverId = requireServerId(parseQuery(req, serverIdQuery).server_id);
    const server = await loadConnectedServer(req, serverId, "infra.containers:read");
    requireRuntime(req, server);
    const h = helpers(req);

    const result = await agentRead(server, () =>
      req.ctx.hub.call(
        server.id,
        "container.list",
        { all: true, with_stats: true },
        { timeoutMs: SYNC_TIMEOUT_MS },
      ),
    );
    const live: ContainerInfo[] = result.containers;

    const now = new Date();
    for (const c of live) {
      const values = {
        name: c.name,
        image: c.image,
        imageId: c.image_id,
        state: c.state,
        status: c.status,
        runtime: c.runtime,
        ports: c.ports,
        labels: c.labels,
        networks: c.networks,
        mounts: c.mounts,
        restartCount: c.restart_count,
        cpuPercent: c.cpu_percent,
        memoryUsage: c.memory_usage,
        memoryLimit: c.memory_limit,
        createdAtHost: new Date(c.created_at),
        startedAt: c.started_at ? new Date(c.started_at) : null,
        lastSyncedAt: now,
      };
      await req.ctx.db
        .insert(containers)
        .values({ serverId: server.id, containerId: c.id, ...values })
        .onConflictDoUpdate({
          target: [containers.serverId, containers.containerId],
          set: { ...values, updatedAt: now },
        });
    }
    // Containers that vanished from the host vanish from the panel.
    await req.ctx.db
      .delete(containers)
      .where(and(eq(containers.serverId, server.id), lt(containers.lastSyncedAt, now)));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "container.synced",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
      metadata: { containers: live.length },
    });
    req.ctx.events.publish(
      "containers",
      "container.synced",
      { server_id: server.id, containers: live.length },
      server.id,
    );

    return item(reply, {
      server_id: server.id,
      containers: live.length,
      synced_at: now.toISOString(),
    });
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/containers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { container, server } = await loadContainer(req, id, "infra.containers:read");

    const runtimes = req.ctx.hub.capabilities(server.id);
    const reachable =
      req.ctx.hub.isConnected(server.id) &&
      (runtimes.includes("docker") || runtimes.includes("podman"));
    if (!reachable) {
      // An unreachable host still renders: `last_synced_at` is how the age
      // is shown rather than hidden (KD-012).
      return item(reply, { ...toApi(container, server.name), inspect: null });
    }

    const result = await agentRead(server, () =>
      req.ctx.hub.call(
        server.id,
        "container.inspect",
        { id: container.containerId },
        { timeoutMs: READ_TIMEOUT_MS },
      ),
    );
    const info: ContainerInfo = result.container;
    const raw: unknown = result.raw;

    const now = new Date();
    const patch = {
      name: info.name,
      image: info.image,
      imageId: info.image_id,
      state: info.state,
      status: info.status,
      ports: info.ports,
      labels: info.labels,
      networks: info.networks,
      mounts: info.mounts,
      restartCount: info.restart_count,
      cpuPercent: info.cpu_percent,
      memoryUsage: info.memory_usage,
      memoryLimit: info.memory_limit,
      startedAt: info.started_at ? new Date(info.started_at) : null,
      lastSyncedAt: now,
    };
    // What the operator just learned is worth keeping: the list page reads
    // this row too, and `last_synced_at` should not lie about its age.
    await req.ctx.db
      .update(containers)
      .set({ ...patch, updatedAt: now })
      .where(eq(containers.id, container.id));

    if (info.state !== container.state) {
      req.ctx.events.publish(
        "containers",
        "container.changed",
        { server_id: server.id, container_id: container.containerId, state: info.state },
        server.id,
      );
    }

    return item(reply, { ...toApi({ ...container, ...patch }, server.name), inspect: raw });
  });

  /* ----------------------------- actions ---------------------------- */

  for (const action of LIFECYCLE_ACTIONS) {
    app.post(`/containers/:id/${action}`, async (req, reply) => {
      const { id } = parseParams(req, idParam);
      const body = parseBody(req, lifecycleInput);
      const { container, server } = await loadContainer(req, id, "infra.containers:exec");

      const job = await enqueueServerJob(req, {
        type: `container.${action}`,
        server,
        targetType: "container",
        targetId: container.id,
        targetLabel: container.name,
        params:
          action === "start"
            ? { id: container.containerId }
            : { id: container.containerId, timeout_seconds: body.timeout_seconds },
      });
      return accepted(reply, job);
    });
  }

  app.delete("/containers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, removeQuery);
    const { container, server } = await loadContainer(req, id, "infra.containers:delete");

    if (container.state === "running" && !q.force) {
      throw conflict(`${container.name} is still running on ${server.name}.`, {
        summary: "Stop the container first, or repeat this with force=true to kill it.",
        actions: [
          { label: "Stop container", action: "containers.stop" },
          { label: "Force remove", action: "containers.force_remove" },
        ],
      });
    }

    const job = await enqueueServerJob(req, {
      type: "container.remove",
      server,
      targetType: "container",
      targetId: container.id,
      targetLabel: container.name,
      params: { id: container.containerId, force: q.force, remove_volumes: q.remove_volumes },
    });
    return accepted(reply, job);
  });

  /* ------------------------------ logs ------------------------------ */

  app.get("/containers/:id/logs", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, logsQuery);
    const { container, server } = await loadContainer(req, id, "infra.containers:read", {
      connected: true,
    });
    requireRuntime(req, server);

    const params: MethodParams<"container.logs"> = {
      id: container.containerId,
      lines: q.lines,
      follow: q.follow,
      since: q.since,
    };

    if (q.follow) return followLogs(req, reply, server, container.name, params);

    const collected: LogRecord[] = [];
    const handle = req.ctx.hub.stream(
      server.id,
      "container.logs",
      params,
      (data) => {
        collected.push(...toRecords(data, container.name));
      },
      { timeoutMs: READ_TIMEOUT_MS },
    );
    const result = await agentRead(server, () => handle.done);
    const batch: LogRecord[] = result?.records ?? [];

    // Output may arrive as chunks and end empty, or as one final batch.
    return item(reply, {
      server_id: server.id,
      container_id: container.containerId,
      records: collected.length > 0 ? collected : batch,
    });
  });
}

/* ------------------------------------------------------------------ */

/**
 * Loads a container and asserts the caller holds `permission` on its
 * host. The scope lives on the server, which is not knowable before the
 * read, so the unscoped check gates the read and the scoped one the row.
 */
async function loadContainer(
  req: FastifyRequest,
  id: string,
  permission: Permission,
  opts: { connected?: boolean } = {},
): Promise<{ container: typeof containers.$inferSelect; server: ServerRow }> {
  helpers(req).authorize(permission);

  const rows = await req.ctx.db.select().from(containers).where(eq(containers.id, id)).limit(1);
  const container = rows[0];
  if (!container) throw notFound("Container", id);

  const server = opts.connected
    ? await loadConnectedServer(req, container.serverId, permission)
    : await loadServer(req, container.serverId, permission);
  return { container, server };
}

function requireRuntime(req: FastifyRequest, server: ServerRow): void {
  const caps = req.ctx.hub.capabilities(server.id);
  if (!caps.includes("docker") && !caps.includes("podman")) {
    throw agentUnsupported(server.name, "a container runtime");
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

/** Follows container output over SSE, framed exactly like GET /events. */
function followLogs(
  req: FastifyRequest,
  reply: FastifyReply,
  server: ServerRow,
  source: string,
  params: MethodParams<"container.logs">,
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
  /** Returns false when the client is behind and the caller should wait. */
  const write = (event: string, data: unknown): boolean => {
    if (!live || reply.raw.destroyed) return true;
    return reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const handle = req.ctx.hub.stream(
    server.id,
    "container.logs",
    params,
    async (data) => {
      for (const record of toRecords(data, source)) {
        // A browser that is behind holds the next record, and the agent with it.
        if (!write("log", record)) await drained(reply.raw);
      }
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

/** Container output is framed as NDJSON; anything else is still a line the operator needs. */
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

function toApi(row: typeof containers.$inferSelect, serverName: string): Container {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: serverName,
    container_id: row.containerId,
    name: row.name,
    image: row.image,
    image_id: row.imageId,
    state: row.state,
    status: row.status,
    runtime: row.runtime,
    ports: row.ports as Container["ports"],
    labels: row.labels,
    networks: row.networks,
    restart_count: row.restartCount,
    cpu_percent: row.cpuPercent,
    memory_usage: row.memoryUsage,
    memory_limit: row.memoryLimit,
    // A container Kaname has never synced still has a row age to show.
    created_at_host: (row.createdAtHost ?? row.createdAt).toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    last_synced_at: row.lastSyncedAt.toISOString(),
  };
}
