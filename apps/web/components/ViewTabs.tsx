"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@kaname/ui";
import type { IconComponent } from "@/lib/icons";

/* ------------------------------------------------------------------ *
 * ViewTabs — the switch between the several lists a module page owns.
 *
 * Links, not a tablist: each view is its own URL, so the browser's own
 * back button, middle-click and copy-link all keep working, and there
 * is no `aria-controls` pointing at a panel that does not exist. The
 * treatment matches `Tab` from the kit because these read as tabs even
 * though they navigate.
 *
 * Following a tab drops the list's search, sort and page, because those
 * mean different things in each view and carrying them across produces
 * a table sorted by a column it does not have.
 * ------------------------------------------------------------------ */

export interface ViewTabItem {
  id: string;
  label: string;
  href: string;
  icon?: IconComponent;
  /** Right-aligned count. */
  badge?: React.ReactNode;
}

export interface ViewTabsProps {
  tabs: readonly ViewTabItem[];
  current: string;
  /** Names the group, e.g. "Database views". */
  label: string;
  className?: string;
}

export function ViewTabs({ tabs, current, label, className }: ViewTabsProps) {
  return (
    <nav aria-label={label} className={cn("flex items-center overflow-x-auto", className)}>
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const active = tab.id === current;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 font-medium",
              "outline-none transition-[color,border-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
              active
                ? "border-[var(--kn-accent-500)] text-[var(--kn-text)]"
                : "border-transparent text-[var(--kn-text-2)] hover:text-[var(--kn-text)]",
            )}
          >
            {Icon && <Icon size={14} className="shrink-0" aria-hidden />}
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null && (
              <span className="kn-num text-xs text-[var(--kn-text-3)]">{tab.badge}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
