"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Badge, StatusBadge, Tag, Dot
 *
 * `Tone` is the kit-wide semantic scale. Every other component that
 * colour-codes state imports it from here instead of declaring its own,
 * so "warn" means the same thing in a badge, a metric and a job pill.
 *
 * StatusBadge is the only pill-shaped element in the product. Everything
 * else stays on the 6/8/10px radius scale.
 * ------------------------------------------------------------------ */

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";
export type BadgeSize = "xs" | "sm";

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

const CHIP_TONES: Record<Tone, string> = {
  neutral: "bg-[var(--kn-neutral-soft)] text-[var(--kn-text-2)]",
  ok: "bg-[var(--kn-ok-soft)] text-[var(--kn-ok)]",
  warn: "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)]",
  danger: "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
  info: "bg-[var(--kn-info-soft)] text-[var(--kn-info)]",
  accent: "bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]",
};

const DOT_FILL_TONES: Record<Tone, string> = {
  neutral: "bg-[var(--kn-text-3)]",
  ok: "bg-[var(--kn-ok)]",
  warn: "bg-[var(--kn-warn)]",
  danger: "bg-[var(--kn-danger)]",
  info: "bg-[var(--kn-info)]",
  accent: "bg-[var(--kn-accent-500)]",
};

const DOT_RING_TONES: Record<Tone, string> = {
  neutral: "border-[var(--kn-text-3)]",
  ok: "border-[var(--kn-ok)]",
  warn: "border-[var(--kn-warn)]",
  danger: "border-[var(--kn-danger)]",
  info: "border-[var(--kn-info)]",
  accent: "border-[var(--kn-accent-500)]",
};

/* --------------------------------- Dot --------------------------------- */

export type DotSize = "sm" | "md";

const DOT_SIZES: Record<DotSize, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
};

export interface DotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: DotSize;
  /** Slow opacity pulse. Reserved for "something is still in motion". */
  pulse?: boolean;
  /** Ring instead of fill — reads as "not present" rather than "bad". */
  hollow?: boolean;
  /** Give the dot a name when it stands alone in a table cell. */
  label?: string;
}

export const Dot = React.forwardRef<HTMLSpanElement, DotProps>(function Dot(
  { tone = "neutral", size = "sm", pulse = false, hollow = false, label, className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-block shrink-0 rounded-[var(--kn-r-pill)]",
        variant(DOT_SIZES, size, "sm"),
        hollow
          ? cn("border bg-transparent", variant(DOT_RING_TONES, tone, "neutral"))
          : variant(DOT_FILL_TONES, tone, "neutral"),
        pulse && "animate-[kn-pulse-ring_1.8s_ease-in-out_infinite]",
        className,
      )}
      {...props}
    />
  );
});

/* -------------------------------- Badge -------------------------------- */

const BADGE_SIZES: Record<BadgeSize, string> = {
  xs: "h-4 gap-1 px-1 text-2xs",
  sm: "h-5 gap-1 px-1.5 text-xs",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: BadgeSize;
  icon?: IconComponent;
  /** For counts, versions and identifiers. */
  mono?: boolean;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = "neutral", size = "sm", icon: Icon, mono = false, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex max-w-full select-none items-center whitespace-nowrap rounded-[var(--kn-r-sm)] font-medium",
        variant(CHIP_TONES, tone, "neutral"),
        variant(BADGE_SIZES, size, "sm"),
        mono && "kn-mono",
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={12} className="shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
    </span>
  );
});

/* ----------------------------- StatusBadge ----------------------------- */

const STATUS_SIZES: Record<BadgeSize, string> = {
  xs: "h-4 gap-1 px-1.5 text-2xs",
  sm: "h-5 gap-1.5 px-2 text-xs",
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: BadgeSize;
  /** Replaces the dot. Sized 12 to sit inside the 16/20px pill. */
  icon?: IconComponent;
  pulse?: boolean;
  hollow?: boolean;
}

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(function StatusBadge(
  {
    tone = "neutral",
    size = "sm",
    icon: Icon,
    pulse = false,
    hollow = false,
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex max-w-full select-none items-center whitespace-nowrap rounded-[var(--kn-r-pill)] font-medium",
        variant(CHIP_TONES, tone, "neutral"),
        variant(STATUS_SIZES, size, "sm"),
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon size={12} className="shrink-0" aria-hidden />
      ) : (
        <Dot tone={tone} pulse={pulse} hollow={hollow} />
      )}
      {children != null && <span className="truncate">{children}</span>}
    </span>
  );
});

/* --------------------------------- Tag --------------------------------- */

const TAG_SIZES: Record<BadgeSize, string> = {
  xs: "h-4 gap-1 pl-1 text-2xs",
  sm: "h-5 gap-1 pl-1.5 text-xs",
};

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: BadgeSize;
  /** Labels, capabilities and paths are technical strings. */
  mono?: boolean;
  /** Renders the remove affordance. Omit for a read-only chip. */
  onRemove?: () => void;
  /** Names the remove button, e.g. `Remove label env=prod`. */
  removeLabel?: string;
}

export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { size = "sm", mono = false, onRemove, removeLabel, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex max-w-full items-center whitespace-nowrap rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] text-[var(--kn-text)]",
        variant(TAG_SIZES, size, "sm"),
        onRemove ? "pr-0.5" : size === "xs" ? "pr-1" : "pr-1.5",
        mono && "kn-mono",
        className,
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? "Remove"}
          onClick={onRemove}
          className={cn(
            "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[var(--kn-r-xs)] text-[var(--kn-text-3)]",
            "transition-[background-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
            "hover:bg-[var(--kn-surface-3)] hover:text-[var(--kn-text)]",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
          )}
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </span>
  );
});
