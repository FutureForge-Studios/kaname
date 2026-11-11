"use client";

import * as React from "react";
import { SquareTerminal } from "lucide-react";
import { MonoLabel, cn, type Tone } from "@kaname/ui";
import type { TerminalStatus } from "@/components/TerminalPane";

/* ------------------------------------------------------------------ *
 * TerminalWell — the ink-deep frame a shell sits in.
 *
 * A recessed hairline well with a slim mono header bar (who and where
 * on the left; state and geometry on the right). It pins the dark token
 * set on itself, so the shell reads as ink-deep on paper too, and the
 * xterm palette — which TerminalPane reads from its own element — follows
 * the same tokens.
 *
 * Shared by the host terminal and a container's Exec tab: the same
 * audited path, so the same frame.
 * ------------------------------------------------------------------ */

export const TERMINAL_STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: "Connecting",
  open: "Connected",
  closed: "Disconnected",
  error: "Disconnected",
};

export const TERMINAL_STATUS_TONES: Record<TerminalStatus, Tone> = {
  connecting: "warn",
  open: "ok",
  closed: "neutral",
  error: "danger",
};

const DOT: Record<string, string> = {
  ok: "bg-[var(--kn-ok)]",
  warn: "bg-[var(--kn-warn)]",
  danger: "bg-[var(--kn-danger)]",
  neutral: "bg-[var(--kn-text-3)]",
};

export interface TerminalWellProps {
  /** Mono identity in the bar: `root@forge-01`, `sh in redis on db-01`. */
  title: React.ReactNode;
  /** Null while nothing is mounted: the bar then shows "idle". */
  status: TerminalStatus | null;
  geometry?: { cols: number; rows: number };
  /** Right-hand slot in the bar, before the state. */
  extra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function TerminalWell({
  title,
  status,
  geometry,
  extra,
  className,
  children,
}: TerminalWellProps) {
  const tone = status ? TERMINAL_STATUS_TONES[status] : "neutral";
  return (
    <div
      data-theme="dark"
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] text-[var(--kn-text)]",
        className,
      )}
    >
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-[var(--kn-border-subtle)] px-3">
        <SquareTerminal size={13} aria-hidden className="shrink-0 text-[var(--kn-text-3)]" />
        <span className="kn-mono min-w-0 flex-1 truncate text-xs text-[var(--kn-text-2)]">
          {title}
        </span>
        {extra}
        {geometry && status && (
          <MonoLabel size="xs" tone="subtle" className="hidden sm:inline">
            {geometry.cols}×{geometry.rows}
          </MonoLabel>
        )}
        {/* The state is announced by the page's own badge; this is the glanceable dot. */}
        <span aria-hidden className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-[var(--kn-r-pill)]",
              DOT[tone] ?? DOT["neutral"],
              status === "connecting" && "animate-pulse",
            )}
          />
          <MonoLabel size="xs" tone={status === "open" ? "ok" : "subtle"}>
            {status === "open" ? "live" : status === "connecting" ? "dialing" : "idle"}
          </MonoLabel>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
