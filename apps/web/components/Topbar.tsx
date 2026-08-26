"use client";

import * as React from "react";
import {
  Check,
  Keyboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import {
  Avatar,
  DropdownMenu,
  IconButton,
  Kbd,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  SubMenu,
  cn,
} from "@kaname/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { Breadcrumbs } from "./Breadcrumbs";
import { useCommandPalette } from "./CommandPalette";
import { JobActivityButton } from "./JobDrawer";

/* ------------------------------------------------------------------ *
 * Topbar — 48px, and it never grows.
 *
 * It carries only what has to be reachable from every page: where you
 * are, the way to get anywhere (the palette), what is running (jobs),
 * and who you are. Page-specific actions belong to the PageHeader
 * underneath it, so the two never compete for the same corner.
 * ------------------------------------------------------------------ */

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
  if (typeof window === "undefined") return "dark";
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
        "flex h-[var(--kn-topbar-h)] shrink-0 items-center gap-2 border-b border-[var(--kn-border)] bg-[var(--kn-bg)] px-3",
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
          "hidden h-7 min-w-0 items-center gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)]",
          "bg-[var(--kn-surface)] pl-2 pr-1.5 text-[var(--kn-text-3)] outline-none sm:flex",
          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          "hover:border-[var(--kn-border-strong)] hover:text-[var(--kn-text-2)]",
        )}
      >
        <Search size={14} aria-hidden />
        <span className="w-28 text-left md:w-40">Search</span>
        <Kbd keys="mod+k" size="xs" />
      </button>

      <IconButton
        icon={Search}
        label="Search and commands"
        size="sm"
        onClick={() => palette.setOpen(true)}
        className="sm:hidden"
      />

      <JobActivityButton />

      <DropdownMenu
        placement="bottom-end"
        label="Account"
        trigger={
          <button
            type="button"
            aria-label={`Account — ${identity}`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[var(--kn-r-sm)] px-1 outline-none",
              "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
              "hover:bg-[var(--kn-surface-2)]",
            )}
          >
            <Avatar name={identity} size="sm" />
          </button>
        }
      >
        <MenuLabel>
          <span className="block truncate text-[var(--kn-text)]">{identity}</span>
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

        <MenuItem
          icon={Keyboard}
          onSelect={() => window.dispatchEvent(new CustomEvent("kaname:shortcuts"))}
        >
          Keyboard shortcuts
        </MenuItem>

        {user && (
          <MenuItem icon={UserRound} onSelect={() => window.location.assign("/administration/users")}>
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
