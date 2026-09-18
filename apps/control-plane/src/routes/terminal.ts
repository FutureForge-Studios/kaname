import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { and, asc, desc, eq, gt, isNotNull, isNull, sql, type Database } from "@kaname/db";
import { servers, settings, terminalRecordings, terminalSessions } from "@kaname/db/schema";
import {
  can,
  idParam,
  terminalSessionListQuery,
  terminalSessionRequest,
  type TerminalSessionRecord,
  type TerminalSessionTicket,
} from "@kaname/contract";
import { MAX_DEADLINE_MS, ptyResizeParams, type MethodResult } from "@kaname/contract/agent";
import { z } from "zod";
import { AgentOfflineError, AgentRpcError, type StreamHandle } from "../agent/hub.js";
import {
  helpers,
  item,
  list,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { ApiException, notFound } from "../lib/errors.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { combine, loadConnectedServer, scopeFilter, searchTerm, sortColumn } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Terminal (KD-013).
 *
 * The one place in the product where "no shell strings" cannot hold, so
 * it gets compensating controls instead of a rule: a permission of its
 * own, a single-use ticket that expires in 30 seconds and is bound to
 * the requesting address, an audit entry on open and on close, and a
 * recorded I/O stream unless an operator has explicitly (and audibly)
 * turned recording off.
 * ------------------------------------------------------------------ */

const TICKET_TTL_MS = 30_000;
const RECORDING_FLUSH_MS = 500;
const RECORDING_FLUSH_FRAMES = 64;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Output waits once the browser socket holds this much unsent; the agent's PTY waits with it. */
const OUTPUT_HIGH_WATER_BYTES = 1024 * 1024;
const OUTPUT_POLL_MS = 20;

const SORTABLE_SESSIONS = {
  started_at: terminalSessions.startedAt,
  duration_ms: terminalSessions.durationMs,
  user_name: terminalSessions.userName,
  bytes_out: terminalSessions.bytesOut,
} as const;

const ticketParam = z.object({ ticket: z.string().min(16).max(256) });

/** Text frames are control; everything else on the socket is raw input. */
const controlFrame = ptyResizeParams.extend({ t: z.literal("resize") });

const replayQuery = z.object({
  from_seq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(20_000).default(5000),
});

export async function terminalRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- sessions ---------------------------- */

  app.post("/terminal/sessions", async (req, reply) => {
    const body = parseBody(req, terminalSessionRequest);
    const server = await loadConnectedServer(req, body.server_id, "terminal.session:exec");
    const h = helpers(req);
    const principal = h.requirePrincipal();

    // A root shell is an interactive act by a person. An API key is a
    // long-lived credential with no session to expire, so it does not
    // get one — it can still drive every typed verb through the API.
    if (principal.kind !== "user") {
      throw new ApiException(
        "forbidden",
        "Terminal sessions require an interactive user session.",
        {
          remediation: {
            summary:
              "Sign in to the panel and open the terminal there. API keys cannot open a shell.",
            actions: [{ label: "Open terminal", href: `/terminal?server_id=${server.id}` }],
          },
        },
      );
    }

    const ticket = generateToken("kn_tty");
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    const recorded = await recordingEnabled(req.ctx.db);

    const [row] = await req.ctx.db
      .insert(terminalSessions)
      .values({
        serverId: server.id,
        userId: principal.id,
        userName: principal.name,
        posixUser: body.user ?? "root",
        ticketHash: hashToken(ticket),
        ip: req.ip ?? null,
        recorded,
        expiresAt,
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "terminal.session.requested",
      targetType: "terminal_session",
      targetId: row!.id,
      targetLabel: server.name,
      serverId: server.id,
      metadata: { posix_user: row!.posixUser, recorded, cols: body.cols, rows: body.rows },
    });

    const response: TerminalSessionTicket = {
      ticket,
      ws_url: socketUrl(req.ctx.config.clientApiUrl, ticket, body.cols, body.rows),
      expires_at: expiresAt.toISOString(),
      server_id: server.id,
      server_name: server.name,
      recorded,
    };
    return item(reply, response, 201);
  });

  app.get("/terminal/sessions", async (req, reply) => {
    const q = parseQuery(req, terminalSessionListQuery);
    helpers(req).authorize("terminal.session:exec");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "terminal.session:exec", terminalSessions.serverId),
      // A ticket nobody ever redeemed is not a session that happened.
      isNotNull(terminalSessions.startedAt),
      q.server_id ? eq(terminalSessions.serverId, q.server_id) : null,
      q.user_id ? eq(terminalSessions.userId, q.user_id) : null,
      q.active === true ? isNull(terminalSessions.endedAt) : null,
      q.active === false ? isNotNull(terminalSessions.endedAt) : null,
      term
        ? sql`(lower(${terminalSessions.userName}) like ${term} or lower(${servers.name}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_SESSIONS, q.sort, "started_at");
    const rows = await req.ctx.db
      .select({
        session: terminalSessions,
        serverName: servers.name,
        frames: sql<number>`(select count(*) from terminal_recordings tr where tr.session_id = ${terminalSessions.id})::int`,
      })
      .from(terminalSessions)
      .innerJoin(servers, eq(terminalSessions.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(terminalSessions)
      .innerJoin(servers, eq(terminalSessions.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toRecord(r.session, r.serverName, r.frames > 0)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  /* ----------------------------- replay ----------------------------- */

  app.get("/terminal/sessions/:id/recording", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, replayQuery);
    const h = helpers(req);

    const rows = await req.ctx.db
      .select({ session: terminalSessions, serverName: servers.name })
      .from(terminalSessions)
      .innerJoin(servers, eq(terminalSessions.serverId, servers.id))
      .where(eq(terminalSessions.id, id))
      .limit(1);

    const found = rows[0];
    if (!found) throw notFound("Terminal session", id);
    h.authorize("terminal.session:exec", found.session.serverId);

    if (!found.session.recorded) {
      throw new ApiException("not_found", "This session was not recorded.", {
        remediation: {
          summary:
            "Session recording was switched off when this shell was opened. Turning it off is itself an audited settings change.",
          actions: [
            { label: "Security settings", href: "/administration/settings" },
            { label: "Audit trail", href: "/security/audit" },
          ],
        },
      });
    }

    const frames = await req.ctx.db
      .select()
      .from(terminalRecordings)
      .where(and(eq(terminalRecordings.sessionId, id), gt(terminalRecordings.seq, q.from_seq)))
      // Batched writes can interleave, so replay order is the recorded
      // offset first and the write sequence only as a tie-breaker.
      .orderBy(asc(terminalRecordings.offsetMs), asc(terminalRecordings.seq))
      .limit(q.limit + 1);

    const page = frames.slice(0, q.limit);
    const last = page[page.length - 1];

    // Reading someone's root-shell transcript is itself worth recording.
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "terminal.recording.viewed",
      targetType: "terminal_session",
      targetId: id,
      targetLabel: found.serverName,
      serverId: found.session.serverId,
      metadata: { from_seq: q.from_seq, frames: page.length },
    });

    return item(reply, {
      session: toRecord(found.session, found.serverName, true),
      /** PTY output is arbitrary bytes, so each frame survives as base64. */
      encoding: "base64",
      frames: page.map((f) => ({
        seq: f.seq,
        offset_ms: f.offsetMs,
        direction: f.direction,
        data: f.data,
      })),
      next_seq: frames.length > q.limit ? (last?.seq ?? null) : null,
    });
  });

  /* --------------------------- the socket --------------------------- */

  app.get("/terminal/:ticket", { websocket: true }, async (socket, req) => {
    /*
     * There is deliberately no session cookie check here: the ticket
     * IS the credential (KD-013). It was minted by an authorised POST,
     * is single-use, expires in 30 seconds and is bound to the address
     * that asked for it — so this socket cannot be reached by guessing
     * a URL, and a leaked URL is useless a moment later.
     */
    const params = ticketParam.safeParse(req.params);
    if (!params.success) {
      socket.close(4400, "malformed ticket");
      return;
    }

    const rows = await req.ctx.db
      .select({ session: terminalSessions, server: servers })
      .from(terminalSessions)
      .innerJoin(servers, eq(terminalSessions.serverId, servers.id))
      .where(eq(terminalSessions.ticketHash, hashToken(params.data.ticket)))
      .limit(1);

    const found = rows[0];
    if (!found) {
      socket.close(4401, "unknown ticket");
      return;
    }
    const { session, server } = found;

    if (session.startedAt) {
      socket.close(4401, "ticket already used");
      return;
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      socket.close(4401, "ticket expired");
      return;
    }
    if (normalizeIp(session.ip) !== normalizeIp(req.ip)) {
      socket.close(4403, "ticket is bound to a different address");
      return;
    }

    // Grants can be withdrawn between minting a ticket and redeeming it.
    if (session.userId) {
      const grants = await req.ctx.auth.grantsForUser(session.userId);
      if (!can(grants, "terminal.session:exec", session.serverId)) {
        socket.close(4403, "permission withdrawn");
        return;
      }
    }

    // Single use is enforced by the update, not by the read above: two
    // simultaneous upgrades must not both win the same ticket.
    const claimed = await req.ctx.db
      .update(terminalSessions)
      .set({ startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(terminalSessions.id, session.id), isNull(terminalSessions.startedAt)))
      .returning({ id: terminalSessions.id });

    if (!claimed[0]) {
      socket.close(4401, "ticket already used");
      return;
    }

    if (!req.ctx.hub.isConnected(session.serverId)) {
      await req.ctx.db
        .update(terminalSessions)
        .set({ endedAt: new Date(), durationMs: 0, updatedAt: new Date() })
        .where(eq(terminalSessions.id, session.id));
      socket.close(4503, `the agent on ${server.name} is not connected`);
      return;
    }

    // The initial geometry rides on the ticket URL, revalidated with the
    // agent's own schema so a hand-edited link cannot widen it.
    const requested = req.query as { cols?: string; rows?: string };
    const size = ptyResizeParams.safeParse({
      cols: Number(requested.cols),
      rows: Number(requested.rows),
    });
    const cols = size.success ? size.data.cols : DEFAULT_COLS;
    const rows_ = size.success ? size.data.rows : DEFAULT_ROWS;

    const actor = {
      type: "user" as const,
      id: session.userId,
      name: session.userName,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    };

    await req.ctx.audit.record({
      actor,
      action: "terminal.session.opened",
      targetType: "terminal_session",
      targetId: session.id,
      targetLabel: server.name,
      serverId: session.serverId,
      metadata: { posix_user: session.posixUser, recorded: session.recorded, cols, rows: rows_ },
    });
    req.ctx.events.publish(
      "audit",
      "terminal.opened",
      { session_id: session.id, server_id: session.serverId, user_name: session.userName },
      session.serverId,
    );

    const startedAtMs = Date.now();
    let bytesIn = 0;
    let bytesOut = 0;
    let commandCount = 0;
    let closed = false;

    const pending: { offsetMs: number; direction: "in" | "out"; data: string }[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      try {
        await req.ctx.db.insert(terminalRecordings).values(
          batch.map((f) => ({
            sessionId: session.id,
            offsetMs: f.offsetMs,
            direction: f.direction,
            data: f.data,
          })),
        );
      } catch (err) {
        // Losing a recording batch must not kill an operator's shell
        // mid-incident; the gap is visible in the replay's offsets.
        req.log.warn({ err, sessionId: session.id }, "terminal recording flush failed");
      }
    };

    const record = (direction: "in" | "out", buf: Buffer): void => {
      if (!session.recorded) return;
      pending.push({
        offsetMs: Date.now() - startedAtMs,
        direction,
        data: buf.toString("base64"),
      });
      if (pending.length >= RECORDING_FLUSH_FRAMES) void flush();
    };

    const flushTimer = setInterval(() => void flush(), RECORDING_FLUSH_MS);
    flushTimer.unref?.();

    let handle: StreamHandle<MethodResult<"pty.open">>;
    try {
      handle = openPty();
    } catch (err) {
      // The agent dropped between the connectivity check above and here,
      // or does not offer a shell. Nothing is wired to the socket yet, so
      // this is the last place to tell the browser and settle the row
      // instead of leaving a hung terminal, a live flush timer and a
      // session that reads as still open.
      clearInterval(flushTimer);
      await req.ctx.db
        .update(terminalSessions)
        .set({ endedAt: new Date(), durationMs: 0, updatedAt: new Date() })
        .where(eq(terminalSessions.id, session.id));
      const reason =
        err instanceof AgentOfflineError
          ? `the agent on ${server.name} is not connected`
          : err instanceof AgentRpcError
            ? err.agentError.message
            : "could not open a shell on the host";
      socket.close(4503, reason.slice(0, 120));
      return;
    }

    function openPty(): StreamHandle<MethodResult<"pty.open">> {
      return req.ctx.hub.stream(
        session.serverId,
        "pty.open",
        {
          cols,
          rows: rows_,
          user: session.posixUser,
          term: "xterm-256color",
        },
        async (data, encoding) => {
          const buf =
            encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
          bytesOut += buf.length;
          record("out", buf);
          if (socket.readyState !== socket.OPEN) return;
          socket.send(buf);
          // ws has no drain event for its send queue, so a browser that has
          // stopped reading shows up here; waiting holds the PTY output too.
          while (
            socket.bufferedAmount > OUTPUT_HIGH_WATER_BYTES &&
            socket.readyState === socket.OPEN
          ) {
            await new Promise((resolve) => setTimeout(resolve, OUTPUT_POLL_MS));
          }
        },
        // A shell stays open as long as the operator wants it open, up to
        // the six hours the agent itself allows a request.
        { timeoutMs: MAX_DEADLINE_MS },
      );
    }

    const finish = async (reason: string, code = 1000): Promise<void> => {
      if (closed) return;
      closed = true;
      clearInterval(flushTimer);
      handle.cancel(reason);
      await flush();

      const endedAt = new Date();
      await req.ctx.db
        .update(terminalSessions)
        .set({
          endedAt,
          durationMs: endedAt.getTime() - startedAtMs,
          bytesIn,
          bytesOut,
          commandCount,
          updatedAt: endedAt,
        })
        .where(eq(terminalSessions.id, session.id));

      await req.ctx.audit.record({
        actor,
        action: "terminal.session.closed",
        targetType: "terminal_session",
        targetId: session.id,
        targetLabel: server.name,
        serverId: session.serverId,
        metadata: {
          reason,
          duration_ms: endedAt.getTime() - startedAtMs,
          bytes_in: bytesIn,
          bytes_out: bytesOut,
          command_count: commandCount,
        },
      });
      req.ctx.events.publish(
        "audit",
        "terminal.closed",
        { session_id: session.id, server_id: session.serverId, reason },
        session.serverId,
      );

      if (socket.readyState === socket.OPEN) socket.close(code, reason.slice(0, 120));
    };

    const write = (buf: Buffer): void => {
      if (closed || buf.length === 0) return;
      bytesIn += buf.length;
      // A carriage return is a submitted line; it is the only honest
      // command count available without parsing the remote shell.
      for (const byte of buf) if (byte === 0x0d) commandCount += 1;
      record("in", buf);
      handle.send(buf.toString("base64"), "base64");
    };

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (!isBinary) {
        const text = toBuffer(raw).toString("utf8");
        const control = parseControl(text);
        if (control) {
          void req.ctx.hub
            .call(session.serverId, "pty.resize", { cols: control.cols, rows: control.rows })
            .catch((err: unknown) =>
              req.log.debug({ err, sessionId: session.id }, "pty resize failed"),
            );
          return;
        }
        write(Buffer.from(text, "utf8"));
        return;
      }
      write(toBuffer(raw));
    });

    socket.on("close", () => void finish("client closed"));
    socket.on("error", (err) => {
      req.log.warn({ err, sessionId: session.id }, "terminal socket error");
      void finish("socket error");
    });

    void handle.done
      .then(() => finish("shell exited"))
      .catch((err: unknown) => {
        req.log.info({ err, sessionId: session.id }, "terminal stream ended");
        void finish("shell ended", 1011);
      });
  });
}

/* ------------------------------------------------------------------ */

/** Recording is on by default; disabling it is itself audited (KD-013). */
async function recordingEnabled(db: Database): Promise<boolean> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "security"))
    .limit(1);

  const value = rows[0]?.value as { terminal_recording?: unknown } | undefined;
  return value?.terminal_recording !== false;
}

function socketUrl(base: string, ticket: string, cols: number, rows: number): string {
  const url = new URL(`/api/v1/terminal/${ticket}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));
  return url.toString();
}

/** IPv4-mapped IPv6 and plain IPv4 are the same address to an operator. */
function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function parseControl(text: string): { cols: number; rows: number } | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed = controlFrame.safeParse(JSON.parse(text));
    return parsed.success ? { cols: parsed.data.cols, rows: parsed.data.rows } : null;
  } catch {
    return null;
  }
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function toRecord(
  row: typeof terminalSessions.$inferSelect,
  serverName: string,
  recordingAvailable: boolean,
): TerminalSessionRecord {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: serverName,
    user_id: row.userId!,
    user_name: row.userName,
    started_at: (row.startedAt ?? row.createdAt).toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    duration_ms: row.durationMs,
    bytes_in: row.bytesIn,
    bytes_out: row.bytesOut,
    command_count: row.commandCount,
    recording_available: row.recorded && recordingAvailable,
  };
}
