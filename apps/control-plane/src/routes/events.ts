import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EVENT_TOPICS, type EventTopic } from "../services/events.js";
import { helpers, parseQuery } from "../http/plugin.js";
import { unauthenticated } from "../lib/errors.js";

/* ------------------------------------------------------------------ *
 * GET /api/v1/events — one multiplexed SSE stream for the whole UI.
 *
 * A subscriber only ever receives events for servers it is scoped to,
 * so a Developer role watching the job feed cannot learn about hosts it
 * has no permission to see.
 * ------------------------------------------------------------------ */

const query = z.object({
  topics: z
    .string()
    .optional()
    .transform((s) =>
      (s ? s.split(",") : [...EVENT_TOPICS])
        .map((t) => t.trim())
        .filter((t): t is EventTopic => (EVENT_TOPICS as readonly string[]).includes(t)),
    ),
});

const KEEPALIVE_MS = 20_000;
/**
 * Bytes a subscriber may fall behind before it is dropped. A peer that
 * vanished without a FIN never drains; letting it reconnect with
 * Last-Event-ID costs a bounded replay instead of an unbounded buffer.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/events", async (req, reply) => {
    const { topics } = parseQuery(req, query);
    const h = helpers(req);
    const principal = h.requirePrincipal();
    if (!principal) throw unauthenticated();

    const readScope = req.ctx.auth.scope(principal, "infra.servers:read");
    const scope: "global" | Set<string> =
      readScope === "global" ? "global" : new Set(readScope ?? []);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers SSE by default and makes the feed look broken.
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`retry: 3000\n\n`);
    // Node does not enable TCP keepalive on accepted sockets; without it a
    // suspended laptop or a NAT timeout is a subscriber that never leaves.
    req.raw.socket.setKeepAlive(true, 30_000);

    const topicSet = new Set(topics);
    const write = (payload: {
      id: string;
      topic: string;
      type: string;
      ts: string;
      data: unknown;
    }) => {
      if (reply.raw.destroyed) return;
      if (reply.raw.writableLength > MAX_BUFFERED_BYTES) {
        req.log.warn({ buffered: reply.raw.writableLength }, "dropping slow event subscriber");
        req.raw.destroy();
        return;
      }
      reply.raw.write(
        `id: ${payload.id}\nevent: ${payload.topic}\ndata: ${JSON.stringify(payload)}\n\n`,
      );
    };

    // Replay anything missed across a reconnect before going live.
    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? null;
    for (const missed of req.ctx.events.replaySince(lastEventId, topicSet, scope)) {
      write(missed);
    }

    const keepalive = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableNeedDrain) return;
      reply.raw.write(`: keepalive\n\n`);
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    const sub = req.ctx.events.subscribe({
      topics: topicSet,
      scope,
      send: (event) =>
        write({
          id: event.id,
          topic: event.topic,
          type: event.type,
          ts: event.ts,
          data: event.data,
        }),
      close: () => {
        clearInterval(keepalive);
        if (!reply.raw.destroyed) reply.raw.end();
      },
    });

    const close = () => {
      clearInterval(keepalive);
      sub.unsubscribe();
    };
    req.raw.on("close", close);
    req.raw.on("error", close);

    // Never resolves: the reply is owned by the stream until the client leaves.
    return reply;
  });
}
