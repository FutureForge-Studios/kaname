"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Server as ServerIcon } from "lucide-react";
import { agentConnection, healthState, serverCapability, type Server } from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Badge,
  Button,
  HealthBadge,
  MonoText,
  RelativeTime,
  Select,
  Sparkline,
  cn,
  type DataTableColumn,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { useCan, useList } from "@/lib/queries";
import { formatCount, formatPercent, formatUptime, humanize, percentOf } from "@/lib/format";
import { AddServerDialog } from "../_components/AddServerDialog";
import { useServerCommands } from "../_components/ServerCommands";
import { useFleetSparklines, usageTone, worstDiskPercent } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Fleet.
 *
 * The table an operator opens first, so it answers both status
 * questions in adjacent columns and never merges them (PLAN.md 2.6):
 * `connection` is whether we can reach the box, `health` is whether the
 * box is fine, and a host is routinely connected and critical at the
 * same time.
 *
 * Sparklines come from the monitoring series endpoint rather than from
 * per-row requests, so thirty servers cost three queries.
 * ------------------------------------------------------------------ */

const ANY = "";

const CONNECTION_OPTIONS = [
  { value: ANY, label: "Any agent state" },
  ...agentConnection.options.map((value) => ({ value, label: humanize(value) })),
];

const HEALTH_OPTIONS = [
  { value: ANY, label: "Any health" },
  ...healthState.options.map((value) => ({ value, label: humanize(value) })),
];

const CAPABILITY_OPTIONS = [
  { value: ANY, label: "Any capability" },
  ...serverCapability.options.map((value) => ({ value, label: value })),
];

const SPARK_COLORS: Record<string, string> = {
  danger: "var(--kn-danger)",
  warn: "var(--kn-warn)",
  neutral: "var(--kn-chart-1)",
};

const USAGE_TEXT: Record<string, string> = {
  danger: "text-[var(--kn-danger)]",
  warn: "text-[var(--kn-warn)]",
  neutral: "",
};

interface UsageCellProps {
  percent: number | null;
  values: number[] | undefined;
  label: string;
}

function UsageCell({ percent, values, label }: UsageCellProps) {
  const tone = usageTone(percent);
  return (
    <span className="flex items-center justify-end gap-2">
      {values && values.length > 1 && (
        <Sparkline
          values={values}
          width={52}
          height={18}
          label={label}
          color={SPARK_COLORS[tone] ?? SPARK_COLORS["neutral"]}
          showLastPoint={false}
          className="hidden xl:inline-block"
        />
      )}
      <span className={cn("kn-num", USAGE_TEXT[tone])}>{formatPercent(percent)}</span>
    </span>
  );
}

