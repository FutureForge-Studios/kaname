"use client";

import * as React from "react";
import type { TimeRange } from "@kaname/contract";
import { CalendarClock } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { Button } from "./Button.js";
import { Input } from "./Input.js";
import { Popover } from "./Popover.js";

/* ------------------------------------------------------------------ *
 * TimeRangePicker — the range control every metrics and log surface
 * shares. Presets are relative to "now" and resolved at read time, so a
 * dashboard left open keeps meaning the last hour rather than the hour
 * that was current when it loaded. An absolute range is pinned.
 * ------------------------------------------------------------------ */

export type TimeRangeValue =
  { kind: "preset"; preset: TimeRange } | { kind: "absolute"; from: string; to: string };

export const TIME_RANGE_PRESETS: readonly TimeRange[] = ["1h", "6h", "24h", "7d", "30d", "90d"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIME_RANGE_MS: Record<TimeRange, number> = {
  "1h": HOUR,
  "6h": 6 * HOUR,
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
};

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "1h": "1h",
  "6h": "6h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
};

const TIME_RANGE_DESCRIPTIONS: Record<TimeRange, string> = {
  "1h": "Last hour",
  "6h": "Last 6 hours",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

/** Collapses either shape into the absolute millisecond window to query. */
export function resolveTimeRange(
  value: TimeRangeValue,
  now: number = Date.now(),
): {
  from: number;
  to: number;
} {
  if (value.kind === "absolute") {
    return { from: Date.parse(value.from), to: Date.parse(value.to) };
  }
  return { from: now - TIME_RANGE_MS[value.preset], to: now };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export type TimeRangePickerSize = "xs" | "sm";

const SEGMENT_SIZES: Record<TimeRangePickerSize, string> = {
  xs: "h-5 px-1.5 text-2xs",
  sm: "h-6 px-2 text-xs",
};

const FRAME_SIZES: Record<TimeRangePickerSize, string> = {
  xs: "h-6",
  sm: "h-7",
};

export interface TimeRangePickerProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "onChange"
> {
  value: TimeRangeValue;
  onChange: (value: TimeRangeValue) => void;
  presets?: readonly TimeRange[];
  allowCustom?: boolean;
  size?: TimeRangePickerSize;
  disabled?: boolean;
  label?: string;
}

export const TimeRangePicker = React.forwardRef<HTMLDivElement, TimeRangePickerProps>(
  function TimeRangePicker(
    {
      value,
      onChange,
      presets = TIME_RANGE_PRESETS,
      allowCustom = true,
      size = "sm",
      disabled = false,
      label = "Time range",
      className,
      ...props
    },
    ref,
  ) {
    const uid = React.useId();
    const [open, setOpen] = React.useState(false);
    const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

    const isCustom = value.kind === "absolute";
    const activeIndex = isCustom ? presets.length : Math.max(0, presets.indexOf(value.preset));
    const itemCount = presets.length + (allowCustom ? 1 : 0);

    const [draftFrom, setDraftFrom] = React.useState("");
    const [draftTo, setDraftTo] = React.useState("");

    // Seed the form from the live value each time the popover opens.
    React.useEffect(() => {
      if (!open) return;
      const now = Date.now();
      const resolved = resolveTimeRange(value, now);
      setDraftFrom(toLocalInput(new Date(resolved.from).toISOString()));
      setDraftTo(toLocalInput(new Date(resolved.to).toISOString()));
    }, [open, value]);

    const fromIso = fromLocalInput(draftFrom);
    const toIso = fromLocalInput(draftTo);
    const invalid =
      draftFrom.length > 0 && draftTo.length > 0 && (!fromIso || !toIso || fromIso >= toIso);
    const canApply = Boolean(fromIso && toIso && !invalid);

    const move = React.useCallback(
      (next: number) => {
        const index = (next + itemCount) % itemCount;
        itemRefs.current[index]?.focus();
        const preset = presets[index];
        if (preset) onChange({ kind: "preset", preset });
      },
      [itemCount, presets, onChange],
    );

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          move(activeIndex + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          move(activeIndex - 1);
          break;
        case "Home":
          event.preventDefault();
          move(0);
          break;
        case "End":
          event.preventDefault();
          move(itemCount - 1);
          break;
        default:
          break;
      }
    };

    const segmentClass = (selected: boolean) =>
      cn(
        "inline-flex select-none items-center justify-center rounded-[var(--kn-r-xs)] font-medium",
        "transition-[background-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant(SEGMENT_SIZES, size, "sm"),
        selected
          ? "bg-[var(--kn-surface-3)] text-[var(--kn-text)]"
          : "text-[var(--kn-text-2)] hover:bg-[var(--kn-surface-2)] hover:text-[var(--kn-text)]",
      );

    return (
      <div
        ref={ref}
        role="radiogroup"
        aria-label={label}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-0.5",
          variant(FRAME_SIZES, size, "sm"),
          className,
        )}
        {...props}
      >
        {presets.map((preset, index) => {
          const selected = !isCustom && value.preset === preset;
          return (
            <button
              key={preset}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={TIME_RANGE_DESCRIPTIONS[preset]}
              tabIndex={index === activeIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange({ kind: "preset", preset })}
              className={cn("tabular-nums", segmentClass(selected))}
            >
              {TIME_RANGE_LABELS[preset]}
            </button>
          );
        })}

        {allowCustom && (
          <Popover
            open={open}
            onOpenChange={setOpen}
            placement="bottom-end"
            trapFocus
            label="Custom time range"
            trigger={
              <button
                ref={(el) => {
                  itemRefs.current[presets.length] = el;
                }}
                type="button"
                role="radio"
                aria-checked={isCustom}
                aria-label="Custom absolute range"
                tabIndex={presets.length === activeIndex ? 0 : -1}
                disabled={disabled}
                className={cn("gap-1", segmentClass(isCustom))}
              >
                <CalendarClock size={12} aria-hidden />
                {isCustom ? (
                  <span className="tabular-nums font-mono">
                    {formatStamp(value.from)} – {formatStamp(value.to)}
                  </span>
                ) : (
                  "Custom"
                )}
              </button>
            }
          >
            <div className="flex w-56 flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`${uid}-from`}
                  className="text-xs font-medium text-[var(--kn-text-2)]"
                >
                  From
                </label>
                <Input
                  id={`${uid}-from`}
                  type="datetime-local"
                  mono
                  value={draftFrom}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraftFrom(event.target.value)
                  }
                />
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`${uid}-to`}
                  className="text-xs font-medium text-[var(--kn-text-2)]"
                >
                  To
                </label>
                <Input
                  id={`${uid}-to`}
                  type="datetime-local"
                  mono
                  value={draftTo}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraftTo(event.target.value)
                  }
                  invalid={invalid}
                />
              </div>

              <p
                role={invalid ? "alert" : undefined}
                className={cn(
                  "text-xs",
                  invalid ? "text-[var(--kn-danger)]" : "text-[var(--kn-text-3)]",
                )}
              >
                {invalid ? "The start must fall before the end." : "Times are in your local zone."}
              </p>

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!canApply}
                  onClick={() => {
                    if (!fromIso || !toIso) return;
                    onChange({ kind: "absolute", from: fromIso, to: toIso });
                    setOpen(false);
                  }}
                >
                  Apply
                </Button>
              </div>
            </div>
          </Popover>
        )}
      </div>
    );
  },
);
