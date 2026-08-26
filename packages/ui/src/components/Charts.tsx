"use client";

import * as React from "react";
import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Charts — hand-built SVG, no charting library (KD-006).
 *
 * Four shapes cover the whole product: Sparkline (inline, in a table
 * cell), LineChart / AreaChart (time series) and BarChart (categorical).
 * Everything is token-themed, tabular-numeral, keyboard-and-screen-
 * reader reachable through a visually-hidden data table, and drawn only
 * once a real width has been measured — which also keeps the markup
 * identical on both sides of hydration.
 * ------------------------------------------------------------------ */

export interface ChartPoint {
  x: number;
  /** `null` is a real gap in the series, not a zero. */
  y: number | null;
}

export interface ChartSeries {
  id: string;
  label?: string;
  /** Overrides the ramp position. Must be a token reference. */
  color?: string;
  data: readonly ChartPoint[];
}

export interface ChartMargin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const CHART_COLORS = [
  "var(--kn-chart-1)",
  "var(--kn-chart-2)",
  "var(--kn-chart-3)",
  "var(--kn-chart-4)",
  "var(--kn-chart-5)",
  "var(--kn-chart-6)",
] as const;

const DEFAULT_MARGIN: ChartMargin = { top: 8, right: 8, bottom: 20, left: 44 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TIME_STEPS = [
  1_000,
  5_000,
  15_000,
  30_000,
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
];

/* ----------------------------- helpers ----------------------------- */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function seriesColor(series: ChartSeries | BarSeries, index: number): string {
  return series.color ?? CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}

/** Default y-axis formatter: compact, at most one decimal. */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  const scale =
    abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "k"] : [1, ""];
  const divisor = scale[0] as number;
  const suffix = scale[1] as string;
  const scaled = value / divisor;
  const decimals =
    divisor === 1 ? (Number.isInteger(value) ? 0 : 2) : Math.abs(scaled) < 10 ? 1 : 0;
  return `${scaled.toFixed(decimals).replace(/\.0+$/, "")}${suffix}`;
}

function niceNum(range: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  const nice = round
    ? fraction < 1.5
      ? 1
      : fraction < 3
        ? 2
        : fraction < 7
          ? 5
          : 10
    : fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 5
          ? 5
          : 10;
  return nice * 10 ** exponent;
}

interface LinearScale {
  min: number;
  max: number;
  ticks: number[];
}

function niceScale(min: number, max: number, count: number): LinearScale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const step = niceNum(niceNum(max - min, false) / Math.max(1, count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Number(v.toFixed(decimals + 2)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

/** Tick density is driven by pixels, so a narrow chart never crowds. */
function timeTicks(min: number, max: number, width: number): { values: number[]; step: number } {
  const target = Math.max(2, Math.floor(width / 88));
  const span = Math.max(1, max - min);
  const ideal = span / target;
  const step = TIME_STEPS.find((s) => s >= ideal) ?? Math.ceil(ideal / DAY) * DAY;
  const values: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) values.push(v);
  if (values.length === 0) values.push(min, max);
  return { values, step };
}

export function formatTimeTick(ts: number, step: number): string {
  const d = new Date(ts);
  if (step < MINUTE) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (step < DAY) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (step < 30 * DAY) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function nearestIndex(xs: readonly number[], value: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo > 0 ? lo - 1 : 0;
  return Math.abs((xs[prev] as number) - value) <= Math.abs((xs[lo] as number) - value) ? prev : lo;
}

/** Splits on nulls so a gap stays a gap instead of a straight lie across it. */
function buildPaths(
  data: readonly ChartPoint[],
  toX: (x: number) => number,
  toY: (y: number) => number,
  baseline: number,
): { line: string; area: string } {
  let line = "";
  let area = "";
  let run: string[] = [];
  let runStartX = 0;
  let runEndX = 0;

  const flush = () => {
    if (run.length === 0) return;
    const d = `M${run.join("L")}`;
    line += d;
    if (run.length === 1) {
      run = [];
      return;
    }
    area += `${d}L${runEndX},${baseline}L${runStartX},${baseline}Z`;
    run = [];
  };

  for (const point of data) {
    if (point.y === null || !Number.isFinite(point.y)) {
      flush();
      continue;
    }
    const px = toX(point.x);
    const py = toY(point.y);
    if (run.length === 0) runStartX = px;
    runEndX = px;
    run.push(`${px},${py}`);
  }
  flush();
  return { line, area };
}

/* ------------------------ useChartDimensions ----------------------- */

export interface UseChartDimensionsOptions {
  height?: number;
  margin?: Partial<ChartMargin>;
}

export interface ChartDimensions<E extends HTMLElement> {
  ref: React.RefObject<E | null>;
  width: number;
  height: number;
  margin: ChartMargin;
  innerWidth: number;
  innerHeight: number;
  /** False until a real width has been measured; nothing should be drawn before. */
  measured: boolean;
}

export function useChartDimensions<E extends HTMLElement = HTMLDivElement>(
  options: UseChartDimensionsOptions = {},
): ChartDimensions<E> {
  const { height: fixedHeight, margin: marginOverride } = options;
  const ref = React.useRef<E | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((prev) =>
        Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
          ? prev
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const margin = React.useMemo<ChartMargin>(
    () => ({ ...DEFAULT_MARGIN, ...marginOverride }),
    [marginOverride],
  );

  const height = fixedHeight ?? size.height;
  return {
    ref,
    width: size.width,
    height,
    margin,
    innerWidth: Math.max(0, size.width - margin.left - margin.right),
    innerHeight: Math.max(0, height - margin.top - margin.bottom),
    measured: size.width > 0 && height > 0,
  };
}

/* --------------------------- shared parts -------------------------- */

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--kn-text-3)]">
      {label}
    </div>
  );
}

