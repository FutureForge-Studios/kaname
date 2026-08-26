"use client";

import * as React from "react";
import { CloudDownload, History } from "lucide-react";
import type { Server } from "@kaname/contract";
import { Button, RelativeTime, cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * HostSync — the visible half of KD-012.
 *
 * Unit and container lists are served from the control plane's cache,
 * which is the only way a thirty-host page stays usable. The honest
 * version of that trade is to say how old the cached rows are and to
 * put the live re-read one click away, rather than to let a table imply
 * it is watching the host in real time.
 *
 * Distinct from the toolbar's "synced 12s ago", which is the age of the
 * *query*: this is the age of what the host last told us.
 * ------------------------------------------------------------------ */

/** Past this, the cache is old enough that an operator should be told. */
const STALE_MS = 5 * 60_000;

export interface HostSyncProps {
  /** Oldest `last_synced_at` across the rows on screen. */
  syncedAt: string | null;
  /** Null on a fleet-wide view, where there is no single host to re-read. */
  server: Server | null;
  /** "units", "containers" — what a sync would refresh. */
  noun: string;
  canSync: boolean;
  pending: boolean;
  onSync: () => void;
  className?: string;
}

export function HostSync({
  syncedAt,
  server,
  noun,
  canSync,
  pending,
  onSync,
  className,
}: HostSyncProps) {
  const age = syncedAt ? Date.now() - Date.parse(syncedAt) : null;
  const stale = age !== null && Number.isFinite(age) && age > STALE_MS;
  const connected = server?.connection === "connected";

  const reason = !server
    ? `Pick a single server to re-read its ${noun} from the host.`
    : !canSync
      ? `This account cannot read ${noun} on ${server.name}.`
      : !connected
        ? `${server.name}'s agent is not connected, so the host cannot be re-read.`
        : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--kn-r-md)] border px-3 py-2",
        stale
          ? "border-[var(--kn-warn-soft)] bg-[var(--kn-warn-soft)]"
          : "border-[var(--kn-border)] bg-[var(--kn-surface)]",
        className,
      )}
    >
      <History
        size={14}
        className={cn("shrink-0", stale ? "text-[var(--kn-warn)]" : "text-[var(--kn-text-3)]")}
        aria-hidden
      />
      <p className={cn("min-w-0", stale ? "text-[var(--kn-warn)]" : "text-[var(--kn-text-2)]")}>
        {syncedAt ? (
          <>
            {server ? "The host reported these" : "The oldest of these"} {noun} were read{" "}
            <RelativeTime value={syncedAt} />
            {stale && " — this is a cached list, not live state."}
          </>
        ) : (
          <>
            Kaname has not read {noun} from {server ? "this host" : "these hosts"} yet.
          </>
        )}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* Said out loud rather than hidden in a tooltip on a disabled control. */}
        {reason && <span className="text-xs text-[var(--kn-text-3)]">{reason}</span>}
        <Button
          variant="secondary"
          size="xs"
          icon={CloudDownload}
          disabled={Boolean(reason) || pending}
          loading={pending}
          onClick={onSync}
        >
          Sync from host
        </Button>
      </div>
    </div>
  );
}
