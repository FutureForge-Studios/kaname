"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Play, ScrollText, Send, Square } from "lucide-react";
import type { LogLevel, MailLogEntry } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  Drawer,
  DrawerBody,
  DrawerHeader,
  Duration,
  EmptyState,
  Input,
  LogViewer,
  MonoText,
  PageHeader,
  PropertyList,
  PropertyRow,
  RelativeTime,
  SectionCard,
  Select,
  Tab,
  TabList,
  Tabs,
  cn,
  type DataTableColumn,
  type LogLine,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import type { ApiError, QueryParams } from "@/lib/api";
import { formatCount, formatPercent } from "@/lib/format";
import { DELIVERY_STATUSES, useDeliveryBreakdown, useMailLogs } from "../_components/queries";
import {
  DELIVERY_TONE_BG,
  DeliveryStatusBadge,
  DomainPicker,
  deliveryLabel,
} from "../_components/status";
import { openMailLogTail, type MailLogLine, type MailTailStatus } from "../_components/tail";

/* ------------------------------------------------------------------ *
 * Mail logs.
 *
 * Two questions, two surfaces. "What happened to that message" is a
 * search over what the control plane has already ingested, and it is
 * answered with filters and a delivery breakdown counted server-side —
 * a breakdown tallied from the fifty rows on screen would describe the
 * page, not the mail flow. "What is happening right now" is a live tail
 * straight off the host, which is a different thing and says so.
 * ------------------------------------------------------------------ */

const RANGES: readonly { value: string; label: string; ms: number | null }[] = [
  { value: "1h", label: "Last hour", ms: 60 * 60_000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60_000 },
  { value: "all", label: "Everything kept", ms: null },
];

/** Quantised so the query key changes once a minute, not once a render. */
function windowStart(range: string): string | undefined {
  const entry = RANGES.find((candidate) => candidate.value === range) ?? RANGES[1];
  if (!entry?.ms) return undefined;
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  return new Date(minute - entry.ms).toISOString();
}

