"use client";

import * as React from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import type { Tone } from "./Badge.js";

/* ------------------------------------------------------------------ *
 * Editorial — the ffstudios.io vocabulary.
 *
 * These are the pieces that make a page read as FutureForge rather than
 * as a generic admin panel: the mono uppercase label, the eyebrow chip
 * with its purple square, the gradient second line, the numbered section
 * row, the leader annotation, the dot-and-sentence status line, the
 * check list, the hairline card with an inset panel, and the blueprint
 * backdrop with frame rails and crosshair marks.
 *
 * They carry no behaviour. Everything interactive still comes from the
 * rest of the kit; these only give it structure and voice. Usage and
 * the page anatomy they add up to are in docs/redesign-guide.md.
 * ------------------------------------------------------------------ */

export type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

/** "1" -> "01", "12" -> "12", "A" -> "A". The mono section number. */
export function formatIndex(index: number | string): string {
  if (typeof index === "number") return String(index).padStart(2, "0");
  return /^\d$/.test(index) ? `0${index}` : index;
}

/* ------------------------------ MonoLabel ------------------------------ */

export type MonoLabelTone = "subtle" | "muted" | "fg" | "accent" | Exclude<Tone, "neutral" | "accent">;
export type MonoLabelSize = "xs" | "sm";

const LABEL_TONES: Record<MonoLabelTone, string> = {
  subtle: "text-[var(--kn-text-3)]",
  muted: "text-[var(--kn-text-2)]",
  fg: "text-[var(--kn-text)]",
  accent: "text-[var(--kn-accent-400)]",
  ok: "text-[var(--kn-ok)]",
  warn: "text-[var(--kn-warn)]",
  danger: "text-[var(--kn-danger)]",
  info: "text-[var(--kn-info)]",
};

const LABEL_SIZES: Record<MonoLabelSize, string> = {
  xs: "kn-label-sm",
  sm: "kn-label",
};

export interface MonoLabelProps extends React.HTMLAttributes<HTMLElement> {
  /** Rendered element. Default `span`. */
  as?: "span" | "div" | "p" | "dt" | "label" | "h2" | "h3" | "h4";
  /** `xs` 10px, `sm` 11px (default). */
  size?: MonoLabelSize;
  tone?: MonoLabelTone;
}

/**
 * The mono, uppercase, wide-tracked label. For anything that annotates:
 * group labels, field captions, axis names, counters. Never for values
 * someone will copy — uppercase would lie about a hostname's case.
 */
export const MonoLabel = React.forwardRef<HTMLElement, MonoLabelProps>(function MonoLabel(
  { as = "span", size = "sm", tone = "subtle", className, ...props },
  ref,
) {
  const Component = as as React.ElementType;
  return (
    <Component
      ref={ref}
      className={cn(
        variant(LABEL_SIZES, size, "sm"),
        variant(LABEL_TONES, tone, "subtle"),
        className,
      )}
      {...props}
    />
  );
});

/* ------------------------------- Eyebrow ------------------------------- */

const MARKER_TONES: Record<Tone, string> = {
  neutral: "bg-[var(--kn-text-3)]",
  ok: "bg-[var(--kn-ok)]",
  warn: "bg-[var(--kn-warn)]",
  danger: "bg-[var(--kn-danger)]",
  info: "bg-[var(--kn-info)]",
  accent: "bg-[var(--kn-accent-500)]",
};

export interface EyebrowProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Colour of the trailing square. Default the brand purple. */
  tone?: Tone;
  /** Hide the trailing square. */
  marker?: boolean;
  /** Leading icon, 12px. */
  icon?: IconComponent;
}

/**
 * The ffstudios eyebrow: a hairline chip holding a mono uppercase word
 * and a small purple square ("STUDIO ▪"). One per page header or hero,
 * naming the area the page belongs to.
 */
export const Eyebrow = React.forwardRef<HTMLSpanElement, EyebrowProps>(function Eyebrow(
  { tone = "accent", marker = true, icon: Icon, className, children, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "kn-label-sm inline-flex h-6 max-w-full select-none items-center gap-2 whitespace-nowrap rounded-[var(--kn-r-sm)]",
        "border border-[var(--kn-border-strong)] px-2 text-[var(--kn-text-2)]",
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={12} className="shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
      {marker && (
        <span
          aria-hidden
          className={cn("h-1.5 w-2 shrink-0 rounded-[1px]", variant(MARKER_TONES, tone, "accent"))}
        />
      )}
    </span>
  );
});

