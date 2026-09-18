import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, sql, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import {
  enrollmentTokens,
  jobs,
  servers,
  sessions,
  terminalSessions,
  users,
} from "@kaname/db/schema";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { bootstrap } from "./bootstrap.js";
import { Reconciler } from "./services/reconciler.js";

/* ------------------------------------------------------------------ *
 * Housekeeping. Jobs, sessions and tokens only ever grew; this pins
 * what is pruned, and — just as important — what is not.
 * ------------------------------------------------------------------ */

let handle: DbHandle;
let ctx: AppContext;
let serverId: string;
let userId: string;

const DAY = 24 * 60 * 60_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-housekeeping-test-owner",
    JOB_WORKER_ENABLED: "false",
    JOB_RETENTION_DAYS: "30",
    SESSION_RETENTION_DAYS: "7",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);

  const [server] = await handle.db
    .insert(servers)
    .values({ name: "hk-01", hostname: "hk-01.example.com", connection: "connected" })
    .returning({ id: servers.id });
  serverId = server!.id;
  const [owner] = await handle.db.select({ id: users.id }).from(users).limit(1);
  userId = owner!.id;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

async function job(
  status: "succeeded" | "failed" | "running" | "queued",
  finishedDaysAgo: number | null,
) {
  const [row] = await handle.db
    .insert(jobs)
    .values({
      type: "service.restart",
      status,
      serverId,
      finishedAt: finishedDaysAgo === null ? null : ago(finishedDaysAgo),
    })
    .returning({ id: jobs.id });
  return row!.id;
}

describe("housekeeping", () => {
  it("prunes finished jobs, dead sessions and spent tokens past their retention, and nothing else", async () => {
    const oldDone = await job("succeeded", 45);
    const oldFailed = await job("failed", 31);
    const recentDone = await job("succeeded", 2);
    const stillRunning = await job("running", null);
    const queued = await job("queued", null);
    // Its log lines go with it.
    await ctx.queue.log(oldDone, "info", "a line that should vanish");

    const [expiredSession] = await handle.db
      .insert(sessions)
      .values({ userId, tokenHash: "expired", expiresAt: ago(10) })
      .returning({ id: sessions.id });
    const [revokedSession] = await handle.db
      .insert(sessions)
      .values({
        userId,
        tokenHash: "revoked",
        expiresAt: new Date(Date.now() + DAY),
        revokedAt: ago(9),
      })
      .returning({ id: sessions.id });
    const [liveSession] = await handle.db
      .insert(sessions)
      .values({ userId, tokenHash: "live", expiresAt: new Date(Date.now() + DAY) })
      .returning({ id: sessions.id });
    const [recentlyExpired] = await handle.db
      .insert(sessions)
      .values({ userId, tokenHash: "recent", expiresAt: ago(1) })
      .returning({ id: sessions.id });

    const [unredeemed] = await handle.db
      .insert(terminalSessions)
      .values({
        serverId,
        userId,
        userName: "owner",
        ticketHash: "t1",
        posixUser: "root",
        expiresAt: ago(3),
      })
      .returning({ id: terminalSessions.id });
    const [redeemed] = await handle.db
      .insert(terminalSessions)
      .values({
        serverId,
        userId,
        userName: "owner",
        ticketHash: "t2",
        posixUser: "root",
        expiresAt: ago(3),
        startedAt: ago(3),
        endedAt: ago(3),
      })
      .returning({ id: terminalSessions.id });

    const [spentToken] = await handle.db
      .insert(enrollmentTokens)
      .values({
        tokenHash: "e1",
        serverId,
        expiresAt: ago(20),
        usedAt: ago(20),
        createdAt: ago(20),
      })
      .returning({ id: enrollmentTokens.id });
    const [freshToken] = await handle.db
      .insert(enrollmentTokens)
      .values({ tokenHash: "e2", serverId, expiresAt: new Date(Date.now() + DAY) })
      .returning({ id: enrollmentTokens.id });

    const reconciler = new Reconciler(ctx) as unknown as { housekeeping(): Promise<void> };
    await reconciler.housekeeping();

    const remainingJobs = new Set(
      (await handle.db.select({ id: jobs.id }).from(jobs)).map((row) => row.id),
    );
    expect(remainingJobs.has(oldDone)).toBe(false);
    expect(remainingJobs.has(oldFailed)).toBe(false);
    expect(remainingJobs.has(recentDone)).toBe(true);
    expect(remainingJobs.has(stillRunning)).toBe(true);
    expect(remainingJobs.has(queued)).toBe(true);
    const logs = await handle.db.execute(
      sql`select count(*)::int as n from job_logs where job_id = ${oldDone}`,
    );
    expect((logs as { rows: { n: number }[] }).rows[0]!.n).toBe(0);

    const remainingSessions = new Set(
      (await handle.db.select({ id: sessions.id }).from(sessions)).map((row) => row.id),
    );
    expect(remainingSessions.has(expiredSession!.id)).toBe(false);
    expect(remainingSessions.has(revokedSession!.id)).toBe(false);
    expect(remainingSessions.has(liveSession!.id)).toBe(true);
    // Expired, but inside the retention window: kept for the audit of who was signed in.
    expect(remainingSessions.has(recentlyExpired!.id)).toBe(true);

    const terminals = (
      await handle.db.select({ id: terminalSessions.id }).from(terminalSessions)
    ).map((row) => row.id);
    expect(terminals).not.toContain(unredeemed!.id);
    expect(terminals).toContain(redeemed!.id);

    const tokens = (await handle.db.select({ id: enrollmentTokens.id }).from(enrollmentTokens)).map(
      (row) => row.id,
    );
    expect(tokens).not.toContain(spentToken!.id);
    expect(tokens).toContain(freshToken!.id);

    // Idempotent: a second pass finds nothing more to do.
    await reconciler.housekeeping();
    expect(
      (await handle.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, recentDone))).length,
    ).toBe(1);
  });
});
