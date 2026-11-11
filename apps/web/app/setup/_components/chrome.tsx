"use client";

import * as React from "react";
import { ArrowRight, Check } from "lucide-react";
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
import { Button, Card, CardInset, Eyebrow, InlineError, MonoLabel, cn, formatIndex } from "@kaname/ui";
import { ApiError, api, isApiError } from "@/lib/api";
import { Hero, HeroSplit, StandaloneFrame } from "./frame";

/* ------------------------------------------------------------------ *
 * The wizard's chrome, in the ffstudios.io language.
 *
 * Each step is a hero and a card. The hero (left on a wide screen,
 * first on a phone) says what the step is in a tight headline whose
 * second line is the purple gradient, explains it in one muted
 * paragraph, and carries the numbered step rail — "01 INSTALL ───" —
 * that says where you are and what was answered. The card holds the
 * step itself: a <form>, so Enter is always "the primary action", whose
 * footer has exactly one filled pill on the right and, on optional
 * steps, a quiet way to leave it for later on the left.
 * ------------------------------------------------------------------ */

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

interface Progress {
  step?: SetupStep;
  outcomes?: SetupState["outcomes"];
}

const ProgressContext = React.createContext<Progress>({});

export function Frame({
  children,
  step,
  outcomes,
}: {
  children: React.ReactNode;
  step?: SetupStep;
  /** What each optional step was answered with, for the rail. */
  outcomes?: SetupState["outcomes"];
}) {
  // A new step starts at the top: the previous one may have been long.
  React.useEffect(() => {
    if (step) window.scrollTo({ top: 0 });
  }, [step]);

  const progress = React.useMemo(() => ({ step, outcomes }), [step, outcomes]);

  return (
    <StandaloneFrame caption="Setting up this installation">
      <ProgressContext.Provider value={progress}>{children}</ProgressContext.Provider>
    </StandaloneFrame>
  );
}

/**
 * The numbered rail. One line always says where you are in words
 * ("Step 6 of 11 · Backups"); on a wide screen the eleven steps are
 * listed under it, each with its number, a leader and what became of it.
 */
