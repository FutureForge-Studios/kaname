"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore, CopyPlus, DatabaseBackup, TriangleAlert } from "lucide-react";
import type { AppBackupOverview, AppRestorePoint, BackupRunStatus } from "@kaname/contract";
import {
  Badge,
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  MonoText,
  NumberedSection,
  RelativeTime,
  Select,
  Skeleton,
  StatusLine,
  Switch,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { api, type ApiError } from "@/lib/api";
import { describeCron } from "@/lib/cron";
import { formatBytes } from "@/lib/format";
import { DETAIL_STALE_TIME, queryKeys, useCan, useMutationWithJob, useServers } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * An installed app's backups (KD-043): when it was last backed up,
 * the restore points that hold it, and the three things a person does
 * with them — back up now, restore in place, restore as a new copy.
 * Self-contained: the install page mounts it with one line.
 *
 * Data lives under the `backups/restore-points` family, so the SSE
 * `backups` topic (a run finishing, a restore step) refreshes it.
 * ------------------------------------------------------------------ */

const FAMILY = "backups/restore-points";

const RUN_TONES: Record<BackupRunStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "ok",
  partial: "warn",
  failed: "danger",
  cancelled: "neutral",
};

export interface AppBackupsProps {
  installId: string;
  serverId: string;
  index?: number;
}

export function AppBackups({ installId, serverId, index = 6 }: AppBackupsProps) {
  const can = useCan();
  const query = useQuery<AppBackupOverview, ApiError>({
    queryKey: queryKeys.detail(FAMILY, `app:${installId}`),
    queryFn: ({ signal }) => api.get<AppBackupOverview>(`/backups/apps/${installId}`, { signal }),
    staleTime: DETAIL_STALE_TIME,
  });
  const [destinationOpen, setDestinationOpen] = React.useState(false);
  const [restoring, setRestoring] = React.useState<AppRestorePoint | null>(null);
  const [copying, setCopying] = React.useState<AppRestorePoint | null>(null);

  const backUp = useMutationWithJob<{ destination_id?: string }>({
    mutationFn: (body) => api.post(`/backups/apps/${installId}/run`, body),
    invalidates: [FAMILY, "backups/runs", "backups/schedules"],
    describe: () => "Back up app",
    onQueued: () => setDestinationOpen(false),
  });

  if (!can("backups.schedules:read", serverId)) return null;

  const data = query.data;
  const mayWrite = can("backups.schedules:write", serverId);
  const mayRestore = can("backups.restore:exec", serverId);

  return (
    <NumberedSection
      index={index}
      title="Backups"
      caption="Its data, a consistent database dump and a manifest, in one snapshot."
      actions={
        data && !data.unsupported_reason && mayWrite ? (
          <Button
            size="sm"
            variant="primary"
            icon={DatabaseBackup}
            loading={backUp.isPending}
            onClick={() => (data.schedule ? backUp.mutate({}) : setDestinationOpen(true))}
          >
            Back up now
          </Button>
        ) : undefined
      }
    >
      {query.isLoading && <Skeleton className="h-32 w-full" label="Loading backups" />}
      {query.error && (
        <ErrorState code={query.error.code} message={query.error.message} remediation={query.error.remediation} />
      )}
      {data && (
        <>
          <Card radius="xl" padding="md" className="flex flex-col gap-2">
            <LastRunLine overview={data} />
            {data.schedule ? (
              <StatusLine tone={data.schedule.enabled ? "ok" : "neutral"}>
                <span>
                  {describeCron(data.schedule.cron, "UTC")} to{" "}
                  <MonoText className="text-[var(--kn-text)]">{data.schedule.destination_name}</MonoText>
                  {data.covered_by.length > 1 && ` · also in ${data.covered_by.length - 1} other schedule(s)`}
                </span>
              </StatusLine>
            ) : data.covered_by.length > 0 ? (
              <StatusLine tone="ok">Covered by {data.covered_by.map((s) => s.name).join(", ")}</StatusLine>
            ) : (
              <StatusLine tone="warn">No schedule yet. The first “Back up now” sets up a nightly one.</StatusLine>
            )}
            {data.stop_during_backup && (
              <p className="m-0 text-sm text-[var(--kn-text-2)]">
                The app is stopped for the few seconds its snapshot takes, so its files and database agree.
              </p>
            )}
            {data.unsupported_reason && (
              <p className="m-0 flex items-start gap-2 text-sm text-[var(--kn-text)]">
                <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
                {data.unsupported_reason}
              </p>
            )}
          </Card>

          <DataTable<AppRestorePoint>
            label="Restore points"
            density="compact"
            columnVisibility={false}
            rows={data.restore_points}
            getRowId={(row) => row.id}
            columns={pointColumns}
            empty={
              <EmptyState
                title="No restore points yet"
                description="Back the app up once and its first restore point appears here."
              />
            }
            rowActions={(row) => [
              {
                id: "restore",
                label: "Restore",
                icon: ArchiveRestore,
                destructive: true,
                disabled: !mayRestore || row.app_version === null || row.newer_than_recipe,
                onSelect: setRestoring,
              },
              {
                id: "restore-new",
                label: "Restore as new",
                icon: CopyPlus,
                disabled: !mayRestore || row.app_version === null || row.newer_than_recipe,
                onSelect: setCopying,
              },
            ]}
          />
          <p className="m-0 text-xs text-[var(--kn-text-3)]">
            Secrets stay sealed in Kaname: the snapshot holds only their names. A point taken with a newer app version
            than Kaname installs cannot be restored until Kaname is updated.
          </p>

          <DestinationDialog
            open={destinationOpen}
            onOpenChange={setDestinationOpen}
            overview={data}
            loading={backUp.isPending}
            onConfirm={(destinationId) => backUp.mutate({ destination_id: destinationId })}
          />
          <RestoreDialog installId={installId} overview={data} point={restoring} onClose={() => setRestoring(null)} />
          <RestoreAsNewDialog
            installId={installId}
            overview={data}
            point={copying}
            onClose={() => setCopying(null)}
          />
        </>
      )}
    </NumberedSection>
  );
}

