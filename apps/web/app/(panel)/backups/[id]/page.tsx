"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Archive,
  BadgeCheck,
  ChevronRight,
  History,
  Pencil,
  Play,
  Power,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { BackupRun, BackupSchedule, Job, RestorePoint } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  ConfirmDialog,
  DataTable,
  DetailLayout,
  Duration,
  EmptyState,
  IconButton,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Skeleton,
  type DataTableColumn,
} from "@kaname/ui";
import {
  RestoreDialog,
  RunStatusBadge,
  ScheduleDialog,
  describeRetention,
  describeScope,
} from "@/components/BackupForms";
import { PageError } from "@/components/PageError";
import { api } from "@/lib/api";
import { describeCron } from "@/lib/cron";
import { formatCount } from "@/lib/format";
import {
  useCan,
  useList,
  useMutationWithJob,
  useResource,
  useResourceMutation,
  useServers,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * One backup schedule.
 *
 * The question this page answers is "is this schedule actually
 * protecting anything", which is not the same as "is it enabled". So
 * the run history and the restore points it produced sit on the page
 * itself rather than behind a tab: a schedule that has been enabled for
 * a month and has produced nothing should be obvious at a glance.
 * ------------------------------------------------------------------ */

const RUN_PAGE_SIZE = 20;
const POINT_PAGE_SIZE = 20;

export default function BackupSchedulePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const can = useCan();

  const schedule = useResource<BackupSchedule>("backups/schedules", id, {
    path: `/backups/schedules/${id}`,
  });
  const servers = useServers();

  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [restoring, setRestoring] = React.useState<RestorePoint | null>(null);

  const row = schedule.data;
  const server = servers.data?.data.find((candidate) => candidate.id === row?.server_id) ?? null;
  const writable = can("backups.schedules:write", row?.server_id);

  const runNow = useMutationWithJob<void>({
    mutationFn: () => api.post<{ job: Job }>(`/backups/schedules/${id}/run`),
    invalidates: ["backups/schedules", "backups/runs", "backups/restore-points"],
  });

  const setEnabled = useResourceMutation<boolean, BackupSchedule>({
    mutationFn: (enabled) => api.patch<BackupSchedule>(`/backups/schedules/${id}`, { enabled }),
    invalidates: ["backups/schedules"],
    successMessage: (result) => `Schedule ${result.enabled ? "enabled" : "disabled"}.`,
  });

  const remove = useResourceMutation<void, void>({
    mutationFn: () => api.del(`/backups/schedules/${id}`),
    invalidates: ["backups/schedules"],
    successMessage: () => `Schedule "${row?.name ?? ""}" deleted.`,
    onDone: () => router.push("/backups"),
  });

  if (schedule.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceHeader name="Backup schedule" breadcrumb={<Breadcrumb />} />
        <div className="px-6 py-4">
          <PageError
            error={schedule.error}
            onRetry={() => void schedule.refetch()}
            context="Backup schedule"
          />
        </div>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceHeader name={<Skeleton className="h-6 w-48" label="Loading schedule" />} />
        <div className="grid grid-cols-1 gap-4 px-6 py-4 lg:grid-cols-[minmax(0,1fr)_288px]">
          <Skeleton className="h-64 rounded-[var(--kn-r-md)]" />
          <Skeleton className="h-64 rounded-[var(--kn-r-md)]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResourceHeader
        name={row.name}
        breadcrumb={<Breadcrumb name={row.name} />}
        identity={`${row.server_name} → ${row.destination_name}`}
        connection={server?.connection}
        lastSeenAt={server?.last_seen_at ?? null}
        health={server?.health}
        healthReasons={server?.health_reasons}
        badges={
          <>
            <RunStatusBadge status={row.last_run_status} />
            {!row.enabled && (
              <Badge tone="warn" size="sm">
                disabled
              </Badge>
            )}
            {row.encryption && (
              <Badge tone="neutral" size="sm">
                encrypted
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="primary"
              size="sm"
              icon={Play}
              disabled={!writable}
              loading={runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              Run now
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Power}
              disabled={!writable}
              onClick={() => setEnabled.mutate(!row.enabled)}
            >
              {row.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Pencil}
              disabled={!writable}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <IconButton
              icon={Trash2}
              label="Delete schedule"
              size="sm"
              variant="danger-subtle"
              disabled={!can("backups.schedules:delete", row.server_id)}
              onClick={() => setDeleting(true)}
            />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <DetailLayout
          rail={
            <SectionCard title="Configuration" icon={Archive}>
              <PropertyList dense labelWidth="sm">
                <PropertyRow label="Server" mono copyValue={row.server_name}>
                  <Link
                    href={`/infrastructure/servers/${row.server_id}`}
                    className="text-[var(--kn-accent-400)] outline-none hover:underline"
                  >
                    {row.server_name}
                  </Link>
                </PropertyRow>
                <PropertyRow label="Destination">
                  <Link
                    href={`/backups?tab=destinations&q=${encodeURIComponent(row.destination_name)}`}
                    className="text-[var(--kn-accent-400)] outline-none hover:underline"
                  >
                    {row.destination_name}
                  </Link>
                </PropertyRow>
                <PropertyRow label="Runs" hint="The cron expression this schedule is stored with">
                  {describeCron(row.cron, row.timezone)}
                </PropertyRow>
                <PropertyRow label="Expression" mono copyValue={row.cron}>
                  {row.cron}
                </PropertyRow>
                <PropertyRow label="Scope">{describeScope(row.scope)}</PropertyRow>
                <PropertyRow label="Retention">{describeRetention(row.retention)}</PropertyRow>
                <PropertyRow
                  label="Encryption"
                  hint="Kaname holds the repository password; restores go through the panel"
                >
                  {row.encryption ? "On" : "Off"}
                </PropertyRow>
                <PropertyRow label="Last run">
                  <RelativeTime value={row.last_run_at} fallback="never" />
                </PropertyRow>
                <PropertyRow label="Next run">
                  {row.enabled ? (
                    <RelativeTime value={row.next_run_at} fallback="not scheduled" />
                  ) : (
                    "disabled"
                  )}
                </PropertyRow>
                <PropertyRow label="Created">
                  <RelativeTime value={row.created_at} />
                </PropertyRow>
              </PropertyList>
            </SectionCard>
          }
        >
          <RunHistory scheduleId={id} />
          <RestorePoints
            scheduleId={id}
            canRestore={can("backups.restore:exec", row.server_id)}
            canVerify={can("backups.schedules:read", row.server_id)}
            onRestore={setRestoring}
          />
        </DetailLayout>
      </div>

      <ScheduleDialog open={editing} onOpenChange={setEditing} schedule={row} />
      <RestoreDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        point={restoring}
        servers={servers.data?.data ?? []}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${row.name}?`}
        description="Snapshots already in the destination are untouched — but Kaname loses the repository password with the schedule, so encrypted snapshots become unreadable from the panel."
        confirmText={row.name}
        confirmLabel="Delete schedule"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function Breadcrumb({ name }: { name?: string }) {
  return (
    <nav className="flex items-center gap-1.5" aria-label="Breadcrumb">
      <Link href="/backups" className="text-[var(--kn-text-2)] outline-none hover:underline">
        Backups
      </Link>
      <ChevronRight size={12} className="text-[var(--kn-text-3)]" aria-hidden />
      <span className="text-[var(--kn-text-2)]">{name ?? "Schedule"}</span>
    </nav>
  );
}

/* ---------------------------- run history --------------------------- */

function RunHistory({ scheduleId }: { scheduleId: string }) {
  const router = useRouter();
  const query = useList<BackupRun>("backups/runs", {
    schedule_id: scheduleId,
    per_page: RUN_PAGE_SIZE,
    sort: "started_at",
    order: "desc",
  });

  const columns = React.useMemo<DataTableColumn<BackupRun>[]>(
    () => [
      {
        id: "started_at",
        header: "Started",
        width: 132,
        locked: true,
        cell: (run) => <RelativeTime value={run.started_at} />,
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
        cell: (run) => <RunStatusBadge status={run.status} />,
      },
      {
        id: "bytes",
        header: "Written",
        width: 96,
        align: "right",
        cell: (run) => <ByteSize bytes={run.bytes} />,
      },
      {
        id: "files",
        header: "Files",
        width: 80,
        align: "right",
        hideBelow: "lg",
        cell: (run) => <span className="kn-num">{formatCount(run.files)}</span>,
      },
      {
        id: "duration_ms",
        header: "Took",
        width: 88,
        align: "right",
        cell: (run) => <Duration ms={run.duration_ms} />,
      },
      {
        id: "error",
        header: "Detail",
        minWidth: 160,
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
    <SectionCard
      title="Run history"
      icon={History}
      padded={false}
      actions={
        <Link
          href={`/backups?tab=runs&schedule_id=${scheduleId}`}
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          All runs
        </Link>
      }
    >
      <DataTable<BackupRun>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(run) => run.id}
        label="Run history"
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={5}
        onRowClick={(run) => router.push(`/jobs/${run.job_id}`)}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Run history"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={History}
            title="This schedule has never run"
            description="Run it once now to prove the destination accepts writes, rather than finding out at 03:00."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

/* --------------------------- restore points ------------------------- */

interface RestorePointsProps {
  scheduleId: string;
  canRestore: boolean;
  canVerify: boolean;
  onRestore: (point: RestorePoint) => void;
}

function RestorePoints({ scheduleId, canRestore, canVerify, onRestore }: RestorePointsProps) {
  const query = useList<RestorePoint>("backups/restore-points", {
    schedule_id: scheduleId,
    per_page: POINT_PAGE_SIZE,
    sort: "taken_at",
    order: "desc",
  });

  const verify = useMutationWithJob<string>({
    mutationFn: (id) => api.post<{ job: Job }>(`/backups/restore-points/${id}/verify`),
    invalidates: ["backups/restore-points"],
  });

  const columns = React.useMemo<DataTableColumn<RestorePoint>[]>(
    () => [
      {
        id: "label",
        header: "Restore point",
        locked: true,
        mono: true,
        minWidth: 180,
        accessor: (point) => point.label,
      },
      {
        id: "taken_at",
        header: "Taken",
        width: 120,
        cell: (point) => <RelativeTime value={point.taken_at} />,
      },
      {
        id: "bytes",
        header: "Size",
        width: 96,
        align: "right",
        cell: (point) => <ByteSize bytes={point.bytes} />,
      },
      {
        id: "file_count",
        header: "Files",
        width: 80,
        align: "right",
        hideBelow: "lg",
        cell: (point) => <span className="kn-num">{formatCount(point.file_count)}</span>,
      },
      {
        id: "verified_at",
        header: "Verified",
        width: 120,
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
    <SectionCard
      title="Restore points"
      icon={ShieldCheck}
      padded={false}
      actions={
        <Link
          href={`/backups?tab=restore-points&schedule_id=${scheduleId}`}
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          All restore points
        </Link>
      }
    >
      <DataTable<RestorePoint>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(point) => point.id}
        label="Restore points"
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={5}
        rowActions={(point) => [
          {
            id: "verify",
            label: "Verify",
            icon: BadgeCheck,
            disabled: !canVerify,
            onSelect: () => verify.mutate(point.id),
          },
          {
            id: "restore",
            label: "Restore…",
            icon: RotateCcw,
            destructive: true,
            separatorBefore: true,
            disabled: !canRestore,
            onSelect: () => onRestore(point),
          },
        ]}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Restore points"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={ShieldCheck}
            title="Nothing to restore from yet"
            description="A successful run leaves a restore point here. Until one does, this schedule is not protecting anything."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}
