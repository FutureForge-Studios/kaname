"use client";

import * as React from "react";
import type { AgentConnection, HealthState } from "@kaname/contract";
import { cn, variant } from "../lib/cn.js";
import { AgentConnectionIndicator, HealthBadge } from "./Status.js";
import type { DateInput } from "./Primitives.js";

/* ------------------------------------------------------------------ *
 * Page chrome: PageHeader, SectionCard, ResourceHeader, DetailLayout.
 *
 * SectionCard is the default container for everything — a bordered
 * surface with a header row, not a floating card with a shadow. Detail
 * pages pair a main column with a sticky metadata rail so identity and
 * status stay on screen while the body scrolls.
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
}

export const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  { title, subtitle, breadcrumb, actions, tabs, className, ...props },
  ref,
) {
  return (
    <header
      ref={ref}
      className={cn(
        "border-b border-[var(--kn-border)] bg-[var(--kn-bg)] px-6 pt-4",
        tabs ? "pb-0" : "pb-4",
        className,
      )}
      {...props}
    >
      {breadcrumb && (
        <div className="mb-2 flex items-center text-sm text-[var(--kn-text-2)]">{breadcrumb}</div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-medium tracking-tight text-[var(--kn-text)]">
            {title}
          </h1>
          {subtitle && (
            <div className="kn-mono mt-0.5 truncate text-[var(--kn-text-2)]">{subtitle}</div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div className="-mb-px mt-3">{tabs}</div>}
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
        "overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]",
        className,
      )}
      {...props}
    >
      {(title || actions) && (
        <div className="flex min-h-9 items-center justify-between gap-3 border-b border-[var(--kn-border)] px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {Icon && <Icon size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />}
            <div className="min-w-0">
              {title && (
                <Heading className="truncate font-medium text-[var(--kn-text)]">{title}</Heading>
              )}
              {description && (
                <p className="mt-0.5 text-sm text-[var(--kn-text-2)]">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
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
          "border-b border-[var(--kn-border)] bg-[var(--kn-bg)] px-6 pt-4",
          tabs ? "pb-0" : "pb-4",
          className,
        )}
        {...props}
      >
        {breadcrumb && (
          <div className="mb-2 flex items-center text-sm text-[var(--kn-text-2)]">{breadcrumb}</div>
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="truncate text-xl font-medium tracking-tight text-[var(--kn-text)]">
                {name}
              </h1>
              {connection && (
                <AgentConnectionIndicator connection={connection} since={lastSeenAt} />
              )}
              {health && <HealthBadge health={health} reasons={healthReasons} />}
              {badges}
            </div>
            {identity && <div className="kn-mono truncate text-[var(--kn-text-2)]">{identity}</div>}
          </div>

          {(actions || menu) && (
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              {menu}
            </div>
          )}
        </div>

        {tabs && <div className="-mb-px mt-3">{tabs}</div>}
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
