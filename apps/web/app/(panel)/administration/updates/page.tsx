"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  UPDATE_TIER_LABELS,
  parseVersion,
  type AgentVersionRow,
  type UpdateOverview,
  type UpdateRun,
  type UpdateRunStatus,
} from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Drawer,
  DrawerBody,
  DrawerHeader,
  EmptyState,
  IconButton,
  LogViewer,
  MonoText,
  PageHeader,
  PropertyList,
  PropertyRow,
  RelativeTime,
  SectionCard,
  Skeleton,
  Spinner,
  cn,
  type DataTableColumn,
  type LogLine,
  type Tone,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import {
  invalidateFamilies,
  useCan,
  useList,
  useResource,
  useResourceMutation,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Updates.
 *
 * The page exists so nobody has to SSH into a box to find out what is
 * running on it. Three questions, in the order they get asked: what is
 * this control plane on, what is every agent on, and what happened the
 * last time something was updated.
 *
 * A rollout is rendered per host, never as one aggregate spinner. A
 * partial failure on one server is exactly the thing an aggregate would
 * hide, and it is the whole reason this page is worth having.
 * ------------------------------------------------------------------ */

const STATUS_TONE: Record<UpdateRunStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "ok",
  failed: "danger",
  rolled_back: "warn",
  needs_attention: "danger",
};

const STATUS_LABEL: Record<UpdateRunStatus, string> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  rolled_back: "rolled back",
  needs_attention: "needs attention",
};

