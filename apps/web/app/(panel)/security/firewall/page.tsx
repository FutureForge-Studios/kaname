"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CircleSlash,
  Pencil,
  Play,
  Plus,
  Shield,
  Trash2,
  Zap,
} from "lucide-react";
import {
  cidr as cidrSchema,
  portSpec as portSpecSchema,
  type FirewallRule,
  type FirewallStatus,
  type Job,
} from "@kaname/contract";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  Input,
  MetricTile,
  MonoText,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  Textarea,
  cn,
  type DataTableColumn,
  type DataTableRowAction,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import {
  LockoutNotice,
  RollbackBanner,
  type LockoutAssessment,
  type RollbackWindow,
} from "@/components/RollbackBanner";
import { api, type ApiError } from "@/lib/api";
import { queryKeys, useCan, useList, useMutationWithJob, useResourceMutation } from "@/lib/queries";
import { formatCount, formatDateTime } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Firewall.
 *
 * Rules are staged in Kaname and only reach the host on Apply, which
 * replaces the host's whole set. Two things follow from that and shape
 * this page: the operator must be able to see exactly what an apply
 * will change before it happens, and the rollback window has to be the
 * loudest thing on screen while it is open — because the mistake this
 * page enables is losing the machine.
 *
 * Ordering is edited as numbers rather than dragged. A drag reorders
 * what you can see; a firewall's order is the whole rule set, most of
 * which is off-screen, and "priority 100" is also what the host, the
 * audit entry and the next operator will read.
 * ------------------------------------------------------------------ */

const ACTION_TONES: Record<FirewallRule["action"], Tone> = {
  allow: "ok",
  deny: "neutral",
  reject: "danger",
};

const ROLLBACK_OPTIONS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "60 seconds" },
  { value: "120", label: "2 minutes" },
  { value: "300", label: "5 minutes" },
  { value: "0", label: "No rollback window" },
];

interface ApplyResponse {
  job: Job;
  lockout: LockoutAssessment;
  rollback: { seconds: number; summary: string };
}

interface RuleResponse {
  rule: FirewallRule;
  lockout: LockoutAssessment;
}

interface RuleDraft {
  priority: number;
  action: FirewallRule["action"];
  direction: FirewallRule["direction"];
  protocol: FirewallRule["protocol"];
  port_spec: string;
  source_cidr: string;
  dest_cidr: string;
  comment: string;
  enabled: boolean;
}

