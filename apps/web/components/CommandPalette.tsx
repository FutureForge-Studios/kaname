"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Clock,
  Compass,
  Keyboard,
  ListChecks,
  LogOut,
  Search,
  Zap,
} from "lucide-react";
import {
  NAV_LEAVES,
  type Permission,
  type SearchAction,
  type SearchResponse,
  type SearchResult,
} from "@kaname/contract";
import { Dialog, Kbd, Spinner, cn } from "@kaname/ui";
import { api, type ApiError } from "@/lib/api";
import { iconFor, type IconComponent } from "@/lib/icons";
import { queryKeys, useCan, useJobDrawer } from "@/lib/queries";
import { PageError } from "./PageError";

/* ------------------------------------------------------------------ *
 * Command palette — the signature interaction.
 *
 * Two things make it worth building rather than buying:
 *
 * 1. Local destinations resolve on the keystroke. NAVIGATION is already
 *    in the bundle, so section jumps never wait on a round trip and the
 *    palette feels instant even while /search is still in flight.
 * 2. It runs things. The control plane returns ACTIONS beside results —
 *    "restart nginx on web-01" — so the operator is not sent to a list
 *    to hunt for a row.
 *
 * Everything is keyboard-reachable and nothing is mouse-only.
 * ------------------------------------------------------------------ */

const RECENT_KEY = "kaname.palette.recent";
const MAX_RECENT = 6;
const DEBOUNCE_MS = 140;

export interface PaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: IconComponent;
  /** Shown right-aligned: a shortcut, a server name, a state. */
  meta?: string;
  kbd?: string;
  href?: string;
  run: () => void;
}

interface RecentEntry {
  title: string;
  subtitle: string;
  href: string;
  icon: string;
}

/* ---------------------------- provider ----------------------------- */

interface CommandPaletteValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Opens the palette pre-filled, e.g. from a row's "find related". */
  openWith: (query: string) => void;
}

const CommandPaletteContext = React.createContext<CommandPaletteValue | null>(null);

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [seed, setSeed] = React.useState("");

  const value = React.useMemo<CommandPaletteValue>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((previous) => !previous),
      openWith: (query: string) => {
        setSeed(query);
        setOpen(true);
      },
    }),
    [open],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} seed={seed} />
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteValue {
  const context = React.useContext(CommandPaletteContext);
  if (!context) throw new Error("useCommandPalette must be used inside <CommandPaletteProvider>");
  return context;
}

/* ----------------------------- recents ----------------------------- */

