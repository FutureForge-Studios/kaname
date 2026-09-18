import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ *
 * The event bus behind GET /api/v1/events (SSE).
 *
 * SSE rather than WebSocket because this feed is one-way and the
 * browser reconnects for free — which matters when the thing being
 * watched is a job that outlives a page navigation. The only
 * WebSocket in the product is the terminal.
 * ------------------------------------------------------------------ */

export const EVENT_TOPICS = [
  "jobs",
  "servers",
  "services",
  "containers",
  "threats",
  "alerts",
  "deployments",
  "certificates",
  "backups",
  "audit",
  "metrics",
  "updates",
] as const;
export type EventTopic = (typeof EVENT_TOPICS)[number];

export interface StreamEvent {
  id: string;
  topic: EventTopic;
  type: string;
  ts: string;
  /** Null means fleet-wide; used to filter by a subscriber's scope. */
  serverId: string | null;
  data: unknown;
}

export interface Subscriber {
  id: string;
  topics: Set<EventTopic>;
  /** Server ids this subscriber may see, or "global". */
  scope: "global" | Set<string>;
  send(event: StreamEvent): void;
  /** Ends the transport cleanly; called on shutdown so clients reconnect. */
  close?(): void;
}

export class EventBus extends EventEmitter {
  private readonly subscribers = new Map<string, Subscriber>();
  /** Small replay ring so a reconnecting client does not miss a transition. */
  private readonly recent: StreamEvent[] = [];
  private static readonly REPLAY_SIZE = 200;

  /** Returns the event id, which is what a client presents as `Last-Event-ID`. */
  publish(topic: EventTopic, type: string, data: unknown, serverId: string | null = null): string {
    const event: StreamEvent = {
      id: randomUUID(),
      topic,
      type,
      ts: new Date().toISOString(),
      serverId,
      data,
    };

    this.recent.push(event);
    if (this.recent.length > EventBus.REPLAY_SIZE) this.recent.shift();

    for (const sub of this.subscribers.values()) {
      if (!sub.topics.has(topic)) continue;
      if (serverId && sub.scope !== "global" && !sub.scope.has(serverId)) continue;
      try {
        sub.send(event);
      } catch {
        this.subscribers.delete(sub.id);
      }
    }

    this.emit(topic, event);
    return event.id;
  }

  subscribe(sub: Omit<Subscriber, "id">): { id: string; unsubscribe: () => void } {
    const id = randomUUID();
    this.subscribers.set(id, { ...sub, id });
    return { id, unsubscribe: () => this.subscribers.delete(id) };
  }

  /**
   * Events since a given id, for `Last-Event-ID` reconnects. Filtered
   * by the same scope as live delivery: a reconnect must not be the one
   * moment a server-scoped role sees the rest of the fleet.
   */
  replaySince(
    lastEventId: string | null,
    topics: Set<EventTopic>,
    scope: "global" | Set<string> = "global",
  ): StreamEvent[] {
    if (!lastEventId) return [];
    const idx = this.recent.findIndex((e) => e.id === lastEventId);
    if (idx < 0) return [];
    return this.recent
      .slice(idx + 1)
      .filter(
        (e) => topics.has(e.topic) && (!e.serverId || scope === "global" || scope.has(e.serverId)),
      );
  }

  /** Ends every open stream. Clients reconnect after `retry:` and replay what they missed. */
  closeAll(): void {
    for (const sub of this.subscribers.values()) {
      try {
        sub.close?.();
      } catch {
        /* the socket was already gone */
      }
    }
    this.subscribers.clear();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