export default function FirewallPage() {
  const can = useCan();
  const selection = useServerSelection({
    permission: "security.firewall:read",
    required: true,
  });
  const serverId = selection.serverId;
  const serverName = selection.server?.name ?? "this server";

  const status = useQuery<FirewallStatus, ApiError>({
    queryKey: queryKeys.sub("firewall", serverId ?? "none", "status"),
    queryFn: ({ signal }) =>
      api.get<FirewallStatus>("/firewall/status", { params: { server_id: serverId }, signal }),
    enabled: Boolean(serverId),
    staleTime: 15_000,
  });

  const state = useResourceListState({
    defaultSort: { id: "priority", order: "asc" },
    filterKeys: ["action", "direction", "protocol", "managed_by"],
    extraParams: { server_id: serverId ?? undefined },
  });

  const rules = useList<FirewallRule>("firewall", state.params, { enabled: Boolean(serverId) });

  /* Apply replaces the host's whole set, and moving a rule needs its
   * neighbour, so both work from every rule on the server rather than
   * the page currently on screen. */
  const allRules = useList<FirewallRule>(
    "firewall",
    { server_id: serverId ?? undefined, per_page: 200, sort: "priority", order: "asc" },
    { enabled: Boolean(serverId) },
  );
  const ordered = React.useMemo(
    () => [...(allRules.data?.data ?? [])].sort((a, b) => a.priority - b.priority),
    [allRules.data],
  );

  const [editing, setEditing] = React.useState<FirewallRule | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<FirewallRule[] | null>(null);
  const [applyOpen, setApplyOpen] = React.useState(false);
  const [lockout, setLockout] = React.useState<LockoutAssessment | null>(null);
  const [applyError, setApplyError] = React.useState<ApiError | null>(null);
  const [rollback, setRollback] = React.useState<RollbackWindow | null>(null);

  const mayWrite = can("security.firewall:write", serverId);

  const createRule = useResourceMutation<RuleDraft, RuleResponse>({
    mutationFn: async (draft) => {
      const response = await api.post<RuleResponse>("/firewall", {
        server_id: serverId,
        ...toBody(draft),
      });
      setLockout(response.lockout);
      return response;
    },
    invalidates: ["firewall"],
    successMessage: () => "Rule staged. It reaches the host on Apply.",
    onDone: () => setCreating(false),
  });

  const updateRule = useResourceMutation<
    { id: string; patch: Partial<ReturnType<typeof toBody>> },
    RuleResponse
  >({
    mutationFn: async ({ id, patch }) => {
      const response = await api.patch<RuleResponse>(`/firewall/${id}`, patch);
      setLockout(response.lockout);
      return response;
    },
    invalidates: ["firewall"],
    onDone: () => setEditing(null),
  });

  const moveRule = useResourceMutation<{ rule: FirewallRule; step: -1 | 1 }, unknown>({
    mutationFn: async ({ rule, step }) => {
      const index = ordered.findIndex((row) => row.id === rule.id);
      const neighbour = ordered[index + step];
      if (!neighbour) return null;

      // Equal priorities are ambiguous on the host too, so nudge instead
      // of swapping two identical numbers.
      if (neighbour.priority === rule.priority) {
        return api.patch<RuleResponse>(`/firewall/${rule.id}`, {
          priority: Math.min(65535, Math.max(0, rule.priority + step)),
        });
      }
      await api.patch<RuleResponse>(`/firewall/${rule.id}`, { priority: neighbour.priority });
      const response = await api.patch<RuleResponse>(`/firewall/${neighbour.id}`, {
        priority: rule.priority,
      });
      setLockout(response.lockout);
      return response;
    },
    invalidates: ["firewall"],
  });

  const deleteRules = useResourceMutation<FirewallRule[], void>({
    mutationFn: async (rows) => {
      for (const row of rows) await api.del(`/firewall/${row.id}`);
    },
    invalidates: ["firewall"],
    successMessage: (_result, rows) =>
      rows.length === 1
        ? "Rule removed from the staged set."
        : `${rows.length} rules removed from the staged set.`,
    onDone: () => {
      setDeleting(null);
      state.setSelected([]);
    },
  });

  const apply = useMutationWithJob<{
    defaultInbound: "allow" | "deny";
    defaultOutbound: "allow" | "deny";
    rollbackSeconds: number;
  }>({
    mutationFn: async ({ defaultInbound, defaultOutbound, rollbackSeconds }) => {
      setApplyError(null);
      const response = await api.post<ApplyResponse>("/firewall/apply", {
        server_id: serverId,
        default_inbound: defaultInbound,
        default_outbound: defaultOutbound,
        rollback_seconds: rollbackSeconds,
        rules: ordered.map(toBodyFromRule),
      });
      setLockout(response.lockout);
      setRollback({
        serverId: serverId!,
        serverName,
        subject: "firewall rule set",
        seconds: response.rollback.seconds,
        expiresAt: Date.now() + response.rollback.seconds * 1000,
        summary: response.rollback.summary,
        lockout: response.lockout,
      });
      return response;
    },
    invalidates: ["firewall"],
    describe: () => `Apply firewall to ${serverName}`,
    onQueued: () => {
      setApplyOpen(false);
      void status.refetch();
    },
    onFailed: (error) => setApplyError(error),
  });

  const confirm = useResourceMutation<void, FirewallStatus>({
    mutationFn: () => api.post<FirewallStatus>("/firewall/confirm", { server_id: serverId }),
    invalidates: ["firewall"],
    successMessage: () => "Rule set confirmed. The host will not revert.",
    onDone: () => {
      setRollback(null);
      void status.refetch();
    },
  });

  const lastApplied = status.data?.last_applied_at ? Date.parse(status.data.last_applied_at) : null;
  const isPending = React.useCallback(
    (rule: FirewallRule) => lastApplied === null || Date.parse(rule.updated_at) > lastApplied,
    [lastApplied],
  );

  const columns = React.useMemo<DataTableColumn<FirewallRule>[]>(
    () => [
      {
        id: "priority",
        header: "Priority",
        sortable: true,
        locked: true,
        width: 96,
        cell: (rule) => (
          <PriorityCell
            rule={rule}
            disabled={!can("security.firewall:write", rule.server_id) || updateRule.isPending}
            onCommit={(priority) => updateRule.mutate({ id: rule.id, patch: { priority } })}
          />
        ),
      },
      {
        id: "action",
        header: "Action",
        sortable: true,
        width: 92,
        cell: (rule) => (
          <StatusBadge tone={ACTION_TONES[rule.action]} size="xs">
            {rule.action}
          </StatusBadge>
        ),
      },
      {
        id: "direction",
        header: "Direction",
        sortable: true,
        width: 96,
        accessor: (rule) => rule.direction,
      },
      {
        id: "protocol",
        header: "Proto",
        sortable: true,
        mono: true,
        width: 72,
        accessor: (rule) => rule.protocol,
      },
      {
        id: "port_spec",
        header: "Port",
        sortable: true,
        mono: true,
        width: 112,
        accessor: (rule) => rule.port_spec ?? "any",
      },
      {
        id: "source_cidr",
        header: "Source",
        mono: true,
        width: 148,
        accessor: (rule) => rule.source_cidr ?? "any",
      },
      {
        id: "dest_cidr",
        header: "Destination",
        mono: true,
        width: 148,
        hideBelow: "lg",
        accessor: (rule) => rule.dest_cidr ?? "any",
      },
      {
        id: "comment",
        header: "Comment",
        minWidth: 180,
        cell: (rule) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[var(--kn-text-2)]">{rule.comment ?? "—"}</span>
            {!rule.enabled && (
              <Badge tone="neutral" size="xs">
                disabled
              </Badge>
            )}
            {rule.managed_by === "external" && (
              <Badge tone="info" size="xs" title="Read from the host, not written by Kaname.">
                external
              </Badge>
            )}
            {isPending(rule) && (
              <Badge tone="warn" size="xs" title="Edited since the last apply.">
                staged
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "hit_count",
        header: "Hits",
        sortable: true,
        align: "right",
        width: 88,
        hideBelow: "md",
        cell: (rule) =>
          rule.hit_count === null ? (
            <span className="text-[var(--kn-text-3)]" title="This backend exposes no counters.">
              n/a
            </span>
          ) : (
            <span className="kn-num">{formatCount(rule.hit_count)}</span>
          ),
      },
    ],
    [can, isPending, updateRule.isPending, updateRule.mutate],
  );

  const rowActions = React.useCallback(
    (rule: FirewallRule): DataTableRowAction<FirewallRule>[] => {
      const writable = can("security.firewall:write", rule.server_id);
      const index = ordered.findIndex((row) => row.id === rule.id);
      return [
        {
          id: "edit",
          label: "Edit rule",
          icon: Pencil,
          disabled: !writable,
          onSelect: () => setEditing(rule),
        },
        {
          id: "up",
          label: "Move earlier",
          icon: ArrowUp,
          disabled: !writable || index <= 0,
          onSelect: () => moveRule.mutate({ rule, step: -1 }),
        },
        {
          id: "down",
          label: "Move later",
          icon: ArrowDown,
          disabled: !writable || index < 0 || index >= ordered.length - 1,
          onSelect: () => moveRule.mutate({ rule, step: 1 }),
        },
        {
          id: "toggle",
          label: rule.enabled ? "Disable rule" : "Enable rule",
          icon: rule.enabled ? CircleSlash : Play,
          disabled: !writable,
          separatorBefore: true,
          onSelect: () => updateRule.mutate({ id: rule.id, patch: { enabled: !rule.enabled } }),
        },
        {
          id: "delete",
          label: "Delete rule",
          icon: Trash2,
          destructive: true,
          disabled: !writable,
          onSelect: () => setDeleting([rule]),
        },
      ];
    },
    [can, moveRule.mutate, ordered, updateRule.mutate],
  );

  const newRule = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      disabled={!mayWrite || !serverId}
      onClick={() => setCreating(true)}
    >
      New rule
    </Button>
  );

  return (
    <>
      <ResourcePage<FirewallRule>
        title="Firewall"
        subtitle={
          status.data
            ? `${status.data.backend} · default in ${status.data.default_inbound} / out ${status.data.default_outbound} · ${selection.server?.hostname ?? ""}`
            : undefined
        }
        primaryAction={newRule}
        headerActions={
          <Button
            variant="secondary"
            size="sm"
            icon={Zap}
            disabled={!mayWrite || ordered.length === 0}
            onClick={() => {
              setApplyError(null);
              setApplyOpen(true);
            }}
          >
            Apply to host
          </Button>
        }
        state={state}
        query={rules}
        columns={columns}
        getRowId={(rule) => rule.id}
        tableLabel="Firewall rules"
        density="compact"
        searchPlaceholder="Search comment, port or source"
        filters={
          <>
            <Select
              size="sm"
              aria-label="Action"
              value={state.filters.action ?? ""}
              onChange={(event) => state.setFilter("action", event.target.value || null)}
              options={[
                { value: "", label: "Any action" },
                { value: "allow", label: "allow" },
                { value: "deny", label: "deny" },
                { value: "reject", label: "reject" },
              ]}
              boxClassName="w-32"
            />
            <Select
              size="sm"
              aria-label="Direction"
              value={state.filters.direction ?? ""}
              onChange={(event) => state.setFilter("direction", event.target.value || null)}
              options={[
                { value: "", label: "Any direction" },
                { value: "inbound", label: "inbound" },
                { value: "outbound", label: "outbound" },
              ]}
              boxClassName="w-36"
            />
            <Select
              size="sm"
              aria-label="Protocol"
              value={state.filters.protocol ?? ""}
              onChange={(event) => state.setFilter("protocol", event.target.value || null)}
              options={[
                { value: "", label: "Any protocol" },
                { value: "tcp", label: "tcp" },
                { value: "udp", label: "udp" },
                { value: "icmp", label: "icmp" },
                { value: "any", label: "any" },
              ]}
              boxClassName="w-36"
            />
            <Select
              size="sm"
              aria-label="Managed by"
              value={state.filters.managed_by ?? ""}
              onChange={(event) => state.setFilter("managed_by", event.target.value || null)}
              options={[
                { value: "", label: "Any origin" },
                { value: "kaname", label: "managed by Kaname" },
                { value: "external", label: "read from host" },
              ]}
              boxClassName="w-44"
            />
          </>
        }
        selectable
        bulkActions={(ids) => {
          const rows = (rules.data?.data ?? []).filter((rule) => ids.includes(rule.id));
          return (
            <>
              <Button
                variant="ghost"
                size="xs"
                icon={Play}
                disabled={!mayWrite}
                onClick={() => {
                  for (const rule of rows) {
                    if (!rule.enabled) updateRule.mutate({ id: rule.id, patch: { enabled: true } });
                  }
                }}
              >
                Enable
              </Button>
              <Button
                variant="ghost"
                size="xs"
                icon={CircleSlash}
                disabled={!mayWrite}
                onClick={() => {
                  for (const rule of rows) {
                    if (rule.enabled) updateRule.mutate({ id: rule.id, patch: { enabled: false } });
                  }
                }}
              >
                Disable
              </Button>
              <Button
                variant="danger-subtle"
                size="xs"
                icon={Trash2}
                disabled={!mayWrite}
                onClick={() => setDeleting(rows)}
              >
                Delete {ids.length === 1 ? "rule" : `${ids.length} rules`}
              </Button>
            </>
          );
        }}
        rowActions={rowActions}
        emptyIcon={Shield}
        emptyTitle="No rules staged"
        emptyDescription="With no rules, the chain default policy decides everything. Add the rules you need, then apply them to the host."
        emptyAction={newRule}
        errorContext="Firewall rules"
      >
        {/* Above the host picker on purpose: while the window is open it
            is the only thing on this page that is time-critical. */}
        {rollback && (
          <RollbackBanner
            window={rollback}
            confirming={confirm.isPending}
            onConfirm={() => confirm.mutate()}
            onDismiss={() => setRollback(null)}
          />
        )}

        <ServerPicker selection={selection} />

        {status.isError && (
          <PageError
            error={status.error}
            onRetry={() => void status.refetch()}
            context="Firewall status"
          />
        )}

        {status.isLoading && <StatusSkeleton />}

        {status.data && <StatusStrip status={status.data} />}

        {status.data && status.data.pending_changes > 0 && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-[var(--kn-r-md)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] px-3 py-2"
          >
            <span className="text-[var(--kn-text)]">
              {formatCount(status.data.pending_changes)}{" "}
              {status.data.pending_changes === 1 ? "rule is" : "rules are"} staged in Kaname and not
              on {serverName}.
            </span>
            <Button
              variant="secondary"
              size="xs"
              icon={Zap}
              disabled={!mayWrite}
              onClick={() => {
                setApplyError(null);
                setApplyOpen(true);
              }}
              className="ml-auto"
            >
              Review and apply
            </Button>
          </div>
        )}

        {/* Loud, and before the apply rather than after it. */}
        <LockoutNotice assessment={lockout} subject="The staged rule set" />
      </ResourcePage>

      <RuleDialog
        open={creating || editing !== null}
        rule={editing}
        pending={createRule.isPending || updateRule.isPending}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSubmit={(draft) => {
          if (editing) updateRule.mutate({ id: editing.id, patch: toBody(draft) });
          else createRule.mutate(draft);
        }}
      />

      <ApplyDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        serverName={serverName}
        status={status.data ?? null}
        rules={ordered}
        isPending={isPending}
        lockout={lockout}
        error={applyError}
        submitting={apply.isPending}
        onApply={(defaultInbound, defaultOutbound, rollbackSeconds) =>
          apply.mutate({ defaultInbound, defaultOutbound, rollbackSeconds })
        }
      />

      <Dialog
        open={deleting !== null && deleting.length > 0}
        onOpenChange={(next) => !next && setDeleting(null)}
        size="sm"
        dismissible={!deleteRules.isPending}
      >
        <DialogHeader
          title={
            deleting && deleting.length === 1
              ? "Delete this rule?"
              : `Delete ${deleting?.length ?? 0} rules?`
          }
          description={`Removed from the staged set only. ${serverName} keeps its current rules until you apply.`}
        />
        <DialogBody>
          <ul className="flex flex-col gap-1">
            {deleting?.map((rule) => (
              <li key={rule.id}>
                <MonoText>{describeRule(rule)}</MonoText>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={deleteRules.isPending}
            onClick={() => setDeleting(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={deleteRules.isPending}
            onClick={() => deleting && deleteRules.mutate(deleting)}
          >
            Delete
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/* ------------------------------ status ------------------------------ */

function StatusSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      {[0, 1, 2, 3, 4].map((index) => (
        <Skeleton
          key={index}
          className="h-16 rounded-[var(--kn-r-md)]"
          label={index === 0 ? "Loading firewall status" : undefined}
        />
      ))}
    </div>
  );
}

function StatusStrip({ status }: { status: FirewallStatus }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
      <MetricTile
        size="sm"
        label="Backend"
        value={status.backend}
        tone={status.enabled ? "neutral" : "warn"}
        unit={status.enabled ? undefined : "inactive"}
      />
      <MetricTile size="sm" label="Rules" value={formatCount(status.rule_count)} />
      <MetricTile
        size="sm"
        label="Default inbound"
        value={status.default_inbound}
        tone={status.default_inbound === "deny" ? "ok" : "warn"}
      />
      <MetricTile
        size="sm"
        label="Default outbound"
        value={status.default_outbound}
        tone={status.default_outbound === "deny" ? "warn" : "neutral"}
      />
      <MetricTile
        size="sm"
        label="Staged, not applied"
        value={formatCount(status.pending_changes)}
        tone={status.pending_changes > 0 ? "warn" : "neutral"}
      />
    </div>
  );
}

/* ---------------------------- priority cell ------------------------- */

function PriorityCell({
  rule,
  disabled,
  onCommit,
}: {
  rule: FirewallRule;
  disabled: boolean;
  onCommit: (priority: number) => void;
}) {
  const [value, setValue] = React.useState(String(rule.priority));

  React.useEffect(() => setValue(String(rule.priority)), [rule.priority]);

  const commit = () => {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 0 || next > 65535 || next === rule.priority) {
      setValue(String(rule.priority));
      return;
    }
    onCommit(next);
  };

  return (
    <Input
      size="xs"
      mono
      type="number"
      min={0}
      max={65535}
      value={value}
      disabled={disabled}
      aria-label={`Priority of ${describeRule(rule)}`}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setValue(String(rule.priority));
          event.currentTarget.blur();
        }
      }}
      className="text-right"
      boxClassName="w-16"
    />
  );
}

