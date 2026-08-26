import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { AGENT_SUBPROTOCOL } from "@kaname/contract/agent";
import type { AppContext } from "./context.js";
import { registerRequestContext } from "./http/plugin.js";
import { registerAgentRoutes } from "./agent/routes.js";
import { registerDistributionRoutes } from "./agent/distribution.js";
import { registerApiRoutes } from "./routes/index.js";

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // loggerInstance, not logger: Fastify 5 reserves `logger` for a
    // configuration object and rejects an already-built pino instance.
    // Widened to FastifyBaseLogger so the instance keeps its default
    // generics and route modules can be typed as a plain FastifyInstance.
    loggerInstance: ctx.log as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 32 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    // The UI is served by Next on its own origin; CSP belongs there.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: ctx.config.isDevelopment ? true : [ctx.config.KANAME_PUBLIC_URL],
    credentials: true,
  });

  await app.register(cookie, { parseOptions: { httpOnly: true, sameSite: "lax", path: "/" } });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 } });
  await app.register(websocket, {
    options: {
      maxPayload: 4 * 1024 * 1024,
      // A client that offers a subprotocol expects the server to select
      // one; agents offer exactly ours, the terminal offers none.
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(AGENT_SUBPROTOCOL) ? AGENT_SUBPROTOCOL : false,
    },
  });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.principal?.id ?? req.ip,
  });

  await registerRequestContext(app, ctx);

  app.get("/health", async () => ({
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    agents_connected: ctx.hub.connectedServerIds().length,
    subscribers: ctx.events.subscriberCount,
    driver: ctx.dbHandle.driver,
  }));

  await registerAgentRoutes(app, ctx);
  await registerDistributionRoutes(app, ctx);
  await app.register(registerApiRoutes, { prefix: "/api/v1" });

  return app;
}
