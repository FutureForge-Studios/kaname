import type { ServerResponse } from "node:http";
import type { FastifyRequest } from "fastify";
import { and, eq, inArray, sql, type SQL } from "@kaname/db";
import type { PgColumn } from "drizzle-orm/pg-core";
import { servers } from "@kaname/db/schema";
import { JOB_SPECS, type Job, type JobType, type Permission } from "@kaname/contract";
import { agentOffline, notFound } from "../lib/errors.js";
import { helpers } from "../http/plugin.js";

/* ------------------------------------------------------------------ *
 * Helpers every route module uses.
 *
 * The point of centralising these is that "authorise, then act on a
 * server" is one code path. A module that loads a server any other way
 * would skip the scope check, so there is no other way to load one.
 * ------------------------------------------------------------------ */

export type ServerRow = typeof servers.$inferSelect;

/** Loads a server and asserts the caller holds `permission` on it. */
export async function loadServer(
  req: FastifyRequest,
  serverId: string,
  permission: Permission,
): Promise<ServerRow> {
  const h = helpers(req);
  h.authorize(permission, serverId);

  const rows = await req.ctx.db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const server = rows[0];
  if (!server) throw notFound("Server", serverId);
  return server;
}

/** Loads a server and additionally requires a live agent connection. */
export async function loadConnectedServer(
  req: FastifyRequest,
  serverId: string,
  permission: Permission,
): Promise<ServerRow> {
  const server = await loadServer(req, serverId, permission);
  if (!req.ctx.hub.isConnected(serverId)) {
    throw agentOffline(server.name, server.lastSeenAt);
  }
  return server;
}

/**
 * SQL fragment restricting a list query to the servers this principal
 * may see. Returns null when the caller has global scope.
 */
export function scopeFilter(
  req: FastifyRequest,
  permission: Permission,
  column: PgColumn,
): SQL | null {
  const principal = helpers(req).requirePrincipal();
  const scope = req.ctx.auth.scope(principal, permission);
  if (scope === "global") return null;
  if (!scope || scope.length === 0) return sql`false`;
  return inArray(column, scope as string[]);
}

/** Server ids visible to this principal, or "global". */
export function visibleServerIds(
  req: FastifyRequest,
  permission: Permission,
): "global" | readonly string[] {
  const principal = helpers(req).requirePrincipal();
  const scope = req.ctx.auth.scope(principal, permission);
  if (scope === "global") return "global";
  return scope ?? [];
}

/**
 * Enqueues a job against a server. This is the ONLY way a route causes
 * something to happen on a host (KD-008): no route performs an agent
 * RPC that has a side effect.
 */
export async function enqueueServerJob(
  req: FastifyRequest,
  opts: {
    type: JobType;
    server: ServerRow;
    targetType?: string;
    targetId?: string;
    targetLabel?: string;
    params?: Record<string, unknown>;
    correlationId?: string;
  },
): Promise<Job> {
  const h = helpers(req);
  const spec = JOB_SPECS[opts.type];
  const principal = h.authorize(spec.permission, opts.server.id);

  const job = await req.ctx.queue.enqueue({
    type: opts.type,
    serverId: opts.server.id,
    targetType: opts.targetType,
    targetId: opts.targetId,
    targetLabel: opts.targetLabel,
    params: opts.params ?? {},
    correlationId: opts.correlationId,
    createdBy: principal.kind === "user" ? principal.id : null,
    createdByName: principal.name,
  });

  await req.ctx.audit.record({
    actor: h.actor(),
    action: `${opts.type}.requested`,
    targetType: opts.targetType ?? "server",
    targetId: opts.targetId ?? opts.server.id,
    targetLabel: opts.targetLabel ?? opts.server.name,
    serverId: opts.server.id,
    jobId: job.id,
    metadata: { params: opts.params ?? {} },
  });

  req.ctx.events.publish("jobs", "job.queued", job, opts.server.id);
  return { ...job, server_name: opts.server.name };
}

/** Fan one action across many servers under a shared correlation id. */
export async function enqueueFanOut(
  req: FastifyRequest,
  type: JobType,
  targets: {
    server: ServerRow;
    params?: Record<string, unknown>;
    targetId?: string;
    targetLabel?: string;
  }[],
): Promise<{ correlation_id: string; jobs: Job[] }> {
  const correlationId = crypto.randomUUID();
  const jobs: Job[] = [];
  for (const t of targets) {
    jobs.push(
      await enqueueServerJob(req, {
        type,
        server: t.server,
        params: t.params,
        targetId: t.targetId,
        targetLabel: t.targetLabel,
        correlationId,
      }),
    );
  }
  return { correlation_id: correlationId, jobs };
}

/** Builds an ORDER BY expression from a whitelist, so `sort` cannot inject. */
export function sortColumn<T extends Record<string, unknown>>(
  columns: T,
  requested: string | undefined,
  fallback: keyof T,
): T[keyof T] {
  if (requested && requested in columns) return columns[requested as keyof T];
  return columns[fallback];
}

/** Case-insensitive contains, used by every list route's `q`. */
export function searchTerm(q: string | undefined): string | null {
  const trimmed = q?.trim();
  return trimmed ? `%${trimmed.toLowerCase()}%` : null;
}

export function combine(...clauses: (SQL | null | undefined)[]): SQL | undefined {
  const present = clauses.filter((c): c is SQL => Boolean(c));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return and(...present);
}

/**
 * Resolves once a response that reported a full write buffer can take
 * more, or immediately when it never filled up or is already gone. The
 * streaming routes await this before acknowledging the agent's next
 * chunk, which is what keeps a slow browser from making the control
 * plane buffer a whole download.
 */
export function drained(res: ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded || !res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
    res.on("error", done);
  });
}
