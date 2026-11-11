"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  Cpu,
  Gauge,
  HardDrive,
  ListChecks,
  MemoryStick,
  Plus,
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
  Button,
  ByteSize,
  Card,
  DataTable,
  EmptyState,
  HealthBadge,
  IconButton,
  JobStatusPill,
  LeaderLabel,
  MonoLabel,
  MonoText,
  NumberedSection,
  PageBody,
  PageHero,
  RelativeTime,
  Skeleton,
  StatusLine,
  cn,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { GettingStarted } from "@/components/GettingStarted";
import { ModeHome } from "@/components/modes";
import { PageError } from "@/components/PageError";
import { ATTENTION_ICONS, type IconComponent } from "@/lib/icons";
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
import { useCan, useDashboard, useServers, type DashboardSummary } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Command Center.
 *
 * The question this page answers is "what needs me right now", and
 * everything is ordered by how directly it answers that. The opener
 * states the fleet's condition in one sentence beside its pulse (the
 * rollup, as one hairline matrix); then the numbered sections: the
 * attention list — the most important surface in the product — the
 * fleet itself, and the record of what has been happening.
 *
 * No giant metric cards. An operator opens this page dozens of times a
 * day; it should read like an instrument panel, not a quarterly report.
 *
 * The default export takes no props and owns no layout outside its own
 * root, so a mode switch can render it or something else in its place.
 * ------------------------------------------------------------------ */

type Attention = DashboardSummary["attention"][number];
type Severity = Attention["severity"];

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  warning: "warn",
  info: "info",
};

/*
 * The home route. Clients, resellers and operators in Simplified each get
 * their own home from ModeHome; an operator in Advanced gets the Command
 * Center below.
 */
export default function HomePage() {
  return <ModeHome fallback={<CommandCenterPage />} />;
}

function CommandCenterPage() {
  const router = useRouter();
  const can = useCan();
  const dashboard = useDashboard();
  const servers = useServers();

  const summary = dashboard.data;
  const busy = dashboard.isFetching || servers.isFetching;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 py-8">
        <PageHero
          size="md"
          eyebrow="Overview"
          title="Command Center"
          lede="What needs you right now, across every server Kaname manages."
          actions={
            <>
              {can("infra.servers:write") && (
                <Button
                  variant="primary"
                  size="md"
                  icon={Plus}
                  onClick={() => router.push("/infrastructure/servers?new=1")}
                >
                  Add server
                </Button>
              )}
              <Button size="md" arrow onClick={() => router.push("/monitoring")}>
                Open monitoring
              </Button>
              <IconButton
                icon={RefreshCw}
                label="Refresh"
                size="md"
                disabled={busy}
                onClick={() => {
                  void dashboard.refetch();
                  void servers.refetch();
                }}
              />
            </>
          }
          status={
            summary ? (
              <FleetStatus summary={summary} />
            ) : dashboard.isLoading ? (
              <Skeleton className="h-4 w-64" label="Loading fleet status" />
            ) : undefined
          }
          aside={<FleetPulse summary={summary} loading={dashboard.isLoading} />}
        />
      </header>

      <PageBody>
        {dashboard.isError && (
          <PageError
            error={dashboard.error}
            onRetry={() => void dashboard.refetch()}
            context="Command Center"
          />
        )}

        <GettingStarted />

        <AttentionList
          index={1}
          items={summary?.attention ?? []}
          loading={dashboard.isLoading}
          failed={dashboard.isError}
        />

        <FleetTable index={2} query={servers} />

        {/* Siblings, not nested: each block is one <section> with one heading. */}
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-3">
          <RecentActivity index={3} summary={summary} loading={dashboard.isLoading} />
          <div className="flex min-w-0 flex-col gap-6">
            <ExpiringCertificates index={4} summary={summary} loading={dashboard.isLoading} />
            <BackupHealth index={5} summary={summary} loading={dashboard.isLoading} />
          </div>
        </div>
      </PageBody>
    </div>
  );
}

/* ----------------------------- fleet status ------------------------- */

/**
 * The fleet's condition as one sentence. The dot is the worst thing
 * true right now: something critical or unhealthy, then anything open.
 */
function FleetStatus({ summary }: { summary: DashboardSummary }) {
  const { fleet, attention } = summary;
  const offline = fleet.servers_total - fleet.servers_connected;
  const critical = attention.filter((item) => item.severity === "critical").length;

  const tone: Tone =
    critical > 0 || fleet.servers_unhealthy > 0
      ? "danger"
      : offline > 0 || fleet.open_alerts > 0 || attention.length > 0
        ? "warn"
        : "ok";

  return (
    <StatusLine tone={tone} pulse={tone === "ok"}>
      <span>
        {formatCount(fleet.servers_connected)}/{formatCount(fleet.servers_total)} agents connected
      </span>
      {" · "}
      {fleet.open_alerts === 0
        ? "no open alerts"
        : `${formatCount(fleet.open_alerts)} open alert${fleet.open_alerts === 1 ? "" : "s"}`}
      {attention.length > 0 &&
        ` · ${formatCount(attention.length)} item${attention.length === 1 ? "" : "s"} to look at`}
    </StatusLine>
  );
}