const pointColumns: readonly DataTableColumn<AppRestorePoint>[] = [
  { id: "label", header: "Point", mono: true, accessor: (row) => row.label, locked: true },
  { id: "taken", header: "Taken", cell: (row) => <RelativeTime value={row.taken_at} /> },
  {
    id: "version",
    header: "Version",
    mono: true,
    cell: (row) =>
      row.app_version === null ? (
        <span className="text-[var(--kn-text-3)]">no manifest</span>
      ) : row.newer_than_recipe ? (
        <Badge tone="warn" size="xs" mono title="Newer than the recipe Kaname installs">
          {row.app_version} · newer
        </Badge>
      ) : (
        row.app_version
      ),
  },
  { id: "size", header: "Size", mono: true, align: "right", accessor: (row) => formatBytes(row.bytes), hideBelow: "md" },
  {
    id: "verified",
    header: "Verified",
    hideBelow: "lg",
    cell: (row) => (row.verified_at ? <RelativeTime value={row.verified_at} /> : <span className="text-[var(--kn-text-3)]">—</span>),
  },
];

function LastRunLine({ overview }: { overview: AppBackupOverview }) {
  const run = overview.last_run;
  if (!run) return <StatusLine tone="neutral">Never backed up</StatusLine>;
  const live = run.status === "queued" || run.status === "running";
  return (
    <StatusLine tone={RUN_TONES[run.status]} pulse={live}>
      <span>
        Last backup {run.status} <RelativeTime value={run.finished_at ?? run.started_at} />
        {run.status === "succeeded" && ` · ${formatBytes(run.bytes)}`}
        {run.error && <span className="text-[var(--kn-text)]"> · {run.error}</span>}{" "}
        <Link href={`/jobs/${run.job_id}`} className="text-[var(--kn-accent-400)] hover:underline">
          log
        </Link>
      </span>
    </StatusLine>
  );
}

