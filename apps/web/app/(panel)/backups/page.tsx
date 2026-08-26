"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  BadgeCheck,
  CircleSlash,
  HardDriveDownload,
  History,
  Pencil,
  Play,
  Plug,
  Plus,
  Power,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  BackupDestination,
  BackupRun,
  BackupSchedule,
  Job,
  RestorePoint,
} from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  ConfirmDialog,
  Duration,
  MonoText,
  RelativeTime,
  Select,
  StatusBadge,
  Tab,
  TabList,
  Tabs,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import {
  DestinationDialog,
  RestoreDialog,
  RunStatusBadge,
  ScheduleDialog,
  DESTINATION_KIND_LABELS,
  SCOPE_KIND_LABELS,
  describeDestination,
  describeRetention,
  describeScope,
} from "@/components/BackupForms";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { describeCron } from "@/lib/cron";
import { formatCount } from "@/lib/format";
import { api } from "@/lib/api";
import {
  useCan,
  useList,
  useMutationWithJob,
  useResourceMutation,
  useServers,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Backups.
 *
 * Four lists that are one workflow, so they are four tabs of one page
 * rather than four routes: a destination holds repositories, a schedule
 * writes into one, a run is an attempt, and a restore point is what a
 * successful attempt leaves behind. Reading down that chain is the
 * normal way an operator answers "is this actually protected".
 *
 * The tab lives in the query string and resets the list state with it —
 * a sort or a filter chosen for run history means nothing on
 * destinations, and carrying it across would silently hide rows.
 * ------------------------------------------------------------------ */

const TABS = [
  { value: "schedules", label: "Schedules" },
  { value: "destinations", label: "Destinations" },
  { value: "runs", label: "Run history" },
  { value: "restore-points", label: "Restore points" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

/** Shared by the schedule and run filters so the two never drift. */
const RUN_STATUS_OPTIONS = [
  { value: "succeeded", label: "Succeeded" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "cancelled", label: "Cancelled" },
] as const;

function isTab(value: string | null): value is TabValue {
  return TABS.some((tab) => tab.value === value);
}

export default function BackupsPage() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const active: TabValue = isTab(raw) ? raw : "schedules";

  const tabs = <BackupTabs active={active} />;

  if (active === "destinations") return <DestinationsTab tabs={tabs} />;
  if (active === "runs") return <RunsTab tabs={tabs} />;
  if (active === "restore-points") return <RestorePointsTab tabs={tabs} />;
  return <SchedulesTab tabs={tabs} />;
}

function BackupTabs({ active }: { active: TabValue }) {
  const router = useRouter();
  return (
    <Tabs
      value={active}
      onValueChange={(next) => router.replace(`/backups?tab=${next}`, { scroll: false })}
    >
      <TabList>
        {TABS.map((tab) => (
          <Tab key={tab.value} value={tab.value}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}

/* ------------------------------------------------------------------ *
 * Schedules
 * ------------------------------------------------------------------ */

function SchedulesTab({ tabs }: { tabs: React.ReactNode }) {
  const router = useRouter();
  const can = useCan();
  const servers = useServers();

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["server_id", "destination_id", "enabled", "last_run_status", "scope_kind"],
  });
  const query = useList<BackupSchedule>("backups/schedules", state.params);
  const destinations = useList<BackupDestination>("backups/destinations", {
    per_page: 200,
    sort: "name",
    order: "asc",
  });

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<BackupSchedule | null>(null);
  const [deleting, setDeleting] = React.useState<BackupSchedule | null>(null);

  const runNow = useMutationWithJob<string[]>({
    mutationFn: async (ids) => ({
      jobs: await Promise.all(
        ids.map((id) =>
          api.post<{ job: Job }>(`/backups/schedules/${id}/run`).then((response) => response.job),
        ),
      ),
      correlation_id: ids.join(","),
    }),
    invalidates: ["backups/schedules", "backups/runs", "backups/restore-points"],
  });

  const setEnabled = useResourceMutation<{ ids: string[]; enabled: boolean }, unknown>({
    mutationFn: ({ ids, enabled }) =>
      Promise.all(ids.map((id) => api.patch(`/backups/schedules/${id}`, { enabled }))),
    invalidates: ["backups/schedules"],
    successMessage: (_result, { ids, enabled }) =>
      `${formatCount(ids.length)} schedule${ids.length === 1 ? "" : "s"} ${enabled ? "enabled" : "disabled"}.`,
    onDone: () => state.setSelected([]),
  });

  const remove = useResourceMutation<BackupSchedule, void>({
    mutationFn: (schedule) => api.del(`/backups/schedules/${schedule.id}`),
    invalidates: ["backups/schedules"],
    successMessage: (_result, schedule) => `Schedule "${schedule.name}" deleted.`,
    onDone: () => setDeleting(null),
  });

  const columns = React.useMemo<DataTableColumn<BackupSchedule>[]>(
    () => [
      {
        id: "name",
        header: "Schedule",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (schedule) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">{schedule.name}</span>
            <MonoText muted truncate className="text-sm">
              {schedule.server_name}
            </MonoText>
          </div>
        ),
      },
      {
        id: "scope",
        header: "Scope",
        minWidth: 160,
        hideBelow: "lg",
        accessor: (schedule) => describeScope(schedule.scope),
      },
      {
        id: "cron",
        header: "Runs",
        minWidth: 200,
        cell: (schedule) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[var(--kn-text)]">
              {describeCron(schedule.cron, schedule.timezone)}
            </span>
            <MonoText muted className="text-sm">
              {schedule.cron}
            </MonoText>
          </div>
        ),
      },
      {
        id: "destination",
        header: "Destination",
        minWidth: 140,
        hideBelow: "md",
        accessor: (schedule) => schedule.destination_name,
      },
      {
        id: "retention",
        header: "Retention",
        minWidth: 160,
        hideBelow: "lg",
        accessor: (schedule) => describeRetention(schedule.retention),
      },
      {
        id: "last_run_at",
        header: "Last run",
        width: 132,
        sortable: true,
        cell: (schedule) => (
          <div className="flex items-center gap-2">
            <RunStatusBadge status={schedule.last_run_status} size="xs" />
            <RelativeTime
              value={schedule.last_run_at}
              className="text-xs text-[var(--kn-text-3)]"
            />
          </div>
        ),
      },
      {
        id: "next_run_at",
        header: "Next run",
        width: 112,
        align: "right",
        sortable: true,
        cell: (schedule) =>
          schedule.enabled ? (
            <RelativeTime value={schedule.next_run_at} fallback="not scheduled" />
          ) : (
            <Badge tone="neutral" size="xs">
              disabled
            </Badge>
          ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (schedule: BackupSchedule): DataTableRowAction<BackupSchedule>[] => {
      const writable = can("backups.schedules:write", schedule.server_id);
      return [
        {
          id: "run",
          label: "Run now",
          icon: Play,
          disabled: !writable,
          onSelect: () => runNow.mutate([schedule.id]),
        },
        {
          id: "edit",
          label: "Edit",
          icon: Pencil,
          disabled: !writable,
          onSelect: () => setEditing(schedule),
        },
        {
          id: "toggle",
          label: schedule.enabled ? "Disable" : "Enable",
          icon: Power,
          disabled: !writable,
          onSelect: () => setEnabled.mutate({ ids: [schedule.id], enabled: !schedule.enabled }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          disabled: !can("backups.schedules:delete", schedule.server_id),
          onSelect: () => setDeleting(schedule),
        },
      ];
    },
    [can, runNow, setEnabled],
  );

  return (
    <>
      <ResourcePage<BackupSchedule>
        title="Backups"
        tabs={tabs}
        state={state}
        query={query}
        columns={columns}
        getRowId={(schedule) => schedule.id}
        tableLabel="Backup schedules"
        searchPlaceholder="Search schedules"
        selectable
        onRowClick={(schedule) => router.push(`/backups/${schedule.id}`)}
        rowActions={rowActions}
        errorContext="Backup schedules"
        emptyIcon={Archive}
        emptyTitle="No backup schedules"
        emptyDescription="A schedule names what to protect on one host, how often, and where the snapshots go."
        primaryAction={
          can("backups.schedules:write") && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
              New schedule
            </Button>
          )
        }
        emptyAction={
          can("backups.schedules:write") && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
              New schedule
            </Button>
          )
        }
        filters={
          <>
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by server"
              value={state.filters.server_id ?? ""}
              onChange={(event) => state.setFilter("server_id", event.target.value || null)}
              options={[
                { value: "", label: "Any server" },
                ...(servers.data?.data ?? []).map((server) => ({
                  value: server.id,
                  label: server.name,
                })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by destination"
              value={state.filters.destination_id ?? ""}
              onChange={(event) => state.setFilter("destination_id", event.target.value || null)}
              options={[
                { value: "", label: "Any destination" },
                ...(destinations.data?.data ?? []).map((destination) => ({
                  value: destination.id,
                  label: destination.name,
                })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by scope"
              value={state.filters.scope_kind ?? ""}
              onChange={(event) => state.setFilter("scope_kind", event.target.value || null)}
              options={[
                { value: "", label: "Any scope" },
                ...Object.entries(SCOPE_KIND_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by last run"
              value={state.filters.last_run_status ?? ""}
              onChange={(event) => state.setFilter("last_run_status", event.target.value || null)}
              options={[{ value: "", label: "Any outcome" }, ...RUN_STATUS_OPTIONS]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by state"
              value={state.filters.enabled ?? ""}
              onChange={(event) => state.setFilter("enabled", event.target.value || null)}
              options={[
                { value: "", label: "Enabled and disabled" },
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
            />
          </>
        }
        bulkActions={(ids) => (
          <>
            <Button
              variant="secondary"
              size="xs"
              icon={Play}
              onClick={() => runNow.mutate(ids)}
              disabled={!can("backups.schedules:write")}
            >
              Run now
            </Button>
            <Button
              variant="secondary"
              size="xs"
              icon={Power}
              onClick={() => setEnabled.mutate({ ids, enabled: true })}
              disabled={!can("backups.schedules:write")}
            >
              Enable
            </Button>
            <Button
              variant="secondary"
              size="xs"
              icon={CircleSlash}
              onClick={() => setEnabled.mutate({ ids, enabled: false })}
              disabled={!can("backups.schedules:write")}
            >
              Disable
            </Button>
          </>
        )}
      />

      <ScheduleDialog open={creating} onOpenChange={setCreating} />
      <ScheduleDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        schedule={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "schedule"}?`}
        description="Snapshots already in the destination are untouched — but Kaname loses the repository password with the schedule, so encrypted snapshots become unreadable from the panel."
        confirmText={deleting?.name}
        confirmLabel="Delete schedule"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Destinations
 * ------------------------------------------------------------------ */

const DESTINATION_STATUS_TONES = {
  ok: "ok",
  unreachable: "danger",
  untested: "neutral",
} as const;

function DestinationsTab({ tabs }: { tabs: React.ReactNode }) {
  const router = useRouter();
  const can = useCan();
  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["kind", "status"],
  });
  const query = useList<BackupDestination>("backups/destinations", state.params);

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<BackupDestination | null>(null);
  const [deleting, setDeleting] = React.useState<BackupDestination | null>(null);

  const test = useResourceMutation<string[], unknown>({
    mutationFn: (ids) =>
      Promise.all(ids.map((id) => api.post("/backups/destinations/test", { destination_id: id }))),
    invalidates: ["backups/destinations"],
    successMessage: (_result, ids) =>
      `Tested ${formatCount(ids.length)} destination${ids.length === 1 ? "" : "s"}.`,
    onDone: () => state.setSelected([]),
  });

  const remove = useResourceMutation<BackupDestination, void>({
    mutationFn: (destination) => api.del(`/backups/destinations/${destination.id}`),
    invalidates: ["backups/destinations"],
    successMessage: (_result, destination) => `Destination "${destination.name}" deleted.`,
    onDone: () => setDeleting(null),
  });

  const columns = React.useMemo<DataTableColumn<BackupDestination>[]>(
    () => [
      {
        id: "name",
        header: "Destination",
        locked: true,
        sortable: true,
        minWidth: 160,
        cell: (destination) => (
          <span className="truncate font-medium text-[var(--kn-text)]">{destination.name}</span>
        ),
      },
      {
        id: "kind",
        header: "Kind",
        width: 132,
        sortable: true,
        cell: (destination) => (
          <Badge tone="neutral" size="xs">
            {DESTINATION_KIND_LABELS[destination.kind]}
          </Badge>
        ),
      },
      {
        id: "endpoint",
        header: "Endpoint",
        mono: true,
        minWidth: 200,
        hideBelow: "md",
        accessor: (destination) => describeDestination(destination),
      },
      {
        id: "status",
        header: "Status",
        width: 132,
        sortable: true,
        cell: (destination) => (
          <StatusBadge
            tone={DESTINATION_STATUS_TONES[destination.status]}
            size="sm"
            title={
              destination.status_detail ??
              "Reachability only. Whether these credentials can write is proven by the first run."
            }
          >
            {destination.status}
          </StatusBadge>
        ),
      },
      {
        id: "used_bytes",
        header: "Used",
        width: 96,
        align: "right",
        sortable: true,
        cell: (destination) => <ByteSize bytes={destination.used_bytes} />,
      },
      {
        id: "snapshot_count",
        header: "Snapshots",
        width: 96,
        align: "right",
        cell: (destination) => (
          <span className="kn-num">{formatCount(destination.snapshot_count)}</span>
        ),
      },
      {
        id: "last_checked_at",
        header: "Checked",
        width: 112,
        align: "right",
        sortable: true,
        cell: (destination) => (
          <RelativeTime value={destination.last_checked_at} fallback="never" />
        ),
      },
    ],
    [],
  );

  return (
    <>
      <ResourcePage<BackupDestination>
        title="Backups"
        tabs={tabs}
        state={state}
        query={query}
        columns={columns}
        getRowId={(destination) => destination.id}
        tableLabel="Backup destinations"
        searchPlaceholder="Search destinations"
        selectable
        onRowClick={(destination) => can("backups.schedules:write") && setEditing(destination)}
        errorContext="Backup destinations"
        emptyIcon={HardDriveDownload}
        emptyTitle="No backup destinations"
        emptyDescription="A destination is where snapshots are written — an object store, an SFTP host, or a directory on a managed server."
        primaryAction={
          can("backups.schedules:write") && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
              New destination
            </Button>
          )
        }
        emptyAction={
          can("backups.schedules:write") && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
              New destination
            </Button>
          )
        }
        filters={
          <>
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by kind"
              value={state.filters.kind ?? ""}
              onChange={(event) => state.setFilter("kind", event.target.value || null)}
              options={[
                { value: "", label: "Any kind" },
                ...Object.entries(DESTINATION_KIND_LABELS).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by status"
              value={state.filters.status ?? ""}
              onChange={(event) => state.setFilter("status", event.target.value || null)}
              options={[
                { value: "", label: "Any status" },
                { value: "ok", label: "Reachable" },
                { value: "unreachable", label: "Unreachable" },
                { value: "untested", label: "Untested" },
              ]}
            />
          </>
        }
        rowActions={(destination) => [
          {
            id: "test",
            label: "Test connection",
            icon: Plug,
            disabled: !can("backups.schedules:write"),
            onSelect: () => test.mutate([destination.id]),
          },
          {
            id: "schedules",
            label: "Schedules using it",
            icon: Archive,
            onSelect: () => router.push(`/backups?tab=schedules&destination_id=${destination.id}`),
          },
          {
            id: "edit",
            label: "Edit",
            icon: Pencil,
            disabled: !can("backups.schedules:write"),
            onSelect: () => setEditing(destination),
          },
          {
            id: "delete",
            label: "Delete",
            icon: Trash2,
            destructive: true,
            separatorBefore: true,
            disabled: !can("backups.schedules:delete"),
            onSelect: () => setDeleting(destination),
          },
        ]}
        bulkActions={(ids) => (
          <Button
            variant="secondary"
            size="xs"
            icon={Plug}
            loading={test.isPending}
            disabled={!can("backups.schedules:write")}
            onClick={() => test.mutate(ids)}
          >
            Test connection
          </Button>
        )}
      />

      <DestinationDialog open={creating} onOpenChange={setCreating} />
      <DestinationDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        destination={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "destination"}?`}
        description="Kaname forgets where these snapshots live and the credentials that reach them. The data in the destination itself is not touched."
        confirmText={deleting?.name}
        confirmLabel="Delete destination"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Run history
 * ------------------------------------------------------------------ */

function RunsTab({ tabs }: { tabs: React.ReactNode }) {
  const router = useRouter();
  const servers = useServers();
  const state = useResourceListState({
    defaultSort: { id: "started_at", order: "desc" },
    filterKeys: ["status", "trigger", "server_id", "schedule_id"],
  });
  const query = useList<BackupRun>("backups/runs", state.params);

  const columns = React.useMemo<DataTableColumn<BackupRun>[]>(
    () => [
      {
        id: "started_at",
        header: "Started",
        width: 132,
        sortable: true,
        locked: true,
        cell: (run) => <RelativeTime value={run.started_at} />,
      },
      {
        id: "schedule",
        header: "Schedule",
        minWidth: 160,
        cell: (run) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[var(--kn-text)]">{run.schedule_name}</span>
            <MonoText muted truncate className="text-sm">
              {run.server_name}
            </MonoText>
          </div>
        ),
      },
      {
        id: "trigger",
        header: "Trigger",
        width: 96,
        hideBelow: "md",
        cell: (run) => (
          <Badge tone={run.trigger === "manual" ? "info" : "neutral"} size="xs">
            {run.trigger}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Outcome",
        width: 112,
        sortable: true,
        cell: (run) => <RunStatusBadge status={run.status} />,
      },
      {
        id: "bytes",
        header: "Written",
        width: 96,
        align: "right",
        sortable: true,
        cell: (run) => <ByteSize bytes={run.bytes} />,
      },
      {
        id: "files",
        header: "Files",
        width: 88,
        align: "right",
        hideBelow: "lg",
        cell: (run) => <span className="kn-num">{formatCount(run.files)}</span>,
      },
      {
        id: "duration_ms",
        header: "Took",
        width: 88,
        align: "right",
        sortable: true,
        cell: (run) => <Duration ms={run.duration_ms} />,
      },
      {
        id: "error",
        header: "Detail",
        minWidth: 180,
        hideBelow: "lg",
        cell: (run) =>
          run.error ? (
            <span className="truncate text-[var(--kn-danger)]" title={run.error}>
              {run.error}
            </span>
          ) : (
            <span className="text-[var(--kn-text-3)]">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <ResourcePage<BackupRun>
      title="Backups"
      tabs={tabs}
      state={state}
      query={query}
      columns={columns}
      getRowId={(run) => run.id}
      tableLabel="Backup runs"
      searchPlaceholder="Search runs"
      density="compact"
      errorContext="Backup runs"
      emptyIcon={History}
      emptyTitle="No backup runs yet"
      emptyDescription="Every attempt lands here, scheduled or manual, whether it succeeded or not."
      emptyAction={
        <Button variant="primary" size="sm" icon={Archive} onClick={() => router.push("/backups")}>
          Open schedules
        </Button>
      }
      filters={
        <>
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by server"
            value={state.filters.server_id ?? ""}
            onChange={(event) => state.setFilter("server_id", event.target.value || null)}
            options={[
              { value: "", label: "Any server" },
              ...(servers.data?.data ?? []).map((server) => ({
                value: server.id,
                label: server.name,
              })),
            ]}
          />
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by outcome"
            value={state.filters.status ?? ""}
            onChange={(event) => state.setFilter("status", event.target.value || null)}
            options={[{ value: "", label: "Any outcome" }, ...RUN_STATUS_OPTIONS]}
          />
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by trigger"
            value={state.filters.trigger ?? ""}
            onChange={(event) => state.setFilter("trigger", event.target.value || null)}
            options={[
              { value: "", label: "Any trigger" },
              { value: "scheduled", label: "Scheduled" },
              { value: "manual", label: "Manual" },
            ]}
          />
        </>
      }
      rowActions={(run) => [
        {
          id: "job",
          label: "Open job",
          icon: History,
          onSelect: () => router.push(`/jobs/${run.job_id}`),
        },
        {
          id: "schedule",
          label: "Open schedule",
          icon: Archive,
          onSelect: () => router.push(`/backups/${run.schedule_id}`),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Restore points
 * ------------------------------------------------------------------ */

function RestorePointsTab({ tabs }: { tabs: React.ReactNode }) {
  const can = useCan();
  const servers = useServers();
  const state = useResourceListState({
    defaultSort: { id: "taken_at", order: "desc" },
    filterKeys: ["server_id", "scope_kind", "verified"],
  });
  const query = useList<RestorePoint>("backups/restore-points", state.params);

  const [restoring, setRestoring] = React.useState<RestorePoint | null>(null);

  const verify = useMutationWithJob<string[]>({
    mutationFn: async (ids) => ({
      jobs: await Promise.all(
        ids.map((id) =>
          api
            .post<{ job: Job }>(`/backups/restore-points/${id}/verify`)
            .then((response) => response.job),
        ),
      ),
      correlation_id: ids.join(","),
    }),
    invalidates: ["backups/restore-points"],
  });

  const columns = React.useMemo<DataTableColumn<RestorePoint>[]>(
    () => [
      {
        id: "label",
        header: "Restore point",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 200,
        accessor: (point) => point.label,
      },
      {
        id: "server",
        header: "From",
        width: 140,
        mono: true,
        accessor: (point) => point.server_name,
      },
      {
        id: "taken_at",
        header: "Taken",
        width: 120,
        sortable: true,
        cell: (point) => <RelativeTime value={point.taken_at} />,
      },
      {
        id: "scope",
        header: "Scope",
        minWidth: 160,
        hideBelow: "lg",
        accessor: (point) => describeScope(point.scope),
      },
      {
        id: "bytes",
        header: "Size",
        width: 96,
        align: "right",
        sortable: true,
        cell: (point) => <ByteSize bytes={point.bytes} />,
      },
      {
        id: "file_count",
        header: "Files",
        width: 88,
        align: "right",
        hideBelow: "lg",
        cell: (point) => <span className="kn-num">{formatCount(point.file_count)}</span>,
      },
      {
        id: "verified_at",
        header: "Verified",
        width: 120,
        sortable: true,
        cell: (point) =>
          point.verified_at ? (
            <span className="flex items-center gap-1.5 text-[var(--kn-ok)]">
              <BadgeCheck size={12} aria-hidden />
              <RelativeTime value={point.verified_at} className="text-[var(--kn-text-2)]" />
            </span>
          ) : (
            <Badge tone="warn" size="xs">
              unverified
            </Badge>
          ),
      },
      {
        id: "expires_at",
        header: "Pruned",
        width: 104,
        align: "right",
        hideBelow: "lg",
        cell: (point) => <RelativeTime value={point.expires_at} fallback="pinned" />,
      },
    ],
    [],
  );

  return (
    <>
      <ResourcePage<RestorePoint>
        title="Backups"
        tabs={tabs}
        state={state}
        query={query}
        columns={columns}
        getRowId={(point) => point.id}
        tableLabel="Restore points"
        searchPlaceholder="Search restore points"
        density="compact"
        selectable
        errorContext="Restore points"
        emptyIcon={ShieldCheck}
        emptyTitle="No restore points"
        emptyDescription="A successful run leaves one behind. Until then there is nothing to restore from."
        emptyAction={
          <Link
            href="/backups?tab=schedules"
            className="text-[var(--kn-accent-400)] outline-none hover:underline"
          >
            Open schedules
          </Link>
        }
        filters={
          <>
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by server"
              value={state.filters.server_id ?? ""}
              onChange={(event) => state.setFilter("server_id", event.target.value || null)}
              options={[
                { value: "", label: "Any server" },
                ...(servers.data?.data ?? []).map((server) => ({
                  value: server.id,
                  label: server.name,
                })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by scope"
              value={state.filters.scope_kind ?? ""}
              onChange={(event) => state.setFilter("scope_kind", event.target.value || null)}
              options={[
                { value: "", label: "Any scope" },
                ...Object.entries(SCOPE_KIND_LABELS).map(([value, label]) => ({ value, label })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by verification"
              value={state.filters.verified ?? ""}
              onChange={(event) => state.setFilter("verified", event.target.value || null)}
              options={[
                { value: "", label: "Verified and not" },
                { value: "true", label: "Verified" },
                { value: "false", label: "Unverified" },
              ]}
            />
          </>
        }
        rowActions={(point) => [
          {
            id: "verify",
            label: "Verify",
            icon: BadgeCheck,
            disabled: !can("backups.schedules:read", point.server_id),
            onSelect: () => verify.mutate([point.id]),
          },
          {
            id: "restore",
            label: "Restore…",
            icon: RotateCcw,
            destructive: true,
            separatorBefore: true,
            disabled: !can("backups.restore:exec", point.server_id),
            onSelect: () => setRestoring(point),
          },
        ]}
        bulkActions={(ids) => (
          <Button
            variant="secondary"
            size="xs"
            icon={BadgeCheck}
            onClick={() => verify.mutate(ids)}
          >
            Verify
          </Button>
        )}
      />

      <RestoreDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        point={restoring}
        servers={servers.data?.data ?? []}
      />
    </>
  );
}
