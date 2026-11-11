"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Ban, EyeOff, List, ShieldAlert, ShieldOff, Undo2 } from "lucide-react";
import {
  cidr as cidrSchema,
  ipAddress as ipAddressSchema,
  type IpBlock,
  type Job,
  type ThreatEvent,
  type ThreatSummary,
  type TimeRange,
} from "@kaname/contract";
import {
  AreaChart,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  FormField,
  Input,
  MetricTile,
  MonoText,
  NumberedSection,
  RelativeTime,
  SectionCard,
  SectionHeader,
  Select,
  Skeleton,
  StatusBadge,
  StatusLine,
  TIME_RANGE_MS,
  TimeRangePicker,
  type DataTableColumn,
  type DataTableRowAction,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import { ViewTabs } from "@/components/ViewTabs";
import { api, type ApiError } from "@/lib/api";
import {
  queryKeys,
  useCan,
  useList,
  useMutationWithJob,
  useResourceMutation,
  useServers,
} from "@/lib/queries";
import { formatCount, humanize } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Threat protection.
 *
 * Deliberately undramatic. Background SSH scanning is weather: every
 * internet-facing host sees thousands of attempts a day and none of it
 * means anything on its own. A page that celebrates "12,481 attacks
 * blocked!" teaches an operator to stop reading it, which is exactly
 * the habit that loses a machine on the day the number matters.
 *
 * So: counts over a chosen window, a plain timeline, the sources doing
 * the most of it, and the full log. No score, no streak, no siren.
 * ------------------------------------------------------------------ */

const KIND_LABELS: Record<ThreatEvent["kind"], string> = {
  ssh_bruteforce: "SSH brute force",
  web_bruteforce: "Web brute force",
  mail_bruteforce: "Mail brute force",
  port_scan: "Port scan",
  malformed_request: "Malformed request",
  rate_abuse: "Rate abuse",
  known_bad_ip: "Known bad address",
};

const DISPOSITION_TONES: Record<ThreatEvent["disposition"], Tone> = {
  observed: "neutral",
  // Asked for, not yet done by the host: the job decides what comes next.
  pending: "warn",
  banned: "info",
  ignored: "neutral",
};

/*
 * Severity is a reading aid for triage, not a field the host reports:
 * a known-bad address or a brute force that kept going outranks one
 * malformed request. Derived here from kind and volume only, so it can
 * never disagree with the numbers next to it.
 */
type Severity = "high" | "elevated" | "low";

const KIND_WEIGHT: Record<ThreatEvent["kind"], number> = {
  known_bad_ip: 2,
  ssh_bruteforce: 1,
  web_bruteforce: 1,
  mail_bruteforce: 1,
  port_scan: 0,
  malformed_request: 0,
  rate_abuse: 0,
};

const SEVERITY_META: Record<Severity, { tone: Tone; rank: number }> = {
  high: { tone: "danger", rank: 2 },
  elevated: { tone: "warn", rank: 1 },
  low: { tone: "neutral", rank: 0 },
};

function severityOf(kind: ThreatEvent["kind"], attempts: number): Severity {
  const volume = attempts >= 100 ? 2 : attempts >= 20 ? 1 : 0;
  const score = (KIND_WEIGHT[kind] ?? 0) + volume;
  if (score >= 3) return "high";
  if (score >= 2) return "elevated";
  return "low";
}

function SeverityBadge({ kind, attempts }: { kind: ThreatEvent["kind"]; attempts: number }) {
  const severity = severityOf(kind, attempts);
  return (
    <StatusBadge
      tone={SEVERITY_META[severity].tone}
      size="xs"
      title="Derived from the kind of attempt and how many there were."
    >
      {severity}
    </StatusBadge>
  );
}

const DURATION_OPTIONS = [
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "24 hours" },
  { value: "604800", label: "7 days" },
  { value: "0", label: "Until unbanned" },
];

type BanMode = "ban" | "unban" | "ignore";

interface BanTarget {
  ip: string;
  mode: BanMode;
  attempts: number | null;
}

type View = "events" | "bans";