/* ----------------------------- GradientText ---------------------------- */

export interface GradientTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Put the span on its own line — the second line of a headline. */
  block?: boolean;
}

/**
 * Purple-soft to purple text. Reserved for the second line of a hero
 * headline (onboarding, login, an empty canvas) — at most once per view,
 * and never on body copy or anything smaller than a title.
 */
export const GradientText = React.forwardRef<HTMLSpanElement, GradientTextProps>(
  function GradientText({ block = false, className, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn("kn-gradient-text", block ? "block" : "inline", className)}
        {...props}
      />
    );
  },
);

/* ------------------------------ LeaderLabel ---------------------------- */

export interface LeaderLabelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Mono number before the label, in the accent colour ("04"). */
  index?: number | string;
  /** Which side the hairline leader runs to. Default `end`. */
  leader?: "start" | "end" | "both" | "none";
  tone?: MonoLabelTone;
}

/**
 * "04 INTERFACE ———": a mono uppercase annotation with a hairline leader
 * running off to one side. Use it to caption a region (a chart, a group
 * of tiles, a diagram) or as a quiet divider with a name.
 */
export const LeaderLabel = React.forwardRef<HTMLDivElement, LeaderLabelProps>(function LeaderLabel(
  { index, leader = "end", tone = "subtle", className, children, ...props },
  ref,
) {
  const line = <span aria-hidden className="h-px min-w-6 flex-1 bg-[var(--kn-border-strong)]" />;
  return (
    <div
      ref={ref}
      className={cn("kn-label-sm flex min-w-0 items-center gap-3", className)}
      {...props}
    >
      {(leader === "start" || leader === "both") && line}
      <span className={cn("flex min-w-0 shrink-0 items-center gap-2", variant(LABEL_TONES, tone, "subtle"))}>
        {index !== undefined && (
          <span aria-hidden className="text-[var(--kn-accent-400)]">
            {formatIndex(index)}
          </span>
        )}
        <span className="truncate">{children}</span>
      </span>
      {(leader === "end" || leader === "both") && line}
    </div>
  );
});

/* ------------------------------ StatusLine ----------------------------- */

const STATUS_DOTS: Record<Tone, string> = {
  neutral: "bg-[var(--kn-text-3)]",
  ok: "bg-[var(--kn-ok)]",
  warn: "bg-[var(--kn-warn)]",
  danger: "bg-[var(--kn-danger)]",
  info: "bg-[var(--kn-info)]",
  accent: "bg-[var(--kn-accent-500)]",
};

export interface StatusLineProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /** Colour of the dot. Status colour means status: default teal `ok`. */
  tone?: Tone;
  /** Soft ring pulse around the dot — "live", "in motion". */
  pulse?: boolean;
}

/**
 * A dot and one muted sentence: "● 4 agents connected · last sync 12s
 * ago". The calm way to state overall condition under a headline; use a
 * StatusBadge when the state belongs to one row.
 */
export const StatusLine = React.forwardRef<HTMLParagraphElement, StatusLineProps>(
  function StatusLine({ tone = "ok", pulse = false, className, children, ...props }, ref) {
    return (
      <p
        ref={ref}
        className={cn("m-0 flex min-w-0 items-center gap-2.5 text-sm text-[var(--kn-text-2)]", className)}
        {...props}
      >
        <span aria-hidden className="relative inline-flex h-1.5 w-1.5 shrink-0">
          {pulse && (
            <span
              className={cn(
                "absolute -inset-1 rounded-[var(--kn-r-pill)] opacity-30 animate-[kn-pulse-ring_1.8s_ease-in-out_infinite]",
                variant(STATUS_DOTS, tone, "ok"),
              )}
            />
          )}
          <span
            className={cn(
              "relative h-1.5 w-1.5 rounded-[var(--kn-r-pill)]",
              variant(STATUS_DOTS, tone, "ok"),
            )}
          />
        </span>
        <span className="min-w-0">{children}</span>
      </p>
    );
  },
);

