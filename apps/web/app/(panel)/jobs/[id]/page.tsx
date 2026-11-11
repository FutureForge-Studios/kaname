"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Ban } from "lucide-react";
import { TERMINAL_JOB_STATUSES, type Job, type JobStatus } from "@kaname/contract";
import {
  Button,
  Card,
  CopyButton,
  JobProgress,
  JobStatusPill,
  LeaderLabel,
  LogViewer,
  MonoLabel,
  MonoText,
  NumberedSection,
  PageBody,
  PageHeader,
  RelativeTime,
  StatusLine,
  type LogLine,
  type Tone,
} from "@kaname/ui";
import { api } from "@/lib/api";
import { formatCount, formatDateTime, formatDuration } from "@/lib/format";
import { useJob, useJobLogs, useResourceMutation } from "@/lib/queries";
import { DetailFailed, DetailLoading } from "@/app/(panel)/websites/_components/detail";

/* ------------------------------------------------------------------ *
 * Job detail.
 *
 * The drawer, a toast and every notification link here, so this page
 * exists for one reason: a job's log has to have an address that
 * survives closing the drawer, and that can be pasted into a message.
 * A header that states the outcome in one line, a mono record of the
 * run (what, where, when, which attempt), then the log in its well.
 * ------------------------------------------------------------------ */

const TERMINAL = new Set<Job["status"]>(TERMINAL_JOB_STATUSES);

const OUTCOME_TONE: Partial<Record<JobStatus, Tone>> = {
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  timed_out: "danger",
};

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const job = useJob(id);

  const cancel = useResourceMutation<void, Job>({
    mutationFn: () => api.post<Job>(`/jobs/${id}/cancel`),
    invalidates: ["jobs"],
    successMessage: () => "Cancellation requested.",
  });

  if (job.isLoading) return <DetailLoading rail={false} />;
  if (job.isError || !job.data) {
    return (
      <DetailFailed
        error={job.error}
        onRetry={() => void job.refetch()}
        context="Job"
        title="Job"
      />
    );
  }

  const row = job.data;
  const running = !TERMINAL.has(row.status);
  const where = [row.server_name, row.target_label].filter(Boolean).join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Job"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{row.label}</span>
            <JobStatusPill status={row.status} size="sm" blockedReason={row.blocked_reason} />
          </span>
        }
        subtitle={where ? <MonoText muted>{where}</MonoText> : undefined}
        status={<Outcome job={row} running={running} />}
        actions={
          <>
            {running && (
              <Button
                variant="danger-subtle"
                size="sm"
                icon={Ban}
                loading={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => router.back()}>
              Back
            </Button>
          </>
        }
      />
      <PageBody>
        <NumberedSection index={1} title="Run" caption="What ran, where, when.">
          <RunRecord job={row} />
        </NumberedSection>
        <JobLog job={row} running={running} />
      </PageBody>
    </div>
  );
}

/* ------------------------------ outcome ----------------------------- */

/** The run's outcome as one sentence beside a status dot. */
function Outcome({ job, running }: { job: Job; running: boolean }) {
  const tone: Tone = job.blocked_reason
    ? "warn"
    : running
      ? "info"
      : (OUTCOME_TONE[job.status] ?? "neutral");
  const when = job.finished_at ?? job.started_at ?? job.created_at;
  return (
    <StatusLine tone={tone} pulse={running}>
      <span className="kn-mono">{job.status.replace(/_/g, " ")}</span>
      {" · "}
      <RelativeTime value={when} />
      {job.duration_ms != null && <> · {formatDuration(job.duration_ms)}</>}
      {job.created_by_name && <> · started by {job.created_by_name}</>}
    </StatusLine>
  );
}

/* ------------------------------ run record -------------------------- */

/**
 * The run as one hairline matrix of mono facts. Everything here is
 * something an operator pastes into a message or greps a log for.
 */
