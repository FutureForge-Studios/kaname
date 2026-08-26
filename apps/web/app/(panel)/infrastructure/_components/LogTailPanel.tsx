"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { IconButton, LogViewer, Select, StatusBadge, type Tone } from "@kaname/ui";
import type { QueryParams } from "@/lib/api";
import { PageError } from "@/components/PageError";
import { useLogTail, type LogTailStatus } from "../_lib/logStream";

/* ------------------------------------------------------------------ *
 * LogTailPanel.
 *
 * One followed tail, wherever it comes from: a unit's journal, a
 * container's output, or a named source on a host. The endpoints differ
 * only in their path and in what they call the line budget, so the
 * viewer, the status of the stream and the reconnect control are shared
 * rather than rebuilt three times.
 * ------------------------------------------------------------------ */

const LINE_OPTIONS = [
  { value: "200", label: "200 lines" },
  { value: "1000", label: "1,000 lines" },
  { value: "5000", label: "5,000 lines" },
];

const STATUS_TONE: Record<LogTailStatus, Tone> = {
  idle: "neutral",
  connecting: "info",
  streaming: "accent",
  ended: "neutral",
  failed: "danger",
};

const STATUS_LABEL: Record<LogTailStatus, string> = {
  idle: "Not streaming",
  connecting: "Connecting",
  streaming: "Following",
  ended: "Stream ended",
  failed: "Stream failed",
};

export interface LogTailPanelProps {
  /** API path of the tail. Null renders `unavailable` instead. */
  path: string | null;
  params?: QueryParams;
  /** `/logs/tail` calls the budget `limit`; the unit and container tails call it `lines`. */
  linesKey?: "lines" | "limit";
  /** Why there is nothing to stream — agent offline, no source picked. */
  unavailable?: React.ReactNode;
  toolbarExtra?: React.ReactNode;
  height?: number | string;
  label?: string;
}

export function LogTailPanel({
  path,
  params,
  linesKey = "lines",
  unavailable,
  toolbarExtra,
  height = 480,
  label = "Log output",
}: LogTailPanelProps) {
  const [lines, setLines] = React.useState("1000");

  const streamParams = React.useMemo<QueryParams>(
    () => ({ ...params, follow: true, [linesKey]: Number.parseInt(lines, 10) }),
    [linesKey, lines, params],
  );

  const tail = useLogTail({
    path: unavailable ? null : path,
    params: streamParams,
    max: Number.parseInt(lines, 10),
  });

  if (unavailable) {
    return (
      <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)] px-4 py-6 text-center text-[var(--kn-text-2)]">
        {unavailable}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {tail.error && <PageError error={tail.error} onRetry={tail.restart} context="Log stream" />}
      <LogViewer
        lines={tail.lines}
        height={height}
        label={label}
        emptyLabel={
          tail.status === "streaming"
            ? "Connected — nothing has been logged yet"
            : "No log lines yet"
        }
        toolbarExtra={
          <>
            <StatusBadge
              tone={STATUS_TONE[tail.status]}
              size="xs"
              pulse={tail.status === "streaming"}
            >
              {STATUS_LABEL[tail.status]}
            </StatusBadge>
            <Select
              size="xs"
              aria-label="Lines to keep"
              options={LINE_OPTIONS}
              value={lines}
              onChange={(event) => setLines(event.target.value)}
              boxClassName="w-28"
            />
            <IconButton icon={RefreshCw} label="Reconnect" size="xs" onClick={tail.restart} />
            {toolbarExtra}
          </>
        }
      />
    </div>
  );
}
