"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Ellipsis, LifeBuoy, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ResellerBranding } from "@kaname/contract";
import { Dot, IconButton, MonoLabel, Tooltip, cn } from "@kaname/ui";
import { iconFor } from "@/lib/icons";
import { AUDIENCE_LABELS, useModes, useNavigation, type VisibleSection } from "@/lib/modes";
import { Wordmark } from "./Logo";
import { useNavIndicators } from "./UpdateNotice";

/* ------------------------------------------------------------------ *
 * Sidebar.
 *
 * NAVIGATION is the product's information architecture, so this
 * component renders it rather than restating it. Permission filtering
 * happens per leaf and then per section: a role with no email
 * permissions does not see a greyed-out Email group, it sees no Email
 * group — the sidebar describes the panel this account actually has.
 *
 * Flat: one row per section, linking to its first page this person may
 * see; the section's other pages are the tab row on the page
 * (SectionTabs). Occasional tools sit under "More", closed by default.
 *
 * What is listed also depends on the view mode and audience (KD-039):
 * lib/modes.tsx decides, so the palette and the sidebar agree. A
 * reseller's clients see the reseller's name and mark up here, and its
 * support contact at the foot.
 * ------------------------------------------------------------------ */

export type SidebarVariant = "fixed" | "drawer";

export interface SidebarProps {
  variant?: SidebarVariant;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Closes the mobile drawer when a destination is chosen. */
  onNavigate?: () => void;
}

const MORE_KEY = "kaname.sidebar.more";