function RunRecord({ job }: { job: Job }) {
  return (
    <Card padding="none" className="overflow-hidden">
      <dl className="m-0 grid grid-cols-2 gap-px bg-[var(--kn-border)] md:grid-cols-4">
        <Fact label="Type">{job.type}</Fact>
        <Fact label="Job ID" copy={job.id} title={job.id}>
          {job.id}
        </Fact>
        <Fact label="Server">{job.server_name}</Fact>
        <Fact label="Target">{job.target_label}</Fact>
        <Fact label="Queued" title={formatDateTime(job.created_at)}>
          <RelativeTime value={job.created_at} />
        </Fact>
        <Fact label="Started" title={job.started_at ? formatDateTime(job.started_at) : undefined}>
          {job.started_at ? <RelativeTime value={job.started_at} /> : null}
        </Fact>
        <Fact label="Duration">
          {job.duration_ms != null ? formatDuration(job.duration_ms) : null}
        </Fact>
        <Fact label="Attempt">
          {job.attempt} of {job.max_attempts}
        </Fact>
      </dl>
    </Card>
  );
}

function Fact({
  label,
  copy,
  title,
  children,
}: {
  label: string;
  /** Exact string for the clipboard; shows a copy button. */
  copy?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const empty = children == null || children === "";
  return (
    <div className="min-w-0 bg-[var(--kn-surface)] px-4 py-3">
      <MonoLabel as="dt" size="xs">
        {label}
      </MonoLabel>
      <dd className="m-0 mt-1.5 flex min-h-5 min-w-0 items-center gap-1" title={title}>
        <span
          className={
            empty
              ? "kn-mono text-[var(--kn-text-3)]"
              : "kn-mono min-w-0 select-text truncate text-[var(--kn-text)]"
          }
        >
          {empty ? "—" : children}
        </span>
        {copy && <CopyButton value={copy} label={`Copy ${label}`} size="xs" />}
      </dd>
    </div>
  );
}

/* --------------------------------- log ------------------------------ */

/**
 * The log in the same well the Logs page uses: a hairline frame that
 * names what is in it, the error (if any) as one mono line, and the
 * viewer recessed inside. Lines arrive over the panel's SSE bridge,
 * which appends them to the cache entry this reads.
 */
function JobLog({ job, running }: { job: Job; running: boolean }) {
  const logs = useJobLogs(job.id);

  const lines = React.useMemo<LogLine[]>(
    () =>
      (logs.data ?? []).map((line) => ({
        id: `${job.id}-${line.seq}`,
        ts: line.ts,
        level: line.level,
        message: line.message,
      })),
    [job.id, logs.data],
  );

  return (
    <NumberedSection index={2} title="Log" caption="Everything the agent reported for this run.">
      <Card padding="none" className="overflow-hidden">
        <div className="flex min-h-9 items-center gap-3 border-b border-[var(--kn-border)] px-4 py-2">
          <LeaderLabel tone={running ? "ok" : "subtle"} className="min-w-0 flex-1">
            {running ? "Streaming" : "Output"}
          </LeaderLabel>
          <span className="kn-mono shrink-0 text-xs text-[var(--kn-text-3)]">
            {formatCount(lines.length)} lines
          </span>
        </div>

        {job.progress != null && (
          <JobProgress value={job.progress} status={job.status} label={`${job.label} progress`} />
        )}

        {job.error && (
          <p className="m-0 border-b border-[var(--kn-border)] px-4 py-2 text-[var(--kn-danger)]">
            <MonoText>{job.error.code}</MonoText> — {job.error.message}
          </p>
        )}

        <div className="bg-[var(--kn-bg-inset)] p-1.5">
          <LogViewer
            lines={lines}
            height={520}
            label={`${job.label} log`}
            emptyLabel={
              logs.isLoading
                ? "Loading…"
                : running
                  ? "Waiting for the agent to report."
                  : "This job emitted no output."
            }
            className="rounded-[var(--kn-r-md)]"
          />
        </div>
      </Card>
    </NumberedSection>
  );
}
