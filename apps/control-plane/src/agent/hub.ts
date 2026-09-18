import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  AGENT_METHODS,
  AGENT_EVENT_TOPICS,
  MAX_CHUNK_BYTES,
  MAX_DEADLINE_MS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MULTIPLIER,
  STREAM_WINDOW,
  type AgentError,
  type AgentEventTopic,
  type AgentMethod,
  type HelloFrame,
  type MethodParams,
  type MethodResult,
} from "@kaname/contract/agent";
import type { Logger } from "pino";

/* ------------------------------------------------------------------ *
 * The agent hub.
 *
 * Holds one live WebSocket per enrolled server and multiplexes typed
 * RPC over it. This is the ONLY place in the control plane that talks
 * to a managed host — nothing above it has a socket, a shell or a
 * container runtime.
 *
 * Flow control mirrors agent/internal/rpc/conn.go exactly: a sender may
 * have STREAM_WINDOW chunks unacknowledged, an `ack` for seq N means
 * "everything through N arrived", and a receiver acks every half window
 * — but only once its own sink has taken the bytes, so a slow browser
 * stalls the agent instead of filling this process.
 * ------------------------------------------------------------------ */

export type ChunkEncoding = "utf8" | "base64";

/**
 * Consumes one inbound chunk. Returning a promise holds the next chunk
 * (and the ack that lets the agent send more) until it resolves, which
 * is how a consumer's own backpressure reaches the host.
 */
export type ChunkConsumer = (data: string, encoding: ChunkEncoding) => void | Promise<void>;

export interface AgentRpcOptions {
  /** Overrides the method's default deadline; clamped to MAX_DEADLINE_MS. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamHandle<T = unknown> {
  /** Resolves with the final result once the stream ended and every chunk reached the consumer. */
  done: Promise<T>;
  /**
   * Send a chunk upstream (bidirectional streams only). Resolves once the
   * chunk has left, which is delayed while the agent's window is full or
   * the socket is behind; rejects if the stream is no longer open.
   */
  send(data: string, encoding?: ChunkEncoding): Promise<void>;
  cancel(reason?: string): void;
}

export class AgentRpcError extends Error {
  constructor(readonly agentError: AgentError) {
    super(agentError.message);
    this.name = "AgentRpcError";
  }
}

export class AgentOfflineError extends Error {
  constructor(readonly serverId: string) {
    super(`No agent connected for server ${serverId}`);
    this.name = "AgentOfflineError";
  }
}

const DEFAULT_DEADLINE_MS = 60_000;
/** Outbound: pause while the socket holds more than this unsent (1 MiB). */
const SEND_HIGH_WATER_BYTES = 4 * MAX_CHUNK_BYTES;
/** bufferedAmount has no event, so a blocked sender re-reads it on this cadence. */
const SEND_POLL_MS = 20;
/** An agent that never introduces itself is not one we can drive. */
const HELLO_TIMEOUT_MS = 10_000;

interface Waiter {
  resolve(): void;
  reject(err: Error): void;
}

interface PendingCall {
  method: AgentMethod;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  onChunk?: ChunkConsumer;
  /** Inbound chunks are handed to the consumer strictly in order through this chain. */
  drain: Promise<void>;
  /** Inbound chunk count, which is what decides when an ack is due. */
  received: number;
  lastSeq: number;
  /** Outbound window: the next seq to assign and how many the agent has confirmed. */
  nextSeq: number;
  ackedSeq: number;
  /** Senders paused on the window or the socket buffer. */
  waiters: Waiter[];
  abort: { signal: AbortSignal; handler: () => void } | null;
}

export interface AgentConnectionInfo {
  serverId: string;
  agentVersion: string;
  protocol: number;
  capabilities: string[];
  host: HelloFrame["host"];
  connectedAt: Date;
  lastSeenAt: Date;
  remoteAddress: string | null;
  inFlight: number;
}

/* ------------------------------------------------------------------ */

class AgentConnection {
  readonly serverId: string;
  readonly connectedAt = new Date();
  lastSeenAt = new Date();
  hello: HelloFrame | null = null;

  private readonly pending = new Map<string, PendingCall>();
  private pingTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private closed = false;

  constructor(
    serverId: string,
    private readonly socket: WebSocket,
    private readonly log: Logger,
    private readonly onEvent: (
      serverId: string,
      topic: AgentEventTopic,
      ts: string,
      data: unknown,
    ) => void,
    private readonly onHello: (conn: AgentConnection) => void,
    private readonly onClose: (conn: AgentConnection) => void,
    readonly remoteAddress: string | null,
  ) {
    this.serverId = serverId;
    socket.on("message", (raw) => this.handleMessage(raw.toString()));
    socket.on("close", () => this.destroy("socket closed"));
    socket.on("error", (err) => {
      this.log.warn({ err, serverId }, "agent socket error");
      this.destroy("socket error");
    });
    // Hello is the agent's first frame. Without it there is no version
    // and no capability list, so nothing above can be driven safely.
    this.helloTimer = setTimeout(() => {
      if (this.hello) return;
      this.log.warn({ serverId }, "agent sent no hello, dropping");
      this.destroy("no hello");
    }, HELLO_TIMEOUT_MS);
    this.helloTimer.unref?.();
    this.startHeartbeat();
  }

