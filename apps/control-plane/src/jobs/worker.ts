import type { Logger } from "pino";
import { JOB_SPECS, type JobType } from "@kaname/contract";
import type { Database } from "@kaname/db";
import type { Config } from "../config.js";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "../agent/hub.js";
import type { EventBus } from "../services/events.js";
import type { AuditService } from "../services/audit.js";
import { JobQueue, type ClaimedJob } from "./queue.js";

/* ------------------------------------------------------------------ *
 * The job worker.
 *
 * Claims one job at a time per slot, holds a renewable lease while the
 * RPC is in flight, and translates the outcome into: the resource's own
 * state, a job row, an audit entry and an SSE event. Nothing else in
 * the control plane is allowed to call the hub for a mutation.
 * ------------------------------------------------------------------ */

export interface JobContext {
  db: Database;
  hub: AgentHub;
  queue: JobQueue;
  events: EventBus;
  audit: AuditService;
  config: Config;
  log: Logger;
  job: ClaimedJob;
  /** Emits a job log line and pushes it to any open job drawer. */
  log_(level: "debug" | "info" | "warn" | "error", message: string): Promise<void>;
  progress(percent: number): Promise<void>;
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export class JobWorker {
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly owner = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly running = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly deps: {
      db: Database;
      hub: AgentHub;
      queue: JobQueue;
      events: EventBus;
      audit: AuditService;
      config: Config;
      log: Logger;
    },
  ) {}

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  registerAll(handlers: Partial<Record<JobType, JobHandler>>): void {
    for (const [type, handler] of Object.entries(handlers)) {
      if (handler) this.handlers.set(type as JobType, handler);
    }
  }

  start(): void {
    if (!this.deps.config.JOB_WORKER_ENABLED) {
      this.deps.log.warn("job worker disabled by configuration");
      return;
    }
    this.deps.log.info(
      { owner: this.owner, concurrency: this.deps.config.JOB_WORKER_CONCURRENCY },
      "job worker started",
    );
    this.tick();
    this.maintenanceTimer = setInterval(() => void this.maintenance(), 30_000);
    this.maintenanceTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    for (const controller of this.running.values()) controller.abort();
    // Give in-flight jobs a moment to record their failure before exit.
    await new Promise((r) => setTimeout(r, 250));
  }

  private tick(): void {
    if (this.stopped) return;
    const delay = this.deps.config.JOB_POLL_MS;
    this.timer = setTimeout(() => {
      void this.pump().finally(() => this.tick());
    }, delay);
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    const free = this.deps.config.JOB_WORKER_CONCURRENCY - this.running.size;
    if (free <= 0) return;

    const connected = this.deps.hub.connectedServerIds();
    for (let i = 0; i < free; i += 1) {
      const job = await this.deps.queue.claim(
        this.owner,
        this.deps.config.JOB_LEASE_SECONDS,
        connected,
      );
      if (!job) break;
      void this.execute(job);
    }
  }

  private async maintenance(): Promise<void> {
    try {
      const reaped = await this.deps.queue.reapExpiredLeases();
      const expired = await this.deps.queue.expireStale();
      if (reaped || expired) {
        this.deps.log.info({ reaped, expired }, "job maintenance");
      }
    } catch (err) {
      this.deps.log.error({ err }, "job maintenance failed");
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const controller = new AbortController();
    this.running.set(job.id, controller);

    const spec = JOB_SPECS[job.type];
    const lease = setInterval(
      () => void this.deps.queue.heartbeat(job.id, this.owner, this.deps.config.JOB_LEASE_SECONDS),
      (this.deps.config.JOB_LEASE_SECONDS * 1000) / 3,
    );
    lease.unref?.();

    this.publish(job, "job.started");

    const ctx: JobContext = {
      ...this.deps,
      job,
      signal: controller.signal,
      log_: async (level, message) => {
        await this.deps.queue.log(job.id, level, message);
        this.deps.events.publish(
          "jobs",
          "job.log",
          { job_id: job.id, level, message },
          job.serverId,
        );
      },
      progress: async (percent) => {
        await this.deps.queue.setProgress(job.id, percent);
        this.deps.events.publish(
          "jobs",
          "job.progress",
          { job_id: job.id, progress: percent },
          job.serverId,
        );
      },
    };

    try {
      const handler = this.handlers.get(job.type);
      if (!handler) {
        throw new Error(`No handler registered for job type ${job.type}`);
      }

      const result = await handler(ctx);
      await this.deps.queue.complete(job.id, result ?? null);
      this.publish(job, "job.succeeded", { result });

      await this.deps.audit.record({
        actor: job.createdBy
          ? { type: "user", id: job.createdBy, name: job.createdByName ?? "unknown" }
          : { type: "system", id: null, name: "kaname" },
        action: job.type,
        targetType: job.targetType ?? "job",
        targetId: job.targetId ?? job.id,
        targetLabel: job.targetLabel ?? "",
        serverId: job.serverId,
        jobId: job.id,
        metadata: { params: job.params },
      });
    } catch (err) {
      await this.handleFailure(job, spec, err);
    } finally {
      clearInterval(lease);
      this.running.delete(job.id);
    }
  }

  private async handleFailure(
    job: ClaimedJob,
    spec: (typeof JOB_SPECS)[JobType],
    err: unknown,
  ): Promise<void> {
    // "The box is unreachable" is not a failure — it is a wait. The job
    // goes back to the queue without consuming an attempt (KD-008).
    if (err instanceof AgentOfflineError) {
      await this.deps.queue.block(job.id, "agent_offline");
      this.publish(job, "job.blocked", { reason: "agent_offline" });
      return;
    }

    const error =
      err instanceof AgentRpcError
        ? {
            code: err.agentError.code,
            message: err.agentError.message,
            detail: err.agentError.output ?? err.agentError.detail,
          }
        : { code: "internal_error", message: err instanceof Error ? err.message : String(err) };

    const transient = error.code === "timeout" || error.code === "cancelled";
    const canRetry = spec.idempotent && job.attempt < job.maxAttempts && transient;

    await this.deps.queue.log(job.id, "error", error.message);
    await this.deps.queue.fail(job.id, error, {
      retry: canRetry,
      retryDelayMs: Math.min(30_000, 2 ** job.attempt * 1000),
    });

    this.deps.log.warn({ jobId: job.id, type: job.type, error, willRetry: canRetry }, "job failed");
    this.publish(job, canRetry ? "job.retrying" : "job.failed", { error });

    if (!canRetry) {
      await this.deps.audit.record({
        actor: job.createdBy
          ? { type: "user", id: job.createdBy, name: job.createdByName ?? "unknown" }
          : { type: "system", id: null, name: "kaname" },
        action: `${job.type}.failed`,
        targetType: job.targetType ?? "job",
        targetId: job.targetId ?? job.id,
        targetLabel: job.targetLabel ?? "",
        serverId: job.serverId,
        jobId: job.id,
        metadata: { error },
      });
    }
  }

  private publish(job: ClaimedJob, type: string, extra: Record<string, unknown> = {}): void {
    this.deps.events.publish(
      "jobs",
      type,
      { job_id: job.id, job_type: job.type, server_id: job.serverId, ...extra },
      job.serverId,
    );
  }
}
