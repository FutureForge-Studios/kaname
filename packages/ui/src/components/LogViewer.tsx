"use client";

import * as React from "react";
import type { LogLevel } from "@kaname/contract";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Filter,
  Pause,
  Play,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button, IconButton } from "./Button.js";
import { Input } from "./Input.js";
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from "./DropdownMenu.js";

/* ------------------------------------------------------------------ *
 * LogViewer — windowed, so a 50k-line retention buffer stays smooth.
 *
 * The windowing is hand-rolled rather than pulled from react-window
 * because wrapped lines have data-dependent heights: with wrap off every
 * row is one line and the offset is arithmetic; with wrap on we derive a
 * row count from the measured character width and keep a prefix-sum
 * table. Both paths do one binary search per scroll event and render
 * only what fits plus an overscan.
 * ------------------------------------------------------------------ */

export interface LogLine {
  id: string;
  /** ISO string or epoch millis. */
  ts?: string | number;
  level?: LogLevel;
  message: string;
  /** Unit, container or file the line came from. */
  source?: string;
}

export const LOG_LEVELS: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "notice",
  "warn",
  "error",
  "fatal",
];

const LEVEL_TEXT: Record<LogLevel, string> = {
  trace: "text-[var(--kn-text-3)]",
  debug: "text-[var(--kn-text-3)]",
  info: "text-[var(--kn-info)]",
  notice: "text-[var(--kn-text-2)]",
  warn: "text-[var(--kn-warn)]",
  error: "text-[var(--kn-danger)]",
  fatal: "text-[var(--kn-danger)]",
};

const LEVEL_TAG: Record<LogLevel, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  notice: "NOT",
  warn: "WRN",
  error: "ERR",
  fatal: "FTL",
};

const LINE_HEIGHT = 18;
const OVERSCAN = 12;
const MEASURE_CHARS = 100;
const TS_CHARS = 12;
const LEVEL_CHARS = 3;
const MAX_MATCHES_PER_LINE = 200;
const BOTTOM_EPSILON = 8;
/** Shared empty array so a row without matches keeps a stable memo identity. */
const NO_RANGES: [number, number][] = [];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatTs(ts: string | number | undefined): string {
  if (ts === undefined) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
}

