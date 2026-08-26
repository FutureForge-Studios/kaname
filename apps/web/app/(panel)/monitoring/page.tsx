"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  Activity,
  BellRing,
  Check,
  Cpu,
  Gauge,
  HardDrive,
  LineChart as LineChartIcon,
  MemoryStick,
  Pencil,
  Plus,
  RefreshCw,
  Server as ServerIcon,
  Siren,
  Trash2,
} from "lucide-react";
import type {
  Alert,
  AlertRule,
  MetricName,
  MetricSeries,
  MonitoringOverview,
  TimeRange,
} from "@kaname/contract";
import {
  AgentConnectionIndicator,
  AreaChart,
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  FormField,
  HealthBadge,
  IconButton,
  Input,
  LineChart,
  MetricTile,
  MonoText,
  PageHeader,
  RelativeTime,
  SectionCard,
  Select,
  Skeleton,
  Sparkline,
  StatusBadge,
  Switch,
  Tab,
  TabList,
  Tabs,
  TimeRangePicker,
  cn,
  type ChartSeries,
  type DataTableColumn,
  type TimeRangeValue,
  type Tone,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { api, type ApiError, type ListResult } from "@/lib/api";
import {
  formatBytes,
  formatCount,
  formatLoad,
  formatPercent,
  formatRate,
  formatUptime,
  percentOf,
} from "@/lib/format";
import {
  LIST_STALE_TIME,
  queryKeys,
  useCan,
  useList,
  useResourceMutation,
  useServers,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Monitoring.
 *
 * A cross-server rollup rather than a per-host dashboard: the question
 * is "which box is in trouble", and answering it means seeing all of
 * them on the same axes at the same time. Every chart is therefore
 * multi-series by default and narrows to one host only when the picker
 * says so.
 *
 * Bucketing happens in the control plane, so a 90-day range is the same
 * couple of hundred points as an hour and the browser never receives
 * data it would immediately throw away. The range is a preset rather
 * than an arbitrary window because that is what `/monitoring/series`
 * accepts — offering a custom range the API cannot serve would be a
 * control that lies.
 * ------------------------------------------------------------------ */

const OVERVIEW_REFRESH_MS = 30_000;

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "alerts", label: "Alerts" },
  { value: "rules", label: "Alert rules" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

const METRIC_LABELS: Record<MetricName, string> = {
  cpu: "CPU",
  memory: "Memory",
  swap: "Swap",
  disk: "Disk",
  disk_io: "Disk I/O",
  network_rx: "Network in",
  network_tx: "Network out",
  load1: "Load, 1 minute",
  load5: "Load, 5 minutes",
  load15: "Load, 15 minutes",
  processes: "Processes",
};

const COMPARATOR_LABELS: Record<AlertRule["comparator"], string> = {
  gt: "is above",
  gte: "is at or above",
  lt: "is below",
  lte: "is at or below",
};

const SEVERITY_TONES: Record<AlertRule["severity"], Tone> = {
  info: "info",
  warning: "warn",
  critical: "danger",
};

const ALERT_STATE_TONES: Record<Alert["state"], Tone> = {
  ok: "ok",
  pending: "warn",
  firing: "danger",
  resolved: "neutral",
  silenced: "neutral",
};

const RANGE_PRESETS: readonly TimeRange[] = ["1h", "6h", "24h", "7d", "30d", "90d"];

function isTab(value: string | null): value is TabValue {
  return TABS.some((tab) => tab.value === value);
}

function isRange(value: string | null): value is TimeRange {
  return RANGE_PRESETS.includes(value as TimeRange);
}

export default function MonitoringPage() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab");
  const active: TabValue = isTab(raw) ? raw : "overview";
  const tabs = <MonitoringTabs active={active} />;

  if (active === "alerts") return <AlertsTab tabs={tabs} />;
  if (active === "rules") return <RulesTab tabs={tabs} />;
  return <OverviewTab tabs={tabs} />;
}

function MonitoringTabs({ active }: { active: TabValue }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <Tabs
      value={active}
      onValueChange={(next) => {
        // The range is the one piece of list state worth carrying across
        // tabs — an operator looking at the last hour still is.
        const range = searchParams.get("range");
        const query = new URLSearchParams({ tab: next });
        if (range) query.set("range", range);
        router.replace(`/monitoring?${query.toString()}`, { scroll: false });
      }}
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
 * Series plumbing
 * ------------------------------------------------------------------ */

interface SeriesResponse {
  metric: MetricName;
  range: TimeRange;
  step_seconds: number;
  resolution: "raw" | "5m";
  unit: MetricSeries["unit"];
  series: MetricSeries[];
}

function useSeries(metric: MetricName, range: TimeRange, serverId: string | null, enabled = true) {
  return useQuery<SeriesResponse, ApiError>({
    queryKey: queryKeys.sub("monitoring", "series", metric, { range, server_id: serverId }),
    queryFn: ({ signal }) =>
      api.get<SeriesResponse>("/monitoring/series", {
        params: { metric, range, server_id: serverId ?? undefined },
        signal,
      }),
    staleTime: LIST_STALE_TIME,
    enabled,
  });
}

function toChartSeries(series: readonly MetricSeries[], suffix?: string): ChartSeries[] {
  return series.map((entry) => ({
    id: suffix ? `${entry.server_id}:${suffix}` : entry.server_id,
    label: suffix ? `${entry.server_name} ${suffix}` : entry.server_name,
    data: entry.points.map((point) => ({ x: Date.parse(point.ts), y: point.value })),
  }));
}

function formatterFor(unit: MetricSeries["unit"]): (value: number) => string {
  if (unit === "percent") return (value) => `${Math.round(value)}%`;
  if (unit === "bytes") return (value) => formatBytes(value, "binary", 0);
  if (unit === "bytes_per_second") return (value) => formatRate(value);
  if (unit === "load") return (value) => formatLoad(value);
  return (value) => formatCount(Math.round(value));
}

interface FleetChartProps {
  title: string;
  metric: MetricName;
  range: TimeRange;
  serverId: string | null;
  /** Second metric drawn on the same axes, e.g. network out beside network in. */
  companion?: { metric: MetricName; suffix: string };
  suffix?: string;
  percentScale?: boolean;
}

function FleetChart({
  title,
  metric,
  range,
  serverId,
  companion,
  suffix,
  percentScale = false,
}: FleetChartProps) {
  const primary = useSeries(metric, range, serverId);
  const secondary = useSeries(companion?.metric ?? metric, range, serverId, Boolean(companion));

  const loading = primary.isLoading || (companion ? secondary.isLoading : false);

  const series = React.useMemo<ChartSeries[]>(() => {
    const base = toChartSeries(primary.data?.series ?? [], suffix);
    if (!companion) return base;
    return [...base, ...toChartSeries(secondary.data?.series ?? [], companion.suffix)];
  }, [companion, primary.data, secondary.data, suffix]);

  const unit = primary.data?.unit ?? "count";
  const Chart = series.length > 1 ? LineChart : AreaChart;

  return (
    <SectionCard
      title={title}
      icon={LineChartIcon}
      actions={
        primary.data && (
          <span className="text-xs text-[var(--kn-text-3)]">
            {primary.data.resolution === "raw" ? "raw samples" : "5-minute rollup"}
          </span>
        )
      }
    >
      {primary.isError ? (
        <PageError error={primary.error} onRetry={() => void primary.refetch()} context={title} />
      ) : loading ? (
        <Skeleton className="h-[200px] rounded-[var(--kn-r-sm)]" label={`Loading ${title}`} />
      ) : (
        <Chart
          series={series}
          title={title}
          height={200}
          formatValue={formatterFor(unit)}
          yDomain={percentScale ? [0, 100] : undefined}
          emptyLabel="No samples in this range"
        />
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

function OverviewTab({ tabs }: { tabs: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selection = useServerSelection({ permission: "monitoring.metrics:read" });

  const rangeParam = searchParams.get("range");
  const range: TimeRange = isRange(rangeParam) ? rangeParam : "24h";

  const setRange = React.useCallback(
    (value: TimeRangeValue) => {
      if (value.kind !== "preset") return;
      const next = new URLSearchParams(searchParams.toString());
      next.set("range", value.preset);
      router.replace(`/monitoring?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const overview = useQuery<MonitoringOverview, ApiError>({
    queryKey: queryKeys.sub("monitoring", "overview", "fleet"),
    queryFn: ({ signal }) => api.get<MonitoringOverview>("/monitoring/overview", { signal }),
    staleTime: LIST_STALE_TIME,
    refetchInterval: OVERVIEW_REFRESH_MS,
  });

  const alerts = useList<Alert>(
    "alerts",
    { state: "firing", per_page: 5, sort: "severity", order: "desc" },
    {
      path: "/monitoring/alerts",
    },
  );

  const fleet = overview.data?.fleet;
  const rows = React.useMemo(() => {
    const all = overview.data?.servers ?? [];
    return selection.serverId ? all.filter((row) => row.server_id === selection.serverId) : all;
  }, [overview.data, selection.serverId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Monitoring"
        subtitle={
          fleet
            ? `${formatCount(fleet.servers_connected)}/${formatCount(fleet.servers_total)} agents connected · ${formatCount(fleet.open_alerts)} open alerts`
            : undefined
        }
        tabs={tabs}
        actions={
          <IconButton
            icon={RefreshCw}
            label="Refresh"
            size="sm"
            disabled={overview.isFetching}
            onClick={() => void overview.refetch()}
          />
        }
      />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <TimeRangePicker
            value={{ kind: "preset", preset: range }}
            onChange={setRange}
            presets={RANGE_PRESETS}
            allowCustom={false}
            size="sm"
          />
          <ServerPicker selection={selection} allowAll allLabel="Whole fleet" />
        </div>

        {overview.isError && (
          <PageError
            error={overview.error}
            onRetry={() => void overview.refetch()}
            context="Fleet rollup"
          />
        )}

        {overview.isLoading && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton
                key={index}
                className="h-16 rounded-[var(--kn-r-md)]"
                label={index === 0 ? "Loading fleet rollup" : undefined}
              />
            ))}
          </div>
        )}

        {fleet && <FleetRollup fleet={fleet} />}

        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
          <FleetChart
            title="CPU"
            metric="cpu"
            range={range}
            serverId={selection.serverId}
            percentScale
          />
          <FleetChart
            title="Memory used"
            metric="memory"
            range={range}
            serverId={selection.serverId}
          />
          <FleetChart
            title="Disk, worst filesystem"
            metric="disk"
            range={range}
            serverId={selection.serverId}
            percentScale
          />
          <FleetChart
            title="Network"
            metric="network_rx"
            suffix="in"
            companion={{ metric: "network_tx", suffix: "out" }}
            range={range}
            serverId={selection.serverId}
          />
          <FleetChart
            title="Load average, 1 minute"
            metric="load1"
            range={range}
            serverId={selection.serverId}
          />
        </div>

        <ServerTable rows={rows} loading={overview.isLoading} />

        <OpenAlerts query={alerts} />
      </div>
    </div>
  );
}

function FleetRollup({ fleet }: { fleet: MonitoringOverview["fleet"] }) {
  const memoryPercent = percentOf(fleet.memory_used, fleet.memory_total);
  const diskPercent = percentOf(fleet.disk_used, fleet.disk_total);
  const offline = fleet.servers_total - fleet.servers_connected;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
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
        tone={usageTone(fleet.cpu_percent_avg)}
      />
      <MetricTile
        size="sm"
        icon={MemoryStick}
        label="Memory"
        value={formatPercent(memoryPercent)}
        unit={`of ${formatBytes(fleet.memory_total, "binary", 0)}`}
        tone={usageTone(memoryPercent)}
      />
      <MetricTile
        size="sm"
        icon={HardDrive}
        label="Disk"
        value={formatPercent(diskPercent)}
        unit={`of ${formatBytes(fleet.disk_total, "binary", 0)}`}
        tone={usageTone(diskPercent)}
      />
      <MetricTile
        size="sm"
        icon={Gauge}
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
    </div>
  );
}

function usageTone(percent: number): Tone {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warn";
  return "neutral";
}

type OverviewRow = MonitoringOverview["servers"][number];

function ServerTable({ rows, loading }: { rows: readonly OverviewRow[]; loading: boolean }) {
  const router = useRouter();

  const columns = React.useMemo<DataTableColumn<OverviewRow>[]>(
    () => [
      {
        id: "name",
        header: "Server",
        locked: true,
        minWidth: 160,
        cell: (row) => (
          <span className="truncate font-medium text-[var(--kn-text)]">{row.name}</span>
        ),
      },
      {
        id: "connection",
        header: "Agent",
        width: 132,
        cell: (row) => <AgentConnectionIndicator connection={row.connection} />,
      },
      {
        id: "health",
        header: "Health",
        width: 104,
        cell: (row) => <HealthBadge health={row.health} />,
      },
      {
        id: "trend",
        header: "CPU, 24h",
        width: 120,
        cell: (row) => (
          <Sparkline
            values={row.sparkline}
            height={20}
            area
            label={`CPU on ${row.name} over the last 24 hours`}
          />
        ),
      },
      {
        id: "cpu",
        header: "CPU",
        width: 72,
        align: "right",
        cell: (row) => <Usage percent={row.cpu_percent} />,
      },
      {
        id: "memory",
        header: "Mem",
        width: 72,
        align: "right",
        cell: (row) => <Usage percent={row.memory_percent} />,
      },
      {
        id: "disk",
        header: "Disk",
        width: 72,
        align: "right",
        cell: (row) => <Usage percent={row.disk_percent} />,
      },
      {
        id: "load1",
        header: "Load",
        width: 72,
        align: "right",
        mono: true,
        hideBelow: "md",
        accessor: (row) => formatLoad(row.load1),
      },
      {
        id: "uptime",
        header: "Uptime",
        width: 104,
        align: "right",
        hideBelow: "lg",
        accessor: (row) => formatUptime(row.uptime_seconds),
      },
    ],
    [],
  );

  return (
    <SectionCard title="Per server" icon={ServerIcon} padded={false}>
      <DataTable<OverviewRow>
        columns={columns}
        rows={rows}
        getRowId={(row) => row.server_id}
        label="Per-server metrics"
        density="compact"
        columnVisibility={false}
        loading={loading}
        skeletonRows={5}
        onRowClick={(row) => router.push(`/infrastructure/servers/${row.server_id}`)}
        empty={
          <EmptyState
            icon={ServerIcon}
            title="No servers reporting"
            description="Metrics appear as soon as an enrolled agent starts pushing samples."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

function Usage({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="text-[var(--kn-text-3)]">—</span>;
  const tone = usageTone(percent);
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

function OpenAlerts({ query }: { query: UseQueryResult<ListResult<Alert>, ApiError> }) {
  const rows = query.data?.data ?? [];

  return (
    <SectionCard
      title="Firing alerts"
      icon={Siren}
      padded={false}
      actions={
        <Link
          href="/monitoring?tab=alerts"
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          All alerts
        </Link>
      }
    >
      {query.isError && (
        <div className="p-4">
          <PageError error={query.error} onRetry={() => void query.refetch()} context="Alerts" />
        </div>
      )}

      {query.isLoading && (
        <ul>
          {[0, 1, 2].map((index) => (
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

      {!query.isLoading && !query.isError && rows.length === 0 && (
        <EmptyState
          icon={Check}
          title="Nothing is firing"
          description="Every alert rule in scope is inside its threshold."
          size="sm"
        />
      )}

      <ul>
        {rows.map((alert) => (
          <li
            key={alert.id}
            className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
          >
            <StatusBadge tone={SEVERITY_TONES[alert.severity]} size="xs">
              {alert.severity}
            </StatusBadge>
            <span className="min-w-0 flex-1 truncate text-[var(--kn-text)]">{alert.message}</span>
            {alert.server_name && (
              <MonoText muted className="hidden text-sm sm:inline">
                {alert.server_name}
              </MonoText>
            )}
            <RelativeTime
              value={alert.started_at}
              className="shrink-0 text-xs text-[var(--kn-text-3)]"
            />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

function AlertsTab({ tabs }: { tabs: React.ReactNode }) {
  const can = useCan();
  const servers = useServers();
  const state = useResourceListState({
    defaultSort: { id: "started_at", order: "desc" },
    filterKeys: ["state", "severity", "acknowledged", "server_id"],
  });
  const query = useList<Alert>("alerts", state.params, { path: "/monitoring/alerts" });

  const acknowledge = useResourceMutation<string[], unknown>({
    mutationFn: (ids) =>
      Promise.all(ids.map((id) => api.post(`/monitoring/alerts/${id}/acknowledge`))),
    invalidates: ["alerts"],
    successMessage: (_result, ids) =>
      `${formatCount(ids.length)} alert${ids.length === 1 ? "" : "s"} acknowledged.`,
    onDone: () => state.setSelected([]),
  });

  const columns = React.useMemo<DataTableColumn<Alert>[]>(
    () => [
      {
        id: "severity",
        header: "Severity",
        width: 104,
        locked: true,
        sortable: true,
        cell: (alert) => (
          <StatusBadge tone={SEVERITY_TONES[alert.severity]} size="sm">
            {alert.severity}
          </StatusBadge>
        ),
      },
      {
        id: "state",
        header: "State",
        width: 96,
        sortable: true,
        cell: (alert) => (
          <Badge tone={ALERT_STATE_TONES[alert.state]} size="xs">
            {alert.state}
          </Badge>
        ),
      },
      {
        id: "rule_name",
        header: "Rule",
        minWidth: 160,
        accessor: (alert) => alert.rule_name,
      },
      {
        id: "message",
        header: "Detail",
        minWidth: 220,
        cell: (alert) => (
          <span className="truncate text-[var(--kn-text-2)]" title={alert.message}>
            {alert.message}
          </span>
        ),
      },
      {
        id: "server",
        header: "Server",
        width: 132,
        mono: true,
        hideBelow: "md",
        accessor: (alert) => alert.server_name ?? "fleet",
      },
      {
        id: "value",
        header: "Value",
        width: 112,
        align: "right",
        sortable: true,
        cell: (alert) => (
          <span className="kn-num">
            {formatLoad(alert.value)}
            <span className="text-[var(--kn-text-3)]"> / {formatLoad(alert.threshold)}</span>
          </span>
        ),
      },
      {
        id: "started_at",
        header: "Since",
        width: 112,
        align: "right",
        sortable: true,
        cell: (alert) => <RelativeTime value={alert.started_at} />,
      },
      {
        id: "resolved_at",
        header: "Resolved",
        width: 112,
        align: "right",
        hideBelow: "lg",
        cell: (alert) => <RelativeTime value={alert.resolved_at} fallback="open" />,
      },
    ],
    [],
  );

  return (
    <ResourcePage<Alert>
      title="Monitoring"
      tabs={tabs}
      state={state}
      query={query}
      columns={columns}
      getRowId={(alert) => alert.id}
      tableLabel="Alerts"
      searchPlaceholder="Search alerts"
      density="compact"
      selectable
      errorContext="Alerts"
      emptyIcon={BellRing}
      emptyTitle="No alerts"
      emptyDescription="Alerts appear when a rule's threshold is breached for longer than its duration."
      emptyAction={
        <Link
          href="/monitoring?tab=rules"
          className="text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Open alert rules
        </Link>
      }
      filters={
        <>
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by state"
            value={state.filters.state ?? ""}
            onChange={(event) => state.setFilter("state", event.target.value || null)}
            options={[
              { value: "", label: "Any state" },
              { value: "firing", label: "Firing" },
              { value: "pending", label: "Pending" },
              { value: "resolved", label: "Resolved" },
              { value: "silenced", label: "Silenced" },
              { value: "ok", label: "OK" },
            ]}
          />
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by severity"
            value={state.filters.severity ?? ""}
            onChange={(event) => state.setFilter("severity", event.target.value || null)}
            options={[
              { value: "", label: "Any severity" },
              { value: "critical", label: "Critical" },
              { value: "warning", label: "Warning" },
              { value: "info", label: "Info" },
            ]}
          />
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by acknowledgement"
            value={state.filters.acknowledged ?? ""}
            onChange={(event) => state.setFilter("acknowledged", event.target.value || null)}
            options={[
              { value: "", label: "Acknowledged or not" },
              { value: "false", label: "Not acknowledged" },
              { value: "true", label: "Acknowledged" },
            ]}
          />
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
        </>
      }
      rowActions={(alert) => [
        {
          id: "acknowledge",
          label: "Acknowledge",
          icon: Check,
          disabled:
            alert.acknowledged_by !== null || !can("monitoring.alerts:write", alert.server_id),
          onSelect: () => acknowledge.mutate([alert.id]),
        },
      ]}
      bulkActions={(ids) => (
        <Button
          variant="secondary"
          size="xs"
          icon={Check}
          loading={acknowledge.isPending}
          disabled={!can("monitoring.alerts:write")}
          onClick={() => acknowledge.mutate(ids)}
        >
          Acknowledge
        </Button>
      )}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Alert rules
 * ------------------------------------------------------------------ */

function RulesTab({ tabs }: { tabs: React.ReactNode }) {
  const can = useCan();
  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["enabled", "severity"],
  });
  const query = useList<AlertRule>("alert-rules", state.params, {
    path: "/monitoring/alert-rules",
  });

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<AlertRule | null>(null);
  const [deleting, setDeleting] = React.useState<AlertRule | null>(null);

  const setEnabled = useResourceMutation<{ ids: string[]; enabled: boolean }, unknown>({
    mutationFn: ({ ids, enabled }) =>
      Promise.all(ids.map((id) => api.patch(`/monitoring/alert-rules/${id}`, { enabled }))),
    invalidates: ["alert-rules"],
    successMessage: (_result, { ids, enabled }) =>
      `${formatCount(ids.length)} rule${ids.length === 1 ? "" : "s"} ${enabled ? "enabled" : "disabled"}.`,
    onDone: () => state.setSelected([]),
  });

  const remove = useResourceMutation<AlertRule, void>({
    mutationFn: (rule) => api.del(`/monitoring/alert-rules/${rule.id}`),
    invalidates: ["alert-rules"],
    successMessage: (_result, rule) => `Rule "${rule.name}" deleted.`,
    onDone: () => setDeleting(null),
  });

  const columns = React.useMemo<DataTableColumn<AlertRule>[]>(
    () => [
      {
        id: "name",
        header: "Rule",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (rule) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-[var(--kn-text)]">{rule.name}</span>
            {!rule.enabled && (
              <Badge tone="neutral" size="xs">
                off
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "condition",
        header: "Condition",
        minWidth: 240,
        cell: (rule) => (
          <span className="truncate text-[var(--kn-text-2)]">{describeRule(rule)}</span>
        ),
      },
      {
        id: "severity",
        header: "Severity",
        width: 104,
        sortable: true,
        cell: (rule) => (
          <StatusBadge tone={SEVERITY_TONES[rule.severity]} size="sm">
            {rule.severity}
          </StatusBadge>
        ),
      },
      {
        id: "scope",
        header: "Applies to",
        width: 140,
        cell: (rule) =>
          rule.scope.kind === "fleet" ? (
            <Badge tone="accent" size="xs">
              whole fleet
            </Badge>
          ) : (
            <span className="kn-num text-[var(--kn-text-2)]">
              {formatCount(rule.scope.server_ids.length)} servers
            </span>
          ),
      },
      {
        id: "channels",
        header: "Notifies",
        width: 104,
        align: "right",
        hideBelow: "lg",
        cell: (rule) => (
          <span className="kn-num text-[var(--kn-text-2)]">
            {rule.channels.length === 0 ? "—" : formatCount(rule.channels.length)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <ResourcePage<AlertRule>
        title="Monitoring"
        tabs={tabs}
        state={state}
        query={query}
        columns={columns}
        getRowId={(rule) => rule.id}
        tableLabel="Alert rules"
        searchPlaceholder="Search rules"
        selectable
        onRowClick={(rule) => can("monitoring.alerts:write") && setEditing(rule)}
        errorContext="Alert rules"
        emptyIcon={BellRing}
        emptyTitle="No alert rules"
        emptyDescription="A rule watches one metric against a threshold for a duration, and fires when it stays there."
        primaryAction={
          can("monitoring.alerts:write") && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
              New rule
            </Button>
          )
        }
        emptyAction={
          can("monitoring.alerts:write") && (
            <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
              New rule
            </Button>
          )
        }
        filters={
          <>
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by severity"
              value={state.filters.severity ?? ""}
              onChange={(event) => state.setFilter("severity", event.target.value || null)}
              options={[
                { value: "", label: "Any severity" },
                { value: "critical", label: "Critical" },
                { value: "warning", label: "Warning" },
                { value: "info", label: "Info" },
              ]}
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
        rowActions={(rule) => [
          {
            id: "edit",
            label: "Edit",
            icon: Pencil,
            disabled: !can("monitoring.alerts:write"),
            onSelect: () => setEditing(rule),
          },
          {
            id: "toggle",
            label: rule.enabled ? "Disable" : "Enable",
            icon: BellRing,
            disabled: !can("monitoring.alerts:write"),
            onSelect: () => setEnabled.mutate({ ids: [rule.id], enabled: !rule.enabled }),
          },
          {
            id: "delete",
            label: "Delete",
            icon: Trash2,
            destructive: true,
            separatorBefore: true,
            disabled: !can("monitoring.alerts:write"),
            onSelect: () => setDeleting(rule),
          },
        ]}
        bulkActions={(ids) => (
          <>
            <Button
              variant="secondary"
              size="xs"
              icon={BellRing}
              onClick={() => setEnabled.mutate({ ids, enabled: true })}
            >
              Enable
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setEnabled.mutate({ ids, enabled: false })}
            >
              Disable
            </Button>
          </>
        )}
      />

      <AlertRuleDialog open={creating} onOpenChange={setCreating} />
      <AlertRuleDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        rule={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "rule"}?`}
        description="Alerts already raised by this rule stay in the history. Nothing will fire from it again."
        confirmLabel="Delete rule"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

function describeRule(rule: AlertRule): string {
  const metric = METRIC_LABELS[rule.metric];
  const comparator = COMPARATOR_LABELS[rule.comparator];
  const threshold =
    rule.metric === "cpu" || rule.metric === "disk"
      ? `${rule.threshold}%`
      : formatLoad(rule.threshold);
  const duration =
    rule.duration_seconds >= 60
      ? `${Math.round(rule.duration_seconds / 60)} min`
      : `${rule.duration_seconds}s`;
  return `${metric} ${comparator} ${threshold} for ${duration}`;
}

/* --------------------------- rule editor ---------------------------- */

interface RuleDraft {
  name: string;
  metric: MetricName;
  comparator: AlertRule["comparator"];
  threshold: string;
  durationSeconds: string;
  severity: AlertRule["severity"];
  fleet: boolean;
  serverIds: string[];
  enabled: boolean;
}

function ruleDraft(rule: AlertRule | null): RuleDraft {
  return {
    name: rule?.name ?? "",
    metric: rule?.metric ?? "cpu",
    comparator: rule?.comparator ?? "gt",
    threshold: String(rule?.threshold ?? 90),
    durationSeconds: String(rule?.duration_seconds ?? 300),
    severity: rule?.severity ?? "warning",
    fleet: rule ? rule.scope.kind === "fleet" : true,
    serverIds: rule && rule.scope.kind === "servers" ? [...rule.scope.server_ids] : [],
    enabled: rule?.enabled ?? true,
  };
}

interface AlertRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: AlertRule | null;
}

function AlertRuleDialog({ open, onOpenChange, rule = null }: AlertRuleDialogProps) {
  const editing = rule !== null;
  const servers = useServers();
  const [draft, setDraft] = React.useState<RuleDraft>(() => ruleDraft(rule));
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setDraft(ruleDraft(rule));
    setError(null);
  }, [open, rule]);

  const patch = React.useCallback(
    (next: Partial<RuleDraft>) => setDraft((prev) => ({ ...prev, ...next })),
    [],
  );

  const save = useResourceMutation<void, AlertRule>({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        metric: draft.metric,
        comparator: draft.comparator,
        threshold: Number(draft.threshold),
        duration_seconds: Number(draft.durationSeconds),
        severity: draft.severity,
        scope: draft.fleet
          ? { kind: "fleet" as const }
          : { kind: "servers" as const, server_ids: draft.serverIds },
        enabled: draft.enabled,
      };
      return editing
        ? api.patch<AlertRule>(`/monitoring/alert-rules/${rule.id}`, body)
        : api.post<AlertRule>("/monitoring/alert-rules", body);
    },
    invalidates: ["alert-rules"],
    successMessage: (result) => `Rule "${result.name}" ${editing ? "updated" : "created"}.`,
    onDone: () => onOpenChange(false),
    onFailed: setError,
  });

  const preview: AlertRule = {
    id: rule?.id ?? "preview",
    name: draft.name,
    metric: draft.metric,
    comparator: draft.comparator,
    threshold: Number(draft.threshold) || 0,
    duration_seconds: Number(draft.durationSeconds) || 0,
    severity: draft.severity,
    scope: draft.fleet ? { kind: "fleet" } : { kind: "servers", server_ids: draft.serverIds },
    enabled: draft.enabled,
    channels: rule?.channels ?? [],
    created_at: rule?.created_at ?? new Date().toISOString(),
    updated_at: rule?.updated_at ?? new Date().toISOString(),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" dismissible={!save.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <DialogHeader
          title={editing ? `Edit ${rule.name}` : "New alert rule"}
          description="A rule fires only after its threshold has held for the whole duration, so a single spiky sample does not page anyone."
        />

        <DialogBody>
          {error && error.fieldEntries.length === 0 && (
            <PageError error={error} onRetry={() => save.mutate()} className="mb-4" />
          )}

          <div className="flex flex-col gap-4">
            <FormField label="Name" required error={error?.fields.name}>
              <Input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="Disk nearly full"
                data-autofocus=""
              />
            </FormField>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_128px_112px]">
              <FormField label="Metric" required error={error?.fields.metric}>
                <Select
                  value={draft.metric}
                  onChange={(event) => patch({ metric: event.target.value as MetricName })}
                  options={(Object.keys(METRIC_LABELS) as MetricName[]).map((metric) => ({
                    value: metric,
                    label: METRIC_LABELS[metric],
                  }))}
                />
              </FormField>
              <FormField label="Comparator" required>
                <Select
                  value={draft.comparator}
                  onChange={(event) =>
                    patch({ comparator: event.target.value as AlertRule["comparator"] })
                  }
                  options={(Object.keys(COMPARATOR_LABELS) as AlertRule["comparator"][]).map(
                    (comparator) => ({ value: comparator, label: COMPARATOR_LABELS[comparator] }),
                  )}
                />
              </FormField>
              <FormField label="Threshold" required error={error?.fields.threshold}>
                <Input
                  mono
                  inputMode="decimal"
                  value={draft.threshold}
                  onChange={(event) => patch({ threshold: event.target.value })}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Duration"
                required
                description="Seconds the condition must hold before firing."
                error={error?.fields.duration_seconds}
              >
                <Input
                  mono
                  inputMode="numeric"
                  value={draft.durationSeconds}
                  onChange={(event) => patch({ durationSeconds: event.target.value })}
                />
              </FormField>
              <FormField label="Severity" required>
                <Select
                  value={draft.severity}
                  onChange={(event) =>
                    patch({ severity: event.target.value as AlertRule["severity"] })
                  }
                  options={[
                    { value: "info", label: "Info" },
                    { value: "warning", label: "Warning" },
                    { value: "critical", label: "Critical" },
                  ]}
                />
              </FormField>
            </div>

            <Switch
              checked={draft.fleet}
              onChange={(event) => patch({ fleet: event.target.checked })}
              label="Apply to the whole fleet"
              description="A fleet rule covers servers added later, and needs monitoring.alerts:write across the whole fleet."
            />

            {!draft.fleet && (
              <FormField label="Servers" required error={error?.fields.scope}>
                <Combobox
                  multiple
                  options={
                    servers.data?.data.map((server) => ({
                      value: server.id,
                      label: server.name,
                      description: server.hostname,
                      mono: true,
                    })) ?? []
                  }
                  value={draft.serverIds}
                  onValueChange={(next) => patch({ serverIds: next })}
                  loading={servers.isLoading}
                  placeholder="Select servers"
                  emptyMessage="No server matches that name."
                  mono
                />
              </FormField>
            )}

            <Switch
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
              label="Enabled"
            />

            <div className="rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] p-3">
              <p className="text-2xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
                This rule reads as
              </p>
              <p className="mt-1 text-[var(--kn-text)]">
                {describeRule(preview)} on{" "}
                {draft.fleet
                  ? "every server"
                  : `${formatCount(draft.serverIds.length)} selected server${draft.serverIds.length === 1 ? "" : "s"}`}
                , raising a {draft.severity} alert.
              </p>
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
