"use client";

import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { isAriaInvalid, mergeRefs } from "./Input.js";

/* ------------------------------------------------------------------ *
 * Checkbox, Radio, RadioGroup.
 *
 * All three are real native inputs with `appearance-none`, styled by
 * :checked / :indeterminate rather than by React state. Uncontrolled
 * usage therefore needs no state at all, and a RadioGroup keeps the
 * arrow-key roving focus the platform already implements.
 * ------------------------------------------------------------------ */

export type ControlSize = "sm" | "md";

const BOX_SIZES: Record<ControlSize, string> = { sm: "h-4 w-4", md: "h-5 w-5" };
const MARK_SIZES: Record<ControlSize, number> = { sm: 12, md: 14 };
const DOT_SIZES: Record<ControlSize, string> = { sm: "h-1.5 w-1.5", md: "h-2 w-2" };

const CONTROL_BASE = cn(
  "peer shrink-0 appearance-none border bg-[var(--kn-surface-2)]",
  "transition-[background-color,border-color,opacity] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
  "disabled:cursor-not-allowed",
);

const MARK_BASE = cn(
  "pointer-events-none absolute inset-0 m-auto opacity-0",
  "transition-opacity duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
);

/** Dimming lives on the outermost node so it never stacks with the input's own. */
const OUTER_DISABLED = "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50";

interface LabelledControlProps {
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Applied to the wrapping <label> when `label` or `description` is set. */
  labelClassName?: string;
}

function borderFor(invalid: boolean): string {
  return invalid
    ? "border-[var(--kn-danger)]"
    : "border-[var(--kn-border-strong)] checked:border-[var(--kn-accent-600)]";
}

function Labelled({
  label,
  description,
  labelClassName,
  control,
}: LabelledControlProps & { control: React.ReactNode }) {
  return (
    <label
      className={cn(
        "inline-flex gap-2",
        description ? "items-start" : "items-center",
        OUTER_DISABLED,
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
}

/* -------------------------------- Checkbox ------------------------------- */

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "type">, LabelledControlProps {
  size?: ControlSize;
  /** Mixed state — sets the DOM property, not just the glyph. */
  indeterminate?: boolean;
  invalid?: boolean;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    className,
    label,
    description,
    labelClassName,
    size = "sm",
    indeterminate = false,
    invalid,
    disabled,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const setRefs = React.useMemo(() => mergeRefs<HTMLInputElement>(ref, innerRef), [ref]);
  const isInvalid = invalid ?? isAriaInvalid(ariaInvalid);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const Mark = indeterminate ? Minus : Check;
  const hasLabel = label !== undefined || description !== undefined;

  const control = (
    <span
      className={cn(
        "relative inline-flex shrink-0",
        description && "mt-0.5",
        !hasLabel && OUTER_DISABLED,
      )}
    >
      <input
        ref={setRefs}
        type="checkbox"
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        className={cn(
          CONTROL_BASE,
          "rounded-[var(--kn-r-xs)]",
          "checked:bg-[var(--kn-accent-600)] indeterminate:border-[var(--kn-accent-600)] indeterminate:bg-[var(--kn-accent-600)]",
          borderFor(isInvalid),
          variant(BOX_SIZES, size, "sm"),
          className,
        )}
        {...props}
      />
      <Mark
        size={MARK_SIZES[size]}
        aria-hidden
        strokeWidth={3}
        className={cn(
          MARK_BASE,
          "text-[var(--kn-accent-fg)]",
          indeterminate ? "opacity-100" : "peer-checked:opacity-100",
        )}
      />
    </span>
  );

  if (!hasLabel) return control;

  return (
    <Labelled
      label={label}
      description={description}
      labelClassName={labelClassName}
      control={control}
    />
  );
});

/* ------------------------------- RadioGroup ------------------------------ */

interface RadioGroupContextValue {
  name: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onChange" | "defaultValue"
> {
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
}

export const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  {
    className,
    name,
    value,
    defaultValue,
    onValueChange,
    orientation = "vertical",
    disabled,
    children,
    ...props
  },
  ref,
) {
  const autoName = React.useId();
  const context = React.useMemo<RadioGroupContextValue>(
    () => ({ name: name ?? autoName, value, defaultValue, onValueChange, disabled }),
    [name, autoName, value, defaultValue, onValueChange, disabled],
  );

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-orientation={orientation}
      className={cn(
        "flex",
        orientation === "horizontal" ? "flex-wrap items-center gap-4" : "flex-col gap-2",
        className,
      )}
      {...props}
    >
      <RadioGroupContext.Provider value={context}>{children}</RadioGroupContext.Provider>
    </div>
  );
});

/* --------------------------------- Radio --------------------------------- */

export interface RadioProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "type">, LabelledControlProps {
  size?: ControlSize;
  invalid?: boolean;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function Radio(
  {
    className,
    label,
    description,
    labelClassName,
    size = "sm",
    invalid,
    name,
    value,
    checked,
    defaultChecked,
    disabled,
    onChange,
    "aria-invalid": ariaInvalid,
    ...props
  },
  ref,
) {
  const group = React.useContext(RadioGroupContext);
  const isInvalid = invalid ?? isAriaInvalid(ariaInvalid);

  let resolvedChecked = checked;
  let resolvedDefault = defaultChecked;
  if (group) {
    if (group.value !== undefined) resolvedChecked = resolvedChecked ?? group.value === value;
    else if (group.defaultValue !== undefined)
      resolvedDefault = resolvedDefault ?? group.defaultValue === value;
  }

  const hasLabel = label !== undefined || description !== undefined;

  const control = (
    <span
      className={cn(
        "relative inline-flex shrink-0",
        description && "mt-0.5",
        !hasLabel && OUTER_DISABLED,
      )}
    >
      <input
        ref={ref}
        type="radio"
        name={name ?? group?.name}
        value={value}
        checked={resolvedChecked}
        defaultChecked={resolvedDefault}
        disabled={disabled ?? group?.disabled}
        aria-invalid={isInvalid || undefined}
        onChange={(event) => {
          if (event.currentTarget.checked && typeof value === "string") {
            group?.onValueChange?.(value);
          }
          onChange?.(event);
        }}
        className={cn(
          CONTROL_BASE,
          /* The circle is the only thing telling a radio from a checkbox at
           * 16px, so this is the one place a pill radius earns its keep. */
          "rounded-[var(--kn-r-pill)]",
          "checked:bg-[var(--kn-accent-600)]",
          borderFor(isInvalid),
          variant(BOX_SIZES, size, "sm"),
          className,
        )}
        {...props}
      />
      <span
        aria-hidden
        className={cn(
          MARK_BASE,
          "rounded-[var(--kn-r-pill)] bg-[var(--kn-accent-fg)] peer-checked:opacity-100",
          variant(DOT_SIZES, size, "sm"),
        )}
      />
    </span>
  );

  if (!hasLabel) return control;

  return (
    <Labelled
      label={label}
      description={description}
      labelClassName={labelClassName}
      control={control}
    />
  );
});
