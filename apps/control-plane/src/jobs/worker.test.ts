import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { jobs } from "@kaname/db/schema";
import { loadConfig, resetConfigForTests } from "../config.js";
import { createContext, type AppContext } from "../context.js";
import { bootstrap } from "../bootstrap.js";
import type { StreamEvent } from "../services/events.js";

/* ------------------------------------------------------------------ *
 * The worker's shutdown contract: a job the control plane itself cut
 * off is not a job that failed. Idempotent work goes back to the queue
 * with its attempt refunded; non-idempotent work is failed with a
 * reason that says a person should look before retrying.
 * ------------------------------------------------------------------ */

let handle: DbHandle;
let ctx: AppContext;

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-worker-test-owner",
    JOB_WORKER_ENABLED: "true",
    JOB_POLL_MS: "40",
    JOB_WORKER_CONCURRENCY: "4",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

/** A handler that runs until the worker aborts it, like an RPC in flight. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

async function status(id: string) {
  const [row] = await handle.db
    .select({ status: jobs.status, attempt: jobs.attempt, error: jobs.error })
    .from(jobs)
    .where(eq(jobs.id, id));
  return row!;
}

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met in time");
}

describe("job worker shutdown", () => {
  it("requeues an idempotent job and fails a non-idempotent one honestly", async () => {
    const seen: StreamEvent[] = [];
    ctx.events.on("jobs", (event) => seen.push(event));

    ctx.worker.register("service.restart", (job) => untilAborted(job.signal));
    ctx.worker.register("mail.mailbox.create", (job) => untilAborted(job.signal));

    // No server: claimable without a connected agent.
    const restart = await ctx.queue.enqueue({ type: "service.restart", serverId: null });
    const create = await ctx.queue.enqueue({ type: "mail.mailbox.create", serverId: null });

    ctx.worker.start();
    await waitFor(
      async () =>
        (await status(restart.id)).status === "running" &&
        (await status(create.id)).status === "running",
    );

    await ctx.worker.stop();
    await waitFor(async () => (await status(restart.id)).status !== "running");
    await waitFor(async () => (await status(create.id)).status !== "running");

    const requeued = await status(restart.id);
    expect(requeued.status).toBe("queued");
    // The attempt the claim charged is handed back.
    expect(requeued.attempt).toBe(0);

    const failed = await status(create.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("interrupted");
    expect(failed.error?.message).toContain("restarted");

    const types = seen.map((event) => event.type);
    expect(types).toContain("job.started");
    expect(types).toContain("job.queued");
    expect(types).toContain("job.failed");
    expect(types).not.toContain("job.retrying");
  });
});
