"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Radio, RefreshCw, Regex, ScrollText, Square } from "lucide-react";
import type { LogLevel, LogRecordRow, LogSourceRow, TimeRange } from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  IconButton,
  Input,
  LogViewer,
  PageHeader,
  Select,
  TimeRangePicker,
  cn,
  resolveTimeRange,
  type LogLine,
  type TimeRangeValue,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { formatCount } from "@/lib/format";
import { LogTail, type LogTailStatus } from "@/lib/logTail";
import { useList } from "@/lib/queries";
import type { ApiError } from "@/lib/api";

/* ------------------------------------------------------------------ *
 * The unified log viewer.
 *
 * Every filter on this page is pushed down to the host: level, regex
 * and time window travel with the request, so the control plane never
 * pulls a gigabyte of journal in order to grep it and neither does the
 * browser. What arrives is already the answer.
 *
 * Two modes share one viewer. A search is a bounded query the operator
 * can page around in; a tail is an open stream. The tail is buffered
 * and flushed on a timer rather than committed per record — a chatty
 * host emits thousands of lines a second, and one React render per line
 * would make the pause button itself unresponsive, which is exactly
 * when an operator reaches for it.
 * ------------------------------------------------------------------ */

/** Ring size for the live buffer. The viewer is virtualized; the browser is not. */
const MAX_LINES = 5000;
const FLUSH_MS = 120;
const SEARCH_LIMIT = 1000;
const SEARCH_DEBOUNCE_MS = 250;

const LEVELS: readonly { value: string; label: string }[] = [
  { value: "", label: "Every level" },
  { value: "trace", label: "trace and above" },
  { value: "debug", label: "debug and above" },
  { value: "info", label: "info and above" },
  { value: "notice", label: "notice and above" },
  { value: "warn", label: "warn and above" },
  { value: "error", label: "error and above" },
  { value: "fatal", label: "fatal only" },
];

const RANGE_PRESETS: readonly TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

const TAIL_TONES: Record<LogTailStatus, "ok" | "warn" | "neutral"> = {
  connecting: "warn",
  open: "ok",
  reconnecting: "warn",
  closed: "neutral",
};

function isLevel(value: string | null): value is LogLevel {
  return LEVELS.some((entry) => entry.value === value && entry.value.length > 0);
}

function isRange(value: string | null): value is TimeRange {
  return RANGE_PRESETS.includes(value as TimeRange);
}

function toLine(record: LogRecordRow, qualified: boolean): LogLine {
  return {
    id: record.id,
    ts: record.ts,
    level: record.level,
    message: record.message,
    source: qualified ? `${record.server_name}:${record.source}` : record.source,
  };
}

