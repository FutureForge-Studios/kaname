import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, eq, sql, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { jobs, servers } from "@kaname/db/schema";
import { JobQueue } from "./queue.js";

/* ------------------------------------------------------------------ *
 * The queue's contract (KD-003, KD-008):
 *   - two workers never claim the same job
 *   - a worker that dies releases its job instead of losing it
 *   - a job whose host is unreachable waits rather than failing
 * ------------------------------------------------------------------ */

let handle: DbHandle;
let queue: JobQueue;
let serverId: string;

beforeEach(async () => {
  handle = await createDb("pglite://:memory:");
  await migrateHandle(handle);
  queue = new JobQueue(handle.db);

  const [row] = await handle.db
    .insert(servers)
    .values({ name: "test-01", hostname: "test-01.example.com", connection: "connected" })
    .returning({ id: servers.id });
  serverId = row!.id;
});

afterEach(async () => {
  await handle.close();
});

describe("job queue", () => {
  it("enqueues with the spec's retry policy and timeout", async () => {
    const job = await queue.enqueue({
      type: "service.restart",
      serverId,
      params: { unit: "nginx.service" },
    });

    expect(job.status).toBe("queued");
    expect(job.max_attempts).toBe(2); // service.restart is idempotent
    expect(job.label).toBe("Restart service");

    const nonIdempotent = await queue.enqueue({ type: "mail.mailbox.create", serverId });
    expect(nonIdempotent.max_attempts).toBe(1);
  });

  it("hands one job to exactly one claimer", async () => {
    await queue.enqueue({ type: "service.restart", serverId, params: { unit: "a" } });

    const [first, second] = await Promise.all([
      queue.claim("worker-1", 60, [serverId]),
      queue.claim("worker-2", 60, [serverId]),
    ]);

    const claimed = [first, second].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.attempt).toBe(1);

    // The claim is raw SQL, so its snake_case columns have to be mapped
    // back into the Drizzle shape. Handlers read these; if they come
    // back undefined every job fails with "requires a server".
    const job = claimed[0]!;
    expect(job.serverId).toBe(serverId);
    expect(job.type).toBe("service.restart");
    expect(job.params).toEqual({ unit: "a" });
    expect(job.maxAttempts).toBe(2);
    expect(job.timeoutMs).toBeGreaterThan(0);
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(job.leaseUntil).toBeInstanceOf(Date);
  });

  it("respects priority then age", async () => {
    await queue.enqueue({ type: "service.restart", serverId, params: { unit: "old" } });
    await queue.enqueue({
      type: "service.restart",
      serverId,
      params: { unit: "urgent" },
      priority: 10,
    });

    const claimed = await queue.claim("worker-1", 60, [serverId]);
    expect((claimed!.params as { unit: string }).unit).toBe("urgent");
    expect(claimed!.priority).toBe(10);
  });

  it("skips jobs whose server has no connected agent", async () => {
    await queue.enqueue({ type: "service.restart", serverId, params: { unit: "a" } });

    expect(await queue.claim("worker-1", 60, [])).toBeNull();
    expect(await queue.claim("worker-1", 60, [serverId])).not.toBeNull();
  });

  it("does not claim a job before its run_after", async () => {
    await queue.enqueue({ type: "service.restart", serverId, runAfterMs: 60_000 });
    expect(await queue.claim("worker-1", 60, [serverId])).toBeNull();
  });

  it("returns a job to the queue when its lease expires", async () => {
    await queue.enqueue({ type: "service.restart", serverId, params: { unit: "a" } });
    const claimed = await queue.claim("worker-1", 60, [serverId]);
    expect(claimed).not.toBeNull();

    // Simulate the worker dying mid-job.
    await handle.db.execute(sql`update jobs set lease_until = now() - interval '1 minute';`);
    const reaped = await queue.reapExpiredLeases();
    expect(reaped).toBe(1);

    const again = await queue.claim("worker-2", 60, [serverId]);
    expect(again!.id).toBe(claimed!.id);
    expect(again!.attempt).toBe(2);
  });

  it("fails a job for good once it is out of attempts", async () => {
    const job = await queue.enqueue({ type: "mail.mailbox.create", serverId });
    await queue.claim("worker-1", 60, [serverId]);

    await handle.db.execute(sql`update jobs set lease_until = now() - interval '1 minute';`);
    await queue.reapExpiredLeases();

    const after = await queue.get(job.id);
    expect(after!.status).toBe("failed");
    expect(after!.error?.code).toBe("lease_expired");
  });

  it("blocking does not consume an attempt", async () => {
    const job = await queue.enqueue({ type: "service.restart", serverId });
    await queue.claim("worker-1", 60, [serverId]);
    await queue.block(job.id, "agent_offline", 0);

    const after = await queue.get(job.id);
    expect(after!.status).toBe("queued");
    expect(after!.blocked_reason).toBe("agent_offline");
    expect(after!.attempt).toBe(0);
  });

  it("expires a job whose agent never came back", async () => {
    const job = await queue.enqueue({ type: "service.restart", serverId, expiresInMs: -1000 });
    expect(await queue.claim("worker-1", 60, [serverId])).toBeNull();

    expect(await queue.expireStale()).toBe(1);
    expect((await queue.get(job.id))!.status).toBe("timed_out");
  });

  it("records completion with a duration", async () => {
    const job = await queue.enqueue({ type: "service.restart", serverId });
    await queue.claim("worker-1", 60, [serverId]);
    await queue.complete(job.id, { ok: true });

    const after = await queue.get(job.id);
    expect(after!.status).toBe("succeeded");
    expect(after!.progress).toBe(100);
    expect(after!.finished_at).not.toBeNull();
    expect(after!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("only cancels jobs that are still in flight", async () => {
    const job = await queue.enqueue({ type: "service.restart", serverId });
    expect(await queue.cancel(job.id)).toBe(true);
    expect(await queue.cancel(job.id)).toBe(false);
    expect((await queue.get(job.id))!.status).toBe("cancelled");
  });

  it("groups a fan-out under one correlation id", async () => {
    const { correlationId, jobs: created } = await queue.enqueueMany([
      { type: "service.restart", serverId, params: { unit: "a" } },
      { type: "service.restart", serverId, params: { unit: "b" } },
    ]);

    expect(created).toHaveLength(2);
    expect(created.every((j) => j.correlation_id === correlationId)).toBe(true);

    const rows = await handle.db.select().from(jobs).where(eq(jobs.correlationId, correlationId));
    expect(rows).toHaveLength(2);
  });

  it("streams job log lines in order", async () => {
    const job = await queue.enqueue({ type: "service.restart", serverId });
    await queue.log(job.id, "info", "first");
    await queue.log(job.id, "warn", "second");

    const rows = await handle.db.execute(
      sql`select message from job_logs where job_id = ${job.id} order by seq`,
    );
    const messages = ((rows as { rows?: { message: string }[] }).rows ?? []).map((r) => r.message);
    expect(messages).toEqual(["first", "second"]);
  });
});
