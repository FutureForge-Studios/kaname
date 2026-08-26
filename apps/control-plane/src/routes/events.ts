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

    const topicSet = new Set(topics);
    const write = (payload: {
      id: string;
      topic: string;
      type: string;
      ts: string;
      data: unknown;
    }) => {
      reply.raw.write(
        `id: ${payload.id}\nevent: ${payload.topic}\ndata: ${JSON.stringify(payload)}\n\n`,
      );
    };

    // Replay anything missed across a reconnect before going live.
    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? null;
    for (const missed of req.ctx.events.replaySince(lastEventId, topicSet)) {
      write(missed);
    }

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
    });

    const keepalive = setInterval(() => reply.raw.write(`: keepalive\n\n`), KEEPALIVE_MS);
    keepalive.unref?.();

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
