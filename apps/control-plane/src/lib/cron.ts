import { ApiException } from "./errors.js";

/* ------------------------------------------------------------------ *
 * Cron
 *
 * Shared by the schedules routes (which store next_run_at) and the
 * backup scheduler (which advances it), so the time the panel shows and
 * the time a backup actually starts come from the same arithmetic.
 *
 * A dependency for this would be five fields of parsing plus a timezone
 * database we already have in `Intl`. Standard five-field cron: minute,
 * hour, day-of-month, month, day-of-week.
 * ------------------------------------------------------------------ */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = [
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
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** How far ahead we are willing to look before calling an expression unreachable. */
const CRON_HORIZON_YEARS = 5;

/**
 * The stored next_run_at. A disabled schedule has none; an expression
 * that can never fire is rejected here rather than becoming a backup
 * that silently never happens.
 */
export function computeNextRun(
  cron: string,
  timeZone: string,
  enabled: boolean,
  from = new Date(),
): Date | null {
  if (!enabled) return null;
  const next = nextCronRun(cron, timeZone, from);
  if (!next) {
    throw new ApiException(
      "validation_failed",
      `"${cron}" never comes round — there is no matching date in the next ${CRON_HORIZON_YEARS} years.`,
      {
        fields: { cron: "matches no real date, e.g. February 30th" },
        remediation: {
          summary: "Check the day-of-month and month fields against each other.",
          actions: [{ label: "Copy example", copy: "30 2 * * *" }],
        },
      },
    );
  }
  return next;
}

/** The first matching minute strictly after `from`, as an instant. */
export function nextCronRun(expression: string, timeZone: string, from = new Date()): Date | null {
  const fields = parseCron(expression);
  assertTimeZone(timeZone);

  // Walk wall-clock time in the schedule's own zone, then convert the
  // match back to an instant. Doing it the other way round drifts by an
  // hour twice a year, which is exactly when nobody is watching.
  const start = zoneParts(new Date(from.getTime() + 60_000), timeZone);
  let cursor = new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute));
  const limit = start.year + CRON_HORIZON_YEARS;

  while (cursor.getUTCFullYear() <= limit) {
    if (!fields.months.has(cursor.getUTCMonth() + 1)) {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 0, 0));
      continue;
    }
    if (!dayMatches(fields, cursor)) {
      cursor = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, 0, 0),
      );
      continue;
    }
    if (!fields.hours.has(cursor.getUTCHours())) {
      cursor = new Date(cursor.getTime() + 3_600_000 - (cursor.getTime() % 3_600_000));
      continue;
    }
    if (!fields.minutes.has(cursor.getUTCMinutes())) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }
    return wallClockToInstant(cursor, timeZone);
  }
  return null;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ApiException(
      "validation_failed",
      `"${expression}" is not a five-field cron expression.`,
      {
        fields: { cron: "expected: minute hour day-of-month month day-of-week" },
        remediation: {
          summary: "Five fields, space separated. Daily at 02:30 is `30 2 * * *`.",
          actions: [{ label: "Copy example", copy: "30 2 * * *" }],
        },
      },
    );
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 0, 59, "minute"),
    hours: parseField(hour, 0, 23, "hour"),
    daysOfMonth: parseField(dom, 1, 31, "day-of-month"),
    months: parseField(month, 1, 12, "month", MONTH_NAMES),
    daysOfWeek: parseField(dow, 0, 6, "day-of-week", DAY_NAMES),
    domRestricted: !isWildcard(dom),
    dowRestricted: !isWildcard(dow),
  };
}

function isWildcard(field: string): boolean {
  return field === "*" || field === "?";
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  names?: string[],
): Set<number> {
  const out = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw cronFieldError(label, part, "the step after `/` must be a positive whole number");
    }

    let low: number;
    let high: number;
    if (range === undefined || isWildcard(range)) {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      low = fieldValue(a, min, max, label, names);
      high = fieldValue(b, min, max, label, names);
    } else {
      low = fieldValue(range, min, max, label, names);
      // "5/15" means "from 5 onwards, every 15", not "just 5".
      high = stepText === undefined ? low : max;
    }
    if (low > high) throw cronFieldError(label, part, `${low} is after ${high}`);

    for (let value = low; value <= high; value += step) out.add(value);
  }

  if (out.size === 0) throw cronFieldError(label, field, "it matches nothing");
  return out;
}

function fieldValue(
  text: string | undefined,
  min: number,
  max: number,
  label: string,
  names?: string[],
): number {
  if (text === undefined || text === "") throw cronFieldError(label, "", "it is empty");

  // Names index from the field's own minimum: JAN is month 1, SUN is day 0.
  const named = names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + min;

  const value = Number(text);
  // Cron allows 7 for Sunday as well as 0.
  if (label === "day-of-week" && value === 7) return 0;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw cronFieldError(label, text, `it must be between ${min} and ${max}`);
  }
  return value;
}

function cronFieldError(label: string, part: string, why: string): ApiException {
  return new ApiException(
    "validation_failed",
    `The ${label} field of this cron expression is invalid.`,
    {
      fields: { cron: `"${part}": ${why}` },
      remediation: {
        summary: "Five fields, space separated. Daily at 02:30 is `30 2 * * *`.",
        actions: [{ label: "Copy example", copy: "30 2 * * *" }],
      },
    },
  );
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.daysOfMonth.has(date.getUTCDate());
  const dow = fields.daysOfWeek.has(date.getUTCDay());
  // Standard cron: when both are restricted, either one matching is enough.
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ApiException("validation_failed", `"${timeZone}" is not a known time zone.`, {
      fields: { timezone: "must be an IANA zone name" },
      remediation: {
        summary: 'Use an IANA name such as "Europe/Berlin", "America/New_York" or "UTC".',
        actions: [{ label: "Copy UTC", copy: "UTC" }],
      },
    });
  }
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    // Some ICU builds render midnight as hour 24.
    hour: Number(map.get("hour")) % 24,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

function wallEpoch(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** `wall` carries the intended local clock encoded as UTC. */
function wallClockToInstant(wall: Date, timeZone: string): Date {
  const target = wall.getTime();
  // One correction pass, because the offset at the guessed instant is the
  // one that actually applies across a DST boundary.
  const guess = new Date(target - zoneOffsetMs(wall, timeZone));
  let instant = new Date(target - zoneOffsetMs(guess, timeZone));

  // The hour a spring-forward skips has no instant at all, and the
  // arithmetic above lands before it. Running a backup early and then
  // again at the real time is worse than running it late, so walk up to
  // the first minute the local clock actually reaches.
  for (let i = 0; i < 180 && wallEpoch(instant, timeZone) < target; i += 1) {
    instant = new Date(instant.getTime() + 60_000);
  }
  return instant;
}

