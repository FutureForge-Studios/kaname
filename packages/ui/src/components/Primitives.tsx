"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn.js";
import { IconButton, type ButtonSize } from "./Button.js";

/* ------------------------------------------------------------------ *
 * Small value renderers shared by every module.
 *
 * These carry the product's typographic rules: technical strings are
 * mono, comparable numbers are tabular, and a timestamp is always both
 * relative (scannable) and absolute (precise, in the title).
 * ------------------------------------------------------------------ */

export type DateInput = string | number | Date;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function toMillis(value: DateInput): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

/* ----------------------------- CopyButton ------------------------------ */

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  // A self-hosted panel is routinely reached on a LAN address over plain
  // HTTP, where the async clipboard API is unavailable as a non-secure
  // context. Copying a DNS record or an install command has to keep working.
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export interface CopyButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "children"
> {
  value: string;
  /** Accessible name before the copy happens. */
  label?: string;
  size?: ButtonSize;
  onCopied?: (value: string) => void;
}

export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  { value, label = "Copy", size = "xs", className, onClick, onCopied, ...props },
  ref,
) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      void writeClipboard(value).then((ok) => {
        if (!ok) return;
        setCopied(true);
        onCopied?.(value);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1000);
      });
    },
    [onClick, onCopied, value],
  );

  return (
    <span className="inline-flex shrink-0 items-center">
      <IconButton
        ref={ref}
        icon={copied ? Check : Copy}
        label={copied ? "Copied" : label}
        size={size}
        onClick={handleClick}
        className={cn(copied && "text-[var(--kn-ok)]", className)}
        {...props}
      />
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </span>
  );
});

/* ---------------------------- RelativeTime ----------------------------- */

export function formatAbsoluteTime(value: DateInput): string {
  const ts = toMillis(value);
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function formatRelativeTime(value: DateInput, now: number = Date.now()): string {
  const ts = toMillis(value);
  if (!Number.isFinite(ts)) return "—";
  const delta = now - ts;
  const abs = Math.abs(delta);
  const phrase = (unit: string) => (delta >= 0 ? `${unit} ago` : `in ${unit}`);

  if (abs < 10 * SECOND) return "just now";
  if (abs < MINUTE) return phrase(`${Math.round(abs / SECOND)}s`);
  if (abs < HOUR) return phrase(`${Math.floor(abs / MINUTE)}m`);
  if (abs < DAY) return phrase(`${Math.floor(abs / HOUR)}h`);
  if (abs < WEEK) return phrase(`${Math.floor(abs / DAY)}d`);

  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

function tickPeriod(abs: number): number {
  if (abs < MINUTE) return 5 * SECOND;
  if (abs < HOUR) return 30 * SECOND;
  return 5 * MINUTE;
}

/**
 * Live "2m ago" string. Returns null for an absent timestamp so callers can
 * choose their own fallback. The interval re-derives its period from the
 * current age, so a fresh row ticks every 5s and a week-old one every 5m.
 */
export function useRelativeTime(value: DateInput | null | undefined): string | null {
  const ts = value == null ? null : toMillis(value);
  const valid = ts !== null && Number.isFinite(ts);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!valid || ts === null) return;
    const id = window.setInterval(() => setNow(Date.now()), tickPeriod(Math.abs(Date.now() - ts)));
    return () => window.clearInterval(id);
  }, [ts, valid, now]);

  if (!valid || ts === null) return null;
  return formatRelativeTime(ts, now);
}

export interface RelativeTimeProps extends Omit<
  React.TimeHTMLAttributes<HTMLTimeElement>,
  "children" | "title" | "dateTime"
> {
  value: DateInput | null | undefined;
  /** Shown when there is no timestamp — a job never started, a host never seen. */
  fallback?: string;
}

export const RelativeTime = React.forwardRef<HTMLTimeElement, RelativeTimeProps>(
  function RelativeTime({ value, fallback = "—", className, ...props }, ref) {
    const relative = useRelativeTime(value);
    const ts = value == null ? null : toMillis(value);

    if (ts === null || !Number.isFinite(ts) || relative === null) {
      return <span className={cn("text-[var(--kn-text-3)]", className)}>{fallback}</span>;
    }

    return (
      <time
        ref={ref}
        dateTime={new Date(ts).toISOString()}
        title={formatAbsoluteTime(ts)}
        // Server and browser render this string against their own clock and
        // timezone. They agree to the second in practice; the suppression
        // covers the boundary case instead of blanking the first paint.
        suppressHydrationWarning
        className={cn("kn-num whitespace-nowrap", className)}
        {...props}
      >
        {relative}
      </time>
    );
  },
);

