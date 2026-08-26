"use client";

import * as React from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Portal } from "./Portal.js";
import { Button, IconButton } from "./Button.js";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Toast — transient confirmation, stacked bottom-right.
 *
 * Host-touching mutations do NOT toast a result (KD-008): they return a
 * job. What a toast carries is the acknowledgement plus a link into the
 * job that now owns the outcome.
 * ------------------------------------------------------------------ */

export type ToastVariant = "info" | "success" | "warning" | "error";

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

const MAX_VISIBLE = 4;

const ICONS: Record<ToastVariant, IconComponent> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const ACCENTS: Record<ToastVariant, string> = {
  info: "text-[var(--kn-info)]",
  success: "text-[var(--kn-ok)]",
  warning: "text-[var(--kn-warn)]",
  error: "text-[var(--kn-danger)]",
};

const BARS: Record<ToastVariant, string> = {
  info: "bg-[var(--kn-info)]",
  success: "bg-[var(--kn-ok)]",
  warning: "bg-[var(--kn-warn)]",
  error: "bg-[var(--kn-danger)]",
};

/** Errors are pinned: an operator who missed one has no other trace of it. */
const DURATIONS: Record<ToastVariant, number> = {
  info: 5000,
  success: 5000,
  warning: 8000,
  error: 0,
};

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastJobLink {
  /** Job id, rendered in mono. */
  id: string;
  href?: string;
  onClick?: () => void;
  label?: string;
}

export interface ToastOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** ms. 0 pins the toast until it is dismissed. */
  duration?: number;
  action?: ToastAction;
  job?: ToastJobLink;
}

export interface ToastRecord extends ToastOptions {
  id: string;
}

/* -------------------------------- Toast -------------------------------- */

export interface ToastProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
  action?: ToastAction;
  job?: ToastJobLink;
  onDismiss?: () => void;
}

export const Toast = React.forwardRef<HTMLDivElement, ToastProps>(function Toast(
  {
    className,
    title,
    description,
    variant: v = "info",
    duration,
    action,
    job,
    onDismiss,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    ...props
  },
  ref,
) {
  const barRef = React.useRef<HTMLDivElement | null>(null);
  const pausedRef = React.useRef(false);
  const dismissRef = React.useRef(onDismiss);
  const life = duration ?? DURATIONS[v];
  const Icon = ICONS[v];

  React.useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  React.useEffect(() => {
    if (life <= 0) return;

    let frame = 0;
    let last = performance.now();
    let remaining = life;

    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      if (!pausedRef.current) remaining -= delta;
      // Written straight to the node: a state update per frame would
      // re-render the whole stack sixty times a second.
      if (barRef.current) {
        barRef.current.style.transform = `scaleX(${Math.max(remaining / life, 0)})`;
      }
      if (remaining <= 0) {
        dismissRef.current?.();
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [life]);

  const shortJobId = job?.id.slice(0, 8);

  return (
    <div
      ref={ref}
      role={v === "error" ? "alert" : "status"}
      aria-atomic="true"
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        pausedRef.current = true;
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        pausedRef.current = false;
      }}
      onFocus={(event) => {
        onFocus?.(event);
        pausedRef.current = true;
      }}
      onBlur={(event) => {
        onBlur?.(event);
        pausedRef.current = false;
      }}
      className={cn(
        "relative overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)]",
        "bg-[var(--kn-surface-2)] p-3 text-base shadow-[var(--kn-shadow-md)]",
        "animate-[var(--animate-rise)]",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-2">
        <span className="flex h-5 shrink-0 items-center">
          <Icon size={14} className={variant(ACCENTS, v, "info")} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[var(--kn-text)]">{title}</p>
          {description !== undefined && description !== null && (
            <p className="mt-1 text-sm text-[var(--kn-text-2)]">{description}</p>
          )}
          {(action || job) && (
            <div className="mt-2 flex items-center gap-3">
              {action && (
                <Button variant="link" size="xs" onClick={action.onClick}>
                  {action.label}
                </Button>
              )}
              {job &&
                (job.href ? (
                  <a
                    href={job.href}
                    className={cn(
                      "inline-flex items-center gap-1 text-xs text-[var(--kn-accent-400)]",
                      "underline-offset-2 hover:underline",
                    )}
                  >
                    {job.label ?? "View job"}
                    <span className="font-mono text-[var(--kn-text-3)]">{shortJobId}</span>
                    <ArrowUpRight size={12} aria-hidden />
                  </a>
                ) : (
                  <Button
                    variant="link"
                    size="xs"
                    iconRight={ArrowUpRight}
                    onClick={job.onClick}
                    className="gap-1"
                  >
                    {job.label ?? "View job"}
                    <span className="font-mono text-[var(--kn-text-3)]">{shortJobId}</span>
                  </Button>
                ))}
            </div>
          )}
        </div>
        {onDismiss && <IconButton icon={X} label="Dismiss" size="xs" onClick={onDismiss} />}
      </div>
      {life > 0 && (
        <div
          ref={barRef}
          aria-hidden
          className={cn("absolute inset-x-0 bottom-0 h-px origin-left", variant(BARS, v, "info"))}
        />
      )}
    </div>
  );
});

/* ---------------------------- ToastProvider ---------------------------- */

interface ToastContextValue {
  /** Queues a toast and returns its id. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

let sequence = 0;

export interface ToastProviderProps {
  children: React.ReactNode;
  /** Newest N stay on screen; older ones drop off the top of the stack. */
  max?: number;
}

export function ToastProvider({ children, max = MAX_VISIBLE }: ToastProviderProps) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      sequence += 1;
      const id = `kn-toast-${sequence}`;
      setToasts((prev) => [...prev, { ...options, id }].slice(-max));
      return id;
    },
    [max],
  );

  const context = React.useMemo<ToastContextValue>(() => ({ toast, dismiss }), [dismiss, toast]);

  return (
    <ToastContext.Provider value={context}>
      {children}
      <Portal>
        <ol
          aria-label="Notifications"
          className={cn(
            // Above dialogs and drawers: a failure must not be hidden by
            // the modal that caused it.
            "pointer-events-none fixed bottom-0 right-0 z-[60]",
            "flex w-full max-w-sm flex-col gap-2 p-4",
          )}
        >
          {toasts.map((entry) => (
            <li key={entry.id} className="pointer-events-auto">
              <Toast
                title={entry.title}
                description={entry.description}
                variant={entry.variant}
                duration={entry.duration}
                action={entry.action}
                job={entry.job}
                onDismiss={() => dismiss(entry.id)}
              />
            </li>
          ))}
        </ol>
      </Portal>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
