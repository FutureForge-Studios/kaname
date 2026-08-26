"use client";

import * as React from "react";
import { Select } from "@kaname/ui";

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
