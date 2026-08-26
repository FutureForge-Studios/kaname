"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CircleAlert,
  CircleCheck,
  Info,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { DnsRecord, DnsValidationIssue, Domain, RemediationAction } from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  CopyableCode,
  EmptyState,
  MonoText,
  RelativeTime,
  SectionCard,
  Skeleton,
  cn,
  type ComboboxOption,
  type DataTableRowAction,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { PageError } from "@/components/PageError";
import { formatCount } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { DnsRecordDialog } from "../_components/DnsRecordDialog";
import { useDnsColumns } from "../_components/dnsColumns";
import { DNS_RECORD_TYPES } from "../_components/dnsTypes";
import { FilterSelect } from "../_components/filters";
import {
  useDeleteDnsRecords,
  useDnsRecords,
  useDnsValidation,
  useDomains,
  useReconcileDnsRecord,
  useReconcileDnsRecords,
  useSyncDns,
  type DnsSyncResult,
} from "../_components/queries";
import { DNS_PROVIDER_LABELS } from "../_components/status";

/* ------------------------------------------------------------------ *
 * The DNS record manager.
 *
 * One zone at a time, because that is how DNS is actually reasoned
 * about — and with no zone chosen the table still works, spanning every
 * domain in scope, so "where is that TXT record" is one search away.
 *
 * Two things this page refuses to hide. Drift: a record changed at the
 * provider keeps both values and offers a one-click write-back rather
 * than silently adopting whichever side was read last. And validation:
 * the zone checks run on demand and every finding carries the exact
 * record to publish, copyable, instead of "your DNS is misconfigured".
 * ------------------------------------------------------------------ */

const TYPE_OPTIONS = DNS_RECORD_TYPES.map((type) => ({ value: type, label: type }));

const MANAGED_OPTIONS = [
  { value: "kaname", label: "Managed by Kaname" },
  { value: "external", label: "Found at provider" },
];

const DRIFT_OPTIONS = [
  { value: "true", label: "Drifted only" },
  { value: "false", label: "In sync only" },
];