/* ----------------------------- SectionHeader --------------------------- */

export interface SectionHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** "01". A number is zero-padded to two digits. */
  index?: number | string;
  title: React.ReactNode;
  /** Right-aligned muted sentence: what this section is for. */
  caption?: React.ReactNode;
  /** Right-aligned controls, after the caption. */
  actions?: React.ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** The hairline under the row. Default true. */
  divider?: boolean;
}

/**
 * The ffstudios numbered row: "01  Automate the work ········ Take the
 * repeated, manual work off people." with a hairline underneath. It
 * opens every major section of a page; number them in reading order.
 */
export const SectionHeader = React.forwardRef<HTMLDivElement, SectionHeaderProps>(
  function SectionHeader(
    { index, title, caption, actions, headingLevel = 2, divider = true, className, ...props },
    ref,
  ) {
    const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
    return (
      <div
        ref={ref}
        className={cn(
          "flex min-h-9 min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 pb-2.5",
          divider && "border-b border-[var(--kn-border)]",
          className,
        )}
        {...props}
      >
        <div className="flex min-w-0 items-baseline gap-3">
          {index !== undefined && (
            <span aria-hidden className="kn-label-sm shrink-0 text-[var(--kn-text-3)]">
              {formatIndex(index)}
            </span>
          )}
          <Heading className="kn-title m-0 truncate text-md text-[var(--kn-text)]">{title}</Heading>
        </div>
        {(caption || actions) && (
          <div className="flex min-w-0 items-center gap-3">
            {caption && <span className="truncate text-sm text-[var(--kn-text-3)]">{caption}</span>}
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
          </div>
        )}
      </div>
    );
  },
);

export interface NumberedSectionProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  index?: number | string;
  title: React.ReactNode;
  caption?: React.ReactNode;
  actions?: React.ReactNode;
  headingLevel?: 2 | 3 | 4;
}

/**
 * A `<section>` that opens with a SectionHeader and stacks its children
 * 16px apart. The standard block a page body is built from.
 */
export const NumberedSection = React.forwardRef<HTMLElement, NumberedSectionProps>(
  function NumberedSection(
    { index, title, caption, actions, headingLevel, className, children, ...props },
    ref,
  ) {
    return (
      <section ref={ref} className={cn("flex min-w-0 flex-col gap-4", className)} {...props}>
        <SectionHeader
          index={index}
          title={title}
          caption={caption}
          actions={actions}
          headingLevel={headingLevel}
        />
        {children}
      </section>
    );
  },
);

/* ------------------------------- CheckList ----------------------------- */

export type CheckItemState = "done" | "current" | "todo" | "warning" | "failed";

const CHECK_MARKS: Record<CheckItemState, string> = {
  done: "bg-[var(--kn-accent-soft-strong)] text-[var(--kn-accent-400)] border-transparent",
  current: "bg-transparent text-[var(--kn-accent-400)] border-[var(--kn-accent-500)]",
  todo: "bg-transparent text-transparent border-[var(--kn-border-strong)]",
  warning: "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)] border-transparent",
  failed: "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)] border-transparent",
};

const CHECK_STATE_LABEL: Record<CheckItemState, string> = {
  done: " (done)",
  current: " (in progress)",
  todo: " (to do)",
  warning: " (needs attention)",
  failed: " (failed)",
};

export interface CheckListProps extends React.HTMLAttributes<HTMLUListElement> {
  /**
   * `true` (default): hairlines between rows and at both ends, as on the
   * site. `"between"`: only between rows — use it directly under a
   * SectionHeader or inside a card, which already draw the outer lines.
   * `false`: none.
   */
  divided?: boolean | "between";
}

/** The ffstudios check list: soft purple circles, hairline separators. */
export const CheckList = React.forwardRef<HTMLUListElement, CheckListProps>(function CheckList(
  { divided = true, className, ...props },
  ref,
) {
  return (
    <ul
      ref={ref}
      className={cn(
        "m-0 flex list-none flex-col p-0",
        divided && "[&>li+li]:border-t [&>li+li]:border-[var(--kn-border)]",
        divided === true && "border-y border-[var(--kn-border)]",
        className,
      )}
      {...props}
    />
  );
});

