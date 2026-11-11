"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  NAVIGATION,
  type AccountContext,
  type Audience,
  type NavLeaf,
  type NavSection,
  type Permission,
  type ResellerBranding,
  type ViewMode,
} from "@kaname/contract";
import { useToast } from "@kaname/ui";
import { api, toApiError, type ApiError } from "./api";
import { useSession } from "./queries";

/* ------------------------------------------------------------------ *
 * View modes and audiences (KD-039), as the shell sees them.
 *
 *   view mode   Simplified / Advanced. A per-user preference stored on
 *               the account (PUT /me/view-mode). It hides pages; the
 *               control plane never reads it.
 *   audience    operator / reseller / client, from GET /me.
 *   preview     an owner or admin "viewing as" a client or reseller.
 *               Held in this browser tab only. It filters what the
 *               shell draws and nothing else: no request changes, no
 *               permission is granted, nobody is impersonated.
 *
 * Everything that decides what navigation to draw lives here, so the
 * sidebar and the command palette can never disagree about it.
 * ------------------------------------------------------------------ */

export type PreviewAudience = Exclude<Audience, "operator">;

const PREVIEW_KEY = "kaname.preview-as";
const VIEW_MODE_KEY = "kaname.view-mode";

export const accountKey = ["kaname", "me"] as const;

export interface ModeValue {
  /** Null while loading, for an API key, or when /me failed. */
  account: AccountContext | null;
  accountQuery: UseQueryResult<AccountContext, ApiError>;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  savingViewMode: boolean;
  /** Who the signed-in account really is. */
  actualAudience: Audience;
  /** What the shell is drawing for: the preview when one is on. */
  audience: Audience;
  preview: PreviewAudience | null;
  /** Owners and admins may preview; scoped accounts never can. */
  canPreview: boolean;
  startPreview: (as: PreviewAudience) => void;
  exitPreview: () => void;
  /** The reseller's branding for a reseller or its client; null otherwise. */
  branding: ResellerBranding | null;
}

/* ------------------------------------------------------------------ *
 * Browser-held state, as tiny external stores rather than a provider:
 * the command palette renders outside the app shell, and it has to
 * draw the same navigation as the sidebar.
 * ------------------------------------------------------------------ */

