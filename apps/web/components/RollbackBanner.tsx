"use client";

import * as React from "react";
import { AlertTriangle, ShieldAlert, ShieldCheck, TimerReset, X } from "lucide-react";
import { Badge, Button, CopyableCode, IconButton, cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * The rollback window.
 *
 * Two surfaces in this product can lock an operator out of the machine
 * they are administering — the firewall and sshd — and both are applied
 * with a window inside which the host reverts on its own. That window
 * is the single most important thing on the page while it is open, so
 * it is a persistent banner with a live countdown rather than a toast
 * that scrolls away, and the wording says what happens if the operator
 * does nothing, because doing nothing is the safe move.
 *
 * `LockoutNotice` is the same component before and after applying, so
 * the warning an operator reads in the confirmation dialog is literally
 * the warning they read in the banner.
 * ------------------------------------------------------------------ */

/** Shape returned by the firewall and sshd apply routes. */
export interface LockoutCheck {
  code: string;
  severity: "critical" | "warning";
  message: string;
  /** A rule to add, verbatim. Rendered as something to copy. */
  remediation: string;
}

export interface LockoutAssessment {
  locks_out: boolean;
  /** The address the control plane evaluated the rules against. */
  checked_from: string | null;
  checks: LockoutCheck[];
}

export interface LockoutNoticeProps {
  assessment: LockoutAssessment | null | undefined;
  /** Prefix for the heading, e.g. "This rule set". */
  subject: string;
  className?: string;
}

export function LockoutNotice({ assessment, subject, className }: LockoutNoticeProps) {
  if (!assessment || assessment.checks.length === 0) return null;

  const critical = assessment.checks.filter((check) => check.severity === "critical");
  const warnings = assessment.checks.filter((check) => check.severity !== "critical");
  const tone = critical.length > 0 ? "danger" : "warn";

  return (
    <div
      role={critical.length > 0 ? "alert" : "status"}
      className={cn(
        "rounded-[var(--kn-r-md)] border p-3",
        tone === "danger"
          ? "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]"
          : "border-[var(--kn-warn)] bg-[var(--kn-warn-soft)]",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert
          size={14}
          aria-hidden
          className={cn(
            "mt-0.5 shrink-0",
            tone === "danger" ? "text-[var(--kn-danger)]" : "text-[var(--kn-warn)]",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[var(--kn-text)]">
            {critical.length > 0
              ? `${subject} would lock you out.`
              : `${subject} has ${warnings.length === 1 ? "a warning" : `${warnings.length} warnings`}.`}
          </p>
          {assessment.checked_from && (
            <p className="mt-0.5 text-[var(--kn-text-2)]">
              Checked against{" "}
              <span className="kn-mono text-[var(--kn-text)]">{assessment.checked_from}</span>, the
              address this request came from.
            </p>
          )}

          <ul className="mt-2 flex flex-col gap-2">
            {[...critical, ...warnings].map((check) => (
              <li key={check.code} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={check.severity === "critical" ? "danger" : "warn"} size="xs" mono>
                    {check.code}
                  </Badge>
                  <span className="min-w-0 text-[var(--kn-text)]">{check.message}</span>
                </div>
                <CopyableCode value={check.remediation} label="Add this rule" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export interface RollbackWindow {
  serverId: string;
  serverName: string;
  /** What reverts, e.g. "firewall rule set". */
  subject: string;
  /** Window the host was given. Zero means it keeps whatever was applied. */
  seconds: number;
  /** Epoch milliseconds at which the host reverts. */
  expiresAt: number;
  /** The control plane's own sentence about what happens next. */
  summary: string;
  lockout: LockoutAssessment | null;
}

export interface RollbackBannerProps {
  window: RollbackWindow;
  /**
   * Cancels the pending revert. Omit for sshd, where the host verifies
   * the new configuration itself and there is nothing to confirm.
   */
  onConfirm?: () => void;
  confirming?: boolean;
  onDismiss: () => void;
  className?: string;
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function RollbackBanner({
  window: state,
  onConfirm,
  confirming = false,
  onDismiss,
  className,
}: RollbackBannerProps) {
  const [now, setNow] = React.useState(() => Date.now());
  const remaining = state.expiresAt - now;
  const open = state.seconds > 0 && remaining > 0;

  React.useEffect(() => {
    if (state.seconds === 0) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [state.seconds, state.expiresAt]);

  const tone = state.seconds === 0 ? "danger" : open ? "warn" : "neutral";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col gap-3 rounded-[var(--kn-r-md)] border p-3",
        tone === "danger" && "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]",
        tone === "warn" && "border-[var(--kn-warn)] bg-[var(--kn-warn-soft)]",
        tone === "neutral" && "border-[var(--kn-border-strong)] bg-[var(--kn-surface-2)]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)]",
            tone === "danger" && "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
            tone === "warn" && "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)]",
            tone === "neutral" && "bg-[var(--kn-neutral-soft)] text-[var(--kn-text-2)]",
          )}
        >
          {tone === "danger" ? (
            <AlertTriangle size={14} aria-hidden />
          ) : tone === "warn" ? (
            <TimerReset size={14} aria-hidden />
          ) : (
            <ShieldCheck size={14} aria-hidden />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="font-medium text-[var(--kn-text)]">
              {state.seconds === 0
                ? `No rollback window on ${state.serverName}.`
                : open
                  ? `${state.serverName} reverts its ${state.subject} in`
                  : `The rollback window on ${state.serverName} has closed.`}
            </p>
            {open && (
              <span
                className="kn-num text-xl font-medium leading-none text-[var(--kn-text)]"
                aria-label={`${countdown(remaining)} remaining`}
              >
                {countdown(remaining)}
              </span>
            )}
          </div>

          <p className="mt-1 text-[var(--kn-text-2)]">
            {open || state.seconds === 0
              ? state.summary
              : onConfirm
                ? `If you did not confirm inside the window, the previous ${state.subject} is already back. Refresh the status to see which set is live.`
                : `If the new ${state.subject} did not hold, the host has already reverted it. Refresh to see what is live.`}
          </p>

          {open && onConfirm && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" loading={confirming} onClick={onConfirm}>
                Confirm — keep these changes
              </Button>
              <span className="text-xs text-[var(--kn-text-3)]">
                Check that you can still reach {state.serverName} first. If you cannot, do nothing.
              </span>
            </div>
          )}
        </div>

        <IconButton icon={X} label="Dismiss" size="sm" onClick={onDismiss} />
      </div>

      <LockoutNotice assessment={state.lockout} subject={`The applied ${state.subject}`} />

      {open && (
        <p className="text-xs text-[var(--kn-text-3)]">
          The countdown runs in this browser tab. Closing it does not stop the host — the revert is
          the host&apos;s own timer.
        </p>
      )}
    </div>
  );
}
