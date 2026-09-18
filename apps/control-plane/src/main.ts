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

  // Listens to the same bus the panel does, so anything worth a page in
  // the UI can also be an email, a webhook or a Slack message. Started
  // first: the update check below may have something to say.
  ctx.notifications.start();

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

  // Only now is an update that brought this build up a success: booting
  // and answering are not the same thing, and a build that died between
  // the two would otherwise have been filed as succeeded already.
  await ctx.updates.confirmBooted();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");

    // Compose gives a container ten seconds by default; whatever has
    // not finished by then is lost to SIGKILL anyway, so exit on our own
    // terms first and say so.
    const deadline = setTimeout(() => {
      log.error("shutdown did not finish in time; exiting");
      process.exit(1);
    }, 8_000);
    deadline.unref?.();

    reconciler.stop();
    ctx.updates.stop();
    ctx.notifications.stop();
    // Jobs first, while their agent sockets are still up: a handler that
    // is interrupted can then be requeued or marked honestly, instead of
    // every in-flight RPC being rejected as "connection lost".
    await ctx.worker.stop();
    ctx.hub.shutdown();
    // Tell every open event stream to reconnect rather than holding the
    // HTTP server open.
    ctx.events.closeAll();
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
