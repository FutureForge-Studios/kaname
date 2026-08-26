"use client";

import * as React from "react";
import { Activity } from "lucide-react";
import { signalName, type ProcessRow, type SignalName } from "@kaname/contract";
import {
  Badge,
  ByteSize,
  ConfirmDialog,
  FormField,
  MonoText,
  RelativeTime,
  Select,
  Switch,
  type DataTableColumn,
  type DataTableRowAction,
  type SortState,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { useCan } from "@/lib/queries";
import { formatCount, formatPercent } from "@/lib/format";
import {
  PROCESS_REFRESH_MS,
  PROCESS_SORT_ORDER,
  SIGNAL_ICON,
  useProcesses,
  useProcessSignal,
  type ProcessSort,
  type ProcessView,
} from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Processes.
 *
 * The one inventory Kaname never caches: a process table is stale the
 * moment it is written, so this page reads the host live on every
 * query (KD-012) and says so by refreshing on a visible interval the
 * operator can switch off.
 *
 * The host sorts and truncates, not the browser — which is why the sort
 * arrows only ever point the way the host actually returns that column,
 * and why paging asks for a longer list rather than an offset.
 * ------------------------------------------------------------------ */

const PER_PAGE = 100;

const VIEW_OPTIONS = [
  { value: "flat", label: "Flat list" },
  { value: "tree", label: "Process tree" },
];

const STATE_TONE: Record<ProcessRow["state"], Tone> = {
  running: "ok",
  sleeping: "neutral",
  idle: "neutral",
  disk_sleep: "warn",
  stopped: "warn",
  zombie: "danger",
  unknown: "neutral",
};

interface PendingSignal {
  process: ProcessRow;
  signal: SignalName;
}

export default function ProcessesPage() {
  const can = useCan();
  const selection = useServerSelection({ permission: "infra.processes:read", required: true });
  const server = selection.server;

  const [auto, setAuto] = React.useState(true);
  const [pending, setPending] = React.useState<PendingSignal | null>(null);

  const state = useResourceListState({
    defaultSort: { id: "cpu", order: "desc" },
    defaultPerPage: PER_PAGE,
    filterKeys: ["view", "user"],
  });

  const sort = (state.sort?.id ?? "cpu") as ProcessSort;
  const view = (state.filters["view"] === "tree" ? "tree" : "flat") as ProcessView;
  const user = state.filters["user"] ?? "";

  const query = useProcesses({
    serverId: selection.serverId,
    q: state.q,
    user,
    sort,
    view,
    page: state.page,
    perPage: state.perPage,
    refreshMs: auto ? PROCESS_REFRESH_MS : false,
    enabled: Boolean(selection.serverId),
  });

  const rows = query.data?.data ?? [];
  const signal = useProcessSignal();

  /* The API decides the direction of each sort, so the header shows the
   * direction the rows actually arrived in rather than a wish. */
  const listState = React.useMemo(
    () => ({
      ...state,
      sort: { id: sort, order: PROCESS_SORT_ORDER[sort] } as SortState,
      setSort: (next: SortState | null) =>
        state.setSort({
          id: next?.id ?? "cpu",
          order: PROCESS_SORT_ORDER[(next?.id ?? "cpu") as ProcessSort] ?? "desc",
        }),
    }),
    [sort, state],
  );

  const users = React.useMemo(() => {
    const seen = new Set<string>(user ? [user] : []);
    for (const process of rows) seen.add(process.user);
    return [...seen].sort();
  }, [rows, user]);

  const columns = React.useMemo<DataTableColumn<ProcessRow>[]>(
    () => [
      {
        id: "name",
        header: "Command",
        locked: true,
        sortable: true,
        minWidth: 260,
        cell: (process) => (
          <span
            className="flex min-w-0 items-center"
            style={view === "tree" ? { paddingLeft: (process.depth ?? 0) * 12 } : undefined}
          >
            <MonoText truncate>{process.command}</MonoText>
          </span>
        ),
      },
      {
        id: "cmdline",
        header: "Command line",
        mono: true,
        minWidth: 240,
        hideBelow: "lg",
        accessor: (process) => process.cmdline,
      },
      {
        id: "pid",
        header: "PID",
        sortable: true,
        width: 84,
        align: "right",
        mono: true,
        accessor: (process) => formatCount(process.pid),
      },
      {
        id: "user",
        header: "User",
        width: 112,
        mono: true,
        hideBelow: "md",
        accessor: (process) => process.user,
      },
      {
        id: "state",
        header: "State",
        width: 104,
        cell: (process) => (
          <Badge tone={STATE_TONE[process.state]} size="xs">
            {process.state}
          </Badge>
        ),
      },
      {
        id: "cpu",
        header: "CPU",
        sortable: true,
        width: 84,
        align: "right",
        accessor: (process) => formatPercent(process.cpu_percent, 1),
      },
      {
        id: "memory",
        header: "Memory",
        sortable: true,
        width: 132,
        align: "right",
        cell: (process) => (
          <span className="kn-num">
            <ByteSize bytes={process.memory_rss} />
            <span className="text-[var(--kn-text-3)]">
              {" · "}
              {formatPercent(process.memory_percent, 1)}
            </span>
          </span>
        ),
      },
      {
        id: "threads",
        header: "Threads",
        width: 80,
        align: "right",
        hideBelow: "lg",
        accessor: (process) => formatCount(process.threads),
      },
      {
        id: "nice",
        header: "Nice",
        width: 64,
        align: "right",
        hideBelow: "lg",
        accessor: (process) => formatCount(process.nice),
      },
      {
        id: "started_at",
        header: "Started",
        width: 104,
        align: "right",
        hideBelow: "md",
        cell: (process) => <RelativeTime value={process.started_at} />,
      },
    ],
    [view],
  );

  const rowActions = React.useCallback(
    (process: ProcessRow): DataTableRowAction<ProcessRow>[] => [
      {
        id: "signal",
        label: "Send signal",
        icon: SIGNAL_ICON,
        destructive: true,
        disabled: !can("infra.processes:exec", process.server_id) || process.pid === 1,
        onSelect: () => setPending({ process, signal: "SIGTERM" }),
      },
    ],
    [can],
  );

  return (
    <>
      <ResourcePage<ProcessRow>
        title="Processes"
        subtitle={
          server
            ? `Read live from ${server.hostname}${auto ? `, refreshing every ${PROCESS_REFRESH_MS / 1000}s` : ""}`
            : undefined
        }
        state={listState}
        query={query}
        columns={columns}
        getRowId={(process) => `${process.server_id}:${process.pid}`}
        tableLabel="Processes"
        density="compact"
        searchPlaceholder="Search command, arguments or user"
        filters={
          <>
            <Select
              size="sm"
              aria-label="Process view"
              options={VIEW_OPTIONS}
              value={view}
              onChange={(event) =>
                state.setFilter("view", event.target.value === "tree" ? "tree" : null)
              }
              boxClassName="w-36"
            />
            <Select
              size="sm"
              mono
              aria-label="Filter by user"
              options={[
                { value: "", label: "Any user" },
                ...users.map((value) => ({ value, label: value })),
              ]}
              value={user}
              onChange={(event) => state.setFilter("user", event.target.value || null)}
              boxClassName="w-36"
            />
            <Switch
              size="sm"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
              label="Auto-refresh"
            />
          </>
        }
        rowActions={rowActions}
        emptyIcon={Activity}
        emptyTitle={selection.serverId ? "No processes matched" : "No server selected"}
        emptyDescription={
          selection.serverId
            ? "The host answered, but nothing on it matches the current search and filters."
            : "Processes are read live from one host at a time. Pick a server to start."
        }
        errorContext="Processes"
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} />
        </div>
      </ResourcePage>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending ? `Send ${pending.signal} to ${pending.process.command}?` : "Send signal"}
        description={
          pending?.signal === "SIGKILL"
            ? "SIGKILL cannot be caught or ignored. The process dies immediately, without flushing anything it was holding."
            : "The process may catch this signal and decide what to do with it. Nothing else on the host is touched."
        }
        confirmText={pending?.signal === "SIGKILL" ? String(pending.process.pid) : undefined}
        confirmLabel="Send signal"
        loading={signal.isPending}
        onConfirm={() => {
          if (!pending) return;
          signal.mutate({
            pid: pending.process.pid,
            serverId: pending.process.server_id,
            signal: pending.signal,
            command: pending.process.command,
          });
          setPending(null);
        }}
      >
        <div className="flex flex-col gap-3">
          <FormField
            label="Signal"
            description="Signalling a process is not idempotent, so it is never retried automatically."
          >
            <Select
              mono
              options={signalName.options.map((value) => ({ value, label: value }))}
              value={pending?.signal ?? "SIGTERM"}
              onChange={(event) =>
                setPending((previous) =>
                  previous ? { ...previous, signal: event.target.value as SignalName } : previous,
                )
              }
            />
          </FormField>
          {pending && (
            <p className="kn-mono text-sm text-[var(--kn-text-2)]">
              pid {pending.process.pid} · {pending.process.user} · {pending.process.cmdline}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