/* ----------------------------- rule dialog -------------------------- */

const EMPTY_DRAFT: RuleDraft = {
  priority: 100,
  action: "allow",
  direction: "inbound",
  protocol: "tcp",
  port_spec: "",
  source_cidr: "",
  dest_cidr: "",
  comment: "",
  enabled: true,
};

function toDraft(rule: FirewallRule): RuleDraft {
  return {
    priority: rule.priority,
    action: rule.action,
    direction: rule.direction,
    protocol: rule.protocol,
    port_spec: rule.port_spec ?? "",
    source_cidr: rule.source_cidr ?? "",
    dest_cidr: rule.dest_cidr ?? "",
    comment: rule.comment ?? "",
    enabled: rule.enabled,
  };
}

function toBody(draft: RuleDraft) {
  return {
    priority: draft.priority,
    action: draft.action,
    direction: draft.direction,
    protocol: draft.protocol,
    port_spec: draft.port_spec || undefined,
    source_cidr: draft.source_cidr || undefined,
    dest_cidr: draft.dest_cidr || undefined,
    comment: draft.comment || undefined,
    enabled: draft.enabled,
  };
}

function toBodyFromRule(rule: FirewallRule) {
  return toBody(toDraft(rule));
}

function describeRule(rule: FirewallRule): string {
  const port = rule.port_spec ? ` ${rule.port_spec}` : "";
  const source = rule.source_cidr ? ` from ${rule.source_cidr}` : "";
  return `${rule.action} ${rule.direction} ${rule.protocol}${port}${source}`;
}