function DestinationDialog({
  open,
  onOpenChange,
  overview,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overview: AppBackupOverview;
  loading: boolean;
  onConfirm: (destinationId: string) => void;
}) {
  const [destinationId, setDestinationId] = React.useState("");
  React.useEffect(() => {
    if (open) setDestinationId(overview.destinations[0]?.id ?? "");
  }, [open, overview.destinations]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" dismissible={!loading}>
      <DialogHeader
        title={`Back up ${overview.app_name}`}
        description="The first backup sets up a nightly schedule for this app. Pick where its snapshots go."
      />
      <DialogBody>
        {overview.destinations.length === 0 ? (
          <p className="m-0 text-sm text-[var(--kn-text-2)]">
            There is no backup destination yet. An operator adds one under Backups → Destinations.
          </p>
        ) : (
          <FormField label="Destination" required>
            <Select
              value={destinationId}
              onChange={(event) => setDestinationId(event.target.value)}
              options={overview.destinations.map((d) => ({ value: d.id, label: `${d.name} (${d.kind})` }))}
            />
          </FormField>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={loading}
          disabled={!destinationId}
          onClick={() => onConfirm(destinationId)}
        >
          Back up now
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function RestoreDialog({
  installId,
  overview,
  point,
  onClose,
}: {
  installId: string;
  overview: AppBackupOverview;
  point: AppRestorePoint | null;
  onClose: () => void;
}) {
  const restore = useMutationWithJob<void>({
    mutationFn: () =>
      api.post(`/backups/apps/${installId}/restore`, {
        restore_point_id: point!.id,
        confirm_domain: overview.domain,
      }),
    invalidates: [FAMILY, "apps/installs"],
    describe: () => `Restore ${overview.app_name}`,
    onQueued: onClose,
  });
  if (!point) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Restore ${overview.app_name}`}
      description={`From ${point.label}, taken ${new Date(point.taken_at).toLocaleString()}.`}
      confirmText={overview.domain}
      confirmLabel="Restore"
      loading={restore.isPending}
      onConfirm={() => restore.mutate()}
    >
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-[var(--kn-text-2)]">
        <li>The snapshot is unpacked into a staging directory.</li>
        <li>Today&apos;s database is dumped and kept until the restore succeeds.</li>
        <li>The app stops; its data is swapped for the staged copy.</li>
        <li>Each database re-imports its dump, the app starts, and Kaname checks it answers.</li>
      </ol>
      <p className="mt-3 text-sm text-[var(--kn-text)]">
        If any step fails, the original data and database are put back and the app is started again.
      </p>
    </ConfirmDialog>
  );
}

function RestoreAsNewDialog({
  installId,
  overview,
  point,
  onClose,
}: {
  installId: string;
  overview: AppBackupOverview;
  point: AppRestorePoint | null;
  onClose: () => void;
}) {
  const servers = useServers();
  const [serverId, setServerId] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [ssl, setSsl] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  React.useEffect(() => {
    if (!point) return;
    setServerId(point.server_id);
    setDomain("");
    setSsl(true);
    setError(null);
  }, [point]);

  const copy = useMutationWithJob<void>({
    mutationFn: () =>
      api.post(`/backups/apps/${installId}/restore-as-new`, {
        restore_point_id: point!.id,
        target_server_id: serverId,
        domain: domain.trim(),
        ssl,
        confirm_domain: overview.domain,
      }),
    invalidates: [FAMILY, "apps/installs"],
    describe: () => `Restore ${overview.app_name} as ${domain.trim()}`,
    onQueued: onClose,
    onFailed: setError,
  });
  if (!point) return null;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Restore as a new app"
      description={`A fresh ${overview.app_name} with its own port, site and certificate, then ${point.label} restored into it.`}
      confirmText={overview.domain}
      confirmLabel="Install and restore"
      destructive={false}
      loading={copy.isPending}
      onConfirm={() => copy.mutate()}
    >
      <div className="flex flex-col gap-4">
        <FormField label="Server" required error={error?.fields["target_server_id"]}>
          <Combobox
            options={
              servers.data?.data.map((s) => ({ value: s.id, label: s.name, description: s.hostname, mono: true })) ?? []
            }
            value={serverId}
            onValueChange={(next) => setServerId(next ?? "")}
            loading={servers.isLoading}
            placeholder="Select a server"
            emptyMessage="No server matches that name."
            mono
          />
        </FormField>
        <FormField
          label="New domain"
          required
          description="Point its DNS at the server first if you want a certificate."
          error={error?.fields["domain"]}
        >
          <Input mono value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="copy.example.com" />
        </FormField>
        <Switch checked={ssl} onChange={(event) => setSsl(event.target.checked)} label="HTTPS" />
        <p className="m-0 text-sm text-[var(--kn-text-2)]">
          The copy gets {overview.domain}&apos;s secrets (sealed, never shown). Apps that store their own address in their
          data may need the new domain added in their settings.
        </p>
      </div>
    </ConfirmDialog>
  );
}
