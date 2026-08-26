"use client";

import * as React from "react";
import Link from "next/link";
import type { LogSourceRow, Server } from "@kaname/contract";
import { Combobox, Skeleton, type ComboboxOption } from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useList } from "@/lib/queries";
import { LogTailPanel } from "./LogTailPanel";

/* ------------------------------------------------------------------ *
 * A host's logs.
 *
 * Sources are enumerated live by the agent rather than guessed, so the
 * picker only ever offers streams that exist on this box. Nothing is
 * cached here: a stale log line is worse than a slow one.
 * ------------------------------------------------------------------ */

export function ServerLogsTab({ server }: { server: Server }) {
  const connected = server.connection === "connected";

  const sources = useList<LogSourceRow>(
    "logs/sources",
    { server_id: server.id, per_page: 200, sort: "label", order: "asc" },
    { enabled: connected },
  );

  const rows = sources.data?.data ?? [];
  const [source, setSource] = React.useState<string | null>(null);

  /* Default to the first source the host reports, so the tab is useful
   * without a decision the operator has no basis to make yet. */
  React.useEffect(() => {
    if (source !== null || rows.length === 0) return;
    setSource(rows[0]?.id ?? null);
  }, [rows, source]);

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      rows.map((row) => ({
        value: row.id,
        label: row.label,
        description: row.ref,
        mono: true,
      })),
    [rows],
  );

  const unavailable = !connected ? (
    <>
      <p className="text-[var(--kn-text)]">{server.name}&apos;s agent is not connected.</p>
      <p className="mt-1">
        Logs are read live from the host, so there is nothing to show until it dials back in.
      </p>
    </>
  ) : rows.length === 0 && !sources.isLoading ? (
    <p>This host reports no log sources.</p>
  ) : !source ? (
    <p>Pick a source to start following it.</p>
  ) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {sources.isError && (
        <PageError
          error={sources.error}
          onRetry={() => void sources.refetch()}
          context="Log sources"
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        {sources.isLoading ? (
          <Skeleton className="h-7 w-72 rounded-[var(--kn-r-sm)]" label="Loading log sources" />
        ) : (
          <Combobox
            options={options}
            value={source ?? ""}
            onValueChange={setSource}
            placeholder={connected ? "Select a log source" : "Agent not connected"}
            emptyMessage="No source matches that name."
            disabled={!connected || options.length === 0}
            mono
            aria-label="Log source"
            className="w-72"
          />
        )}
        <Link
          href={`/logs?server_id=${server.id}`}
          className="ml-auto rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Open in Logs
        </Link>
      </div>

      <LogTailPanel
        path="/logs/tail"
        params={{ server_id: server.id, source: source ?? undefined }}
        linesKey="limit"
        unavailable={unavailable}
        label={`Logs on ${server.name}`}
        height={520}
      />
    </div>
  );
}
