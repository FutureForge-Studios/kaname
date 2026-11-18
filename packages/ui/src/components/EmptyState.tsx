"use client";

import * as React from "react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * EmptyState.
 *
 * One icon in a plain hairline tile, one line of explanation, one
 * obvious next step. No illustration — an empty table on an operations panel is
 * a routine state, not an event.
 * ------------------------------------------------------------------ */

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

export type EmptyStateSize = "sm" | "md";

const PADDING: Record<EmptyStateSize, string> = {
  sm: "px-4 py-6",
  md: "px-6 py-10",
};

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: IconComponent;
  title: React.ReactNode;
  /** One sentence. If it needs two, the page needs a doc link instead. */
  description?: React.ReactNode;
  /** Primary action, normally a `<Button variant="primary">`. */
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  size?: EmptyStateSize;
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  {
    icon: Icon,
    title,
    description,
    action,
    secondaryAction,
    size = "md",
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center text-center",
        variant(PADDING, size, "md"),
        className,
      )}
      {...props}
    >
      {Icon && (
        <span
          aria-hidden
          className={cn(
            "mb-4 inline-flex items-center justify-center rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)] text-[var(--kn-text-2)]",
            size === "sm" ? "h-9 w-9" : "h-12 w-12",
          )}
        >
          <Icon size={size === "sm" ? 16 : 20} />
        </span>
      )}
      <p className={cn("kn-title text-[var(--kn-text)]", size === "md" && "text-md")}>{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-pretty text-sm text-[var(--kn-text-2)]">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
      {children}
    </div>
  );
});
