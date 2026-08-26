"use client";

import * as React from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { TERMINAL_JOB_STATUSES, type Job } from "@kaname/contract";
import {
  Button,
  JobProgress,
  JobStatusPill,
  MonoText,
  RelativeTime,
  SectionCard,
} from "@kaname/ui";
import { useJob, useJobDrawer } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * JobActivityBar — the in-page half of KD-008.
 *
 * The global drawer owns the history, but an operator who just pressed
 * "Delete" on a directory should not have to open a drawer to find out
 * whether it happened. This strip sits on the page that started the
 * work, filtered to the job types that page is responsible for, and
 * shows the same pill and the same progress the drawer does.
 *
 * It renders nothing when this session has queued nothing, so a page
 * that is only being read stays quiet.
 * ------------------------------------------------------------------ */

const MAX_ROWS = 5;
const TERMINAL = new Set<Job["status"]>(TERMINAL_JOB_STATUSES);

export interface JobActivityBarProps {
  /** Job-type prefixes this surface owns, e.g. `["fs."]`. */
  types: readonly string[];
  title?: string;
  className?: string;
}

export function JobActivityBar({ types, title = "Queued work", className }: JobActivityBarProps) {
  const drawer = useJobDrawer();

  const entries = React.useMemo(
    () =>
      drawer.tracked
        .filter((entry) => types.some((prefix) => entry.job.type.startsWith(prefix)))
        .slice(0, MAX_ROWS),
    [drawer.tracked, types],
  );

  if (entries.length === 0) return null;

  return (
    <SectionCard
      title={title}
      icon={ListChecks}
      padded={false}
      className={className}
      actions={
        <Button variant="ghost" size="xs" onClick={drawer.clearSettled}>
          Clear finished
        </Button>
      }
    >
      <ul>
        {entries.map((entry) => (
          <JobActivityRow key={entry.job.id} initial={entry.job} />
        ))}
      </ul>
    </SectionCard>
  );
}

function JobActivityRow({ initial }: { initial: Job }) {
  const drawer = useJobDrawer();
  const query = useJob(initial.id);
  const job = query.data ?? initial;

  return (
    <li className="flex items-start gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0">
      <JobStatusPill
        status={job.status}
        size="xs"
        blockedReason={job.blocked_reason}
        className="mt-0.5 shrink-0"
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-[var(--kn-text)]">{job.label}</span>
          {job.target_label && (
            <MonoText muted truncate className="min-w-0 text-sm">
              {job.target_label}
            </MonoText>
          )}
        </div>
        {job.progress != null && !TERMINAL.has(job.status) && (
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

      <div className="flex shrink-0 items-center gap-3">
        {job.server_name && (
          <MonoText muted className="hidden text-xs sm:inline">
            {job.server_name}
          </MonoText>
        )}
        <RelativeTime value={job.created_at} className="text-xs text-[var(--kn-text-3)]" />
        <button
          type="button"
          onClick={() => {
            drawer.focusJob(job.id);
            drawer.setOpen(true);
          }}
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Log
        </button>
        <Link
          href={`/jobs/${job.id}`}
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Details
        </Link>
      </div>
    </li>
  );
}
