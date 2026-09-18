"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button, JobStatusPill, MonoText, PageHeader } from "@kaname/ui";
import { useJob } from "@/lib/queries";
import { JobPanel } from "@/app/(panel)/websites/_components/JobPanel";
import { DetailBody, DetailFailed, DetailLoading } from "@/app/(panel)/websites/_components/detail";

/* ------------------------------------------------------------------ *
 * Job detail.
 *
 * The drawer, a toast and every notification link here, so this page
 * exists for one reason: a job's log has to have an address that
 * survives closing the drawer, and that can be pasted into a message.
 * It is the same panel the job started in, with the whole width.
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
      <DetailBody>
        <JobPanel jobId={id} title="Log" />
      </DetailBody>
    </div>
  );
}
