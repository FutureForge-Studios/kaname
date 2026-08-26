import {
  formatAbsoluteTime,
  formatBytes,
  formatCompactNumber,
  formatDuration,
  formatRelativeTime,
  middleTruncate,
} from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * Formatters.
 *
 * The component kit already owns bytes, durations, relative time and
 * compact numbers, so those are re-exported rather than reimplemented —
 * a second `formatBytes` that rounds differently is how two screens
 * start disagreeing about the size of the same disk. Everything below
 * the re-exports is a shape the kit does not cover.
 * ------------------------------------------------------------------ */

export {
  formatAbsoluteTime,
  formatBytes,
  formatCompactNumber,
  formatDuration,
  formatRelativeTime,
  middleTruncate,
};

const EM_DASH = "—";

export function formatPercent(value: number | null | undefined, precision = 0): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(precision)}%`;
}

export function formatRatio(used: number, total: number, precision = 0): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return EM_DASH;
  return formatPercent((used / total) * 100, precision);
}

export function percentOf(used: number | null | undefined, total: number | null | undefined): number {
  if (used == null || total == null || !Number.isFinite(used) || !total) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** Bytes per second, which is a rate rather than a size. */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return EM_DASH;
  return `${formatBytes(bytesPerSecond, "decimal", 1)}/s`;
}

/** Uptime reads in whole units — nobody cares about the seconds after a week. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return EM_DASH;
  return formatDuration(seconds * 1000, seconds >= 86_400 ? 2 : 2);
}

export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString("en-US");
}

/** Load averages are compared column-to-column, so the precision is fixed. */
export function formatLoad(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EM_DASH;
  return value.toFixed(2);
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value == null) return EM_DASH;
  return formatAbsoluteTime(value);
}

export function formatDaysLeft(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return EM_DASH;
  if (days < 0) return `${formatCount(Math.abs(days))} days ago`;
  if (days === 0) return "today";
  return `${formatCount(days)} ${days === 1 ? "day" : "days"}`;
}

/**
 * Turns a machine identifier — a job type, an audit action, an error
 * code — into a sentence-cased phrase. Used only where the contract
 * does not already supply a label.
 */
export function humanize(value: string): string {
  const words = value.replace(/[._-]+/g, " ").trim();
  if (words.length === 0) return EM_DASH;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "web-01 · nginx.service" style joins that skip absent parts. */
export function joinMeta(...parts: (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}
