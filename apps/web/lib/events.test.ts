import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream, type StreamMessage } from "./events";

/* ------------------------------------------------------------------ *
 * The SSE client. What is defended: a wake-up during a pending
 * reconnect never opens a second stream, stop() aborts every fetch it
 * ever started, and frames are parsed once.
 * ------------------------------------------------------------------ */

interface FakeFetch {
  calls: { signal: AbortSignal; headers: Record<string, string> }[];
  /** Resolves the most recent pending fetch with a stream that stays open. */
  open(): void;
  /** Pushes an SSE frame into the currently open stream. */
  push(frame: string): void;
  /** Resolves the most recent pending fetch with a failure status. */
  refuse(status: number): void;
  /** Ends the currently open stream, as a control-plane restart would. */
  close(): void;
}

function installFakeFetch(): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const pending: Array<(response: Response) => void> = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  vi.stubGlobal(
    "fetch",
    vi.fn((_: unknown, init?: RequestInit) => {
      calls.push({
        signal: init!.signal!,
        headers: (init!.headers as Record<string, string>) ?? {},
      });
      return new Promise<Response>((resolve, reject) => {
        pending.push(resolve);
        init!.signal!.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }),
  );

  return {
    calls,
    open() {
      const resolve = pending.pop()!;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      resolve(new Response(body, { status: 200 }));
    },
    push(frame) {
      controller!.enqueue(encoder.encode(frame));
    },
    refuse(status) {
      pending.pop()!(new Response("", { status }));
    },
    close() {
      controller!.close();
      controller = null;
    },
  };
}

/* Captured before the timers are faked, so awaiting a tick is still possible. */
const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

describe("EventStream", () => {
  let fake: FakeFetch;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fake = installFakeFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers parsed frames and resumes from the last id after the server closes the stream", async () => {
    const seen: StreamMessage[] = [];
    const stream = new EventStream({ onMessage: (m) => seen.push(m) });
    stream.start();
    await flush();
    fake.open();
    await flush();
    expect(stream.status).toBe("open");

    fake.push(
      `id: evt-1\nevent: jobs\ndata: ${JSON.stringify({ id: "evt-1", topic: "jobs", type: "job.started", ts: "t", data: {} })}\n\n: keepalive\n\n`,
    );
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("job.started");

    // The control plane restarts: the stream ends cleanly, a reconnect is
    // scheduled, and it presents the last id so nothing is lost.
    fake.close();
    await flush();
    expect(stream.status).toBe("reconnecting");
    await vi.runOnlyPendingTimersAsync();
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.headers["Last-Event-ID"]).toBe("evt-1");

    stream.stop();
    for (const call of fake.calls) expect(call.signal.aborted).toBe(true);
  });

  it("never opens a second stream when woken during a pending reconnect", async () => {
    const stream = new EventStream({ onMessage: () => {} });
    stream.start();
    await flush();
    expect(fake.calls).toHaveLength(1);

    // First attempt is refused; a reconnect is scheduled.
    fake.refuse(503);
    await flush();
    expect(stream.status).toBe("reconnecting");

    // The backoff fires and a second fetch is in flight.
    await vi.runOnlyPendingTimersAsync();
    expect(fake.calls).toHaveLength(2);

    // The tab comes back to the foreground while that fetch is pending.
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(fake.calls).toHaveLength(2);

    fake.open();
    await flush();
    expect(stream.status).toBe("open");

    // A wake while open is also a no-op.
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(fake.calls).toHaveLength(2);

    stream.stop();
    for (const call of fake.calls) expect(call.signal.aborted).toBe(true);
    expect(stream.status).toBe("closed");
  });
});