export default function UpdatesPage() {
  const can = useCan();
  const readOnly = !can("admin.settings:write");
  const [openRunId, setOpenRunId] = React.useState<string | null>(null);

  const overview = useResource<UpdateOverview>("updates", "overview", { path: "/updates" });
  const runs = useList<UpdateRun>("update-runs", { per_page: 25 }, { path: "/updates/runs" });

  // While the host is replacing the control plane, a refetch that fails
  // is the expected shape of things, not an error to swap the page for:
  // the last good overview stays up and says what is happening.
  const restarting = overview.data?.control_plane.run?.status === "running";

  const check = useResourceMutation<void, UpdateOverview>({
    mutationFn: () => api.post<UpdateOverview>("/updates/check"),
    invalidates: ["updates", "update-runs"],
    successMessage: (result) =>
      result.control_plane.update_available
        ? `${result.control_plane.latest_version} is available.`
        : "Already on the newest release.",
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Updates"
        subtitle={
          overview.data ? `Control plane ${overview.data.control_plane.current_version}` : undefined
        }
        actions={
          <div className="flex items-center gap-1.5">
            {readOnly && (
              <Badge tone="neutral" size="sm">
                read only
              </Badge>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={check.isPending}
              disabled={readOnly}
              onClick={() => check.mutate()}
            >
              Check for updates
            </Button>
          </div>
        }
      />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        {overview.isError && !restarting && (
          <PageError
            error={overview.error}
            onRetry={() => void overview.refetch()}
            context="Updates"
          />
        )}

        {overview.isLoading && (
          <>
            <Skeleton className="h-44 rounded-[var(--kn-r-md)]" label="Loading updates" />
            <Skeleton className="h-56 rounded-[var(--kn-r-md)]" />
          </>
        )}

        {overview.data && (
          <>
            <ControlPlaneCard overview={overview.data} readOnly={readOnly} />
            <AgentTable overview={overview.data} readOnly={readOnly} />
            <HistoryTable
              runs={runs.data?.data ?? []}
              loading={runs.isLoading}
              error={runs.error}
              onRetry={() => void runs.refetch()}
              onOpen={setOpenRunId}
            />
          </>
        )}
      </div>

      <RunDrawer runId={openRunId} onClose={() => setOpenRunId(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Control plane
 * ------------------------------------------------------------------ */

function ControlPlaneCard({ overview, readOnly }: { overview: UpdateOverview; readOnly: boolean }) {
  const cp = overview.control_plane;
  const [confirming, setConfirming] = React.useState(false);
  const [skipBackup, setSkipBackup] = React.useState(false);
  const justFinished = useRestartWatch(cp.run);

  const apply = useResourceMutation<{ confirm: boolean; skipBackup: boolean }, UpdateRun>({
    mutationFn: (vars) =>
      api.post<UpdateRun>("/updates/control-plane", {
        to_version: cp.latest_version,
        confirm_breaking: vars.confirm,
        skip_backup_check: vars.skipBackup,
      }),
    invalidates: ["updates", "update-runs"],
    successMessage: () => `Applying ${cp.latest_version}. The panel will restart.`,
    onFailed: (error) => {
      // The backup precondition is a decision, not a dead end: offering
      // the override here is the difference between "blocked" and
      // "blocked, and here is what you would be choosing".
      if (error.status === 412 && error.message.includes("backup")) setSkipBackup(true);
    },
  });

  return (
    <SectionCard
      title="Control plane"
      description={`This installation. Update cadence: ${UPDATE_TIER_LABELS[overview.settings.tier].label.toLowerCase()}.`}
      icon={ArrowUpCircle}
      actions={
        cp.update_available &&
        !readOnly && (
          <Button
            variant={cp.requires_confirmation ? "secondary" : "primary"}
            size="xs"
            icon={Download}
            loading={apply.isPending}
            disabled={Boolean(cp.blocked_reason) || cp.run?.status === "running"}
            onClick={() => {
              if (cp.requires_confirmation) setConfirming(true);
              else apply.mutate({ confirm: false, skipBackup: skipBackup });
            }}
          >
            Update to {cp.latest_version}
          </Button>
        )
      }
    >
      <PropertyList>
        <PropertyRow label="Running">
          <MonoText>{cp.current_version}</MonoText>
        </PropertyRow>
        <PropertyRow label="Latest">
          {cp.latest_version ? (
            <span className="flex items-center gap-2">
              <MonoText>{cp.latest_version}</MonoText>
              {cp.pending?.security && (
                <Badge tone="warn" size="sm">
                  security
                </Badge>
              )}
              {cp.requires_confirmation && (
                <Badge tone="danger" size="sm">
                  {cp.pending?.breaking ? "breaking" : "destructive migration"}
                </Badge>
              )}
            </span>
          ) : (
            <span className="text-[var(--kn-text-3)]">up to date</span>
          )}
        </PropertyRow>
        {cp.pending?.summary && <PropertyRow label="Summary">{cp.pending.summary}</PropertyRow>}
        {cp.pending?.notes_url && (
          <PropertyRow label="Release notes">
            <a
              className="inline-flex items-center gap-1 text-[var(--kn-accent-400)] hover:underline"
              href={cp.pending.notes_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {cp.pending.notes_url}
              <ExternalLink size={12} aria-hidden />
            </a>
          </PropertyRow>
        )}
        <PropertyRow label="Last checked">
          {overview.settings.last_checked_at ? (
            <RelativeTime value={overview.settings.last_checked_at} />
          ) : (
            <span className="text-[var(--kn-text-3)]">never</span>
          )}
        </PropertyRow>
        {overview.settings.next_check_at && overview.settings.tier !== "off" && (
          <PropertyRow label="Next check">
            <RelativeTime value={overview.settings.next_check_at} />
          </PropertyRow>
        )}
      </PropertyList>

      {overview.settings.last_check_error && (
        <Notice tone="warn" icon={CircleAlert}>
          The last check failed: {overview.settings.last_check_error}
          {overview.settings.next_check_at && overview.settings.tier !== "off" && (
            <>
              {" "}
              Retrying <RelativeTime value={overview.settings.next_check_at} />.
            </>
          )}
        </Notice>
      )}

      {overview.settings.last_apply_error && (
        <Notice tone="warn" icon={CircleAlert}>
          Scheduled apply of {overview.settings.last_apply_error.version} was refused{" "}
          <RelativeTime value={overview.settings.last_apply_error.at} />:{" "}
          {overview.settings.last_apply_error.message}
          {overview.settings.last_apply_error.message.includes("backup") && (
            <>
              {" "}
              <a className="text-[var(--kn-accent-400)] hover:underline" href="/backups">
                Backups
              </a>
            </>
          )}
        </Notice>
      )}

      {cp.blocked_reason && (
        <Notice tone="warn" icon={ShieldAlert}>
          {cp.blocked_reason}
        </Notice>
      )}

      {cp.run?.status === "running" && <UpdateInProgress run={cp.run} />}

      {justFinished && cp.run?.status === "succeeded" && (
        <Notice tone="info" icon={CircleCheck}>
          Updated to {cp.run.to_version}. The control plane is back and answering.
        </Notice>
      )}

      {cp.run && cp.run.status !== "succeeded" && cp.run.status !== "running" && (
        <Notice tone="danger" icon={CircleAlert}>
          The last control-plane update ({cp.run.from_version} to {cp.run.to_version}){" "}
          {STATUS_LABEL[cp.run.status]}
          {cp.run.error ? `: ${cp.run.error}` : "."}
        </Notice>
      )}

      {apply.error && (
        <div className="mt-3">
          <PageError error={apply.error} context="Update" />
          {skipBackup && (
            <Button
              className="mt-2"
              variant="secondary"
              size="xs"
              loading={apply.isPending}
              onClick={() =>
                cp.requires_confirmation
                  ? setConfirming(true)
                  : apply.mutate({ confirm: false, skipBackup: true })
              }
            >
              Apply without a recent backup
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Apply ${cp.latest_version} to the control plane`}
        confirmText={cp.latest_version ?? undefined}
        confirmLabel="Apply the update"
        destructive
        loading={apply.isPending}
        onConfirm={() => {
          apply.mutate({ confirm: true, skipBackup });
          setConfirming(false);
        }}
      >
        <div className="flex flex-col gap-2 text-[var(--kn-text-2)]">
          <p>
            {cp.pending?.breaking
              ? `${cp.latest_version} is marked as containing breaking changes.`
              : `${cp.latest_version} runs a migration that rewrites or drops data.`}{" "}
            That is why this asks, and why it would still ask if updates were set to apply
            themselves.
          </p>
          {cp.pending?.summary && <p>{cp.pending.summary}</p>}
          <p>
            The panel and the API will be unavailable for about a minute. If the new version does
            not answer afterwards, the previous configuration is restored automatically — unless a
            migration has already run, in which case the run stops and waits for you.
          </p>
          {skipBackup && (
            <p className="text-[var(--kn-warn)]">
              No backup has succeeded recently. Choosing to continue is recorded in the audit trail.
            </p>
          )}
        </div>
      </ConfirmDialog>
    </SectionCard>
  );
}

/**
 * What the operator sees between "Update to X" and the new build
 * answering. The host's pull and restart lines arrive in the run as
 * they are written, and the 502 the proxy answers while the control
 * plane is being recreated is named here as the expected thing.
 */
function UpdateInProgress({ run }: { run: UpdateRun }) {
  const elapsed = useElapsed(run.started_at ?? run.created_at);
  const lines = React.useMemo(() => toLogLines(run.log), [run.log]);

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Spinner size={14} label="Updating" />
        <span className="text-[var(--kn-text)]">
          Updating {run.from_version} → {run.to_version}
        </span>
        <span className="text-[var(--kn-text-3)]">{formatDuration(elapsed)} elapsed</span>
      </div>
      <p className="text-[var(--kn-text-2)]">
        The panel will be unreachable for about a minute while the host restarts it. If the new
        version does not answer, the previous one is put back automatically.
      </p>
      <LogViewer
        lines={lines}
        height={200}
        label={`Output of update ${run.to_version}`}
        emptyLabel="Waiting for the host updater."
        defaultShowTimestamps={false}
        defaultWrap
      />
    </div>
  );
}

/**
 * While a control-plane update runs, asks /health every few seconds
 * and refetches the page when the answer changes — the control plane
 * coming back, or coming back as a different version. The SSE stream
 * does the same on reconnect; this is for the tab whose stream has not
 * noticed yet. Returns true once a run watched here has finished.
 */
function useRestartWatch(run: UpdateRun | null): boolean {
  const client = useQueryClient();
  const running = run?.status === "running" ? run.id : null;
  const [watched, setWatched] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!running) return;
    setWatched(running);

    let last: { up: boolean; version: string | null } | null = null;
    const poll = async () => {
      let next: { up: boolean; version: string | null };
      try {
        const res = await fetch("/health", { cache: "no-store" });
        const data = res.ok ? ((await res.json()) as { version?: string }) : null;
        next = { up: res.ok, version: data?.version ?? null };
      } catch {
        next = { up: false, version: null };
      }
      if (last && (next.up !== last.up || next.version !== last.version)) {
        invalidateFamilies(client, ["updates", "update-runs"]);
      }
      last = next;
    };

    const timer = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(timer);
  }, [client, running]);

  return watched !== null && run?.id === watched && run.status !== "running";
}

function useElapsed(since: string): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, now - Date.parse(since));
}

/** The updater marks its own lines: `==>` is a phase, `!!` is something that went wrong. */
function toLogLines(text: string): LogLine[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((message, index) => ({
      id: String(index),
      message,
      level: message.startsWith("!!") ? "error" : message.startsWith("==>") ? "notice" : "info",
    }));
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: "info" | "warn" | "danger";
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-3 flex items-start gap-2 rounded-[var(--kn-r-sm)] border px-3 py-2 text-sm",
        tone === "info" && "border-[var(--kn-border)] bg-[var(--kn-surface-2)]",
        tone === "warn" && "border-[var(--kn-warn)] bg-[var(--kn-warn-soft)]",
        tone === "danger" && "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]",
      )}
    >
      <Icon size={13} className="mt-0.5 shrink-0 text-[var(--kn-text-3)]" />
      <span className="min-w-0 text-[var(--kn-text-2)]">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The fleet
 * ------------------------------------------------------------------ */

function AgentTable({ overview, readOnly }: { overview: UpdateOverview; readOnly: boolean }) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const target = overview.control_plane.latest_version ?? overview.control_plane.current_version;

  const rollout = useResourceMutation<string[], { jobs: unknown[] }>({
    mutationFn: (ids) =>
      api.post<{ jobs: unknown[] }>("/updates/agents", {
        to_version: target,
        server_ids: ids,
      }),
    invalidates: ["updates", "update-runs", "servers", "jobs"],
    successMessage: (result) => `Updating ${result.jobs.length} agents.`,
    onDone: () => setSelected([]),
  });

  const acknowledge = useResourceMutation<string, UpdateRun>({
    mutationFn: (runId) => api.post<UpdateRun>(`/updates/runs/${runId}/acknowledge`),
    invalidates: ["updates", "update-runs"],
    successMessage: () => "Acknowledged.",
  });

  const columns: DataTableColumn<AgentVersionRow>[] = [
    {
      id: "server",
      header: "Server",
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[var(--kn-text)]">{row.server_name}</span>
          <span className="truncate font-mono text-xs text-[var(--kn-text-3)]">{row.hostname}</span>
        </div>
      ),
      minWidth: 200,
    },
    {
      id: "version",
      header: "Agent",
      mono: true,
      cell: (row) => row.agent_version ?? "—",
      width: 110,
    },
    {
      id: "state",
      header: "State",
      cell: (row) =>
        row.up_to_date ? (
          <Badge tone="ok" size="sm">
            up to date
          </Badge>
        ) : row.agent_version && parseVersion(row.agent_version) === null ? (
          <Badge tone="neutral" size="sm">
            unknown version
          </Badge>
        ) : (
          <Badge tone="warn" size="sm">
            {target} available
          </Badge>
        ),
      width: 150,
    },
    {
      id: "last_seen",
      header: "Last seen",
      cell: (row) =>
        row.last_seen_at ? (
          <RelativeTime value={row.last_seen_at} />
        ) : (
          <span className="text-[var(--kn-text-3)]">never</span>
        ),
      width: 130,
      hideBelow: "md",
    },
    {
      id: "rollout",
      header: "Rollout",
      cell: (row) => <RolloutCell row={row} onAcknowledge={(id) => acknowledge.mutate(id)} />,
      minWidth: 220,
    },
  ];

  return (
    <SectionCard
      title="Agents"
      description="One row per host. A rollout that fails on one server shows up as that server."
      icon={ArrowUpCircle}
    >
      <DataTable
        label="Agent versions"
        columns={columns}
        rows={overview.agents}
        getRowId={(row) => row.server_id}
        density="compact"
        selectedIds={readOnly ? undefined : selected}
        onSelectionChange={readOnly ? undefined : setSelected}
        isRowSelectable={(row) => row.connection === "connected"}
        bulkActions={(ids) => (
          <Button
            variant="primary"
            size="xs"
            icon={Download}
            loading={rollout.isPending}
            onClick={() => rollout.mutate(ids)}
          >
            Update {ids.length} agent{ids.length === 1 ? "" : "s"} to {target}
          </Button>
        )}
        empty={
          <EmptyState
            title="No servers yet"
            description="Agents appear here as soon as they enroll."
          />
        }
      />
    </SectionCard>
  );
}

function RolloutCell({
  row,
  onAcknowledge,
}: {
  row: AgentVersionRow;
  onAcknowledge: (runId: string) => void;
}) {
  const run = row.run;
  if (!run) return <span className="text-[var(--kn-text-3)]">—</span>;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge tone={STATUS_TONE[run.status]} size="sm">
        {STATUS_LABEL[run.status]}
      </Badge>
      <span className="truncate text-xs text-[var(--kn-text-3)]">
        {run.from_version} → {run.to_version}
      </span>
      {run.status === "needs_attention" && (
        <Button variant="ghost" size="xs" onClick={() => onAcknowledge(run.id)}>
          Acknowledge
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function HistoryTable({
  runs,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  runs: UpdateRun[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (id: string) => void;
}) {
  const columns: DataTableColumn<UpdateRun>[] = [
    {
      id: "what",
      header: "What",
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[var(--kn-text)]">
            {row.kind === "control_plane" ? "Control plane" : (row.server_name ?? "Agent")}
          </span>
          <span className="truncate font-mono text-xs text-[var(--kn-text-3)]">
            {row.from_version} → {row.to_version}
          </span>
        </div>
      ),
      minWidth: 200,
    },
    {
      id: "status",
      header: "Outcome",
      cell: (row) => (
        <Badge tone={STATUS_TONE[row.status]} size="sm">
          {STATUS_LABEL[row.status]}
        </Badge>
      ),
      width: 150,
    },
    {
      id: "trigger",
      header: "Started by",
      cell: (row) => row.started_by_name ?? row.trigger,
      width: 150,
      hideBelow: "lg",
    },
    {
      id: "when",
      header: "When",
      cell: (row) => <RelativeTime value={row.started_at ?? row.created_at} />,
      width: 130,
    },
    {
      id: "duration",
      header: "Took",
      cell: (row) =>
        row.duration_ms ? (
          formatDuration(row.duration_ms)
        ) : (
          <span className="text-[var(--kn-text-3)]">—</span>
        ),
      width: 90,
      align: "right",
      hideBelow: "md",
    },
  ];

  return (
    <SectionCard
      title="History"
      description="Every update run, with the output it produced."
      icon={ArrowUpCircle}
    >
      {error ? (
        <PageError error={error} onRetry={onRetry} context="Update history" />
      ) : (
        <DataTable
          label="Update history"
          columns={columns}
          rows={runs}
          getRowId={(row) => row.id}
          density="compact"
          loading={loading}
          onRowClick={(row) => onOpen(row.id)}
          empty={
            <EmptyState
              title="Nothing has been updated yet"
              description="Runs appear here once the control plane or an agent is updated."
            />
          }
        />
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * One run, with its whole log
 * ------------------------------------------------------------------ */

function RunDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const run = useResource<UpdateRun>("update-runs", runId, {
    path: `/updates/runs/${runId ?? ""}`,
  });

  const lines = React.useMemo(() => toLogLines(run.data?.log ?? ""), [run.data?.log]);

  return (
    <Drawer open={Boolean(runId)} onOpenChange={(open) => !open && onClose()} size="lg">
      <DrawerHeader
        title={
          run.data
            ? `${run.data.kind === "control_plane" ? "Control plane" : (run.data.server_name ?? "Agent")} · ${run.data.to_version}`
            : "Update run"
        }
        description={run.data ? `Run ${run.data.id}` : undefined}
      />
      <DrawerBody>
        {run.isLoading && <Skeleton className="h-40" label="Loading the run" />}
        {run.isError && (
          <PageError error={run.error} onRetry={() => void run.refetch()} context="Update run" />
        )}

        {run.data && (
          <div className="flex flex-col gap-4">
            <PropertyList>
              <PropertyRow label="Outcome">
                <Badge tone={STATUS_TONE[run.data.status]} size="sm">
                  {STATUS_LABEL[run.data.status]}
                </Badge>
              </PropertyRow>
              <PropertyRow label="Versions">
                <MonoText>
                  {run.data.from_version} → {run.data.to_version}
                </MonoText>
              </PropertyRow>
              <PropertyRow label="Started">
                {run.data.started_at ? <RelativeTime value={run.data.started_at} /> : "—"}
              </PropertyRow>
              <PropertyRow label="Took">
                {run.data.duration_ms ? formatDuration(run.data.duration_ms) : "—"}
              </PropertyRow>
              <PropertyRow label="Started by">
                {run.data.started_by_name ?? run.data.trigger}
              </PropertyRow>
              {run.data.error && <PropertyRow label="Error">{run.data.error}</PropertyRow>}
            </PropertyList>

            <LogViewer
              lines={lines}
              height={420}
              label={`Output of update ${run.data.to_version}`}
              emptyLabel="This run produced no output."
              defaultShowTimestamps={false}
            />
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
