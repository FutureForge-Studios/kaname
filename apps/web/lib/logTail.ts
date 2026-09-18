import type { LogLevel, LogRecordRow, Remediation } from "@kaname/contract";
import { API_BASE, ApiError, encodeParams, redirectToLogin, type AnyErrorCode } from "./api";

/* ------------------------------------------------------------------ *
 * The live log tail.
 *
 * `/logs/tail` is a named-event SSE stream rather than the multiplexed
 * `/events` feed, so it gets its own reader: the payload is a log record
 * per frame, the id is the record cursor, and a reconnect must resume
 * from that cursor or the viewer silently loses whatever arrived while
 * the socket was down.
 *
 * Like the event bus (lib/events.ts) this is built on fetch rather than
 * EventSource, because EventSource cannot send `Last-Event-ID` and a
 * resumable tail is the whole point.
 * ------------------------------------------------------------------ */

export type LogTailStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface LogTailOptions {
  serverId: string;
  source: string;
  /** Minimum severity, pushed down to the host. */
  level?: LogLevel;
  /** Substring, or `/pattern/` for a regex. Filtered on the host, not here. */
  q?: string;
  since?: string;
  limit?: number;
  onRecord: (record: LogRecordRow) => void;
  onStatusChange?: (status: LogTailStatus) => void;
  /** The stream failed in a way retrying will not fix. */
  onError?: (error: ApiError) => void;
}

const DEFAULT_RETRY_MS = 3000;
const MAX_RETRY_MS = 30_000;

interface ErrorFrame {
  code?: string;
  message?: string;
}

export class LogTail {
  private controller: AbortController | null = null;
  private timer: number | null = null;
  private cursor: string | null = null;
  private retryMs = DEFAULT_RETRY_MS;
  private attempt = 0;
  private stopped = false;
  private state: LogTailStatus = "closed";

  constructor(private readonly options: LogTailOptions) {}

  get status(): LogTailStatus {
    return this.state;
  }

  start(): void {
    if (typeof window === "undefined") return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.setStatus("closed");
  }

  private setStatus(next: LogTailStatus): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStatusChange?.(next);
  }

  private url(): string {
    const query = encodeParams({
      server_id: this.options.serverId,
      source: this.options.source,
      level: this.options.level,
      q: this.options.q,
      // A resumed tail continues from the last rendered record; a fresh
      // one starts from the operator's chosen window.
      since: this.cursor ? undefined : this.options.since,
      cursor: this.cursor ?? undefined,
      limit: this.options.limit,
      follow: true,
    });
    return `${API_BASE}/logs/tail?${query}`;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const controller = new AbortController();
    this.controller = controller;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.cursor) headers["Last-Event-ID"] = this.cursor;

    try {
      const response = await fetch(this.url(), {
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });

      if (response.status === 401) {
        this.stop();
        redirectToLogin();
        return;
      }

      if (!response.ok || !response.body) {
        // A refused tail is an answer, not a dropped socket: the source
        // may not exist, or the agent may be gone. Say which.
        this.fail(await toApiError(response));
        return;
      }

      this.attempt = 0;
      this.setStatus("open");
      await this.read(response.body);
    } catch {
      /* Aborts are our own stop(); anything else is a dropped socket. */
    }

    if (!controller.signal.aborted) this.scheduleReconnect();
  }

  private fail(error: ApiError): void {
    this.stopped = true;
    // The reader that dispatched the error frame is still awaiting the
    // body; without this it keeps delivering records after "closed".
    this.controller?.abort();
    this.controller = null;
    this.setStatus("closed");
    this.options.onError?.(error);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        this.dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private dispatch(chunk: string): void {
    const dataLines: string[] = [];
    let event = "message";
    let id: string | null = null;

    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0 || line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const rest = colon === -1 ? "" : line.slice(colon + 1);
      const value = rest.startsWith(" ") ? rest.slice(1) : rest;

      if (field === "data") dataLines.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "retry") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) this.retryMs = parsed;
      }
    }

    if (dataLines.length === 0) return;

    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      /* A truncated frame is not worth tearing the stream down for. */
      return;
    }

    if (event === "error") {
      const frame = payload as ErrorFrame;
      this.fail(
        new ApiError({
          code: (frame.code as AnyErrorCode) ?? "agent_error",
          message: frame.message ?? "The log stream ended unexpectedly.",
          status: 502,
        }),
      );
      return;
    }

    if (event === "end") {
      // The source closed cleanly — a rotated file, a stopped unit. The
      // viewer keeps what it has rather than pretending it is still live.
      this.stop();
      return;
    }

    if (id) this.cursor = id;
    this.options.onRecord(payload as LogRecordRow);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    this.attempt += 1;

    const backoff = Math.min(MAX_RETRY_MS, this.retryMs * 2 ** Math.min(this.attempt - 1, 4));
    const delay = backoff * (0.75 + Math.random() * 0.5);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; remediation?: Remediation };
}

async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    /* An SSE endpoint that answered with something other than JSON. */
  }

  const error = envelope.error ?? {};
  return new ApiError({
    code: (error.code as AnyErrorCode) ?? "agent_error",
    message: error.message ?? `The log stream could not be opened (${response.status}).`,
    status: response.status,
    remediation: error.remediation ?? null,
  });
}

/** Opens a tail and returns its teardown, for use inside an effect. */
export function openLogTail(options: LogTailOptions): () => void {
  const tail = new LogTail(options);
  tail.start();
  return () => tail.stop();
}
