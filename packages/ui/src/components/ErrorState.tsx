"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle } from "lucide-react";
import type { Remediation, RemediationAction } from "@kaname/contract";
import { cn } from "../lib/cn.js";
import { Badge } from "./Badge.js";
import { Button } from "./Button.js";
import { CopyButton } from "./Primitives.js";

/* ------------------------------------------------------------------ *
 * ErrorState, InlineError, CopyableCode.
 *
 * The API contract guarantees a machine `code` and a `remediation`
 * alongside every message, so this component never has to render
 * "something went wrong". An action carrying a literal `copy` value —
 * a DNS record, a shell command — becomes a copyable block rather than
 * a button, because the operator has to paste it somewhere else.
 * ------------------------------------------------------------------ */

type CopyAction = RemediationAction & { copy: string };

const HEAD_TONES = {
  danger: "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
  warn: "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)]",
} as const;

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Machine code from the error envelope, e.g. `agent_offline`. */
  code: string;
  /** The specific problem, e.g. "DNS record _acme-challenge.example.com not found". */
  message: string;
  remediation?: Remediation | null;
  /** Invoked with the whole action so the app can route `href` or dispatch `action`. */
  onAction?: (action: RemediationAction) => void;
  tone?: "danger" | "warn";
}

export const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  { code, message, remediation, onAction, tone = "danger", className, children, ...props },
  ref,
) {
  const actions = remediation?.actions ?? [];
  const copyActions = actions.filter(
    (action): action is CopyAction => typeof action.copy === "string" && action.copy.length > 0,
  );
  const buttonActions = actions.filter((action) => !action.copy);

  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        "rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-4",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)]",
            HEAD_TONES[tone],
          )}
        >
          <AlertTriangle size={14} aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-[var(--kn-text)]">{message}</p>
            <Badge tone={tone} size="xs" mono>
              {code}
            </Badge>
          </div>

          {remediation?.summary && (
            <p className="mt-1 text-[var(--kn-text-2)]">{remediation.summary}</p>
          )}

          {copyActions.map((action) => (
            <CopyableCode
              key={`${action.label}:${action.copy}`}
              label={action.label}
              value={action.copy}
              className="mt-2"
            />
          ))}

          {buttonActions.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {buttonActions.map((action, index) => (
                <Button
                  key={action.label}
                  variant={index === 0 ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => onAction?.(action)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}

          {children}
        </div>
      </div>
    </div>
  );
});

/* ------------------------------ InlineError ----------------------------- */

const INLINE_TONES = {
  danger: "text-[var(--kn-danger)]",
  warn: "text-[var(--kn-warn)]",
} as const;

export interface InlineErrorProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /** Field-level or row-level message. Keep it to one line. */
  message: React.ReactNode;
  tone?: "danger" | "warn";
  /** Hide the icon when the message already sits under a highlighted field. */
  icon?: boolean;
}

export const InlineError = React.forwardRef<HTMLParagraphElement, InlineErrorProps>(
  function InlineError({ message, tone = "danger", icon = true, className, ...props }, ref) {
    return (
      <p
        ref={ref}
        role="alert"
        className={cn("flex items-start gap-1 text-xs", INLINE_TONES[tone], className)}
        {...props}
      >
        {icon && <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden />}
        <span className="min-w-0">{message}</span>
      </p>
    );
  },
);

/* ----------------------------- CopyableCode ----------------------------- */

export interface CopyableCodeProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "onCopy"
> {
  /** The exact string the operator must paste. Never abbreviated. */
  value: string;
  label?: string;
  /** Preserve newlines and scroll sideways instead of wrapping. */
  block?: boolean;
}

export const CopyableCode = React.forwardRef<HTMLDivElement, CopyableCodeProps>(
  function CopyableCode({ value, label, block = false, className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)]",
          className,
        )}
        {...props}
      >
        {label && (
          <div className="border-b border-[var(--kn-border)] px-2 py-1 text-xs text-[var(--kn-text-2)]">
            {label}
          </div>
        )}
        <div className="flex items-start gap-2 py-1.5 pl-2 pr-1">
          <code
            className={cn(
              "kn-mono min-w-0 flex-1 select-all text-[var(--kn-text)]",
              block ? "block overflow-x-auto whitespace-pre" : "break-all",
            )}
          >
            {value}
          </code>
          <CopyButton value={value} label={label ? `Copy ${label}` : "Copy"} size="xs" />
        </div>
      </div>
    );
  },
);
