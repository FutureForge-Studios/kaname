"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { FIELD_ICON_SIZES, FIELD_PAD_R, fieldBox, isAriaInvalid, type FieldSize } from "./Input.js";

/* ------------------------------------------------------------------ *
 * Select — a real <select> wearing the Input field box.
 *
 * Deliberately native: keyboard behaviour, type-ahead, mobile pickers
 * and form participation all come free, and the option list is drawn
 * by the platform in the right colour scheme because tokens.css sets
 * `color-scheme`. The element is stretched over the whole box so the
 * chevron area still opens it; only the chevron itself is inert.
 * ------------------------------------------------------------------ */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const SELECT_PAD: Record<FieldSize, string> = {
  xs: "pl-2 pr-6",
  sm: "pl-2.5 pr-7",
  md: "pl-3 pr-8",
};

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: FieldSize;
  invalid?: boolean;
  /** Monospace face — hostnames, unit names, engine versions. */
  mono?: boolean;
  /** Convenience list; `children` renders after it for optgroups. */
  options?: readonly SelectOption[];
  /** Rendered as a disabled empty-value option at the top. */
  placeholder?: string;
  /** Applied to the field box rather than the <select>. */
  boxClassName?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    boxClassName,
    size = "sm",
    invalid,
    mono = false,
    options,
    placeholder,
    disabled,
    children,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const isInvalid = invalid ?? isAriaInvalid(ariaInvalid);

  return (
    <div
      className={cn(
        fieldBox({ size, control: "select", invalid: isInvalid, padded: false }),
        boxClassName,
      )}
    >
      <select
        ref={ref}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        className={cn(
          "absolute inset-0 cursor-pointer appearance-none bg-transparent text-[inherit] outline-none",
          "disabled:cursor-not-allowed",
          variant(SELECT_PAD, size, "sm"),
          mono && "font-mono",
          className,
        )}
        {...props}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options?.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        size={FIELD_ICON_SIZES[size]}
        aria-hidden
        className={cn(
          "pointer-events-none ml-auto shrink-0 text-[var(--kn-text-3)]",
          variant(FIELD_PAD_R, size, "sm"),
        )}
      />
    </div>
  );
});
