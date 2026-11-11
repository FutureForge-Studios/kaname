"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Eyebrow, PageHeader, Skeleton, Tab, TabList, cn } from "@kaname/ui";
import type { IconComponent } from "@/lib/icons";
import { PageError } from "@/components/PageError";

/* ------------------------------------------------------------------ *
 * Detail-page scaffolding.
 *
 * Four detail pages in this module and they open the same way: the tab
 * lives in the query string so a link lands on the tab it was copied
 * from, the loading state has the shape of the loaded page, and the
 * failure keeps the machine code and the remediation the control plane
 * sent rather than replacing them with an apology.
 * ------------------------------------------------------------------ */

export interface DetailTabSpec {
  value: string;
  label: string;
  icon?: IconComponent;
  /** Right-aligned count — domains on a site, records in a zone. */
  badge?: React.ReactNode;
}

/**
 * Tab selection in the URL, validated against the known set so a stale
 * or hand-edited `?tab=` falls back rather than rendering nothing.
 */
export function useDetailTab(
  tabs: readonly DetailTabSpec[],
  fallback: string,
): [string, (next: string) => void] {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const paramString = searchParams.toString();

  const requested = searchParams.get("tab");
  const value = tabs.some((tab) => tab.value === requested) ? (requested as string) : fallback;

  const setValue = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(paramString);
      if (next === fallback) params.delete("tab");
      else params.set("tab", next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [fallback, paramString, pathname, router],
  );

  return [value, setValue];
}

export function DetailTabList({ tabs }: { tabs: readonly DetailTabSpec[] }) {
  return (
    <TabList>
      {tabs.map((tab) => (
        <Tab key={tab.value} value={tab.value} icon={tab.icon} badge={tab.badge}>
          {tab.label}
        </Tab>
      ))}
    </TabList>
  );
}

/** Body column shared by every detail page, so gutters never drift. */
export function DetailBody({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={className ?? "flex min-w-0 flex-col gap-4 px-6 py-6"}>{children}</div>;
}

/* ------------------------------------------------------------------ *
 * The detail header's editorial pieces.
 *
 * ResourceHeader owns the name, both host status axes and the actions;
 * these fill its two open slots the same way on every page in the
 * module: an eyebrow naming what kind of thing this is, and under the
 * name the greppable identity in mono with one StatusLine sentence that
 * says what the thing is doing right now.
 * ------------------------------------------------------------------ */

/** "WEBSITES · SITE ▪" — sits in ResourceHeader's breadcrumb slot. */
export function DetailEyebrow({ kind }: { kind: string }) {
  return <Eyebrow>{`Websites · ${kind}`}</Eyebrow>;
}

/**
 * Identity line plus the condition sentence. ResourceHeader renders the
 * identity slot in mono, so the StatusLine resets to the sans face.
 */
export function DetailIdentity({
  children,
  status,
}: {
  children: React.ReactNode;
  status?: React.ReactNode;
}) {
  return (
    <>
      <span className="block truncate">{children}</span>
      {status && (
        <div className="mt-2.5 whitespace-normal [font-family:var(--kn-font-sans)] [font-variant-ligatures:normal]">
          {status}
        </div>
      )}
    </>
  );
}

/**
 * A navigation that sits where a ghost pill would — "Open certificate",
 * "All deployments". It stays an anchor so it can be opened in a new tab.
 */
export function PillLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group/pill inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-[var(--kn-r-pill)] border border-[var(--kn-border-strong)] px-2.5 text-xs font-medium text-[var(--kn-text-2)]",
        "transition-[background-color,border-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
        "hover:border-[var(--kn-line-control)] hover:bg-[var(--kn-neutral-soft)] hover:text-[var(--kn-text)]",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
        className,
      )}
    >
      {children}
      <ArrowRight
        size={12}
        aria-hidden
        className="shrink-0 transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)] group-hover/pill:translate-x-0.5 motion-reduce:transition-none"
      />
    </Link>
  );
}

/** Header band, identity line, tab strip, rail and body — in outline. */
export function DetailLoading({ rail = true }: { rail?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy>
      <div className="border-b border-[var(--kn-border)] px-6 pb-0 pt-6">
        <Skeleton className="h-6 w-36 rounded-[var(--kn-r-sm)]" label="Loading" />
        <Skeleton className="mt-3 h-7 w-72" />
        <Skeleton className="mt-2 h-3 w-56" />
        <Skeleton className="mt-3 h-3 w-80" />
        <div className="mt-4 flex gap-4 pb-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-4 w-20" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_288px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-[var(--kn-r-lg)]" />
          <Skeleton className="h-32 rounded-[var(--kn-r-lg)]" />
        </div>
        {rail && <Skeleton className="h-64 rounded-[var(--kn-r-lg)]" />}
      </div>
    </div>
  );
}

export interface DetailFailedProps {
  error: unknown;
  onRetry: () => void;
  /** Prefixed to the message, e.g. "Certificate". */
  context: string;
  title: string;
}

export function DetailFailed({ error, onRetry, context, title }: DetailFailedProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader eyebrow="Websites" title={title} />
      <div className="px-6 py-6">
        <PageError error={error} onRetry={onRetry} context={context} />
      </div>
    </div>
  );
}