export default function MailLogsPage() {
  const router = useRouter();
  const pathname = usePathname() ?? "/email/logs";
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "tail" ? "tail" : "search";

  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "search") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const tabs = (
    <Tabs value={tab} onValueChange={setTab}>
      <TabList>
        <Tab value="search" icon={ScrollText}>
          Search
        </Tab>
        <Tab value="tail" icon={Send}>
          Live tail
        </Tab>
      </TabList>
    </Tabs>
  );

  return tab === "tail" ? <TailView tabs={tabs} /> : <SearchView tabs={tabs} />;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function SearchView({ tabs }: { tabs: React.ReactNode }) {
  const selection = useServerSelection({ permission: "email.logs:read" });

  const state = useResourceListState({
    defaultSort: { id: "ts", order: "desc" },
    filterKeys: [
      "server_id",
      "mail_domain_id",
      "direction",
      "status",
      "address",
      "queue_id",
      "range",
    ],
  });

  const range = state.filters["range"] ?? "24h";
  const since = windowStart(range);

  const extra = React.useMemo<QueryParams>(() => ({ since }), [since]);
  const params = React.useMemo<QueryParams>(() => {
    const { range: _range, ...rest } = state.params;
    return { ...rest, ...extra };
  }, [extra, state.params]);

  const query = useMailLogs(params);

  /* The breakdown answers "of everything matching these filters, how
   * much landed" — so it deliberately ignores the status filter. */
  const breakdownParams = React.useMemo<QueryParams>(() => {
    const {
      status: _status,
      page: _page,
      per_page: _perPage,
      sort: _sort,
      order: _order,
      ...rest
    } = params;
    return rest;
  }, [params]);
  const breakdown = useDeliveryBreakdown(breakdownParams);

  const [detail, setDetail] = React.useState<MailLogEntry | null>(null);

  const columns = React.useMemo<DataTableColumn<MailLogEntry>[]>(
    () => [
      {
        id: "ts",
        header: "When",
        locked: true,
        sortable: true,
        width: 112,
        cell: (entry) => <RelativeTime value={entry.ts} />,
      },
      {
        id: "from",
        header: "From",
        sortable: true,
        mono: true,
        minWidth: 200,
        cell: (entry) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {entry.from === "" || entry.from === "<>" ? "<> (bounce)" : entry.from}
          </MonoText>
        ),
      },
      {
        id: "to",
        header: "To",
        mono: true,
        minWidth: 200,
        cell: (entry) => (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
              {entry.to[0] ?? "—"}
            </MonoText>
            {entry.to.length > 1 && (
              <span
                className="shrink-0 text-xs text-[var(--kn-text-3)]"
                title={entry.to.slice(1).join("\n")}
              >
                +{entry.to.length - 1}
              </span>
            )}
          </span>
        ),
      },
      {
        id: "subject",
        header: "Subject",
        minWidth: 200,
        hideBelow: "lg",
        cell: (entry) =>
          entry.subject ? (
            <span className="truncate">{entry.subject}</span>
          ) : (
            <span className="text-[var(--kn-text-3)]">not recorded</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 124,
        cell: (entry) => <DeliveryStatusBadge status={entry.status} />,
      },
      {
        id: "relay",
        header: "Relay",
        mono: true,
        width: 180,
        hideBelow: "lg",
        cell: (entry) =>
          entry.relay ? (
            <MonoText muted truncate className="min-w-0">
              {entry.relay}
            </MonoText>
          ) : (
            <span className="text-[var(--kn-text-3)]">—</span>
          ),
      },
      {
        id: "delay_seconds",
        header: "Delay",
        width: 88,
        align: "right",
        hideBelow: "md",
        cell: (entry) => <Duration ms={entry.delay_seconds * 1000} units={1} />,
      },
      {
        id: "dsn",
        header: "DSN",
        width: 72,
        mono: true,
        align: "right",
        hideBelow: "lg",
        cell: (entry) =>
          entry.dsn ? (
            <MonoText muted title={`Delivery status notification code ${entry.dsn}`}>
              {entry.dsn}
            </MonoText>
          ) : (
            <span className="text-[var(--kn-text-3)]">—</span>
          ),
      },
      {
        id: "size_bytes",
        header: "Size",
        sortable: true,
        width: 88,
        align: "right",
        hideBelow: "lg",
        cell: (entry) => <ByteSize bytes={entry.size_bytes} />,
      },
    ],
    [],
  );

  return (
    <>
      <ResourcePage<MailLogEntry>
        title="Mail Logs"
        subtitle={selection.server?.hostname}
        tabs={tabs}
        state={state}
        query={query}
        columns={columns}
        getRowId={(entry) => entry.id}
        tableLabel="Mail transport log"
        density="compact"
        searchPlaceholder="Subject, sender or message text"
        errorContext="Mail logs"
        emptyIcon={ScrollText}
        emptyTitle="Nothing in this window"
        emptyDescription="No message matching these filters passed through in the selected range."
        filters={
          <>
            <Select
              size="sm"
              value={range}
              onChange={(event) => state.setFilter("range", event.target.value)}
              aria-label="Time range"
              boxClassName="w-40"
              options={RANGES.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
            <Select
              size="sm"
              value={state.filters["direction"] ?? ""}
              onChange={(event) => state.setFilter("direction", event.target.value || null)}
              aria-label="Direction"
              boxClassName="w-36"
              options={[
                { value: "", label: "Both ways" },
                { value: "inbound", label: "Inbound" },
                { value: "outbound", label: "Outbound" },
              ]}
            />
            <Select
              size="sm"
              value={state.filters["status"] ?? ""}
              onChange={(event) => state.setFilter("status", event.target.value || null)}
              aria-label="Delivery status"
              boxClassName="w-40"
              options={[
                { value: "", label: "Any outcome" },
                ...DELIVERY_STATUSES.map((status) => ({
                  value: status,
                  label: deliveryLabel(status),
                })),
              ]}
            />
            <FilterInput
              value={state.filters["address"] ?? ""}
              onCommit={(next) => state.setFilter("address", next || null)}
              placeholder="Exact address"
              label="Envelope address"
              width="w-52"
            />
            <FilterInput
              value={state.filters["queue_id"] ?? ""}
              onCommit={(next) => state.setFilter("queue_id", next || null)}
              placeholder="Queue id"
              label="Queue id"
              width="w-36"
            />
          </>
        }
        rowActions={undefined}
        onRowClick={(entry) => setDetail(entry)}
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll allLabel="All servers" />
          <DomainPicker
            value={state.filters["mail_domain_id"] ?? null}
            onChange={(next) => state.setFilter("mail_domain_id", next)}
            allowAll
          />
        </div>

        <DeliveryBreakdownStrip
          counts={breakdown.counts}
          total={breakdown.total}
          loading={breakdown.isLoading}
          failed={breakdown.isError}
          active={state.filters["status"] ?? ""}
          onSelect={(status) =>
            state.setFilter("status", status === state.filters["status"] ? null : status)
          }
        />
      </ResourcePage>

      <EntryDrawer entry={detail} onClose={() => setDetail(null)} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

const FILTER_DEBOUNCE_MS = 300;

interface FilterInputProps {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  label: string;
  width: string;
}

/**
 * These land in the query string, so a keystroke cannot be a request:
 * the value settles first and only then becomes part of the URL every
 * other surface on this page reads.
 */
function FilterInput({ value, onCommit, placeholder, label, width }: FilterInputProps) {
  const [draft, setDraft] = React.useState(value);
  const committed = React.useRef(value);
  const commitRef = React.useRef(onCommit);
  commitRef.current = onCommit;

  React.useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    setDraft(value);
  }, [value]);

  React.useEffect(() => {
    if (draft === committed.current) return;
    const timer = window.setTimeout(() => {
      committed.current = draft;
      commitRef.current(draft);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  return (
    <Input
      size="sm"
      mono
      value={draft}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      boxClassName={width}
      autoComplete="off"
      spellCheck={false}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Delivery breakdown
 * ------------------------------------------------------------------ */

interface BreakdownProps {
  counts: Record<MailLogEntry["status"], number>;
  total: number;
  loading: boolean;
  failed: boolean;
  active: string;
  onSelect: (status: MailLogEntry["status"]) => void;
}

function DeliveryBreakdownStrip({
  counts,
  total,
  loading,
  failed,
  active,
  onSelect,
}: BreakdownProps) {
  if (failed) return null;

  return (
    <SectionCard
      title="Delivery outcomes"
      description="Counted across every message matching these filters, not just the page below."
      padded
    >
      <div className="flex flex-col gap-2">
        <div
          className="flex h-1 w-full overflow-hidden rounded-[var(--kn-r-xs)] bg-[var(--kn-border)]"
          role="img"
          aria-label={
            total === 0
              ? "No messages in this window"
              : DELIVERY_STATUSES.map(
                  (status) => `${deliveryLabel(status)} ${counts[status]}`,
                ).join(", ")
          }
        >
          {total > 0 &&
            DELIVERY_STATUSES.map((status) =>
              counts[status] > 0 ? (
                <span
                  key={status}
                  className={cn("h-full", DELIVERY_TONE_BG[status])}
                  style={{ width: `${(counts[status] / total) * 100}%` }}
                />
              ) : null,
            )}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {DELIVERY_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              aria-pressed={active === status}
              onClick={() => onSelect(status)}
              className={cn(
                "flex items-baseline gap-2 rounded-[var(--kn-r-sm)] px-1.5 py-0.5 outline-none",
                "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                "hover:bg-[var(--kn-surface-2)]",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
                active === status && "bg-[var(--kn-accent-soft)]",
              )}
            >
              <span
                aria-hidden
                className={cn("h-1.5 w-1.5 rounded-[var(--kn-r-pill)]", DELIVERY_TONE_BG[status])}
              />
              <span className="text-[var(--kn-text-2)]">{deliveryLabel(status)}</span>
              {loading ? (
                <span className="kn-num text-[var(--kn-text-3)]">—</span>
              ) : (
                <>
                  <span className="kn-num font-medium text-[var(--kn-text)]">
                    {formatCount(counts[status])}
                  </span>
                  {total > 0 && (
                    <span className="kn-num text-xs text-[var(--kn-text-3)]">
                      {formatPercent((counts[status] / total) * 100)}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * One message
 * ------------------------------------------------------------------ */

function EntryDrawer({ entry, onClose }: { entry: MailLogEntry | null; onClose: () => void }) {
  return (
    <Drawer
      open={entry !== null}
      onOpenChange={(next) => !next && onClose()}
      side="right"
      size="md"
      label="Message detail"
    >
      {entry && (
        <>
          <DrawerHeader
            title={entry.subject ?? "No subject recorded"}
            description={`Queue id ${entry.queue_id || "unknown"}`}
            actions={<DeliveryStatusBadge status={entry.status} />}
          />
          <DrawerBody>
            <PropertyList labelWidth="md">
              <PropertyRow label="When" copyValue={entry.ts}>
                <RelativeTime value={entry.ts} />
              </PropertyRow>
              <PropertyRow label="Direction">
                <Badge tone="neutral" size="xs">
                  {entry.direction}
                </Badge>
              </PropertyRow>
              <PropertyRow label="Envelope from" mono copyValue={entry.from}>
                {entry.from || "<>"}
              </PropertyRow>
              <PropertyRow label="Recipients" mono copyValue={entry.to.join(", ")}>
                <span className="flex flex-col">
                  {entry.to.map((address) => (
                    <span key={address}>{address}</span>
                  ))}
                </span>
              </PropertyRow>
              <PropertyRow label="Relay" mono copyValue={entry.relay ?? undefined}>
                {entry.relay}
              </PropertyRow>
              <PropertyRow
                label="DSN"
                mono
                hint="The delivery status code the receiving side returned."
              >
                {entry.dsn}
              </PropertyRow>
              <PropertyRow label="Delay">
                <Duration ms={entry.delay_seconds * 1000} />
              </PropertyRow>
              <PropertyRow label="Size">
                <ByteSize bytes={entry.size_bytes} />
              </PropertyRow>
              <PropertyRow label="Host" mono>
                {entry.server_name}
              </PropertyRow>
            </PropertyList>

            <div className="mt-4 flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
                Log line
              </h3>
              <pre className="kn-mono overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] p-2 text-[var(--kn-text)]">
                {entry.message}
              </pre>
            </div>
          </DrawerBody>
        </>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ *
 * Live tail
 * ------------------------------------------------------------------ */

const MAX_TAIL_LINES = 5000;
const TAIL_BACKLOG = 200;

const STATUS_LABELS: Record<MailTailStatus, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Stopped",
};

/**
 * Postfix writes one line per event with no severity of its own, so the
 * level is inferred from the outcome the line reports. It is a reading
 * aid, not a claim about the syslog priority — but it is what makes the
 * viewer's level filter able to isolate bounces in a busy relay.
 */
function levelFor(line: string): LogLevel {
  if (/\b(fatal|panic)\b/i.test(line)) return "fatal";
  if (/status=(bounced|expired)|\breject(ed)?\b|\berror\b/i.test(line)) return "error";
  if (/status=deferred|\bwarning\b/i.test(line)) return "warn";
  if (/status=sent/i.test(line)) return "info";
  return "notice";
}

function TailView({ tabs }: { tabs: React.ReactNode }) {
  const selection = useServerSelection({
    permission: "email.logs:read",
    capability: "mail",
    required: true,
  });
  const serverId = selection.serverId;

  const [filter, setFilter] = React.useState("");
  const [applied, setApplied] = React.useState("");
  const [running, setRunning] = React.useState(true);
  const [status, setStatus] = React.useState<MailTailStatus>("closed");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const sequence = React.useRef(0);

  React.useEffect(() => {
    setLines([]);
    setError(null);
    sequence.current = 0;
  }, [serverId, applied]);

  React.useEffect(() => {
    if (!serverId || !running) {
      setStatus("closed");
      return;
    }

    return openMailLogTail({
      serverId,
      lines: TAIL_BACKLOG,
      ...(applied ? { q: applied } : {}),
      onStatusChange: setStatus,
      onError: setError,
      onLine: (record: MailLogLine) => {
        sequence.current += 1;
        const id = `mail-${sequence.current}`;
        setLines((current) => {
          const next = [
            ...current,
            { id, ts: record.ts, level: levelFor(record.line), message: record.line },
          ];
          return next.length > MAX_TAIL_LINES ? next.slice(next.length - MAX_TAIL_LINES) : next;
        });
      },
    });
  }, [applied, running, serverId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Mail Logs"
        subtitle={selection.server?.hostname}
        tabs={tabs}
        actions={
          <Button
            variant={running ? "secondary" : "primary"}
            size="sm"
            icon={running ? Square : Play}
            disabled={!serverId}
            onClick={() => setRunning((current) => !current)}
          >
            {running ? "Stop" : "Start"}
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} />

          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setApplied(filter.trim());
            }}
          >
            <Input
              size="sm"
              mono
              value={filter}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setFilter(event.target.value)
              }
              placeholder="Filter on the host"
              aria-label="Filter the tail on the host"
              boxClassName="w-64"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="secondary" size="sm">
              Apply
            </Button>
            {applied && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilter("");
                  setApplied("");
                }}
              >
                Clear
              </Button>
            )}
          </form>

          <span
            className="ml-auto flex items-center gap-1.5 text-xs text-[var(--kn-text-3)]"
            title="Filtering happens on the host, so a busy relay does not push every line down this socket."
          >
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 rounded-[var(--kn-r-pill)]",
                status === "open"
                  ? "bg-[var(--kn-ok)]"
                  : status === "closed"
                    ? "bg-[var(--kn-text-3)]"
                    : "bg-[var(--kn-warn)] animate-[kn-pulse-ring_1.8s_ease-in-out_infinite]",
              )}
            />
            {STATUS_LABELS[status]}
          </span>
        </div>

        {error && (
          <PageError
            error={error}
            onRetry={() => {
              setError(null);
              setRunning(true);
            }}
            context="Live tail"
          />
        )}

        {!serverId && !selection.isLoading ? (
          <SectionCard>
            <EmptyState
              icon={Send}
              title="No host carries mail"
              description="A live tail reads the transport log off a host running a mail stack, and this account can reach none."
            />
          </SectionCard>
        ) : (
          <LogViewer
            lines={lines}
            height="100%"
            label={`Mail transport log on ${selection.server?.name ?? "the selected host"}`}
            emptyLabel={
              running
                ? "Connected. Nothing has passed through since this tail opened."
                : "The tail is stopped."
            }
            className="min-h-0 flex-1"
          />
        )}
      </div>
    </div>
  );
}
