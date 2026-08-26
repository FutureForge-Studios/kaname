"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import type { Tone } from "./Badge.js";

/* ------------------------------------------------------------------ *
 * Spinner, Progress, Skeleton.
 *
 * Loading states mirror the shape of what is loading. A dense table
 * renders SkeletonRows at the real row height so the page does not
 * reflow when data lands; a generic centred spinner is the fallback of
 * last resort, not the default.
 * ------------------------------------------------------------------ */

export type SpinnerSize = 12 | 14 | 16;

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /** Announced to screen readers. Omit only when adjacent text says it. */
  label?: string;
}

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { size = 14, label, className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex shrink-0 items-center text-[var(--kn-text-2)]", className)}
      {...props}
    >
      <Loader2 size={size} className="animate-[var(--animate-spin-slow)]" aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
});

/* ------------------------------- Progress ------------------------------- */

export type ProgressSize = "xs" | "sm";

const TRACK_SIZES: Record<ProgressSize, string> = {
  xs: "h-0.5",
  sm: "h-1",
};

const BAR_TONES: Record<Tone, string> = {
  neutral: "bg-[var(--kn-text-3)]",
  ok: "bg-[var(--kn-ok)]",
  warn: "bg-[var(--kn-warn)]",
  danger: "bg-[var(--kn-danger)]",
  info: "bg-[var(--kn-info)]",
  accent: "bg-[var(--kn-accent-500)]",
};

const BAR_TEXT_TONES: Record<Tone, string> = {
  neutral: "text-[var(--kn-text-3)]",
  ok: "text-[var(--kn-ok)]",
  warn: "text-[var(--kn-warn)]",
  danger: "text-[var(--kn-danger)]",
  info: "text-[var(--kn-info)]",
  accent: "text-[var(--kn-accent-500)]",
};

export interface ProgressProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** null or undefined renders the indeterminate treatment. */
  value?: number | null;
  max?: number;
  size?: ProgressSize;
  tone?: Tone;
  /** Required: a bare bar tells a screen reader nothing. */
  label: string;
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value, max = 100, size = "xs", tone = "accent", label, className, ...props },
  ref,
) {
  const numeric = value != null && Number.isFinite(value) ? Number(value) : null;
  const clamped = numeric === null ? 0 : Math.min(Math.max(numeric, 0), max);

  return (
    <div
      ref={ref}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={numeric === null ? undefined : Math.round(clamped)}
      className={cn(
        "w-full overflow-hidden bg-[var(--kn-border)]",
        variant(TRACK_SIZES, size, "xs"),
        className,
      )}
      {...props}
    >
      {numeric !== null ? (
        <div
          className={cn(
            "h-full w-full origin-left transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)]",
            variant(BAR_TONES, tone, "accent"),
          )}
          style={{ transform: `scaleX(${max > 0 ? clamped / max : 0})` }}
        />
      ) : (
        /* Stripes rather than a travelling block: the bar still reads as
           "working, length unknown" when prefers-reduced-motion stops it. */
        <div
          className={cn(
            "h-full w-full animate-[kn-pulse-ring_1.4s_ease-in-out_infinite]",
            variant(BAR_TEXT_TONES, tone, "accent"),
          )}
          style={{
            backgroundImage:
              "repeating-linear-gradient(115deg, currentColor 0 8px, transparent 8px 16px)",
          }}
        />
      )}
    </div>
  );
});

/* ------------------------------- Skeleton ------------------------------- */

const SHIMMER = "animate-[kn-shimmer_1.2s_ease-in-out_infinite_alternate]";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Names the loading region. Without it the placeholder is decorative. */
  label?: string;
}

export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(function Skeleton(
  { label, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("rounded-[var(--kn-r-sm)] bg-[var(--kn-surface-3)]", SHIMMER, className)}
      {...props}
    />
  );
});

export interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  lines?: number;
  label?: string;
}

export const SkeletonText = React.forwardRef<HTMLDivElement, SkeletonTextProps>(
  function SkeletonText({ lines = 3, label, className, ...props }, ref) {
    return (
      <div
        ref={ref}
        role={label ? "status" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
        className={cn("flex flex-col gap-1.5", className)}
        {...props}
      >
        {Array.from({ length: Math.max(1, lines) }, (_, index) => (
          <div
            key={index}
            className={cn(
              "h-3 rounded-[var(--kn-r-xs)] bg-[var(--kn-surface-3)]",
              SHIMMER,
              index === lines - 1 && lines > 1 ? "w-1/2" : "w-full",
            )}
          />
        ))}
      </div>
    );
  },
);

/** Widths cycle so a skeleton table looks like data, not a bar chart. */
const CELL_WIDTHS = ["w-40", "w-24", "w-32", "w-16", "w-28", "w-20"] as const;

export interface SkeletonRowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Cell count of the table this row stands in for. */
  cols?: number;
  dense?: boolean;
  leading?: "none" | "dot" | "avatar";
  label?: string;
}

export const SkeletonRow = React.forwardRef<HTMLDivElement, SkeletonRowProps>(function SkeletonRow(
  { cols = 4, dense = false, leading = "none", label, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-3",
        dense ? "h-[var(--kn-row-h-compact)]" : "h-[var(--kn-row-h)]",
        className,
      )}
      {...props}
    >
      {leading === "dot" && (
        <div
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-[var(--kn-r-pill)] bg-[var(--kn-surface-3)]",
            SHIMMER,
          )}
        />
      )}
      {leading === "avatar" && (
        <div
          className={cn(
            "h-5 w-5 shrink-0 rounded-[var(--kn-r-sm)] bg-[var(--kn-surface-3)]",
            SHIMMER,
          )}
        />
      )}
      {Array.from({ length: Math.max(1, cols) }, (_, index) => (
        <div
          key={index}
          className={cn(
            "h-3 rounded-[var(--kn-r-xs)] bg-[var(--kn-surface-3)]",
            SHIMMER,
            index === cols - 1
              ? "ml-auto w-12"
              : (CELL_WIDTHS[index % CELL_WIDTHS.length] ?? "w-24"),
          )}
        />
      ))}
    </div>
  );
});
