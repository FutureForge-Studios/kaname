"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Cog } from "lucide-react";
import { serviceActiveState, type Service } from "@kaname/contract";
import { Select, Switch } from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { useCan, useList } from "@/lib/queries";
import { formatCount, humanize } from "@/lib/format";
import { HostSync } from "../_components/HostSync";
import { useServiceColumns, useServiceCommands } from "../_components/ServiceControls";
import { useServiceSync } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Services.
 *
 * Fleet-wide by default and scoped by the picker, because "which units
 * are failed anywhere" and "what is running on web-01" are both
 * questions an operator asks daily.
 *
 * Rows come from the control plane's cache, so the age of that cache is
 * stated above the table with the live re-read one click away (KD-012).
 * Every verb produces a job, never a spinner (KD-008).
 * ------------------------------------------------------------------ */

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  ...serviceActiveState.options.map((value) => ({ value, label: humanize(value) })),
];

export default function ServicesPage() {
  const router = useRouter();
  const can = useCan();

  const selection = useServerSelection({ permission: "infra.services:read" });
  const extraParams = React.useMemo(
    () => ({ server_id: selection.serverId ?? undefined }),
    [selection.serverId],
  );

  const state = useResourceListState({
    defaultSort: { id: "unit", order: "asc" },
    filterKeys: ["active_state"],
    extraParams,
  });

  const query = useList<Service>("services", state.params);
  const rows = query.data?.data ?? [];

  const columns = useServiceColumns({ showServer: selection.serverId === null });
  const commands = useServiceCommands();
  const sync = useServiceSync();

  const failedOnly = state.filters["active_state"] === "failed";
  const syncedAt = rows.reduce<string | null>(
    (oldest, service) =>
      oldest === null || service.last_synced_at < oldest ? service.last_synced_at : oldest,
    null,
  );

  return (
    <>
      <ResourcePage<Service>
        title="Services"
        subtitle={
          query.data
            ? `${formatCount(query.data.meta.total)} units${selection.server ? ` on ${selection.server.name}` : " across the fleet"}`
            : undefined
        }
        state={state}
        query={query}
        columns={columns}
        getRowId={(service) => service.id}
        tableLabel="Services"
        searchPlaceholder="Search unit or description"
        filters={
          <>
            <Select
              size="sm"
              aria-label="Filter by unit state"
              disabled={failedOnly}
              options={STATE_OPTIONS}
              value={state.filters["active_state"] ?? ""}
              onChange={(event) => state.setFilter("active_state", event.target.value || null)}
              boxClassName="w-36"
            />
            <Switch
              size="sm"
              checked={failedOnly}
              onChange={(event) =>
                state.setFilter("active_state", event.target.checked ? "failed" : null)
              }
              label="Failed only"
            />
          </>
        }
        selectable
        bulkActions={(ids) => commands.bulkActions(ids, rows)}
        rowActions={commands.rowActions}
        onRowClick={(service) => router.push(`/infrastructure/services/${service.id}`)}
        emptyIcon={Cog}
        emptyTitle="No units cached yet"
        emptyDescription="Kaname reads the unit list from each host and caches it. Pick a server and sync it from the host."
        errorContext="Services"
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll allLabel="All servers" />
        </div>

        <HostSync
          syncedAt={syncedAt}
          server={selection.server}
          noun="units"
          canSync={selection.server !== null && can("infra.services:read", selection.server.id)}
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
