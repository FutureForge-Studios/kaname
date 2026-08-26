"use client";

import * as React from "react";
import Link from "next/link";
import { Ban, ListChecks } from "lucide-react";
import { TERMINAL_JOB_STATUSES, type Job } from "@kaname/contract";
import {
  Button,
  JobProgress,
  JobStatusPill,
  LogViewer,
  MonoText,
  RelativeTime,
  SectionCard,
  Skeleton,
  type LogLine,
} from "@kaname/ui";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useJob, useJobLogs, useResourceMutation } from "@/lib/queries";
import { PageError } from "@/components/PageError";

/* ------------------------------------------------------------------ *
 * JobPanel — a job's progress and log, in place.
 *
 * ACME runs on the host, so issuing, renewing and revoking are jobs
 * (KD-008) and the honest way to show one is the pill plus the lines it
 * is emitting. The global job drawer still tracks it; this is the same
 * job rendered where the operator started it, so they do not have to
 * open a drawer to watch a renewal they are waiting on.
 *
 * Lines arrive over the panel's SSE bridge, which appends them to the
 * same cache entry this reads — no second stream.
 * ------------------------------------------------------------------ */

const TERMINAL = new Set<Job["status"]>(TERMINAL_JOB_STATUSES);

export interface JobPanelProps {
  jobId: string;
  title: string;
  onDismiss?: () => void;
}

export function JobPanel({ jobId, title, onDismiss }: JobPanelProps) {
  const job = useJob(jobId);
  const logs = useJobLogs(jobId);

  const cancel = useResourceMutation<void, Job>({
    mutationFn: () => api.post<Job>(`/jobs/${jobId}/cancel`),
    invalidates: ["jobs"],
    successMessage: () => "Cancellation requested.",
  });

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

  const running = job.data ? !TERMINAL.has(job.data.status) : true;

  return (
    <SectionCard
      title={title}
      icon={ListChecks}
      padded={false}
      headingLevel={3}
      actions={
        <>
          {job.data && (
            <JobStatusPill
              status={job.data.status}
              size="xs"
              blockedReason={job.data.blocked_reason}
            />
          )}
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
          {!running && onDismiss && (
            <Button variant="ghost" size="xs" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </>
      }
      footer={
        job.data ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <MonoText muted className="text-xs">
              {job.data.type}
            </MonoText>
            <span aria-hidden>·</span>
            <RelativeTime value={job.data.created_at} className="text-xs" />
            {job.data.duration_ms != null && (
              <>
                <span aria-hidden>·</span>
                <span className="kn-num text-xs">{formatDuration(job.data.duration_ms)}</span>
              </>
            )}
            <Link
              href={`/jobs/${jobId}`}
              className="ml-auto rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              Job details
            </Link>
          </span>
        ) : undefined
      }
    >
      {job.isError && (
        <div className="p-4">
          <PageError error={job.error} onRetry={() => void job.refetch()} context="Job" />
        </div>
      )}

      {job.isLoading && <Skeleton className="m-4 h-3 w-48" label="Loading job" />}

      {job.data?.progress != null && (
        <JobProgress
          value={job.data.progress}
          status={job.data.status}
          label={`${job.data.label} progress`}
        />
      )}

      {job.data?.error && (
        <p className="border-b border-[var(--kn-border)] px-4 py-2 text-[var(--kn-danger)]">
          <MonoText>{job.data.error.code}</MonoText> — {job.data.error.message}
        </p>
      )}

      <LogViewer
        lines={lines}
        height={320}
        emptyLabel={running ? "Waiting for the agent to report." : "This job emitted no output."}
        label={`${title} log`}
      />
    </SectionCard>
  );
}
