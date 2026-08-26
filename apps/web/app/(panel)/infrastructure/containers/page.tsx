"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Box } from "lucide-react";
import { containerState, type Container } from "@kaname/contract";
import { Select } from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { useCan, useList } from "@/lib/queries";
import { formatCount, humanize } from "@/lib/format";
import { HostSync } from "../_components/HostSync";
import { PruneButton } from "../_components/PruneButton";
import { useContainerColumns, useContainerCommands } from "../_components/ContainerControls";
import { useContainerSync } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Containers.
 *
 * Fleet-wide by default, scoped by the picker. Rows come from the
 * control plane's cache so that one unreachable host costs one stale
 * row rather than the whole page (KD-012); the age of that cache is
 * stated above the table with the live re-read one click away.
 * ------------------------------------------------------------------ */

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  ...containerState.options.map((value) => ({ value, label: humanize(value) })),
];

export default function ContainersPage() {
  const router = useRouter();
  const can = useCan();

  const selection = useServerSelection({ permission: "infra.containers:read" });
  const extraParams = React.useMemo(
    () => ({ server_id: selection.serverId ?? undefined }),
    [selection.serverId],
  );

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["state"],
    extraParams,
  });

  const query = useList<Container>("containers", state.params);
  const rows = query.data?.data ?? [];

  const columns = useContainerColumns({ showServer: selection.serverId === null });
  const commands = useContainerCommands();
  const sync = useContainerSync();

  const syncedAt = rows.reduce<string | null>(
    (oldest, container) =>
      oldest === null || container.last_synced_at < oldest ? container.last_synced_at : oldest,
    null,
  );

  return (
    <>
      <ResourcePage<Container>
        title="Containers"
        subtitle={
          query.data
            ? `${formatCount(query.data.meta.total)} containers${selection.server ? ` on ${selection.server.name}` : " across the fleet"}`
            : undefined
        }
        primaryAction={<PruneButton server={selection.server} />}
        state={state}
        query={query}
        columns={columns}
        getRowId={(container) => container.id}
        tableLabel="Containers"
        searchPlaceholder="Search name or image"
        filters={
          <Select
            size="sm"
            aria-label="Filter by container state"
            options={STATE_OPTIONS}
            value={state.filters["state"] ?? ""}
            onChange={(event) => state.setFilter("state", event.target.value || null)}
            boxClassName="w-36"
          />
        }
        selectable
        bulkActions={(ids) => commands.bulkActions(ids, rows)}
        rowActions={commands.rowActions}
        onRowClick={(container) => router.push(`/infrastructure/containers/${container.id}`)}
        emptyIcon={Box}
        emptyTitle="No containers cached yet"
        emptyDescription="Kaname reads the container list from each host that advertises docker or podman. Pick a server and sync it from the host."
        errorContext="Containers"
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll allLabel="All servers" />
        </div>

        <HostSync
          syncedAt={syncedAt}
          server={selection.server}
          noun="containers"
          canSync={selection.server !== null && can("infra.containers:read", selection.server.id)}
          pending={sync.isPending}
          onSync={() => {
            if (selection.server) {
              sync.mutate({
                serverId: selection.server.id,
                serverName: selection.server.name,
              });
            }
          }}
        />
      </ResourcePage>

      {commands.dialog}
    </>
  );
}