/* ----------------------------- fleet pulse -------------------------- */

const VALUE_TONES: Record<Tone, string> = {
  neutral: "text-[var(--kn-text)]",
  ok: "text-[var(--kn-ok)]",
  warn: "text-[var(--kn-warn)]",
  danger: "text-[var(--kn-danger)]",
  info: "text-[var(--kn-info)]",
  accent: "text-[var(--kn-accent-400)]",
};

/**
 * The fleet rollup as one hairline matrix: eight readouts, each a mono
 * label, a numeral and one line of context. It sits in the opener's
 * right column, where the site puts its art — here the art is the data.
 */
function FleetPulse({
  summary,
  loading,
}: {
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  if (!summary && !loading) return null;

  return (
    <Card radius="xl" padding="none" className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--kn-border)] px-4 py-2.5">
        <LeaderLabel className="flex-1">Fleet pulse</LeaderLabel>
      </div>
      {summary ? (
        <FleetRollup summary={summary} />
      ) : (
        <div className="grid grid-cols-2 gap-px bg-[var(--kn-border)] sm:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="bg-[var(--kn-surface)] px-4 py-3.5">
              <Skeleton
                className="h-[58px] rounded-[var(--kn-r-sm)]"
                label={index === 0 ? "Loading fleet summary" : undefined}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function FleetRollup({ summary }: { summary: DashboardSummary }) {
  const { fleet, threats_24h: threats } = summary;
  const memoryPercent = percentOf(fleet.memory_used, fleet.memory_total);
  const diskPercent = percentOf(fleet.disk_used, fleet.disk_total);
  const offline = fleet.servers_total - fleet.servers_connected;

  return (
    <dl className="m-0 grid grid-cols-2 gap-px bg-[var(--kn-border)] sm:grid-cols-4">
      <Readout
        icon={ServerIcon}
        label="Agents"
        value={`${formatCount(fleet.servers_connected)}/${formatCount(fleet.servers_total)}`}
        note={offline > 0 ? `${formatCount(offline)} offline` : "all reporting"}
        tone={offline > 0 ? "warn" : "ok"}
      />
      <Readout
        icon={Activity}
        label="Unhealthy"
        value={formatCount(fleet.servers_unhealthy)}
        note={`of ${formatCount(fleet.servers_total)} servers`}
        tone={fleet.servers_unhealthy > 0 ? "danger" : "neutral"}
      />
      <Readout
        icon={Cpu}
        label="CPU"
        value={formatPercent(fleet.cpu_percent_avg)}
        note="fleet average"
        tone={toneForUsage(fleet.cpu_percent_avg)}
      />
      <Readout
        icon={MemoryStick}
        label="Memory"
        value={formatPercent(memoryPercent)}
        note={`of ${byteLabel(fleet.memory_total)}`}
        tone={toneForUsage(memoryPercent)}
      />
      <Readout
        icon={HardDrive}
        label="Disk"
        value={formatPercent(diskPercent)}
        note={`of ${byteLabel(fleet.disk_total)}`}
        tone={toneForUsage(diskPercent)}
      />
      <Readout
        icon={Gauge}
        label="Network"
        value={formatRate(fleet.net_rx_rate + fleet.net_tx_rate)}
        note="in + out"
      />
      <Readout
        icon={Siren}
        label="Alerts"
        value={formatCount(fleet.open_alerts)}
        note="open now"
        tone={fleet.open_alerts > 0 ? "warn" : "neutral"}
      />
      <Readout
        icon={ShieldAlert}
        label="Blocked"
        value={formatCount(threats.blocked)}
        note="threats, 24h"
        tone={threats.blocked > 0 ? "info" : "neutral"}
      />
    </dl>
  );
}

function Readout({
  icon: Icon,
  label,
  value,
  note,
  tone = "neutral",
}: {
  icon: IconComponent;
  label: string;
  value: string;
  note: string;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0 bg-[var(--kn-surface)] px-4 py-3.5">
      <dt className="flex items-center gap-1.5 text-[var(--kn-text-3)]">
        <Icon size={12} className="shrink-0" aria-hidden />
        <MonoLabel size="xs" className="truncate">
          {label}
        </MonoLabel>
      </dt>
      <dd className="m-0 mt-2.5 min-w-0">
        <span
          className={cn(
            "kn-num block truncate text-xl font-medium leading-none tracking-[var(--kn-tracking-display)]",
            VALUE_TONES[tone],
          )}
        >
          {value}
        </span>
        <span className="kn-mono mt-1.5 block truncate text-xs text-[var(--kn-text-3)]">
          {note}
        </span>
      </dd>
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

/* ------------------------------ shared ------------------------------ */

const ROW_FOCUS =
  "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]";

/** "ALL SERVERS →": the quiet way out of a section, in its header row. */
function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "kn-label-sm group/more inline-flex items-center gap-1.5 rounded-[var(--kn-r-xs)] text-[var(--kn-text-2)]",
        "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)] hover:text-[var(--kn-text)]",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
      )}
    >
      {children}
      <ArrowRight
        size={12}
        className="shrink-0 transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)] group-hover/more:translate-x-0.5 motion-reduce:transition-none"
        aria-hidden
      />
    </Link>
  );
}

/** The hairline card a section's rows sit in. */
function RowCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <Card padding="none" className={cn("overflow-hidden", className)}>
      {children}
    </Card>
  );
}

