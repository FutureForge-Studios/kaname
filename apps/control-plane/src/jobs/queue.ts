import { and, eq, inArray, isNull, lte, or, sql, type Database } from "@kaname/db";
import { jobLogs, jobs, servers } from "@kaname/db/schema";
import { JOB_SPECS, type Job, type JobStatus, type JobType } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * The job queue (KD-003, KD-008).
 *
 * Postgres-backed with FOR UPDATE SKIP LOCKED. One fewer daemon to
 * self-host than Redis, and the job lands in the same transaction as
 * the state change that created it — no "row written, enqueue failed"
 * split brain.
 * ------------------------------------------------------------------ */

export interface EnqueueInput {
  type: JobType;
  serverId?: string | null;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  params?: Record<string, unknown>;
  priority?: number;
  correlationId?: string;
  parentId?: string;
  createdBy?: string | null;
  createdByName?: string | null;
  /** Delay before the job becomes claimable. */
  runAfterMs?: number;
  /** Give up entirely after this long, even if the agent never returns. */
  expiresInMs?: number;
}

export class JobQueue {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueInput): Promise<Job> {
    const spec = JOB_SPECS[input.type];
    const now = Date.now();

    const [row] = await this.db
      .insert(jobs)
      .values({
        type: input.type,
        status: "queued",
        serverId: input.serverId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        params: input.params ?? {},
        priority: input.priority ?? 0,
        maxAttempts: spec.maxAttempts,
        timeoutMs: spec.timeoutMs,
        correlationId: input.correlationId ?? null,
        parentId: input.parentId ?? null,
        createdBy: input.createdBy ?? null,
        createdByName: input.createdByName ?? null,
        runAfter: new Date(now + (input.runAfterMs ?? 0)),
        // Default: a job that cannot reach its host within 24h is dead.
        expiresAt: new Date(now + (input.expiresInMs ?? 24 * 60 * 60 * 1000)),
      })
      .returning();

    if (!row) throw new Error("failed to enqueue job");
    return this.toApi(row, null);
  }

  /** Fan one operator action across N servers under a shared correlation id. */
  async enqueueMany(
    inputs: EnqueueInput[],
    correlationId = crypto.randomUUID(),
  ): Promise<{ correlationId: string; jobs: Job[] }> {
    const created: Job[] = [];
    for (const input of inputs) {
      created.push(await this.enqueue({ ...input, correlationId }));
    }
    return { correlationId, jobs: created };
  }

  /**
   * Claim one job. SKIP LOCKED means N workers never fight over the same
   * row, and the lease means a worker that dies mid-job releases it.
   */
  async claim(
    owner: string,
    leaseSeconds: number,
    connectedServerIds: string[],
  ): Promise<ClaimedJob | null> {
    // A job whose server has no live agent stays queued rather than
    // burning an attempt — it will be picked up on reconnect.
    const serverFilter =
      connectedServerIds.length > 0
        ? sql`(j.server_id is null or j.server_id = any(${sql.raw(`ARRAY[${connectedServerIds.map((id) => `'${id}'::uuid`).join(",")}]`)}))`
        : sql`j.server_id is null`;

    const result = await this.db.execute(sql`
      update jobs set
        status = 'running',
        attempt = attempt + 1,
        started_at = coalesce(started_at, now()),
        lease_until = now() + ${sql.raw(`interval '${leaseSeconds} seconds'`)},
        lease_owner = ${owner},
        blocked_reason = null,
        updated_at = now()
      where id = (
        select j.id from jobs j
        where j.status = 'queued'
          and j.run_after <= now()
          and (j.expires_at is null or j.expires_at > now())
          and ${serverFilter}
        order by j.priority desc, j.created_at
        for update skip locked
        limit 1
      )
      returning *;
    `);

    const row = firstRow(result);
    return row ? toClaimedJob(row) : null;
  }

  /** Renew the lease while an RPC is still in flight. */
  async heartbeat(jobId: string, owner: string, leaseSeconds: number): Promise<void> {
    await this.db.execute(sql`
      update jobs
      set lease_until = now() + ${sql.raw(`interval '${leaseSeconds} seconds'`)}
      where id = ${jobId} and lease_owner = ${owner} and status = 'running';
    `);
  }

  /** Return jobs whose worker died to the queue. Run on an interval. */
  async reapExpiredLeases(): Promise<number> {
    const result = await this.db.execute(sql`
      update jobs set
        status = case when attempt >= max_attempts then 'failed' else 'queued' end,
        error = case when attempt >= max_attempts
          then jsonb_build_object('code', 'lease_expired', 'message', 'worker did not report back')
          else error end,
        finished_at = case when attempt >= max_attempts then now() else finished_at end,
        lease_until = null,
        lease_owner = null,
        updated_at = now()
      where status = 'running' and lease_until < now()
      returning id;
    `);
    return rowCount(result);
  }

  /** Fail jobs that outlived their expiry without ever running. */
  async expireStale(): Promise<number> {
    const result = await this.db.execute(sql`
      update jobs set
        status = 'timed_out',
        error = jsonb_build_object('code', 'expired', 'message', 'the target agent never came back online'),
        finished_at = now(),
        updated_at = now()
      where status = 'queued' and expires_at is not null and expires_at < now()
      returning id;
    `);
    return rowCount(result);
  }

  async complete(jobId: string, result: unknown): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: "succeeded",
        result: result ?? null,
        progress: 100,
        finishedAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
        updatedAt: new Date(),
        durationMs: sql`extract(epoch from (now() - coalesce(started_at, created_at))) * 1000`,
      })
      .where(eq(jobs.id, jobId));
  }

  async fail(
    jobId: string,
    error: { code: string; message: string; detail?: unknown },
    opts: { retry: boolean; retryDelayMs?: number } = { retry: false },
  ): Promise<void> {
    if (opts.retry) {
      await this.db
        .update(jobs)
        .set({
          status: "queued",
          error,
          leaseUntil: null,
          leaseOwner: null,
          runAfter: new Date(Date.now() + (opts.retryDelayMs ?? 5_000)),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, jobId));
      return;
    }

    await this.db
      .update(jobs)
      .set({
        status: "failed",
        error,
        finishedAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
        updatedAt: new Date(),
        durationMs: sql`extract(epoch from (now() - coalesce(started_at, created_at))) * 1000`,
      })
      .where(eq(jobs.id, jobId));
  }

  /** Park a job because its host is unreachable. Does not consume an attempt. */
  async block(jobId: string, reason: string, retryInMs = 15_000): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: "queued",
        blockedReason: reason,
        attempt: sql`greatest(attempt - 1, 0)`,
        leaseUntil: null,
        leaseOwner: null,
        runAfter: new Date(Date.now() + retryInMs),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
  }

  async cancel(jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running"])))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  async setProgress(jobId: string, progress: number): Promise<void> {
    await this.db
      .update(jobs)
      .set({ progress: Math.max(0, Math.min(100, progress)), updatedAt: new Date() })
      .where(eq(jobs.id, jobId));
  }

  async log(
    jobId: string,
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): Promise<void> {
    await this.db.insert(jobLogs).values({ jobId, level, message: message.slice(0, 8192) });
  }

  async get(jobId: string): Promise<Job | null> {
    const rows = await this.db
      .select({ job: jobs, serverName: servers.name })
      .from(jobs)
      .leftJoin(servers, eq(jobs.serverId, servers.id))
      .where(eq(jobs.id, jobId))
      .limit(1);
    const row = rows[0];
    return row ? this.toApi(row.job, row.serverName) : null;
  }

  toApi(row: typeof jobs.$inferSelect, serverName: string | null): Job {
    return {
      id: row.id,
      type: row.type,
      label: JOB_SPECS[row.type]?.label ?? row.type,
      status: row.status,
      server_id: row.serverId,
      server_name: serverName,
      target_type: row.targetType,
      target_id: row.targetId,
      target_label: row.targetLabel,
      progress: row.progress ?? null,
      blocked_reason: (row.blockedReason as Job["blocked_reason"]) ?? null,
      attempt: row.attempt,
      max_attempts: row.maxAttempts,
      correlation_id: row.correlationId,
      parent_id: row.parentId,
      child_count: 0,
      error: row.error ?? null,
      result: row.result ?? null,
      created_by: row.createdBy,
      created_by_name: row.createdByName,
      created_at: row.createdAt.toISOString(),
      started_at: row.startedAt?.toISOString() ?? null,
      finished_at: row.finishedAt?.toISOString() ?? null,
      duration_ms: row.durationMs,
    };
  }
}

