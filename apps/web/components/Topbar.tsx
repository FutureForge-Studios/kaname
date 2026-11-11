"use client";

import * as React from "react";
import {
  Check,
  Eye,
  EyeOff,
  Keyboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  UserRound,
} from "lucide-react";
import type { ViewMode } from "@kaname/contract";
import {
  Avatar,
  DropdownMenu,
  IconButton,
  Kbd,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  SegmentedControl,
  SubMenu,
  cn,
} from "@kaname/ui";
import { api } from "@/lib/api";
import { useModes } from "@/lib/modes";
import { useSession } from "@/lib/queries";
import { Breadcrumbs } from "./Breadcrumbs";
import { useCommandPalette } from "./CommandPalette";
import { JobActivityButton } from "./JobDrawer";

/* ------------------------------------------------------------------ *
 * Topbar — 52px, flat ink with a hairline, and it never grows.
 *
 * It carries only what has to be reachable from every page: where you
 * are, the way to get anywhere (the palette), what is running (jobs),
 * and who you are. Page-specific actions belong to the PageHeader
 * underneath it, so the two never compete for the same corner.
 *
 * The one exception is the Simplified / Advanced switch (KD-039): it
 * changes what every page offers, so it sits with the other global
 * controls. Below 768px it moves into the account menu.
 * ------------------------------------------------------------------ */

const VIEW_MODE_OPTIONS = [
  { value: "simplified", label: "Simplified" },
  { value: "advanced", label: "Advanced" },
] as const satisfies readonly { value: ViewMode; label: string }[];

export type ThemeChoice = "dark" | "light" | "system";

const THEME_KEY = "kaname.theme";

/** Kept in sync with the pre-paint script in app/layout.tsx. */
export function applyTheme(choice: ThemeChoice): void {
  const resolved =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : choice;
  document.documentElement.setAttribute("data-theme", resolved);
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* The attribute is already set; persistence is the optional half. */
  }
}