export default function LogsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selection = useServerSelection({ permission: "logs.streams:read" });

  const source = searchParams.get("source") ?? "";
  const levelParam = searchParams.get("level");
  const level: LogLevel | undefined = isLevel(levelParam) ? levelParam : undefined;
  const useRegex = searchParams.get("regex") === "1";
  const urlQuery = searchParams.get("q") ?? "";

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const rangeParam = searchParams.get("range");
  const preset: TimeRange = isRange(rangeParam) ? rangeParam : "1h";

  /*
   * Memoised on its primitives, not rebuilt per render: `since` feeds
   * the tail's effect dependencies, and a value that moved every render
   * would tear the stream down and reopen it on every keystroke.
   */
  const rangeValue = React.useMemo<TimeRangeValue>(
    () => (from && to ? { kind: "absolute", from, to } : { kind: "preset", preset }),
    [from, preset, to],
  );

  const bounds = React.useMemo(() => resolveTimeRange(rangeValue), [rangeValue]);
  const since = new Date(bounds.from).toISOString();
  const until = rangeValue.kind === "absolute" ? new Date(bounds.to).toISOString() : undefined;

  const update = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `/logs?${query}` : "/logs", { scroll: false });
    },
    [router, searchParams],
  );

  /* ---------------------------- search box --------------------------- */

  const [draftQuery, setDraftQuery] = React.useState(urlQuery);
  const committed = React.useRef(urlQuery);

  React.useEffect(() => {
    if (urlQuery !== committed.current) {
      committed.current = urlQuery;
      setDraftQuery(urlQuery);
    }
  }, [urlQuery]);

  React.useEffect(() => {
    if (draftQuery === committed.current) return;
    const timer = window.setTimeout(() => {
      committed.current = draftQuery;
      update({ q: draftQuery || null });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draftQuery, update]);

  /** The contract reads a slash-wrapped query as a regular expression. */
  const hostQuery = urlQuery ? (useRegex ? `/${urlQuery}/` : urlQuery) : undefined;

  /* ------------------------------ sources ---------------------------- */

  const sources = useList<LogSourceRow>(
    "log-sources",
    { server_id: selection.serverId ?? undefined, per_page: 200, sort: "label", order: "asc" },
    { path: "/logs/sources", enabled: Boolean(selection.serverId) || selection.servers.length > 0 },
  );

  /* ------------------------------- live ------------------------------ */

  const [live, setLive] = React.useState(false);
  const [tailStatus, setTailStatus] = React.useState<LogTailStatus>("closed");
  const [tailError, setTailError] = React.useState<ApiError | null>(null);
  const [liveLines, setLiveLines] = React.useState<LogLine[]>([]);

  const canTail = Boolean(selection.serverId) && source.length > 0;
  const qualified = !selection.serverId;

  React.useEffect(() => {
    if (!live) return;
    if (!selection.serverId || !source) return;

    setLiveLines([]);
    setTailError(null);

    const buffer: LogLine[] = [];
    const flush = setInterval(() => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      setLiveLines((prev) => {
        const next = [...prev, ...batch];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }, FLUSH_MS);

    const tail = new LogTail({
      serverId: selection.serverId,
      source,
      level,
      q: hostQuery,
      since,
      limit: SEARCH_LIMIT,
      onRecord: (record) => buffer.push(toLine(record, qualified)),
      onStatusChange: setTailStatus,
      onError: (error) => {
        setTailError(error);
        setLive(false);
      },
    });
    tail.start();

    return () => {
      clearInterval(flush);
      tail.stop();
      setTailStatus("closed");
    };
  }, [hostQuery, level, live, qualified, selection.serverId, since, source]);

  /* ------------------------------ search ----------------------------- */

  const search = useList<LogRecordRow>(
    "log-search",
    {
      server_id: selection.serverId ?? undefined,
      source: source || undefined,
      level,
      q: hostQuery,
      since,
      until,
      limit: SEARCH_LIMIT,
    },
    { path: "/logs/search", enabled: !live, staleTime: 5_000 },
  );

  const searchLines = React.useMemo<LogLine[]>(() => {
    const rows = search.data?.data ?? [];
    // The API answers newest first; the viewer reads top to bottom.
    return rows.map((record) => toLine(record, qualified)).reverse();
  }, [qualified, search.data]);

  const lines = live ? liveLines : searchLines;
  const sourceRows = sources.data?.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Logs"
        subtitle={
          source
            ? source
            : selection.serverId
              ? "every source on this host"
              : "every reachable host in scope"
        }
        actions={
          <>
            {live && (
              <Badge tone={TAIL_TONES[tailStatus]} size="sm">
                {tailStatus === "open" ? "streaming" : tailStatus}
              </Badge>
            )}
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              size="sm"
              disabled={live || search.isFetching}
              onClick={() => void search.refetch()}
            />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <ServerPicker selection={selection} allowAll allLabel="All reachable hosts" />

          <Combobox
            options={sourceRows.map((row) => ({
              value: row.id,
              label: row.label,
              description: `${row.kind} · ${row.ref}`,
              mono: true,
            }))}
            value={source}
            onValueChange={(next) => update({ source: next })}
            loading={sources.isLoading}
            clearable
            mono
            placeholder={selection.serverId ? "Every source on this host" : "Pick a host first"}
            emptyMessage="No source matches that name."
            aria-label="Log source"
            className="w-64"
          />

          <Select
            size="sm"
            boxClassName="w-44"
            aria-label="Minimum level"
            value={level ?? ""}
            onChange={(event) => update({ level: event.target.value || null })}
            options={LEVELS}
          />

          <Input
            size="sm"
            mono
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder={useRegex ? "nginx\\[\\d+\\]" : "Search on the host"}
            aria-label="Search log lines on the host"
            spellCheck={false}
            boxClassName="w-64"
            trailing={
              <IconButton
                icon={Regex}
                label={useRegex ? "Match as plain text" : "Match as a regular expression"}
                size="xs"
                aria-pressed={useRegex}
                className={cn(useRegex && "bg-[var(--kn-surface-3)] text-[var(--kn-accent-400)]")}
                onClick={() => update({ regex: useRegex ? null : "1" })}
              />
            }
          />

          <TimeRangePicker
            value={rangeValue}
            onChange={(next) =>
              next.kind === "preset"
                ? update({ range: next.preset, from: null, to: null })
                : update({ range: null, from: next.from, to: next.to })
            }
            presets={RANGE_PRESETS}
            size="sm"
          />

          <div className="ml-auto flex items-center gap-2">
            <span className="kn-num text-xs text-[var(--kn-text-3)]">
              {formatCount(lines.length)} lines
            </span>
            <Button
              variant={live ? "danger-subtle" : "primary"}
              size="sm"
              icon={live ? Square : Radio}
              disabled={!canTail}
              title={
                canTail
                  ? undefined
                  : "A live tail needs one host and one source — the agent streams a single file or unit."
              }
              onClick={() => setLive((previous) => !previous)}
            >
              {live ? "Stop" : "Live tail"}
            </Button>
          </div>
        </div>

        {tailError && (
          <PageError
            error={tailError}
            onRetry={() => {
              setTailError(null);
              setLive(true);
            }}
            context="Live tail"
          />
        )}

        {!live && search.isError && (
          <PageError
            error={search.error}
            onRetry={() => void search.refetch()}
            context="Log search"
          />
        )}

        {sources.isError && (
          <PageError
            error={sources.error}
            onRetry={() => void sources.refetch()}
            context="Log sources"
          />
        )}

        <LogViewer
          lines={lines}
          height="100%"
          label={source ? `${source} log output` : "Log output"}
          emptyLabel={
            search.isLoading
              ? "Loading…"
              : live
                ? "Waiting for the first line from this source"
                : "No log line in this range matches these filters"
          }
          toolbarExtra={
            <span className="flex items-center gap-2">
              <ScrollText size={12} className="text-[var(--kn-text-3)]" aria-hidden />
              <span className="text-xs text-[var(--kn-text-3)]">
                {live ? "live tail" : "search"}
              </span>
            </span>
          }
          className="min-h-0 flex-1"
        />
      </div>
    </div>
  );
}
