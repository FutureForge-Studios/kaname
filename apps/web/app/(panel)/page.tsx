"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Archive,
  ArrowRight,
  Cpu,
  HardDrive,
  ListChecks,
  MemoryStick,
  RefreshCw,
  Server as ServerIcon,
  ShieldAlert,
  ShieldCheck,
  Siren,
} from "lucide-react";
import type { Server } from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Badge,
  ByteSize,
  DataTable,
  EmptyState,
  HealthBadge,
  IconButton,
  JobStatusPill,
  MetricTile,
  MonoText,
  PageHeader,
  RelativeTime,
  SectionCard,
  Skeleton,
  cn,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { GettingStarted } from "@/components/GettingStarted";
import { PageError } from "@/components/PageError";
import { ATTENTION_ICONS } from "@/lib/icons";
import {
  formatBytes,
  formatCount,
  formatDaysLeft,
  formatLoad,
  formatPercent,
  formatRate,
  formatUptime,
  humanize,
  percentOf,
} from "@/lib/format";
import { useDashboard, useServers, type DashboardSummary } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Command Center.
 *
 * The question this page answers is "what needs me right now", and
 * everything is ordered by how directly it answers that: the fleet
 * rollup is one dense strip, then the attention list — the most
 * important surface in the product — then the fleet itself, then the
 * record of what has been happening.
 *
 * No giant metric cards. An operator opens this page dozens of times a
 * day; it should read like an instrument panel, not a quarterly report.
 * ------------------------------------------------------------------ */

type Attention = DashboardSummary["attention"][number];
type Severity = Attention["severity"];

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  warning: "warn",
  info: "info",
};

export default function CommandCenterPage() {
  const dashboard = useDashboard();
  const servers = useServers();

  const summary = dashboard.data;
  const busy = dashboard.isFetching || servers.isFetching;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Command Center"
        subtitle={
          summary
            ? `${formatCount(summary.fleet.servers_connected)}/${formatCount(summary.fleet.servers_total)} agents connected`
            : undefined
        }
        actions={
          <IconButton
            icon={RefreshCw}
            label="Refresh"
            size="sm"
            disabled={busy}
            onClick={() => {
              void dashboard.refetch();
              void servers.refetch();
            }}
          />
        }
      />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        {dashboard.isError && (
          <PageError
            error={dashboard.error}
            onRetry={() => void dashboard.refetch()}
            context="Command Center"
          />
        )}

        <GettingStarted />

        {dashboard.isLoading && <RollupSkeleton />}
        {summary && <FleetRollup summary={summary} />}

        <AttentionList
          items={summary?.attention ?? []}
          loading={dashboard.isLoading}
          failed={dashboard.isError}
        />

        <FleetTable query={servers} />

        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
          <RecentActivity summary={summary} loading={dashboard.isLoading} />
          <div className="flex min-w-0 flex-col gap-4">
            <ExpiringCertificates summary={summary} loading={dashboard.isLoading} />
            <BackupHealth summary={summary} loading={dashboard.isLoading} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- fleet rollup -------------------------- */

function RollupSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton
          key={index}
          className="h-16 rounded-[var(--kn-r-md)]"
          label={index === 0 ? "Loading fleet summary" : undefined}
        />
      ))}
    </div>
  );
}