function readTheme(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

const THEME_LABELS: Record<ThemeChoice, string> = {
  dark: "Dark",
  light: "Light",
  system: "Match system",
};

const THEME_ICONS: Record<ThemeChoice, typeof Moon> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export interface TopbarProps {
  /** Shown below 1024px, where the sidebar is a drawer. */
  onOpenNav: () => void;
  className?: string;
}

export function Topbar({ onOpenNav, className }: TopbarProps) {
  const palette = useCommandPalette();
  const { session, can } = useSession();
  const modes = useModes();
  const [theme, setTheme] = React.useState<ThemeChoice>("system");

  React.useEffect(() => setTheme(readTheme()), []);

  const chooseTheme = React.useCallback((choice: ThemeChoice) => {
    applyTheme(choice);
    setTheme(choice);
  }, []);

  const user = session?.user ?? null;
  const identity = user?.name ?? session?.api_key?.name ?? "Signed in";

  return (
    <header
      className={cn(
        "kn-material flex h-[var(--kn-topbar-h)] shrink-0 items-center gap-2 border-b border-[var(--kn-border)] pl-3 pr-3 lg:pl-6",
        className,
      )}
    >
      <IconButton
        icon={Menu}
        label="Open navigation"
        size="sm"
        onClick={onOpenNav}
        className="lg:hidden"
      />

      <Breadcrumbs className="min-w-0 flex-1" />

      <button
        type="button"
        onClick={() => palette.setOpen(true)}
        aria-label="Search and commands"
        className={cn(
          "kn-label-sm hidden h-8 min-w-0 items-center gap-2.5 rounded-[var(--kn-r-sm)] border border-[var(--kn-border-strong)]",
          "bg-transparent pl-2.5 pr-2 text-[var(--kn-text-3)] outline-none sm:flex",
          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
          "hover:border-[var(--kn-line-control)] hover:text-[var(--kn-text)]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
        )}
      >
        <Search size={13} aria-hidden />
        <span className="w-24 text-left md:w-36">Search</span>
        <Kbd keys="mod+k" size="xs" className="tracking-normal" />
      </button>

      <IconButton
        icon={Search}
        label="Search and commands"
        size="sm"
        onClick={() => palette.setOpen(true)}
        className="sm:hidden"
      />

      {user && (
        <SegmentedControl
          label="View mode"
          size="xs"
          options={VIEW_MODE_OPTIONS}
          value={modes.viewMode}
          onValueChange={modes.setViewMode}
          className="hidden md:inline-flex"
          data-testid="view-mode-switch"
        />
      )}

      <JobActivityButton />

      <DropdownMenu
        placement="bottom-end"
        label="Account"
        trigger={
          <button
            type="button"
            aria-label={`Account — ${identity}`}
            className={cn(
              "inline-flex h-8 w-8 items-center justify-center rounded-[var(--kn-r-pill)] outline-none",
              "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
              "hover:bg-[var(--kn-neutral-soft)]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
            )}
          >
            <Avatar name={identity} size="md" />
          </button>
        }
      >
        <MenuLabel className="font-[family-name:var(--kn-font-sans)] normal-case tracking-normal">
          <span className="block truncate text-base text-[var(--kn-text)]">{identity}</span>
          {user?.email && (
            <span className="kn-mono block truncate text-[var(--kn-text-3)]">{user.email}</span>
          )}
        </MenuLabel>
        <MenuSeparator />

        <SubMenu label={`Theme — ${THEME_LABELS[theme]}`} icon={THEME_ICONS[theme]}>
          {(["dark", "light", "system"] as const).map((choice) => (
            <MenuItem
              key={choice}
              role="menuitemradio"
              aria-checked={theme === choice}
              icon={theme === choice ? Check : THEME_ICONS[choice]}
              onSelect={() => chooseTheme(choice)}
            >
              {THEME_LABELS[choice]}
            </MenuItem>
          ))}
        </SubMenu>

        {user && (
          <SubMenu
            label={`View — ${modes.viewMode === "simplified" ? "Simplified" : "Advanced"}`}
            icon={SlidersHorizontal}
          >
            {VIEW_MODE_OPTIONS.map((option) => (
              <MenuItem
                key={option.value}
                role="menuitemradio"
                aria-checked={modes.viewMode === option.value}
                icon={modes.viewMode === option.value ? Check : undefined}
                onSelect={() => modes.setViewMode(option.value)}
              >
                {option.label}
              </MenuItem>
            ))}
          </SubMenu>
        )}

        {modes.preview ? (
          <MenuItem icon={EyeOff} onSelect={modes.exitPreview}>
            Exit {modes.preview} preview
          </MenuItem>
        ) : (
          modes.canPreview && (
            <SubMenu label="View as…" icon={Eye}>
              <MenuItem onSelect={() => modes.startPreview("client")}>Client</MenuItem>
              <MenuItem onSelect={() => modes.startPreview("reseller")}>Reseller</MenuItem>
            </SubMenu>
          )
        )}

        <MenuItem
          icon={Keyboard}
          onSelect={() => window.dispatchEvent(new CustomEvent("kaname:shortcuts"))}
        >
          Keyboard shortcuts
        </MenuItem>

        {user && (
          // /account, not /administration/users: the account page is where
          // your own password, two-factor and sessions live, and the users
          // list is forbidden to every role without admin.users:read.
          <MenuItem icon={UserRound} onSelect={() => window.location.assign("/account")}>
            Your profile and sessions
          </MenuItem>
        )}

        {can("admin.settings:read") && (
          <MenuItem icon={Settings} onSelect={() => window.location.assign("/administration/settings")}>
            Settings
          </MenuItem>
        )}

        <MenuSeparator />
        <MenuItem
          icon={LogOut}
          destructive
          onSelect={() => {
            void api.post("/auth/logout").finally(() => window.location.assign("/login"));
          }}
        >
          Sign out
        </MenuItem>
      </DropdownMenu>
    </header>
  );
}
