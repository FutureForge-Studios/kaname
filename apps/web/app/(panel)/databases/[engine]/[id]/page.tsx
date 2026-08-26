"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  Database as DatabaseIcon,
  Download,
  Gauge,
  KeyRound,
  Table2,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import type { Database, DbInstance, DbUser, Job, Server } from "@kaname/contract";
import {
  AreaChart,
  Badge,
  Button,
  ByteSize,
  ConfirmDialog,
  CopyableCode,
  DataTable,
  DetailLayout,
  Duration,
  EmptyState,
  JobStatusPill,
  MetricTile,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Skeleton,
  StatusBadge,
  formatBytes,
  type DataTableColumn,
} from "@kaname/ui";
import {
  DumpDialog,
  RestoreDialog,
  connectionTemplate,
  engineMeta,
  isEngineGroup,
  type DatabaseEngineGroup,
} from "@/components/DatabaseSection";
import { PageError } from "@/components/PageError";
import { api, type ApiError, type ListResult } from "@/lib/api";
import { queryKeys, useCan, useList, useMutationWithJob, useResource } from "@/lib/queries";
import { formatCount, formatDateTime, humanize } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * One database.
 *
 * Kaname does not keep a size history — the schema stores a single
 * `size_bytes` per row — so the chart below plots the samples this
 * session has actually taken, starting from the cached one, and says
 * so. A chart that implied a history the panel does not have would be
 * the same lie as a spinner that implies a restart happened.
 * ------------------------------------------------------------------ */

interface SizeSample {
  database_id: string;
  name: string;
  engine: string;
  size_bytes: number;
  table_count: number;
  sampled_at: string;
}