interface RuleDialogProps {
  open: boolean;
  rule: FirewallRule | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (draft: RuleDraft) => void;
}

function RuleDialog({ open, rule, pending, onClose, onSubmit }: RuleDialogProps) {
  const [draft, setDraft] = React.useState<RuleDraft>(EMPTY_DRAFT);

  React.useEffect(() => {
    if (!open) return;
    setDraft(rule ? toDraft(rule) : EMPTY_DRAFT);
  }, [open, rule]);

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const portError =
    draft.port_spec && !portSpecSchema.safeParse(draft.port_spec).success
      ? "a port, a comma-separated list, or a range"
      : undefined;
  const sourceError =
    draft.source_cidr && !cidrSchema.safeParse(draft.source_cidr).success
      ? "must be a CIDR block, e.g. 203.0.113.4/32"
      : undefined;
  const destError =
    draft.dest_cidr && !cidrSchema.safeParse(draft.dest_cidr).success
      ? "must be a CIDR block, e.g. 10.0.0.0/8"
      : undefined;
  const valid = !portError && !sourceError && !destError;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      size="md"
      dismissible={!pending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || pending) return;
          onSubmit(draft);
        }}
      >
        <DialogHeader
          title={rule ? "Edit rule" : "New rule"}
          description="Staged in Kaname. Nothing changes on the host until you apply."
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <FormField label="Priority" description="Lowest first." required>
                <Input
                  data-autofocus=""
                  type="number"
                  mono
                  min={0}
                  max={65535}
                  value={String(draft.priority)}
                  onChange={(event) => set("priority", Number(event.target.value))}
                />
              </FormField>
              <FormField label="Action" required>
                <Select
                  value={draft.action}
                  onChange={(event) => set("action", event.target.value as RuleDraft["action"])}
                  options={[
                    { value: "allow", label: "allow" },
                    { value: "deny", label: "deny (drop)" },
                    { value: "reject", label: "reject (ICMP)" },
                  ]}
                />
              </FormField>
              <FormField label="Direction" required>
                <Select
                  value={draft.direction}
                  onChange={(event) =>
                    set("direction", event.target.value as RuleDraft["direction"])
                  }
                  options={[
                    { value: "inbound", label: "inbound" },
                    { value: "outbound", label: "outbound" },
                  ]}
                />
              </FormField>
              <FormField label="Protocol" required>
                <Select
                  value={draft.protocol}
                  onChange={(event) => set("protocol", event.target.value as RuleDraft["protocol"])}
                  options={[
                    { value: "tcp", label: "tcp" },
                    { value: "udp", label: "udp" },
                    { value: "icmp", label: "icmp" },
                    { value: "any", label: "any" },
                  ]}
                />
              </FormField>
            </div>

            <FormField
              label="Port"
              description="Empty matches every port. 22, 80,443 or 3000-4000."
              error={portError}
            >
              <Input
                mono
                value={draft.port_spec}
                onChange={(event) => set("port_spec", event.target.value)}
                placeholder="22"
                autoComplete="off"
                spellCheck={false}
                disabled={draft.protocol === "icmp"}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Source"
                description="Empty matches any address."
                error={sourceError}
              >
                <Input
                  mono
                  value={draft.source_cidr}
                  onChange={(event) => set("source_cidr", event.target.value)}
                  placeholder="203.0.113.4/32"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField
                label="Destination"
                description="Empty matches any address."
                error={destError}
              >
                <Input
                  mono
                  value={draft.dest_cidr}
                  onChange={(event) => set("dest_cidr", event.target.value)}
                  placeholder="10.0.0.0/8"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
            </div>

            <FormField
              label="Comment"
              description="Why this rule exists. The next operator reads it."
            >
              <Textarea
                autoGrow
                maxRows={3}
                value={draft.comment}
                onChange={(event) => set("comment", event.target.value)}
                placeholder="Office VPN egress"
              />
            </FormField>

            <Switch
              checked={draft.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
              label="Enabled"
              description="A disabled rule is kept and applied as inactive."
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
            {rule ? "Save rule" : "Add rule"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ---------------------------- apply dialog -------------------------- */

interface ApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  status: FirewallStatus | null;
  rules: readonly FirewallRule[];
  isPending: (rule: FirewallRule) => boolean;
  lockout: LockoutAssessment | null;
  error: ApiError | null;
  submitting: boolean;
  onApply: (
    defaultInbound: "allow" | "deny",
    defaultOutbound: "allow" | "deny",
    rollbackSeconds: number,
  ) => void;
}

function ApplyDialog({
  open,
  onOpenChange,
  serverName,
  status,
  rules,
  isPending,
  lockout,
  error,
  submitting,
  onApply,
}: ApplyDialogProps) {
  const [defaultInbound, setDefaultInbound] = React.useState<"allow" | "deny">("deny");
  const [defaultOutbound, setDefaultOutbound] = React.useState<"allow" | "deny">("allow");
  const [rollbackSeconds, setRollbackSeconds] = React.useState(60);
  const [acknowledged, setAcknowledged] = React.useState(false);

  React.useEffect(() => {
    if (!open || !status) return;
    setDefaultInbound(status.default_inbound);
    setDefaultOutbound(status.default_outbound);
    setRollbackSeconds(60);
    setAcknowledged(false);
  }, [open, status]);

  // The 412 the control plane returns for "locks you out with no window"
  // carries the assessment; showing it here is more useful than a toast.
  const errorLockout = error && isLockout(error.detail) ? error.detail : null;

  const changed = rules.filter(isPending).length;
  const policyChanged =
    status !== null &&
    (status.default_inbound !== defaultInbound || status.default_outbound !== defaultOutbound);
  const riskyWithoutWindow = rollbackSeconds === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" dismissible={!submitting}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting || (riskyWithoutWindow && !acknowledged)) return;
          onApply(defaultInbound, defaultOutbound, rollbackSeconds);
        }}
      >
        <DialogHeader
          title={`Apply ${formatCount(rules.length)} rules to ${serverName}`}
          description={
            status?.last_applied_at
              ? `This replaces the host's whole rule set. Last applied ${formatDateTime(status.last_applied_at)}.`
              : "This replaces the host's whole rule set. Kaname has not applied to this host before, so every rule counts as new."
          }
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            {error && <PageError error={error} context="Apply" />}
            <LockoutNotice assessment={errorLockout ?? lockout} subject="This rule set" />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <FormField
                label="Default inbound"
                description={
                  defaultInbound === "allow" ? "Anything not denied gets in." : undefined
                }
              >
                <Select
                  value={defaultInbound}
                  onChange={(event) => setDefaultInbound(event.target.value as "allow" | "deny")}
                  options={[
                    { value: "deny", label: "deny" },
                    { value: "allow", label: "allow" },
                  ]}
                />
              </FormField>
              <FormField label="Default outbound">
                <Select
                  value={defaultOutbound}
                  onChange={(event) => setDefaultOutbound(event.target.value as "allow" | "deny")}
                  options={[
                    { value: "allow", label: "allow" },
                    { value: "deny", label: "deny" },
                  ]}
                />
              </FormField>
              <FormField
                label="Rollback window"
                description="The host reverts unless you confirm inside it."
              >
                <Select
                  value={String(rollbackSeconds)}
                  onChange={(event) => setRollbackSeconds(Number(event.target.value))}
                  options={ROLLBACK_OPTIONS}
                />
              </FormField>
            </div>

            <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--kn-border)] px-3 py-2">
                <span className="font-medium text-[var(--kn-text)]">What changes</span>
                <span className="text-[var(--kn-text-2)]">
                  {changed === 0
                    ? "No rule has been edited since the last apply."
                    : `${formatCount(changed)} of ${formatCount(rules.length)} rules edited since the last apply.`}
                </span>
                {policyChanged && (
                  <Badge tone="warn" size="xs">
                    default policy changes
                  </Badge>
                )}
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full border-collapse">
                  <caption className="sr-only">
                    Rules that will be written to {serverName}, in priority order
                  </caption>
                  <thead className="sticky top-0 bg-[var(--kn-surface-2)]">
                    <tr className="text-left text-xs text-[var(--kn-text-2)]">
                      <th scope="col" className="px-3 py-1 font-medium">
                        #
                      </th>
                      <th scope="col" className="px-3 py-1 font-medium">
                        Rule
                      </th>
                      <th scope="col" className="px-3 py-1 font-medium">
                        Comment
                      </th>
                      <th scope="col" className="px-3 py-1 text-right font-medium">
                        State
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule) => (
                      <tr
                        key={rule.id}
                        className={cn(
                          "border-t border-[var(--kn-border-subtle)]",
                          !rule.enabled && "opacity-60",
                        )}
                      >
                        <td className="kn-mono px-3 py-1 text-[var(--kn-text-2)]">
                          {rule.priority}
                        </td>
                        <td className="kn-mono px-3 py-1 text-[var(--kn-text)]">
                          {describeRule(rule)}
                        </td>
                        <td className="px-3 py-1 text-[var(--kn-text-2)]">{rule.comment ?? "—"}</td>
                        <td className="px-3 py-1 text-right">
                          {!rule.enabled ? (
                            <Badge tone="neutral" size="xs">
                              disabled
                            </Badge>
                          ) : isPending(rule) ? (
                            <Badge tone="warn" size="xs">
                              changed
                            </Badge>
                          ) : (
                            <span className="text-xs text-[var(--kn-text-3)]">unchanged</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {riskyWithoutWindow && (
              <Checkbox
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                label="Apply with no rollback window"
                description={`If these rules cut Kaname or your SSH session off from ${serverName}, nothing brings it back but console access.`}
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant={riskyWithoutWindow ? "danger" : "primary"}
            disabled={riskyWithoutWindow && !acknowledged}
            loading={submitting}
          >
            Apply to {serverName}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function isLockout(value: unknown): value is LockoutAssessment {
  return (
    typeof value === "object" &&
    value !== null &&
    "checks" in value &&
    Array.isArray((value as { checks: unknown }).checks)
  );
}
