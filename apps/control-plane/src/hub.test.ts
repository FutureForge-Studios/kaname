import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { WebSocket } from "ws";
import { MAX_CHUNK_BYTES, MAX_DEADLINE_MS, STREAM_WINDOW } from "@kaname/contract/agent";
import { AgentHub, AgentRpcError } from "./agent/hub.js";

/* ------------------------------------------------------------------ *
 * The hub's side of the contract with agent/internal/rpc/conn.go:
 *   - a sender never has more than STREAM_WINDOW chunks unacknowledged
 *   - an inbound half window is acked only once the consumer took it
 *   - a call that ends leaves nothing behind: no timer, no listener
 *   - a connection exists once hello arrived, not once a socket opened
 * ------------------------------------------------------------------ */

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const HELLO = {
  t: "hlo",
  proto: 1,
  agent_version: "1.2.3",
  capabilities: ["systemd"],
  host: {
    hostname: "test-01",
    machine_id: "m-1",
    os: "linux",
    os_version: "12",
    arch: "x86_64",
    kernel: "6.1.0",
    boot_time: "2026-01-01T00:00:00Z",
    simulated: true,
  },
};

/** Stands in for a `ws` socket: records what the hub sends and lets a test play the agent. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: { code: number; reason: string } | null = null;

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  /** What the agent would have written. */
  receive(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  frames(t: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.t === t);
  }
}

const hubs: AgentHub[] = [];

function newHub(): { hub: AgentHub; socket: FakeSocket } {
  const hub = new AgentHub(pino({ level: "silent" }));
  hubs.push(hub);
  return { hub, socket: new FakeSocket() };
}

/** A registered connection whose agent has already said hello. */
function connect(): { hub: AgentHub; socket: FakeSocket } {
  const { hub, socket } = newHub();
  hub.register(SERVER_ID, socket as unknown as WebSocket, null);
  socket.receive(HELLO);
  return { hub, socket };
}