function readStored(key: string, storage: "local" | "session"): string | null {
  if (typeof window === "undefined") return null;
  try {
    return (storage === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null, storage: "local" | "session"): void {
  try {
    const store = storage === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* A convenience: the server holds the real preference. */
  }
}

function createStore<T extends string>(key: string, storage: "local" | "session", allowed: readonly T[]) {
  let value: T | null | undefined;
  const listeners = new Set<() => void>();
  const read = (): T | null => {
    if (value === undefined) {
      const stored = readStored(key, storage);
      value = stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : null;
    }
    return value;
  };
  return {
    get: read,
    set(next: T | null) {
      value = next;
      writeStored(key, next, storage);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* The last mode this browser saw, so a reload does not flash the
 * Advanced sidebar for a Simplified user while /me is in flight. */
const cachedModeStore = createStore<ViewMode>(VIEW_MODE_KEY, "local", ["simplified", "advanced"]);
const previewStore = createStore<PreviewAudience>(PREVIEW_KEY, "session", ["client", "reseller"]);

function useStore<T extends string>(store: ReturnType<typeof createStore<T>>): T | null {
  return React.useSyncExternalStore(store.subscribe, store.get, () => null);
}

/** Mode, audience and preview for the signed-in person. Usable anywhere under the session. */
export function useModes(): ModeValue {
  const { session, can } = useSession();
  const client = useQueryClient();
  const { toast } = useToast();
  const hasUser = Boolean(session?.user);

  const accountQuery = useQuery<AccountContext, ApiError>({
    queryKey: accountKey,
    queryFn: ({ signal }) => api.get<AccountContext>("/me", { signal }),
    enabled: hasUser,
    staleTime: 60_000,
  });
  const account = accountQuery.data ?? null;
  const cachedMode = useStore(cachedModeStore);
  const preview = useStore(previewStore);

  const mutation = useMutation<AccountContext, ApiError, ViewMode, { previous?: AccountContext }>({
    mutationFn: async (mode) => {
      try {
        return await api.put<AccountContext>("/me/view-mode", { view_mode: mode });
      } catch (err) {
        throw toApiError(err);
      }
    },
    onMutate: async (mode) => {
      await client.cancelQueries({ queryKey: accountKey });
      const previous = client.getQueryData<AccountContext>(accountKey);
      if (previous) client.setQueryData<AccountContext>(accountKey, { ...previous, view_mode: mode });
      cachedModeStore.set(mode);
      return { previous };
    },
    onError: (error, _mode, context) => {
      if (context?.previous) {
        client.setQueryData(accountKey, context.previous);
        cachedModeStore.set(context.previous.view_mode);
      }
      toast({ variant: "error", title: error.message, description: error.remediation?.summary });
    },
    onSuccess: (next) => {
      client.setQueryData(accountKey, next);
      cachedModeStore.set(next.view_mode);
    },
  });

  const actualAudience: Audience = account?.audience ?? "operator";
  const canPreview = actualAudience === "operator" && hasUser && can("admin.users:write");
  const activePreview = canPreview ? preview : null;
  const viewMode: ViewMode = account?.view_mode ?? cachedMode ?? "advanced";
  const { mutate } = mutation;

  const setViewMode = React.useCallback(
    (mode: ViewMode) => {
      if (mode !== viewMode) mutate(mode);
    },
    [viewMode, mutate],
  );

  return {
    account,
    accountQuery,
    viewMode,
    setViewMode,
    savingViewMode: mutation.isPending,
    actualAudience,
    audience: activePreview ?? actualAudience,
    preview: activePreview,
    canPreview,
    startPreview: previewStore.set,
    exitPreview: exitPreview,
    branding: activePreview ? null : (account?.branding ?? null),
  };
}

function exitPreview(): void {
  previewStore.set(null);
}

export function useViewMode(): Pick<ModeValue, "viewMode" | "setViewMode" | "savingViewMode"> {
  const { viewMode, setViewMode, savingViewMode } = useModes();
  return { viewMode, setViewMode, savingViewMode };
}

export function useAudience(): Pick<
  ModeValue,
  "audience" | "actualAudience" | "preview" | "canPreview" | "startPreview" | "exitPreview" | "branding"
> {
  const { audience, actualAudience, preview, canPreview, startPreview, exitPreview, branding } =
    useModes();
  return { audience, actualAudience, preview, canPreview, startPreview, exitPreview, branding };
}

export const AUDIENCE_LABELS: Record<Audience, string> = {
  operator: "Operator",
  reseller: "Reseller",
  client: "Client",
};

/* ------------------------------------------------------------------ *
 * Navigation per mode
 * ------------------------------------------------------------------ */

/** Pages Simplified hides: the expert tools an operator reaches for on purpose. */
export const EXPERT_HREFS: ReadonlySet<string> = new Set([
  "/infrastructure/processes",
  "/infrastructure/containers",
  "/websites/dns",
  "/email/logs",
  "/security/firewall",
  "/security/ssh",
  "/security/audit",
  "/terminal",
  "/administration/api",
]);

/** What a client or reseller is shown of the operator's navigation. */
export const CLIENT_HREFS: ReadonlySet<string> = new Set([
  "/apps",
  "/websites/sites",
  "/websites/domains",
  "/files/manager",
  "/email/mailboxes",
  "/databases/mysql",
  "/databases/postgres",
  "/backups",
]);

export interface VisibleSection {
  section: NavSection;
  leaves: NavLeaf[];
}

/* A leaf that is always drawn for its audience; the page itself decides. */
const SELF: Permission = "websites.sites:read";

const HOME_LEAF: NavSection = { label: "Home", icon: "LayoutDashboard", href: "/", permission: SELF };

const RESELLER_SECTION: NavSection = {
  label: "Reseller",
  icon: "Users",
  permission: SELF,
  children: [
    { label: "Clients", href: "/reseller/clients", icon: "Users", permission: SELF },
    { label: "Quotas", href: "/reseller/quotas", icon: "HardDrive", permission: SELF },
    { label: "Branding", href: "/reseller/branding", icon: "BadgeCheck", permission: SELF },
  ],
};

const ACCOUNT_SECTION: NavSection = {
  label: "Account",
  icon: "UserCog",
  href: "/account",
  permission: SELF,
};

const RESELLERS_LEAF: NavLeaf = {
  label: "Resellers",
  href: "/administration/resellers",
  icon: "Users",
  permission: "admin.users:read",
};

export interface NavigationInput {
  audience: Audience;
  viewMode: ViewMode;
  can: (permission: Permission) => boolean;
}

/**
 * The sections the sidebar draws. Permission filtering is per leaf and
 * then per section, as before; the mode only ever removes.
 */
export function navigationFor({ audience, viewMode, can }: NavigationInput): VisibleSection[] {
  const out: VisibleSection[] = [];

  if (audience !== "operator") {
    out.push({ section: HOME_LEAF, leaves: [] });
    for (const section of NAVIGATION) {
      if (!section.children) {
        if (section.href && CLIENT_HREFS.has(section.href) && can(section.permission)) {
          out.push({ section, leaves: [] });
        }
        continue;
      }
      const leaves = section.children.filter(
        (leaf) => CLIENT_HREFS.has(leaf.href) && can(leaf.permission),
      );
      if (leaves.length > 0) out.push({ section, leaves });
    }
    if (audience === "reseller") {
      out.push({ section: RESELLER_SECTION, leaves: RESELLER_SECTION.children ?? [] });
    }
    out.push({ section: ACCOUNT_SECTION, leaves: [] });
    return out;
  }

  const simplified = viewMode === "simplified";
  for (const section of NAVIGATION) {
    if (!section.children) {
      if (!can(section.permission)) continue;
      if (simplified && section.href && EXPERT_HREFS.has(section.href)) continue;
      out.push({
        section: simplified && section.href === "/" ? { ...section, label: "Home" } : section,
        leaves: [],
      });
      continue;
    }
    let children = section.children;
    if (section.label === "Administration" && !children.some((l) => l.href === RESELLERS_LEAF.href)) {
      const at = children.findIndex((leaf) => leaf.href === "/administration/users");
      children = [...children.slice(0, at + 1), RESELLERS_LEAF, ...children.slice(at + 1)];
    }
    const leaves = children.filter(
      (leaf) => can(leaf.permission) && !(simplified && EXPERT_HREFS.has(leaf.href)),
    );
    if (leaves.length > 0) out.push({ section, leaves });
  }
  return out;
}

/** Flattened, for the command palette. */
export function flattenNavigation(sections: VisibleSection[]): (NavLeaf & { section: string })[] {
  return sections.flatMap(({ section, leaves }) =>
    leaves.length > 0
      ? leaves.map((leaf) => ({ ...leaf, section: section.label }))
      : section.href
        ? [
            {
              label: section.label,
              href: section.href,
              icon: section.icon,
              permission: section.permission,
              section: section.label,
            },
          ]
        : [],
  );
}

/** The navigation for the signed-in person in their current mode. */
export function useNavigation(): VisibleSection[] {
  const { can } = useSession();
  const { audience, viewMode } = useModes();
  return React.useMemo(
    () => navigationFor({ audience, viewMode, can: (p) => can(p) }),
    [audience, viewMode, can],
  );
}
