"use client";

import * as React from "react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Layout — Separator, ScrollArea, Stack, Inline.
 *
 * Spacing is a closed set on the 4px grid. Passing a number instead of
 * a Tailwind class is what keeps `gap-[7px]` out of the product: there
 * is no way to express it.
 * ------------------------------------------------------------------ */

export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12;
export type LayoutAlign = "start" | "center" | "end" | "stretch" | "baseline";
export type LayoutJustify = "start" | "center" | "end" | "between";

const GAPS: Record<Space, string> = {
  0: "gap-0",
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
  10: "gap-10",
  12: "gap-12",
};

const ALIGNS: Record<LayoutAlign, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
  baseline: "items-baseline",
};

const JUSTIFIES: Record<LayoutJustify, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};

/* ------------------------------ Separator ------------------------------ */

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  /** Decorative separators are hidden from assistive tech. Default true. */
  decorative?: boolean;
}

export const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(function Separator(
  { className, orientation = "horizontal", decorative = true, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "shrink-0 bg-[var(--kn-border)]",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className,
      )}
      {...props}
    />
  );
});

/* ------------------------------ ScrollArea ----------------------------- */

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal" | "both";
  /** Names the region. Long log and table panes should always have one. */
  label?: string;
}

/**
 * Styled native overflow — not a virtual scroller. The scrollbar itself
 * is themed once, globally, in tokens.css; virtualization belongs to
 * LogViewer and DataTable, which know their row height.
 */
export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { className, orientation = "vertical", label, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      role={label ? "region" : undefined}
      aria-label={label}
      // Focusable so a keyboard user can scroll a pane that contains no
      // controls of its own.
      tabIndex={0}
      className={cn(
        "min-h-0 min-w-0 overscroll-contain outline-none",
        orientation === "vertical" && "overflow-y-auto overflow-x-hidden",
        orientation === "horizontal" && "overflow-x-auto overflow-y-hidden",
        orientation === "both" && "overflow-auto",
        className,
      )}
      {...props}
    />
  );
});

/* -------------------------------- Stack -------------------------------- */

export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: Space;
  align?: LayoutAlign;
  justify?: LayoutJustify;
}

export const Stack = React.forwardRef<HTMLDivElement, StackProps>(function Stack(
  { className, gap = 2, align = "stretch", justify = "start", ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex min-w-0 flex-col",
        GAPS[gap],
        variant(ALIGNS, align, "stretch"),
        variant(JUSTIFIES, justify, "start"),
        className,
      )}
      {...props}
    />
  );
});

/* -------------------------------- Inline ------------------------------- */

export interface InlineProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: Space;
  align?: LayoutAlign;
  justify?: LayoutJustify;
  wrap?: boolean;
}

export const Inline = React.forwardRef<HTMLDivElement, InlineProps>(function Inline(
  { className, gap = 2, align = "center", justify = "start", wrap = false, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex min-w-0 flex-row",
        wrap ? "flex-wrap" : "flex-nowrap",
        GAPS[gap],
        variant(ALIGNS, align, "center"),
        variant(JUSTIFIES, justify, "start"),
        className,
      )}
      {...props}
    />
  );
});