function groupThousands(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Largest index whose offset is at or before `value`. */
function bisectFloor(offsets: Float64Array, value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] as number) <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Smallest index whose offset reaches `value`. */
function bisectCeil(offsets: Float64Array, value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Matcher {
  test(text: string): boolean;
  find(text: string): [number, number][];
}

function buildMatcher(query: string, regex: boolean): Matcher | null {
  if (query.length === 0) return null;
  if (!regex) {
    const needle = query.toLowerCase();
    return {
      test: (text) => text.toLowerCase().includes(needle),
      find: (text) => {
        const haystack = text.toLowerCase();
        const out: [number, number][] = [];
        let from = 0;
        while (out.length < MAX_MATCHES_PER_LINE) {
          const at = haystack.indexOf(needle, from);
          if (at === -1) break;
          out.push([at, at + needle.length]);
          from = at + needle.length;
        }
        return out;
      },
    };
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(query, "gi");
  } catch {
    return null;
  }
  return {
    test: (text) => {
      compiled.lastIndex = 0;
      return compiled.test(text);
    },
    find: (text) => {
      compiled.lastIndex = 0;
      const out: [number, number][] = [];
      let match = compiled.exec(text);
      while (match !== null && out.length < MAX_MATCHES_PER_LINE) {
        const end = match.index + (match[0].length || 1);
        out.push([match.index, end]);
        if (match[0].length === 0) compiled.lastIndex = end;
        match = compiled.exec(text);
      }
      return out;
    },
  };
}

function useControlled<T>(
  controlled: T | undefined,
  onChange: ((next: T) => void) | undefined,
  initial: T,
): readonly [T, (next: T) => void] {
  const [internal, setInternal] = React.useState(initial);
  const current = controlled !== undefined ? controlled : internal;
  const set = React.useCallback(
    (next: T) => {
      if (controlled === undefined) setInternal(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, set] as const;
}

export interface LogViewerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  lines: readonly LogLine[];
  height?: number | string;
  levels?: readonly LogLevel[];
  onLevelsChange?: (levels: LogLevel[]) => void;
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  defaultWrap?: boolean;
  defaultShowTimestamps?: boolean;
  /** Left of the built-in controls, for a unit picker or a download action. */
  toolbarExtra?: React.ReactNode;
  emptyLabel?: string;
  label?: string;
}

export const LogViewer = React.forwardRef<HTMLDivElement, LogViewerProps>(function LogViewer(
  {
    lines,
    height = 420,
    levels: levelsProp,
    onLevelsChange,
    paused: pausedProp,
    onPausedChange,
    defaultWrap = false,
    defaultShowTimestamps = true,
    toolbarExtra,
    emptyLabel = "No log lines in this range",
    label = "Log output",
    className,
    ...props
  },
  ref,
) {
  const [activeLevels, setActiveLevels] = useControlled<readonly LogLevel[]>(
    levelsProp,
    onLevelsChange as ((next: readonly LogLevel[]) => void) | undefined,
    LOG_LEVELS,
  );
  const [paused, setPaused] = useControlled<boolean>(pausedProp, onPausedChange, false);
  const [wrap, setWrap] = React.useState(defaultWrap);
  const [showTimestamps, setShowTimestamps] = React.useState(defaultShowTimestamps);
  const [follow, setFollow] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const [useRegex, setUseRegex] = React.useState(false);
  const [matchCursor, setMatchCursor] = React.useState(0);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  /* ---- pause freezes the buffer instead of dropping lines --------- */

  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  const [frozen, setFrozen] = React.useState<readonly LogLine[] | null>(null);

  React.useEffect(() => {
    if (paused) setFrozen((prev) => prev ?? linesRef.current);
    else setFrozen(null);
  }, [paused]);

  const source = frozen ?? lines;
  const pending = frozen ? Math.max(0, lines.length - frozen.length) : 0;

  /* ---- filtering -------------------------------------------------- */

  const filtered = React.useMemo(() => {
    if (activeLevels.length >= LOG_LEVELS.length) return source;
    const allowed = new Set(activeLevels);
    return source.filter((line) => (line.level ? allowed.has(line.level) : true));
  }, [source, activeLevels]);

  const matcher = React.useMemo(() => buildMatcher(query, useRegex), [query, useRegex]);
  const regexInvalid = useRegex && query.length > 0 && matcher === null;

  const matchLines = React.useMemo(() => {
    if (!matcher) return [];
    const out: number[] = [];
    for (let i = 0; i < filtered.length; i += 1) {
      const line = filtered[i];
      if (line && matcher.test(line.message)) out.push(i);
    }
    return out;
  }, [filtered, matcher]);

  React.useEffect(() => {
    setMatchCursor(0);
  }, [query, useRegex]);

  const currentMatchLine =
    matchLines.length > 0 ? matchLines[Math.min(matchCursor, matchLines.length - 1)] : undefined;

  /* ---- measurement ------------------------------------------------ */

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const measureRef = React.useRef<HTMLSpanElement | null>(null);
  const programmatic = React.useRef(false);
  const [charWidth, setCharWidth] = React.useState(7.2);
  const [viewport, setViewport] = React.useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = React.useState(0);

  React.useLayoutEffect(() => {
    const element = measureRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width / MEASURE_CHARS;
      if (next > 0) setCharWidth((prev) => (Math.abs(prev - next) < 0.01 ? prev : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height: h } = entry.contentRect;
      setViewport((prev) =>
        prev.width === width && prev.height === h ? prev : { width, height: h },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const gutterWidth = Math.ceil(
    Math.max(3, String(Math.max(1, filtered.length)).length) * charWidth + 16,
  );
  const tsWidth = showTimestamps ? Math.ceil(TS_CHARS * charWidth + 12) : 0;
  const levelWidth = Math.ceil(LEVEL_CHARS * charWidth + 12);
  const messageWidth = Math.max(80, viewport.width - gutterWidth - tsWidth - levelWidth - 12);
  const charsPerLine = Math.max(20, Math.floor(messageWidth / charWidth));

  /* ---- windowing -------------------------------------------------- */

  const offsets = React.useMemo(() => {
    if (!wrap) return null;
    const table = new Float64Array(filtered.length + 1);
    for (let i = 0; i < filtered.length; i += 1) {
      const message = filtered[i]?.message ?? "";
      const rows = Math.max(1, Math.ceil(message.length / charsPerLine));
      table[i + 1] = (table[i] as number) + rows * LINE_HEIGHT;
    }
    return table;
  }, [wrap, filtered, charsPerLine]);

  const totalHeight = offsets
    ? (offsets[offsets.length - 1] as number)
    : filtered.length * LINE_HEIGHT;

  const viewHeight = viewport.height || 0;
  const rawStart = offsets ? bisectFloor(offsets, scrollTop) : Math.floor(scrollTop / LINE_HEIGHT);
  const rawEnd = offsets
    ? bisectCeil(offsets, scrollTop + viewHeight)
    : Math.ceil((scrollTop + viewHeight) / LINE_HEIGHT);

  const startIndex = Math.max(0, Math.min(rawStart, Math.max(0, filtered.length - 1)) - OVERSCAN);
  const endIndex = Math.min(filtered.length, rawEnd + OVERSCAN);
  const windowOffset = offsets ? (offsets[startIndex] as number) : startIndex * LINE_HEIGHT;
  const windowed = filtered.slice(startIndex, endIndex);

  /* ---- scrolling -------------------------------------------------- */

  const scrollTo = React.useCallback((top: number) => {
    const element = scrollRef.current;
    if (!element) return;
    programmatic.current = true;
    element.scrollTop = top;
    setScrollTop(element.scrollTop);
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  }, []);

  const jumpToLatest = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    scrollTo(element.scrollHeight);
    setFollow(true);
  }, [scrollTo]);

  const handleScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    if (programmatic.current) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_EPSILON;
    // Scrolling away from the tail is the operator saying "hold still".
    setFollow(atBottom);
  }, []);

  React.useEffect(() => {
    if (!follow || paused) return;
    const element = scrollRef.current;
    if (!element) return;
    programmatic.current = true;
    element.scrollTop = element.scrollHeight;
    setScrollTop(element.scrollTop);
    const frame = requestAnimationFrame(() => {
      programmatic.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [follow, paused, totalHeight, filtered.length]);

  const gotoMatch = React.useCallback(
    (delta: number) => {
      if (matchLines.length === 0) return;
      const next = (matchCursor + delta + matchLines.length) % matchLines.length;
      setMatchCursor(next);
      const index = matchLines[next];
      if (index === undefined) return;
      const top = offsets ? (offsets[index] as number) : index * LINE_HEIGHT;
      setFollow(false);
      scrollTo(Math.max(0, top - viewHeight / 2));
    },
    [matchLines, matchCursor, offsets, scrollTo, viewHeight],
  );

  const copyLine = React.useCallback((line: LogLine) => {
    const text =
      `${formatTs(line.ts)} ${line.level ? LEVEL_TAG[line.level] : ""} ${line.message}`.trim();
    void navigator.clipboard?.writeText(text);
    setCopiedId(line.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === line.id ? null : prev)), 1200);
  }, []);

  const toggleLevel = React.useCallback(
    (level: LogLevel, next: boolean) => {
      const draft = new Set(activeLevels);
      if (next) draft.add(level);
      else draft.delete(level);
      setActiveLevels(LOG_LEVELS.filter((l) => draft.has(l)));
    },
    [activeLevels, setActiveLevels],
  );

  const allLevels = activeLevels.length >= LOG_LEVELS.length;

  return (
    <div
      ref={ref}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)]",
        className,
      )}
      {...props}
    >
      {/* Character-width probe. Drives wrapped-row height maths. */}
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute whitespace-pre font-mono text-sm"
      >
        {"0".repeat(MEASURE_CHARS)}
      </span>

      <div className="flex h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--kn-border)] bg-[var(--kn-surface)] px-2">
        <DropdownMenu
          placement="bottom-start"
          label="Log levels"
          trigger={
            <Button variant="ghost" size="xs" icon={Filter}>
              {allLevels ? "All levels" : `${activeLevels.length} levels`}
            </Button>
          }
        >
          <MenuLabel>Levels</MenuLabel>
          <MenuSeparator />
          {LOG_LEVELS.map((level) => {
            const on = activeLevels.includes(level);
            return (
              <MenuItem
                key={level}
                role="menuitemcheckbox"
                aria-checked={on}
                closeOnSelect={false}
                icon={on ? Check : undefined}
                className={cn(!on && "pl-8")}
                onSelect={() => toggleLevel(level, !on)}
              >
                <span className={cn("font-mono", LEVEL_TEXT[level])}>{LEVEL_TAG[level]}</span>
                <span className="capitalize text-[var(--kn-text-2)]">{level}</span>
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuItem onSelect={() => setActiveLevels(LOG_LEVELS)}>Show all levels</MenuItem>
        </DropdownMenu>

        <div className="flex min-w-0 flex-1 items-center">
          <Input
            size="xs"
            mono
            type="search"
            icon={Search}
            value={query}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
            placeholder={useRegex ? "Regular expression" : "Search lines"}
            aria-label="Search log lines"
            invalid={regexInvalid}
            boxClassName="w-full min-w-32"
            trailing={
              <>
                {query.length > 0 && (
                  <>
                    <span className="tabular-nums px-0.5 text-xs">
                      {matchLines.length === 0
                        ? "0"
                        : `${groupThousands(matchCursor + 1)}/${groupThousands(matchLines.length)}`}
                    </span>
                    <IconButton
                      icon={ChevronUp}
                      label="Previous match"
                      size="xs"
                      disabled={matchLines.length === 0}
                      onClick={() => gotoMatch(-1)}
                    />
                    <IconButton
                      icon={ChevronDown}
                      label="Next match"
                      size="xs"
                      disabled={matchLines.length === 0}
                      onClick={() => gotoMatch(1)}
                    />
                    <IconButton
                      icon={X}
                      label="Clear search"
                      size="xs"
                      onClick={() => setQuery("")}
                    />
                  </>
                )}
                <button
                  type="button"
                  aria-pressed={useRegex}
                  aria-label="Match as a regular expression"
                  title="Match as a regular expression"
                  onClick={() => setUseRegex((prev) => !prev)}
                  className={cn(
                    "inline-flex h-4 shrink-0 items-center rounded-[var(--kn-r-xs)] px-1 font-mono text-sm",
                    "transition-[background-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
                    useRegex
                      ? "bg-[var(--kn-accent-soft-strong)] text-[var(--kn-accent-400)]"
                      : "text-[var(--kn-text-3)] hover:text-[var(--kn-text)]",
                  )}
                >
                  .*
                </button>
              </>
            }
          />
        </div>

        {toolbarExtra}

        <IconButton
          icon={WrapText}
          label={wrap ? "Disable line wrapping" : "Wrap long lines"}
          size="xs"
          aria-pressed={wrap}
          className={cn(wrap && "bg-[var(--kn-surface-3)] text-[var(--kn-text)]")}
          onClick={() => setWrap((prev) => !prev)}
        />
        <IconButton
          icon={Clock}
          label={showTimestamps ? "Hide timestamps" : "Show timestamps"}
          size="xs"
          aria-pressed={showTimestamps}
          className={cn(showTimestamps && "bg-[var(--kn-surface-3)] text-[var(--kn-text)]")}
          onClick={() => setShowTimestamps((prev) => !prev)}
        />
        <IconButton
          icon={ArrowDownToLine}
          label={follow ? "Stop following the tail" : "Follow the tail"}
          size="xs"
          aria-pressed={follow}
          className={cn(follow && "bg-[var(--kn-surface-3)] text-[var(--kn-text)]")}
          onClick={() => (follow ? setFollow(false) : jumpToLatest())}
        />
        <Button
          variant={paused ? "secondary" : "ghost"}
          size="xs"
          icon={paused ? Play : Pause}
          onClick={() => setPaused(!paused)}
        >
          {paused ? (pending > 0 ? `Resume (${groupThousands(pending)})` : "Resume") : "Pause"}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-label={label}
          aria-live={follow && !paused ? "polite" : "off"}
          tabIndex={0}
          style={{ height }}
          className={cn(
            "relative overflow-auto font-mono text-sm leading-[18px]",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
            wrap ? "overflow-x-hidden" : "overflow-x-auto",
          )}
        >
          <div style={{ height: totalHeight }} className="relative min-w-full">
            <div
              className={cn("absolute left-0 top-0", wrap ? "right-0" : "w-max min-w-full")}
              style={{ transform: `translateY(${windowOffset}px)` }}
            >
              {windowed.map((line, i) => {
                const index = startIndex + i;
                const ranges = matcher ? matcher.find(line.message) : NO_RANGES;
                const rowHeight = offsets
                  ? (offsets[index + 1] as number) - (offsets[index] as number)
                  : LINE_HEIGHT;
                return (
                  <LogRow
                    key={line.id}
                    line={line}
                    lineNumber={index + 1}
                    ranges={ranges}
                    isCurrentMatch={index === currentMatchLine}
                    wrap={wrap}
                    rowHeight={rowHeight}
                    showTimestamp={showTimestamps}
                    gutterWidth={gutterWidth}
                    tsWidth={tsWidth}
                    levelWidth={levelWidth}
                    copied={copiedId === line.id}
                    onCopy={copyLine}
                  />
                );
              })}
            </div>
          </div>

          {filtered.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-sans text-xs text-[var(--kn-text-3)]">
              {emptyLabel}
            </div>
          )}
        </div>

        {!follow && (
          <Button
            variant="secondary"
            size="xs"
            icon={ArrowDownToLine}
            onClick={jumpToLatest}
            className="absolute bottom-3 right-4 shadow-[var(--kn-shadow-md)] animate-[var(--animate-rise)] motion-reduce:animate-none"
          >
            {pending > 0 ? `${groupThousands(pending)} new` : "Jump to latest"}
          </Button>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-[var(--kn-border)] bg-[var(--kn-surface)] px-3 text-xs text-[var(--kn-text-3)]">
        <span className="tabular-nums">
          {groupThousands(filtered.length)} of {groupThousands(source.length)} lines
        </span>
        <span className="tabular-nums">
          {paused ? "Paused" : follow ? "Following" : "Scrolled back"}
        </span>
      </div>
    </div>
  );
});

/* ------------------------------- row ------------------------------- */

interface LogRowProps {
  line: LogLine;
  lineNumber: number;
  ranges: [number, number][];
  isCurrentMatch: boolean;
  wrap: boolean;
  /** Comes from the same table the scroll offsets do, so layout cannot drift. */
  rowHeight: number;
  showTimestamp: boolean;
  gutterWidth: number;
  tsWidth: number;
  levelWidth: number;
  copied: boolean;
  onCopy: (line: LogLine) => void;
}

const LogRow = React.memo(function LogRow({
  line,
  lineNumber,
  ranges,
  isCurrentMatch,
  wrap,
  rowHeight,
  showTimestamp,
  gutterWidth,
  tsWidth,
  levelWidth,
  copied,
  onCopy,
}: LogRowProps) {
  return (
    <div
      className={cn(
        "group/line flex min-w-full items-start overflow-hidden hover:bg-[var(--kn-surface)]",
        isCurrentMatch && "bg-[var(--kn-accent-soft)]",
      )}
      style={{ height: rowHeight }}
    >
      <span
        className="sticky left-0 z-10 flex shrink-0 select-none items-start justify-end bg-[var(--kn-bg-inset)] pr-2 text-[var(--kn-text-3)] group-hover/line:bg-[var(--kn-surface)]"
        style={{ width: gutterWidth, height: LINE_HEIGHT }}
      >
        <span className="tabular-nums group-hover/line:invisible">{lineNumber}</span>
        <IconButton
          icon={copied ? Check : Copy}
          label={`Copy line ${lineNumber}`}
          size="xs"
          onClick={() => onCopy(line)}
          className="invisible absolute right-0 top-0 h-[18px] w-[18px] group-hover/line:visible"
        />
      </span>

      {showTimestamp && (
        <span
          className="shrink-0 select-none pr-2 text-[var(--kn-text-3)]"
          style={{ width: tsWidth }}
        >
          {formatTs(line.ts)}
        </span>
      )}

      <span
        className={cn(
          "shrink-0 select-none pr-2",
          line.level ? LEVEL_TEXT[line.level] : "text-[var(--kn-text-3)]",
        )}
        style={{ width: levelWidth }}
        title={line.level}
      >
        {line.level ? LEVEL_TAG[line.level] : ""}
      </span>

      <span
        className={cn(
          "min-w-0 flex-1 text-[var(--kn-text)]",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        )}
      >
        {ranges.length === 0 ? line.message : highlight(line.message, ranges)}
      </span>
    </div>
  );
});

function highlight(text: string, ranges: readonly [number, number][]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(
      <mark
        key={i}
        className="rounded-[var(--kn-r-xs)] bg-[var(--kn-accent-soft-strong)] text-[var(--kn-accent-300)]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
