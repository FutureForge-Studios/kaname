"use client";

import * as React from "react";
import Link from "next/link";
import { Ban, ChevronRight, ListChecks } from "lucide-react";
import { TERMINAL_JOB_STATUSES, type Job } from "@kaname/contract";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerHeader,
  EmptyState,
  JobProgress,
  JobStatusPill,
  LogViewer,
  MonoText,
  RelativeTime,
  Skeleton,
  cn,
  type LogLine,
} from "@kaname/ui";
import { api, type ApiError } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useJobDrawer, useJobLogs, useList, useResourceMutation } from "@/lib/queries";
import { PageError } from "./PageError";

/* ------------------------------------------------------------------ *
 * Global job drawer.
 *
 * The counterpart to KD-008: because no mutation returns its outcome
 * inline, this is where outcomes live. It is deliberately global rather
 * than per-page — a certificate issuance started on the SSL page is
 * still running when the operator has moved to the dashboard, and it
 * has to stay watchable there.
 * ------------------------------------------------------------------ */

const TERMINAL = new Set<Job["status"]>(TERMINAL_JOB_STATUSES);

export function JobDrawer() {
  const drawer = useJobDrawer();
  const { open, setOpen, focusedJobId, focusJob, tracked, activeCount } = drawer;

  const jobs = useList<Job>(
    "jobs",
    { per_page: 40, sort: "created_at", order: "desc" },
    {
      enabled: open,
      staleTime: 5_000,
    },
  );

  /* Tracked jobs are pinned so a queue full of background work cannot
   * push the thing the operator just started off the top. */
  const rows = React.useMemo<Job[]>(() => {
    const pinned = tracked.map((entry) => entry.job);
    const pinnedIds = new Set(pinned.map((job) => job.id));
    const fetched = jobs.data?.data ?? [];
    const fresh = new Map(fetched.map((job) => [job.id, job] as const));
    return [
      ...pinned.map((job) => fresh.get(job.id) ?? job),
      ...fetched.filter((job) => !pinnedIds.has(job.id)),
    ];
  }, [jobs.data, tracked]);

  return (
    <Drawer open={open} onOpenChange={setOpen} side="right" size="md" label="Job activity">
      <DrawerHeader
        title="Job activity"
        description={
          activeCount > 0
            ? `${activeCount} job${activeCount === 1 ? "" : "s"} still running.`
            : "Everything this session has queued, newest first."
        }
        actions={
          <Button variant="ghost" size="xs" onClick={() => void jobs.refetch()}>
            Refresh
          </Button>
        }
      />

      <DrawerBody className="px-0 py-0">
        {jobs.isError && (
          <div className="p-4">
            <PageError
              error={jobs.error}
              onRetry={() => void jobs.refetch()}
              context="Job history"
            />
          </div>
        )}

        {jobs.isLoading && rows.length === 0 && (
          <ul className="divide-y divide-[var(--kn-border-subtle)]">
            {[0, 1, 2, 3, 4].map((index) => (
              <li key={index} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="h-4 w-20 rounded-[var(--kn-r-pill)]" />
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-12" />
              </li>
            ))}
          </ul>
        )}

        {!jobs.isLoading && !jobs.isError && rows.length === 0 && (
          <EmptyState
            icon={ListChecks}
            title="No jobs yet"
            description="Anything that touches a host — a restart, a certificate, a backup — shows up here while it runs."
            size="sm"
          />
        )}

        <ul className="divide-y divide-[var(--kn-border-subtle)]">
          {rows.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              expanded={focusedJobId === job.id}
              onToggle={() => focusJob(focusedJobId === job.id ? null : job.id)}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </ul>
      </DrawerBody>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

interface JobRowProps {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}

function JobRow({ job, expanded, onToggle, onNavigate }: JobRowProps) {
  const cancel = useResourceMutation<void, Job>({
    mutationFn: () => api.post<Job>(`/jobs/${job.id}/cancel`),
    invalidates: ["jobs"],
    successMessage: () => `Cancellation requested for ${job.label}.`,
  });

  const running = !TERMINAL.has(job.status);

  return (
    <li>
      <div className="flex items-start gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="mt-0.5 shrink-0 rounded-[var(--kn-r-xs)] text-[var(--kn-text-3)] outline-none transition-colors duration-[var(--kn-dur-fast)] hover:text-[var(--kn-text)]"
        >
          <ChevronRight
            size={14}
            className={cn(
              "transition-transform duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <span className="sr-only">{expanded ? "Hide job log" : "Show job log"}</span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium text-[var(--kn-text)]">{job.label}</span>
            <JobStatusPill
              status={job.status}
              size="xs"
              blockedReason={job.blocked_reason}
              className="shrink-0"
            />
          </div>

          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--kn-text-2)]">
            {job.server_name && <MonoText muted>{job.server_name}</MonoText>}
            {job.target_label && (
              <>
                <span aria-hidden>·</span>
                <MonoText muted truncate>
                  {job.target_label}
                </MonoText>
              </>
            )}
            <span aria-hidden>·</span>
            <RelativeTime value={job.created_at} />
            {job.duration_ms != null && (
              <>
                <span aria-hidden>·</span>
                <span className="kn-num">{formatDuration(job.duration_ms)}</span>
              </>
            )}
            {job.attempt > 1 && (
              <>
                <span aria-hidden>·</span>
                <span>
                  attempt {job.attempt} of {job.max_attempts}
                </span>
              </>
            )}
          </div>

          {job.progress != null && (
            <JobProgress
              value={job.progress}
              status={job.status}
              label={`${job.label} progress`}
              className="mt-1.5"
            />
          )}

          {job.error && (
            <p className="mt-1 text-xs text-[var(--kn-danger)]">
              <MonoText>{job.error.code}</MonoText> — {job.error.message}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {running && (
            <Button
              variant="ghost"
              size="xs"
              icon={Ban}
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          )}
          <Link
            href={`/jobs/${job.id}`}
            onClick={onNavigate}
            className="rounded-[var(--kn-r-xs)] px-1 text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
          >
            Details
          </Link>
        </div>
      </div>

      {expanded && <JobLog jobId={job.id} status={job.status} />}
    </li>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The same windowed viewer the job panels use: a long backup or build
 * is thousands of lines, and rendering each as a list item inside a
 * scroller is what made the drawer the heaviest thing on the page.
 */
function JobLog({ jobId, status }: { jobId: string; status: Job["status"] }) {
  const logs = useJobLogs(jobId);
  const running = !TERMINAL.has(status);

  const lines = React.useMemo<LogLine[]>(
    () =>
      (logs.data ?? []).map((line) => ({
        id: `${jobId}-${line.seq}`,
        ts: line.ts,
        level: line.level,
        message: line.message,
      })),
    [jobId, logs.data],
  );

  return (
    <div className="border-t border-[var(--kn-border-subtle)] bg-[var(--kn-bg-inset)]">
      {logs.isLoading && (
        <div className="px-4 py-2">
          <Skeleton className="h-3 w-2/3" label="Loading job log" />
        </div>
      )}

      {logs.isError && (
        <div className="px-4 py-2">
          <PageError
            error={logs.error as ApiError}
            onRetry={() => void logs.refetch()}
            context="Job log"
          />
        </div>
      )}

      {!logs.isLoading && !logs.isError && (
        <LogViewer
          lines={lines}
          height={224}
          emptyLabel={
            running
              ? "No log lines yet. The agent writes them as the job progresses."
              : "This job emitted no output."
          }
          label="Job log"
        />
      )}
    </div>
  );
}

/** Topbar affordance: opens the drawer and shows what is still moving. */
export function JobActivityButton({ className }: { className?: string }) {
  const drawer = useJobDrawer();
  const active = drawer.activeCount;

  return (
    <button
      type="button"
      onClick={() => drawer.setOpen(true)}
      aria-label={active > 0 ? `Job activity — ${active} running` : "Job activity"}
      className={cn(
        "relative inline-flex h-7 items-center gap-1.5 rounded-[var(--kn-r-sm)] px-2",
        "text-[var(--kn-text-2)] outline-none",
        "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        "hover:bg-[var(--kn-surface-2)] hover:text-[var(--kn-text)]",
        className,
      )}
    >
      <ListChecks size={14} aria-hidden />
      {active > 0 && (
        <span className="kn-num inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--kn-r-pill)] bg-[var(--kn-accent-soft-strong)] px-1 text-2xs font-medium text-[var(--kn-accent-300)]">
          {active}
        </span>
      )}
    </button>
  );
}