interface FallbackTableProps {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

/** The chart's data, reachable by a screen reader without reading the SVG. */
function ChartFallbackTable({ caption, columns, rows }: FallbackTableProps) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={cellIndex}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TooltipRow {
  id: string;
  label: string;
  color: string;
  value: string;
}

function ChartTooltip({
  x,
  width,
  title,
  rows,
}: {
  x: number;
  width: number;
  title: string;
  rows: readonly TooltipRow[];
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-[var(--kn-r-md)] border border-[var(--kn-border-strong)]",
        "bg-[var(--kn-surface-2)] px-2 py-1.5 shadow-[var(--kn-shadow-md)]",
        "animate-[var(--animate-fade-in)] motion-reduce:animate-none",
      )}
      style={{ left: clamp(x, 76, Math.max(76, width - 76)) }}
      role="presentation"
    >
      <div className="mb-1 font-mono text-2xs text-[var(--kn-text-3)]">{title}</div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2 whitespace-nowrap">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-[var(--kn-r-xs)]"
              style={{ background: row.color }}
            />
            <span className="min-w-0 flex-1 truncate text-2xs text-[var(--kn-text-2)]">
              {row.label}
            </span>
            <span className="tabular-nums font-mono text-2xs text-[var(--kn-text)]">
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartLegend({
  items,
}: {
  items: readonly { id: string; label: string; color: string }[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-1.5 text-xs text-[var(--kn-text-2)]">
          <span
            aria-hidden
            className="h-1.5 w-3 shrink-0 rounded-[var(--kn-r-xs)]"
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------- Sparkline --------------------------- */

export interface SparklineProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  values: readonly (number | null)[];
  /** Omit to measure the container instead. */
  width?: number;
  height?: number;
  area?: boolean;
  color?: string;
  showLastPoint?: boolean;
  /** Accessible name — a sparkline has no axes to read. */
  label: string;
}

export const Sparkline = React.forwardRef<HTMLDivElement, SparklineProps>(function Sparkline(
  {
    values,
    width,
    height = 24,
    area = false,
    color = "var(--kn-chart-1)",
    showLastPoint = true,
    label,
    className,
    ...props
  },
  forwardedRef,
) {
  const gradientId = React.useId();
  const measured = useChartDimensions<HTMLDivElement>({
    height,
    margin: { top: 2, right: 2, bottom: 2, left: 2 },
  });
  React.useImperativeHandle(forwardedRef, () => measured.ref.current as HTMLDivElement);

  const w = width ?? measured.width;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const ready = w > 0 && finite.length > 0;

  let line = "";
  let areaPath = "";
  let lastX = 0;
  let lastY = 0;

  if (ready) {
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const span = max - min || 1;
    const innerW = Math.max(1, w - 4);
    const innerH = Math.max(1, height - 4);
    const step = values.length > 1 ? innerW / (values.length - 1) : 0;
    const toX = (i: number) => 2 + (values.length > 1 ? i * step : innerW / 2);
    const toY = (v: number) => 2 + innerH - ((v - min) / span) * innerH;
    const points: ChartPoint[] = values.map((v, i) => ({ x: i, y: v }));
    const built = buildPaths(points, (i) => toX(i), toY, height - 2);
    line = built.line;
    areaPath = built.area;
    const lastIndex = values.reduce<number>(
      (acc, v, i) => (v !== null && Number.isFinite(v) ? i : acc),
      -1,
    );
    const lastValue = lastIndex >= 0 ? values[lastIndex] : null;
    if (lastValue !== null && lastValue !== undefined) {
      lastX = toX(lastIndex);
      lastY = toY(lastValue);
    }
  }

  return (
    <div
      ref={measured.ref}
      className={cn("relative inline-block align-middle", className)}
      style={{ width: width ?? "100%", height }}
      {...props}
    >
      {ready && (
        <svg
          width={w}
          height={height}
          viewBox={`0 0 ${w} ${height}`}
          role="img"
          aria-label={label}
          className="block overflow-visible"
        >
          {area && (
            <>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <path d={areaPath} fill={`url(#${gradientId})`} />
            </>
          )}
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* A single sample still deserves a mark, otherwise it renders as nothing. */}
          {(showLastPoint || finite.length === 1) && (
            <circle cx={lastX} cy={lastY} r={2} fill={color} />
          )}
        </svg>
      )}
    </div>
  );
});

/* -------------------------- time series ---------------------------- */

export interface TimeSeriesChartProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  series: readonly ChartSeries[];
  /** Accessible title rendered into the SVG. */
  title: string;
  description?: string;
  height?: number;
  margin?: Partial<ChartMargin>;
  yTickCount?: number;
  yDomain?: [number | null, number | null];
  formatValue?: (value: number) => string;
  showGrid?: boolean;
  showLegend?: boolean;
  emptyLabel?: string;
}

interface InternalTimeSeriesProps extends TimeSeriesChartProps {
  area: boolean;
}

function TimeSeriesChart({
  series,
  title,
  description,
  height = 200,
  margin: marginOverride,
  yTickCount = 4,
  yDomain,
  formatValue = formatCompactNumber,
  showGrid = true,
  showLegend,
  emptyLabel = "No data for this range",
  area,
  className,
  ...props
}: InternalTimeSeriesProps) {
  const uid = React.useId();
  const dims = useChartDimensions<HTMLDivElement>({ height, margin: marginOverride });
  const [hover, setHover] = React.useState<number | null>(null);

  const xs = React.useMemo(() => {
    const set = new Set<number>();
    for (const s of series) for (const p of s.data) set.add(p.x);
    return [...set].sort((a, b) => a - b);
  }, [series]);

  const lookups = React.useMemo(
    () => series.map((s) => new Map(s.data.map((p) => [p.x, p.y]))),
    [series],
  );

  const yScale = React.useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (const p of s.data) {
        if (p.y === null || !Number.isFinite(p.y)) continue;
        if (p.y < min) min = p.y;
        if (p.y > max) max = p.y;
      }
    }
    if (min === Infinity) return niceScale(0, 1, yTickCount);
    const lo = yDomain?.[0] ?? Math.min(min, 0 <= min && min < max * 0.4 ? 0 : min);
    const hi = yDomain?.[1] ?? max;
    return niceScale(lo, hi, yTickCount);
  }, [series, yDomain, yTickCount]);

  const hasData = xs.length > 0 && series.some((s) => s.data.some((p) => p.y !== null));
  const legendItems = series.map((s, i) => ({
    id: s.id,
    label: s.label ?? s.id,
    color: seriesColor(s, i),
  }));
  const withLegend = showLegend ?? series.length > 1;

  const xMin = xs[0] ?? 0;
  const xMax = xs[xs.length - 1] ?? 1;
  const xSpan = xMax - xMin || 1;
  const { innerWidth, innerHeight, margin } = dims;

  const toX = React.useCallback(
    (x: number) => margin.left + ((x - xMin) / xSpan) * innerWidth,
    [margin.left, xMin, xSpan, innerWidth],
  );
  const toY = React.useCallback(
    (y: number) =>
      margin.top + innerHeight - ((y - yScale.min) / (yScale.max - yScale.min || 1)) * innerHeight,
    [margin.top, innerHeight, yScale.min, yScale.max],
  );

  const ticks = React.useMemo(() => timeTicks(xMin, xMax, innerWidth), [xMin, xMax, innerWidth]);

  const paths = React.useMemo(
    () => series.map((s) => buildPaths(s.data, toX, toY, margin.top + innerHeight)),
    [series, toX, toY, margin.top, innerHeight],
  );

  const handlePointer = (event: React.PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left;
    const value = xMin + (offset / Math.max(1, bounds.width)) * xSpan;
    const index = nearestIndex(xs, value);
    setHover(index >= 0 ? index : null);
  };

  const hoveredX = hover !== null ? xs[hover] : undefined;
  const tooltipRows: TooltipRow[] =
    hoveredX === undefined
      ? []
      : series.map((s, i) => {
          const y = lookups[i]?.get(hoveredX);
          return {
            id: s.id,
            label: s.label ?? s.id,
            color: seriesColor(s, i),
            value: y === null || y === undefined ? "—" : formatValue(y),
          };
        });

  const fallbackRows = React.useMemo(() => {
    const stride = Math.max(1, Math.ceil(xs.length / 200));
    const rows: string[][] = [];
    for (let i = 0; i < xs.length; i += stride) {
      const x = xs[i] as number;
      rows.push([
        formatTimestamp(x),
        ...series.map((_, si) => {
          const y = lookups[si]?.get(x);
          return y === null || y === undefined ? "no data" : formatValue(y);
        }),
      ]);
    }
    return rows;
  }, [xs, series, lookups, formatValue]);

  return (
    <div className={cn("flex min-w-0 flex-col", className)} {...props}>
      <div ref={dims.ref} className="relative min-w-0" style={{ height }}>
        {!hasData && <ChartEmpty label={emptyLabel} />}
        {hasData && dims.measured && (
          <>
            <svg
              width={dims.width}
              height={height}
              viewBox={`0 0 ${dims.width} ${height}`}
              role="img"
              aria-labelledby={`${uid}-title${description ? ` ${uid}-desc` : ""}`}
              className="block"
            >
              <title id={`${uid}-title`}>{title}</title>
              {description && <desc id={`${uid}-desc`}>{description}</desc>}

              {area && (
                <defs>
                  {series.map((s, i) => (
                    <linearGradient key={s.id} id={`${uid}-fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={seriesColor(s, i)} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={seriesColor(s, i)} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
              )}

              {showGrid &&
                yScale.ticks.map((tick) => (
                  <line
                    key={tick}
                    x1={margin.left}
                    x2={margin.left + innerWidth}
                    y1={toY(tick)}
                    y2={toY(tick)}
                    stroke="var(--kn-chart-grid)"
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                ))}

              <g className="tabular-nums" fontSize={10} fill="var(--kn-text-3)">
                {yScale.ticks.map((tick) => (
                  <text
                    key={tick}
                    x={margin.left - 8}
                    y={toY(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {formatValue(tick)}
                  </text>
                ))}
                {ticks.values.map((tick) => (
                  <text
                    key={tick}
                    x={toX(tick)}
                    y={margin.top + innerHeight + 14}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {formatTimeTick(tick, ticks.step)}
                  </text>
                ))}
              </g>

              <g className="transition-opacity duration-[var(--kn-dur)] ease-[var(--kn-ease)] motion-reduce:transition-none">
                {series.map((s, i) => {
                  const built = paths[i];
                  if (!built) return null;
                  return (
                    <g key={s.id}>
                      {area && <path d={built.area} fill={`url(#${uid}-fill-${i})`} />}
                      <path
                        d={built.line}
                        fill="none"
                        stroke={seriesColor(s, i)}
                        strokeWidth={1.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  );
                })}
              </g>

              {hoveredX !== undefined && (
                <g pointerEvents="none">
                  <line
                    x1={toX(hoveredX)}
                    x2={toX(hoveredX)}
                    y1={margin.top}
                    y2={margin.top + innerHeight}
                    stroke="var(--kn-border-strong)"
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                  {series.map((s, i) => {
                    const y = lookups[i]?.get(hoveredX);
                    if (y === null || y === undefined) return null;
                    return (
                      <circle
                        key={s.id}
                        cx={toX(hoveredX)}
                        cy={toY(y)}
                        r={2.5}
                        fill="var(--kn-bg)"
                        stroke={seriesColor(s, i)}
                        strokeWidth={1.5}
                      />
                    );
                  })}
                </g>
              )}

              <rect
                x={margin.left}
                y={margin.top}
                width={innerWidth}
                height={innerHeight}
                fill="transparent"
                onPointerMove={handlePointer}
                onPointerLeave={() => setHover(null)}
              />
            </svg>

            {hoveredX !== undefined && (
              <ChartTooltip
                x={toX(hoveredX)}
                width={dims.width}
                title={formatTimestamp(hoveredX)}
                rows={tooltipRows}
              />
            )}
          </>
        )}
      </div>

      {withLegend && hasData && <ChartLegend items={legendItems} />}

      <ChartFallbackTable
        caption={`${title}${description ? ` — ${description}` : ""}`}
        columns={["Time", ...series.map((s) => s.label ?? s.id)]}
        rows={fallbackRows}
      />
    </div>
  );
}

export function LineChart(props: TimeSeriesChartProps) {
  return <TimeSeriesChart {...props} area={false} />;
}

export function AreaChart(props: TimeSeriesChartProps) {
  return <TimeSeriesChart {...props} area />;
}

/* ----------------------------- BarChart ---------------------------- */

export interface BarSeries {
  id: string;
  label?: string;
  color?: string;
  values: readonly (number | null)[];
}

export interface BarChartProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  categories: readonly string[];
  series: readonly BarSeries[];
  title: string;
  description?: string;
  orientation?: "vertical" | "horizontal";
  stacked?: boolean;
  height?: number;
  margin?: Partial<ChartMargin>;
  tickCount?: number;
  formatValue?: (value: number) => string;
  showGrid?: boolean;
  showLegend?: boolean;
  emptyLabel?: string;
}

const BAND_PADDING = 0.24;
const GROUP_GAP = 2;

export function BarChart({
  categories,
  series,
  title,
  description,
  orientation = "vertical",
  stacked = false,
  height = 200,
  margin: marginOverride,
  tickCount = 4,
  formatValue = formatCompactNumber,
  showGrid = true,
  showLegend,
  emptyLabel = "No data",
  className,
  ...props
}: BarChartProps) {
  const uid = React.useId();
  const horizontal = orientation === "horizontal";
  const dims = useChartDimensions<HTMLDivElement>({
    height,
    margin: marginOverride ?? (horizontal ? { left: 84, bottom: 20 } : undefined),
  });
  const [hover, setHover] = React.useState<number | null>(null);

  const totals = React.useMemo(
    () =>
      categories.map((_, ci) => {
        let sum = 0;
        let max = 0;
        for (const s of series) {
          const v = s.values[ci];
          if (v === null || v === undefined || !Number.isFinite(v)) continue;
          sum += v;
          if (v > max) max = v;
        }
        return { sum, max };
      }),
    [categories, series],
  );

  const scale = React.useMemo(() => {
    const peak = totals.reduce((acc, t) => Math.max(acc, stacked ? t.sum : t.max), 0);
    return niceScale(0, peak, tickCount);
  }, [totals, stacked, tickCount]);

  const hasData = categories.length > 0 && totals.some((t) => t.sum !== 0);
  const { margin, innerWidth, innerHeight } = dims;
  const bandSize = (horizontal ? innerHeight : innerWidth) / Math.max(1, categories.length);
  const barSpan = bandSize * (1 - BAND_PADDING);
  const groupCount = stacked ? 1 : Math.max(1, series.length);
  const barThickness = Math.max(1, (barSpan - GROUP_GAP * (groupCount - 1)) / groupCount);

  const valueLength = horizontal ? innerWidth : innerHeight;
  const toLength = (value: number) => (value / (scale.max || 1)) * valueLength;
  const bandStart = (index: number) =>
    (horizontal ? margin.top : margin.left) + index * bandSize + (bandSize - barSpan) / 2;

  const legendItems = series.map((s, i) => ({
    id: s.id,
    label: s.label ?? s.id,
    color: seriesColor(s, i),
  }));
  const withLegend = showLegend ?? series.length > 1;

  const tooltipRows: TooltipRow[] =
    hover === null
      ? []
      : series.map((s, i) => {
          const v = s.values[hover];
          return {
            id: s.id,
            label: s.label ?? s.id,
            color: seriesColor(s, i),
            value: v === null || v === undefined ? "—" : formatValue(v),
          };
        });

  const fallbackRows = React.useMemo(
    () =>
      categories.map((category, ci) => [
        category,
        ...series.map((s) => {
          const v = s.values[ci];
          return v === null || v === undefined ? "no data" : formatValue(v);
        }),
      ]),
    [categories, series, formatValue],
  );

  return (
    <div className={cn("flex min-w-0 flex-col", className)} {...props}>
      <div ref={dims.ref} className="relative min-w-0" style={{ height }}>
        {!hasData && <ChartEmpty label={emptyLabel} />}
        {hasData && dims.measured && (
          <>
            <svg
              width={dims.width}
              height={height}
              viewBox={`0 0 ${dims.width} ${height}`}
              role="img"
              aria-labelledby={`${uid}-title${description ? ` ${uid}-desc` : ""}`}
              className="block"
            >
              <title id={`${uid}-title`}>{title}</title>
              {description && <desc id={`${uid}-desc`}>{description}</desc>}

              {showGrid &&
                scale.ticks.map((tick) =>
                  horizontal ? (
                    <line
                      key={tick}
                      x1={margin.left + toLength(tick)}
                      x2={margin.left + toLength(tick)}
                      y1={margin.top}
                      y2={margin.top + innerHeight}
                      stroke="var(--kn-chart-grid)"
                      strokeWidth={1}
                      shapeRendering="crispEdges"
                    />
                  ) : (
                    <line
                      key={tick}
                      x1={margin.left}
                      x2={margin.left + innerWidth}
                      y1={margin.top + innerHeight - toLength(tick)}
                      y2={margin.top + innerHeight - toLength(tick)}
                      stroke="var(--kn-chart-grid)"
                      strokeWidth={1}
                      shapeRendering="crispEdges"
                    />
                  ),
                )}

              <g className="tabular-nums" fontSize={10} fill="var(--kn-text-3)">
                {scale.ticks.map((tick) =>
                  horizontal ? (
                    <text
                      key={tick}
                      x={margin.left + toLength(tick)}
                      y={margin.top + innerHeight + 14}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {formatValue(tick)}
                    </text>
                  ) : (
                    <text
                      key={tick}
                      x={margin.left - 8}
                      y={margin.top + innerHeight - toLength(tick)}
                      textAnchor="end"
                      dominantBaseline="middle"
                    >
                      {formatValue(tick)}
                    </text>
                  ),
                )}
                {categories.map((category, ci) =>
                  horizontal ? (
                    <text
                      key={category}
                      x={margin.left - 8}
                      y={bandStart(ci) + barSpan / 2}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fill="var(--kn-text-2)"
                    >
                      {category}
                    </text>
                  ) : (
                    <text
                      key={category}
                      x={bandStart(ci) + barSpan / 2}
                      y={margin.top + innerHeight + 14}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="var(--kn-text-2)"
                    >
                      {category}
                    </text>
                  ),
                )}
              </g>

              {categories.map((category, ci) => {
                let stackOffset = 0;
                return (
                  <g
                    key={category}
                    className="transition-opacity duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)] motion-reduce:transition-none"
                    opacity={hover === null || hover === ci ? 1 : 0.5}
                    onPointerEnter={() => setHover(ci)}
                    onPointerLeave={() => setHover((prev) => (prev === ci ? null : prev))}
                  >
                    {series.map((s, si) => {
                      const raw = s.values[ci];
                      const value =
                        raw === null || raw === undefined || !Number.isFinite(raw) ? 0 : raw;
                      const length = toLength(value);
                      const offset = stacked ? stackOffset : 0;
                      if (stacked) stackOffset += length;
                      const along = stacked
                        ? bandStart(ci)
                        : bandStart(ci) + si * (barThickness + GROUP_GAP);
                      const thickness = stacked ? barSpan : barThickness;
                      return (
                        <rect
                          key={s.id}
                          x={horizontal ? margin.left + offset : along}
                          y={horizontal ? along : margin.top + innerHeight - offset - length}
                          width={horizontal ? Math.max(0, length) : thickness}
                          height={horizontal ? thickness : Math.max(0, length)}
                          rx={2}
                          fill={seriesColor(s, si)}
                        />
                      );
                    })}
                    <rect
                      x={horizontal ? margin.left : bandStart(ci) - (bandSize - barSpan) / 2}
                      y={horizontal ? bandStart(ci) - (bandSize - barSpan) / 2 : margin.top}
                      width={horizontal ? innerWidth : bandSize}
                      height={horizontal ? bandSize : innerHeight}
                      fill="transparent"
                    />
                  </g>
                );
              })}
            </svg>

            {hover !== null && (
              <ChartTooltip
                x={horizontal ? margin.left + innerWidth / 2 : bandStart(hover) + barSpan / 2}
                width={dims.width}
                title={categories[hover] ?? ""}
                rows={tooltipRows}
              />
            )}
          </>
        )}
      </div>

      {withLegend && hasData && <ChartLegend items={legendItems} />}

      <ChartFallbackTable
        caption={`${title}${description ? ` — ${description}` : ""}`}
        columns={["Category", ...series.map((s) => s.label ?? s.id)]}
        rows={fallbackRows}
      />
    </div>
  );
}
