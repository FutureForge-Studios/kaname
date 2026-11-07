"use client";

import * as React from "react";
import {
  SETUP_STEPS,
  SETUP_STEP_LABELS,
  SETUP_STEP_SHORT_LABELS,
  isOptionalSetupStep,
  type OptionalSetupStep,
  type SetupState,
  type SetupStep,
  type SetupStepOutcome,
} from "@kaname/contract";
import { Badge, Button, InlineError, cn } from "@kaname/ui";
import { ApiError, api, isApiError } from "@/lib/api";
import { Wordmark } from "@/components/Logo";

/* ------------------------------------------------------------------ *
 * The wizard's chrome: one calm column, a step indicator that says
 * where you are in words ("Step 6 of 11 · Backups"), and a card per
 * step whose footer always holds exactly one primary action on the
 * right and, on optional steps, a quiet way to leave it for later on
 * the left. Every step is a <form>, so Enter is always "the primary
 * action" and nothing has to reinvent that.
 * ------------------------------------------------------------------ */

export function Frame({ children, step }: { children: React.ReactNode; step?: SetupStep }) {
  // A new step starts at the top: the previous one may have been long.
  React.useEffect(() => {
    if (step) window.scrollTo({ top: 0 });
  }, [step]);

  return (
    <main className="flex min-h-dvh justify-center px-4 py-10 sm:py-16">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Wordmark size={28} />
          <p className="text-[var(--kn-text-3)]">Setting up this installation</p>
        </div>

        {step && <Stepper current={step} />}
        {children}
      </div>
    </main>
  );
}

