"use client";

import * as React from "react";
import { cn, variant } from "../lib/cn.js";
import { FIELD_PAD_X, fieldBox, isAriaInvalid, type FieldSize } from "./Input.js";

/* ------------------------------------------------------------------ *
 * Textarea — the field box from Input.tsx, opened up vertically.
 *
 * Auto-grow is done with a hidden mirror in the same grid cell rather
 * than by measuring scrollHeight in an effect: the row is sized during
 * layout, so there is no reflow-per-keystroke and no first-paint jump.
 * ------------------------------------------------------------------ */

export interface TextareaProps extends Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "size"
> {
  size?: FieldSize;
  invalid?: boolean;
  /** Monospace face — config fragments, keys, log excerpts. */
  mono?: boolean;
  /** Grows with its content instead of scrolling. */
  autoGrow?: boolean;
  /** Cap for `autoGrow`; the field scrolls beyond it. */
  maxRows?: number;
  /** Applied to the field box rather than the <textarea>. */
  boxClassName?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    boxClassName,
    size = "sm",
    invalid,
    mono = false,
    autoGrow = false,
    maxRows,
    rows = 3,
    value,
    defaultValue,
    onChange,
    disabled,
    style,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const isInvalid = invalid ?? isAriaInvalid(ariaInvalid);
  const [uncontrolled, setUncontrolled] = React.useState(() => String(defaultValue ?? ""));
  const text = value !== undefined ? String(value) : uncontrolled;

  /* py-1.5 top and bottom; `lh` resolves against the field's own line box. */
  const cap: React.CSSProperties | undefined = maxRows
    ? { maxHeight: `calc(${maxRows}lh + 0.75rem)` }
    : undefined;

  const inner = cn(
    "w-full min-w-0 bg-transparent py-1.5 text-[inherit] outline-none",
    "placeholder:text-[var(--kn-text-3)] disabled:cursor-not-allowed",
    variant(FIELD_PAD_X, size, "sm"),
    mono && "font-mono",
  );

  const field = (
    <textarea
      ref={ref}
      rows={rows}
      disabled={disabled}
      value={value}
      defaultValue={defaultValue}
      aria-invalid={isInvalid || undefined}
      style={{ ...cap, ...style }}
      onChange={(event) => {
        if (value === undefined) setUncontrolled(event.currentTarget.value);
        onChange?.(event);
      }}
      className={cn(
        inner,
        autoGrow
          ? cn(
              "col-start-1 row-start-1 resize-none",
              maxRows ? "overflow-y-auto" : "overflow-hidden",
            )
          : "resize-y",
        className,
      )}
      {...props}
    />
  );

  return (
    <div
      className={cn(
        fieldBox({
          size,
          control: "textarea",
          invalid: isInvalid,
          padded: false,
          fixedHeight: false,
        }),
        "items-stretch",
        boxClassName,
      )}
    >
      {autoGrow ? (
        <div className="grid w-full">
          {field}
          <span
            aria-hidden
            style={cap}
            className={cn(
              inner,
              "invisible col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words",
            )}
          >
            {/* Zero-width space so a trailing newline still occupies a row. */}
            {text + "\u200B"}
          </span>
        </div>
      ) : (
        field
      )}
    </div>
  );
});
