"use client";

import * as React from "react";
import { MonoLabel, Select } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * FilterSelect — the toolbar control every list in this module uses.
 *
 * The empty value means "no filter", which is what ResourceListState
 * already treats as absent, so a cleared filter drops out of the URL
 * instead of writing `?status=`.
 * ------------------------------------------------------------------ */

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterSelectProps {
  /** Accessible name and the "any" row's wording, e.g. "Runtime". */
  label: string;
  value: string | undefined;
  onChange: (value: string | null) => void;
  options: readonly FilterOption[];
  className?: string;
}

export function FilterSelect({ label, value, onChange, options, className }: FilterSelectProps) {
  return (
    <Select
      size="sm"
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      className={className}
      boxClassName="w-auto min-w-32"
      options={[{ value: "", label: `Any ${label.toLowerCase()}` }, ...options]}
    />
  );
}

/**
 * The scope row above a list: which host or zone the table is narrowed
 * to. It is not a filter (it changes what the page is about), so it sits
 * on its own labelled line rather than in the table toolbar.
 */
export function ScopeBar({
  label = "Scope",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <MonoLabel tone="muted" className="w-12 shrink-0">
        {label}
      </MonoLabel>
      {children}
    </div>
  );
}