/* ------------------------------- ByteSize ------------------------------- */

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
const DECIMAL_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

export type ByteBase = "binary" | "decimal";

export function formatBytes(value: number, base: ByteBase = "binary", precision = 1): string {
  if (!Number.isFinite(value)) return "—";
  const units = base === "binary" ? BINARY_UNITS : DECIMAL_UNITS;
  const step = base === "binary" ? 1024 : 1000;
  const sign = value < 0 ? -1 : 1;

  let n = Math.abs(value);
  let i = 0;
  while (n >= step && i < units.length - 1) {
    n /= step;
    i += 1;
  }
  return `${(sign * n).toFixed(i === 0 ? 0 : precision)} ${units[i] ?? "B"}`;
}

export interface ByteSizeProps extends React.HTMLAttributes<HTMLSpanElement> {
  bytes: number | null | undefined;
  base?: ByteBase;
  precision?: number;
  fallback?: string;
}

export const ByteSize = React.forwardRef<HTMLSpanElement, ByteSizeProps>(function ByteSize(
  { bytes, base = "binary", precision = 1, fallback = "—", className, ...props },
  ref,
) {
  const numeric = bytes != null && Number.isFinite(bytes) ? Number(bytes) : null;
  return (
    <span
      ref={ref}
      className={cn(
        "kn-num whitespace-nowrap",
        numeric === null && "text-[var(--kn-text-3)]",
        className,
      )}
      {...props}
    >
      {numeric === null ? fallback : formatBytes(numeric, base, precision)}
    </span>
  );
});

/* ------------------------------- Duration ------------------------------- */

export function formatDuration(ms: number, units = 2): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < SECOND) return `${Math.round(ms)}ms`;
  if (ms < 10 * SECOND) return `${(ms / SECOND).toFixed(1)}s`;

  const total = Math.floor(ms / SECOND);
  const parts: Array<[number, string]> = [
    [Math.floor(total / 86400), "d"],
    [Math.floor((total % 86400) / 3600), "h"],
    [Math.floor((total % 3600) / 60), "m"],
    [total % 60, "s"],
  ];

  const start = parts.findIndex(([n]) => n > 0);
  if (start === -1) return "0s";
  return parts
    .slice(start, start + Math.max(1, units))
    .filter(([n], index) => index === 0 || n > 0)
    .map(([n, unit]) => `${n}${unit}`)
    .join(" ");
}

export interface DurationProps extends React.HTMLAttributes<HTMLSpanElement> {
  ms: number | null | undefined;
  /** How many units to show. 2 gives "1h 4m", 1 gives "1h". */
  units?: number;
  fallback?: string;
}

export const Duration = React.forwardRef<HTMLSpanElement, DurationProps>(function Duration(
  { ms, units = 2, fallback = "—", className, ...props },
  ref,
) {
  const numeric = ms != null && Number.isFinite(ms) ? Number(ms) : null;
  return (
    <span
      ref={ref}
      className={cn(
        "kn-num whitespace-nowrap",
        numeric === null && "text-[var(--kn-text-3)]",
        className,
      )}
      {...props}
    >
      {numeric === null ? fallback : formatDuration(numeric, units)}
    </span>
  );
});

/* ------------------------------- MonoText ------------------------------- */

export interface MonoTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  muted?: boolean;
  /** Single-line ellipsis. Needs a width-constrained parent. */
  truncate?: boolean;
}

export const MonoText = React.forwardRef<HTMLSpanElement, MonoTextProps>(function MonoText(
  { muted = false, truncate = false, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "kn-mono select-text",
        muted && "text-[var(--kn-text-2)]",
        truncate && "inline-block max-w-full truncate align-bottom",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
});

/* ---------------------------- TruncatedText ----------------------------- */

/** Keeps both ends of a path or hash, which is where the meaning lives. */
export function middleTruncate(value: string, max: number): string {
  if (max < 4 || value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export interface TruncatedTextProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children" | "title"
> {
  value: string;
  /** Character budget before the middle is elided. */
  max?: number;
  mono?: boolean;
}

export const TruncatedText = React.forwardRef<HTMLSpanElement, TruncatedTextProps>(
  function TruncatedText({ value, max = 40, mono = true, className, ...props }, ref) {
    const shown = middleTruncate(value, max);
    return (
      <span
        ref={ref}
        title={value}
        className={cn("inline-flex max-w-full items-center", mono && "kn-mono", className)}
        {...props}
      >
        <span aria-hidden>{shown}</span>
        <span className="sr-only">{value}</span>
      </span>
    );
  },
);
