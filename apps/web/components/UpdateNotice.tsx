"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpCircle, X } from "lucide-react";
import type { UpdateOverview, UserPreferences } from "@kaname/contract";
import { Spinner, cn, useToast } from "@kaname/ui";
import { api } from "@/lib/api";
import { useModes } from "@/lib/modes";
import { useResource, useResourceMutation, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Kaname update notice.
 *
 * When the control plane's own update check has found a newer release
 * (the `update.available` event, `update_available` on /updates), the
 * people who can apply it are told inside the panel: a dot on
 * Administration → Updates and a pill in the top bar that goes straight
 * to the confirm step. Dismissing the pill is per release and per
 * account (a `dismissed_hints` entry), so the next release asks again.
 *
 * Gated on `admin.settings:write` — the permission POST
 * /updates/control-plane checks — and on the operator audience, so a
 * reseller, a client, or an operator previewing either never sees it.
 *
 * It also owns the "Updated to X" toast: the version this browser last
 * saw is remembered, and the first answer from a newer build that a
 * successful run produced says so once.
 * ------------------------------------------------------------------ */

export const UPDATES_HREF = "/administration/updates";
const HINT_PREFIX = "kaname-update:";
const SEEN_KEY = "kaname.version-seen";

export interface KanameUpdateState {
  /** The newer release, when there is one this account may apply. */
  version: string | null;
  /** True while a control-plane update is being applied. */
  applying: boolean;
  overview: UpdateOverview | null;
  dismissed: boolean;
  dismiss: () => void;
}

export function useKanameUpdate(): KanameUpdateState {
  const { session, can, refresh } = useSession();
  const { audience, preview } = useModes();
  const allowed = Boolean(session?.user) && audience === "operator" && !preview && can("admin.settings:write");

  // Same key as the Updates page, so both read one cache and the SSE
  // `updates` topic refreshes both.
  const query = useResource<UpdateOverview>("updates", "overview", {
    path: "/updates",
    enabled: allowed,
    staleTime: 5 * 60_000,
  });

  const overview = allowed ? (query.data ?? null) : null;
  const cp = overview?.control_plane;
  const version = cp?.update_available ? (cp.latest_version ?? null) : null;
  const applying = cp?.run?.status === "running";

  const hints = session?.preferences?.dismissed_hints ?? [];
  const dismissed = version !== null && hints.includes(`${HINT_PREFIX}${version}`);

  const save = useResourceMutation<string, UserPreferences>({
    mutationFn: (v) =>
      api.patch<UserPreferences>("/auth/preferences", {
        // One entry per account at most: an older release's dismissal is
        // dropped, so the list cannot fill with versions.
        dismissed_hints: [...hints.filter((h) => !h.startsWith(HINT_PREFIX)), `${HINT_PREFIX}${v}`],
      }),
    onDone: () => void refresh(),
  });

  const dismiss = React.useCallback(() => {
    if (version) save.mutate(version);
  }, [save, version]);

  return { version, applying, overview, dismissed, dismiss };
}

/** Says "Updated to X" once, the first time this browser sees the new build. */
function useUpdatedToast(overview: UpdateOverview | null): void {
  const { toast } = useToast();
  const current = overview?.control_plane.current_version ?? null;
  const run = overview?.control_plane.run ?? null;

  React.useEffect(() => {
    if (!current) return;
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(SEEN_KEY);
      window.localStorage.setItem(SEEN_KEY, current);
    } catch {
      return;
    }
    if (!seen || seen === current) return;
    if (run?.status === "succeeded" && run.to_version === current) {
      toast({
        variant: "success",
        title: `Updated to Kaname ${current}`,
        description: `From ${run.from_version}. The control plane is back and answering.`,
      });
    }
  }, [current, run?.status, run?.to_version, run?.from_version, toast]);
}

/** The dot the sidebar puts on Administration → Updates. */
export function useNavIndicators(): ReadonlySet<string> {
  const update = useKanameUpdate();
  return React.useMemo(
    () => new Set(update.version || update.applying ? [UPDATES_HREF] : []),
    [update.version, update.applying],
  );
}

/**
 * The top-bar pill. Quiet by design — one line, mono version, a link —
 * because it competes with breadcrumbs for the same strip.
 */
export function UpdatePill({ className }: { className?: string }) {
  const update = useKanameUpdate();
  // Here rather than in the hook: the sidebar reads the hook too, and
  // the toast must be said once.
  useUpdatedToast(update.overview);

  if (update.applying) {
    return (
      <Link
        href={UPDATES_HREF}
        className={cn(PILL, "text-[var(--kn-text-2)]", className)}
        data-testid="kaname-update-pill"
      >
        <Spinner size={12} label="Updating Kaname" />
        <span className="hidden md:inline">Updating Kaname…</span>
      </Link>
    );
  }

  if (!update.version || update.dismissed) return null;

  const pending = update.overview?.control_plane.pending;
  return (
    <span
      className={cn(PILL, "pr-0.5", className)}
      data-testid="kaname-update-pill"
    >
      <Link
        href={`${UPDATES_HREF}?apply=1`}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-[var(--kn-r-pill)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
        aria-label={`Kaname ${update.version} is available — review and update`}
      >
        <ArrowUpCircle
          size={13}
          aria-hidden
          className={pending?.security ? "text-[var(--kn-warn)]" : "text-[var(--kn-accent-400)]"}
        />
        <span className="hidden text-[var(--kn-text-2)] lg:inline">Kaname</span>
        <span className="kn-mono text-[var(--kn-text)]">{update.version}</span>
        <span className="hidden text-[var(--kn-text-2)] lg:inline">available</span>
        <span className="inline-flex items-center gap-1 text-[var(--kn-accent-400)]">
          <ArrowRight size={12} aria-hidden />
          <span className="hidden sm:inline">Update</span>
        </span>
      </Link>
      <button
        type="button"
        onClick={update.dismiss}
        aria-label={`Dismiss the notice for Kaname ${update.version}`}
        className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded-[var(--kn-r-pill)] text-[var(--kn-text-3)] outline-none transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)] hover:bg-[var(--kn-neutral-soft)] hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
      >
        <X size={12} aria-hidden />
      </button>
    </span>
  );
}

const PILL = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--kn-r-pill)] border border-[var(--kn-border-strong)] pl-2.5 pr-2.5 text-sm",
  "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)] hover:border-[var(--kn-line-control)]",
);
