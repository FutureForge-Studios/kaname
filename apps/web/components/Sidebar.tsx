"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LifeBuoy, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { NavLeaf, NavSection, ResellerBranding } from "@kaname/contract";
import { Dot, IconButton, Kbd, MonoLabel, Tooltip, cn } from "@kaname/ui";
import { iconFor } from "@/lib/icons";
import { AUDIENCE_LABELS, useModes, useNavigation } from "@/lib/modes";
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
 * ffstudios treatment: flat ink with a hairline edge, groups opened by
 * a numbered mono uppercase label ("01 INFRASTRUCTURE"), and the active
 * leaf marked by a purple bar on the rail rather than a filled row.
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

/** A path is active for the deepest matching leaf, so detail routes light up their list. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
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
            aria-label={branding ? `${branding.display_name} — Home` : "Kaname — Command Center"}
            className="min-w-0 rounded-[var(--kn-r-sm)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
          >
            {branding ? (
              <BrandMark branding={branding} markOnly={narrow} />
            ) : (
              <Wordmark markOnly={narrow} />
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
        className={cn("min-h-0 flex-1 overflow-y-auto pb-4 pt-3", narrow ? "px-2" : "px-2")}
      >
        {sections.map(({ section, leaves }, index) => (
          <SidebarSection
            key={section.label}
            section={section}
            leaves={leaves}
            pathname={pathname}
            narrow={narrow}
            first={index === 0}
            indicators={indicators}
            number={
              leaves.length > 0
                ? sections.slice(0, index + 1).filter((entry) => entry.leaves.length > 0).length
                : 0
            }
            onNavigate={onNavigate}
          />
        ))}
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

interface SidebarSectionProps {
  section: NavSection;
  leaves: NavLeaf[];
  pathname: string;
  narrow: boolean;
  first: boolean;
  /** 1-based position among the grouped sections; shown as "01". */
  number: number;
  /** Leaves that carry an "attention here" dot, e.g. a Kaname update. */
  indicators: ReadonlySet<string>;
  onNavigate?: () => void;
}

function SidebarSection({
  section,
  leaves,
  pathname,
  narrow,
  first,
  number,
  indicators,
  onNavigate,
}: SidebarSectionProps) {
  const labelId = React.useId();

  if (leaves.length === 0) {
    return (
      <div className={cn(!first && "mt-1")}>
        <SidebarLink
          href={section.href ?? "/"}
          label={section.label}
          icon={section.icon}
          active={isActive(pathname, section.href ?? "/")}
          narrow={narrow}
          onNavigate={onNavigate}
        />
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby={narrow ? undefined : labelId} className={cn(!first && "mt-4")}>
      {narrow ? (
        <div className="mx-2 mb-2 h-px bg-[var(--kn-border)]" aria-hidden />
      ) : (
        <div className="kn-label-sm flex items-center gap-2 px-2 pb-1.5 text-[var(--kn-text-3)]">
          <span aria-hidden className="opacity-60">
            {String(number).padStart(2, "0")}
          </span>
          <span id={labelId} className="truncate">
            {section.label}
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-px">
        {leaves.map((leaf) => (
          <li key={leaf.href}>
            <SidebarLink
              href={leaf.href}
              label={leaf.label}
              icon={leaf.icon}
              shortcut={leaf.shortcut}
              active={isActive(pathname, leaf.href)}
              indicator={indicators.has(leaf.href)}
              narrow={narrow}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SidebarLinkProps {
  href: string;
  label: string;
  icon: string;
  shortcut?: string;
  active: boolean;
  /** A small accent dot: something new behind this link. */
  indicator?: boolean;
  narrow: boolean;
  onNavigate?: () => void;
}

function SidebarLink({
  href,
  label,
  icon,
  shortcut,
  active,
  indicator = false,
  narrow,
  onNavigate,
}: SidebarLinkProps) {
  const Icon = iconFor(icon);

  const link = (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/nav relative flex h-7 items-center rounded-[var(--kn-r-sm)] outline-none",
        "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
        narrow ? "w-full justify-center px-0" : "gap-2.5 px-2",
        active
          ? "bg-[var(--kn-neutral-soft)] text-[var(--kn-text)]"
          : "text-[var(--kn-text-2)] hover:bg-[var(--kn-neutral-soft)] hover:text-[var(--kn-text)]",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-r-[1px] bg-[var(--kn-accent-500)]"
        />
      )}
      <Icon
        size={15}
        className={cn("shrink-0", active ? "text-[var(--kn-accent-400)]" : "text-[var(--kn-text-3)] group-hover/nav:text-current")}
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
      {!narrow && shortcut && (
        <Kbd
          keys={`g then ${shortcut}`}
          size="xs"
          className="opacity-0 transition-opacity duration-[var(--kn-dur-fast)] group-hover/nav:opacity-100"
        />
      )}
      {narrow && <span className="sr-only">{label}</span>}
    </Link>
  );

  if (!narrow) return link;

  return (
    <Tooltip content={shortcut ? `${label} — g then ${shortcut}` : label} placement="right">
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
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : branding.display_name.slice(0, 2))
    .toUpperCase();
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
  const href = branding.support_url ?? (branding.support_email ? `mailto:${branding.support_email}` : null);
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