export type ClaimedJob = typeof jobs.$inferSelect;

/**
 * The claim runs as raw SQL for FOR UPDATE SKIP LOCKED, so its columns
 * come back in the database's snake_case rather than Drizzle's
 * camelCase. Casting the row straight to ClaimedJob type-checks and is
 * wrong: every camelCase field reads as undefined, which showed up as
 * handlers insisting a job "requires a server" while looking at a row
 * that plainly had one.
 */
function toClaimedJob(row: Record<string, unknown>): ClaimedJob {
  const date = (v: unknown): Date | null =>
    v == null ? null : v instanceof Date ? v : new Date(String(v));
  const num = (v: unknown): number => (v == null ? 0 : Number(v));

  return {
    id: String(row.id),
    type: row.type as ClaimedJob["type"],
    status: row.status as ClaimedJob["status"],
    serverId: (row.server_id as string | null) ?? null,
    targetType: (row.target_type as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    targetLabel: (row.target_label as string | null) ?? null,
    params: (row.params as Record<string, unknown>) ?? {},
    result: row.result ?? null,
    error: (row.error as ClaimedJob["error"]) ?? null,
    progress: row.progress == null ? null : Number(row.progress),
    blockedReason: (row.blocked_reason as string | null) ?? null,
    priority: num(row.priority),
    attempt: num(row.attempt),
    maxAttempts: num(row.max_attempts),
    timeoutMs: num(row.timeout_ms),
    correlationId: (row.correlation_id as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    runAfter: date(row.run_after) ?? new Date(),
    leaseUntil: date(row.lease_until),
    leaseOwner: (row.lease_owner as string | null) ?? null,
    expiresAt: date(row.expires_at),
    createdBy: (row.created_by as string | null) ?? null,
    createdByName: (row.created_by_name as string | null) ?? null,
    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: date(row.created_at) ?? new Date(),
    updatedAt: date(row.updated_at) ?? new Date(),
  };
}

/* Drizzle's execute() returns a driver-shaped result; normalise it. */
function firstRow(result: unknown): Record<string, unknown> | null {
  const rows = (result as { rows?: unknown[] })?.rows ?? (result as unknown[]);
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
}

function rowCount(result: unknown): number {
  const rows = (result as { rows?: unknown[] })?.rows ?? (result as unknown[]);
  return Array.isArray(rows) ? rows.length : 0;
}

export const TERMINAL: readonly JobStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];
