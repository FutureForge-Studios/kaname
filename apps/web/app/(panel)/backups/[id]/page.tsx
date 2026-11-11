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
  Card,
  CardInset,
  ConfirmDialog,
  DataTable,
  DetailLayout,
  Duration,
  EmptyState,
  IconButton,
  LeaderLabel,
  MonoLabel,
  NumberedSection,
  PageBody,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Skeleton,
  StatusLine,
  cn,
  formatBytes,
  type DataTableColumn,
  type Tone,
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
import { formatCount, formatDateTime } from "@/lib/format";
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

      <PageBody gap="md">
        <ScheduleStatus schedule={row} />

        <DetailLayout
          rail={
            <SectionCard title="Configuration" icon={Archive} headingLevel={3}>
              <div className="flex flex-col gap-4">
                <ConfigGroup index={1} label="What">
                  <PropertyRow label="Server" mono copyValue={row.server_name}>
                    <Link
                      href={`/infrastructure/servers/${row.server_id}`}
                      className="text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
                    >
                      {row.server_name}
                    </Link>
                  </PropertyRow>
                  <PropertyRow label="Scope">{describeScope(row.scope)}</PropertyRow>
                </ConfigGroup>
                <ConfigGroup index={2} label="Where">
                  <PropertyRow label="Destination">
                    <Link
                      href={`/backups?tab=destinations&q=${encodeURIComponent(row.destination_name)}`}
                      className="text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
                    >
                      {row.destination_name}
                    </Link>
                  </PropertyRow>
                  <PropertyRow
                    label="Encryption"
                    hint="Kaname holds the repository password; restores go through the panel"
                  >
                    {row.encryption ? "On" : "Off"}
                  </PropertyRow>
                </ConfigGroup>
                <ConfigGroup index={3} label="When">
                  <PropertyRow label="Runs" hint="The cron expression this schedule is stored with">
                    {describeCron(row.cron, row.timezone)}
                  </PropertyRow>
                  <PropertyRow label="Expression" mono copyValue={row.cron}>
                    {row.cron}
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
                </ConfigGroup>
                <ConfigGroup index={4} label="Retention">
                  <PropertyRow label="Keeps">{describeRetention(row.retention)}</PropertyRow>
                  <PropertyRow label="Created">
                    <RelativeTime value={row.created_at} />
                  </PropertyRow>
                </ConfigGroup>
              </div>
            </SectionCard>
          }
        >
          <div className="flex min-w-0 flex-col gap-8">
            <RunHistory scheduleId={id} />
            <RestorePoints
              scheduleId={id}
              canRestore={can("backups.restore:exec", row.server_id)}
              canVerify={can("backups.schedules:read", row.server_id)}
              onRestore={setRestoring}
            />
          </div>
        </DetailLayout>
      </PageBody>

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

/** The schedule's condition as one sentence: the last outcome and what comes next. */
function ScheduleStatus({ schedule }: { schedule: BackupSchedule }) {
  const next = schedule.enabled ? (
    <>
      next run <RelativeTime value={schedule.next_run_at} fallback="not scheduled" />
    </>
  ) : (
    "disabled, so nothing runs until it is enabled again"
  );

  if (schedule.last_run_status === null) {
    return (
      <StatusLine tone="warn">
        Never run — this schedule is not protecting anything yet · {next}
      </StatusLine>
    );
  }

  const tone: Tone = !schedule.enabled
    ? "warn"
    : schedule.last_run_status === "failed"
      ? "danger"
      : schedule.last_run_status === "partial"
        ? "warn"
        : schedule.last_run_status === "running"
          ? "info"
          : "ok";

  return (
    <StatusLine tone={tone} pulse={schedule.last_run_status === "running"}>
      Last run {schedule.last_run_status} <RelativeTime value={schedule.last_run_at} /> · {next}
    </StatusLine>
  );
}

