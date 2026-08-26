"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Cog } from "lucide-react";
import { serviceActiveState, type Server, type Service } from "@kaname/contract";
import { DataTable, EmptyState, SearchInput, Select, Switch } from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCan, useList } from "@/lib/queries";
import { humanize } from "@/lib/format";
import { HostSync } from "./HostSync";
import { useServiceColumns, useServiceCommands } from "./ServiceControls";
import { useDebounced, useServiceSync } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * A host's units, embedded in its detail page.
 *
 * Same columns, same verbs and same confirmations as the fleet-wide
 * Services page — only the scaffold differs, because a tab has no page
 * header of its own and its list state belongs to the tab rather than
 * to the URL.
 * ------------------------------------------------------------------ */

const PER_PAGE = 25;

export function ServerServicesTab({ server }: { server: Server }) {
  const router = useRouter();
  const can = useCan();

  const [search, setSearch] = React.useState("");
  const [failedOnly, setFailedOnly] = React.useState(false);
  const [state, setState] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<string[]>([]);

  const q = useDebounced(search);
  const activeState = failedOnly ? "failed" : state || undefined;

  const query = useList<Service>("services", {
    server_id: server.id,
    q: q || undefined,
    active_state: activeState,
    sort: "unit",
    order: "asc",
    page,
    per_page: PER_PAGE,
  });

  const rows = query.data?.data ?? [];
  const columns = useServiceColumns({ showServer: false });
  const commands = useServiceCommands();
  const sync = useServiceSync();

  React.useEffect(() => setSelected([]), [q, activeState, page]);

  const syncedAt = rows.reduce<string | null>(
    (oldest, service) =>
      oldest === null || service.last_synced_at < oldest ? service.last_synced_at : oldest,
    null,
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <HostSync
        syncedAt={syncedAt}
        server={server}
        noun="units"
        canSync={can("infra.services:read", server.id)}
        pending={sync.isPending}
        onSync={() => sync.mutate({ serverId: server.id, serverName: server.name })}
      />

      <DataTable<Service>
        columns={columns}
        rows={rows}
        getRowId={(service) => service.id}
        label={`Units on ${server.name}`}
        density="compact"
        toolbar={
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              onClear={() => setSearch("")}
              placeholder="Search units"
              aria-label={`Search units on ${server.name}`}
              size="sm"
              boxClassName="w-48"
            />
            <Select
              size="sm"
              aria-label="Filter by unit state"
              disabled={failedOnly}
              options={[
                { value: "", label: "Any state" },
                ...serviceActiveState.options.map((value) => ({ value, label: humanize(value) })),
              ]}
              value={failedOnly ? "failed" : state}
              onChange={(event) => {
                setState(event.target.value);
                setPage(1);
              }}
              boxClassName="w-36"
            />
            <Switch
              size="sm"
              checked={failedOnly}
              onChange={(event) => {
                setFailedOnly(event.target.checked);
                setPage(1);
              }}
              label="Failed only"
            />
            <Link
              href={`/infrastructure/services?server_id=${server.id}`}
              className="ml-auto rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              Open in Services
            </Link>
          </div>
        }
        page={page}
        perPage={PER_PAGE}
        total={query.data?.meta.total}
        onPageChange={setPage}
        selectedIds={selected}
        onSelectionChange={setSelected}
        bulkActions={(ids) => commands.bulkActions(ids, rows)}
        rowActions={commands.rowActions}
        onRowClick={(service) => router.push(`/infrastructure/services/${service.id}`)}
        loading={query.isLoading}
        skeletonRows={8}
        error={
          query.isError ? (
            <PageError error={query.error} onRetry={() => void query.refetch()} context="Units" />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={Cog}
            title={q || activeState ? "No matching units" : "No units cached yet"}
            description={
              q || activeState
                ? "Nothing on this host matches the current search and filter."
                : "Kaname has not read the unit list from this host. Sync it from the bar above."
            }
            size="sm"
          />
        }
      />

      {commands.dialog}
    </div>
  );
}
