import type { FastifyInstance } from "fastify";
import {
  processListQuery,
  signalProcessInput,
  uuid,
  type ProcessInfo,
  type ProcessRow,
} from "@kaname/contract";
import { z } from "zod";
import { accepted, list, paginate, parseBody, parseParams, parseQuery } from "../http/plugin.js";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { agentOffline, conflict, fromAgentError } from "../lib/errors.js";
import { enqueueServerJob, loadConnectedServer, loadServer, type ServerRow } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Processes.
 *
 * The one inventory that is never cached: a process table is stale the
 * moment it is written, so reading one is always a live pass-through to
 * a connected agent — which is allowed precisely because a read has no
 * side effect to lose (KD-008). Signalling a process is the opposite:
 * it is destructive and non-idempotent, so it goes through the queue.
 * ------------------------------------------------------------------ */

/** A process table is only useful if it arrives quickly; a slow host fails fast. */
const READ_TIMEOUT_MS = 15_000;

type TreeProcess = ProcessInfo & { depth: number };

const pidParam = z.object({ pid: z.coerce.number().int().positive() });

const signalInput = signalProcessInput.omit({ pid: true }).extend({ server_id: uuid });

export async function processRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/processes", async (req, reply) => {
    const q = parseQuery(req, processListQuery);
    // There is no table to scope-filter: the whole result belongs to one
    // host, and this is the check that decides whether it may be read.
    const server = await loadConnectedServer(req, q.server_id, "infra.processes:read");

    const term = q.q?.trim().toLowerCase();
    const matches = (p: ProcessInfo): boolean =>
      !term ||
      p.command.toLowerCase().includes(term) ||
      p.cmdline.toLowerCase().includes(term) ||
      p.user.toLowerCase().includes(term);

    if (q.view === "tree") {
      const result = await agentRead(server, () =>
        req.ctx.hub.call(server.id, "process.tree", {}, { timeoutMs: READ_TIMEOUT_MS }),
      );
      const tree: TreeProcess[] = result.processes;
      // Filtering keeps each row's depth, so the tree still renders its indent.
      const filtered = tree.filter((p) => matches(p) && (!q.user || p.user === q.user));
      return list(
        reply,
        filtered.slice(0, q.limit).map((p) => toApi(server.id, p)),
        paginate(filtered.length, 1, q.limit),
      );
    }

    const result = await agentRead(server, () =>
      req.ctx.hub.call(
        server.id,
        "process.list",
        { sort: q.sort, limit: q.limit, user: q.user },
        { timeoutMs: READ_TIMEOUT_MS },
      ),
    );
    const rows: ProcessInfo[] = result.processes;
    const reported: number = result.total ?? rows.length;
    const filtered = rows.filter(matches);

    return list(
      reply,
      filtered.map((p) => toApi(server.id, p)),
      // `total` is the host's full count; once we filter locally, only the
      // rows we actually matched can be claimed.
      paginate(term ? filtered.length : reported, 1, q.limit),
    );
  });

  /* ----------------------------- signal ----------------------------- */

  app.post("/processes/:pid/signal", async (req, reply) => {
    const { pid } = parseParams(req, pidParam);
    const body = parseBody(req, signalInput);
    const server = await loadServer(req, body.server_id, "infra.processes:exec");

    if (pid === 1) {
      throw conflict(
        `pid 1 is the init system on ${server.name}; signalling it would take the host down.`,
        {
          summary: "Reboot the server instead — that is queued, audited and recoverable.",
          actions: [
            {
              label: "Reboot server",
              href: `/infrastructure/servers/${server.id}`,
              action: "servers.reboot",
            },
          ],
        },
      );
    }

    const job = await enqueueServerJob(req, {
      type: "process.signal",
      server,
      targetType: "process",
      targetId: String(pid),
      targetLabel: `pid ${pid}`,
      params: { pid, signal: body.signal },
    });
    return accepted(reply, job);
  });
}

/* ------------------------------------------------------------------ */

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

function toApi(serverId: string, p: ProcessInfo & { depth?: number }): ProcessRow {
  return {
    server_id: serverId,
    pid: p.pid,
    ppid: p.ppid,
    user: p.user,
    command: p.command,
    cmdline: p.cmdline,
    state: p.state,
    cpu_percent: p.cpu_percent,
    memory_rss: p.memory_rss,
    memory_percent: p.memory_percent,
    threads: p.threads,
    nice: p.nice,
    started_at: p.started_at,
    depth: p.depth,
  };
}