export default function DatabaseDetailPage() {
  const params = useParams<{ engine: string; id: string }>();
  const router = useRouter();
  const can = useCan();

  const group: DatabaseEngineGroup = isEngineGroup(params.engine) ? params.engine : "mysql";
  const meta = engineMeta(group);
  const id = params.id;

  const database = useResource<Database>("databases", id);
  const row = database.data ?? null;

  const server = useResource<Server>("servers", row?.server_id);
  const instance = useResource<DbInstance>("db-instances", row?.instance_id);

  const users = useList<DbUser>(
    "db-users",
    { database_id: id, per_page: 100, sort: "username", order: "asc" },
    { enabled: Boolean(row) },
  );

  const dumps = useList<Job>(
    "jobs",
    { type: "db.dump", server_id: row?.server_id, per_page: 100 },
    { enabled: Boolean(row) },
  );
  const restores = useList<Job>(
    "jobs",
    { type: "db.restore", server_id: row?.server_id, per_page: 100 },
    { enabled: Boolean(row) },
  );

  const [dumping, setDumping] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);
  const [samples, setSamples] = React.useState<SizeSample[]>([]);

  /* The cached row is a real observation with a real timestamp, so it is
   * the first point rather than a synthetic zero. */
  React.useEffect(() => {
    if (!row) return;
    setSamples((previous) =>
      previous.length > 0
        ? previous
        : [
            {
              database_id: row.id,
              name: row.name,
              engine: row.engine,
              size_bytes: row.size_bytes,
              table_count: row.table_count,
              sampled_at: row.last_synced_at,
            },
          ],
    );
  }, [row]);

  const sample = useQuery<SizeSample, Error>({
    queryKey: queryKeys.sub("databases", id, "size"),
    queryFn: ({ signal }) => api.get<SizeSample>(`/databases/${id}/size`, { signal }),
    enabled: false,
    staleTime: 0,
  });

  const takeSample = React.useCallback(() => {
    void sample.refetch().then((result) => {
      const next = result.data;
      if (!next) return;
      setSamples((previous) =>
        previous.some((entry) => entry.sampled_at === next.sampled_at)
          ? previous
          : [...previous, next],
      );
    });
  }, [sample]);

  const dumpDatabase = useMutationWithJob<{ destination: string; compress: boolean }>({
    mutationFn: (body) => api.post<{ job: Job }>(`/databases/${id}/dump`, body),
    invalidates: ["databases", "jobs"],
    describe: () => `Dump ${row?.name ?? "database"}`,
    onQueued: () => setDumping(false),
  });

  const restoreDatabase = useMutationWithJob<{ source: string; dropExisting: boolean }>({
    mutationFn: ({ source, dropExisting }) =>
      api.post<{ job: Job }>(`/databases/${id}/restore`, {
        source,
        database_name: row?.name,
        confirm_name: row?.name,
        drop_existing: dropExisting,
      }),
    invalidates: ["databases", "jobs"],
    describe: () => `Restore ${row?.name ?? "database"}`,
    onQueued: () => setRestoring(false),
  });

  const dropDatabase = useMutationWithJob<void>({
    mutationFn: () => api.del<{ job: Job }>(`/databases/${id}`),
    invalidates: ["databases", "db-users", "db-instances"],
    describe: () => `Drop ${row?.name ?? "database"}`,
    onQueued: () => {
      setDropping(false);
      router.push(`/databases/${group}`);
    },
  });

  if (database.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceHeader name="Database" breadcrumb={<Breadcrumb group={group} meta={meta} />} />
        <div className="px-6 py-4">
          <PageError
            error={database.error}
            onRetry={() => void database.refetch()}
            context="Database"
          />
        </div>
      </div>
    );
  }

  if (!row) {
    return <DetailSkeleton group={group} />;
  }

  const mayWrite = can(meta.write, row.server_id);
  const mayDelete = can(meta.delete, row.server_id);
  const history = [...(dumps.data?.data ?? []), ...(restores.data?.data ?? [])]
    .filter((job) => job.target_id === row.id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResourceHeader
        name={row.name}
        identity={
          instance.data
            ? connectionTemplate(meta, instance.data.host, instance.data.port, row.name)
            : `${row.engine} · ${row.server_name}`
        }
        breadcrumb={<Breadcrumb group={group} meta={meta} name={row.name} />}
        connection={server.data?.connection}
        lastSeenAt={server.data?.last_seen_at}
        health={server.data?.health}
        healthReasons={server.data?.health_reasons}
        badges={
          <>
            <Badge tone="neutral" size="sm" mono>
              {row.engine}
            </Badge>
            {row.last_backup_at === null && (
              <StatusBadge tone="warn" size="sm">
                never backed up
              </StatusBadge>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              disabled={!can(meta.read, row.server_id)}
              onClick={() => setDumping(true)}
            >
              Dump
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Upload}
              disabled={!mayWrite}
              onClick={() => setRestoring(true)}
            >
              Restore
            </Button>
            <Button
              variant="danger-subtle"
              size="sm"
              icon={Trash2}
              disabled={!mayDelete}
              onClick={() => setDropping(true)}
            >
              Drop
            </Button>
          </>
        }
      />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricTile
            size="sm"
            icon={Gauge}
            label="Size"
            value={<ByteSize bytes={latest(samples)?.size_bytes ?? row.size_bytes} />}
          />
          <MetricTile
            size="sm"
            icon={Table2}
            label="Tables"
            value={formatCount(latest(samples)?.table_count ?? row.table_count)}
          />
          <MetricTile size="sm" icon={Users} label="Users" value={formatCount(row.users.length)} />
          <MetricTile
            size="sm"
            icon={Archive}
            label="Last backup"
            value={row.last_backup_at ? formatDateTime(row.last_backup_at) : "never"}
            tone={row.last_backup_at ? "neutral" : "warn"}
          />
        </div>

        <DetailLayout
          rail={
            <SectionCard title="Details" icon={DatabaseIcon} headingLevel={3}>
              <PropertyList dense labelWidth="sm">
                <PropertyRow label="Engine" mono>
                  {row.engine}
                </PropertyRow>
                <PropertyRow label="Instance" mono>
                  {instance.data ? `${instance.data.host}:${instance.data.port}` : "—"}
                </PropertyRow>
                <PropertyRow label="Server">
                  <Link
                    href={`/infrastructure/servers/${row.server_id}`}
                    className="text-[var(--kn-accent-400)] hover:underline"
                  >
                    {row.server_name}
                  </Link>
                </PropertyRow>
                <PropertyRow label={meta.ownerLabel} mono>
                  {row.owner}
                </PropertyRow>
                <PropertyRow label="Encoding" mono>
                  {row.encoding}
                </PropertyRow>
                <PropertyRow label="Collation" mono>
                  {row.collation}
                </PropertyRow>
                <PropertyRow label="Created">
                  <RelativeTime value={row.created_at} />
                </PropertyRow>
                <PropertyRow label="Synced" hint="How stale the cached row is.">
                  <RelativeTime value={row.last_synced_at} />
                </PropertyRow>
              </PropertyList>
            </SectionCard>
          }
        >
          <SizeCard
            samples={samples}
            sampling={sample.isFetching}
            error={sample.error}
            onSample={takeSample}
          />

          <SectionCard
            title="Users granted on this database"
            icon={KeyRound}
            padded={false}
            headingLevel={3}
          >
            <GrantedUsers query={users} hostPatterns={meta.hostPatterns} />
          </SectionCard>

          <SectionCard
            title="Backup history"
            icon={Archive}
            padded={false}
            headingLevel={3}
            footer={
              <>
                Dump and restore jobs recorded for this database. Scheduled backups that include it
                are listed under{" "}
                <Link href="/backups" className="text-[var(--kn-accent-400)] hover:underline">
                  Backups
                </Link>
                .
              </>
            }
          >
            <BackupHistory
              rows={history}
              loading={dumps.isLoading || restores.isLoading}
              error={dumps.error ?? restores.error}
              onRetry={() => {
                void dumps.refetch();
                void restores.refetch();
              }}
            />
          </SectionCard>

          <SectionCard title="Connection" icon={KeyRound} headingLevel={3}>
            <CopyableCode
              value={
                instance.data
                  ? connectionTemplate(meta, instance.data.host, instance.data.port, row.name)
                  : row.connection_string_template
              }
              label={`${row.engine} · ${row.name}`}
              block
            />
            <p className="mt-2 text-[var(--kn-text-2)]">
              The password placeholder is deliberate. Stored credentials are envelope-encrypted and
              are never read back into the panel; rotate a user&apos;s password to be shown a new
              one once.
            </p>
          </SectionCard>
        </DetailLayout>
      </div>

      <DumpDialog
        database={dumping ? row : null}
        meta={meta}
        pending={dumpDatabase.isPending}
        onClose={() => setDumping(false)}
        onSubmit={(destination, compress) => dumpDatabase.mutate({ destination, compress })}
      />

      <RestoreDialog
        database={restoring ? row : null}
        meta={meta}
        pending={restoreDatabase.isPending}
        onClose={() => setRestoring(false)}
        onSubmit={(source, dropExisting) => restoreDatabase.mutate({ source, dropExisting })}
      />

      <ConfirmDialog
        open={dropping}
        onOpenChange={setDropping}
        title={`Drop ${row.name}?`}
        description={`Every table, row and index in ${row.name} on ${row.server_name} is destroyed. Kaname cannot undo this; only a restore from a dump can.`}
        confirmText={row.name}
        confirmLabel="Drop database"
        loading={dropDatabase.isPending}
        onConfirm={() => dropDatabase.mutate()}
      >
        {row.last_backup_at === null && (
          <p className="text-[var(--kn-warn)]">This database has never been backed up by Kaname.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function latest(samples: SizeSample[]): SizeSample | undefined {
  return samples[samples.length - 1];
}

function Breadcrumb({
  group,
  meta,
  name,
}: {
  group: DatabaseEngineGroup;
  meta: ReturnType<typeof engineMeta>;
  name?: string;
}) {
  return (
    <>
      <Link href={`/databases/${group}`} className="hover:text-[var(--kn-text)]">
        {meta.title}
      </Link>
      {name && (
        <>
          <ChevronRight size={12} className="mx-1 text-[var(--kn-text-3)]" aria-hidden />
          <MonoText>{name}</MonoText>
        </>
      )}
    </>
  );
}

function DetailSkeleton({ group }: { group: DatabaseEngineGroup }) {
  const meta = engineMeta(group);
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy>
      <div className="border-b border-[var(--kn-border)] px-6 pb-4 pt-4">
        <Skeleton className="h-3 w-40" label={`Loading ${meta.title} database`} />
        <Skeleton className="mt-2 h-6 w-64" />
        <Skeleton className="mt-2 h-3 w-96" />
      </div>
      <div className="flex flex-col gap-4 px-6 py-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16 rounded-[var(--kn-r-md)]" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-[var(--kn-r-md)]" />
        <Skeleton className="h-40 rounded-[var(--kn-r-md)]" />
      </div>
    </div>
  );
}

/* ------------------------------ size -------------------------------- */

interface SizeCardProps {
  samples: SizeSample[];
  sampling: boolean;
  error: Error | null;
  onSample: () => void;
}

function SizeCard({ samples, sampling, error, onSample }: SizeCardProps) {
  const series = [
    {
      id: "size",
      label: "Size on disk",
      data: samples.map((entry) => ({ x: Date.parse(entry.sampled_at), y: entry.size_bytes })),
    },
  ];

  return (
    <SectionCard
      title="Size and tables"
      icon={Gauge}
      headingLevel={3}
      actions={
        <Button variant="secondary" size="xs" loading={sampling} onClick={onSample}>
          Sample now
        </Button>
      }
      footer={
        <>
          Kaname stores one current size per database, not a history. These are the samples read
          from the engine since this page opened — the first is the cached value and its own
          timestamp. Each sample is a live read on the host.
        </>
      }
    >
      {error && <PageError error={error} onRetry={onSample} context="Size" className="mb-3" />}

      {samples.length < 2 ? (
        <EmptyState
          icon={Gauge}
          title={
            samples.length === 0
              ? "No sample yet"
              : `One sample: ${formatBytes(samples[0]!.size_bytes)} across ${formatCount(samples[0]!.table_count)} tables`
          }
          description="Take a second sample to see movement. Nothing is plotted from a single point."
          action={
            <Button variant="secondary" size="sm" loading={sampling} onClick={onSample}>
              Sample now
            </Button>
          }
          size="sm"
        />
      ) : (
        <>
          <AreaChart
            series={series}
            title={`Size of this database across ${samples.length} samples`}
            height={180}
            formatValue={(value) => formatBytes(value, "binary", 1)}
            emptyLabel="No samples yet"
          />
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <SampleStat label="First sample" value={formatDateTime(samples[0]!.sampled_at)} />
            <SampleStat
              label="Latest sample"
              value={formatDateTime(samples[samples.length - 1]!.sampled_at)}
            />
            <SampleStat
              label="Change"
              value={formatDelta(samples[samples.length - 1]!.size_bytes - samples[0]!.size_bytes)}
            />
            <SampleStat
              label="Tables"
              value={formatCount(samples[samples.length - 1]!.table_count)}
            />
          </dl>
        </>
      )}
    </SectionCard>
  );
}

function SampleStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-[var(--kn-text-3)]">{label}</dt>
      <dd className="kn-num m-0 truncate text-[var(--kn-text)]">{value}</dd>
    </div>
  );
}

function formatDelta(bytes: number): string {
  if (bytes === 0) return "no change";
  return `${bytes > 0 ? "+" : "−"}${formatBytes(Math.abs(bytes), "binary", 1)}`;
}

/* ------------------------------ users ------------------------------- */

function GrantedUsers({
  query,
  hostPatterns,
}: {
  query: UseQueryResult<ListResult<DbUser>, ApiError>;
  hostPatterns: boolean;
}) {
  const columns = React.useMemo<DataTableColumn<DbUser>[]>(
    () => [
      {
        id: "username",
        header: "User",
        locked: true,
        minWidth: 180,
        cell: (row) => (
          <MonoText truncate className="font-medium">
            {hostPatterns ? `${row.username}@${row.host_pattern}` : row.username}
          </MonoText>
        ),
      },
      {
        id: "privileges",
        header: "Privileges",
        minWidth: 220,
        cell: (row) => {
          const grant = row.grants[0];
          if (!grant) return <span className="text-[var(--kn-text-3)]">—</span>;
          return (
            <span className="flex flex-wrap items-center gap-1">
              {grant.privileges.map((privilege) => (
                <Badge key={privilege} tone="neutral" size="xs" mono>
                  {privilege}
                </Badge>
              ))}
              {grant.grant_option && (
                <Badge tone="warn" size="xs">
                  grant option
                </Badge>
              )}
            </span>
          );
        },
      },
      {
        id: "can_login",
        header: "Login",
        width: 92,
        cell: (row) => (
          <StatusBadge tone={row.can_login ? "ok" : "neutral"} size="xs">
            {row.can_login ? "enabled" : "disabled"}
          </StatusBadge>
        ),
      },
      {
        id: "last_used_at",
        header: "Last used",
        align: "right",
        width: 108,
        cell: (row) =>
          row.last_used_at ? (
            <RelativeTime value={row.last_used_at} />
          ) : (
            <span className="text-[var(--kn-text-3)]">never</span>
          ),
      },
    ],
    [hostPatterns],
  );

  return (
    <DataTable<DbUser>
      columns={columns}
      rows={query.data?.data ?? []}
      getRowId={(row) => row.id}
      label="Users granted on this database"
      density="compact"
      columnVisibility={false}
      loading={query.isLoading}
      skeletonRows={3}
      error={
        query.isError ? (
          <PageError
            error={query.error}
            onRetry={() => void query.refetch()}
            context="Granted users"
          />
        ) : undefined
      }
      empty={
        <EmptyState
          icon={Users}
          title="No user is granted on this database"
          description="Nothing can connect to it. Create a user on the instance and grant it here."
          size="sm"
        />
      }
      className="rounded-none border-0"
    />
  );
}

/* -------------------------- backup history -------------------------- */

function BackupHistory({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: Job[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const columns = React.useMemo<DataTableColumn<Job>[]>(
    () => [
      {
        id: "type",
        header: "Action",
        locked: true,
        width: 132,
        cell: (job) => (
          <span className="flex items-center gap-2">
            {job.type === "db.restore" ? (
              <Upload size={12} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
            ) : (
              <Download size={12} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
            )}
            {job.type === "db.restore" ? "Restore" : "Dump"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 132,
        cell: (job) => <JobStatusPill status={job.status} blockedReason={job.blocked_reason} />,
      },
      {
        id: "started",
        header: "Started",
        align: "right",
        width: 116,
        cell: (job) => <RelativeTime value={job.created_at} />,
      },
      {
        id: "duration",
        header: "Duration",
        align: "right",
        width: 96,
        hideBelow: "md",
        cell: (job) => <Duration ms={job.duration_ms} />,
      },
      {
        id: "actor",
        header: "Detail",
        minWidth: 200,
        hideBelow: "lg",
        cell: (job) =>
          job.error ? (
            <span className="truncate text-[var(--kn-danger)]">{job.error.message}</span>
          ) : (
            <span className="truncate text-[var(--kn-text-2)]">
              {job.target_label ?? humanize(job.type)}
            </span>
          ),
      },
    ],
    [],
  );

  return (
    <DataTable<Job>
      columns={columns}
      rows={rows}
      getRowId={(job) => job.id}
      label="Backup history"
      density="compact"
      columnVisibility={false}
      loading={loading}
      skeletonRows={3}
      error={
        error ? <PageError error={error} onRetry={onRetry} context="Backup history" /> : undefined
      }
      empty={
        <EmptyState
          icon={Archive}
          title="No dump or restore recorded"
          description="Dumping this database from here is the fastest way to get a restorable copy on the host."
          size="sm"
        />
      }
      className="rounded-none border-0"
    />
  );
}
