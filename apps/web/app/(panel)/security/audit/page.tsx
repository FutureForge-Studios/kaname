"use client";

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Download, FileSearch, Link2, ShieldAlert, ShieldCheck } from "lucide-react";
import type { AuditEvent, AuditVerification } from "@kaname/contract";
import {
  Badge,
  Button,
  CopyButton,
  Drawer,
  DrawerBody,
  DrawerHeader,
  Input,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  Select,
  Skeleton,
  TIME_RANGE_PRESETS,
  TimeRangePicker,
  TruncatedText,
  cn,
  resolveTimeRange,
  type DataTableColumn,
  type DataTableRowAction,
  type TimeRangeValue,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import { api, buildPath, type ApiError, type QueryParams } from "@/lib/api";
import { queryKeys, useJobDrawer, useList } from "@/lib/queries";
import { formatCount, formatDateTime } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Audit trail.
 *
 * The rows are insert-only and hash-chained (KD-009), and the only
 * thing that makes that worth anything is showing it. The banner is a
 * claim the panel can be held to: it names how many events verified,
 * when the walk ran, and — when the chain is broken — the exact event
 * whose hash does not follow from its predecessor.
 *
 * Nothing on this page writes. There is no route that would let it.
 * ------------------------------------------------------------------ */

const ACTOR_TONES: Record<AuditEvent["actor_type"], Tone> = {
  user: "neutral",
  api_key: "info",
  agent: "accent",
  system: "neutral",
};

/** `database.created` -> destructive-looking verbs get a red-ish tint. */
function actionTone(action: string): Tone {
  if (/(deleted|dropped|revoked|removed|banned|purged)$/.test(action)) return "danger";
  if (/(created|added|issued|granted|enrolled)$/.test(action)) return "ok";
  if (/(applied|updated|rotated|confirmed|synced)$/.test(action)) return "info";
  return "neutral";
}

export default function AuditPage() {
  const selection = useServerSelection({ permission: "security.audit:read" });
  const serverId = selection.serverId;
  const jobDrawer = useJobDrawer();

  const [range, setRange] = React.useState<TimeRangeValue>({ kind: "preset", preset: "7d" });

  /* Pinned per range change. A preset sends only `from`, so a refresh
   * still picks up events written since the page was opened. */
  const bounds = React.useMemo(() => {
    const resolved = resolveTimeRange(range);
    return range.kind === "preset"
      ? { from: new Date(resolved.from).toISOString(), to: undefined }
      : { from: new Date(resolved.from).toISOString(), to: new Date(resolved.to).toISOString() };
  }, [range]);

  const state = useResourceListState({
    defaultSort: { id: "ts", order: "desc" },
    defaultPerPage: 100,
    filterKeys: ["actor_type", "action", "target_type"],
    extraParams: { server_id: serverId ?? undefined, from: bounds.from, to: bounds.to },
  });

  const events = useList<AuditEvent>("audit", state.params, { staleTime: 30_000 });

  const verification = useQuery<AuditVerification, ApiError>({
    queryKey: queryKeys.sub("audit", "chain", "verify"),
    queryFn: ({ signal }) => api.get<AuditVerification>("/audit/verify", { signal }),
    staleTime: 5 * 60_000,
  });

  const [opened, setOpened] = React.useState<AuditEvent | null>(null);

  const rows = events.data?.data ?? [];
  const brokenRow = verification.data?.broken_at
    ? rows.find((row) => row.id === verification.data?.broken_at)
    : undefined;

  const exportHref = React.useMemo(() => {
    const params: QueryParams = { ...state.params };
    delete params.page;
    delete params.per_page;
    return buildPath("/audit/export", params);
  }, [state.params]);

  const columns = React.useMemo<DataTableColumn<AuditEvent>[]>(
    () => [
      {
        id: "ts",
        header: "Time",
        sortable: true,
        locked: true,
        width: 132,
        cell: (row) => (
          <span title={formatDateTime(row.ts)}>
            <RelativeTime value={row.ts} />
          </span>
        ),
      },
      {
        id: "actor",
        header: "Actor",
        sortable: true,
        minWidth: 160,
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[var(--kn-text)]">{row.actor_name}</span>
            <Badge tone={ACTOR_TONES[row.actor_type]} size="xs">
              {row.actor_type}
            </Badge>
          </span>
        ),
      },
      {
        id: "action",
        header: "Action",
        sortable: true,
        minWidth: 190,
        cell: (row) => (
          <Badge tone={actionTone(row.action)} size="xs" mono>
            {row.action}
          </Badge>
        ),
      },
      {
        id: "target_type",
        header: "Target",
        sortable: true,
        minWidth: 200,
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate>{row.target_label}</MonoText>
            <span className="shrink-0 text-xs text-[var(--kn-text-3)]">{row.target_type}</span>
          </span>
        ),
      },
      {
        id: "server_name",
        header: "Server",
        mono: true,
        width: 132,
        hideBelow: "md",
        accessor: (row) => row.server_name ?? "fleet",
      },
      {
        id: "ip",
        header: "IP",
        mono: true,
        width: 148,
        hideBelow: "lg",
        accessor: (row) => row.ip ?? "—",
      },
      {
        id: "seq",
        header: "Chain",
        align: "right",
        width: 96,
        hideBelow: "lg",
        cell: (row) => (
          <span
            className={cn(
              "kn-mono text-xs",
              row.id === verification.data?.broken_at
                ? "text-[var(--kn-danger)]"
                : "text-[var(--kn-text-3)]",
            )}
            title={`hash ${row.hash}`}
          >
            {row.hash.slice(0, 8)}
          </span>
        ),
      },
    ],
    [verification.data?.broken_at],
  );

  const rowActions = React.useCallback(
    (row: AuditEvent): DataTableRowAction<AuditEvent>[] => [
      {
        id: "open",
        label: "Open details",
        icon: FileSearch,
        onSelect: () => setOpened(row),
      },
      {
        id: "job",
        label: "Open the job",
        icon: Link2,
        disabled: !row.job_id,
        onSelect: () => {
          if (!row.job_id) return;
          jobDrawer.focusJob(row.job_id);
          jobDrawer.setOpen(true);
        },
      },
      {
        id: "target",
        label: "Filter to this target",
        icon: FileSearch,
        separatorBefore: true,
        onSelect: () => state.setFilter("target_type", row.target_type),
      },
    ],
    [jobDrawer, state],
  );

  return (
    <>
      <ResourcePage<AuditEvent>
        title="Audit"
        subtitle="Append-only and hash-chained. Nothing in the panel can edit or delete a row."
        headerActions={
          <>
            <TimeRangePicker
              value={range}
              onChange={setRange}
              presets={TIME_RANGE_PRESETS}
              size="sm"
            />
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={() => globalThis.location.assign(exportHref)}
            >
              Export
            </Button>
          </>
        }
        state={state}
        query={events}
        columns={columns}
        getRowId={(row) => row.id}
        tableLabel="Audit events"
        density="compact"
        searchPlaceholder="Search action, target or actor"
        filters={
          <>
            <Select
              size="sm"
              aria-label="Actor type"
              value={state.filters.actor_type ?? ""}
              onChange={(event) => state.setFilter("actor_type", event.target.value || null)}
              options={[
                { value: "", label: "Any actor" },
                { value: "user", label: "user" },
                { value: "api_key", label: "api key" },
                { value: "agent", label: "agent" },
                { value: "system", label: "system" },
              ]}
              boxClassName="w-36"
            />
            <FilterInput
              label="Action prefix"
              placeholder="firewall."
              value={state.filters.action ?? ""}
              onCommit={(value) => state.setFilter("action", value || null)}
            />
            <FilterInput
              label="Target type"
              placeholder="database"
              value={state.filters.target_type ?? ""}
              onCommit={(value) => state.setFilter("target_type", value || null)}
            />
          </>
        }
        rowActions={rowActions}
        onRowClick={(row) => setOpened(row)}
        emptyIcon={FileSearch}
        emptyTitle="No event in this window"
        emptyDescription="Nothing was recorded for the selected range, filters and scope. Widen the range to see further back."
        errorContext="Audit trail"
      >
        <ServerPicker selection={selection} allowAll allLabel="Every server" />

        <ChainBanner
          query={verification}
          brokenRow={brokenRow}
          onOpenBroken={() => brokenRow && setOpened(brokenRow)}
        />
      </ResourcePage>

      <EventDrawer
        event={opened}
        onClose={() => setOpened(null)}
        broken={opened !== null && opened.id === verification.data?.broken_at}
        onOpenJob={(jobId) => {
          jobDrawer.focusJob(jobId);
          jobDrawer.setOpen(true);
        }}
      />
    </>
  );
}

