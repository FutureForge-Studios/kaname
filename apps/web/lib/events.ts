import type { EventTopic } from "@kaname/contract";
import { API_BASE, encodeParams, redirectToLogin } from "./api";

/* ------------------------------------------------------------------ *
 * The SSE client behind every live surface in the panel.
 *
 * Built on fetch rather than EventSource for one reason: EventSource
 * will not let us set the `Last-Event-ID` request header, and the
 * control plane replays missed events from exactly that header. Without
 * it a reconnect silently loses the `job.succeeded` that a drawer is
 * waiting on. Everything else EventSource gives for free — retry
 * hints, id tracking, comment keepalives — is ~120 lines here.
 * ------------------------------------------------------------------ */

export interface StreamMessage {
  id: string;
  topic: EventTopic;
  type: string;
  ts: string;
  data: unknown;
}

export type EventStreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface EventStreamOptions {
  topics?: readonly EventTopic[];
  serverId?: string | null;
  onMessage: (message: StreamMessage) => void;
  onStatusChange?: (status: EventStreamStatus) => void;
}

const DEFAULT_RETRY_MS = 3000;
const MAX_RETRY_MS = 30_000;

export class EventStream {
  private controller: AbortController | null = null;
  private timer: number | null = null;
  private lastEventId: string | null = null;
  private retryMs = DEFAULT_RETRY_MS;
  private attempt = 0;
  private stopped = false;
  /** True from the start of a connect until its reader ends, so nothing opens a second one. */
  private inFlight = false;
  private state: EventStreamStatus = "closed";

  constructor(private readonly options: EventStreamOptions) {}

  get status(): EventStreamStatus {
    return this.state;
  }

  start(): void {
    if (typeof window === "undefined") return;
    this.stopped = false;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.wake);
      document.removeEventListener("visibilitychange", this.wake);
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.setStatus("closed");
  }

  /** A tab coming back to the foreground should not wait out the backoff. */
  private wake = (): void => {
    if (this.stopped || this.inFlight) return;
    if (document.visibilityState === "hidden" && !navigator.onLine) return;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    void this.connect();
  };

  private setStatus(next: EventStreamStatus): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStatusChange?.(next);
  }

  private url(): string {
    const query = encodeParams({
      topics: this.options.topics ? [...this.options.topics] : undefined,
      server_id: this.options.serverId ?? undefined,
    });
    return query ? `${API_BASE}/events?${query}` : `${API_BASE}/events`;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;

    // A predecessor that is still reading would otherwise dispatch every
    // event twice and outlive stop(), which only aborts the newest one.
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

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

      // 403 means this principal may never read the feed. Reconnecting
      // would just hammer the control plane with the same answer.
      if (response.status === 403) {
        this.stop();
        return;
      }

      if (response.ok && response.body) {
        this.attempt = 0;
        this.setStatus("open");
        await this.read(response.body);
      }
    } catch {
      /* Aborts are our own stop(); anything else is a dropped socket. */
    } finally {
      this.inFlight = false;
    }

    if (!controller.signal.aborted) this.scheduleReconnect();
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
    let id: string | null = null;

    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0 || line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const rest = colon === -1 ? "" : line.slice(colon + 1);
      const value = rest.startsWith(" ") ? rest.slice(1) : rest;

      if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
      else if (field === "retry") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) this.retryMs = parsed;
      }
    }

    if (id) this.lastEventId = id;
    if (dataLines.length === 0) return;

    try {
      const message = JSON.parse(dataLines.join("\n")) as StreamMessage;
      if (message && typeof message.topic === "string") this.options.onMessage(message);
    } catch {
      /* A truncated frame is not worth tearing the stream down for. */
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    this.attempt += 1;

    // Jitter keeps a fleet of tabs from reconnecting in lockstep after a
    // control-plane restart.
    const backoff = Math.min(MAX_RETRY_MS, this.retryMs * 2 ** Math.min(this.attempt - 1, 4));
    const delay = backoff * (0.75 + Math.random() * 0.5);

    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}

/** Opens a stream and returns its teardown, for use inside an effect. */
export function connectEventStream(options: EventStreamOptions): () => void {
  const stream = new EventStream(options);
  stream.start();
  return () => stream.stop();
}