export interface CheckItemProps extends Omit<React.LiHTMLAttributes<HTMLLIElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /**
   * `done` (default) shows the filled circle with a check; `current`
   * an outlined purple circle with a dot; `todo` an empty hairline
   * circle; `warning` a soft yellow circle with a triangle; `failed` a
   * soft red circle with a cross. The state is also announced to
   * assistive tech.
   */
  state?: CheckItemState;
  /** Replaces the check glyph (lucide, 12px). */
  icon?: IconComponent;
  /** Right-aligned slot: a button, a badge, a value. */
  action?: React.ReactNode;
}

export const CheckItem = React.forwardRef<HTMLLIElement, CheckItemProps>(function CheckItem(
  { title, description, state = "done", icon: Icon, action, className, children, ...props },
  ref,
) {
  const Glyph = Icon ?? (state === "failed" ? X : state === "warning" ? AlertTriangle : Check);
  return (
    <li ref={ref} className={cn("flex items-start gap-3.5 py-3.5", className)} {...props}>
      <span
        aria-hidden
        className={cn(
          "mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--kn-r-pill)] border",
          variant(CHECK_MARKS, state, "done"),
        )}
      >
        {state === "current" && !Icon ? (
          <span className="h-1.5 w-1.5 rounded-[var(--kn-r-pill)] bg-[var(--kn-accent-500)]" />
        ) : (
          <Glyph size={12} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "kn-title m-0 text-md",
            state === "todo" ? "text-[var(--kn-text-2)]" : "text-[var(--kn-text)]",
          )}
        >
          {title}
          <span className="sr-only">
            {CHECK_STATE_LABEL[state] ?? CHECK_STATE_LABEL.done}
          </span>
        </p>
        {description && <p className="m-0 mt-0.5 text-sm text-[var(--kn-text-2)]">{description}</p>}
        {children}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </li>
  );
});

/* --------------------------------- Card -------------------------------- */

export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardRadius = "lg" | "xl";

const CARD_PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `lg` 14px (default, panel density), `xl` 18px (feature cards). */
  radius?: CardRadius;
  padding?: CardPadding;
  /** Hover treatment for a card that is itself a link or button target. */
  interactive?: boolean;
  /** Paint on the canvas colour instead of the surface colour. */
  flat?: boolean;
}

/**
 * The plain hairline card: ink-2 with a white-8% line on dark, white
 * with the softest drop on paper. Reach for SectionCard when the block
 * has a title row; Card is for free-form content and feature tiles.
 */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card(
  { radius = "lg", padding = "md", interactive = false, flat = false, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 border border-[var(--kn-border)] shadow-[var(--kn-shadow-sm)]",
        flat ? "bg-[var(--kn-bg)]" : "bg-[var(--kn-surface)]",
        radius === "xl" ? "rounded-[var(--kn-r-xl)]" : "rounded-[var(--kn-r-lg)]",
        variant(CARD_PADDING, padding, "md"),
        interactive &&
          "transition-[border-color,background-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)] hover:border-[var(--kn-border-strong)] hover:bg-[var(--kn-surface-2)]",
        className,
      )}
      {...props}
    />
  );
});

export interface CardInsetProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Paint the blueprint grid inside the panel. */
  grid?: boolean;
  padding?: CardPadding;
}

/**
 * The recessed panel inside a card (the ffstudios card's art well): for
 * a diagram, a code sample, a preview, a big number.
 */
export const CardInset = React.forwardRef<HTMLDivElement, CardInsetProps>(function CardInset(
  { grid = false, padding = "md", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 rounded-[var(--kn-r-md)] border border-[var(--kn-border-subtle)] bg-[var(--kn-bg-inset)]",
        grid && "kn-grid [--kn-grid-size:16px]",
        variant(CARD_PADDING, padding, "md"),
        className,
      )}
      {...props}
    />
  );
});

/* ------------------------------ GridBackdrop --------------------------- */

export interface GridBackdropProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Vertical frame rails bounding the content column. */
  rails?: boolean;
  /** Distance of the rails from each edge, in px. Default 24. */
  railInset?: number;
  /**
   * The purple radial glow that sits behind feature art. Onboarding and
   * login only — never inside the panel. Names the corner it sits in.
   */
  glow?: false | "right" | "left" | "center" | "top";
  /** Fade the grid out towards the bottom edge. */
  fade?: boolean;
  /** Hide the grid itself (rails and glow only). */
  grid?: boolean;
}