function Stepper({ current }: { current: SetupStep }) {
  const index = SETUP_STEPS.indexOf(current);
  const total = SETUP_STEPS.length;
  const optional = isOptionalSetupStep(current);

  return (
    <nav aria-label="Setup progress" className="mb-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-sm text-[var(--kn-text-2)]" aria-live="polite">
          <span className="kn-num text-[var(--kn-text)]">
            Step {index + 1} of {total}
          </span>
          <span className="text-[var(--kn-text-3)]"> · </span>
          {SETUP_STEP_LABELS[current]}
        </p>
        {optional && (
          <Badge tone="neutral" size="xs">
            Optional
          </Badge>
        )}
      </div>

      <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}>
        {SETUP_STEPS.map((step, i) => {
          const done = i < index;
          const active = i === index;
          return (
            <li
              key={step}
              className="flex min-w-0 flex-col gap-1.5"
              aria-current={active ? "step" : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  "h-1 w-full rounded-full transition-colors duration-[var(--kn-dur)]",
                  done && "bg-[var(--kn-accent-500)]",
                  active && "bg-[var(--kn-accent-400)]",
                  !done && !active && "bg-[var(--kn-surface-3)]",
                )}
              />
              <span
                className={cn(
                  "hidden truncate text-center text-xs sm:block",
                  active ? "text-[var(--kn-text)]" : "text-[var(--kn-text-3)]",
                )}
              >
                <span className="sr-only">
                  {done ? "Completed: " : active ? "Current: " : "Upcoming: "}
                </span>
                {SETUP_STEP_SHORT_LABELS[step]}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-6 shadow-[var(--kn-shadow-sm)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A step is a form: Enter submits the primary action, and the first
 * field (or, on a screen without one, the primary button) takes focus
 * when the step appears.
 */
export function StepForm({
  onSubmit,
  children,
  className,
}: {
  onSubmit: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card>
      <form
        noValidate
        className={cn("flex flex-col gap-5", className)}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    </Card>
  );
}

export function StepHeading({
  title,
  hint,
  icon: Icon,
}: {
  title: string;
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
}) {
  return (
    <div className="flex items-start gap-3">
      {Icon && (
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]">
          <Icon size={14} aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <h1 className="text-xl font-medium tracking-tight text-[var(--kn-text)]">{title}</h1>
        {hint && <p className="mt-1 text-[var(--kn-text-2)]">{hint}</p>}
      </div>
    </div>
  );
}

/** "What this needs" — said plainly, before anything starts. */
export function Needs({ title = "Before you start", items }: { title?: string; items: React.ReactNode[] }) {
  return (
    <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-4 py-3">
      <p className="text-sm font-medium text-[var(--kn-text)]">{title}</p>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-sm text-[var(--kn-text-2)] marker:text-[var(--kn-text-3)]">
        {items.map((entry, i) => (
          <li key={i}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

export function Note({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <p
      className={cn(
        "rounded-[var(--kn-r-md)] border px-4 py-3 text-sm text-[var(--kn-text-2)]",
        tone === "warn"
          ? "border-[var(--kn-warn)] bg-[var(--kn-warn-soft)]"
          : "border-[var(--kn-border)] bg-[var(--kn-surface-2)]",
      )}
    >
      {children}
    </p>
  );
}

export function StepError({ error, exclude = [] }: { error: ApiError | null; exclude?: string[] }) {
  if (!error) return null;
  // Field-level messages are already rendered under their inputs.
  const onlyFieldErrors =
    error.fieldEntries.length > 0 && error.fieldEntries.every(([key]) => exclude.includes(key));
  if (onlyFieldErrors) return null;
  return (
    <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-danger)] bg-[var(--kn-danger-soft)] px-4 py-3">
      <InlineError message={error.message} icon={false} className="text-base" />
      {error.remediation?.summary && (
        <p className="mt-1 text-sm text-[var(--kn-text-2)]">{error.remediation.summary}</p>
      )}
    </div>
  );
}

/**
 * The bottom of every step: the one primary action on the right, and on
 * optional steps a quiet "later" on the left. `primaryAutoFocus` is for
 * screens with no field to land on.
 */
export function StepFooter({
  primary,
  pending = false,
  disabled = false,
  primaryAutoFocus = false,
  icon,
  later,
  laterLabel = "Set up later",
  laterPending = false,
  aside,
}: {
  primary: string;
  pending?: boolean;
  disabled?: boolean;
  primaryAutoFocus?: boolean;
  icon?: React.ComponentType<{ size?: number | string; className?: string }>;
  later?: () => void;
  laterLabel?: string;
  laterPending?: boolean;
  aside?: React.ReactNode;
}) {
  const primaryRef = React.useRef<HTMLButtonElement>(null);
  const blocked = disabled || laterPending;
  // A disabled button cannot take focus on mount, so a screen whose
  // primary action unlocks a moment later (health arriving, a list
  // loading) focuses it then — unless the operator has already moved.
  React.useEffect(() => {
    if (!primaryAutoFocus || blocked) return;
    const active = document.activeElement;
    if (!active || active === document.body) primaryRef.current?.focus();
  }, [primaryAutoFocus, blocked]);

  /*
   * Pressing a footer button must not blur the focused field first: the
   * blur shows that field's error, the footer moves down, and the mouse is
   * released off the button, so the click never lands. Keeping focus where
   * it is leaves keyboard use untouched; the submit then shows every error.
   */
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kn-border)] pt-5">
      <div className="flex min-w-0 items-center gap-2">
        {later && (
          <Button
            type="button"
            variant="ghost"
            size="md"
            loading={laterPending}
            disabled={pending}
            onMouseDown={keepFocus}
            onClick={later}
          >
            {laterLabel}
          </Button>
        )}
        {aside}
      </div>
      <Button
        type="submit"
        variant="primary"
        size="md"
        iconRight={icon}
        loading={pending}
        ref={primaryRef}
        disabled={blocked}
        onMouseDown={keepFocus}
      >
        {primary}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Step plumbing
 * ------------------------------------------------------------------ */

export interface StepProps {
  state: SetupState;
  onAdvance: (next: SetupState) => void;
  onStale: () => void;
}

/**
 * Runs one request on behalf of a step: pending flag, the error to show
 * and, when the refusal means this tab's picture is out of date, a
 * re-read of /setup/state so the right screen comes back.
 */
export function useStepAction(onStale: () => void) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const run = React.useCallback(
    async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await work();
      } catch (err) {
        const failure = toError(err);
        setError(failure);
        if (isStale(failure)) onStale();
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [onStale],
  );

  return { pending, error, setError, run };
}

/** Records an optional step's answer and moves on. */
export function useAnswer({ onAdvance, onStale }: Omit<StepProps, "state">, step: OptionalSetupStep) {
  const action = useStepAction(onStale);
  const answer = React.useCallback(
    async (outcome: SetupStepOutcome) => {
      const next = await action.run(() =>
        api.post<SetupState>(`/setup/steps/${step}`, { outcome }),
      );
      if (next) onAdvance(next);
    },
    [action, onAdvance, step],
  );
  return { ...action, answer };
}

export function toError(err: unknown): ApiError {
  return isApiError(err)
    ? err
    : new ApiError({ code: "internal_error", message: String(err), status: 0 });
}

/**
 * A refusal that means the state this tab rendered from is no longer
 * true — the setup cookie or token lapsed, or somebody else finished —
 * so the page re-reads it and the right screen comes back instead of a
 * dead end with a form that cannot succeed.
 */
export function isStale(error: ApiError): boolean {
  return error.code === "unauthenticated" || (error.code === "conflict" && isSetupConflict(error));
}

/*
 * Only the setup routes' own conflicts mean "this flow moved on". A
 * module route's conflict ("a site called that already exists") is an
 * answer about the form, and re-reading state for it would just blink.
 */
function isSetupConflict(error: ApiError): boolean {
  return /set up|already exists on this instance/i.test(error.message);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
