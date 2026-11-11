"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { Job } from "@kaname/contract";
import {
  Card,
  CopyButton,
  Button,
  JobStatusPill,
  MonoLabel,
  MonoText,
  PageBody,
  PageHeader,
  RelativeTime,
} from "@kaname/ui";
import { formatDateTime, formatDuration } from "@/lib/format";
import { useJob } from "@/lib/queries";
import { JobPanel } from "@/app/(panel)/websites/_components/JobPanel";
import { DetailFailed, DetailLoading } from "@/app/(panel)/websites/_components/detail";

/* ------------------------------------------------------------------ *
 * Job detail.
 *
 * The drawer, a toast and every notification link here, so this page
 * exists for one reason: a job's log has to have an address that
 * survives closing the drawer, and that can be pasted into a message.
 * It is the same panel the job started in, with the whole width, under
 * a header that states the outcome and a mono record of the run: what
 * it was, where it ran, when, and on which attempt.
 * ------------------------------------------------------------------ */

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const job = useJob(id);

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
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2">
            {where && <MonoText muted>{where}</MonoText>}
            {row.created_by_name && (
              <span className="text-[var(--kn-text-3)]">started by {row.created_by_name}</span>
            )}
          </span>
        }
        actions={
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => router.back()}>
            Back
          </Button>
        }
      />
      <PageBody gap="sm">
        <RunRecord job={row} />
        <JobPanel jobId={id} title="Log" />
      </PageBody>
    </div>
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
        <Fact label="Job ID" copy={job.id}>
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