const GLOW_POSITION: Record<"right" | "left" | "center" | "top", string> = {
  right: "right-[-10%] top-1/2 h-[90%] w-[60%] -translate-y-1/2",
  left: "left-[-10%] top-1/2 h-[90%] w-[60%] -translate-y-1/2",
  center: "left-1/2 top-1/2 h-[80%] w-[70%] -translate-x-1/2 -translate-y-1/2",
  top: "left-1/2 top-[-30%] h-[80%] w-[80%] -translate-x-1/2",
};

/**
 * The ffstudios canvas for a full-bleed region: the blueprint grid, the
 * frame rails, and (sparingly) the glow. Decorative layers sit behind
 * the children and never take pointer events. The panel's main area
 * already has this from the shell (`.kn-canvas`); use GridBackdrop for
 * standalone screens — setup, login, invite, a hero band.
 */
export const GridBackdrop = React.forwardRef<HTMLDivElement, GridBackdropProps>(
  function GridBackdrop(
    {
      rails = false,
      railInset = 24,
      glow = false,
      fade = false,
      grid = true,
      className,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <div ref={ref} className={cn("relative isolate bg-[var(--kn-bg)]", className)} {...props}>
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          {grid && (
            <div
              className={cn(
                "kn-grid absolute inset-0",
                fade && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
              )}
            />
          )}
          {glow && (
            <div
              className={cn("absolute blur-2xl", GLOW_POSITION[glow])}
              style={{ backgroundImage: "var(--kn-glow)" }}
            />
          )}
          {rails && (
            <>
              <div
                className="absolute inset-y-0 w-px bg-[var(--kn-rail)]"
                style={{ left: railInset }}
              />
              <div
                className="absolute inset-y-0 w-px bg-[var(--kn-rail)]"
                style={{ right: railInset }}
              />
            </>
          )}
        </div>
        {children}
      </div>
    );
  },
);

/* ------------------------------- Crosshair ----------------------------- */

export interface CrosshairProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Arm length end to end, in px. Default 11. */
  size?: number;
}

/**
 * One "+" registration mark. Absolutely position it (via className)
 * where a hairline meets a rail. PageHeader already draws its own pair.
 */
export const Crosshair = React.forwardRef<HTMLSpanElement, CrosshairProps>(function Crosshair(
  { size = 11, className, style, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute block", className)}
      style={{
        width: size,
        height: size,
        background:
          "linear-gradient(var(--kn-line-control), var(--kn-line-control)) center / 1px 100% no-repeat, linear-gradient(var(--kn-line-control), var(--kn-line-control)) center / 100% 1px no-repeat",
        ...style,
      }}
      {...props}
    />
  );
});

/* -------------------------------- PageHero ----------------------------- */

export type PageHeroSize = "md" | "lg";
export type PageHeroAlign = "start" | "center";

export interface PageHeroProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** String becomes an `<Eyebrow>`; a node is rendered as given. */
  eyebrow?: React.ReactNode;
  /** First line of the headline. */
  title: React.ReactNode;
  /** Second line, set in the purple gradient. */
  accent?: React.ReactNode;
  /** One or two muted sentences. */
  lede?: React.ReactNode;
  /** The pills: one primary `<Button size="lg" arrow>`, at most one secondary. */
  actions?: React.ReactNode;
  /** Under the actions, typically a `<StatusLine>`. */
  status?: React.ReactNode;
  /** Right-hand column on wide screens: art, a card, a form. */
  aside?: React.ReactNode;
  /** `lg` is the full hero (setup, login); `md` is an in-panel opener. */
  size?: PageHeroSize;
  align?: PageHeroAlign;
  /** Heading element. Default `h1`. */
  headingLevel?: 1 | 2;
}

/**
 * The ffstudios hero: eyebrow, a big tight headline whose second line
 * is the purple gradient, a muted lede, pill actions, a status line.
 * For the standalone screens and for a module's first-run state. Routine
 * panel pages use PageHeader, which is the same idea at working density.
 */
