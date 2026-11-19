"use client";

import * as React from "react";
import type { AgentConnection, HealthState } from "@kaname/contract";
import { cn, variant } from "../lib/cn.js";
import { AgentConnectionIndicator, HealthBadge } from "./Status.js";
import type { DateInput } from "./Primitives.js";

/* ------------------------------------------------------------------ *
 * Page chrome: PageHeader, SectionCard, ResourceHeader, DetailLayout.
 *
 * PageHeader: breadcrumb, a 24px title, a mono identity line, an
 * optional lede, actions on the right, and a hairline underneath.
 *
 * SectionCard is the default container: a flat 8px hairline surface with
 * a plain title row. Detail pages pair a main column with a sticky
 * metadata rail so identity and status stay on screen while the body
 * scrolls.
 * ------------------------------------------------------------------ */

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

/* ------------------------------ PageHeader ------------------------------ */

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title: React.ReactNode;
  /** Technical second line: a hostname, a path, a connection string. */
  subtitle?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  /** Rendered flush with the bottom border so the active tab meets it. */
  tabs?: React.ReactNode;
  /** Accepted for old call sites; not rendered (KD-044: no eyebrow chips on routine pages). */
  eyebrow?: React.ReactNode;
  /** One muted sentence under the title saying what this page is for. */
  lede?: React.ReactNode;
  /** Status line under the title block, typically a `<StatusLine>`. */
  status?: React.ReactNode;
}

export const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  { title, subtitle, breadcrumb, actions, tabs, eyebrow: _eyebrow, lede, status, className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      className={cn(
        "shrink-0 border-b border-[var(--kn-border)] px-6 pt-6",
        tabs ? "pb-0" : "pb-5",
        className,
      )}
      {...props}
    >
      {breadcrumb && (
        <div className="kn-label-sm mb-2 flex min-w-0 items-center text-[var(--kn-text-3)]">
          {breadcrumb}
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 max-w-full">
          <h1 className="kn-display truncate text-[var(--kn-text)]">{title}</h1>
          {subtitle && (
            <div className="kn-mono mt-1.5 truncate text-[var(--kn-text-3)]">{subtitle}</div>
          )}
          {lede && <p className="kn-lede mt-2 max-w-2xl">{lede}</p>}
          {status && <div className="mt-3">{status}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div className="-mb-px mt-4">{tabs}</div>}
    </header>
  );
});

/* ------------------------------ SectionCard ----------------------------- */

export interface SectionCardProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: IconComponent;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  /** Set false when the body is a table that must reach the card edge. */
  padded?: boolean;
  /** Match the surrounding document outline. */
  headingLevel?: 2 | 3;
  /** Accepted for old call sites; ignored (KD-044: no numbered sections). */
  index?: number | string;
  /** Right-aligned muted caption in the header row, before the actions. */
  caption?: React.ReactNode;
}

export const SectionCard = React.forwardRef<HTMLElement, SectionCardProps>(function SectionCard(
  {
    title,
    description,
    icon: Icon,
    actions,
    footer,
    padded = true,
    headingLevel = 2,
    index: _index,
    caption,
    className,
    children,
    ...props
  },
  ref,
) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section
      ref={ref}
      className={cn(
        "overflow-hidden rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] shadow-[var(--kn-shadow-sm)]",
        className,
      )}
      {...props}
    >
      {(title || actions) && (
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-[var(--kn-border)] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && <Icon size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />}
            <div className="min-w-0">
              {title && (
                <Heading className="kn-title truncate text-md text-[var(--kn-text)]">{title}</Heading>
              )}
              {description && (
                <p className="mt-0.5 text-sm text-[var(--kn-text-2)]">{description}</p>
              )}
            </div>
          </div>
          {(caption || actions) && (
            <div className="flex shrink-0 items-center gap-3">
              {caption && (
                <span className="hidden text-sm text-[var(--kn-text-3)] sm:inline">{caption}</span>
              )}
              {actions && <div className="flex items-center gap-1.5">{actions}</div>}
            </div>
          )}
        </div>
      )}
      <div className={cn(padded && "p-4")}>{children}</div>
      {footer && (
        <div className="border-t border-[var(--kn-border)] px-4 py-2 text-sm text-[var(--kn-text-2)]">
          {footer}
        </div>
      )}
    </section>
  );
});

/* ----------------------------- ResourceHeader --------------------------- */

export interface ResourceHeaderProps extends React.HTMLAttributes<HTMLElement> {
  name: React.ReactNode;
  /** Mono identity line: hostname, address, OS, engine version. */
  identity?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  /** "Can we reach the box." Rendered alongside, never merged with, health. */
  connection?: AgentConnection;
  lastSeenAt?: DateInput | null;
  /** "Is the box OK." */
  health?: HealthState;
  healthReasons?: string[];
  /** Resource-specific badges: runtime, engine, certificate status. */
  badges?: React.ReactNode;
  /** One sentence under the identity line, typically a `<StatusLine>`. */
  status?: React.ReactNode;
  actions?: React.ReactNode;
  /** Overflow menu trigger for the destructive and rare actions. */
  menu?: React.ReactNode;
  tabs?: React.ReactNode;
}

export const ResourceHeader = React.forwardRef<HTMLElement, ResourceHeaderProps>(
  function ResourceHeader(
    {
      name,
      identity,
      breadcrumb,
      connection,
      lastSeenAt,
      health,
      healthReasons,
      badges,
      status,
      actions,
      menu,
      tabs,
      className,
      ...props
    },
    ref,
  ) {
    return (
      <header
        ref={ref}
        className={cn(
          "shrink-0 border-b border-[var(--kn-border)] px-6 pt-6",
          tabs ? "pb-0" : "pb-5",
          className,
        )}
        {...props}
      >
        {breadcrumb && (
          <div className="kn-label-sm mb-2 flex min-w-0 items-center text-[var(--kn-text-3)]">
            {breadcrumb}
          </div>
        )}

        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 max-w-full flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="kn-display truncate text-[var(--kn-text)]">{name}</h1>
              {connection && (
                <AgentConnectionIndicator connection={connection} since={lastSeenAt} />
              )}
              {health && <HealthBadge health={health} reasons={healthReasons} />}
              {badges}
            </div>
            {identity && <div className="kn-mono truncate text-[var(--kn-text-3)]">{identity}</div>}
            {status && <div className="mt-1.5 min-w-0">{status}</div>}
          </div>

          {(actions || menu) && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
              {menu}
            </div>
          )}
        </div>

        {tabs && <div className="-mb-px mt-4">{tabs}</div>}
      </header>
    );
  },
);

/* ------------------------------ DetailLayout ---------------------------- */

export type RailWidth = "sm" | "md";

const RAIL_WIDTHS: Record<RailWidth, string> = {
  sm: "lg:grid-cols-[minmax(0,1fr)_256px]",
  md: "lg:grid-cols-[minmax(0,1fr)_288px]",
};

export interface DetailLayoutProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Metadata column. Sticks below the topbar while the main column scrolls. */
  rail?: React.ReactNode;
  railWidth?: RailWidth;
}

export const DetailLayout = React.forwardRef<HTMLDivElement, DetailLayoutProps>(
  function DetailLayout({ rail, railWidth = "md", className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "grid grid-cols-1 items-start gap-4",
          rail && variant(RAIL_WIDTHS, railWidth, "md"),
          className,
        )}
        {...props}
      >
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
        {rail && <aside className="flex flex-col gap-4 lg:sticky lg:top-4">{rail}</aside>}
      </div>
    );
  },
);