/** Lets every queued microtask and the current I/O turn run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function requestId(socket: FakeSocket): string {
  const req = socket.frames("req").at(-1);
  if (!req) throw new Error("no request frame was written");
  return String(req.id);
}

const UPLOAD = { path: "/srv/upload.bin", size: 64, overwrite: false };
const DOWNLOAD = { path: "/etc/hosts" };

afterEach(() => {
  vi.useRealTimers();
  for (const hub of hubs.splice(0)) hub.shutdown();
});

describe("agent hub", () => {
  /* --------------------------- upstream ---------------------------- */

  it("pauses an upload at STREAM_WINDOW unacknowledged chunks and resumes on ack", async () => {
    const { hub, socket } = connect();
    const handle = hub.stream(SERVER_ID, "fs.upload", UPLOAD, () => undefined);
    const id = requestId(socket);
    expect(socket.frames("req")[0]).toMatchObject({ method: "fs.upload", stream: true });

    const sends = Array.from({ length: STREAM_WINDOW + 1 }, (_, i) => handle.send(String(i)));
    let overflowSent = false;
    void sends[STREAM_WINDOW]!.then(() => {
      overflowSent = true;
    });
    await settle();

    // Seqs start at 0 and every chunk of the first window leaves at once.
    expect(socket.frames("chk").map((f) => f.seq)).toEqual(
      Array.from({ length: STREAM_WINDOW }, (_, i) => i),
    );
    expect(overflowSent).toBe(false);

    // The agent acks every half window with the seq it just took; 15
    // means "sixteen chunks are mine", exactly as Stream.acknowledge reads it.
    socket.receive({ t: "ack", id, seq: STREAM_WINDOW / 2 - 1 });
    await settle();
    expect(overflowSent).toBe(true);
    expect(socket.frames("chk").at(-1)).toMatchObject({
      seq: STREAM_WINDOW,
      data: String(STREAM_WINDOW),
      encoding: "utf8",
    });
    await Promise.all(sends);
  });

  it("pauses an upload while the socket itself is behind", async () => {
    const { hub, socket } = connect();
    const handle = hub.stream(SERVER_ID, "fs.upload", UPLOAD, () => undefined);

    socket.bufferedAmount = 4 * MAX_CHUNK_BYTES + 1;
    let sent = false;
    const pending = handle.send("x", "base64").then(() => {
      sent = true;
    });
    await settle();
    expect(sent).toBe(false);
    expect(socket.frames("chk")).toHaveLength(0);

    socket.bufferedAmount = 0;
    await pending;
    expect(socket.frames("chk")).toEqual([
      { t: "chk", id: requestId(socket), seq: 0, data: "x", encoding: "base64" },
    ]);
  });

  it("rejects a paused sender when the stream closes under it", async () => {
    const { hub, socket } = connect();
    const handle = hub.stream(SERVER_ID, "fs.upload", UPLOAD, () => undefined);
    const id = requestId(socket);

    for (let i = 0; i < STREAM_WINDOW; i += 1) void handle.send("x");
    const blocked = handle.send("y");
    await settle();

    socket.receive({
      t: "res",
      id,
      ok: false,
      error: { code: "permission_denied", message: "destination is read-only" },
    });
    await expect(blocked).rejects.toMatchObject({ agentError: { code: "permission_denied" } });
    await expect(handle.done).rejects.toMatchObject({ agentError: { code: "permission_denied" } });
    await expect(handle.send("z")).rejects.toBeInstanceOf(AgentRpcError);
    expect(hub.info(SERVER_ID)!.inFlight).toBe(0);
  });

  /* -------------------------- downstream --------------------------- */

  it("acks an inbound half window only once the consumer has drained", async () => {
    const { hub, socket } = connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const handle = hub.stream(SERVER_ID, "fs.download", DOWNLOAD, (data) => {
      seen.push(data);
      return seen.length === 1 ? gate : undefined;
    });
    const id = requestId(socket);

    for (let seq = 0; seq < STREAM_WINDOW / 2; seq += 1) {
      socket.receive({ t: "chk", id, seq, data: `c${seq}`, encoding: "utf8" });
    }
    await settle();
    // The first chunk's sink has not drained, so nothing behind it moves
    // and the agent is not invited to send more.
    expect(seen).toEqual(["c0"]);
    expect(socket.frames("ack")).toHaveLength(0);

    release();
    await settle();
    expect(seen).toHaveLength(STREAM_WINDOW / 2);
    expect(socket.frames("ack")).toEqual([{ t: "ack", id, seq: STREAM_WINDOW / 2 - 1 }]);
    handle.cancel();
  });

  it("settles done only after every chunk reached the consumer", async () => {
    const { hub, socket } = connect();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const handle = hub.stream(SERVER_ID, "fs.download", DOWNLOAD, (data) => {
      seen.push(data);
      return gate;
    });
    const id = requestId(socket);

    socket.receive({ t: "chk", id, seq: 0, data: "tail", encoding: "utf8" });
    socket.receive({ t: "res", id, ok: true, result: { name: "hosts" } });
    socket.receive({ t: "end", id, ok: true });
    let done = false;
    void handle.done.then(() => {
      done = true;
    });
    await settle();
    // The call is over as far as the table is concerned, but a download
    // must not end() its response before its last bytes were written.
    expect(hub.info(SERVER_ID)!.inFlight).toBe(0);
    expect(done).toBe(false);

    release();
    await settle();
    expect(done).toBe(true);
    expect(seen).toEqual(["tail"]);
  });

  it("cancels upstream when a chunk exceeds the frame cap", async () => {
    const { hub, socket } = connect();
    const handle = hub.stream(SERVER_ID, "fs.download", DOWNLOAD, () => undefined);
    const id = requestId(socket);

    socket.receive({ t: "chk", id, seq: 0, data: "x".repeat(MAX_CHUNK_BYTES * 2 + 1) });
    expect(socket.frames("can")).toEqual([{ t: "can", id }]);
    await expect(handle.done).rejects.toMatchObject({ agentError: { code: "internal" } });
  });

  /* ---------------------------- lifetime ---------------------------- */

  it("removes the abort listener once a call settles", async () => {
    const { hub, socket } = connect();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    const call = hub.call(SERVER_ID, "system.info", {}, { signal: controller.signal });
    const id = requestId(socket);
    expect(add).toHaveBeenCalledTimes(1);

    socket.receive({ t: "res", id, ok: true, result: { hostname: "test-01" } });
    await expect(call).resolves.toEqual({ hostname: "test-01" });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);

    // A signal that fires after the fact has nothing left to cancel.
    controller.abort();
    await settle();
    expect(socket.frames("can")).toHaveLength(0);
  });

  it("cancels a live call when its signal aborts", async () => {
    const { hub, socket } = connect();
    const controller = new AbortController();
    const call = hub.call(SERVER_ID, "system.info", {}, { signal: controller.signal });
    const id = requestId(socket);

    controller.abort();
    expect(socket.frames("can")).toEqual([{ t: "can", id }]);
    await expect(call).rejects.toMatchObject({ agentError: { code: "cancelled" } });
    expect(hub.info(SERVER_ID)!.inFlight).toBe(0);
  });

  it("cancel settles the call locally and tells the agent", async () => {
    const { hub, socket } = connect();
    const consumed: string[] = [];
    const handle = hub.stream(SERVER_ID, "fs.download", DOWNLOAD, (data) => {
      consumed.push(data);
    });
    const id = requestId(socket);

    handle.cancel("client left");
    expect(socket.frames("can")).toEqual([{ t: "can", id }]);
    expect(hub.info(SERVER_ID)!.inFlight).toBe(0);
    await expect(handle.done).rejects.toMatchObject({
      agentError: { code: "cancelled", message: expect.stringContaining("client left") },
    });

    // Whatever the agent had in flight belongs to nobody now.
    socket.receive({ t: "chk", id, seq: 0, data: "late", encoding: "utf8" });
    socket.receive({ t: "res", id, ok: true, result: {} });
    await settle();
    expect(consumed).toEqual([]);
    expect(socket.frames("ack")).toHaveLength(0);

    handle.cancel();
    expect(socket.frames("can")).toHaveLength(1);
  });

  it("clamps a deadline to what the agent enforces", () => {
    const { hub, socket } = connect();
    void hub.call(SERVER_ID, "system.info", {}, { timeoutMs: 0x7fffffff }).catch(() => undefined);
    expect(socket.frames("req")[0]).toMatchObject({ deadline_ms: MAX_DEADLINE_MS });
  });

  /* ----------------------------- hello ------------------------------ */

  it("announces a connection when hello arrives, not before", () => {
    vi.useFakeTimers();
    const { hub, socket } = newHub();
    const connected = vi.fn();
    hub.on("connected", connected);

    hub.register(SERVER_ID, socket as unknown as WebSocket, null);
    vi.advanceTimersByTime(1_000);
    expect(connected).not.toHaveBeenCalled();
    expect(hub.info(SERVER_ID)!.agentVersion).toBe("unknown");

    socket.receive(HELLO);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(connected.mock.calls[0]![1]).toMatchObject({
      agentVersion: "1.2.3",
      capabilities: ["systemd"],
      host: { hostname: "test-01" },
    });

    // Once hello is in, the no-hello timer has nothing to say.
    vi.advanceTimersByTime(20_000);
    expect(socket.closedWith).toBeNull();
    expect(hub.isConnected(SERVER_ID)).toBe(true);
  });

  it("drops a connection that never says hello", () => {
    vi.useFakeTimers();
    const { hub, socket } = newHub();
    const connected = vi.fn();
    const disconnected = vi.fn();
    hub.on("connected", connected);
    hub.on("disconnected", disconnected);

    hub.register(SERVER_ID, socket as unknown as WebSocket, null);
    vi.advanceTimersByTime(9_999);
    expect(hub.isConnected(SERVER_ID)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "no hello" });
    expect(hub.isConnected(SERVER_ID)).toBe(false);
    expect(connected).not.toHaveBeenCalled();
    expect(disconnected).toHaveBeenCalledWith(SERVER_ID);
  });
});
