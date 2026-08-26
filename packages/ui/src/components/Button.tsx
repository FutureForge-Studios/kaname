"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Button — the reference implementation for this kit.
 *
 * Conventions every other component follows:
 *   - forwardRef, native props extended, `className` merged last
 *   - variants resolved through `variant()` against a frozen map
 *   - only token-backed utilities; no hex, no arbitrary spacing
 *   - transitions limited to colors/opacity/transform at --kn-dur
 *   - disabled and loading are visually and semantically distinct
 * ------------------------------------------------------------------ */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-subtle" | "link";
export type ButtonSize = "xs" | "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--kn-accent-600)] text-[var(--kn-accent-fg)] border border-[var(--kn-accent-600)] hover:bg-[var(--kn-accent-500)] hover:border-[var(--kn-accent-500)] active:bg-[var(--kn-accent-700)]",
  secondary:
    "bg-[var(--kn-surface-2)] text-[var(--kn-text)] border border-[var(--kn-border)] hover:bg-[var(--kn-surface-3)] hover:border-[var(--kn-border-strong)] active:bg-[var(--kn-surface-2)]",
  ghost:
    "bg-transparent text-[var(--kn-text-2)] border border-transparent hover:bg-[var(--kn-surface-2)] hover:text-[var(--kn-text)] active:bg-[var(--kn-surface-3)]",
  danger:
    "bg-[var(--kn-danger)] text-white border border-[var(--kn-danger)] hover:opacity-90 active:opacity-100",
  "danger-subtle":
    "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)] border border-transparent hover:bg-[var(--kn-danger-soft)] hover:border-[var(--kn-danger)]",
  link: "bg-transparent border border-transparent text-[var(--kn-accent-400)] hover:underline underline-offset-2 px-0",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-6 px-2 gap-1 text-xs rounded-[var(--kn-r-sm)]",
  sm: "h-7 px-2.5 gap-1.5 text-sm rounded-[var(--kn-r-sm)]",
  md: "h-8 px-3 gap-1.5 text-base rounded-[var(--kn-r-md)]",
};

const ICON_SIZES: Record<ButtonSize, number> = { xs: 12, sm: 14, md: 14 };

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps width stable, and blocks activation. */
  loading?: boolean;
  /** Rendered before the label at the size-matched icon dimension. */
  icon?: React.ComponentType<{ size?: number | string; className?: string }>;
  iconRight?: React.ComponentType<{ size?: number | string; className?: string }>;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant: v = "secondary",
    size = "sm",
    loading = false,
    icon: Icon,
    iconRight: IconRight,
    fullWidth = false,
    disabled,
    children,
    type = "button",
    ...props
  },
  ref,
) {
  const iconSize = ICON_SIZES[size];
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-[background-color,border-color,color,opacity] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant(VARIANTS, v, "secondary"),
        variant(SIZES, size, "sm"),
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2
          size={iconSize}
          className="animate-[var(--animate-spin-slow)] shrink-0"
          aria-hidden
        />
      ) : (
        Icon && <Icon size={iconSize} className="shrink-0" aria-hidden />
      )}
      {children}
      {IconRight && !loading && <IconRight size={iconSize} className="shrink-0" aria-hidden />}
    </button>
  );
});

/* ------------------------------ IconButton ------------------------------ */

export interface IconButtonProps extends Omit<ButtonProps, "icon" | "iconRight" | "children"> {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  /** Required: this is the accessible name. */
  label: string;
}

const ICON_BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: "h-6 w-6 rounded-[var(--kn-r-sm)]",
  sm: "h-7 w-7 rounded-[var(--kn-r-sm)]",
  md: "h-8 w-8 rounded-[var(--kn-r-md)]",
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, className, variant: v = "ghost", size = "sm", loading, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "transition-[background-color,border-color,color,opacity] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant(VARIANTS, v, "ghost"),
        ICON_BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <Loader2
          size={ICON_SIZES[size]}
          className="animate-[var(--animate-spin-slow)]"
          aria-hidden
        />
      ) : (
        <Icon size={ICON_SIZES[size]} aria-hidden />
      )}
    </button>
  );
});

/* ------------------------------ ButtonGroup ----------------------------- */

export function ButtonGroup({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center [&>*:not(:first-child)]:rounded-l-none [&>*:not(:last-child)]:rounded-r-none",
        "[&>*:not(:first-child)]:-ml-px",
        className,
      )}
    >
      {children}
    </div>
  );
}
