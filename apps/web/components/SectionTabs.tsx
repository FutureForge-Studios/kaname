"use client";

import { usePathname } from "next/navigation";
import { useNavigation } from "@/lib/modes";
import { ViewTabs } from "./ViewTabs";

/* ------------------------------------------------------------------ *
 * SectionTabs — the pages of the current sidebar section, as one tab
 * row under the top bar.
 *
 * Only on a section's list pages (the path is one of its leaves) and
 * only when this person can see two or more of them. Detail pages keep
 * their breadcrumbs and their own tabs instead.
 * ------------------------------------------------------------------ */

export function SectionTabs() {
  const pathname = usePathname() ?? "/";
  const sections = useNavigation();
  const current = sections.find(
    ({ leaves }) => leaves.length >= 2 && leaves.some((leaf) => leaf.href === pathname),
  );
  if (!current) return null;

  return (
    <div className="shrink-0 border-b border-[var(--kn-border)] px-3 lg:px-6">
      <ViewTabs
        className="-mb-px"
        label={`${current.section.label} pages`}
        current={pathname}
        tabs={current.leaves.map((leaf) => ({ id: leaf.href, label: leaf.label, href: leaf.href }))}
      />
    </div>
  );
}
