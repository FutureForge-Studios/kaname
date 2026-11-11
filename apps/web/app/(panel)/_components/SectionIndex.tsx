"use client";

import * as React from "react";
import { MonoLabel, cn, formatIndex } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * Long-form pages (Settings, Account): numbered sections down the left,
 * and on wide screens a sticky "on this page" index down the right that
 * follows the reader.
 *
 * The index is plain in-page links — the sections already carry ids
 * (#panel, #two-factor, …) that other pages deep-link to — so it works
 * without script; the observer only moves the highlight.
 * ------------------------------------------------------------------ */

export interface SectionIndexEntry {
  id: string;
  title: string;
}

export function SectionIndex({
  entries,
  label = "On this page",
  className,
}: {
  entries: SectionIndexEntry[];
  label?: string;
  className?: string;
}) {
  const [active, setActive] = React.useState<string | null>(entries[0]?.id ?? null);
  const key = entries.map((entry) => entry.id).join("|");

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) visible.set(record.target.id, record.boundingClientRect.top);
          else visible.delete(record.target.id);
        }
        // The highest section still on screen is the one being read.
        const first = entries.find((entry) => visible.has(entry.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    for (const entry of entries) {
      const node = document.getElementById(entry.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids
  }, [key]);

  return (
    <nav aria-label={label} className={cn("flex flex-col gap-3", className)}>
      <MonoLabel as="p" size="xs" tone="subtle">
        {label}
      </MonoLabel>
      <ol className="flex flex-col border-l border-[var(--kn-border)]">
        {entries.map((entry, position) => {
          const current = entry.id === active;
          return (
            <li key={entry.id}>
              <a
                href={`#${entry.id}`}
                aria-current={current ? "location" : undefined}
                onClick={() => setActive(entry.id)}
                className={cn(
                  "-ml-px flex items-baseline gap-2.5 border-l py-1.5 pl-3 text-sm outline-none",
                  "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
                  current
                    ? "border-[var(--kn-accent-500)] text-[var(--kn-text)]"
                    : "border-transparent text-[var(--kn-text-3)] hover:text-[var(--kn-text-2)]",
                )}
              >
                <span aria-hidden className="kn-label-sm shrink-0">
                  {formatIndex(position + 1)}
                </span>
                <span className="min-w-0 truncate">{entry.title}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The two-column shell: sections in the main column, the index in a
 * sticky rail from `xl` up. Below that the index is simply not drawn —
 * the numbered headers already say where you are.
 */
export function IndexedLayout({
  entries,
  children,
  className,
}: {
  entries: SectionIndexEntry[];
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_184px]",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-10">{children}</div>
      <aside className="sticky top-6 hidden self-start xl:block">
        <SectionIndex entries={entries} />
      </aside>
    </div>
  );
}