/* --------------------------- filter input --------------------------- */

/**
 * Commits on blur and Enter rather than on every keystroke: these land
 * in the query string, and a `router.replace` per character makes the
 * back button useless.
 */
function FilterInput({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => setDraft(value), [value]);

  return (
    <Input
      size="sm"
      mono
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(draft.trim());
        }
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      boxClassName="w-40"
    />
  );
}

/* --------------------------- chain banner --------------------------- */

function ChainBanner({
  query,
  brokenRow,
  onOpenBroken,
}: {
  query: UseQueryResult<AuditVerification, ApiError>;
  brokenRow: AuditEvent | undefined;
  onOpenBroken: () => void;
}) {
  if (query.isError) {
    return (
      <PageError
        error={query.error}
        onRetry={() => void query.refetch()}
        context="Chain verification"
      />
    );
  }

  if (!query.data) {
    return <Skeleton className="h-12 rounded-[var(--kn-r-md)]" label="Verifying the audit chain" />;
  }

  const result = query.data;
  const verified = result.verified;

  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--kn-r-md)] border px-3 py-2",
        verified
          ? "border-[var(--kn-border)] bg-[var(--kn-surface)]"
          : "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]",
      )}
    >
      <span
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)]",
          verified
            ? "bg-[var(--kn-ok-soft)] text-[var(--kn-ok)]"
            : "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
        )}
      >
        {verified ? <ShieldCheck size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />}
      </span>

      <div className="min-w-0 flex-1">
        {verified ? (
          <p className="text-[var(--kn-text)]">
            Chain verified through{" "}
            <span className="kn-num font-medium">{formatCount(result.events_checked)}</span> events,
            last checked <RelativeTime value={result.checked_at} />.
          </p>
        ) : (
          <>
            <p className="font-medium text-[var(--kn-text)]">
              The chain breaks at event <MonoText>{result.broken_at ?? "unknown"}</MonoText>.
            </p>
            <p className="mt-0.5 text-[var(--kn-text-2)]">
              {formatCount(result.events_checked)} events were walked from genesis. Every row before
              that one hashes correctly; that row&apos;s hash does not follow from its predecessor,
              so the trail from it onward cannot be trusted to be complete. Rows are insert-only at
              the database-role level, so this means the table was changed outside the panel.
            </p>
          </>
        )}
        <p className="mt-0.5 text-xs text-[var(--kn-text-3)]">
          {result.first_event_at
            ? `Genesis ${formatDateTime(result.first_event_at)} · latest ${result.last_event_at ? formatDateTime(result.last_event_at) : "—"}`
            : "No event has been recorded yet."}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!verified && result.broken_at && (
          <>
            <CopyButton value={result.broken_at} label="Copy the broken event id" size="sm" />
            {brokenRow && (
              <Button variant="secondary" size="sm" onClick={onOpenBroken}>
                Open it
              </Button>
            )}
          </>
        )}
        <Button
          variant="secondary"
          size="sm"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Verify now
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------- event drawer -------------------------- */

