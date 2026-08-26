"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box } from "lucide-react";
import { containerState, type Container, type Server } from "@kaname/contract";
import { DataTable, EmptyState, SearchInput, Select } from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCan, useList } from "@/lib/queries";
import { humanize } from "@/lib/format";
import { HostSync } from "./HostSync";
import { PruneButton } from "./PruneButton";
import { useContainerColumns, useContainerCommands } from "./ContainerControls";
import { hasContainerRuntime, useContainerSync, useDebounced } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * A host's containers, embedded in its detail page.
 *
 * Identical columns and verbs to the fleet-wide Containers page. A host
 * with no container runtime says so rather than rendering an empty
 * table that looks like a host with no containers.
 * ------------------------------------------------------------------ */

const PER_PAGE = 25;

export function ServerContainersTab({ server }: { server: Server }) {
  const router = useRouter();
  const can = useCan();

  const [search, setSearch] = React.useState("");
  const [state, setState] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<string[]>([]);

  const q = useDebounced(search);
  const runtime = hasContainerRuntime(server);

  const query = useList<Container>(
    "containers",
    {
      server_id: server.id,
      q: q || undefined,
      state: state || undefined,
      sort: "name",
      order: "asc",
      page,
      per_page: PER_PAGE,
    },
    { enabled: runtime },
  );

  const rows = query.data?.data ?? [];
  const columns = useContainerColumns({ showServer: false });
  const commands = useContainerCommands();
  const sync = useContainerSync();

  React.useEffect(() => setSelected([]), [q, state, page]);

  const syncedAt = rows.reduce<string | null>(
    (oldest, container) =>
      oldest === null || container.last_synced_at < oldest ? container.last_synced_at : oldest,
    null,
  );

  if (!runtime) {
    return (
      <EmptyState
        icon={Box}
        title="No container runtime"
        description={`${server.name} does not advertise docker or podman, so Kaname greys the module out rather than failing at call time.`}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <HostSync
        syncedAt={syncedAt}
        server={server}
        noun="containers"
        canSync={can("infra.containers:read", server.id)}
        pending={sync.isPending}
        onSync={() => sync.mutate({ serverId: server.id, serverName: server.name })}
      />

      <DataTable<Container>
        columns={columns}
        rows={rows}
        getRowId={(container) => container.id}
        label={`Containers on ${server.name}`}
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
              placeholder="Search name or image"
              aria-label={`Search containers on ${server.name}`}
              size="sm"
              boxClassName="w-48"
            />
            <Select
              size="sm"
              aria-label="Filter by container state"
              options={[
                { value: "", label: "Any state" },
                ...containerState.options.map((value) => ({ value, label: humanize(value) })),
              ]}
              value={state}
              onChange={(event) => {
                setState(event.target.value);
                setPage(1);
              }}
              boxClassName="w-36"
            />
            <PruneButton server={server} size="xs" />
            <Link
              href={`/infrastructure/containers?server_id=${server.id}`}
              className="ml-auto rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              Open in Containers
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
        onRowClick={(container) => router.push(`/infrastructure/containers/${container.id}`)}
        loading={query.isLoading}
        skeletonRows={8}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Containers"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={Box}
            title={q || state ? "No matching containers" : "No containers cached yet"}
            description={
              q || state
                ? "Nothing on this host matches the current search and filter."
                : "Kaname has not read the container list from this host. Sync it from the bar above."
            }
            size="sm"
          />
        }
      />

      {commands.dialog}
    </div>
  );
}
