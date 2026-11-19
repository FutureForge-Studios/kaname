"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAVIGATION, NAV_LEAVES } from "@kaname/contract";
import { cn } from "@kaname/ui";
import { humanize } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Breadcrumbs.
 *
 * Derived from NAVIGATION rather than from a per-page prop, so the
 * trail cannot drift from the sidebar. The last segment of a detail
 * route is usually an id, which reads as noise — pages hand the real
 * name in through `trailing`.
 * ------------------------------------------------------------------ */

export interface Crumb {
  label: string;
  href?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The deepest leaf a path sits under, so "/apps/installed" is Installed, not Catalog. */
function leafFor(href: string) {
  let best: (typeof NAV_LEAVES)[number] | undefined;
  for (const leaf of NAV_LEAVES) {
    const under = href === leaf.href || (leaf.href !== "/" && href.startsWith(`${leaf.href}/`));
    if (under && leaf.href.length > (best?.href.length ?? -1)) best = leaf;
  }
  return best;
}

/** The section's first readable leaf, so the section crumb can link. */
function sectionHref(section: string): string | undefined {
  const match = NAVIGATION.find((entry) => entry.label === section);
  if (!match) return undefined;
  return match.href ?? match.children?.[0]?.href;
}

export function crumbsFor(pathname: string): Crumb[] {
  if (pathname === "/") return [{ label: "Projects" }];
  // A project page lives under /websites/sites but its list is the Projects home.
  if (pathname.startsWith("/websites/sites/")) return [{ label: "Projects", href: "/" }, { label: "Detail" }];

  const leafEntry = leafFor(pathname);
  const crumbs: Crumb[] = [];

  if (leafEntry) {
    if (leafEntry.section !== leafEntry.label) {
      crumbs.push({ label: leafEntry.section, href: sectionHref(leafEntry.section) });
    }
    crumbs.push({ label: leafEntry.label, href: leafEntry.href });

    const rest = pathname.slice(leafEntry.href.length);
    for (const segment of rest.split("/").filter(Boolean)) {
      crumbs.push({ label: UUID.test(segment) ? "Detail" : humanize(decodeURIComponent(segment)) });
    }
    return crumbs;
  }

  for (const segment of pathname.split("/").filter(Boolean)) {
    crumbs.push({ label: UUID.test(segment) ? "Detail" : humanize(decodeURIComponent(segment)) });
  }
  return crumbs;
}

export interface BreadcrumbsProps extends React.HTMLAttributes<HTMLElement> {
  /** Replaces the trailing crumb — the resource's real name. */
  trailing?: string;
}

export function Breadcrumbs({ trailing, className, ...props }: BreadcrumbsProps) {
  const pathname = usePathname();
  const crumbs = React.useMemo(() => {
    const derived = crumbsFor(pathname ?? "/");
    if (!trailing || derived.length === 0) return derived;
    return [...derived.slice(0, -1), { label: trailing }];
  }, [pathname, trailing]);

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("kn-label-sm flex min-w-0 items-center", className)}
      {...props}
    >
      <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-2">
              {index > 0 && (
                <span className="shrink-0 text-[var(--kn-text-3)] opacity-60" aria-hidden>
                  /
                </span>
              )}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="truncate rounded-[var(--kn-r-xs)] text-[var(--kn-text-3)] transition-colors duration-[var(--kn-dur-fast)] hover:text-[var(--kn-text)]"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "truncate",
                    last ? "text-[var(--kn-text)]" : "text-[var(--kn-text-3)]",
                  )}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