  get capabilities(): string[] {
    return this.hello?.capabilities ?? [];
  }

  get info(): AgentConnectionInfo {
    return {
      serverId: this.serverId,
      agentVersion: this.hello?.agent_version ?? "unknown",
      protocol: this.hello?.proto ?? 0,
      capabilities: this.capabilities,
      host: this.hello?.host ?? ({} as HelloFrame["host"]),
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      remoteAddress: this.remoteAddress,
      inFlight: this.pending.size,
    };
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (this.missedPongs >= PING_TIMEOUT_MULTIPLIER) {
        this.log.warn({ serverId: this.serverId }, "agent missed heartbeats, dropping");
        this.destroy("heartbeat timeout");
        return;
      }
      this.missedPongs += 1;
      this.write({ t: "png", ts: Date.now() });
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private write(frame: unknown): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private handleMessage(raw: string): void {
    this.lastSeenAt = new Date();
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log.warn({ serverId: this.serverId }, "agent sent malformed frame");
      return;
    }

    switch (frame.t) {
      case "hlo": {
        const first = this.hello === null;
        this.hello = frame as unknown as HelloFrame;
        if (this.helloTimer) {
          clearTimeout(this.helloTimer);
          this.helloTimer = null;
        }
        this.log.info(
          {
            serverId: this.serverId,
            version: this.hello.agent_version,
            caps: this.hello.capabilities.length,
          },
          "agent hello",
        );
        if (first) this.onHello(this);
        break;
      }

      case "pog":
        this.missedPongs = 0;
        break;

      case "png":
        this.write({ t: "pog", ts: frame.ts });
        break;

      case "res": {
        const call = this.pending.get(String(frame.id));
        if (!call) return;
        this.settle(
          String(frame.id),
          frame.ok === true,
          frame.ok === true ? frame.result : frame.error,
        );
        break;
      }

      case "chk": {
        const id = String(frame.id);
        const call = this.pending.get(id);
        if (!call) return;
        const seq = Number(frame.seq ?? 0);
        // Out-of-order chunks mean a protocol bug, not a recoverable state.
        if (call.lastSeq !== -1 && seq !== call.lastSeq + 1) {
          this.log.debug(
            { serverId: this.serverId, expected: call.lastSeq + 1, got: seq },
            "chunk gap",
          );
        }
        call.lastSeq = seq;
        const data = String(frame.data ?? "");
        if (data.length > MAX_CHUNK_BYTES * 2) {
          // Settling locally is not enough: the agent would keep streaming
          // into an id nobody owns until its own deadline.
          this.abandon(id, { code: "internal", message: "chunk exceeded window" });
          return;
        }
        const encoding: ChunkEncoding = frame.encoding === "base64" ? "base64" : "utf8";
        call.received += 1;
        const ackDue = call.received % (STREAM_WINDOW / 2) === 0;
        call.drain = call.drain
          .then(() => call.onChunk?.(data, encoding))
          .catch((err: unknown) => {
            // A sink that throws cannot take what follows either.
            this.log.warn(
              { err, serverId: this.serverId, method: call.method },
              "stream consumer failed",
            );
            call.onChunk = undefined;
            this.abandon(id, {
              code: "internal",
              message: `${call.method} consumer failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          })
          .then(() => {
            // The ack is the agent's licence to send another half window;
            // it goes out only once the consumer has taken this chunk.
            if (ackDue && this.pending.get(id) === call) this.write({ t: "ack", id, seq });
          });
        break;
      }

      case "ack": {
        const call = this.pending.get(String(frame.id));
        if (!call) return;
        // Same rule as the agent's Stream.acknowledge: seq N confirms
        // every chunk through N, so N+1 have been taken.
        const acked = Number(frame.seq) + 1;
        if (Number.isFinite(acked) && acked > call.ackedSeq) call.ackedSeq = acked;
        for (const waiter of call.waiters.splice(0)) waiter.resolve();
        break;
      }

      case "end":
        this.settle(
          String(frame.id),
          frame.ok === true,
          frame.ok === true ? undefined : frame.error,
        );
        break;

      case "evt": {
        const topic = String(frame.topic ?? "");
        // Topics not in the allow-list are dropped rather than forwarded.
        if ((AGENT_EVENT_TOPICS as readonly string[]).includes(topic)) {
          this.onEvent(
            this.serverId,
            topic as AgentEventTopic,
            String(frame.ts ?? new Date().toISOString()),
            frame.data,
          );
        }
        break;
      }

      default:
        this.log.debug({ serverId: this.serverId, t: frame.t }, "ignoring unknown frame");
    }
  }

  /**
   * Forgets a call: its deadline, its abort listener and its slot in the
   * table. Every path that ends a call goes through here, so a finished
   * call cannot keep a closure alive on a long-lived signal.
   */
  private release(id: string): PendingCall | undefined {
    const call = this.pending.get(id);
    if (!call) return undefined;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (call.abort) {
      call.abort.signal.removeEventListener("abort", call.abort.handler);
      call.abort = null;
    }
    return call;
  }

  private settle(id: string, ok: boolean, payload: unknown): void {
    const call = this.release(id);
    if (!call) return;
    const error = ok ? null : new AgentRpcError(normalizeAgentError(payload));
    // A sender paused on the window must not hang on a call that is gone.
    const senderError =
      error ?? new AgentRpcError({ code: "cancelled", message: `${call.method} stream closed` });
    for (const waiter of call.waiters.splice(0)) waiter.reject(senderError);
    // Chunks already queued for the consumer land before the outcome does:
    // a download's last bytes must not race the response's end().
    void call.drain.then(() => (error ? call.reject(error) : call.resolve(payload)));
  }

  /** Ends a call from this side: tells the agent to stop, then settles locally. */
  private abandon(id: string, error: AgentError): void {
    if (!this.pending.has(id)) return;
    this.write({ t: "can", id });
    this.settle(id, false, error);
  }

  call<M extends AgentMethod>(
    method: M,
    params: MethodParams<M>,
    opts: AgentRpcOptions & { onChunk?: ChunkConsumer } = {},
  ): { id: string; promise: Promise<MethodResult<M>> } {
    const spec = AGENT_METHODS[method];
    const id = randomUUID();
    // The agent clamps at MAX_DEADLINE_MS; a longer timer here would guard nothing.
    const deadline = Math.min(opts.timeoutMs ?? DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS);

    const promise = new Promise<MethodResult<M>>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new AgentRpcError({ code: "cancelled", message: `${method} cancelled` }));
        return;
      }

      const timer = setTimeout(
        () =>
          this.abandon(id, {
            code: "timeout",
            message: `${method} timed out after ${deadline}ms`,
          }),
        deadline,
      );
      timer.unref?.();

      const call: PendingCall = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        onChunk: opts.onChunk,
        drain: Promise.resolve(),
        received: 0,
        lastSeq: -1,
        nextSeq: 0,
        ackedSeq: 0,
        waiters: [],
        abort: null,
      };
      if (opts.signal) {
        const handler = () =>
          this.abandon(id, { code: "cancelled", message: `${method} cancelled` });
        opts.signal.addEventListener("abort", handler, { once: true });
        call.abort = { signal: opts.signal, handler };
      }
      this.pending.set(id, call);

      this.write({
        t: "req",
        id,
        method,
        params,
        deadline_ms: deadline,
        ...(spec.stream === "bidirectional" ? { stream: true } : {}),
      });
    });

    return { id, promise };
  }

  /**
   * Writes one chunk upstream, pausing while the agent's window is full
   * or the socket has fallen behind. Chunks leave in call order: senders
   * are woken in the order they paused and each re-checks before writing.
   */
  async sendChunk(id: string, data: string, encoding: ChunkEncoding = "utf8"): Promise<void> {
    const call = this.pending.get(id);
    if (!call) throw new AgentRpcError({ code: "cancelled", message: "stream is not open" });

    while (this.pending.get(id) === call) {
      const windowFull = call.nextSeq - call.ackedSeq >= STREAM_WINDOW;
      const socketBehind = this.socket.bufferedAmount > SEND_HIGH_WATER_BYTES;
      if (!windowFull && !socketBehind) break;
      await this.waitForRoom(call, socketBehind);
    }
    if (this.pending.get(id) !== call) {
      throw new AgentRpcError({ code: "cancelled", message: `${call.method} stream closed` });
    }

    const seq = call.nextSeq;
    call.nextSeq += 1;
    this.write({ t: "chk", id, seq, data, encoding });
  }

  private waitForRoom(call: PendingCall, poll: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter: Waiter = {
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      call.waiters.push(waiter);
      if (!poll) return;
      // An ack wakes a window wait; the socket buffer has no such signal.
      timer = setTimeout(() => {
        const index = call.waiters.indexOf(waiter);
        if (index >= 0) call.waiters.splice(index, 1);
        resolve();
      }, SEND_POLL_MS);
      timer.unref?.();
    });
  }

  cancel(id: string, reason?: string): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.abandon(id, {
      code: "cancelled",
      message: reason ? `${call.method} cancelled: ${reason}` : `${call.method} cancelled`,
    });
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    for (const id of [...this.pending.keys()]) {
      this.settle(id, false, { code: "cancelled", message: `connection lost: ${reason}` });
    }
    try {
      this.socket.close(1000, reason.slice(0, 120));
    } catch {
      /* already gone */
    }
    this.onClose(this);
  }
}

function normalizeAgentError(payload: unknown): AgentError {
  if (payload && typeof payload === "object" && "code" in payload && "message" in payload) {
    return payload as AgentError;
  }
  return { code: "internal", message: "agent returned an unspecified error", detail: payload };
}

/* ------------------------------------------------------------------ */

export interface HubEvents {
  connected: (serverId: string, info: AgentConnectionInfo) => void;
  disconnected: (serverId: string) => void;
  event: (serverId: string, topic: AgentEventTopic, ts: string, data: unknown) => void;
}

export class AgentHub extends EventEmitter {
  private readonly connections = new Map<string, AgentConnection>();

  constructor(private readonly log: Logger) {
    super();
  }

  /** Called by the WS route once the socket's identity is proven. */
  register(serverId: string, socket: WebSocket, remoteAddress: string | null): void {
    this.connections.get(serverId)?.destroy("replaced by a newer connection");

    const conn = new AgentConnection(
      serverId,
      socket,
      this.log,
      (id, topic, ts, data) => this.emit("event", id, topic, ts, data),
      // Announced on hello rather than on a timer: the reconciler records
      // whatever version and capabilities it is handed, and a WAN round
      // trip is longer than any guess would be.
      (c) => {
        if (this.connections.get(c.serverId) === c) this.emit("connected", c.serverId, c.info);
      },
      (c) => {
        if (this.connections.get(c.serverId) === c) {
          this.connections.delete(c.serverId);
          this.emit("disconnected", c.serverId);
        }
      },
      remoteAddress,
    );
    this.connections.set(serverId, conn);
  }

  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  info(serverId: string): AgentConnectionInfo | null {
    return this.connections.get(serverId)?.info ?? null;
  }

  connectedServerIds(): string[] {
    return [...this.connections.keys()];
  }

  capabilities(serverId: string): string[] {
    return this.connections.get(serverId)?.capabilities ?? [];
  }

  /** Typed, non-streaming call. Throws AgentOfflineError if the box is unreachable. */
  async call<M extends AgentMethod>(
    serverId: string,
    method: M,
    params: MethodParams<M>,
    opts: AgentRpcOptions = {},
  ): Promise<MethodResult<M>> {
    const conn = this.require(serverId);
    this.assertCapability(conn, method);
    return conn.call(method, params, opts).promise;
  }

  /** Response-streaming call: chunks arrive via onChunk, result via `done`. */
  stream<M extends AgentMethod>(
    serverId: string,
    method: M,
    params: MethodParams<M>,
    onChunk: ChunkConsumer,
    opts: AgentRpcOptions = {},
  ): StreamHandle<MethodResult<M>> {
    const conn = this.require(serverId);
    this.assertCapability(conn, method);
    const { id, promise } = conn.call(method, params, { ...opts, onChunk });
    // A consumer that cancels after its own failure (a short upload body,
    // a client that left) has no reason to look at `done` again, and an
    // unobserved rejection would take the whole process down. Awaiting
    // callers still see the error.
    promise.catch(() => undefined);
    return {
      done: promise,
      send: (data, encoding) => {
        const sent = conn.sendChunk(id, data, encoding);
        // A fire-and-forget sender (terminal input) must not turn a closed
        // stream into an unhandled rejection; an awaiting one still sees it.
        sent.catch(() => undefined);
        return sent;
      },
      cancel: (reason) => conn.cancel(id, reason),
    };
  }

  disconnect(serverId: string, reason: string): void {
    this.connections.get(serverId)?.destroy(reason);
  }

  shutdown(): void {
    for (const conn of this.connections.values()) conn.destroy("control plane shutting down");
    this.connections.clear();
  }

  private require(serverId: string): AgentConnection {
    const conn = this.connections.get(serverId);
    if (!conn) throw new AgentOfflineError(serverId);
    return conn;
  }

  private assertCapability(conn: AgentConnection, method: AgentMethod): void {
    const required = AGENT_METHODS[method].requires;
    if (required.length === 0) return;
    const have = new Set(conn.capabilities);
    // Any one of the listed capabilities is enough (docker OR podman).
    if (!required.some((c) => have.has(c))) {
      throw new AgentRpcError({
        code: "unsupported",
        message: `host does not provide ${required.join(" or ")}`,
      });
    }
  }
}

export declare interface AgentHub {
  on<E extends keyof HubEvents>(event: E, listener: HubEvents[E]): this;
  emit<E extends keyof HubEvents>(event: E, ...args: Parameters<HubEvents[E]>): boolean;
}
