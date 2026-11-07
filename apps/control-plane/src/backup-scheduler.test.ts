import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { backupDestinations, backupRuns, backupSchedules, jobs, servers } from "@kaname/db/schema";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { bootstrap } from "./bootstrap.js";
import { BackupScheduler } from "./services/backup-scheduler.js";

/* ------------------------------------------------------------------ *
 * Backup schedules fire on their cron, exactly once per slot, from the
 * persisted next_run_at — so a restart neither loses nor repeats one.
 *
 * Time is a variable here, not something waited for: each scheduler
 * reads the clock this file hands it.
 * ------------------------------------------------------------------ */

let handle: DbHandle;
let ctx: AppContext;
let forge: string;
let edge: string;
let destination: string;

/** The test's clock. Every scheduler built below reads it. */
let clock = new Date("2026-03-10T01:00:00.000Z");
const scheduler = () => new BackupScheduler(ctx, { now: () => clock });

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-scheduler-test-owner",
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);

  const rows = await handle.db
    .insert(servers)
    .values([
      { name: "forge-01", hostname: "forge-01.example.com", enrolledAt: new Date() },
      { name: "edge-01", hostname: "edge-01.example.com", enrolledAt: new Date() },
    ])
    .returning({ id: servers.id });
  forge = rows[0]!.id;
  edge = rows[1]!.id;

  const [dest] = await handle.db
    .insert(backupDestinations)
    .values({ name: "local", kind: "local", config: { server_id: forge, path: "/var/backups" } })
    .returning({ id: backupDestinations.id });
  destination = dest!.id;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await handle.db.delete(backupRuns);
  await handle.db.delete(jobs);
  await handle.db.delete(backupSchedules);
  clock = new Date("2026-03-10T01:00:00.000Z");
});

/** A nightly 02:30 UTC schedule whose next slot is tonight's. */
async function nightly(
  name: string,
  overrides: Partial<typeof backupSchedules.$inferInsert> = {},
): Promise<string> {
  const [row] = await handle.db
    .insert(backupSchedules)
    .values({
      name,
      serverId: forge,
      destinationId: destination,
      scope: [{ kind: "files", selectors: ["/etc"] }],
      cron: "30 2 * * *",
      timezone: "UTC",
      repositoryPath: `/var/backups/${name}`,
      enabled: true,
      nextRunAt: new Date("2026-03-10T02:30:00.000Z"),
      ...overrides,
    })
    .returning({ id: backupSchedules.id });
  return row!.id;
}

async function scheduleRow(id: string) {
  const [row] = await handle.db.select().from(backupSchedules).where(eq(backupSchedules.id, id));
  return row!;
}

async function runsOf(id: string) {
  return handle.db.select().from(backupRuns).where(eq(backupRuns.scheduleId, id));
}

