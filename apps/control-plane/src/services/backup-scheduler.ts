import { and, eq, inArray, isNull, lte, sql, type Database } from "@kaname/db";
import { backupRuns, backupSchedules, dbDatabases, servers } from "@kaname/db/schema";
import type { BackupScope } from "@kaname/contract";
import type { AppContext } from "../context.js";
import { computeNextRun } from "../lib/cron.js";
import { ApiException, badRequest } from "../lib/errors.js";
import { JobQueue } from "../jobs/queue.js";
import { planAppScope, type AppBackupPlanEntry } from "./app-backup-plan.js";
import { ensureSchedulePassword } from "./backup-secrets.js";

/* ------------------------------------------------------------------ *
 * Backup scheduler.
 *
 * A schedule's cron used to be decorative: next_run_at was computed and
 * shown, and nothing ever acted on it, so only "Run now" backed anything
 * up. This is the loop that does, shaped like the alert evaluator: a
 * timer that calls one pass, a pass that never overlaps itself, and a
 * pass that can be called directly with an injected clock so the tests
 * drive time instead of waiting for it.
 *
 * The persisted `next_run_at` is the whole of its memory, which is what
 * makes it safe across restarts:
 *
 * - A schedule is due when `next_run_at <= now`. Claiming it moves
 *   `next_run_at` to the next fire time strictly after now, with a
 *   compare-and-set on the old value, in the same transaction that
 *   inserts the run and the job. A second pass (or a second process, or
 *   the same process after a restart) sees the advanced value and has
 *   nothing to do; a crash before commit leaves the schedule due, so the
 *   run is retried rather than lost.
 * - Fire times missed while the control plane was down collapse into
 *   one run on the next pass, not one per missed slot: three nightly
 *   backups back to back an hour after boot are worse than one.
 * - A schedule whose previous run is still queued or running — queued
 *   typically because its host's agent is offline — is not stacked up:
 *   the slot is skipped (and advanced), and the waiting run covers it.
 *   Two runs into one restic repository would only fight over its lock.
 *
 * The job goes to the schedule's own server, never anywhere else, and a
 * host that is offline gets its job anyway with `blocked_reason:
 * agent_offline`; the worker only claims it once the agent dials back in
 * (KD-008), exactly as for "Run now".
 * ------------------------------------------------------------------ */

const TICK_MS = 15_000;
const FIRST_TICK_MS = 5_000;

type ScheduleRow = typeof backupSchedules.$inferSelect;

export interface BackupSchedulerOptions {
  /** The clock every pass reads. Tests inject one; production uses the wall clock. */
  now?: () => Date;
}

export interface SchedulerPassResult {
  /** Runs enqueued this pass, by schedule id. */
  enqueued: { scheduleId: string; runId: string; jobId: string }[];
  /** Schedules whose slot was skipped because an earlier run is still waiting. */
  skipped: string[];
  /** Schedules whose run could not even be planned (recorded as a failed run). */
  failed: string[];
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => Date;

  constructor(
    private readonly ctx: AppContext,
    opts: BackupSchedulerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    // Soon after boot, so a slot missed while the control plane was down
    // is caught up without waiting a full interval.
    this.first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    this.first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
  }

  /** One pass over every due schedule. Safe to call directly; passes never overlap. */
  async tick(): Promise<SchedulerPassResult> {
    const result: SchedulerPassResult = { enqueued: [], skipped: [], failed: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const now = this.now();
      const due = await this.ctx.db
        .select({ schedule: backupSchedules, serverName: servers.name })
        .from(backupSchedules)
        .innerJoin(servers, eq(backupSchedules.serverId, servers.id))
        .where(
          and(
            eq(backupSchedules.enabled, true),
            lte(backupSchedules.nextRunAt, now),
            // A revoked host will never claim a job; queueing one nightly
            // would only grow a pile nobody can drain.
            isNull(servers.revokedAt),
          ),
        );

      for (const { schedule, serverName } of due) {
        try {
          await this.fire(schedule, serverName, now, result);
        } catch (err) {
          this.ctx.log.warn({ err, scheduleId: schedule.id }, "backup schedule pass failed");
        }
      }
    } catch (err) {
      this.ctx.log.warn({ err }, "backup scheduler pass failed");
    } finally {
      this.running = false;
    }
    return result;
  }