function EventDrawer({
  event,
  broken,
  onClose,
  onOpenJob,
}: {
  event: AuditEvent | null;
  broken: boolean;
  onClose: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <Drawer
      open={event !== null}
      onOpenChange={(next) => !next && onClose()}
      side="right"
      size="lg"
    >
      <DrawerHeader
        title={event ? event.action : "Event"}
        description={event ? `${event.target_type} · ${event.target_label}` : undefined}
        actions={
          broken ? (
            <Badge tone="danger" size="sm">
              chain break
            </Badge>
          ) : undefined
        }
      />
      <DrawerBody>
        {event && (
          <div className="flex flex-col gap-4">
            <PropertyList labelWidth="sm">
              <PropertyRow label="Time" copyValue={event.ts}>
                {formatDateTime(event.ts)}
              </PropertyRow>
              <PropertyRow label="Actor">
                {event.actor_name}{" "}
                <Badge tone={ACTOR_TONES[event.actor_type]} size="xs" className="ml-1">
                  {event.actor_type}
                </Badge>
              </PropertyRow>
              <PropertyRow label="Action" mono copyValue={event.action}>
                {event.action}
              </PropertyRow>
              <PropertyRow label="Target" mono copyValue={event.target_label}>
                {event.target_label}
              </PropertyRow>
              <PropertyRow label="Target id" mono>
                {event.target_id}
              </PropertyRow>
              <PropertyRow label="Server" mono>
                {event.server_name}
              </PropertyRow>
              <PropertyRow label="Source IP" mono copyValue={event.ip ?? undefined}>
                {event.ip}
              </PropertyRow>
              <PropertyRow label="User agent" mono>
                {event.user_agent}
              </PropertyRow>
              <PropertyRow label="Job">
                {event.job_id ? (
                  <button
                    type="button"
                    onClick={() => onOpenJob(event.job_id!)}
                    className="kn-mono rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
                  >
                    {event.job_id}
                  </button>
                ) : null}
              </PropertyRow>
            </PropertyList>

            <DiffView diff={event.diff} />

            {Object.keys(event.metadata).length > 0 && (
              <section>
                <h3 className="mb-2 font-medium text-[var(--kn-text)]">Metadata</h3>
                <pre className="kn-mono overflow-x-auto rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] p-2 text-[var(--kn-text-2)]">
                  {JSON.stringify(event.metadata, null, 2)}
                </pre>
              </section>
            )}

            <section>
              <h3 className="mb-2 font-medium text-[var(--kn-text)]">Chain</h3>
              <PropertyList dense labelWidth="sm">
                <PropertyRow label="Previous" mono copyValue={event.prev_hash}>
                  <TruncatedText value={event.prev_hash} max={40} />
                </PropertyRow>
                <PropertyRow label="This event" mono copyValue={event.hash}>
                  <TruncatedText value={event.hash} max={40} />
                </PropertyRow>
              </PropertyList>
            </section>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}

/* ------------------------------- diff ------------------------------- */

function render(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function DiffView({ diff }: { diff: AuditEvent["diff"] }) {
  if (!diff || (diff.before === null && diff.after === null)) {
    return (
      <section>
        <h3 className="mb-2 font-medium text-[var(--kn-text)]">Change</h3>
        <p className="text-[var(--kn-text-2)]">
          This action recorded no field-level diff. Read-only and fan-out actions carry their detail
          in metadata instead.
        </p>
      </section>
    );
  }

  const before = diff.before ?? {};
  const after = diff.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return (
    <section>
      <h3 className="mb-2 font-medium text-[var(--kn-text)]">Change</h3>
      <div className="overflow-hidden rounded-[var(--kn-r-sm)] border border-[var(--kn-border)]">
        {keys.map((key) => {
          const from = render(before[key]);
          const to = render(after[key]);
          const changed = from !== to;
          return (
            <div
              key={key}
              className="grid grid-cols-1 gap-2 border-t border-[var(--kn-border-subtle)] px-2 py-1.5 first:border-t-0 sm:grid-cols-[140px_minmax(0,1fr)]"
            >
              <span className="kn-mono truncate text-[var(--kn-text-2)]" title={key}>
                {key}
              </span>
              <div className="grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-2">
                <pre
                  className={cn(
                    "kn-mono m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--kn-r-xs)] px-1.5 py-1",
                    changed
                      ? "bg-[var(--kn-danger-soft)] text-[var(--kn-text)]"
                      : "text-[var(--kn-text-3)]",
                  )}
                >
                  {from}
                </pre>
                <pre
                  className={cn(
                    "kn-mono m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--kn-r-xs)] px-1.5 py-1",
                    changed
                      ? "bg-[var(--kn-ok-soft)] text-[var(--kn-text)]"
                      : "text-[var(--kn-text-3)]",
                  )}
                >
                  {to}
                </pre>
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-[var(--kn-text-3)]">
        Left is before, right is after. Secrets are redacted before the row is written, not at
        render time.
      </p>
    </section>
  );
}
