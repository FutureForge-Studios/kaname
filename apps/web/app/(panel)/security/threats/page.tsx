"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, EyeOff, ShieldAlert, ShieldOff, Undo2 } from "lucide-react";
import type { Job, ThreatEvent, ThreatSummary, TimeRange } from "@kaname/contract";
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
  RelativeTime,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
  TIME_RANGE_MS,
  TimeRangePicker,
  type DataTableColumn,
  type DataTableRowAction,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import { api, type ApiError } from "@/lib/api";
import { queryKeys, useCan, useList, useMutationWithJob, useResourceMutation } from "@/lib/queries";
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
  banned: "info",
  ignored: "neutral",
};

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

export default function ThreatsPage() {
  const can = useCan();
  const selection = useServerSelection({ permission: "security.threats:read" });
  const serverId = selection.serverId;

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
        width: 112,
        cell: (row) => (
          <StatusBadge tone={DISPOSITION_TONES[row.disposition]} size="xs">
            {row.disposition}
          </StatusBadge>
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
          disabled: !writable || row.disposition === "banned",
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
        title="Threat protection"
        subtitle={selection.server ? selection.server.hostname : "Every server in your scope"}
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
          <>
            <SummaryStrip summary={summary.data} range={range} />
            <TimelineCard summary={summary.data} range={range} />
            <TopSources
              summary={summary.data}
              canWrite={mayWrite}
              onAct={(mode, ip, attempts) => act(mode, ip, attempts)}
            />
          </>
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
            className="h-16 rounded-[var(--kn-r-md)]"
            label={index === 0 ? "Loading threat summary" : undefined}
          />
        ))}
      </div>
      <Skeleton className="h-48 rounded-[var(--kn-r-md)]" />
    </div>
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
      title="Over time"
      icon={ShieldAlert}
      headingLevel={3}
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
      title="Top sources"
      icon={ShieldAlert}
      padded={false}
      headingLevel={3}
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
