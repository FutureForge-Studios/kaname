"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader, Skeleton, Tab, TabList } from "@kaname/ui";
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
  return <div className={className ?? "flex min-w-0 flex-col gap-4 px-6 py-4"}>{children}</div>;
}

/** Header band, identity line, tab strip, rail and body — in outline. */
export function DetailLoading({ rail = true }: { rail?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy>
      <div className="border-b border-[var(--kn-border)] px-6 pb-0 pt-4">
        <Skeleton className="h-3 w-40" label="Loading" />
        <Skeleton className="mt-2 h-6 w-72" />
        <Skeleton className="mt-2 h-3 w-56" />
        <div className="mt-3 flex gap-4 pb-2">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-4 w-20" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 px-6 py-4 lg:grid-cols-[minmax(0,1fr)_288px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-[var(--kn-r-md)]" />
          <Skeleton className="h-32 rounded-[var(--kn-r-md)]" />
        </div>
        {rail && <Skeleton className="h-64 rounded-[var(--kn-r-md)]" />}
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
      <PageHeader title={title} />
      <div className="px-6 py-4">
        <PageError error={error} onRetry={onRetry} context={context} />
      </div>
    </div>
  );
}
