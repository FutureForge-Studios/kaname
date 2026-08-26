"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { IconButton } from "./Button.js";

/* ------------------------------------------------------------------ *
 * Input — and the field primitives the rest of the kit is built from.
 *
 * Every text-like control (Input, Textarea, Select, Combobox) renders
 * the same "field box": a bordered surface that owns border, radius,
 * height, padding and the focus ring, wrapping a transparent native
 * control. That is what keeps a <select> pixel-identical to an <input>
 * without the same class string living in four files, and it is why
 * leading icons and trailing slots need no magic padding.
 * ------------------------------------------------------------------ */

export type FieldSize = "xs" | "sm" | "md";

/** Which native element sits inside the box — the focus ring targets it. */
export type FieldControl = "input" | "select" | "textarea";

export const FIELD_ICON_SIZES: Record<FieldSize, number> = { xs: 12, sm: 14, md: 14 };

export const FIELD_PAD_X: Record<FieldSize, string> = { xs: "px-2", sm: "px-2.5", md: "px-3" };
export const FIELD_PAD_R: Record<FieldSize, string> = { xs: "pr-2", sm: "pr-2.5", md: "pr-3" };
export const FIELD_HEIGHTS: Record<FieldSize, string> = { xs: "h-6", sm: "h-7", md: "h-8" };
export const FIELD_MIN_HEIGHTS: Record<FieldSize, string> = {
  xs: "min-h-6",
  sm: "min-h-7",
  md: "min-h-8",
};

const FIELD_TEXT: Record<FieldSize, string> = { xs: "text-xs", sm: "text-sm", md: "text-base" };
const FIELD_RADIUS: Record<FieldSize, string> = {
  xs: "rounded-[var(--kn-r-sm)]",
  sm: "rounded-[var(--kn-r-sm)]",
  md: "rounded-[var(--kn-r-md)]",
};
const FIELD_GAP: Record<FieldSize, string> = { xs: "gap-1.5", sm: "gap-1.5", md: "gap-2" };

/* The ring is scoped to the native control so a trailing button inside
 * the box shows its own ring instead of lighting up the whole field. */
const FIELD_RING: Record<FieldControl, string> = {
  input:
    "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-[var(--kn-ring)]",
  select:
    "has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-1 has-[select:focus-visible]:outline-[var(--kn-ring)]",
  textarea:
    "has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-1 has-[textarea:focus-visible]:outline-[var(--kn-ring)]",
};
const FIELD_RING_INVALID: Record<FieldControl, string> = {
  input:
    "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-[var(--kn-danger)]",
  select:
    "has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-offset-1 has-[select:focus-visible]:outline-[var(--kn-danger)]",
  textarea:
    "has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-1 has-[textarea:focus-visible]:outline-[var(--kn-danger)]",
};

export interface FieldBoxOptions {
  size?: FieldSize;
  control?: FieldControl;
  invalid?: boolean;
  /** Off when the inner control owns its padding (Select, Textarea). */
  padded?: boolean;
  /** Off for controls that grow with their content (Textarea, multi Combobox). */
  fixedHeight?: boolean;
}

/** The shared field surface. Composed, never overridden, by every field. */
export function fieldBox({
  size = "sm",
  control = "input",
  invalid = false,
  padded = true,
  fixedHeight = true,
}: FieldBoxOptions = {}): string {
  return cn(
    "relative flex w-full min-w-0 items-center border bg-[var(--kn-surface-2)] text-[var(--kn-text)]",
    "transition-[background-color,border-color,color,opacity] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
    "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
    invalid
      ? "border-[var(--kn-danger)] hover:border-[var(--kn-danger)]"
      : "border-[var(--kn-border)] hover:border-[var(--kn-border-strong)] has-[:disabled]:hover:border-[var(--kn-border)]",
    variant(invalid ? FIELD_RING_INVALID : FIELD_RING, control, "input"),
    variant(FIELD_TEXT, size, "sm"),
    variant(FIELD_RADIUS, size, "sm"),
    variant(FIELD_GAP, size, "sm"),
    fixedHeight && variant(FIELD_HEIGHTS, size, "sm"),
    padded && variant(FIELD_PAD_X, size, "sm"),
  );
}

