"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import type { AppInstall, AppInstallStatus, AppInstallStep, AppInstallStepStatus } from "@kaname/contract";
import {
  CheckItem,
  CheckList,
  StatusBadge,
  StatusLine,
  type CheckItemState,
  type Tone,
} from "@kaname/ui";
import { formatDuration } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * The provisioning checklist.
 *
 * Reads `install.steps`, which the job writes as each step starts and
 * ends, so this is the same truth the job log tells — in sentences.
 * Each row carries a status pill so the colour still means status; the
 * circle on the left is the ffstudios check mark.
 * ------------------------------------------------------------------ */

const STEP_STATE: Record<AppInstallStepStatus, CheckItemState> = {
  pending: "todo",
  running: "current",
  done: "done",
  warn: "warning",
  failed: "failed",
  rolled_back: "todo",
};

const STEP_TONE: Record<AppInstallStepStatus, Tone> = {
  pending: "neutral",
  running: "accent",
  done: "ok",
  warn: "warn",
  failed: "danger",
  rolled_back: "neutral",
};

const STEP_LABEL: Record<AppInstallStepStatus, string> = {
  pending: "Waiting",
  running: "Working",
  done: "Done",
  warn: "Done, with a warning",
  failed: "Failed",
  rolled_back: "Undone",
};

// The kit draws the warning triangle and the failure cross itself.
const STEP_ICON: Partial<Record<AppInstallStepStatus, typeof RotateCcw>> = {
  rolled_back: RotateCcw,
};

export const INSTALL_STATUS: Record<AppInstallStatus, { tone: Tone; label: string }> = {
  queued: { tone: "info", label: "Queued" },
  installing: { tone: "accent", label: "Installing" },
  active: { tone: "ok", label: "Running" },
  failed: { tone: "danger", label: "Failed" },
  rolling_back: { tone: "warn", label: "Undoing" },
  removing: { tone: "warn", label: "Removing" },
};

function stepDuration(step: AppInstallStep): string | null {
  if (!step.started_at || !step.finished_at) return null;
  const ms = Date.parse(step.finished_at) - Date.parse(step.started_at);
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : null;
}

export interface InstallProgressProps {
  install: AppInstall;
  className?: string;
}

export function InstallProgress({ install, className }: InstallProgressProps) {
  return (
    <CheckList divided="between" className={className} aria-label="Provisioning steps">
      {install.steps.map((step) => {
        const duration = stepDuration(step);
        return (
          <CheckItem
            key={step.id}
            data-testid={`install-step-${step.id}`}
            data-status={step.status}
            state={STEP_STATE[step.status]}
            icon={STEP_ICON[step.status]}
            title={step.title}
            description={step.description}
            action={
              <>
                {duration && (
                  <span className="kn-mono text-xs text-[var(--kn-text-3)]">{duration}</span>
                )}
                <StatusBadge
                  size="xs"
                  tone={STEP_TONE[step.status]}
                  pulse={step.status === "running"}
                  hollow={step.status === "pending" || step.status === "rolled_back"}
                >
                  {STEP_LABEL[step.status]}
                </StatusBadge>
              </>
            }
          >
            {step.message && (
              <p
                className={
                  step.status === "failed"
                    ? "m-0 mt-1 text-sm text-[var(--kn-danger)]"
                    : step.status === "warn"
                      ? "m-0 mt-1 text-sm text-[var(--kn-warn)]"
                      : "m-0 mt-1 text-sm text-[var(--kn-text-2)]"
                }
              >
                {step.message}
              </p>
            )}
          </CheckItem>
        );
      })}
    </CheckList>
  );
}

/** One sentence for the whole install, for a StatusLine. */
export function InstallSummary({ install }: { install: AppInstall }) {
  const done = install.steps.filter((s) => s.status === "done" || s.status === "warn").length;
  const total = install.steps.length;
  const running = install.steps.find((s) => s.status === "running");
  const { tone } = INSTALL_STATUS[install.status];

  let sentence: string;
  switch (install.status) {
    case "queued":
      sentence = "Waiting for the server to pick up the job";
      break;
    case "installing":
      sentence = running ? `${running.title} · ${done} of ${total} done` : `${done} of ${total} done`;
      break;
    case "active":
      sentence = install.steps.some((s) => s.status === "warn")
        ? `Installed with a warning · ${install.url}`
        : `Installed and answering at ${install.url}`;
      break;
    case "failed":
      sentence = install.error?.message ?? "The install failed and what it created was undone";
      break;
    case "rolling_back":
      sentence = "A step failed · undoing what this install created";
      break;
    case "removing":
      sentence = "Removing the site, its files and its database";
      break;
  }

  return (
    <StatusLine tone={tone} pulse={IN_FLIGHT_STATUSES.has(install.status)}>
      {sentence}
    </StatusLine>
  );
}

const IN_FLIGHT_STATUSES: ReadonlySet<AppInstallStatus> = new Set([
  "queued",
  "installing",
  "rolling_back",
  "removing",
]);
