"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import type { Tone } from "./Badge.js";

/* ------------------------------------------------------------------ *
 * MetricTile — a dense readout, not a dashboard card.
 *
 * Eight of these sit across a Command Center row, so the tile is sized
 * by its number: one line of label, one line of value. Direction and
 * meaning are separate inputs — on a server, "up" is good for free disk
 * and bad for load, so the caller states the tone rather than the tile
 * guessing from the sign.
 * ------------------------------------------------------------------ */

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

export type MetricTileSize = "sm" | "md";

const VALUE_SIZES: Record<MetricTileSize, string> = {
  sm: "text-lg",
  md: "text-xl",
};

const VALUE_TONES: Record<Tone, string> = {
  neutral: "text-[var(--kn-text)]",
  ok: "text-[var(--kn-ok)]",
  warn: "text-[var(--kn-warn)]",
  danger: "text-[var(--kn-danger)]",
  info: "text-[var(--kn-info)]",
  accent: "text-[var(--kn-accent-400)]",
};

const DELTA_TONES: Record<Tone, string> = {
  neutral: "text-[var(--kn-text-2)]",
  ok: "text-[var(--kn-ok)]",
  warn: "text-[var(--kn-warn)]",
  danger: "text-[var(--kn-danger)]",
  info: "text-[var(--kn-info)]",
  accent: "text-[var(--kn-accent-400)]",
};

const DELTA_ICONS: Record<MetricDeltaDirection, IconComponent> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
};

export type MetricDeltaDirection = "up" | "down" | "flat";

export interface MetricDelta {
  /** Preformatted, e.g. "+12%" or "-4.2 GiB". The tile never guesses units. */
  value: string;
  direction: MetricDeltaDirection;
  /** Whether this movement is good, bad or neither. Defaults to neither. */
  tone?: Tone;
  /** Comparison window, e.g. "vs. previous 24h". Read out, shown on hover. */
  label?: string;
}

export interface MetricTileProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Rendered small beside the value: "%", "GiB", "req/s". */
  unit?: React.ReactNode;
  icon?: IconComponent;
  delta?: MetricDelta;
  /** Threshold verdict for this reading. Colours the number only. */
  tone?: Tone;
  /** A `<Sparkline>`, sized by the tile. */
  sparkline?: React.ReactNode;
  size?: MetricTileSize;
}

export const MetricTile = React.forwardRef<HTMLDivElement, MetricTileProps>(function MetricTile(
  {
    label,
    value,
    unit,
    icon: Icon,
    delta,
    tone = "neutral",
    sparkline,
    size = "md",
    className,
    ...props
  },
  ref,
) {
  const DeltaIcon = delta ? DELTA_ICONS[delta.direction] : null;

  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)] px-3 py-2.5",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-1.5">
        {Icon && <Icon size={12} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />}
        <span className="truncate text-xs text-[var(--kn-text-2)]">{label}</span>
      </div>

      <div className="mt-1 flex items-baseline gap-1">
        <span
          className={cn(
            "kn-num font-medium leading-none",
            variant(VALUE_SIZES, size, "md"),
            variant(VALUE_TONES, tone, "neutral"),
          )}
        >
          {value}
        </span>
        {unit && <span className="text-xs text-[var(--kn-text-3)]">{unit}</span>}

        {delta && DeltaIcon && (
          <span
            title={delta.label}
            className={cn(
              "ml-auto inline-flex shrink-0 items-center gap-0.5 text-xs",
              variant(DELTA_TONES, delta.tone, "neutral"),
            )}
          >
            <DeltaIcon size={12} className="shrink-0" aria-hidden />
            <span className="kn-num">{delta.value}</span>
            {delta.label && <span className="sr-only">{delta.label}</span>}
          </span>
        )}
      </div>

      {sparkline && <div className="mt-2">{sparkline}</div>}
    </div>
  );
});