/** A path is active for the deepest matching leaf, so detail routes light up their list. */
function isActive(pathname: string, href: string): boolean {
  // A project page lives under /websites/sites but belongs to the Projects home.
  if (href === "/") return pathname === "/" || pathname.startsWith("/websites/sites/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Where a section's sidebar row goes: its first page this person may see. */
function sectionHref({ section, leaves }: VisibleSection): string {
  return leaves[0]?.href ?? section.href ?? "/";
}

function sectionActive(pathname: string, entry: VisibleSection): boolean {
  const hrefs =
    entry.leaves.length > 0 ? entry.leaves.map((leaf) => leaf.href) : [sectionHref(entry)];
  return hrefs.some((href) => isActive(pathname, href));
}

function readMore(): boolean {
  try {
    return window.localStorage.getItem(MORE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Sidebar({
  variant = "fixed",
  collapsed = false,
  onCollapsedChange,
  onNavigate,
}: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const { branding, audience, preview } = useModes();
  const drawer = variant === "drawer";
  const narrow = collapsed && !drawer;
  const sections = useNavigation();
  const indicators = useNavIndicators();
  const primary = sections.filter((entry) => !entry.section.secondary);
  const secondary = sections.filter((entry) => entry.section.secondary);
  const secondaryActive = secondary.some((entry) => sectionActive(pathname, entry));

  /* Read after mount, like the collapse preference, so the server render matches. */
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => setMoreOpen(readMore()), []);
  // Arriving on one of its pages opens More, so the active row is not hidden; it can still be folded.
  React.useEffect(() => {
    if (secondaryActive) setMoreOpen(true);
  }, [secondaryActive]);
  const showMore = moreOpen;
  const toggleMore = () => {
    const next = !showMore;
    setMoreOpen(next);
    try {
      window.localStorage.setItem(MORE_KEY, next ? "1" : "0");
    } catch {
      /* A convenience, not state the app depends on. */
    }
  };

  return (
    <div
      className={cn(
        "kn-material flex h-full min-h-0 flex-col",
        !drawer && "border-r border-[var(--kn-border)]",
      )}
    >
      {!drawer && (
        <div
          className={cn(
            "flex h-[var(--kn-topbar-h)] shrink-0 items-center border-b border-[var(--kn-border)]",
            narrow ? "justify-center px-2" : "justify-between pl-4 pr-2",
          )}
        >
          <Link
            href="/"
            aria-label={
              branding
                ? `${branding.display_name} — Home`
                : "Kaname by FutureForge Studios — Projects"
            }
            className="min-w-0 rounded-[var(--kn-r-sm)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
          >
            {branding ? (
              <BrandMark branding={branding} markOnly={narrow} />
            ) : (
              <Wordmark markOnly={narrow} byline />
            )}
          </Link>
          {!narrow && onCollapsedChange && (
            <IconButton
              icon={PanelLeftClose}
              label="Collapse sidebar"
              size="sm"
              onClick={() => onCollapsedChange(true)}
            />
          )}
        </div>
      )}

      <nav
        aria-label="Primary"
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-4 pt-3"
      >
        {primary.map((entry) => (
          <SidebarLink
            key={entry.section.label}
            entry={entry}
            pathname={pathname}
            indicator={entry.leaves.some((leaf) => indicators.has(leaf.href))}
            narrow={narrow}
            onNavigate={onNavigate}
          />
        ))}
        {secondary.length > 0 && (
          <>
            <MoreToggle open={showMore} narrow={narrow} onToggle={toggleMore} />
            {showMore &&
              secondary.map((entry) => (
                <SidebarLink
                  key={entry.section.label}
                  entry={entry}
                  pathname={pathname}
                  indicator={entry.leaves.some((leaf) => indicators.has(leaf.href))}
                  narrow={narrow}
                  onNavigate={onNavigate}
                />
              ))}
          </>
        )}
      </nav>

      {!narrow && (branding?.support_email || branding?.support_url) && (
        <SupportFooter branding={branding} />
      )}

      {!narrow && preview && (
        <div className="shrink-0 border-t border-[var(--kn-border)] px-4 py-2.5">
          <MonoLabel size="xs" tone="accent">
            Preview · {AUDIENCE_LABELS[audience]} navigation
          </MonoLabel>
        </div>
      )}

      {!drawer && narrow && onCollapsedChange && (
        <div className="flex h-9 shrink-0 items-center justify-center border-t border-[var(--kn-border)]">
          <IconButton
            icon={PanelLeftOpen}
            label="Expand sidebar"
            size="sm"
            onClick={() => onCollapsedChange(false)}
          />
        </div>
      )}
    </div>
  );
}

function MoreToggle({
  open,
  narrow,
  onToggle,
}: {
  open: boolean;
  narrow: boolean;
  onToggle: () => void;
}) {
  if (narrow) {
    return (
      <div className="mt-2 flex justify-center border-t border-[var(--kn-border)] pt-2">
        <IconButton icon={Ellipsis} label="More" aria-expanded={open} onClick={onToggle} />
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "mt-3 flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--kn-r-md)] px-2 text-[var(--kn-text-3)] outline-none",
        "hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
      )}
    >
      <ChevronRight
        size={14}
        aria-hidden
        className={cn(
          "shrink-0 transition-transform duration-[var(--kn-dur-fast)] motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
      More
    </button>
  );
}

interface SidebarLinkProps {
  entry: VisibleSection;
  pathname: string;
  /** A small accent dot: something new behind this link. */
  indicator?: boolean;
  narrow: boolean;
  onNavigate?: () => void;
}

function SidebarLink({ entry, pathname, indicator = false, narrow, onNavigate }: SidebarLinkProps) {
  const { label, icon } = entry.section;
  const Icon = iconFor(icon);
  const active = sectionActive(pathname, entry);

  const link = (
    <Link
      href={sectionHref(entry)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav relative flex h-8 shrink-0 items-center rounded-[var(--kn-r-md)] outline-none",
        "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
        narrow ? "w-full justify-center px-0" : "gap-2.5 px-2",
        active
          ? "bg-[var(--kn-neutral-soft)] text-[var(--kn-text)]"
          : "text-[var(--kn-text-2)] hover:bg-[var(--kn-neutral-soft)] hover:text-[var(--kn-text)]",
      )}
    >
      <Icon
        size={16}
        className={cn(
          "shrink-0",
          active
            ? "text-[var(--kn-accent-400)]"
            : "text-[var(--kn-text-3)] group-hover/nav:text-current",
        )}
        aria-hidden
      />
      {!narrow && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {indicator && (
        <>
          <Dot
            tone="accent"
            className={cn(narrow && "absolute right-1.5 top-1")}
            data-testid="nav-indicator"
          />
          <span className="sr-only"> — update available</span>
        </>
      )}
      {narrow && <span className="sr-only">{label}</span>}
    </Link>
  );

  if (!narrow) return link;

  return (
    <Tooltip content={label} placement="right">
      {link}
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ *
 * Reseller branding
 * ------------------------------------------------------------------ */

function initialsOf(branding: ResellerBranding): string {
  if (branding.logo_text) return branding.logo_text.slice(0, 4);
  const words = branding.display_name.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : branding.display_name.slice(0, 2)
  ).toUpperCase();
}

/** The reseller's mark: its initials in the hairline square, then its name. */
export function BrandMark({
  branding,
  markOnly = false,
}: {
  branding: ResellerBranding;
  markOnly?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="kn-mono inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] border border-[var(--kn-accent-500)] bg-[var(--kn-accent-soft)] px-1 text-[11px] font-medium text-[var(--kn-accent-400)]"
      >
        {initialsOf(branding)}
      </span>
      {!markOnly && (
        <span className="min-w-0 truncate text-[15px] font-medium tracking-[-0.02em] text-[var(--kn-text)]">
          {branding.display_name}
        </span>
      )}
    </span>
  );
}

function SupportFooter({ branding }: { branding: ResellerBranding }) {
  const href =
    branding.support_url ?? (branding.support_email ? `mailto:${branding.support_email}` : null);
  if (!href) return null;
  return (
    <div className="shrink-0 border-t border-[var(--kn-border)] px-4 py-3">
      <MonoLabel size="xs" className="block">
        Support
      </MonoLabel>
      <a
        href={href}
        target={branding.support_url ? "_blank" : undefined}
        rel={branding.support_url ? "noreferrer" : undefined}
        className="mt-1 flex items-center gap-1.5 truncate text-[var(--kn-text-2)] outline-none hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-[var(--kn-ring)]"
      >
        <LifeBuoy size={13} aria-hidden className="shrink-0 text-[var(--kn-text-3)]" />
        <span className="truncate">{branding.support_email ?? branding.support_url}</span>
      </a>
    </div>
  );
}