export default function ServersPage() {
  const router = useRouter();
  const can = useCan();
  const [adding, setAdding] = React.useState(false);

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["connection", "health", "capability"],
  });

  const query = useList<Server>("servers", state.params);
  const rows = query.data?.data ?? [];
  const sparklines = useFleetSparklines(can("monitoring.metrics:read"));
  const commands = useServerCommands();

  const columns = React.useMemo<DataTableColumn<Server>[]>(
    () => [
      {
        id: "name",
        header: "Server",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (server) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-[var(--kn-text)]">{server.name}</span>
            {server.simulated && (
              <Badge tone="info" size="xs">
                sim
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "hostname",
        header: "Hostname",
        sortable: true,
        mono: true,
        minWidth: 160,
        hideBelow: "lg",
        accessor: (server) => server.hostname,
      },
      {
        id: "connection",
        header: "Agent",
        sortable: true,
        width: 136,
        cell: (server) => (
          <AgentConnectionIndicator connection={server.connection} since={server.last_seen_at} />
        ),
      },
      {
        id: "health",
        header: "Health",
        sortable: true,
        width: 108,
        cell: (server) => (
          <HealthBadge
            health={server.health}
            reasons={server.health_reasons}
            since={server.latest?.sampled_at ?? null}
          />
        ),
      },
      {
        id: "os",
        header: "OS",
        minWidth: 150,
        hideBelow: "lg",
        cell: (server) => (
          <MonoText muted truncate>
            {[server.os, server.os_version].filter(Boolean).join(" ") || "—"}
            {server.arch ? ` · ${server.arch}` : ""}
          </MonoText>
        ),
      },
      {
        id: "agent_version",
        header: "Agent version",
        width: 116,
        mono: true,
        hideBelow: "lg",
        accessor: (server) => server.agent_version ?? "—",
      },
      {
        id: "cpu",
        header: "CPU",
        width: 132,
        align: "right",
        hideBelow: "md",
        cell: (server) => (
          <UsageCell
            percent={server.latest?.cpu_percent ?? null}
            values={sparklines.values.cpu.get(server.id)}
            label={`CPU on ${server.name}, last 6 hours`}
          />
        ),
      },
      {
        id: "memory",
        header: "Memory",
        width: 132,
        align: "right",
        hideBelow: "md",
        cell: (server) => (
          <UsageCell
            percent={
              server.latest
                ? percentOf(server.latest.memory_used, server.latest.memory_total)
                : null
            }
            values={sparklines.values.memory.get(server.id)}
            label={`Memory on ${server.name}, last 6 hours`}
          />
        ),
      },
      {
        id: "disk",
        header: "Disk",
        width: 132,
        align: "right",
        hideBelow: "md",
        cell: (server) => (
          <UsageCell
            percent={worstDiskPercent(server.latest?.disks)}
            values={sparklines.values.disk.get(server.id)}
            label={`Fullest mount on ${server.name}, last 6 hours`}
          />
        ),
      },
      {
        id: "uptime",
        header: "Uptime",
        width: 96,
        align: "right",
        hideBelow: "lg",
        accessor: (server) => formatUptime(server.uptime_seconds),
      },
      {
        id: "counts",
        header: "Running",
        width: 168,
        hideBelow: "lg",
        cell: (server) => {
          const counts = server.counts;
          if (!counts) return <span className="text-[var(--kn-text-3)]">—</span>;
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              {counts.services_failed > 0 && (
                <Badge tone="danger" size="xs">
                  {formatCount(counts.services_failed)} failed
                </Badge>
              )}
              <span className="truncate text-[var(--kn-text-2)]">
                {formatCount(counts.sites)} sites · {formatCount(counts.containers)} containers
              </span>
            </span>
          );
        },
      },
      {
        id: "last_seen_at",
        header: "Last seen",
        sortable: true,
        width: 104,
        align: "right",
        cell: (server) => <RelativeTime value={server.last_seen_at} />,
      },
    ],
    [sparklines],
  );

  const addButton = can("infra.servers:write") ? (
    <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
      Add server
    </Button>
  ) : undefined;

  return (
    <>
      <ResourcePage<Server>
        title="Servers"
        subtitle={query.data ? `${formatCount(query.data.meta.total)} in scope` : undefined}
        primaryAction={addButton}
        state={state}
        query={query}
        columns={columns}
        getRowId={(server) => server.id}
        tableLabel="Servers"
        searchPlaceholder="Search name or hostname"
        filters={
          <>
            <Select
              size="sm"
              aria-label="Filter by agent state"
              options={CONNECTION_OPTIONS}
              value={state.filters["connection"] ?? ANY}
              onChange={(event) => state.setFilter("connection", event.target.value || null)}
              boxClassName="w-40"
            />
            <Select
              size="sm"
              aria-label="Filter by health"
              options={HEALTH_OPTIONS}
              value={state.filters["health"] ?? ANY}
              onChange={(event) => state.setFilter("health", event.target.value || null)}
              boxClassName="w-36"
            />
            <Select
              size="sm"
              mono
              aria-label="Filter by capability"
              options={CAPABILITY_OPTIONS}
              value={state.filters["capability"] ?? ANY}
              onChange={(event) => state.setFilter("capability", event.target.value || null)}
              boxClassName="w-40"
            />
          </>
        }
        selectable
        bulkActions={(ids) => commands.bulkActions(ids, rows)}
        rowActions={commands.rowActions}
        onRowClick={(server) => router.push(`/infrastructure/servers/${server.id}`)}
        emptyIcon={ServerIcon}
        emptyTitle="No servers yet"
        emptyDescription="Kaname manages hosts through an agent that dials out. Add a server to get the one-line enrollment command."
        emptyAction={addButton}
        errorContext="Servers"
      />

      <AddServerDialog open={adding} onOpenChange={setAdding} />
      {commands.dialogs}
    </>
  );
}
