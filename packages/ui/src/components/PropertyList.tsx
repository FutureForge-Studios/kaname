"use client";

import * as React from "react";
import { Pencil } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { IconButton } from "./Button.js";
import { CopyButton } from "./Primitives.js";

/* ------------------------------------------------------------------ *
 * PropertyList / PropertyRow — the key/value display on every detail
 * page and in every metadata rail.
 *
 * Keys are muted and share a fixed column so values line up down the
 * list; values stay selectable because operators copy them by hand as
 * often as they click. Copy and edit affordances only appear on hover
 * or keyboard focus, so a read-only list stays quiet.
 * ------------------------------------------------------------------ */

export type PropertyLabelWidth = "sm" | "md" | "lg";

const LABEL_WIDTHS: Record<PropertyLabelWidth, string> = {
  sm: "sm:grid-cols-[112px_minmax(0,1fr)]",
  md: "sm:grid-cols-[136px_minmax(0,1fr)]",
  lg: "sm:grid-cols-[176px_minmax(0,1fr)]",
};

interface PropertyListContextValue {
  labelWidth: PropertyLabelWidth;
  dense: boolean;
}

const PropertyListContext = React.createContext<PropertyListContextValue>({
  labelWidth: "md",
  dense: false,
});

export interface PropertyListProps extends React.HTMLAttributes<HTMLDListElement> {
  labelWidth?: PropertyLabelWidth;
  /** 30px rows instead of 36px, for the metadata rail. */
  dense?: boolean;
}

export const PropertyList = React.forwardRef<HTMLDListElement, PropertyListProps>(
  function PropertyList({ labelWidth = "md", dense = false, className, children, ...props }, ref) {
    const context = React.useMemo(() => ({ labelWidth, dense }), [labelWidth, dense]);
    return (
      <PropertyListContext.Provider value={context}>
        <dl ref={ref} className={cn("m-0", className)} {...props}>
          {children}
        </dl>
      </PropertyListContext.Provider>
    );
  },
);

export interface PropertyRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  label: string;
  /** Explains the key itself, e.g. what `cert_serial` is. */
  hint?: string;
  /** Paths, hostnames, hashes and unit names. */
  mono?: boolean;
  /** Exact string to put on the clipboard. Reveals an inline copy button. */
  copyValue?: string;
  /** Reveals the edit affordance; wire it to an InlineEdit or a dialog. */
  onEdit?: () => void;
  /** Rendered when there is no value. */
  empty?: string;
}

export const PropertyRow = React.forwardRef<HTMLDivElement, PropertyRowProps>(function PropertyRow(
  { label, hint, mono = false, copyValue, onEdit, empty = "—", className, children, ...props },
  ref,
) {
  const { labelWidth, dense } = React.useContext(PropertyListContext);
  const isEmpty = children == null || children === "";

  return (
    <div
      ref={ref}
      className={cn(
        "group grid grid-cols-1 items-center gap-x-3 border-t border-[var(--kn-border-subtle)] first:border-t-0",
        variant(LABEL_WIDTHS, labelWidth, "md"),
        dense ? "py-1" : "py-2",
        className,
      )}
      {...props}
    >
      <dt className="truncate text-[var(--kn-text-2)]" title={hint}>
        {label}
      </dt>
      <dd className="m-0 flex min-h-5 min-w-0 items-center gap-1">
        <span
          className={cn(
            "min-w-0 select-text break-words",
            mono && "kn-mono",
            isEmpty && "text-[var(--kn-text-3)]",
          )}
        >
          {isEmpty ? empty : children}
        </span>
        {(copyValue || onEdit) && (
          <span
            className={cn(
              "ml-auto flex shrink-0 items-center gap-0.5 opacity-0",
              "transition-opacity duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
              "group-hover:opacity-100 group-focus-within:opacity-100",
            )}
          >
            {copyValue && <CopyButton value={copyValue} label={`Copy ${label}`} size="xs" />}
            {onEdit && (
              <IconButton icon={Pencil} label={`Edit ${label}`} size="xs" onClick={onEdit} />
            )}
          </span>
        )}
      </dd>
    </div>
  );
});
