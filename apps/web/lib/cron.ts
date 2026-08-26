/* ------------------------------------------------------------------ *
 * Cron, in plain English.
 *
 * A backup schedule nobody can read is a backup schedule nobody audits,
 * and `30 2 * * 1-5` is not readable at a glance. This reads the same
 * five-field grammar the control plane computes `next_run_at` from, so
 * the sentence on screen describes the expression that will actually
 * run rather than a friendlier approximation of it.
 * ------------------------------------------------------------------ */

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTH_ABBR = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

const UNRECOGNISED = "Unrecognised cron expression";

/** How many concrete times are worth spelling out before it reads as noise. */
const MAX_LISTED_TIMES = 4;

export interface CronPreset {
  value: string;
  label: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { value: "*/15 * * * *", label: "Every 15 minutes" },
  { value: "0 * * * *", label: "Hourly, on the hour" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "30 2 * * *", label: "Daily at 02:30" },
  { value: "0 4 * * *", label: "Daily at 04:00" },
  { value: "30 2 * * 1-5", label: "Weekdays at 02:30" },
  { value: "0 3 * * 0", label: "Weekly, Sunday at 03:00" },
  { value: "0 3 1 * *", label: "Monthly, the 1st at 03:00" },
];

interface Field {
  values: number[];
  /** The field is a bare `*` — no restriction at all. */
  wildcard: boolean;
  /** Step from a slash-interval form, which reads as an interval rather than a list. */
  step: number | null;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function ordinal(value: number): string {
  const rem100 = value % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${value}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th";
  return `${value}${suffix}`;
}

function listJoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function fieldValue(
  text: string | undefined,
  min: number,
  max: number,
  names?: readonly string[],
): number | null {
  if (text === undefined || text === "") return null;
  const named = names ? names.indexOf(text.toUpperCase()) : -1;
  if (named >= 0) return named + min;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names?: readonly string[],
): Field | null {
  const values = new Set<number>();
  let wildcard = true;
  let step: number | null = null;

  for (const part of raw.split(",")) {
    const [range, stepText] = part.split("/");
    const stride = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(stride) || stride < 1) return null;

    let low: number;
    let high: number;

    if (range === undefined || range === "*" || range === "?") {
      low = min;
      high = max;
      if (stepText !== undefined) {
        wildcard = false;
        step = stride;
      }
    } else if (range.includes("-")) {
      wildcard = false;
      const [from, to] = range.split("-");
      const lo = fieldValue(from, min, max, names);
      const hi = fieldValue(to, min, max, names);
      if (lo === null || hi === null || lo > hi) return null;
      low = lo;
      high = hi;
    } else {
      wildcard = false;
      const only = fieldValue(range, min, max, names);
      if (only === null) return null;
      low = only;
      // `5/15` means "from 5 onwards, every 15" — not "just 5".
      high = stepText === undefined ? only : max;
      if (stepText !== undefined) step = stride;
    }

    for (let value = low; value <= high; value += stride) values.add(value);
  }

  if (values.size === 0) return null;
  return { values: [...values].sort((a, b) => a - b), wildcard, step };
}

/** Cron accepts both 0 and 7 for Sunday. */
function normalizeWeekdays(field: Field): Field {
  const values = [...new Set(field.values.map((value) => (value === 7 ? 0 : value)))].sort(
    (a, b) => a - b,
  );
  return { ...field, values };
}

function timePhrase(minute: Field, hour: Field): string {
  if (minute.wildcard && hour.wildcard) return "Every minute";
  if (minute.step !== null && hour.wildcard) return `Every ${minute.step} minutes`;

  if (minute.wildcard) {
    const hours = hour.values.map((value) => `${pad2(value)}:00`);
    return `Every minute of ${listJoin(hours)}`;
  }

  if (hour.wildcard) {
    if (minute.values.length === 1) return `Every hour at :${pad2(minute.values[0] as number)}`;
    const past = minute.values.map((value) => `:${pad2(value)}`);
    return `At ${listJoin(past)} past every hour`;
  }

  if (hour.step !== null && minute.values.length === 1) {
    return `Every ${hour.step} hours at :${pad2(minute.values[0] as number)}`;
  }

  const times: string[] = [];
  for (const h of hour.values) for (const m of minute.values) times.push(`${pad2(h)}:${pad2(m)}`);

  if (times.length <= MAX_LISTED_TIMES) return `At ${listJoin(times)}`;
  return `At ${times.slice(0, 3).join(", ")} and ${times.length - 3} other times`;
}

function weekdayPhrase(values: readonly number[]): string {
  const set = new Set(values);
  if (values.length === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return "weekdays";
  if (values.length === 2 && set.has(0) && set.has(6)) return "weekends";
  return listJoin(values.map((day) => DAY_NAMES[day] ?? String(day)));
}

function dayPhrase(dayOfMonth: Field, month: Field, dayOfWeek: Field): string {
  const clauses: string[] = [];

  if (dayOfMonth.wildcard && dayOfWeek.wildcard) {
    clauses.push("every day");
  } else {
    const parts: string[] = [];
    if (!dayOfMonth.wildcard) {
      parts.push(
        dayOfMonth.step !== null && dayOfMonth.values.length > 3
          ? `every ${dayOfMonth.step} days from the ${ordinal(dayOfMonth.values[0] as number)}`
          : `on the ${listJoin(dayOfMonth.values.map(ordinal))}`,
      );
    }
    // Standard cron ORs the two day fields when both are restricted.
    if (!dayOfWeek.wildcard) parts.push(`on ${weekdayPhrase(dayOfWeek.values)}`);
    clauses.push(parts.join(" or "));
  }

  if (!month.wildcard) {
    clauses.push(`in ${listJoin(month.values.map((m) => MONTH_NAMES[m - 1] ?? String(m)))}`);
  }

  return clauses.join(" ");
}

/**
 * Renders a five-field expression as a sentence. `timezone` is appended
 * because "02:30" without a zone is exactly the ambiguity that makes an
 * operator open a calculator.
 */
export function describeCron(expression: string, timezone?: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return UNRECOGNISED;

  const minute = parseField(parts[0] as string, 0, 59);
  const hour = parseField(parts[1] as string, 0, 23);
  const dayOfMonth = parseField(parts[2] as string, 1, 31);
  const month = parseField(parts[3] as string, 1, 12, MONTH_ABBR);
  const weekday = parseField(parts[4] as string, 0, 7, DAY_ABBR);
  if (!minute || !hour || !dayOfMonth || !month || !weekday) return UNRECOGNISED;

  const time = timePhrase(minute, hour);
  const day = dayPhrase(dayOfMonth, month, normalizeWeekdays(weekday));

  // A phrase that already reads as an interval — "every hour", "every 15
  // minutes" — covers every day by construction, so saying so twice only
  // makes it longer.
  const recurring = minute.wildcard || minute.step !== null || hour.wildcard || hour.step !== null;
  const sentence = day === "every day" && recurring ? time : `${time} ${day}`;

  return timezone ? `${sentence} (${timezone})` : sentence;
}

export function isCronRecognised(expression: string): boolean {
  return describeCron(expression) !== UNRECOGNISED;
}

/**
 * IANA zones the browser knows, for the schedule form. Falls back to a
 * short list plus the browser's own zone where `supportedValuesOf` is
 * unavailable, so the control is never empty.
 */
export function timeZoneOptions(): string[] {
  const local =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  const supported =
    typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];

  return [...new Set(["UTC", local, ...supported])].filter(Boolean);
}
