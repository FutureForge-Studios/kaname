"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
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

/** Section label for a path, e.g. "/websites/dns" -> "Websites". */
function sectionFor(href: string): { section: string; leaf: string } | null {
  for (const leaf of NAV_LEAVES) {
    if (href === leaf.href || href.startsWith(`${leaf.href}/`)) {
      return { section: leaf.section, leaf: leaf.label };
    }
  }
  return null;
}

/** The section's first readable leaf, so the section crumb can link. */
function sectionHref(section: string): string | undefined {
  const match = NAVIGATION.find((entry) => entry.label === section);
  if (!match) return undefined;
  return match.href ?? match.children?.[0]?.href;
}

export function crumbsFor(pathname: string): Crumb[] {
  if (pathname === "/") return [{ label: "Command Center" }];

  const match = sectionFor(pathname);
  const crumbs: Crumb[] = [];

  if (match) {
    const leafEntry = NAV_LEAVES.find(
      (leaf) => pathname === leaf.href || pathname.startsWith(`${leaf.href}/`),
    );
    if (match.section !== match.leaf) {
      crumbs.push({ label: match.section, href: sectionHref(match.section) });
    }
    crumbs.push({ label: match.leaf, href: leafEntry?.href });

    const rest = leafEntry ? pathname.slice(leafEntry.href.length) : "";
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
      className={cn("flex min-w-0 items-center", className)}
      {...props}
    >
      <ol className="flex min-w-0 items-center gap-1">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 && (
                <ChevronRight size={12} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
              )}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="truncate rounded-[var(--kn-r-xs)] text-[var(--kn-text-2)] transition-colors duration-[var(--kn-dur-fast)] hover:text-[var(--kn-text)]"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn(
                    "truncate",
                    last ? "text-[var(--kn-text)]" : "text-[var(--kn-text-2)]",
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