export const PageHero = React.forwardRef<HTMLElement, PageHeroProps>(function PageHero(
  {
    eyebrow,
    title,
    accent,
    lede,
    actions,
    status,
    aside,
    size = "lg",
    align = "start",
    headingLevel = 1,
    className,
    children,
    ...props
  },
  ref,
) {
  const Heading = `h${headingLevel}` as "h1" | "h2";
  const centered = align === "center";

  return (
    <section
      ref={ref}
      className={cn(
        "grid min-w-0 items-center gap-10",
        aside ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : undefined,
        className,
      )}
      {...props}
    >
      <div className={cn("flex min-w-0 flex-col", centered ? "items-center text-center" : "items-start")}>
        {eyebrow != null && eyebrow !== false && (
          <div className={size === "lg" ? "mb-6" : "mb-4"}>
            {typeof eyebrow === "string" ? <Eyebrow>{eyebrow}</Eyebrow> : eyebrow}
          </div>
        )}
        <Heading
          className={cn(
            "m-0 text-[var(--kn-text)]",
            size === "lg" ? "kn-headline" : "kn-display text-4xl",
          )}
        >
          <span className="block">{title}</span>
          {accent && <GradientText block>{accent}</GradientText>}
        </Heading>
        {lede && (
          <p
            className={cn(
              "kn-lede m-0 max-w-xl",
              size === "lg" ? "mt-6 text-lg" : "mt-3",
            )}
          >
            {lede}
          </p>
        )}
        {actions && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-3",
              size === "lg" ? "mt-8" : "mt-5",
              centered && "justify-center",
            )}
          >
            {actions}
          </div>
        )}
        {status && <div className={size === "lg" ? "mt-6" : "mt-4"}>{status}</div>}
        {children}
      </div>
      {aside && <div className="min-w-0">{aside}</div>}
    </section>
  );
});

/* -------------------------------- PageBody ----------------------------- */

export interface PageBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Vertical rhythm between the page's sections. Default `md` (24px). */
  gap?: "sm" | "md" | "lg";
  /** Cap the measure for form-like pages (settings, account). */
  width?: "full" | "prose";
}

const BODY_GAPS: Record<"sm" | "md" | "lg", string> = {
  sm: "gap-4",
  md: "gap-6",
  lg: "gap-10",
};

/**
 * The page body under a PageHeader: the standard gutter (24px, so the
 * content column sits just inside the canvas rails) and section rhythm.
 */
export const PageBody = React.forwardRef<HTMLDivElement, PageBodyProps>(function PageBody(
  { gap = "md", width = "full", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex min-w-0 flex-1 flex-col px-6 py-6",
        variant(BODY_GAPS, gap, "md"),
        width === "prose" && "mx-auto w-full max-w-4xl",
        className,
      )}
      {...props}
    />
  );
});

/* ------------------------------ SegmentedControl ----------------------- */

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: IconComponent;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  size?: "xs" | "sm";
}

/**
 * A pill of mono uppercase segments — a radio group for switching a
 * view mode or unit in place (not navigation: that is Tabs / ViewTabs).
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  label,
  size = "sm",
  className,
  ...props
}: SegmentedControlProps<T>) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const enabled = options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((option) => option.value === value);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : event.key === "ArrowRight" || event.key === "ArrowDown"
            ? (current + 1) % enabled.length
            : (current - 1 + enabled.length) % enabled.length;
    const target = enabled[next];
    if (!target) return;
    event.preventDefault();
    onValueChange(target.value);
    const node = event.currentTarget.querySelector<HTMLElement>(
      `[data-value="${CSS.escape(target.value)}"]`,
    );
    node?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded-[var(--kn-r-pill)] border border-[var(--kn-border-strong)] p-0.5",
        className,
      )}
      {...props}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            disabled={option.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "kn-label-sm inline-flex shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-[var(--kn-r-pill)] tracking-[0.08em]",
              size === "xs" ? "h-5 px-2" : "h-6 px-2.5",
              "transition-[background-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "bg-[var(--kn-accent-soft-strong)] text-[var(--kn-text)]"
                : "text-[var(--kn-text-3)] hover:bg-[var(--kn-neutral-soft)] hover:text-[var(--kn-text)]",
            )}
          >
            {Icon && <Icon size={12} className="shrink-0" aria-hidden />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