function readRecents(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as RecentEntry[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function pushRecent(entry: RecentEntry): void {
  if (typeof window === "undefined") return;
  try {
    const next = [entry, ...readRecents().filter((r) => r.href !== entry.href)].slice(0, MAX_RECENT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* A private window without storage still gets a working palette. */
  }
}

/* ---------------------------- matching ----------------------------- */

/** Subsequence match, so "wsl" finds "Websites / SSL". */
function score(haystack: string, needle: string): number {
  const target = haystack.toLowerCase();
  const query = needle.toLowerCase();
  if (query.length === 0) return 0.5;
  if (target === query) return 1;
  if (target.startsWith(query)) return 0.9;
  const index = target.indexOf(query);
  if (index >= 0) return 0.7 - Math.min(0.2, index / 100);

  let cursor = 0;
  for (const character of query) {
    cursor = target.indexOf(character, cursor);
    if (cursor === -1) return 0;
    cursor += 1;
  }
  return 0.4;
}

/* ----------------------------- palette ----------------------------- */

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: string;
}

function CommandPalette({ open, onOpenChange, seed }: CommandPaletteProps) {
  const router = useRouter();
  const can = useCan();
  const drawer = useJobDrawer();

  const [value, setValue] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [recents, setRecents] = React.useState<RecentEntry[]>([]);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const listboxId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    setValue(seed);
    setDebounced(seed);
    setActive(0);
    setRecents(readRecents());
  }, [open, seed]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const search = useQuery<SearchResponse, ApiError>({
    queryKey: queryKeys.search(debounced),
    queryFn: ({ signal }) =>
      api.get<SearchResponse>("/search", { params: { q: debounced, limit: 24 }, signal }),
    enabled: open && debounced.length > 0,
    staleTime: 15_000,
    retry: false,
  });

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);

  const go = React.useCallback(
    (href: string, entry?: RecentEntry) => {
      if (entry) pushRecent(entry);
      close();
      router.push(href);
    },
    [close, router],
  );

  /* ---- items ---------------------------------------------------- */

  const items = React.useMemo<PaletteItem[]>(() => {
    const query = debounced;
    const out: PaletteItem[] = [];

    if (query.length === 0) {
      for (const recent of recents) {
        out.push({
          id: `recent:${recent.href}`,
          group: "Recent",
          title: recent.title,
          subtitle: recent.subtitle,
          icon: iconFor(recent.icon),
          href: recent.href,
          run: () => go(recent.href, recent),
        });
      }
    }

    /* Destinations resolve locally; no round trip, no loading state. */
    const destinations = NAV_LEAVES.filter((leaf) => can(leaf.permission))
      .map((leaf) => ({
        leaf,
        rank: Math.max(score(leaf.label, query), score(`${leaf.section} ${leaf.label}`, query)),
      }))
      .filter((entry) => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, query.length === 0 ? 8 : 6);

    for (const { leaf } of destinations) {
      const entry: RecentEntry = {
        title: leaf.label,
        subtitle: leaf.section,
        href: leaf.href,
        icon: leaf.icon,
      };
      out.push({
        id: `nav:${leaf.href}`,
        group: "Go to",
        title: leaf.label,
        subtitle: leaf.section === leaf.label ? undefined : leaf.section,
        icon: iconFor(leaf.icon),
        kbd: leaf.shortcut ? `g then ${leaf.shortcut}` : undefined,
        href: leaf.href,
        run: () => go(leaf.href, entry),
      });
    }

    for (const command of BUILT_IN_COMMANDS) {
      if (command.permission && !can(command.permission)) continue;
      if (score(command.title, query) <= 0) continue;
      out.push({
        id: `command:${command.id}`,
        group: "Commands",
        title: command.title,
        subtitle: command.hint,
        icon: command.icon,
        run: () => {
          close();
          command.run({ router, drawer });
        },
      });
    }

    const response = search.data;
    if (response) {
      for (const action of response.actions) {
        if (!can(action.permission as Permission)) continue;
        const href = action.href;
        if (!href) continue;
        out.push({
          id: `action:${action.id}`,
          group: "Actions",
          title: action.label,
          subtitle: action.hint,
          icon: Zap,
          href,
          run: () => go(href, { title: action.label, subtitle: action.hint, href, icon: "Zap" }),
        });
      }

      for (const group of response.groups) {
        for (const result of group.results) {
          out.push({
            id: `${result.kind}:${result.id}`,
            group: group.label,
            title: result.title,
            subtitle: result.subtitle,
            meta: result.server_name ?? undefined,
            icon: iconFor(result.icon),
            href: result.href,
            run: () => go(result.href, toRecent(result)),
          });
        }
      }
    }

    return out;
  }, [can, close, debounced, drawer, go, recents, router, search.data]);

  React.useEffect(() => {
    setActive((current) => (current >= items.length ? 0 : current));
  }, [items.length]);

  React.useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [active, items.length]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (items.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((current) => (current + 1) % items.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((current) => (current - 1 + items.length) % items.length);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(items.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        items[active]?.run();
        break;
      }
      default:
        break;
    }
  };

  /* ---- grouping -------------------------------------------------- */

  const groups = React.useMemo(() => {
    const ordered: { label: string; items: { item: PaletteItem; index: number }[] }[] = [];
    items.forEach((item, index) => {
      const existing = ordered.find((group) => group.label === item.group);
      if (existing) existing.items.push({ item, index });
      else ordered.push({ label: item.group, items: [{ item, index }] });
    });
    return ordered;
  }, [items]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      label="Command palette"
      className="mt-[10vh] max-w-2xl self-start"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--kn-border)] px-3">
        <Search size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
        <input
          data-autofocus=""
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search servers, sites, mailboxes, jobs — or run an action"
          aria-label="Search and commands"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={items[active] ? `${listboxId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-md text-[var(--kn-text)] outline-none placeholder:text-[var(--kn-text-3)]"
        />
        {search.isFetching && <Spinner size={14} label="Searching" />}
        <Kbd keys="esc" size="xs" />
      </div>

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Results"
        className="max-h-[52vh] min-h-0 flex-1 overflow-y-auto py-1"
      >
        {search.error && (
          <div className="p-3">
            <PageError error={search.error} onRetry={() => void search.refetch()} />
          </div>
        )}

        {!search.error && items.length === 0 && (
          <p className="px-3 py-6 text-center text-[var(--kn-text-2)]">
            {debounced.length === 0
              ? "Type to search the fleet."
              : `Nothing matches “${debounced}”.`}
          </p>
        )}

        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <div className="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-[var(--kn-text-3)]">
              {group.label}
            </div>
            {group.items.map(({ item, index }) => (
              <PaletteRow
                key={item.id}
                id={`${listboxId}-${index}`}
                item={item}
                active={index === active}
                onHover={() => setActive(index)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-[var(--kn-border)] px-3 text-xs text-[var(--kn-text-3)]">
        <span className="inline-flex items-center gap-1">
          <Kbd keys="up" size="xs" />
          <Kbd keys="down" size="xs" />
          navigate
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd keys="enter" size="xs" />
          open
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Kbd keys="shift+/" size="xs" />
          all shortcuts
        </span>
      </div>
    </Dialog>
  );
}

function toRecent(result: SearchResult): RecentEntry {
  return {
    title: result.title,
    subtitle: result.subtitle,
    href: result.href,
    icon: result.icon,
  };
}

interface PaletteRowProps {
  id: string;
  item: PaletteItem;
  active: boolean;
  onHover: () => void;
}

function PaletteRow({ id, item, active, onHover }: PaletteRowProps) {
  const Icon = item.icon;
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-active={active}
      onMouseMove={onHover}
      onClick={item.run}
      className={cn(
        "flex h-9 cursor-pointer items-center gap-2.5 px-3",
        "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        active ? "bg-[var(--kn-accent-soft)]" : "bg-transparent",
      )}
    >
      <Icon
        size={14}
        className={cn(
          "shrink-0",
          active ? "text-[var(--kn-accent-400)]" : "text-[var(--kn-text-3)]",
        )}
        aria-hidden
      />
      <span className="min-w-0 truncate text-[var(--kn-text)]">{item.title}</span>
      {item.subtitle && (
        <span className="kn-mono min-w-0 truncate text-sm text-[var(--kn-text-3)]">
          {item.subtitle}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {item.meta && <span className="text-xs text-[var(--kn-text-3)]">{item.meta}</span>}
        {item.kbd && <Kbd keys={item.kbd} size="xs" />}
        {active && (
          <ArrowRight size={12} className="text-[var(--kn-accent-400)]" aria-hidden />
        )}
      </span>
    </div>
  );
}

/* -------------------------- built-in commands ---------------------- */

interface CommandContext {
  router: ReturnType<typeof useRouter>;
  drawer: ReturnType<typeof useJobDrawer>;
}

interface BuiltInCommand {
  id: string;
  title: string;
  hint: string;
  icon: IconComponent;
  permission?: Permission;
  run: (context: CommandContext) => void;
}

const BUILT_IN_COMMANDS: readonly BuiltInCommand[] = [
  {
    id: "jobs.open",
    title: "Show job activity",
    hint: "Everything this session has queued",
    icon: ListChecks,
    run: ({ drawer }) => drawer.setOpen(true),
  },
  {
    id: "shortcuts.open",
    title: "Keyboard shortcuts",
    hint: "The full sheet",
    icon: Keyboard,
    run: () => {
      window.dispatchEvent(new CustomEvent("kaname:shortcuts"));
    },
  },
  {
    id: "servers.enroll",
    title: "Add a server",
    hint: "Mint an enrollment token",
    icon: Compass,
    permission: "infra.servers:write",
    run: ({ router }) => router.push("/infrastructure/servers?new=1"),
  },
  {
    id: "auth.logout",
    title: "Sign out",
    hint: "Ends this session everywhere it is open",
    icon: LogOut,
    run: () => {
      void api.post("/auth/logout").finally(() => window.location.assign("/login"));
    },
  },
  {
    id: "recent.clear",
    title: "Clear palette history",
    hint: "Forgets recently opened resources",
    icon: Clock,
    run: () => {
      try {
        window.localStorage.removeItem(RECENT_KEY);
      } catch {
        /* nothing stored, nothing to clear */
      }
    },
  },
];
