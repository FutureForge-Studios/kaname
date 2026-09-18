import type { Remediation } from "@kaname/contract";
import { API_BASE, ApiError, encodeParams, redirectToLogin, type AnyErrorCode } from "@/lib/api";

/* ------------------------------------------------------------------ *
 * The live mail transport tail.
 *
 * `/mail-logs/tail` streams raw Postfix lines as named SSE frames — it
 * is a different shape from both the multiplexed `/events` feed and the
 * structured `/logs/tail`, so it gets its own reader rather than a flag
 * on somebody else's.
 *
 * There is deliberately no resume cursor: the mail log is a byte stream
 * on the host, not a record store, and a reconnect starts a fresh
 * follow. The viewer says so instead of pretending the gap did not
 * happen.
 * ------------------------------------------------------------------ */

export type MailTailStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface MailLogLine {
  server_id: string;
  server_name: string;
  ts: string;
  line: string;
}

export interface MailLogTailOptions {
  serverId: string;
  /** Substring pushed down to the host so a busy relay does not flood the socket. */
  q?: string;
  lines?: number;
  onLine: (line: MailLogLine) => void;
  onStatusChange?: (status: MailTailStatus) => void;
  /** The stream failed in a way retrying will not fix. */
  onError?: (error: ApiError) => void;
  /**
   * A follow was reopened after lines had arrived. The host does not
   * replay what it wrote in between, so the viewer can say so.
   */
  onGap?: () => void;
}

const DEFAULT_RETRY_MS = 3000;
const MAX_RETRY_MS = 30_000;

interface ErrorFrame {
  code?: string;
  message?: string;
}

class MailLogTail {
  private controller: AbortController | null = null;
  private timer: number | null = null;
  private retryMs = DEFAULT_RETRY_MS;
  private attempt = 0;
  private stopped = false;
  /** Set once a follow has opened, so a reconnect does not replay the backlog. */
  private everOpened = false;
  /** Lines delivered so far; a reconnect after any of them is a gap. */
  private seen = 0;
  /** The control plane's per-follow cap was reached: reopen at once, not a failure. */
  private rotated = false;
  private state: MailTailStatus = "closed";

  constructor(private readonly options: MailLogTailOptions) {}

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

  private setStatus(next: MailTailStatus): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStatusChange?.(next);
  }

  private url(): string {
    const query = encodeParams({
      server_id: this.options.serverId,
      q: this.options.q,
      // The host sends `lines` of backlog before following. After a
      // dropped socket the viewer already has that backlog, so ask for
      // the minimum instead of appending it a second time.
      lines: this.everOpened ? 1 : this.options.lines,
    });
    return `${API_BASE}/mail-logs/tail?${query}`;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const controller = new AbortController();
    this.controller = controller;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    try {
      const response = await fetch(this.url(), {
        headers: { Accept: "text/event-stream" },
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
        // A refused tail is an answer, not a dropped socket: the host may
        // have no mail stack, or the agent may be gone. Say which.
        this.fail(await toApiError(response));
        return;
      }

      this.attempt = 0;
      const reopened = this.everOpened;
      this.everOpened = true;
      this.setStatus("open");
      if (reopened && this.seen > 0) this.options.onGap?.();
      await this.read(response.body);
    } catch {
      /* Aborts are our own stop(); anything else is a dropped socket. */
    }

    if (controller.signal.aborted) return;
    if (this.rotated) {
      // The stream ended because the control plane rotates a follow every
      // half hour, and said so. Nothing failed, so there is no backoff.
      this.rotated = false;
      this.setStatus("reconnecting");
      void this.connect();
      return;
    }
    this.scheduleReconnect();
  }

  private fail(error: ApiError): void {
    this.stopped = true;
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

    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0 || line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const rest = colon === -1 ? "" : line.slice(colon + 1);
      const value = rest.startsWith(" ") ? rest.slice(1) : rest;

      if (field === "data") dataLines.push(value);
      else if (field === "event") event = value;
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
          message: frame.message ?? "The mail log stream ended unexpectedly.",
          status: 502,
        }),
      );
      return;
    }

    if (event === "rotate") {
      this.rotated = true;
      return;
    }

    this.seen += 1;
    this.options.onLine(payload as MailLogLine);
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
    message: error.message ?? `The mail log stream could not be opened (${response.status}).`,
    status: response.status,
    remediation: error.remediation ?? null,
  });
}

/** Opens a tail and returns its teardown, for use inside an effect. */
export function openMailLogTail(options: MailLogTailOptions): () => void {
  const tail = new MailLogTail(options);
  tail.start();
  return () => tail.stop();
}
