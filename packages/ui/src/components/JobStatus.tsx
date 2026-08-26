"use client";

import * as React from "react";
import { Ban, Check, Clock, Loader2, TimerOff, X } from "lucide-react";
import type { JobStatus } from "@kaname/contract";
import { cn } from "../lib/cn.js";
import { StatusBadge, type BadgeSize, type Tone } from "./Badge.js";
import { Progress, type ProgressProps } from "./Feedback.js";

/* ------------------------------------------------------------------ *
 * Job status (KD-008).
 *
 * Every host-touching mutation returns a job, so this pill — not a
 * toast — is what an operator watches. `running` is the only state that
 * moves, and it moves at the kit's one spinner speed.
 * ------------------------------------------------------------------ */

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

function RunningIcon({ size, className }: { size?: number | string; className?: string }) {
  return (
    <Loader2
      size={size}
      className={cn("animate-[var(--animate-spin-slow)]", className)}
      aria-hidden
    />
  );
}

interface JobStatusMeta {
  label: string;
  tone: Tone;
  icon: IconComponent;
  description: string;
}

const JOB_STATUS_META: Record<JobStatus, JobStatusMeta> = {
  queued: {
    label: "Queued",
    tone: "neutral",
    icon: Clock,
    description: "Waiting for a worker to claim it.",
  },
  running: {
    label: "Running",
    tone: "accent",
    icon: RunningIcon,
    description: "The agent is executing this job.",
  },
  succeeded: {
    label: "Succeeded",
    tone: "ok",
    icon: Check,
    description: "Completed without error.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: X,
    description: "The agent returned an error.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    icon: Ban,
    description: "Cancelled before it finished.",
  },
  timed_out: {
    label: "Timed out",
    tone: "warn",
    icon: TimerOff,
    description: "Passed its deadline. What happened on the host is unknown.",
  },
};

const BLOCKED_REASONS: Record<string, string> = {
  agent_offline: "agent offline",
  agent_busy: "agent busy",
  waiting_on_dependency: "waiting on dependency",
  rate_limited: "rate limited",
};

export interface JobStatusPillProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children" | "title"
> {
  status: JobStatus;
  size?: BadgeSize;
  showLabel?: boolean;
  /** `blocked_reason` from the job row. Explains a queue that is not moving. */
  blockedReason?: string | null;
}

export const JobStatusPill = React.forwardRef<HTMLSpanElement, JobStatusPillProps>(
  function JobStatusPill(
    { status, size = "sm", showLabel = true, blockedReason, className, ...props },
    ref,
  ) {
    const meta = JOB_STATUS_META[status] ?? JOB_STATUS_META.queued;
    const reason = blockedReason
      ? (BLOCKED_REASONS[blockedReason] ?? blockedReason.replace(/_/g, " "))
      : null;
    const tooltip = reason ? `${meta.description} Blocked: ${reason}.` : meta.description;

    return (
      <StatusBadge
        ref={ref}
        tone={meta.tone}
        size={size}
        icon={meta.icon}
        title={`${meta.label}. ${tooltip}`}
        className={className}
        {...props}
      >
        {showLabel ? (
          <>
            {meta.label}
            {reason && <span className="ml-1 opacity-70">· {reason}</span>}
          </>
        ) : (
          <span className="sr-only">{meta.label}</span>
        )}
      </StatusBadge>
    );
  },
);

/* ------------------------------ JobProgress ----------------------------- */

const PROGRESS_TONES: Partial<Record<JobStatus, Tone>> = {
  succeeded: "ok",
  failed: "danger",
  timed_out: "warn",
  cancelled: "neutral",
};

export interface JobProgressProps extends Omit<ProgressProps, "value" | "size" | "tone" | "label"> {
  /** 0-100, or null when the job type does not report progress. */
  value: number | null | undefined;
  status?: JobStatus;
  label?: string;
}

export const JobProgress = React.forwardRef<HTMLDivElement, JobProgressProps>(function JobProgress(
  { value, status, label = "Job progress", ...props },
  ref,
) {
  // A job with no reported progress gets nothing rather than an empty
  // track: the pill already says whether it is moving.
  if (value == null || !Number.isFinite(value)) return null;

  return (
    <Progress
      ref={ref}
      value={value}
      size="xs"
      tone={status ? (PROGRESS_TONES[status] ?? "accent") : "accent"}
      label={label}
      {...props}
    />
  );
});