function FleetRollup({ summary }: { summary: DashboardSummary }) {
  const { fleet, threats_24h: threats } = summary;
  const memoryPercent = percentOf(fleet.memory_used, fleet.memory_total);
  const diskPercent = percentOf(fleet.disk_used, fleet.disk_total);
  const offline = fleet.servers_total - fleet.servers_connected;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      <MetricTile
        size="sm"
        icon={ServerIcon}
        label="Agents connected"
        value={`${formatCount(fleet.servers_connected)}/${formatCount(fleet.servers_total)}`}
        tone={offline > 0 ? "warn" : "ok"}
      />
      <MetricTile
        size="sm"
        icon={Activity}
        label="Unhealthy"
        value={formatCount(fleet.servers_unhealthy)}
        tone={fleet.servers_unhealthy > 0 ? "danger" : "neutral"}
      />
      <MetricTile
        size="sm"
        icon={Cpu}
        label="CPU, fleet average"
        value={formatPercent(fleet.cpu_percent_avg)}
        tone={toneForUsage(fleet.cpu_percent_avg)}
      />
      <MetricTile
        size="sm"
        icon={MemoryStick}
        label="Memory"
        value={formatPercent(memoryPercent)}
        unit={`of ${byteLabel(fleet.memory_total)}`}
        tone={toneForUsage(memoryPercent)}
      />
      <MetricTile
        size="sm"
        icon={HardDrive}
        label="Disk"
        value={formatPercent(diskPercent)}
        unit={`of ${byteLabel(fleet.disk_total)}`}
        tone={toneForUsage(diskPercent)}
      />
      <MetricTile
        size="sm"
        icon={Activity}
        label="Network"
        value={formatRate(fleet.net_rx_rate + fleet.net_tx_rate)}
      />
      <MetricTile
        size="sm"
        icon={Siren}
        label="Open alerts"
        value={formatCount(fleet.open_alerts)}
        tone={fleet.open_alerts > 0 ? "warn" : "neutral"}
      />
      <MetricTile
        size="sm"
        icon={ShieldAlert}
        label="Blocked, 24h"
        value={formatCount(threats.blocked)}
        tone={threats.blocked > 0 ? "info" : "neutral"}
      />
    </div>
  );
}

function toneForUsage(percent: number): Tone {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warn";
  return "neutral";
}

function byteLabel(total: number): string {
  return formatBytes(total, "binary", 0);
}

/* --------------------------- attention list ------------------------- */

interface AttentionListProps {
  items: readonly Attention[];
  loading: boolean;
  failed: boolean;
}

