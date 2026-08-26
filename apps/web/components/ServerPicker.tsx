"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Permission, Server, ServerCapability } from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Combobox,
  HealthBadge,
  Skeleton,
  cn,
  type ComboboxOption,
} from "@kaname/ui";
import { useCan, useServers } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * ServerPicker.
 *
 * Every server-scoped page shares this control, and the choice is
 * remembered per section rather than globally: an operator working
 * through mailboxes on mail-01 does not want the containers page to
 * follow them there. The URL still wins, so a link into a page keeps
 * meaning what it said.
 *
 * Both status axes ride along with the selection (PLAN.md 2.6) — the
 * picker is often the only place the current host's state is visible.
 * ------------------------------------------------------------------ */

const STORAGE_PREFIX = "kaname.server.";

/** "/email/mailboxes" -> "email"; the section a preference belongs to. */
export function sectionOf(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "root";
}

function readStored(section: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${section}`);
  } catch {
    return null;
  }
}

function writeStored(section: string, serverId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const key = `${STORAGE_PREFIX}${section}`;
    if (serverId) window.localStorage.setItem(key, serverId);
    else window.localStorage.removeItem(key);
  } catch {
    /* Storage is a convenience here; the URL is the source of truth. */
  }
}

export interface ServerSelection {
  serverId: string | null;
  server: Server | null;
  servers: Server[];
  setServerId: (serverId: string | null) => void;
  isLoading: boolean;
}

export interface UseServerSelectionOptions {
  /** Only servers advertising this capability can be chosen. */
  capability?: ServerCapability;
  /** Only servers this principal holds the permission on. */
  permission?: Permission;
  /** Pages that cannot render without a host auto-pick the first one. */
  required?: boolean;
}

/**
 * Resolution order is URL, then the section's remembered choice, then
 * the first eligible server. Anything else makes a shared link behave
 * differently for the person who receives it.
 */
export function useServerSelection(options: UseServerSelectionOptions = {}): ServerSelection {
  const { capability, permission, required = false } = options;
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const can = useCan();
  const query = useServers();

  const section = sectionOf(pathname);
  const fromUrl = searchParams.get("server_id");

  const servers = React.useMemo(() => {
    const all = query.data?.data ?? [];
    return all.filter((server) => {
      if (capability && !server.capabilities.includes(capability)) return false;
      if (permission && !can(permission, server.id)) return false;
      return true;
    });
  }, [can, capability, permission, query.data]);

  const setServerId = React.useCallback(
    (serverId: string | null) => {
      writeStored(section, serverId);
      const next = new URLSearchParams(searchParams.toString());
      if (serverId) next.set("server_id", serverId);
      else next.delete("server_id");
      // Changing host resets pagination; page 3 of another server is noise.
      next.delete("page");
      const query_ = next.toString();
      router.replace(query_ ? `${pathname}?${query_}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams, section],
  );

  const resolved = React.useMemo(() => {
    if (fromUrl && servers.some((server) => server.id === fromUrl)) return fromUrl;
    const stored = readStored(section);
    if (stored && servers.some((server) => server.id === stored)) return stored;
    if (required) return servers[0]?.id ?? null;
    return fromUrl ?? null;
  }, [fromUrl, required, section, servers]);

  /* Reflect a remembered or defaulted choice back into the URL so every
   * link copied off this page carries the host it was read on. */
  React.useEffect(() => {
    if (query.isLoading) return;
    if (resolved && resolved !== fromUrl) setServerId(resolved);
  }, [fromUrl, query.isLoading, resolved, setServerId]);

  return {
    serverId: resolved,
    server: servers.find((server) => server.id === resolved) ?? null,
    servers,
    setServerId,
    isLoading: query.isLoading,
  };
}

/* ------------------------------------------------------------------ */

export interface ServerPickerProps extends UseServerSelectionOptions {
  selection: ServerSelection;
  /** Adds an "All servers" entry for pages that can aggregate the fleet. */
  allowAll?: boolean;
  allLabel?: string;
  className?: string;
}

export function ServerPicker({
  selection,
  allowAll = false,
  allLabel = "All servers",
  className,
}: ServerPickerProps) {
  const { serverId, server, servers, setServerId, isLoading } = selection;

  const options = React.useMemo<ComboboxOption[]>(() => {
    const entries: ComboboxOption[] = allowAll
      ? [{ value: "", label: allLabel, description: `${servers.length} in scope` }]
      : [];
    for (const candidate of servers) {
      entries.push({
        value: candidate.id,
        label: candidate.name,
        description: candidate.hostname,
        mono: true,
      });
    }
    return entries;
  }, [allLabel, allowAll, servers]);

  if (isLoading) {
    return <Skeleton className={cn("h-7 w-48 rounded-[var(--kn-r-sm)]", className)} label="Loading servers" />;
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <Combobox
        options={options}
        value={serverId ?? ""}
        onValueChange={(next) => setServerId(next && next.length > 0 ? next : null)}
        placeholder={servers.length === 0 ? "No servers in scope" : "Select a server"}
        emptyMessage="No server matches that name."
        disabled={servers.length === 0}
        clearable={allowAll}
        mono
        aria-label="Server"
        className="w-56"
      />
      {server && (
        <div className="flex shrink-0 items-center gap-2">
          <AgentConnectionIndicator
            connection={server.connection}
            since={server.last_seen_at}
            showLabel={false}
          />
          <HealthBadge
            health={server.health}
            reasons={server.health_reasons}
            since={server.latest?.sampled_at ?? null}
            size="xs"
          />
        </div>
      )}
    </div>
  );
}
