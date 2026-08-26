"use client";

import * as React from "react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Switch — a checkbox carrying role="switch".
 *
 * Built on the native input rather than a <button> so that Space and
 * Enter, form participation, `:checked` styling and the label
 * association all come from the platform. The track is the input
 * itself; the thumb is an inert sibling driven by `peer-checked`.
 * ------------------------------------------------------------------ */

export type SwitchSize = "sm" | "md";

const TRACK_SIZES: Record<SwitchSize, string> = { sm: "h-4 w-7", md: "h-5 w-9" };
const THUMB_SIZES: Record<SwitchSize, string> = {
  sm: "h-3 w-3 peer-checked:translate-x-3",
  md: "h-4 w-4 peer-checked:translate-x-4",
};

export interface SwitchProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "size" | "type"
> {
  size?: SwitchSize;
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Applied to the wrapping <label> when `label` or `description` is set. */
  labelClassName?: string;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, label, description, labelClassName, size = "sm", disabled, ...props },
  ref,
) {
  const hasLabel = label !== undefined || description !== undefined;

  const control = (
    <span
      className={cn(
        "relative inline-flex shrink-0",
        description && "mt-0.5",
        !hasLabel && "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        disabled={disabled}
        className={cn(
          "peer shrink-0 cursor-pointer appearance-none rounded-[var(--kn-r-sm)] border",
          "border-[var(--kn-border-strong)] bg-[var(--kn-surface-3)]",
          "checked:border-[var(--kn-accent-600)] checked:bg-[var(--kn-accent-600)]",
          "transition-[background-color,border-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
          "disabled:cursor-not-allowed",
          variant(TRACK_SIZES, size, "sm"),
          className,
        )}
        {...props}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0.5 top-0.5 rounded-[var(--kn-r-xs)]",
          "bg-[var(--kn-text-2)] peer-checked:bg-[var(--kn-accent-fg)]",
          "transition-[transform,background-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          variant(THUMB_SIZES, size, "sm"),
        )}
      />
    </span>
  );

  if (!hasLabel) return control;

  return (
    <label
      className={cn(
        "inline-flex gap-2",
        description ? "items-start" : "items-center",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        labelClassName,
      )}
    >
      {control}
      <span className="flex min-w-0 flex-col gap-0.5">
        {label !== undefined && <span className="leading-5 text-[var(--kn-text)]">{label}</span>}
        {description !== undefined && (
          <span className="text-sm text-[var(--kn-text-2)]">{description}</span>
        )}
      </span>
    </label>
  );
});