describe("backup scheduler", () => {
  it("does nothing before a slot, then enqueues exactly one run on the schedule's own server", async () => {
    const id = await nightly("etc nightly");

    clock = new Date("2026-03-10T02:29:59.000Z");
    expect((await scheduler().tick()).enqueued).toHaveLength(0);
    expect(await runsOf(id)).toHaveLength(0);

    clock = new Date("2026-03-10T02:30:05.000Z");
    const pass = await scheduler().tick();
    expect(pass.enqueued).toHaveLength(1);

    const [run] = await runsOf(id);
    expect(run).toMatchObject({ trigger: "scheduled", status: "queued", serverId: forge });
    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, run!.jobId!));
    expect(job).toMatchObject({
      type: "backup.run",
      serverId: forge,
      targetType: "backup_run",
      targetId: run!.id,
      createdByName: "scheduler",
      // No agent is connected in this test, so the job says so up front
      // and waits for the host instead of failing.
      blockedReason: "agent_offline",
      status: "queued",
    });
    expect(job!.params).toMatchObject({
      run_id: run!.id,
      paths: ["/etc"],
      repository: "/var/backups/etc nightly",
      tags: [`schedule:${id}`, "trigger:scheduled"],
    });

    const schedule = await scheduleRow(id);
    expect(schedule.nextRunAt?.toISOString()).toBe("2026-03-11T02:30:00.000Z");
    expect(schedule.lastRunAt?.toISOString()).toBe("2026-03-10T02:30:05.000Z");
    expect(schedule.lastRunStatus).toBe("queued");

    // Nothing was queued for any other server.
    expect(await handle.db.select().from(jobs).where(eq(jobs.serverId, edge))).toHaveLength(0);
  });

  it("survives a restart: a new scheduler on the same database does not run the slot again", async () => {
    const id = await nightly("restart-safe");
    clock = new Date("2026-03-10T02:31:00.000Z");
    await scheduler().tick();
    expect(await runsOf(id)).toHaveLength(1);

    // The same instant, a second pass and a "restarted" process.
    expect((await scheduler().tick()).enqueued).toHaveLength(0);
    clock = new Date("2026-03-10T02:45:00.000Z");
    expect((await scheduler().tick()).enqueued).toHaveLength(0);
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("never double-runs a slot when two passes race", async () => {
    const id = await nightly("raced");
    clock = new Date("2026-03-10T02:30:30.000Z");
    const [a, b] = await Promise.all([scheduler().tick(), scheduler().tick()]);
    expect(a.enqueued.length + b.enqueued.length).toBe(1);
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("collapses slots missed while down into one run, and schedules the next real one", async () => {
    const id = await nightly("missed");
    clock = new Date("2026-03-13T09:00:00.000Z");
    expect((await scheduler().tick()).enqueued).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(1);
    expect((await scheduler().tick()).enqueued).toHaveLength(0);
    expect((await scheduleRow(id)).nextRunAt?.toISOString()).toBe("2026-03-14T02:30:00.000Z");
  });

  it("does not stack runs behind a host that is offline, and resumes once it has run", async () => {
    const id = await nightly("offline host");
    clock = new Date("2026-03-10T02:30:00.000Z");
    await scheduler().tick();

    // The next night the first run is still waiting for the agent.
    clock = new Date("2026-03-11T02:30:00.000Z");
    const pass = await scheduler().tick();
    expect(pass.enqueued).toHaveLength(0);
    expect(pass.skipped).toEqual([id]);
    expect(await runsOf(id)).toHaveLength(1);
    expect((await scheduleRow(id)).nextRunAt?.toISOString()).toBe("2026-03-12T02:30:00.000Z");

    // The host came back and the run finished; the next slot fires.
    await handle.db
      .update(backupRuns)
      .set({ status: "succeeded" })
      .where(eq(backupRuns.scheduleId, id));
    clock = new Date("2026-03-12T02:30:00.000Z");
    expect((await scheduler().tick()).enqueued).toHaveLength(1);
    expect(await runsOf(id)).toHaveLength(2);
  });

  it("queues a job that is claimable straight away when the agent is connected", async () => {
    await nightly("online host");
    vi.spyOn(ctx.hub, "isConnected").mockImplementation((serverId) => serverId === forge);
    clock = new Date("2026-03-10T02:30:00.000Z");
    const [entry] = (await scheduler().tick()).enqueued;
    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, entry!.jobId));
    expect(job!.blockedReason).toBeNull();
  });

  it("follows each schedule's own server, and skips disabled schedules and revoked hosts", async () => {
    const onEdge = await nightly("on edge", { serverId: edge, repositoryPath: "sftp:edge" });
    const disabled = await nightly("disabled", { enabled: false });
    clock = new Date("2026-03-10T02:30:00.000Z");
    await scheduler().tick();

    const [edgeRun] = await runsOf(onEdge);
    expect(edgeRun!.serverId).toBe(edge);
    const [edgeJob] = await handle.db.select().from(jobs).where(eq(jobs.id, edgeRun!.jobId!));
    expect(edgeJob!.serverId).toBe(edge);
    expect(await runsOf(disabled)).toHaveLength(0);

    await handle.db.update(servers).set({ revokedAt: new Date() }).where(eq(servers.id, edge));
    try {
      clock = new Date("2026-03-11T02:30:00.000Z");
      await handle.db.update(backupRuns).set({ status: "succeeded" });
      await scheduler().tick();
      expect(await runsOf(onEdge)).toHaveLength(1);
    } finally {
      await handle.db.update(servers).set({ revokedAt: null }).where(eq(servers.id, edge));
    }
  });

  it("records a schedule that resolves to nothing as a failed run instead of retrying it forever", async () => {
    const id = await nightly("empty", { scope: [{ kind: "files", selectors: [] }] });
    clock = new Date("2026-03-10T02:30:00.000Z");
    const pass = await scheduler().tick();
    expect(pass.failed).toEqual([id]);

    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: "failed", trigger: "scheduled", jobId: null });
    expect(run!.error).toContain("resolves to nothing to back up");
    const schedule = await scheduleRow(id);
    expect(schedule.lastRunStatus).toBe("failed");
    expect(schedule.nextRunAt?.toISOString()).toBe("2026-03-11T02:30:00.000Z");
    expect((await scheduler().tick()).failed).toHaveLength(0);
  });

  it("walks the schedule's own time zone", async () => {
    // 02:30 in Berlin is 01:30 UTC in March, before the clocks change.
    const id = await nightly("berlin", {
      timezone: "Europe/Berlin",
      nextRunAt: new Date("2026-03-10T01:30:00.000Z"),
    });
    clock = new Date("2026-03-10T01:30:00.000Z");
    await scheduler().tick();
    expect(await runsOf(id)).toHaveLength(1);
    expect((await scheduleRow(id)).nextRunAt?.toISOString()).toBe("2026-03-11T01:30:00.000Z");
  });
});