export default function DnsPage() {
  const router = useRouter();
  const can = useCan();

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["domain_id", "type", "managed_by", "drifted"],
  });

  const domainId = state.filters["domain_id"] ?? null;
  const domains = useDomains({ per_page: 200, sort: "name", order: "asc" });
  const domain = React.useMemo<Domain | null>(
    () => domains.data?.data.find((row) => row.id === domainId) ?? null,
    [domains.data, domainId],
  );

  const query = useDnsRecords(state.params);
  const validation = useDnsValidation(domainId);
  const [syncSummary, setSyncSummary] = React.useState<DnsSyncResult | null>(null);
  const sync = useSyncDns(setSyncSummary);
  const reconcile = useReconcileDnsRecord();
  const reconcileMany = useReconcileDnsRecords();
  const removeRecords = useDeleteDnsRecords();

  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<DnsRecord | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<DnsRecord | null>(null);
  const [pendingBulk, setPendingBulk] = React.useState<DnsRecord[] | null>(null);

  const writable = can("websites.dns:write", domain?.server_id ?? null);
  const canWrite = React.useCallback(
    (record: DnsRecord) => can("websites.dns:write", recordServerId(record, domains.data?.data)),
    [can, domains.data],
  );

  const onReconcile = React.useCallback(
    (record: DnsRecord, direction: "kaname" | "zone") => {
      if (!record.drift) return;
      const content = direction === "kaname" ? record.drift.expected : record.drift.actual;
      if (content === null) return;
      reconcile.mutate({
        id: record.id,
        label: `${record.type} ${record.name}`,
        content,
        direction,
      });
    },
    [reconcile],
  );

  const columns = useDnsColumns({
    onReconcile,
    reconcilingId: reconcile.isPending ? (reconcile.variables?.id ?? null) : null,
    canWrite,
    showDomain: domainId === null,
  });

  const rowActions = React.useCallback(
    (record: DnsRecord): DataTableRowAction<DnsRecord>[] => [
      {
        id: "edit",
        label: "Edit record",
        icon: Pencil,
        disabled: !canWrite(record) || domain === null,
        onSelect: () => setEditing(record),
      },
      {
        id: "adopt",
        label: "Adopt the zone's value",
        icon: RefreshCw,
        disabled: !canWrite(record) || !record.drift || record.drift.actual === null,
        onSelect: () => onReconcile(record, "zone"),
      },
      {
        id: "delete",
        label: "Delete record",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled: !canWrite(record),
        onSelect: () => setPendingDelete(record),
      },
    ],
    [canWrite, domain, onReconcile],
  );

  const domainOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (domains.data?.data ?? []).map((row) => ({
        value: row.id,
        label: row.name,
        description: `${DNS_PROVIDER_LABELS[row.dns_provider]} · ${formatCount(row.record_count)} records`,
        mono: true,
      })),
    [domains.data],
  );

  const handleRemediation = React.useCallback(
    (action: RemediationAction) => {
      if (action.href) {
        router.push(action.href);
        return;
      }
      if (action.action === "dns.sync" && domainId) sync.mutate({ domainId });
    },
    [domainId, router, sync],
  );

  const addRecord = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      disabled={!domain || !writable}
      title={domain ? undefined : "Choose a zone before adding a record."}
      onClick={() => setAdding(true)}
    >
      Add record
    </Button>
  );

  return (
    <>
      <ResourcePage<DnsRecord>
        title="DNS"
        subtitle={domain ? domain.name : "Every zone in scope"}
        primaryAction={addRecord}
        headerActions={
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={sync.isPending}
            disabled={!domain || domain.dns_provider === "manual"}
            title={
              domain
                ? domain.dns_provider === "manual"
                  ? "A manual zone has no API to pull from."
                  : "Re-read the zone from the provider."
                : "Choose a zone to sync."
            }
            onClick={() => domainId && sync.mutate({ domainId })}
          >
            Sync zone
          </Button>
        }
        state={state}
        query={query}
        columns={columns}
        getRowId={(record) => record.id}
        tableLabel="DNS records"
        searchPlaceholder="Search names and values"
        errorContext="DNS records"
        emptyIcon={Network}
        emptyTitle={domain ? "No records in this zone" : "No records yet"}
        emptyDescription={
          domain?.dns_provider === "manual"
            ? "Kaname holds your intended records for a manual zone and shows you the lines to publish."
            : "Sync a zone to pull what the provider already serves, or add the first record here."
        }
        emptyAction={addRecord}
        selectable
        rowActions={rowActions}
        filters={
          <>
            <FilterSelect
              label="Type"
              value={state.filters["type"]}
              onChange={(value) => state.setFilter("type", value)}
              options={TYPE_OPTIONS}
            />
            <FilterSelect
              label="Owner"
              value={state.filters["managed_by"]}
              onChange={(value) => state.setFilter("managed_by", value)}
              options={MANAGED_OPTIONS}
            />
            <FilterSelect
              label="Drift"
              value={state.filters["drifted"]}
              onChange={(value) => state.setFilter("drifted", value)}
              options={DRIFT_OPTIONS}
            />
          </>
        }
        bulkActions={(ids) => {
          const rows = (query.data?.data ?? []).filter((record) => ids.includes(record.id));
          const drifted = rows.filter((record) => record.drift !== null);
          return (
            <>
              {drifted.length > 0 && (
                <Button
                  variant="secondary"
                  size="xs"
                  icon={RefreshCw}
                  loading={reconcileMany.isPending}
                  onClick={() => {
                    reconcileMany.mutate(
                      drifted.map((record) => ({
                        id: record.id,
                        label: `${record.type} ${record.name}`,
                        content: record.drift?.expected ?? record.content,
                        direction: "kaname" as const,
                      })),
                      { onSuccess: () => state.setSelected([]) },
                    );
                  }}
                >
                  Reconcile {formatCount(drifted.length)} drifted
                </Button>
              )}
              <Button
                variant="danger-subtle"
                size="xs"
                icon={Trash2}
                onClick={() => setPendingBulk(rows)}
              >
                Delete {ids.length === 1 ? "record" : `${ids.length} records`}
              </Button>
            </>
          );
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Combobox
            options={domainOptions}
            value={domainId ?? ""}
            onValueChange={(next) =>
              state.setFilter("domain_id", next && next.length > 0 ? next : null)
            }
            placeholder={domainOptions.length === 0 ? "No domains in scope" : "All zones"}
            emptyMessage="No domain matches that name."
            loading={domains.isLoading}
            disabled={domainOptions.length === 0}
            clearable
            mono
            aria-label="Zone"
            className="w-64"
          />
          {domain && (
            <div className="flex flex-wrap items-center gap-2 text-[var(--kn-text-2)]">
              <Badge tone={domain.dns_provider === "manual" ? "neutral" : "info"} size="xs">
                {DNS_PROVIDER_LABELS[domain.dns_provider]}
              </Badge>
              <span>
                {formatCount(domain.record_count)} records · nameservers{" "}
                {domain.nameservers.length > 0 ? (
                  <MonoText muted>{domain.nameservers.join(", ")}</MonoText>
                ) : (
                  "unknown"
                )}
              </span>
            </div>
          )}
        </div>

        {domains.isError && (
          <PageError
            error={domains.error}
            onRetry={() => void domains.refetch()}
            context="Domains"
          />
        )}

        {syncSummary && syncSummary.domain_id === domainId && (
          <SyncSummary summary={syncSummary} onDismiss={() => setSyncSummary(null)} />
        )}

        {domain && (
          <ValidationPanel
            domainName={domain.name}
            query={validation}
            records={query.data?.data ?? []}
            onRemediation={handleRemediation}
            onHighlight={(record) => state.setSearch(record.name)}
          />
        )}
      </ResourcePage>

      {domain && (
        <>
          <DnsRecordDialog open={adding} onOpenChange={setAdding} domain={domain} />
          <DnsRecordDialog
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
            domain={domain}
            record={editing}
          />
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this record?"
        description={
          pendingDelete
            ? `${pendingDelete.type} ${pendingDelete.name} will be removed from the zone.`
            : undefined
        }
        confirmLabel="Delete record"
        loading={removeRecords.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          removeRecords.mutate(
            [{ id: pendingDelete.id, label: `${pendingDelete.type} ${pendingDelete.name}` }],
            { onSuccess: () => setPendingDelete(null) },
          );
        }}
      >
        {pendingDelete && (
          <MonoText className="block break-all text-[var(--kn-text-2)]">
            {pendingDelete.content}
          </MonoText>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingBulk !== null}
        onOpenChange={(open) => !open && setPendingBulk(null)}
        title={`Delete ${formatCount(pendingBulk?.length ?? 0)} records?`}
        description="Each one is removed from the zone at the provider. Records that refuse are reported and left alone."
        confirmText={String(pendingBulk?.length ?? 0)}
        confirmLabel="Delete records"
        loading={removeRecords.isPending}
        onConfirm={() => {
          if (!pendingBulk) return;
          removeRecords.mutate(
            pendingBulk.map((record) => ({
              id: record.id,
              label: `${record.type} ${record.name}`,
            })),
            {
              onSuccess: () => {
                setPendingBulk(null);
                state.setSelected([]);
              },
            },
          );
        }}
      >
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {(pendingBulk ?? []).map((record) => (
            <li key={record.id} className="kn-mono truncate text-[var(--kn-text-2)]">
              {record.type} {record.name}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

/** Domains carry the host a DNS permission is scoped against. */
function recordServerId(record: DnsRecord, domains: Domain[] | undefined): string | null {
  return domains?.find((domain) => domain.id === record.domain_id)?.server_id ?? null;
}

/* ---------------------------- sync summary --------------------------- */

function SyncSummary({ summary, onDismiss }: { summary: DnsSyncResult; onDismiss: () => void }) {
  const counts: [string, number][] = [
    ["created", summary.created],
    ["updated", summary.updated],
    ["adopted", summary.adopted],
    ["drifted", summary.drifted],
    ["removed", summary.removed],
  ];

  return (
    <SectionCard
      title={`${summary.domain_name} synced`}
      icon={RefreshCw}
      headingLevel={3}
      actions={
        <Button variant="ghost" size="xs" onClick={onDismiss}>
          Dismiss
        </Button>
      }
      footer={
        <span>
          Read from {DNS_PROVIDER_LABELS[summary.provider]}{" "}
          <RelativeTime value={summary.checked_at} />
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {counts.map(([label, value]) => (
          <span key={label} className="text-[var(--kn-text-2)]">
            <span
              className={cn(
                "kn-num mr-1 font-medium",
                value > 0 && label === "drifted"
                  ? "text-[var(--kn-warn)]"
                  : "text-[var(--kn-text)]",
              )}
            >
              {formatCount(value)}
            </span>
            {label}
          </span>
        ))}
      </div>

      {summary.unsupported.length > 0 && (
        <p className="mt-2 text-[var(--kn-text-2)]">
          {formatCount(summary.unsupported.length)} record
          {summary.unsupported.length === 1 ? "" : "s"} use a type Kaname does not model and were
          left untouched:{" "}
          <MonoText muted>
            {summary.unsupported.map((entry) => `${entry.type} ${entry.name}`).join(", ")}
          </MonoText>
        </p>
      )}
    </SectionCard>
  );
}

/* -------------------------- validation panel ------------------------- */

const SEVERITY_META: Record<
  DnsValidationIssue["severity"],
  {
    tone: Tone;
    icon: React.ComponentType<{ size?: number | string; className?: string }>;
    label: string;
  }
> = {
  error: { tone: "danger", icon: CircleAlert, label: "Error" },
  warning: { tone: "warn", icon: TriangleAlert, label: "Warning" },
  info: { tone: "info", icon: Info, label: "Note" },
};

const SEVERITY_CHIP: Record<DnsValidationIssue["severity"], string> = {
  error: "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
  warning: "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)]",
  info: "bg-[var(--kn-info-soft)] text-[var(--kn-info)]",
};

interface ValidationPanelProps {
  domainName: string;
  query: ReturnType<typeof useDnsValidation>;
  records: readonly DnsRecord[];
  onRemediation: (action: RemediationAction) => void;
  onHighlight: (record: DnsRecord) => void;
}

function ValidationPanel({
  domainName,
  query,
  records,
  onRemediation,
  onHighlight,
}: ValidationPanelProps) {
  const issues = query.data?.issues ?? [];
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  return (
    <SectionCard
      title="Zone validation"
      icon={CircleCheck}
      padded={false}
      headingLevel={3}
      actions={
        <>
          {errors > 0 && (
            <Badge tone="danger" size="xs">
              {formatCount(errors)} error{errors === 1 ? "" : "s"}
            </Badge>
          )}
          {warnings > 0 && (
            <Badge tone="warn" size="xs">
              {formatCount(warnings)} warning{warnings === 1 ? "" : "s"}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="xs"
            icon={RefreshCw}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Re-check
          </Button>
        </>
      }
      footer={
        query.data ? (
          <span>
            Checked <RelativeTime value={query.data.checked_at} />
          </span>
        ) : undefined
      }
    >
      {query.isLoading && (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-3 w-72" label={`Checking ${domainName}`} />
          <Skeleton className="h-3 w-56" />
        </div>
      )}

      {query.isError && (
        <div className="p-4">
          <PageError
            error={query.error}
            onRetry={() => void query.refetch()}
            context="Zone validation"
          />
        </div>
      )}

      {query.data && issues.length === 0 && (
        <EmptyState
          icon={CircleCheck}
          title={`${domainName} checks out`}
          description="Nothing in this zone contradicts the sites, certificates or mail Kaname knows about."
          size="sm"
        />
      )}

      {issues.length > 0 && (
        <ul className="divide-y divide-[var(--kn-border-subtle)]">
          {issues.map((issue, index) => (
            <ValidationIssueRow
              key={`${issue.code}-${issue.record_id ?? index}`}
              issue={issue}
              record={records.find((record) => record.id === issue.record_id) ?? null}
              onRemediation={onRemediation}
              onHighlight={onHighlight}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

interface ValidationIssueRowProps {
  issue: DnsValidationIssue;
  record: DnsRecord | null;
  onRemediation: (action: RemediationAction) => void;
  onHighlight: (record: DnsRecord) => void;
}

function ValidationIssueRow({
  issue,
  record,
  onRemediation,
  onHighlight,
}: ValidationIssueRowProps) {
  const meta = SEVERITY_META[issue.severity];
  const Icon = meta.icon;
  const actions = issue.remediation?.actions ?? [];
  const copyActions = actions.filter(
    (action): action is RemediationAction & { copy: string } =>
      typeof action.copy === "string" && action.copy.length > 0,
  );
  const buttonActions = actions.filter((action) => !action.copy);

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span
        className={cn(
          "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--kn-r-xs)]",
          SEVERITY_CHIP[issue.severity],
        )}
      >
        <Icon size={12} aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 font-medium text-[var(--kn-text)]">{issue.message}</p>
          <Badge tone={meta.tone} size="xs" mono>
            {issue.code}
          </Badge>
        </div>

        {issue.remediation?.summary && (
          <p className="mt-1 text-[var(--kn-text-2)]">{issue.remediation.summary}</p>
        )}

        {copyActions.map((action) => (
          <CopyableCode
            key={`${action.label}:${action.copy}`}
            label={action.label}
            value={action.copy}
            className="mt-2"
            block
          />
        ))}

        {(buttonActions.length > 0 || record) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {record && (
              <Button variant="ghost" size="xs" icon={Search} onClick={() => onHighlight(record)}>
                Find the record
              </Button>
            )}
            {buttonActions.map((action, index) => (
              <Button
                key={action.label}
                variant={index === 0 ? "secondary" : "ghost"}
                size="xs"
                onClick={() => onRemediation(action)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      <span className="sr-only">{meta.label}</span>
    </li>
  );
}
