import type { FastifyInstance, FastifyRequest } from "fastify";
import { asc, inArray } from "@kaname/db";
import { servers } from "@kaname/db/schema";
import {
  listQuery,
  logLevel,
  logQuery,
  logSourceKind,
  serverIdQuery,
  type LogRecord,
  type LogRecordRow,
  type LogSource,
  type LogSourceKind,
  type LogSourceRow,
} from "@kaname/contract";
import type { z } from "zod";
import { helpers, list, offset, paginate, parseQuery } from "../http/plugin.js";
import { ApiException, fromAgentError } from "../lib/errors.js";
import { AgentRpcError } from "../agent/hub.js";
import {
  combine,
  loadConnectedServer,
  scopeFilter,
  sortColumn,
  type ServerRow,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Logs.
 *
 * Nothing here is cached: a stale log line is worse than a slow one, so
 * every route is a read-only pass-through to the agent (permitted by
 * KD-008 precisely because a read has no side effect to lose). Level,
 * substring and time filtering are pushed down to the host — the
 * control plane never pulls a gigabyte of journal in order to grep it,
 * and neither does the browser.
 * ------------------------------------------------------------------ */

const SOURCES_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 20_000;
/** Enough to cover a host's real streams without fanning out unbounded. */
const MAX_SEARCH_SOURCES = 8;
const MIN_LINES_PER_SOURCE = 50;
const KEEPALIVE_MS = 20_000;

const SORTABLE_SOURCES = {
  label: (r: LogSourceRow) => r.label.toLowerCase(),
  kind: (r: LogSourceRow) => r.kind,
  server: (r: LogSourceRow) => r.server_name.toLowerCase(),
  size: (r: LogSourceRow) => r.size ?? 0,
} as const;

const sourceListQuery = listQuery.merge(serverIdQuery);
const logSearchQuery = logQuery.partial({ server_id: true });

export async function logRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- sources ----------------------------- */

  app.get("/logs/sources", async (req, reply) => {
    const q = parseQuery(req, sourceListQuery);
    helpers(req).authorize("logs.streams:read");

    const hosts = await targets(req, q.server_id);
    const results = await Promise.allSettled(
      hosts.map(async (server): Promise<LogSourceRow[]> => {
        const sources = await hostSources(req, server);
        return sources.map((source) => ({
          ...source,
          kind: toSourceKind(source.kind),
          server_id: server.id,
          server_name: server.name,
        }));
      }),
    );

    assertSomethingAnswered(hosts, results, "enumerate log sources");

    const term = q.q?.trim().toLowerCase();
    let rows = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (term) {
      rows = rows.filter(
        (r) => r.label.toLowerCase().includes(term) || r.ref.toLowerCase().includes(term),
      );
    }

    const key = sortColumn(SORTABLE_SOURCES, q.sort, "label");
    rows.sort((a, b) => compare(key(a), key(b)) * (q.order === "asc" ? 1 : -1));

    const page = rows.slice(offset(q.page, q.per_page), offset(q.page, q.per_page) + q.per_page);
    return list(reply, page, paginate(rows.length, q.page, q.per_page));
  });

  /* ----------------------------- search ----------------------------- */

  app.get("/logs/search", async (req, reply) => {
    const q = parseQuery(req, logSearchQuery);
    helpers(req).authorize("logs.streams:read");

    const hosts = await targets(req, q.server_id);
    const results = await Promise.allSettled(hosts.map((server) => searchHost(req, server, q)));

    assertSomethingAnswered(hosts, results, "search logs");

    const rows = results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

    const page = rows.slice(0, q.limit);
    return list(reply, page, paginate(rows.length, 1, q.limit));
  });

  /* ------------------------------ tail ------------------------------ */

  app.get("/logs/tail", async (req, reply) => {
    const q = parseQuery(req, logQuery);
    const server = await loadConnectedServer(req, q.server_id, "logs.streams:read");

    const source = q.source;
    if (!source) {
      throw new ApiException("bad_request", "A log source is required to open a tail.", {
        fields: { source: "required" },
        remediation: {
          summary: `Pick one of the sources ${server.name} reports, then reopen the stream.`,
          actions: [
            { label: "List sources", href: `/logs?server_id=${server.id}` },
            { label: "Copy request", copy: `/api/v1/logs/sources?server_id=${server.id}` },
          ],
        },
      });
    }

    // A reconnecting viewer resumes from the last record it rendered
    // rather than replaying the whole buffer.
    const resumeFrom = (req.headers["last-event-id"] as string | undefined) ?? q.cursor ?? q.since;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers SSE by default and makes the feed look broken.
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`retry: 3000\n\n`);

    let seq = 0;
    const write = (event: string, data: unknown, id?: string) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(
        `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    };

    const handle = req.ctx.hub.stream(
      server.id,
      "log.tail",
      {
        source,
        lines: q.limit,
        follow: true,
        level: q.level,
        query: q.q,
        since: resumeFrom,
      },
      recordDecoder(source, (record) => {
        seq += 1;
        const row = toRow(server, source, record, seq);
        write("log", row, row.id);
      }),
      // No timeout: a follow is expected to stay open until the client leaves.
      { timeoutMs: 0x7fffffff },
    );

    const keepalive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(`: keepalive\n\n`);
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    let closed = false;
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      // Cancelling upstream is the point: without it the agent keeps
      // reading a journal for a browser tab that is already gone.
      handle.cancel(reason);
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    req.raw.on("close", () => close("client disconnected"));
    req.raw.on("error", () => close("client error"));

    void handle.done
      .then(() => {
        write("end", { server_id: server.id, source, reason: "source closed" });
        close("source closed");
      })
      .catch((err: unknown) => {
        if (closed) return;
        const mapped =
          err instanceof AgentRpcError ? fromAgentError(server.name, err.agentError) : null;
        write(
          "error",
          mapped
            ? mapped.toJSON().error
            : { code: "agent_error", message: "the log stream ended unexpectedly" },
        );
        close("stream failed");
      });

    // Never resolves: the reply is owned by the stream until the client leaves.
    return reply;
  });
}

/* ------------------------------------------------------------------ */

/**
 * The hosts a request applies to. Naming one server gives a precise
 * agent_offline error; omitting it merges every reachable host the
 * caller may read, because a fleet-wide search should not fail because
 * one box is down.
 */
async function targets(req: FastifyRequest, serverId: string | undefined): Promise<ServerRow[]> {
  if (serverId) return [await loadConnectedServer(req, serverId, "logs.streams:read")];

  helpers(req).authorize("logs.streams:read");
  const connected = req.ctx.hub.connectedServerIds();
  if (connected.length === 0) return [];

  return req.ctx.db
    .select()
    .from(servers)
    .where(
      combine(scopeFilter(req, "logs.streams:read", servers.id), inArray(servers.id, connected)),
    )
    .orderBy(asc(servers.name));
}

async function searchHost(
  req: FastifyRequest,
  server: ServerRow,
  q: z.infer<typeof logSearchQuery>,
): Promise<LogRecordRow[]> {
  const sources = q.source ? [q.source] : await defaultSources(req, server);
  if (sources.length === 0) return [];

  const lines = Math.max(MIN_LINES_PER_SOURCE, Math.floor(q.limit / sources.length));
  const rows: LogRecordRow[] = [];

  const perSource = await Promise.allSettled(
    sources.map(async (source) => {
      const collected: LogRecordRow[] = [];
      let seq = 0;
      const handle = req.ctx.hub.stream(
        server.id,
        "log.tail",
        {
          source,
          lines,
          follow: false,
          level: q.level,
          query: q.q,
          since: q.since,
        },
        recordDecoder(source, (record) => {
          seq += 1;
          collected.push(toRow(server, source, record, seq));
        }),
        { timeoutMs: SEARCH_TIMEOUT_MS },
      );
      await handle.done;
      return collected;
    }),
  );

  for (const result of perSource) {
    if (result.status === "fulfilled") rows.push(...result.value);
  }
  return rows;
}

async function hostSources(req: FastifyRequest, server: ServerRow): Promise<LogSource[]> {
  const result = (await req.ctx.hub.call(
    server.id,
    "log.sources",
    {},
    {
      timeoutMs: SOURCES_TIMEOUT_MS,
    },
  )) as { sources: LogSource[] };
  return result.sources;
}

/** Without an explicit source, search everything the host actually has. */
async function defaultSources(req: FastifyRequest, server: ServerRow): Promise<string[]> {
  const sources = await hostSources(req, server);
  return sources.slice(0, MAX_SEARCH_SOURCES).map((s) => s.id);
}

/**
 * Agents stream newline-delimited records, so a chunk boundary can land
 * mid-record; the tail of an incomplete line is held back until the rest
 * arrives.
 */
function recordDecoder(
  source: string,
  onRecord: (record: LogRecord) => void,
): (data: string, encoding: "utf8" | "base64") => void {
  let pending = "";

  return (data, encoding) => {
    pending += encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      onRecord(parseRecord(trimmed, source));
    }
  };
}

function parseRecord(line: string, source: string): LogRecord {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") {
      const level = logLevel.safeParse(parsed.level);
      return {
        ts: typeof parsed.ts === "string" ? parsed.ts : new Date().toISOString(),
        level: level.success ? level.data : "info",
        source: typeof parsed.source === "string" ? parsed.source : source,
        message: parsed.message,
        ...(isStringMap(parsed.fields) ? { fields: parsed.fields } : {}),
        ...(typeof parsed.cursor === "string" ? { cursor: parsed.cursor } : {}),
      };
    }
  } catch {
    /* A plain-text line is still a log line, and dropping it would hide it. */
  }
  return { ts: new Date().toISOString(), level: "info", source, message: line };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

function toSourceKind(raw: string): LogSourceKind {
  const parsed = logSourceKind.safeParse(raw);
  return parsed.success ? parsed.data : "file";
}

function toRow(server: ServerRow, source: string, record: LogRecord, seq: number): LogRecordRow {
  return {
    ...record,
    // Stable across re-queries so the virtualized viewer can key rows.
    id: `${server.id}:${source}:${record.cursor ?? `${record.ts}:${seq}`}`,
    server_id: server.id,
    server_name: server.name,
    ts: record.ts,
  };
}

/**
 * One unreachable host in a fleet-wide read is not an error. Every host
 * failing is, and the operator should be told which one and why.
 */
function assertSomethingAnswered(
  hosts: ServerRow[],
  results: PromiseSettledResult<unknown>[],
  what: string,
): void {
  if (hosts.length === 0 || results.some((r) => r.status === "fulfilled")) return;

  const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  const reason = first?.reason as unknown;
  if (reason instanceof AgentRpcError && hosts[0])
    throw fromAgentError(hosts[0].name, reason.agentError);

  throw new ApiException("agent_error", `No agent could ${what}.`, {
    detail: { servers: hosts.map((h) => h.name) },
    remediation: {
      summary:
        "Every host in scope refused or timed out. Check the agents are running and connected.",
      actions: [{ label: "Servers", href: "/infrastructure/servers" }],
    },
  });
}

function compare(a: string | number, b: string | number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
