"use client";

import * as React from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Label, FormField, FieldRow, Fieldset.
 *
 * FormField owns the accessibility wiring so no call site has to
 * invent ids: it generates them, points `htmlFor` at the control and
 * clones the child with `id`, `aria-describedby` and `aria-invalid`.
 * The child *is* the control — wrapping it in a div moves the wiring
 * to the div, which is the one thing to know about this component.
 * ------------------------------------------------------------------ */

function joinIds(...ids: Array<string | null | undefined | false>): string | undefined {
  const list = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return list.length > 0 ? list.join(" ") : undefined;
}

/* --------------------------------- Label -------------------------------- */

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  /** Tertiary weight for table filters and toolbar controls. */
  muted?: boolean;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { className, required = false, muted = false, children, ...props },
  ref,
) {
  return (
    <label
      ref={ref}
      className={cn(
        "select-none font-medium",
        muted ? "text-sm text-[var(--kn-text-2)]" : "text-[var(--kn-text)]",
        className,
      )}
      {...props}
    >
      {children}
      {required && (
        <>
          <span aria-hidden className="ml-0.5 text-[var(--kn-danger)]">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      )}
    </label>
  );
});

/* ------------------------------- wiring --------------------------------- */

interface ControlWiring {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

/** Injects the wiring into the child, never clobbering what it already sets. */
function wireControl(child: React.ReactNode, wiring: ControlWiring): React.ReactNode {
  if (!React.isValidElement(child)) return child;
  const childProps = (child.props ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = {
    id: (childProps.id as string | undefined) ?? wiring.id,
    "aria-describedby": joinIds(
      childProps["aria-describedby"] as string | undefined,
      wiring.describedBy,
    ),
  };
  if (wiring.invalid && childProps["aria-invalid"] === undefined) next["aria-invalid"] = true;
  if (wiring.required && childProps.required === undefined) next.required = true;
  if (wiring.disabled && childProps.disabled === undefined) next.disabled = true;
  return React.cloneElement(child as React.ReactElement<Record<string, unknown>>, next);
}

function Description({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-sm text-[var(--kn-text-2)]">
      {children}
    </p>
  );
}

function ErrorText({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1 text-sm text-[var(--kn-danger)]">
      <CircleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
      {children}
    </p>
  );
}

/* ------------------------------- FormField ------------------------------ */

export interface FormFieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** Present means invalid: the control gets `aria-invalid` and the text gets `role="alert"`. */
  error?: React.ReactNode;
  /** Right-aligned note on the label line — a character count, a unit, a link. */
  hint?: React.ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** The control. Receives id / aria-describedby / aria-invalid / required / disabled. */
  children: React.ReactNode;
}

export const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(function FormField(
  {
    className,
    label,
    description,
    error,
    hint,
    required = false,
    disabled = false,
    id,
    children,
    ...props
  },
  ref,
) {
  const generated = React.useId();
  const controlId = id ?? `${generated}field`;
  const descriptionId = `${generated}desc`;
  const errorId = `${generated}err`;

  const control = wireControl(children, {
    id: controlId,
    describedBy: joinIds(description ? descriptionId : null, error ? errorId : null),
    invalid: Boolean(error),
    required,
    disabled,
  });

  return (
    <div ref={ref} className={cn("flex flex-col gap-1.5", className)} {...props}>
      {(label !== undefined || hint !== undefined) && (
        <div className="flex items-baseline justify-between gap-2">
          {label !== undefined ? (
            <Label htmlFor={controlId} required={required}>
              {label}
            </Label>
          ) : (
            <span />
          )}
          {hint !== undefined && <span className="text-sm text-[var(--kn-text-3)]">{hint}</span>}
        </div>
      )}
      {control}
      {description !== undefined && <Description id={descriptionId}>{description}</Description>}
      {error !== undefined && <ErrorText id={errorId}>{error}</ErrorText>}
    </div>
  );
});

/* -------------------------------- FieldRow ------------------------------ */

export interface FieldRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Off for the last row in a settings group. */
  divided?: boolean;
  children: React.ReactNode;
}

/** Horizontal label/control pairing for dense settings pages. */
export const FieldRow = React.forwardRef<HTMLDivElement, FieldRowProps>(function FieldRow(
  {
    className,
    label,
    description,
    error,
    required = false,
    disabled = false,
    divided = true,
    id,
    children,
    ...props
  },
  ref,
) {
  const generated = React.useId();
  const controlId = id ?? `${generated}field`;
  const descriptionId = `${generated}desc`;
  const errorId = `${generated}err`;

  const control = wireControl(children, {
    id: controlId,
    describedBy: joinIds(description ? descriptionId : null, error ? errorId : null),
    invalid: Boolean(error),
    required,
    disabled,
  });

  return (
    <div
      ref={ref}
      className={cn(
        "flex items-start justify-between gap-4 py-2",
        divided && "border-b border-[var(--kn-border-subtle)] last:border-b-0",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-0.5 py-0.5">
        <Label htmlFor={controlId} required={required}>
          {label}
        </Label>
        {description !== undefined && <Description id={descriptionId}>{description}</Description>}
        {error !== undefined && <ErrorText id={errorId}>{error}</ErrorText>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
});

/* -------------------------------- Fieldset ------------------------------ */

export interface FieldsetProps extends React.FieldsetHTMLAttributes<HTMLFieldSetElement> {
  legend?: React.ReactNode;
  description?: React.ReactNode;
}

export const Fieldset = React.forwardRef<HTMLFieldSetElement, FieldsetProps>(function Fieldset(
  { className, legend, description, children, ...props },
  ref,
) {
  return (
    <fieldset ref={ref} className={cn("m-0 min-w-0 border-0 p-0", className)} {...props}>
      {legend !== undefined && (
        <legend
          className={cn(
            "p-0 text-md font-medium text-[var(--kn-text)]",
            description !== undefined ? "mb-1" : "mb-3",
          )}
        >
          {legend}
        </legend>
      )}
      {description !== undefined && (
        <p className="mb-3 text-sm text-[var(--kn-text-2)]">{description}</p>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </fieldset>
  );
});
