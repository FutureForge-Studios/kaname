"use client";

import * as React from "react";
import type { AccountQuota, Client, QuotaUsage } from "@kaname/contract";
import { cn } from "@kaname/ui";
import { formatMb, quotaFraction } from "@/lib/accounts";
import { toneFor } from "./shared";

const TONE_TEXT = {
  ok: "text-[var(--kn-text)]",
  warn: "text-[var(--kn-warn)]",
  danger: "text-[var(--kn-danger)]",
  neutral: "text-[var(--kn-text)]",
  info: "text-[var(--kn-text)]",
  accent: "text-[var(--kn-text)]",
} as const;

/** "3 / 10" in a table cell, coloured only when it is close to the ceiling. */
export function UsageCell({ used, limit, mb = false }: { used: number; limit: number | null; mb?: boolean }) {
  const show = (v: number) => (mb ? formatMb(v) : String(v));
  const tone = toneFor(quotaFraction(used, limit));
  return (
    <span className={cn("kn-mono", TONE_TEXT[tone])}>
      {show(used)}
      <span className="text-[var(--kn-text-3)]">{limit === null ? " / ∞" : ` / ${show(limit)}`}</span>
    </span>
  );
}

export function clientUsageCell(usage: keyof QuotaUsage, limit: keyof AccountQuota) {
  return function Cell(row: Pick<Client, "usage" | "quota">) {
    return <UsageCell used={row.usage[usage]} limit={row.quota[limit]} mb={usage === "disk_mb"} />;
  };
}

export const STATUS_TONES = { active: "ok", invited: "info", suspended: "warn" } as const;
