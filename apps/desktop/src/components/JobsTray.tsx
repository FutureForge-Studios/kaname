import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { getJob } from "../lib/api";
import { toDesktopError } from "../lib/ipc";
import {
  isTerminalStatus,
  jobsReducer,
  jobTitle,
  pollable,
  pollDelay,
  type Job,
  type TrackedJob,
} from "../lib/jobs";
import { JobBadge } from "./StatusBadges";

/** Auto-dismiss succeeded jobs after this long; failures stay until dismissed. */
const SUCCESS_TTL_MS = 8000;

/**
 * Owns the tracked-jobs state and the polling loop: every second, each
 * job still in flight is polled once its backoff has elapsed.
 * `onSettled` fires once per job when it reaches a terminal state.
 */
export function useJobs(onError: (connectionId: string, error: unknown) => void) {
  const [jobs, dispatch] = useReducer(jobsReducer, []);
  const [settledVersion, setSettledVersion] = useState(0);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const lastPolled = useRef(new Map<string, number>());
  const inFlight = useRef(new Set<string>());
  const settled = useRef(new Set<string>());
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const hasPollable = pollable(jobs).length > 0;

  useEffect(() => {
    if (!hasPollable) return;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const tracked of pollable(jobsRef.current)) {
        const id = tracked.job.id;
        if (inFlight.current.has(id)) continue;
        if (now - (lastPolled.current.get(id) ?? tracked.addedAt) < pollDelay(tracked)) continue;
        inFlight.current.add(id);
        lastPolled.current.set(id, now);
        getJob(tracked.connectionId, id)
          .then((job) => {
            if (job) dispatch({ type: "polled", jobId: id, job });
            else dispatch({ type: "poll_failed", jobId: id, message: "The panel returned no job." });
          })
          .catch((err: unknown) => {
            const error = toDesktopError(err);
            dispatch({ type: "poll_failed", jobId: id, message: error.message });
            onErrorRef.current(tracked.connectionId, error);
          })
          .finally(() => inFlight.current.delete(id));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [hasPollable]);

  // Settlement: bump the version once per job, and schedule auto-dismiss.
  useEffect(() => {
    let changed = false;
    for (const t of jobs) {
      if (isTerminalStatus(t.job.status) && !settled.current.has(t.job.id)) {
        settled.current.add(t.job.id);
        changed = true;
        if (t.job.status === "succeeded") {
          const id = t.job.id;
          setTimeout(() => dispatch({ type: "dismiss", jobId: id }), SUCCESS_TTL_MS);
        }
      }
    }
    if (changed) setSettledVersion((v) => v + 1);
  }, [jobs]);

  const track = useCallback((connectionId: string, job: Job) => {
    dispatch({ type: "track", connectionId, job, now: Date.now() });
  }, []);

  return { jobs, dispatch, track, settledVersion };
}

interface JobsTrayProps {
  jobs: TrackedJob[];
  connectionName(id: string): string | undefined;
  onDismiss(jobId: string): void;
  onClearFinished(): void;
}

export function JobsTray({ jobs, connectionName, onDismiss, onClearFinished }: JobsTrayProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (jobs.length === 0) return null;
  const running = jobs.filter((t) => !isTerminalStatus(t.job.status)).length;

  return (
    <section className="jobs-tray" aria-label="Jobs" aria-live="polite">
      <header className="jobs-head">
        <span className="label">Jobs</span>
        <span className="mono muted">{running > 0 ? `${running} running` : "all settled"}</span>
        <span className="spacer" />
        {jobs.length > running && (
          <button className="link-btn" onClick={onClearFinished}>
            Clear
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand jobs" : "Collapse jobs"}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </header>
      {!collapsed && (
        <ul className="jobs-list">
          {jobs.slice(0, 6).map((t) => (
            <li key={t.job.id} className="job-row">
              <div className="job-main">
                <span className="job-title">{jobTitle(t.job)}</span>
                <span className="job-sub mono">
                  {[t.job.server_name, connectionName(t.connectionId)].filter(Boolean).join(" · ")}
                </span>
                {t.job.error && <span className="job-error">{t.job.error.message}</span>}
                {t.pollError && !isTerminalStatus(t.job.status) && (
                  <span className="job-error">Status unknown: {t.pollError}</span>
                )}
              </div>
              <JobBadge status={t.job.status} />
              <button className="icon-btn" onClick={() => onDismiss(t.job.id)} aria-label="Dismiss">
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