/* --------------------------- attention list ------------------------- */

interface AttentionListProps {
  index: number;
  items: readonly Attention[];
  loading: boolean;
  failed: boolean;
}

function AttentionList({ index, items, loading, failed }: AttentionListProps) {
  const critical = items.filter((item) => item.severity === "critical").length;

  return (
    <NumberedSection
      index={index}
      title="Needs attention"
      caption="Worst first. Each row opens the thing to fix."
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
      <RowCard>
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
            {items.map((item, position) => (
              <AttentionRow
                key={`${item.kind}-${item.server_id ?? "fleet"}-${position}`}
                item={item}
              />
            ))}
          </ul>
        )}
      </RowCard>
    </NumberedSection>
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
          "group/attention flex items-start gap-3 px-4 py-2.5",
          ROW_FOCUS,
          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease-std)]",
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
          <RelativeTime value={item.since} className="kn-mono text-xs text-[var(--kn-text-3)]" />
          <ArrowRight
            size={12}
            className="text-[var(--kn-text-3)] opacity-0 transition-opacity duration-[var(--kn-dur-fast)] group-hover/attention:opacity-100 group-focus-visible/attention:opacity-100"
            aria-hidden
          />
        </div>
      </Link>
    </li>
  );
}

/* ----------------------------- fleet table -------------------------- */

function FleetTable({ index, query }: { index: number; query: ReturnType<typeof useServers> }) {
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
    <NumberedSection
      index={index}
      title="Fleet"
      caption="Can we reach it, and is it well."
      actions={<SectionLink href="/infrastructure/servers">All servers</SectionLink>}
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
      />
    </NumberedSection>
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
  index,
  summary,
  loading,
}: {
  index: number;
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
    <NumberedSection
      index={index}
      title="Recent activity"
      caption="Jobs and audit events, newest first."
      className="lg:col-span-2"
      actions={<SectionLink href="/security/audit">Audit trail</SectionLink>}
    >
      <RowCard>
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
                    className="min-w-0 flex-1 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-text)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
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

              <span className="kn-mono hidden shrink-0 text-xs text-[var(--kn-text-3)] sm:block">
                {entry.kind === "job" ? entry.job.server_name : entry.audit.server_name}
              </span>
              <RelativeTime
                value={entry.ts}
                className="kn-mono w-16 shrink-0 text-right text-xs text-[var(--kn-text-3)]"
              />
            </li>
          ))}
        </ul>
      </RowCard>
    </NumberedSection>
  );
}

/* ------------------------- certificates / backups -------------------- */

function ExpiringCertificates({
  index,
  summary,
  loading,
}: {
  index: number;
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  const certificates = summary?.certificates_expiring ?? [];

  return (
    <NumberedSection
      index={index}
      title="Certificates expiring"
      actions={<SectionLink href="/websites/ssl">SSL / TLS</SectionLink>}
    >
      <RowCard>
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
      </RowCard>
    </NumberedSection>
  );
}

function BackupHealth({
  index,
  summary,
  loading,
}: {
  index: number;
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  const backups = summary?.backups;

  return (
    <NumberedSection
      index={index}
      title="Backup health"
      actions={<SectionLink href="/backups">Backups</SectionLink>}
    >
      <RowCard>
        {loading && <Skeleton className="m-4 h-3 w-40" label="Loading backup health" />}

        {!loading && backups && (
          <dl className="m-0 flex flex-col">
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
                  backups.failing_schedules > 0
                    ? "text-[var(--kn-danger)]"
                    : "text-[var(--kn-text)]",
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
      </RowCard>
    </NumberedSection>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0">
      <MonoLabel as="dt" size="xs">
        {label}
      </MonoLabel>
      <dd className="m-0 min-w-0 truncate text-[var(--kn-text)]">{children}</dd>
    </div>
  );
}