/**
 * Two views over one module: what reached the hosts, and what the hosts
 * are blocking because Kaname asked them to. The second had no page at
 * all — a ban could be made but never seen again, or lifted, without
 * finding the event that prompted it.
 */
export default function ThreatsPage() {
  const searchParams = useSearchParams();
  return searchParams.get("panel") === "bans" ? <BansView /> : <EventsView />;
}

function ThreatTabs({ current, serverId }: { current: View; serverId: string | null }) {
  const pathname = usePathname() ?? "/security/threats";
  const href = (view: View) => {
    const params = new URLSearchParams();
    if (serverId) params.set("server_id", serverId);
    if (view === "bans") params.set("panel", "bans");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  return (
    <ViewTabs
      label="Threat protection views"
      current={current}
      tabs={[
        { id: "events", label: "Events", href: href("events"), icon: ShieldAlert },
        { id: "bans", label: "Bans", href: href("bans"), icon: List },
      ]}
    />
  );
}

function EventsView() {
  const can = useCan();
  const selection = useServerSelection({ permission: "security.threats:read" });
  const serverId = selection.serverId;
  const [banOpen, setBanOpen] = React.useState(false);

  const [range, setRange] = React.useState<TimeRange>("24h");

  /* Pinned when the range changes rather than recomputed per render: a
   * window that slides under the operator makes the summary and the log
   * disagree, and makes every refetch a different query. */
  const since = React.useMemo(
    () => new Date(Date.now() - TIME_RANGE_MS[range]).toISOString(),
    [range],
  );

  const summary = useQuery<ThreatSummary, ApiError>({
    queryKey: queryKeys.sub("threats", serverId ?? "fleet", "summary", { window: range }),
    queryFn: ({ signal }) =>
      api.get<ThreatSummary>("/threats/summary", {
        params: { window: range, server_id: serverId ?? undefined },
        signal,
      }),
    staleTime: 30_000,
  });

  const state = useResourceListState({
    defaultSort: { id: "last_seen", order: "desc" },
    filterKeys: ["kind", "disposition"],
    extraParams: { server_id: serverId ?? undefined, from: since },
  });

  const events = useList<ThreatEvent>("threats", state.params);

  const [target, setTarget] = React.useState<BanTarget | null>(null);
  const mayWrite = can("security.threats:write", serverId);

  const ban = useMutationWithJob<{ ip: string; reason: string; duration: number }>({
    mutationFn: ({ ip, reason, duration }) =>
      api.post<{ job: Job | null; jobs: Job[]; correlation_id: string }>(
        `/threats/${encodeURIComponent(ip)}/ban`,
        { server_id: serverId ?? null, reason, duration_seconds: duration },
      ),
    invalidates: ["threats", "ip-blocks", "firewall"],
    describe: ({ ip }) => `Ban ${ip}`,
    onQueued: () => {
      setTarget(null);
      void summary.refetch();
    },
  });

  const unban = useMutationWithJob<string>({
    mutationFn: (ip) =>
      api.post<{ job: Job | null; jobs: Job[]; correlation_id: string }>(
        `/threats/${encodeURIComponent(ip)}/unban`,
        { server_id: serverId ?? null },
      ),
    invalidates: ["threats", "ip-blocks", "firewall"],
    describe: (ip) => `Unban ${ip}`,
    onQueued: () => {
      setTarget(null);
      void summary.refetch();
    },
  });

  const ignore = useResourceMutation<string, { events_updated: number; note: string }>({
    mutationFn: (ip) =>
      api.post<{ events_updated: number; note: string }>(
        `/threats/${encodeURIComponent(ip)}/ignore`,
        { server_id: serverId ?? null },
      ),
    invalidates: ["threats"],
    successMessage: (result) => result.note,
    onDone: () => {
      setTarget(null);
      void summary.refetch();
    },
  });

  const act = React.useCallback(
    (mode: BanMode, ip: string, attempts: number | null) => setTarget({ ip, mode, attempts }),
    [],
  );

  const columns = React.useMemo<DataTableColumn<ThreatEvent>[]>(
    () => [
      {
        id: "last_seen",
        header: "Last seen",
        sortable: true,
        locked: true,
        width: 116,
        cell: (row) => <RelativeTime value={row.last_seen} />,
      },
      {
        id: "source_ip",
        header: "Source",
        sortable: true,
        mono: true,
        minWidth: 150,
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate>{row.source_ip}</MonoText>
            {row.source_country && (
              <Badge tone="neutral" size="xs" mono>
                {row.source_country}
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "severity",
        header: "Severity",
        width: 96,
        cell: (row) => <SeverityBadge kind={row.kind} attempts={row.attempts} />,
      },
      {
        id: "kind",
        header: "Kind",
        sortable: true,
        width: 168,
        accessor: (row) => KIND_LABELS[row.kind] ?? humanize(row.kind),
      },
      {
        id: "target",
        header: "Target",
        mono: true,
        minWidth: 160,
        hideBelow: "lg",
        accessor: (row) => row.target,
      },
      {
        id: "attempts",
        header: "Attempts",
        sortable: true,
        align: "right",
        width: 96,
        cell: (row) => <span className="kn-num">{formatCount(row.attempts)}</span>,
      },
      {
        id: "disposition",
        header: "Disposition",
        width: 168,
        cell: (row) => (
          <span className="flex min-w-0 flex-col gap-0.5">
            <StatusBadge tone={DISPOSITION_TONES[row.disposition]} size="xs">
              {row.disposition}
            </StatusBadge>
            {/* The host's own reason, kept after the row went back to its
                previous disposition, so a failed ban is not silent. */}
            {row.disposition_error && (
              <span
                className="truncate text-xs text-[var(--kn-danger)]"
                title={row.disposition_error}
              >
                Last change failed: {row.disposition_error}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "server_name",
        header: "Server",
        mono: true,
        width: 132,
        hideBelow: "md",
        accessor: (row) => row.server_name,
      },
      {
        id: "asn",
        header: "Network",
        width: 168,
        hideBelow: "lg",
        accessor: (row) => row.source_asn ?? "—",
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (row: ThreatEvent): DataTableRowAction<ThreatEvent>[] => {
      const writable = can("security.threats:write", row.server_id);
      return [
        {
          id: "ban",
          label: "Ban this address",
          icon: Ban,
          disabled: !writable || row.disposition === "banned" || row.disposition === "pending",
          onSelect: () => act("ban", row.source_ip, row.attempts),
        },
        {
          id: "unban",
          label: "Unban this address",
          icon: Undo2,
          disabled: !writable || row.disposition !== "banned",
          onSelect: () => act("unban", row.source_ip, row.attempts),
        },
        {
          id: "ignore",
          label: "Ignore in Kaname",
          icon: EyeOff,
          separatorBefore: true,
          disabled: !writable || row.disposition === "ignored",
          onSelect: () => act("ignore", row.source_ip, row.attempts),
        },
      ];
    },
    [act, can],
  );

  return (
    <>
      <ResourcePage<ThreatEvent>
        waiting={selection.isLoading}
        eyebrow="Security"
        title="Threat protection"
        lede="Failed logins, scans and abuse the agents saw, ranked so the few that matter stand out. Ban at the host, or ignore in Kaname."
        subtitle={selection.server ? selection.server.hostname : "Every server in your scope"}
        tabs={<ThreatTabs current="events" serverId={serverId} />}
        primaryAction={
          <Button
            variant="primary"
            size="sm"
            icon={Ban}
            disabled={!mayWrite}
            onClick={() => setBanOpen(true)}
          >
            Ban address
          </Button>
        }
        headerActions={
          <TimeRangePicker
            value={{ kind: "preset", preset: range }}
            onChange={(next) => {
              if (next.kind === "preset") setRange(next.preset);
            }}
            allowCustom={false}
            size="sm"
          />
        }
        state={state}
        query={events}
        columns={columns}
        getRowId={(row) => row.id}
        tableLabel="Threat events"
        density="compact"
        searchPlaceholder="Search address, target or kind"
        filters={
          <>
            <Select
              size="sm"
              aria-label="Kind"
              value={state.filters.kind ?? ""}
              onChange={(event) => state.setFilter("kind", event.target.value || null)}
              options={[
                { value: "", label: "Any kind" },
                ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
              ]}
              boxClassName="w-48"
            />
            <Select
              size="sm"
              aria-label="Disposition"
              value={state.filters.disposition ?? ""}
              onChange={(event) => state.setFilter("disposition", event.target.value || null)}
              options={[
                { value: "", label: "Any disposition" },
                { value: "observed", label: "observed" },
                { value: "pending", label: "pending" },
                { value: "banned", label: "banned" },
                { value: "ignored", label: "ignored" },
              ]}
              boxClassName="w-44"
            />
          </>
        }
        selectable
        bulkActions={(ids) => {
          const rows = (events.data?.data ?? []).filter((row) => ids.includes(row.id));
          const addresses = [...new Set(rows.map((row) => row.source_ip))];
          return (
            <>
              <Button
                variant="secondary"
                size="xs"
                icon={Ban}
                disabled={!mayWrite || addresses.length !== 1}
                title={
                  addresses.length === 1
                    ? undefined
                    : "Ban acts on one address at a time so the reason and duration stay accurate."
                }
                onClick={() => addresses[0] && act("ban", addresses[0], null)}
              >
                Ban address
              </Button>
              <Button
                variant="ghost"
                size="xs"
                icon={EyeOff}
                disabled={!mayWrite || addresses.length !== 1}
                onClick={() => addresses[0] && act("ignore", addresses[0], null)}
              >
                Ignore address
              </Button>
            </>
          );
        }}
        rowActions={rowActions}
        emptyIcon={ShieldOff}
        emptyTitle="Nothing recorded in this window"
        emptyDescription="No authentication failures, scans or rate abuse reached the panel for this range. That is the normal state for a host behind a tight firewall."
        errorContext="Threat events"
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll />
        </div>

        {summary.isError && (
          <PageError
            error={summary.error}
            onRetry={() => void summary.refetch()}
            context="Threat summary"
          />
        )}

        {summary.isLoading && <SummarySkeleton />}

        {summary.data && (
          <div className="flex shrink-0 flex-col gap-6">
            <NumberedSection
              index={1}
              title="At a glance"
              caption={`Every attempt in the last ${range}.`}
            >
              <ThreatStatus summary={summary.data} range={range} />
              <SummaryStrip summary={summary.data} range={range} />
            </NumberedSection>
            <TimelineCard summary={summary.data} range={range} />
            <TopSources
              summary={summary.data}
              canWrite={mayWrite}
              onAct={(mode, ip, attempts) => act(mode, ip, attempts)}
            />
            <SectionHeader
              index={4}
              title="Events"
              caption="One row per source, kind and target; newest first."
              className="-mb-2"
            />
          </div>
        )}
      </ResourcePage>

      <ActionDialog
        target={target}
        pending={ban.isPending || unban.isPending || ignore.isPending}
        scope={selection.server?.name ?? null}
        onClose={() => setTarget(null)}
        onBan={(reason, duration) => target && ban.mutate({ ip: target.ip, reason, duration })}
        onUnban={() => target && unban.mutate(target.ip)}
        onIgnore={() => target && ignore.mutate(target.ip)}
      />

      <BanAddressDialog
        open={banOpen}
        defaultServerId={serverId}
        onClose={() => setBanOpen(false)}
        onQueued={() => void summary.refetch()}
      />
    </>
  );
}

/* ------------------------------ summary ----------------------------- */

function SummarySkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton
            key={index}
            className="h-16 rounded-[var(--kn-r-lg)]"
            label={index === 0 ? "Loading threat summary" : undefined}
          />
        ))}
      </div>
      <Skeleton className="h-48 rounded-[var(--kn-r-lg)]" />
    </div>
  );
}

/** The page's condition in one sentence: calm when it is calm. */
function ThreatStatus({ summary, range }: { summary: ThreatSummary; range: TimeRange }) {
  if (summary.total_attempts === 0) {
    return <StatusLine tone="ok">Quiet — nothing recorded in the last {range}.</StatusLine>;
  }
  const worst = summary.top_sources.reduce<Severity>((acc, source) => {
    const next = severityOf(source.kind, source.attempts);
    return SEVERITY_META[next].rank > SEVERITY_META[acc].rank ? next : acc;
  }, "low");
  const unbannedHigh = summary.top_sources.filter(
    (source) => !source.banned && severityOf(source.kind, source.attempts) === "high",
  ).length;
  const tone: Tone = unbannedHigh > 0 ? "danger" : worst === "elevated" ? "warn" : "info";
  return (
    <StatusLine tone={tone}>
      {formatCount(summary.total_attempts)} attempts from {formatCount(summary.unique_sources)}{" "}
      {summary.unique_sources === 1 ? "source" : "sources"}
      {unbannedHigh > 0
        ? ` · ${formatCount(unbannedHigh)} high-severity ${unbannedHigh === 1 ? "source is" : "sources are"} not banned`
        : ` · ${formatCount(summary.banned_count)} banned`}
    </StatusLine>
  );
}

function SummaryStrip({ summary, range }: { summary: ThreatSummary; range: TimeRange }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <MetricTile
        size="sm"
        label={`Attempts, last ${range}`}
        value={formatCount(summary.total_attempts)}
      />
      <MetricTile size="sm" label="Unique sources" value={formatCount(summary.unique_sources)} />
      <MetricTile
        size="sm"
        label="Currently banned"
        value={formatCount(summary.banned_count)}
        tone={summary.banned_count > 0 ? "info" : "neutral"}
      />
    </div>
  );
}

function TimelineCard({ summary, range }: { summary: ThreatSummary; range: TimeRange }) {
  const series = React.useMemo(
    () => [
      {
        id: "attempts",
        label: "Attempts",
        color: "var(--kn-chart-2)",
        data: summary.timeline.map((point) => ({ x: Date.parse(point.ts), y: point.attempts })),
      },
      {
        id: "banned",
        label: "From banned sources",
        color: "var(--kn-chart-1)",
        data: summary.timeline.map((point) => ({ x: Date.parse(point.ts), y: point.banned })),
      },
    ],
    [summary.timeline],
  );

  const byKind = [...summary.by_kind].sort((a, b) => b.count - a.count);

  return (
    <SectionCard
      index={2}
      title="Over time"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {byKind.map((entry) => (
            <Badge key={entry.kind} tone="neutral" size="xs">
              {KIND_LABELS[entry.kind] ?? humanize(entry.kind)} · {formatCount(entry.count)}
            </Badge>
          ))}
        </div>
      }
    >
      <AreaChart
        series={series}
        title={`Attempts over the last ${range}`}
        description="Counts per bucket. Attempts from sources Kaname has banned are drawn separately."
        height={180}
        showLegend
        formatValue={(value) => formatCount(value)}
        emptyLabel="Nothing recorded in this window"
      />
    </SectionCard>
  );
}

/* ---------------------------- top sources --------------------------- */

type TopSource = ThreatSummary["top_sources"][number];

function TopSources({
  summary,
  canWrite,
  onAct,
}: {
  summary: ThreatSummary;
  canWrite: boolean;
  onAct: (mode: BanMode, ip: string, attempts: number) => void;
}) {
  const columns = React.useMemo<DataTableColumn<TopSource>[]>(
    () => [
      {
        id: "ip",
        header: "Address",
        locked: true,
        mono: true,
        minWidth: 160,
        accessor: (row) => row.ip,
      },
      {
        id: "country",
        header: "Country",
        width: 96,
        cell: (row) =>
          row.country ? (
            <MonoText>{row.country}</MonoText>
          ) : (
            <span className="text-[var(--kn-text-3)]">unknown</span>
          ),
      },
      {
        id: "kind",
        header: "Kind",
        width: 176,
        accessor: (row) => KIND_LABELS[row.kind] ?? humanize(row.kind),
      },
      {
        id: "severity",
        header: "Severity",
        width: 96,
        cell: (row) => <SeverityBadge kind={row.kind} attempts={row.attempts} />,
      },
      {
        id: "attempts",
        header: "Attempts",
        align: "right",
        width: 104,
        cell: (row) => <span className="kn-num">{formatCount(row.attempts)}</span>,
      },
      {
        id: "banned",
        header: "Banned",
        width: 96,
        cell: (row) =>
          row.banned ? (
            <StatusBadge tone="info" size="xs">
              banned
            </StatusBadge>
          ) : (
            <span className="text-[var(--kn-text-3)]">no</span>
          ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (row: TopSource): DataTableRowAction<TopSource>[] => [
      {
        id: "ban",
        label: "Ban this address",
        icon: Ban,
        disabled: !canWrite || row.banned,
        onSelect: () => onAct("ban", row.ip, row.attempts),
      },
      {
        id: "unban",
        label: "Unban this address",
        icon: Undo2,
        disabled: !canWrite || !row.banned,
        onSelect: () => onAct("unban", row.ip, row.attempts),
      },
      {
        id: "ignore",
        label: "Ignore in Kaname",
        icon: EyeOff,
        separatorBefore: true,
        disabled: !canWrite,
        onSelect: () => onAct("ignore", row.ip, row.attempts),
      },
    ],
    [canWrite, onAct],
  );

  return (
    <SectionCard
      index={3}
      title="Top sources"
      padded={false}
      footer="Grouped by address and kind over the selected window."
    >
      <DataTable<TopSource>
        columns={columns}
        rows={summary.top_sources}
        getRowId={(row) => `${row.ip}:${row.kind}`}
        label="Top sources"
        density="compact"
        columnVisibility={false}
        rowActions={rowActions}
        empty={
          <EmptyState
            icon={ShieldOff}
            title="No source stands out"
            description="Nothing in this window produced enough attempts to rank."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

/* --------------------------- action dialog -------------------------- */

interface ActionDialogProps {
  target: BanTarget | null;
  pending: boolean;
  /** Null when the action applies to every server in scope. */
  scope: string | null;
  onClose: () => void;
  onBan: (reason: string, duration: number) => void;
  onUnban: () => void;
  onIgnore: () => void;
}

function ActionDialog({
  target,
  pending,
  scope,
  onClose,
  onBan,
  onUnban,
  onIgnore,
}: ActionDialogProps) {
  const [reason, setReason] = React.useState("");
  const [duration, setDuration] = React.useState("86400");

  React.useEffect(() => {
    if (!target) return;
    setReason(
      target.attempts === null
        ? "Repeated authentication failures"
        : `${formatCount(target.attempts)} failed attempts`,
    );
    setDuration("86400");
  }, [target]);

  const where = scope ? scope : "every server in your scope";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      dismissible={!pending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending || !target) return;
          if (target.mode === "ban") onBan(reason, Number(duration));
          else if (target.mode === "unban") onUnban();
          else onIgnore();
        }}
      >
        <DialogHeader
          title={
            target?.mode === "ban"
              ? `Ban ${target.ip}`
              : target?.mode === "unban"
                ? `Unban ${target.ip}`
                : `Ignore ${target?.ip ?? ""}`
          }
          description={
            target?.mode === "ignore"
              ? "This changes nothing on the host. The traffic continues; Kaname stops listing it."
              : `Applied on ${where}. Single addresses are stored as /32 or /128.`
          }
        />
        {target?.mode === "ban" && (
          <DialogBody>
            <div className="flex flex-col gap-4">
              <FormField label="Reason" description="Recorded in the audit trail." required>
                <Input
                  data-autofocus=""
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={200}
                />
              </FormField>
              <FormField label="Duration">
                <Select
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  options={DURATION_OPTIONS}
                />
              </FormField>
            </div>
          </DialogBody>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={target?.mode === "ban" ? "primary" : "secondary"}
            disabled={target?.mode === "ban" && reason.trim().length === 0}
            loading={pending}
          >
            {target?.mode === "ban" ? "Ban" : target?.mode === "unban" ? "Unban" : "Ignore"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ---------------------------- ban address --------------------------- */

const TARGET_MESSAGE =
  "must be an IP address like 203.0.113.7, or a CIDR range like 198.51.100.0/24";

/** What the ban route accepts, so the form refuses exactly what the API would. */
function targetError(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const ok = trimmed.includes("/")
    ? cidrSchema.safeParse(trimmed).success
    : ipAddressSchema.safeParse(trimmed).success;
  return ok ? undefined : TARGET_MESSAGE;
}

interface BanAddressDialogProps {
  open: boolean;
  /** The server picked on the page, offered first; null is fleet-wide. */
  defaultServerId: string | null;
  onClose: () => void;
  onQueued?: () => void;
}

/**
 * Bans any address or range, not only one that already shows up as a
 * threat. Until this, banning an address nobody had observed yet — a
 * range a provider published, a scanner seen elsewhere — was API-only.
 */
function BanAddressDialog({ open, defaultServerId, onClose, onQueued }: BanAddressDialogProps) {
  const can = useCan();
  const servers = useServers();
  const [address, setAddress] = React.useState("");
  const [where, setWhere] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [duration, setDuration] = React.useState("86400");
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setAddress("");
    setWhere(defaultServerId ?? "");
    setReason("");
    setDuration("86400");
    setError(null);
  }, [open, defaultServerId]);

  const ban = useMutationWithJob<{ target: string; serverId: string | null; reason: string; duration: number }>({
    mutationFn: ({ target, serverId, reason: why, duration: seconds }) =>
      api.post<{ job: Job | null; jobs: Job[]; correlation_id: string }>(
        `/threats/${encodeURIComponent(target)}/ban`,
        { server_id: serverId, reason: why, duration_seconds: seconds },
      ),
    invalidates: ["threats", "ip-blocks", "firewall"],
    describe: ({ target }) => `Ban ${target}`,
    toastErrors: false,
    onQueued: () => {
      onClose();
      onQueued?.();
    },
    onFailed: (failure) => setError(failure),
  });

  const addressError = targetError(address);
  const reasonMissing = reason.trim().length === 0;
  const valid = address.trim().length > 0 && !addressError && !reasonMissing;
  const options = [
    { value: "", label: "Every server in your scope" },
    ...(servers.data?.data ?? [])
      .filter((server) => can("security.threats:write", server.id))
      .map((server) => ({ value: server.id, label: server.name })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      dismissible={!ban.isPending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || ban.isPending) return;
          setError(null);
          ban.mutate({
            target: address.trim(),
            serverId: where || null,
            reason: reason.trim(),
            duration: Number(duration),
          });
        }}
      >
        <DialogHeader
          title="Ban an address"
          description="Any address or range, observed or not. Each host blocks it as a job; the ban is listed once the host has done it."
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            {error && <PageError error={error} context="Ban" />}
            <FormField
              label="Address or range"
              description="Single addresses are stored as /32 or /128."
              error={addressError}
              required
            >
              <Input
                data-autofocus=""
                mono
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="203.0.113.7 or 198.51.100.0/24"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
              />
            </FormField>
            <FormField label="Where">
              <Select value={where} onChange={(event) => setWhere(event.target.value)} options={options} />
            </FormField>
            <FormField
              label="Reason"
              description="Recorded in the audit trail."
              error={reason.length > 0 && reasonMissing ? "a reason is required" : undefined}
              required
            >
              <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} />
            </FormField>
            <FormField label="Duration">
              <Select
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
                options={DURATION_OPTIONS}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={ban.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={ban.isPending}>
            Ban
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* -------------------------------- bans ------------------------------ */

const BAN_SOURCE_LABELS: Record<IpBlock["source"], string> = {
  manual: "Kaname",
  fail2ban: "fail2ban",
  rule: "firewall rule",
};

function BansView() {
  const can = useCan();
  const selection = useServerSelection({ permission: "security.threats:read" });
  const serverId = selection.serverId;
  const [banOpen, setBanOpen] = React.useState(false);
  const [lifting, setLifting] = React.useState<IpBlock | null>(null);

  const state = useResourceListState({
    defaultSort: { id: "created_at", order: "desc" },
    extraParams: { server_id: serverId ?? undefined },
  });
  const bans = useList<IpBlock>("ip-blocks", state.params, { path: "/threats/bans" });
  const mayWrite = can("security.threats:write", serverId);

  const unban = useMutationWithJob<IpBlock>({
    mutationFn: (row) =>
      api.post<{ job: Job | null; jobs: Job[]; correlation_id: string }>(
        `/threats/${encodeURIComponent(row.cidr)}/unban`,
        { server_id: row.server_id },
      ),
    invalidates: ["threats", "ip-blocks", "firewall"],
    describe: (row) => `Unban ${row.cidr}`,
    onQueued: () => setLifting(null),
  });

  const columns = React.useMemo<DataTableColumn<IpBlock>[]>(
    () => [
      {
        id: "cidr",
        header: "Address",
        sortable: true,
        locked: true,
        mono: true,
        minWidth: 168,
        accessor: (row) => row.cidr,
      },
      {
        id: "server",
        header: "Server",
        sortable: true,
        mono: true,
        width: 140,
        accessor: (row) => row.server_name ?? "every server",
      },
      {
        id: "reason",
        header: "Reason",
        minWidth: 200,
        cell: (row) => (
          <span className="truncate text-[var(--kn-text-2)]" title={row.reason}>
            {row.reason || "—"}
          </span>
        ),
      },
      {
        id: "source",
        header: "Source",
        width: 112,
        hideBelow: "md",
        accessor: (row) => BAN_SOURCE_LABELS[row.source] ?? row.source,
      },
      {
        id: "created_at",
        header: "Banned",
        sortable: true,
        width: 116,
        cell: (row) => <RelativeTime value={row.created_at} />,
      },
      {
        id: "expires_at",
        header: "Expires",
        sortable: true,
        width: 116,
        cell: (row) =>
          row.expires_at ? (
            <RelativeTime value={row.expires_at} />
          ) : (
            <span className="text-[var(--kn-text-3)]">until unbanned</span>
          ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (row: IpBlock): DataTableRowAction<IpBlock>[] => [
      {
        id: "unban",
        label: "Unban",
        icon: Undo2,
        disabled: !can("security.threats:write", row.server_id ?? undefined),
        onSelect: () => setLifting(row),
      },
    ],
    [can],
  );

  return (
    <>
      <ResourcePage<IpBlock>
        waiting={selection.isLoading}
        eyebrow="Security"
        title="Threat protection"
        lede="Addresses the hosts are refusing right now, whether Kaname, an operator or the host's own jail put them there."
        subtitle={selection.server ? selection.server.hostname : "Every server in your scope"}
        tabs={<ThreatTabs current="bans" serverId={serverId} />}
        primaryAction={
          <Button
            variant="primary"
            size="sm"
            icon={Ban}
            disabled={!mayWrite}
            onClick={() => setBanOpen(true)}
          >
            Ban address
          </Button>
        }
        state={state}
        query={bans}
        columns={columns}
        getRowId={(row) => row.id}
        tableLabel="Active bans"
        density="compact"
        searchPlaceholder="Search address or reason"
        rowActions={rowActions}
        emptyIcon={ShieldOff}
        emptyTitle="Nothing is banned"
        emptyDescription="Bans made from Kaname are listed here once the host has applied them, until they expire or are lifted."
        errorContext="Bans"
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll />
        </div>
      </ResourcePage>

      <Dialog
        open={lifting !== null}
        onOpenChange={(next) => !next && setLifting(null)}
        size="sm"
        dismissible={!unban.isPending}
      >
        <DialogHeader
          title={`Unban ${lifting?.cidr ?? ""}`}
          description={`${lifting?.server_name ?? "Every server"} stops blocking it once the job has run.`}
        />
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={unban.isPending}
            onClick={() => setLifting(null)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={unban.isPending}
            onClick={() => lifting && unban.mutate(lifting)}
          >
            Unban
          </Button>
        </DialogFooter>
      </Dialog>

      <BanAddressDialog
        open={banOpen}
        defaultServerId={serverId}
        onClose={() => setBanOpen(false)}
      />
    </>
  );
}
