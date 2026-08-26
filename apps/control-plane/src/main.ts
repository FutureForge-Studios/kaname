import pino from "pino";
import { createDb } from "@kaname/db";
import { runMigrations } from "@kaname/db/migrate";
import { loadConfig, loadEnvFile } from "./config.js";
import { createContext } from "./context.js";
import { buildServer } from "./server.js";
import { Reconciler } from "./services/reconciler.js";
import { registerJobHandlers } from "./jobs/handlers.js";
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  const config = loadConfig();

  const log = pino({
    level: config.LOG_LEVEL,
    ...(config.LOG_PRETTY || config.isDevelopment
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        }
      : {}),
  });

  log.info(
    { env: config.KANAME_ENV, driver: config.DATABASE_URL.split(":")[0], envFile },
    "kaname control plane starting",
  );

  await runMigrations(config.DATABASE_URL);

  const dbHandle = await createDb(config.DATABASE_URL);
  const ctx = createContext({ config, log, dbHandle });

  // The CA must exist before any agent can enroll.
  await ctx.ca.load();
  await bootstrap(ctx);

  // Before anything is served: an update started by the previous
  // process can only be judged by the one that came back.
  await ctx.updates.reconcile();
  ctx.updates.start();

  registerJobHandlers(ctx.worker);
  ctx.worker.start();

  const reconciler = new Reconciler(ctx);
  reconciler.start();

  const app = await buildServer(ctx);
  await app.listen({ port: config.PORT, host: config.HOST });
  log.info({ port: config.PORT }, "control plane listening");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    reconciler.stop();
    ctx.updates.stop();
    ctx.hub.shutdown();
    await ctx.worker.stop();
    await app.close();
    await dbHandle.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandled rejection"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