function StepRail({ current, outcomes }: { current: SetupStep; outcomes?: SetupState["outcomes"] }) {
  const index = SETUP_STEPS.indexOf(current);
  const total = SETUP_STEPS.length;

  return (
    <nav aria-label="Setup progress" className="flex min-w-0 flex-col gap-3">
      <div className="kn-label-sm flex min-w-0 items-center gap-3">
        <p className="m-0 min-w-0 truncate text-[var(--kn-text-2)]" aria-live="polite">
          <span className="kn-num text-[var(--kn-text)]">
            Step {index + 1} of {total}
          </span>
          <span className="text-[var(--kn-text-3)]"> · </span>
          {SETUP_STEP_LABELS[current]}
        </p>
        <span aria-hidden className="h-px min-w-6 flex-1 bg-[var(--kn-border-strong)]" />
      </div>

      <ol className="m-0 hidden list-none flex-col p-0 lg:flex">
        {SETUP_STEPS.map((step, i) => {
          const done = i < index;
          const active = i === index;
          const later = done && isOptionalSetupStep(step) && outcomes?.[step] === "skipped";
          return (
            <li
              key={step}
              className="kn-label-sm flex h-7 min-w-0 items-center gap-3"
              aria-current={active ? "step" : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  "kn-num shrink-0",
                  active ? "text-[var(--kn-accent-400)]" : "text-[var(--kn-text-3)]",
                )}
              >
                {formatIndex(i + 1)}
              </span>
              <span
                className={cn(
                  "shrink-0",
                  active
                    ? "text-[var(--kn-text)]"
                    : done
                      ? "text-[var(--kn-text-2)]"
                      : "text-[var(--kn-text-3)]",
                )}
              >
                <span className="sr-only">
                  {later ? "Left for later: " : done ? "Completed: " : active ? "Current: " : "Upcoming: "}
                </span>
                {SETUP_STEP_SHORT_LABELS[step]}
              </span>
              <span
                aria-hidden
                className={cn(
                  "h-px min-w-6 flex-1",
                  active ? "bg-[var(--kn-border-strong)]" : "bg-[var(--kn-border)]",
                )}
              />
              <span aria-hidden className="flex shrink-0 items-center text-[var(--kn-text-3)] empty:hidden">
                {later ? (
                  "Later"
                ) : done ? (
                  <Check size={12} className="text-[var(--kn-accent-400)]" />
                ) : active ? (
                  <span className="h-1.5 w-2 rounded-[1px] bg-[var(--kn-accent-500)]" />
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      {index < total - 1 && (
        <p className="m-0 hidden text-sm text-[var(--kn-text-3)] lg:block">
          Close the tab whenever you like. Setup picks up where you left it.
        </p>
      )}
    </nav>
  );
}

/**
 * One step's layout: its heading as the hero with the rail under it,
 * and the step's card beside (below, on a phone).
 */
export function StepShell({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  const { step, outcomes } = React.useContext(ProgressContext);
  return (
    <HeroSplit
      hero={
        <>
          {heading}
          {step && <StepRail current={step} outcomes={outcomes} />}
        </>
      }
    >
      <Card radius="xl" padding="lg">
        {children}
      </Card>
    </HeroSplit>
  );
}

/**
 * A step is a form: Enter submits the primary action, and the first
 * field (or, on a screen without one, the primary button) takes focus
 * when the step appears.
 */
export function StepForm({
  heading,
  onSubmit,
  children,
  className,
}: {
  /** The step's `<StepHeading>`; it renders as the hero, outside the card. */
  heading: React.ReactNode;
  onSubmit: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <StepShell heading={heading}>
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
    </StepShell>
  );
}

/**
 * The step's headline. `accent` names the trailing words of `title`
 * that take the gradient second line; the heading's text stays exactly
 * `title`, so it reads (and is found) as one phrase.
 */
export function StepHeading({
  title,
  accent,
  hint,
  icon,
}: {
  title: string;
  accent?: string;
  hint?: React.ReactNode;
  icon?: IconComponent;
}) {
  const { step } = React.useContext(ProgressContext);
  const split = accent && title.endsWith(accent) && title.length > accent.length;
  return (
    <Hero
      eyebrow={
        <>
          <Eyebrow icon={icon}>Setup</Eyebrow>
          {step && isOptionalSetupStep(step) && (
            <Eyebrow tone="neutral" marker={false}>
              Optional
            </Eyebrow>
          )}
        </>
      }
      title={split ? title.slice(0, title.length - accent.length).trimEnd() : title}
      accent={split ? accent : undefined}
      lede={hint}
    />
  );
}

/** "What this needs" — said plainly, before anything starts. */
export function Needs({ title = "Before you start", items }: { title?: string; items: React.ReactNode[] }) {
  return (
    <CardInset className="px-4 py-3">
      <MonoLabel as="p" size="xs" tone="muted" className="m-0">
        {title}
      </MonoLabel>
      <ul className="m-0 mt-2 flex list-disc flex-col gap-1 pl-4 text-sm text-[var(--kn-text-2)] marker:text-[var(--kn-text-3)]">
        {items.map((entry, i) => (
          <li key={i}>{entry}</li>
        ))}
      </ul>
    </CardInset>
  );
}

export function Note({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <p
      className={cn(
        "m-0 rounded-[var(--kn-r-md)] border px-4 py-3 text-sm text-[var(--kn-text-2)]",
        tone === "warn"
          ? "border-[var(--kn-warn)] bg-[var(--kn-warn-soft)]"
          : "border-[var(--kn-border-subtle)] bg-[var(--kn-bg-inset)]",
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
        <p className="m-0 mt-1 text-sm text-[var(--kn-text-2)]">{error.remediation.summary}</p>
      )}
    </div>
  );
}

/** The hairline row that closes a step's card: quiet things left, the pill right. */
export function StepActions({ start, children }: { start?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kn-border)] pt-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">{start}</div>
      {children}
    </div>
  );
}

/**
 * The bottom of every step: the one primary action on the right, and on
 * optional steps a quiet "later" on the left. `primaryAutoFocus` is for
 * screens with no field to land on. An `icon` of ArrowRight is the
 * forward action and gets the kit's nudging arrow.
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
  icon?: IconComponent;
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
  const forward = icon === ArrowRight;

  return (
    <StepActions
      start={
        <>
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
        </>
      }
    >
      <Button
        type="submit"
        variant="primary"
        size="lg"
        arrow={forward && !pending}
        iconRight={forward ? undefined : icon}
        loading={pending}
        ref={primaryRef}
        disabled={blocked}
        onMouseDown={keepFocus}
      >
        {primary}
      </Button>
    </StepActions>
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
