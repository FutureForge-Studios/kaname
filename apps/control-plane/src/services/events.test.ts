import { describe, expect, it } from "vitest";
import { EventBus, type StreamEvent } from "./events.js";

/* ------------------------------------------------------------------ *
 * The event bus: replay honours scope, and closeAll ends every stream.
 * ------------------------------------------------------------------ */

function collect(bus: EventBus, scope: "global" | Set<string>) {
  const seen: StreamEvent[] = [];
  let closed = 0;
  const sub = bus.subscribe({
    topics: new Set(["jobs", "servers"]),
    scope,
    send: (event) => seen.push(event),
    close: () => {
      closed += 1;
    },
  });
  return { seen, closedCount: () => closed, sub };
}

describe("EventBus", () => {
  it("replays only what a server-scoped subscriber may see", () => {
    const bus = new EventBus();
    bus.publish("jobs", "job.started", { n: 1 }, "server-a");
    const anchor = bus.publish("jobs", "job.started", { n: 2 }, "server-b");
    bus.publish("jobs", "job.log", { n: 3 }, "server-a");
    bus.publish("jobs", "job.log", { n: 4 }, "server-b");
    bus.publish("servers", "server.connected", { n: 5 }, null);
    bus.publish("audit", "user.updated", { n: 6 }, null);

    const topics = new Set<"jobs" | "servers" | "audit">(["jobs", "servers"]);
    const scoped = bus.replaySince(anchor, topics, new Set(["server-a"]));
    expect(scoped.map((e) => (e.data as { n: number }).n)).toEqual([3, 5]);

    const global = bus.replaySince(anchor, topics, "global");
    expect(global.map((e) => (e.data as { n: number }).n)).toEqual([3, 4, 5]);

    expect(bus.replaySince("not-an-id", topics, "global")).toEqual([]);
    expect(bus.replaySince(null, topics, "global")).toEqual([]);
  });

  it("delivers live events by scope and closes every subscriber on shutdown", () => {
    const bus = new EventBus();
    const a = collect(bus, new Set(["server-a"]));
    const everyone = collect(bus, "global");

    bus.publish("jobs", "job.started", {}, "server-a");
    bus.publish("jobs", "job.started", {}, "server-b");
    bus.publish("servers", "server.connected", {}, null);

    expect(a.seen).toHaveLength(2);
    expect(everyone.seen).toHaveLength(3);
    expect(bus.subscriberCount).toBe(2);

    bus.closeAll();
    expect(a.closedCount()).toBe(1);
    expect(everyone.closedCount()).toBe(1);
    expect(bus.subscriberCount).toBe(0);

    // Nothing reaches a closed subscriber.
    bus.publish("jobs", "job.started", {}, "server-a");
    expect(a.seen).toHaveLength(2);
  });

  it("drops a subscriber whose send throws", () => {
    const bus = new EventBus();
    bus.subscribe({
      topics: new Set(["jobs"]),
      scope: "global",
      send: () => {
        throw new Error("socket gone");
      },
    });
    expect(bus.subscriberCount).toBe(1);
    bus.publish("jobs", "job.started", {}, null);
    expect(bus.subscriberCount).toBe(0);
  });
});
