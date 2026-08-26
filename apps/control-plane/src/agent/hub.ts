import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  AGENT_METHODS,
  AGENT_EVENT_TOPICS,
  MAX_CHUNK_BYTES,
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
 * ------------------------------------------------------------------ */

export interface AgentRpcOptions {
  /** Overrides the method's default deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StreamHandle<T = unknown> {
  /** Resolves with the final result when the stream ends cleanly. */
  done: Promise<T>;
  /** Send a chunk upstream (bidirectional streams only). */
  send(data: string, encoding?: "utf8" | "base64"): void;
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

interface PendingCall {
  method: AgentMethod;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  onChunk?(data: string, encoding: "utf8" | "base64"): void;
  chunksSinceAck: number;
  lastSeq: number;
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
      case "hlo":
        this.hello = frame as unknown as HelloFrame;
        this.log.info(
          {
            serverId: this.serverId,
            version: this.hello.agent_version,
            caps: this.hello.capabilities.length,
          },
          "agent hello",
        );
        break;

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
        const call = this.pending.get(String(frame.id));
        if (!call) return;
        const seq = Number(frame.seq ?? 0);
        // Out-of-order chunks mean a protocol bug, not a recoverable state.
        if (seq !== call.lastSeq + 1 && call.lastSeq !== -1) {
          this.log.debug(
            { serverId: this.serverId, expected: call.lastSeq + 1, got: seq },
            "chunk gap",
          );
        }
        call.lastSeq = seq;
        const data = String(frame.data ?? "");
        if (data.length > MAX_CHUNK_BYTES * 2) {
          this.settle(String(frame.id), false, {
            code: "internal",
            message: "chunk exceeded window",
          });
          return;
        }
        call.onChunk?.(data, (frame.encoding as "utf8" | "base64") ?? "utf8");
        call.chunksSinceAck += 1;
        if (call.chunksSinceAck >= STREAM_WINDOW / 2) {
          call.chunksSinceAck = 0;
          this.write({ t: "ack", id: frame.id, seq });
        }
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

  private settle(id: string, ok: boolean, payload: unknown): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (ok) call.resolve(payload);
    else call.reject(new AgentRpcError(normalizeAgentError(payload)));
  }

  call<M extends AgentMethod>(
    method: M,
    params: MethodParams<M>,
    opts: AgentRpcOptions & { onChunk?: (data: string, encoding: "utf8" | "base64") => void } = {},
  ): { id: string; promise: Promise<MethodResult<M>> } {
    const spec = AGENT_METHODS[method];
    const id = randomUUID();
    const deadline = opts.timeoutMs ?? 60_000;

    const promise = new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.write({ t: "can", id });
        reject(
          new AgentRpcError({
            code: "timeout",
            message: `${method} timed out after ${deadline}ms`,
          }),
        );
      }, deadline);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        onChunk: opts.onChunk,
        chunksSinceAck: 0,
        lastSeq: -1,
      });

      opts.signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          this.write({ t: "can", id });
          reject(new AgentRpcError({ code: "cancelled", message: `${method} cancelled` }));
        },
        { once: true },
      );

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

  sendChunk(id: string, data: string, encoding: "utf8" | "base64" = "utf8"): void {
    if (!this.pending.has(id)) return;
    this.write({ t: "chk", id, seq: 0, data, encoding });
  }

  cancel(id: string): void {
    this.write({ t: "can", id });
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new AgentRpcError({ code: "cancelled", message: `connection lost: ${reason}` }));
      this.pending.delete(id);
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
      (c) => {
        if (this.connections.get(c.serverId) === c) {
          this.connections.delete(c.serverId);
          this.emit("disconnected", c.serverId);
        }
      },
      remoteAddress,
    );
    this.connections.set(serverId, conn);
    // hello arrives asynchronously; announce once we have it or after a beat.
    setTimeout(() => this.emit("connected", serverId, conn.info), 50).unref?.();
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
    onChunk: (data: string, encoding: "utf8" | "base64") => void,
    opts: AgentRpcOptions = {},
  ): StreamHandle<MethodResult<M>> {
    const conn = this.require(serverId);
    this.assertCapability(conn, method);
    const { id, promise } = conn.call(method, params, { ...opts, onChunk });
    return {
      done: promise,
      send: (data, encoding) => conn.sendChunk(id, data, encoding),
      cancel: () => conn.cancel(id),
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