function AttentionList({ items, loading, failed }: AttentionListProps) {
  const critical = items.filter((item) => item.severity === "critical").length;

  return (
    <SectionCard
      title="Needs attention"
      icon={ShieldAlert}
      padded={false}
      actions={
        items.length > 0 && (
          <Badge tone={critical > 0 ? "danger" : "warn"} size="xs">
            {critical > 0
              ? `${formatCount(critical)} critical`
              : `${formatCount(items.length)} open`}
          </Badge>
        )
      }
    >
      {loading && (
        <ul>
          {[0, 1, 2].map((index) => (
            <li
              key={index}
              className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2.5 last:border-b-0"
            >
              <Skeleton className="h-4 w-4 rounded-[var(--kn-r-xs)]" />
              <Skeleton className="h-3 w-64" />
              <Skeleton className="ml-auto h-3 w-16" />
            </li>
          ))}
        </ul>
      )}

      {!loading && !failed && items.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="Nothing needs you"
          description="Every agent is reporting, no threshold is breached and no job is failing."
          size="sm"
        />
      )}

      {!loading && items.length > 0 && (
        <ul>
          {items.map((item, index) => (
            <AttentionRow key={`${item.kind}-${item.server_id ?? "fleet"}-${index}`} item={item} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AttentionRow({ item }: { item: Attention }) {
  const Icon = ATTENTION_ICONS[item.kind];
  const tone = SEVERITY_TONE[item.severity];

  return (
    <li className="border-b border-[var(--kn-border-subtle)] last:border-b-0">
      <Link
        href={item.href}
        className={cn(
          "group/attention flex items-start gap-3 px-4 py-2.5 outline-none",
          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          "hover:bg-[var(--kn-surface-2)]",
        )}
      >
        <span
          className={cn(
            "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--kn-r-xs)]",
            tone === "danger" && "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
            tone === "warn" && "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)]",
            tone === "info" && "bg-[var(--kn-info-soft)] text-[var(--kn-info)]",
          )}
        >
          <Icon size={12} aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-[var(--kn-text)]">{item.title}</p>
          <p className="mt-0.5 text-[var(--kn-text-2)]">{item.detail}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {item.server_name && (
            <MonoText muted className="hidden text-sm sm:inline">
              {item.server_name}
            </MonoText>
          )}
          <RelativeTime value={item.since} className="text-xs text-[var(--kn-text-3)]" />
          <ArrowRight
            size={12}
            className="text-[var(--kn-text-3)] opacity-0 transition-opacity duration-[var(--kn-dur-fast)] group-hover/attention:opacity-100"
            aria-hidden
          />
        </div>
      </Link>
    </li>
  );
}

/* ----------------------------- fleet table -------------------------- */

function FleetTable({ query }: { query: ReturnType<typeof useServers> }) {
  const router = useRouter();
  const rows = query.data?.data ?? [];

  const columns = React.useMemo<DataTableColumn<Server>[]>(
    () => [
      {
        id: "name",
        header: "Server",
        locked: true,
        minWidth: 180,
        cell: (server) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-[var(--kn-text)]">{server.name}</span>
            {server.simulated && (
              <Badge tone="info" size="xs">
                sim
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "hostname",
        header: "Hostname",
        mono: true,
        minWidth: 160,
        hideBelow: "lg",
        accessor: (server) => server.hostname,
      },
      {
        id: "connection",
        header: "Agent",
        width: 132,
        cell: (server) => (
          <AgentConnectionIndicator connection={server.connection} since={server.last_seen_at} />
        ),
      },
      {
        id: "health",
        header: "Health",
        width: 104,
        cell: (server) => (
          <HealthBadge
            health={server.health}
            reasons={server.health_reasons}
            since={server.latest?.sampled_at ?? null}
          />
        ),
      },
      {
        id: "cpu",
        header: "CPU",
        width: 72,
        align: "right",
        hideBelow: "md",
        cell: (server) => <Usage percent={server.latest?.cpu_percent ?? null} />,
      },
      {
        id: "memory",
        header: "Mem",
        width: 72,
        align: "right",
        hideBelow: "md",
        cell: (server) => (
          <Usage
            percent={
              server.latest
                ? percentOf(server.latest.memory_used, server.latest.memory_total)
                : null
            }
          />
        ),
      },
      {
        id: "disk",
        header: "Disk",
        width: 72,
        align: "right",
        hideBelow: "md",
        cell: (server) => <Usage percent={worstDisk(server)} />,
      },
      {
        id: "load1",
        header: "Load",
        width: 72,
        align: "right",
        mono: true,
        hideBelow: "lg",
        accessor: (server) => formatLoad(server.latest?.load1 ?? null),
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
        id: "last_seen_at",
        header: "Last seen",
        width: 104,
        align: "right",
        cell: (server) => <RelativeTime value={server.last_seen_at} />,
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Fleet"
      icon={ServerIcon}
      padded={false}
      actions={
        <Link
          href="/infrastructure/servers"
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          All servers
        </Link>
      }
    >
      <DataTable<Server>
        columns={columns}
        rows={rows}
        getRowId={(server) => server.id}
        label="Fleet"
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={5}
        onRowClick={(server) => router.push(`/infrastructure/servers/${server.id}`)}
        error={
          query.isError ? (
            <PageError error={query.error} onRetry={() => void query.refetch()} context="Fleet" />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={ServerIcon}
            title="No servers yet"
            description="Kaname manages hosts through an agent that dials out. Add a server to get its enrollment command."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

function worstDisk(server: Server): number | null {
  const disks = server.latest?.disks ?? [];
  if (disks.length === 0) return null;
  return disks.reduce((worst, disk) => Math.max(worst, disk.used_percent), 0);
}

function Usage({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="text-[var(--kn-text-3)]">—</span>;
  const tone = toneForUsage(percent);
  return (
    <span
      className={cn(
        "kn-num",
        tone === "danger" && "text-[var(--kn-danger)]",
        tone === "warn" && "text-[var(--kn-warn)]",
      )}
    >
      {formatPercent(percent)}
    </span>
  );
}

/* --------------------------- recent activity ------------------------ */

type ActivityEntry =
  | { kind: "job"; ts: string; id: string; job: DashboardSummary["recent_jobs"][number] }
  | { kind: "audit"; ts: string; id: string; audit: DashboardSummary["recent_audit"][number] };

function RecentActivity({
  summary,
  loading,
}: {
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  const entries = React.useMemo<ActivityEntry[]>(() => {
    if (!summary) return [];
    const jobs: ActivityEntry[] = summary.recent_jobs.map((job) => ({
      kind: "job",
      ts: job.finished_at ?? job.started_at ?? job.created_at,
      id: `job-${job.id}`,
      job,
    }));
    const audit: ActivityEntry[] = summary.recent_audit.map((event) => ({
      kind: "audit",
      ts: event.ts,
      id: `audit-${event.id}`,
      audit: event,
    }));
    return [...jobs, ...audit]
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, 14);
  }, [summary]);

  return (
    <SectionCard
      title="Recent activity"
      icon={ListChecks}
      padded={false}
      className="lg:col-span-2"
      actions={
        <Link
          href="/security/audit"
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Audit trail
        </Link>
      }
    >
      {loading && (
        <ul>
          {[0, 1, 2, 3, 4].map((index) => (
            <li
              key={index}
              className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
            >
              <Skeleton className="h-4 w-16 rounded-[var(--kn-r-pill)]" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-12" />
            </li>
          ))}
        </ul>
      )}

      {!loading && entries.length === 0 && (
        <EmptyState
          icon={ListChecks}
          title="Nothing has happened yet"
          description="Jobs and audit events land here as they run."
          size="sm"
        />
      )}

      <ul>
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
          >
            {entry.kind === "job" ? (
              <>
                <JobStatusPill status={entry.job.status} size="xs" showLabel={false} />
                <Link
                  href={`/jobs/${entry.job.id}`}
                  className="min-w-0 flex-1 truncate text-[var(--kn-text)] outline-none hover:underline"
                >
                  {entry.job.label}
                  {entry.job.target_label && (
                    <MonoText muted className="ml-1.5 text-sm">
                      {entry.job.target_label}
                    </MonoText>
                  )}
                </Link>
              </>
            ) : (
              <>
                <Badge tone="neutral" size="xs" mono>
                  {entry.audit.actor_type}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-[var(--kn-text-2)]">
                  <span className="text-[var(--kn-text)]">{entry.audit.actor_name}</span>{" "}
                  {humanize(entry.audit.action).toLowerCase()}
                  {entry.audit.target_label && (
                    <MonoText muted className="ml-1.5 text-sm">
                      {entry.audit.target_label}
                    </MonoText>
                  )}
                </span>
              </>
            )}

            <span className="hidden shrink-0 text-xs text-[var(--kn-text-3)] sm:block">
              {entry.kind === "job" ? entry.job.server_name : entry.audit.server_name}
            </span>
            <RelativeTime value={entry.ts} className="shrink-0 text-xs text-[var(--kn-text-3)]" />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/* ------------------------- certificates / backups -------------------- */

function ExpiringCertificates({
  summary,
  loading,
}: {
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  const certificates = summary?.certificates_expiring ?? [];

  return (
    <SectionCard
      title="Certificates expiring"
      icon={ShieldCheck}
      padded={false}
      actions={
        <Link
          href="/websites/ssl"
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          SSL / TLS
        </Link>
      }
    >
      {loading && <Skeleton className="m-4 h-3 w-40" label="Loading certificates" />}

      {!loading && certificates.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="Nothing expiring"
          description="No certificate is inside its renewal window."
          size="sm"
        />
      )}

      <ul>
        {certificates.map((certificate) => (
          <li
            key={certificate.id}
            className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
          >
            <MonoText truncate className="min-w-0 flex-1 text-[var(--kn-text)]">
              {certificate.subject}
            </MonoText>
            <Badge
              tone={
                certificate.days_left <= 7
                  ? "danger"
                  : certificate.days_left <= 21
                    ? "warn"
                    : "neutral"
              }
              size="xs"
            >
              {certificate.days_left < 0 ? "expired" : formatDaysLeft(certificate.days_left)}
            </Badge>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function BackupHealth({
  summary,
  loading,
}: {
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  const backups = summary?.backups;

  return (
    <SectionCard
      title="Backup health"
      icon={Archive}
      actions={
        <Link
          href="/backups"
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Backups
        </Link>
      }
    >
      {loading && <Skeleton className="h-3 w-40" label="Loading backup health" />}

      {!loading && backups && (
        <dl className="flex flex-col gap-2">
          <Row label="Last successful run">
            {backups.last_success_at ? (
              <RelativeTime value={backups.last_success_at} />
            ) : (
              <span className="text-[var(--kn-warn)]">never</span>
            )}
          </Row>
          <Row label="Failing schedules">
            <span
              className={cn(
                "kn-num",
                backups.failing_schedules > 0 ? "text-[var(--kn-danger)]" : "text-[var(--kn-text)]",
              )}
            >
              {formatCount(backups.failing_schedules)}
            </span>
          </Row>
          <Row label="Protected data">
            <ByteSize bytes={backups.protected_bytes} />
          </Row>
        </dl>
      )}
    </SectionCard>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--kn-text-2)]">{label}</dt>
      <dd className="min-w-0 truncate text-[var(--kn-text)]">{children}</dd>
    </div>
  );
}