/** The bare native control inside a field box. */
export const FIELD_CONTROL =
  "min-w-0 flex-1 bg-transparent text-[inherit] outline-none placeholder:text-[var(--kn-text-3)] disabled:cursor-not-allowed";

/** Lets a component keep its own node while still honouring a forwarded ref. */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as { current: T | null }).current = node;
    }
  };
}

/**
 * React remembers the last value it wrote to an input; assigning `.value`
 * directly leaves that tracker stale and `onChange` never fires. Going
 * through the prototype setter is what makes a clear button work for
 * controlled parents as well as uncontrolled ones.
 */
export function setNativeInputValue(el: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function isAriaInvalid(value: React.AriaAttributes["aria-invalid"]): boolean {
  return value === true || value === "true";
}

/* --------------------------------- Input -------------------------------- */

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: FieldSize;
  /** Leading glyph, sized from the field. lucide only. */
  icon?: React.ComponentType<{ size?: number | string; className?: string }>;
  /** Trailing slot: a unit suffix, a copy button, a spinner. */
  trailing?: React.ReactNode;
  invalid?: boolean;
  /** Monospace face — every IP, port, path, hash and unit name. */
  mono?: boolean;
  /** Applied to the field box rather than the <input>. */
  boxClassName?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    boxClassName,
    size = "sm",
    icon: Icon,
    trailing,
    invalid,
    mono = false,
    disabled,
    type = "text",
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const isInvalid = invalid ?? isAriaInvalid(ariaInvalid);

  return (
    <div className={cn(fieldBox({ size, invalid: isInvalid }), boxClassName)}>
      {Icon && (
        <Icon
          size={FIELD_ICON_SIZES[size]}
          className="pointer-events-none shrink-0 text-[var(--kn-text-3)]"
          aria-hidden
        />
      )}
      <input
        ref={ref}
        type={type}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        className={cn(FIELD_CONTROL, mono && "font-mono", className)}
        {...props}
      />
      {trailing && (
        <span className="flex shrink-0 items-center gap-1 text-[var(--kn-text-3)]">{trailing}</span>
      )}
    </div>
  );
});

/* ------------------------------ SearchInput ----------------------------- */

export interface SearchInputProps extends Omit<
  InputProps,
  "icon" | "trailing" | "type" | "invalid"
> {
  /** Trailing slot for a shortcut hint — typically a <Kbd>. */
  hint?: React.ReactNode;
  /** Fired after the field is cleared; `onChange` fires too. */
  onClear?: () => void;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    {
      className,
      hint,
      onClear,
      size = "sm",
      placeholder = "Search",
      value,
      defaultValue,
      onChange,
      onKeyDown,
      disabled,
      ...props
    },
    ref,
  ) {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    const setRefs = React.useMemo(() => mergeRefs<HTMLInputElement>(ref, innerRef), [ref]);
    const [filled, setFilled] = React.useState(
      () => String(defaultValue ?? value ?? "").length > 0,
    );

    React.useEffect(() => {
      if (value !== undefined) setFilled(String(value).length > 0);
    }, [value]);

    const clear = React.useCallback(() => {
      const el = innerRef.current;
      if (el) {
        setNativeInputValue(el, "");
        el.focus();
      }
      setFilled(false);
      onClear?.();
    }, [onClear]);

    return (
      <Input
        ref={setRefs}
        type="search"
        size={size}
        icon={Search}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        defaultValue={defaultValue}
        onChange={(event) => {
          setFilled(event.currentTarget.value.length > 0);
          onChange?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && filled) {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
          onKeyDown?.(event);
        }}
        className={cn("[&::-webkit-search-cancel-button]:hidden", className)}
        trailing={
          <>
            {filled && !disabled && (
              <IconButton icon={X} label="Clear search" size="xs" onClick={clear} />
            )}
            {hint}
          </>
        }
        {...props}
      />
    );
  },
);