function ConfigGroup({
  index,
  label,
  children,
}: {
  index: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <LeaderLabel index={index}>{label}</LeaderLabel>
      <PropertyList dense labelWidth="sm">
        {children}
      </PropertyList>
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

  const runs = query.data?.data ?? [];

  return (
    <NumberedSection
      index={1}
      title="Run history"
      caption={`The last ${RUN_PAGE_SIZE} attempts, scheduled or manual.`}
      actions={
        <Link
          href={`/backups?tab=runs&schedule_id=${scheduleId}`}
          className="kn-label-sm rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
        >
          All runs
        </Link>
      }
    >
      {runs.length > 0 && <RunTimeline runs={runs} />}
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
      />
    </NumberedSection>
  );
}

/* ---------------------------- run timeline -------------------------- */

const RUN_BAR_FILLS: Record<BackupRun["status"], string> = {
  succeeded: "bg-[var(--kn-ok)]",
  partial: "bg-[var(--kn-warn)]",
  failed: "bg-[var(--kn-danger)]",
  running: "bg-[var(--kn-info)]",
  queued: "bg-[var(--kn-text-3)]",
  cancelled: "bg-[var(--kn-text-3)]",
};

/*
 * The runs as a strip, oldest on the left: one bar per attempt, its
 * height the bytes written relative to the largest, its colour the
 * outcome. A run that wrote nothing still gets a short bar so a failure
 * is a red mark rather than a gap. Each bar opens the run's job.
 */
function RunTimeline({ runs }: { runs: readonly BackupRun[] }) {
  const ordered = [...runs].reverse();
  const max = Math.max(1, ...ordered.map((run) => run.bytes ?? 0));
  const tally = ordered.reduce<Partial<Record<BackupRun["status"], number>>>((acc, run) => {
    acc[run.status] = (acc[run.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <CardInset grid padding="none" className="px-3 pb-2 pt-3">
        <ol
          aria-label="Run timeline, oldest first"
          className="m-0 flex h-24 list-none items-end justify-end gap-1.5 p-0"
        >
          {ordered.map((run) => {
            const height = Math.max(6, Math.round(((run.bytes ?? 0) / max) * 100));
            const label = `${run.status}, ${run.trigger}, started ${formatDateTime(run.started_at)}, wrote ${formatBytes(run.bytes ?? 0)}`;
            return (
              <li key={run.id} className="flex h-full min-w-0 max-w-6 flex-1 items-end">
                <Link
                  href={`/jobs/${run.job_id}`}
                  aria-label={label}
                  title={run.error ? `${label} — ${run.error}` : label}
                  className={cn(
                    "block w-full rounded-t-[var(--kn-r-xs)] opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
                    RUN_BAR_FILLS[run.status],
                  )}
                  style={{ height: `${height}%` }}
                />
              </li>
            );
          })}
        </ol>
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--kn-border)] pt-1.5">
          <MonoLabel size="xs">
            <RelativeTime value={ordered[0]!.started_at} />
          </MonoLabel>
          <MonoLabel size="xs">Latest</MonoLabel>
        </div>
      </CardInset>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {(Object.keys(RUN_BAR_FILLS) as BackupRun["status"][])
          .filter((status) => tally[status])
          .map((status) => (
            <span
              key={status}
              className="flex items-center gap-1.5 text-sm text-[var(--kn-text-2)]"
            >
              <span aria-hidden className={cn("size-2 rounded-xs", RUN_BAR_FILLS[status])} />
              <span className="kn-num">{formatCount(tally[status]!)}</span> {status}
            </span>
          ))}
        <span className="ml-auto text-sm text-[var(--kn-text-3)]">
          Bar height is bytes written.
        </span>
      </div>
    </Card>
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
    <NumberedSection
      index={2}
      title="Restore points"
      caption="What a successful run leaves behind."
      actions={
        <Link
          href={`/backups?tab=restore-points&schedule_id=${scheduleId}`}
          className="kn-label-sm rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
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
      />
    </NumberedSection>
  );
}