  private async fire(
    schedule: ScheduleRow,
    serverName: string,
    now: Date,
    result: SchedulerPassResult,
  ): Promise<void> {
    const { ctx } = this;
    let next: Date | null;
    try {
      next = computeNextRun(schedule.cron, schedule.timezone, true, now);
    } catch {
      // Validated on write, so only a hand-edited row lands here. Parking
      // it (null) stops it being "due" every 15 s for ever.
      next = null;
    }

    // Planned before the transaction: it only reads, and a schedule that
    // resolves to nothing is a failed run the operator needs to see, not
    // an exception that would leave it due for ever.
    let plan: Awaited<ReturnType<typeof planScope>> | null = null;
    let planError: string | null = null;
    try {
      plan = await planScope(ctx.db, schedule);
    } catch (err) {
      planError = err instanceof Error ? err.message : String(err);
    }

    // restic always needs a repository password, whatever the schedule's
    // encryption flag says; a schedule without one gets it here, once.
    const passwordRef = await ensureSchedulePassword(ctx.db, ctx.config.masterKey, schedule);

    const connected = ctx.hub.isConnected(schedule.serverId);
    const outcome = await ctx.db.transaction(async (tx) => {
      // Compare-and-set on the value this pass read: whoever moves it
      // first owns this slot, and everyone else finds nothing to do.
      const claimed = await tx
        .update(backupSchedules)
        .set({ nextRunAt: next, updatedAt: now })
        .where(
          and(
            eq(backupSchedules.id, schedule.id),
            eq(backupSchedules.enabled, true),
            schedule.nextRunAt
              ? eq(backupSchedules.nextRunAt, schedule.nextRunAt)
              : sql`false`,
          ),
        )
        .returning({ id: backupSchedules.id });
      if (claimed.length === 0) return { kind: "lost" as const };

      const waiting = await tx
        .select({ id: backupRuns.id })
        .from(backupRuns)
        .where(
          and(
            eq(backupRuns.scheduleId, schedule.id),
            inArray(backupRuns.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (waiting[0]) return { kind: "skipped" as const };

      if (!plan) {
        const [run] = await tx
          .insert(backupRuns)
          .values({
            scheduleId: schedule.id,
            serverId: schedule.serverId,
            trigger: "scheduled",
            status: "failed",
            error: planError?.slice(0, 2000) ?? "nothing to back up",
            startedAt: now,
            finishedAt: now,
          })
          .returning({ id: backupRuns.id });
        await tx
          .update(backupSchedules)
          .set({ lastRunAt: now, lastRunStatus: "failed" })
          .where(eq(backupSchedules.id, schedule.id));
        return { kind: "failed" as const, runId: run!.id };
      }

      const [run] = await tx
        .insert(backupRuns)
        .values({
          scheduleId: schedule.id,
          serverId: schedule.serverId,
          trigger: "scheduled",
          status: "queued",
        })
        .returning({ id: backupRuns.id });

      // The same params "Run now" sends, so a scheduled run and a manual
      // one are indistinguishable to the handler except by their tag.
      const params = {
        run_id: run!.id,
        repository: schedule.repositoryPath,
        password_ref: passwordRef,
        paths: plan.paths,
        exclude: plan.exclude,
        tags: [`schedule:${schedule.id}`, "trigger:scheduled"],
        databases: plan.databases,
        // Not sent to the agent: the handler runs these before and after
        // the snapshot (dumps, manifests, a brief stop).
        ...(plan.apps.length > 0 ? { apps: plan.apps } : {}),
      };
      // The queue bound to this transaction, so the job commits with the
      // claim and the run — or none of the three does.
      const job = await new JobQueue(tx as unknown as Database).enqueue({
        type: "backup.run",
        serverId: schedule.serverId,
        targetType: "backup_run",
        targetId: run!.id,
        targetLabel: schedule.name,
        params,
        createdByName: "scheduler",
        // Said up front, as enqueueServerJob does: the worker never claims
        // a job for a host that is not connected, so it cannot say so itself.
        blockedReason: connected ? null : "agent_offline",
      });
      await tx.update(backupRuns).set({ jobId: job.id }).where(eq(backupRuns.id, run!.id));
      await tx
        .update(backupSchedules)
        .set({ lastRunAt: now, lastRunStatus: "queued" })
        .where(eq(backupSchedules.id, schedule.id));
      return { kind: "enqueued" as const, runId: run!.id, job, params };
    });

    switch (outcome.kind) {
      case "lost":
        return;
      case "skipped":
        result.skipped.push(schedule.id);
        ctx.log.info(
          { scheduleId: schedule.id, next: next?.toISOString() ?? null },
          "backup slot skipped: the previous run is still waiting",
        );
        return;
      case "failed":
        result.failed.push(schedule.id);
        ctx.events.publish(
          "backups",
          "backup.failed",
          { run_id: outcome.runId, server_id: schedule.serverId, error: planError },
          schedule.serverId,
        );
        return;
      case "enqueued": {
        result.enqueued.push({
          scheduleId: schedule.id,
          runId: outcome.runId,
          jobId: outcome.job.id,
        });
        await ctx.audit.record({
          actor: { type: "system", id: null, name: "scheduler" },
          action: "backup.run.requested",
          targetType: "backup_run",
          targetId: outcome.runId,
          targetLabel: schedule.name,
          serverId: schedule.serverId,
          jobId: outcome.job.id,
          metadata: { params: outcome.params, trigger: "scheduled" },
        });
        ctx.events.publish(
          "jobs",
          "job.queued",
          { ...outcome.job, server_name: serverName },
          schedule.serverId,
        );
        ctx.events.publish(
          "backups",
          "run.queued",
          { run_id: outcome.runId, schedule_id: schedule.id, trigger: "scheduled" },
          schedule.serverId,
        );
        return;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Scope planning
 *
 * Shared with POST /backups/schedules/:id/run so a scheduled run and a
 * manual one back up exactly the same thing.
 * ------------------------------------------------------------------ */

/**
 * What a scope covers on the host when the operator names no selectors.
 * `databases` and `files` have no default: an empty selector list there
 * means "everything the schedule's other scopes already name", and
 * silently backing up every database would be a surprise, not a default.
 */
const SCOPE_DEFAULT_PATHS: Record<BackupScope["kind"], string[]> = {
  files: [],
  databases: [],
  mail: ["/var/vmail"],
  config: ["/etc"],
  panel: ["/var/lib/kaname"],
  app: [],
};

export async function planScope(
  db: Database,
  schedule: ScheduleRow,
): Promise<{
  paths: string[];
  exclude: string[];
  databases: { engine: string; name: string }[];
  apps: AppBackupPlanEntry[];
}> {
  const paths: string[] = [];
  const exclude: string[] = [];
  const databases: { engine: string; name: string }[] = [];
  const apps: AppBackupPlanEntry[] = [];

  for (const scope of schedule.scope as BackupScope[]) {
    if (scope.kind === "app") {
      const plan = await planAppScope(db, schedule.serverId, scope.selectors);
      paths.push(...plan.paths);
      exclude.push(...plan.exclude);
      apps.push(...plan.apps);
      continue;
    }
    if (scope.kind === "databases") {
      for (const selector of scope.selectors) {
        const [engine, name] = selector.includes(":")
          ? [selector.slice(0, selector.indexOf(":")), selector.slice(selector.indexOf(":") + 1)]
          : [null, selector];
        databases.push({ engine: engine ?? (await engineFor(db, schedule.serverId, name)), name });
      }
      continue;
    }
    const selected = scope.selectors.length > 0 ? scope.selectors : SCOPE_DEFAULT_PATHS[scope.kind];
    for (const path of selected) {
      if (!path.startsWith("/")) {
        throw badRequest(`Scope "${scope.kind}" names "${path}", which is not an absolute path.`, {
          scope: `selectors for ${scope.kind} must be absolute paths`,
        });
      }
      paths.push(path);
    }
  }

  if (paths.length === 0 && databases.length === 0) {
    throw new ApiException(
      "precondition_failed",
      `Schedule "${schedule.name}" resolves to nothing to back up.`,
      {
        remediation: {
          summary:
            "Name at least one path in a files scope, or at least one database, otherwise the run would produce an empty snapshot.",
          actions: [{ label: "Edit schedule", href: `/backups/schedules/${schedule.id}` }],
        },
      },
    );
  }
  return { paths, exclude, databases, apps };
}

/** A bare database name is only unambiguous once we know its engine. */
async function engineFor(db: Database, serverId: string, name: string): Promise<string> {
  const rows = await db
    .select({ engine: dbDatabases.engine })
    .from(dbDatabases)
    .where(and(eq(dbDatabases.serverId, serverId), eq(dbDatabases.name, name)))
    .limit(1);
  const engine = rows[0]?.engine;
  if (!engine) {
    throw badRequest(
      `No database named "${name}" is known on this server, so Kaname cannot tell which engine to dump it from.`,
      {
        scope: `write it as "postgres:${name}" or "mysql:${name}", or sync the server's databases first`,
      },
    );
  }
  return engine;
}
