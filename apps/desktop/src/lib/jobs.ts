/* ------------------------------------------------------------------ *
 * Jobs: every host-touching mutation answers 202 { data: { job } }.
 * The tray tracks those jobs and polls GET /jobs/:id until the job
 * reaches a terminal state. This file is the pure part: parsing and
 * the reducer. The polling loop lives in components/JobsTray.tsx.
 * ------------------------------------------------------------------ */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

const KNOWN: readonly string[] = ["queued", "running", ...TERMINAL_JOB_STATUSES];

export interface Job {
  id: string;
  type: string | null;
  label: string | null;
  status: JobStatus;
  server_name: string | null;
  target_label: string | null;
  progress: number | null;
  blocked_reason: string | null;
  error: { code: string; message: string } | null;
  finished_at: string | null;
}

export interface TrackedJob {
  connectionId: string;
  job: Job;
  /** Consecutive failed polls; polling stops at MAX_POLL_FAILURES. */
  pollFailures: number;
  pollError: string | null;
  addedAt: number;
}

export const MAX_POLL_FAILURES = 5;

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Tolerant parse of a job object. Returns null when there is no id. */
export function parseJob(raw: unknown): Job | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const status = typeof r.status === "string" && KNOWN.includes(r.status) ? (r.status as JobStatus) : "queued";
  const err = r.error as Record<string, unknown> | null | undefined;
  return {
    id,
    type: str(r.type),
    label: str(r.label),
    status,
    server_name: str(r.server_name),
    target_label: str(r.target_label),
    progress: typeof r.progress === "number" ? r.progress : null,
    blocked_reason: str(r.blocked_reason),
    error:
      err && typeof err === "object"
        ? { code: str(err.code) ?? "error", message: str(err.message) ?? "The job failed." }
        : null,
    finished_at: str(r.finished_at),
  };
}

/** The job from a 202 body's `data`: `{ job }`, or a bare job. */
export function jobFromAccepted(data: unknown): Job | null {
  if (typeof data === "object" && data !== null && "job" in data) {
    return parseJob((data as { job: unknown }).job);
  }
  return parseJob(data);
}

export function jobTitle(job: Job): string {
  return job.label ?? job.target_label ?? job.type ?? `Job ${job.id.slice(0, 8)}`;
}

export type JobsAction =
  | { type: "track"; connectionId: string; job: Job; now: number }
  | { type: "polled"; jobId: string; job: Job }
  | { type: "poll_failed"; jobId: string; message: string }
  | { type: "dismiss"; jobId: string }
  | { type: "clear_finished" };

export function jobsReducer(state: TrackedJob[], action: JobsAction): TrackedJob[] {
  switch (action.type) {
    case "track": {
      const existing = state.find((t) => t.job.id === action.job.id);
      if (existing) {
        return state.map((t) => (t.job.id === action.job.id ? { ...t, job: action.job } : t));
      }
      const tracked: TrackedJob = {
        connectionId: action.connectionId,
        job: action.job,
        pollFailures: 0,
        pollError: null,
        addedAt: action.now,
      };
      return [tracked, ...state];
    }
    case "polled":
      return state.map((t) => {
        if (t.job.id !== action.jobId) return t;
        // A terminal status never goes back to running (late, reordered poll).
        if (isTerminalStatus(t.job.status) && !isTerminalStatus(action.job.status)) return t;
        return { ...t, job: action.job, pollFailures: 0, pollError: null };
      });
    case "poll_failed":
      return state.map((t) =>
        t.job.id === action.jobId
          ? { ...t, pollFailures: t.pollFailures + 1, pollError: action.message }
          : t,
      );
    case "dismiss":
      return state.filter((t) => t.job.id !== action.jobId);
    case "clear_finished":
      return state.filter((t) => !isTerminalStatus(t.job.status));
  }
}

/** Jobs that still need polling. */
export function pollable(state: TrackedJob[]): TrackedJob[] {
  return state.filter((t) => !isTerminalStatus(t.job.status) && t.pollFailures < MAX_POLL_FAILURES);
}

/** Backoff: 1s while healthy, doubling per consecutive failure, capped at 10s. */
export function pollDelay(tracked: TrackedJob): number {
  return Math.min(1000 * 2 ** tracked.pollFailures, 10_000);
}
