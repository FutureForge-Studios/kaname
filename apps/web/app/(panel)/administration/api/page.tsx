"use client";

import * as React from "react";
import { Ban, KeyRound, Plus, TriangleAlert, Webhook } from "lucide-react";
import type { ApiKey, ApiKeyCreated, Permission, RoleGrant, ScopeKind } from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  CopyButton,
  CopyableCode,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  Input,
  MonoText,
  RelativeTime,
  Select,
  StatusBadge,
  Tooltip,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { PermissionGrid } from "@/components/PermissionGrid";
import { PageError } from "@/components/PageError";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { api, type ApiError } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useCan, useList, useResourceMutation, useServers, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * API keys.
 *
 * A key is a delegation of its creator's permissions, never an
 * escalation, so the scope picker is the role editor's grid with the
 * grant-level scope collapsed into one key-level scope — and anything
 * the creator does not hold is disabled with the reason on hover. The
 * control plane re-checks all of it; this only stops an operator
 * building a key that was always going to be refused.
 *
 * The token exists in exactly one place for exactly one moment: the
 * dialog that appears after creation. There is no route that can show
 * it again, and the dialog says so rather than implying the key can be
 * looked up later.
 * ------------------------------------------------------------------ */

type KeyState = "active" | "expired" | "revoked";

const STATE_TONES: Record<KeyState, Tone> = {
  active: "ok",
  expired: "warn",
  revoked: "neutral",
};

function stateOf(key: ApiKey): KeyState {
  if (key.revoked_at) return "revoked";
  if (key.expires_at && Date.parse(key.expires_at) < Date.now()) return "expired";
  return "active";
}

export default function ApiKeysPage() {
  const can = useCan();
  const state = useResourceListState({
    defaultSort: { id: "created_at", order: "desc" },
    filterKeys: ["revoked"],
  });
  const query = useList<ApiKey>("api-keys", state.params);

  const [creating, setCreating] = React.useState(false);
  const [issued, setIssued] = React.useState<ApiKeyCreated | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKey | null>(null);
  const [bulkRevoking, setBulkRevoking] = React.useState<string[] | null>(null);

  const revoke = useResourceMutation<string[], unknown>({
    mutationFn: (ids) => Promise.all(ids.map((id) => api.post(`/api-keys/${id}/revoke`))),
    invalidates: ["api-keys"],
    successMessage: (_result, ids) =>
      `${formatCount(ids.length)} key${ids.length === 1 ? "" : "s"} revoked.`,
    onDone: () => {
      setRevoking(null);
      setBulkRevoking(null);
      state.setSelected([]);
    },
  });

  const columns = React.useMemo<DataTableColumn<ApiKey>[]>(
    () => [
      {
        id: "name",
        header: "Key",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (key) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">{key.name}</span>
            <MonoText muted truncate className="text-sm">
              {key.prefix}…
            </MonoText>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 104,
        cell: (key) => {
          const value = stateOf(key);
          return (
            <StatusBadge
              tone={STATE_TONES[value]}
              size="sm"
              title={
                value === "revoked"
                  ? "Revoked keys stay listed so the audit trail keeps a name for them."
                  : value === "expired"
                    ? "Past its expiry. Requests with it are refused."
                    : "Accepted on every request that carries it."
              }
            >
              {value}
            </StatusBadge>
          );
        },
      },
      {
        id: "scopes",
        header: "Permissions",
        minWidth: 200,
        cell: (key) => (
          <Tooltip
            content={key.scopes.length === 0 ? "No permission" : key.scopes.slice(0, 24).join(", ")}
          >
            <span className="truncate text-[var(--kn-text-2)]">
              {formatCount(key.scopes.length)} permissions
            </span>
          </Tooltip>
        ),
      },
      {
        id: "scope_kind",
        header: "Applies to",
        width: 140,
        cell: (key) =>
          key.scope_kind === "global" ? (
            <Badge tone="warn" size="xs">
              whole fleet
            </Badge>
          ) : (
            <Badge tone="neutral" size="xs">
              {formatCount(key.scope_server_ids.length)} servers
            </Badge>
          ),
      },
      {
        id: "created_by_name",
        header: "Created by",
        width: 140,
        hideBelow: "lg",
        accessor: (key) => key.created_by_name,
      },
      {
        id: "last_used_at",
        header: "Last used",
        width: 152,
        align: "right",
        sortable: true,
        cell: (key) => (
          <div className="flex flex-col items-end">
            <RelativeTime value={key.last_used_at} fallback="never" />
            {key.last_used_ip && (
              <MonoText muted className="text-xs">
                {key.last_used_ip}
              </MonoText>
            )}
          </div>
        ),
      },
      {
        id: "expires_at",
        header: "Expires",
        width: 112,
        align: "right",
        sortable: true,
        cell: (key) => <RelativeTime value={key.expires_at} fallback="never" />,
      },
    ],
    [],
  );

  const newKeyButton = can("admin.api_keys:write") && (
    <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
      New API key
    </Button>
  );

  return (
    <>
      <ResourcePage<ApiKey>
        title="API"
        subtitle="Authorization: Bearer kn_live_…"
        state={state}
        query={query}
        columns={columns}
        getRowId={(key) => key.id}
        tableLabel="API keys"
        searchPlaceholder="Search name or prefix"
        selectable
        isRowSelectable={(key) => key.revoked_at === null}
        errorContext="API keys"
        emptyIcon={Webhook}
        emptyTitle="No API keys"
        emptyDescription="A key drives the same REST API the panel uses, with a subset of its creator's permissions."
        primaryAction={newKeyButton}
        emptyAction={newKeyButton}
        filters={
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by revocation"
            value={state.filters.revoked ?? ""}
            onChange={(event) => state.setFilter("revoked", event.target.value || null)}
            options={[
              { value: "", label: "Live and revoked" },
              { value: "false", label: "Live keys" },
              { value: "true", label: "Revoked keys" },
            ]}
          />
        }
        rowActions={(key) => [
          {
            id: "revoke",
            label: "Revoke",
            icon: Ban,
            destructive: true,
            disabled: key.revoked_at !== null || !can("admin.api_keys:delete"),
            onSelect: () => setRevoking(key),
          },
        ]}
        bulkActions={(ids) => (
          <Button
            variant="danger-subtle"
            size="xs"
            icon={Ban}
            disabled={!can("admin.api_keys:delete")}
            onClick={() => setBulkRevoking(ids)}
          >
            Revoke
          </Button>
        )}
      />

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onIssued={setIssued} />
      <IssuedKeyDialog issued={issued} onClose={() => setIssued(null)} />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "key"}?`}
        description="Every request carrying it is refused from the next one onward. This cannot be undone — a replacement is a new key."
        confirmText={revoking?.prefix}
        confirmLabel="Revoke key"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate([revoking.id])}
      />

      <ConfirmDialog
        open={bulkRevoking !== null}
        onOpenChange={(open) => !open && setBulkRevoking(null)}
        title={`Revoke ${formatCount(bulkRevoking?.length ?? 0)} keys?`}
        description="Anything automated that still carries one of them starts failing immediately."
        confirmText={`revoke ${bulkRevoking?.length ?? 0} keys`}
        confirmLabel="Revoke keys"
        loading={revoke.isPending}
        onConfirm={() => bulkRevoking && revoke.mutate(bulkRevoking)}
      />
    </>
  );
}

/* ------------------------------- create ----------------------------- */

const EXPIRY_OPTIONS = [
  { value: "", label: "Never expires" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
];

interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (issued: ApiKeyCreated) => void;
}

function CreateKeyDialog({ open, onOpenChange, onIssued }: CreateKeyDialogProps) {
  const { can, scope } = useSession();
  const servers = useServers();

  const [name, setName] = React.useState("");
  const [expiry, setExpiry] = React.useState("90");
  const [scopeKind, setScopeKind] = React.useState<ScopeKind>("global");
  const [serverIds, setServerIds] = React.useState<string[]>([]);
  const [scopes, setScopes] = React.useState<Permission[]>([]);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setExpiry("90");
    setScopeKind("global");
    setServerIds([]);
    setScopes([]);
    setError(null);
  }, [open]);

  /* A key can never do more than the person minting it, so the grid
   * disables what the creator does not already hold. */
  const canGrant = React.useCallback(
    (permission: Permission) =>
      scopeKind === "global"
        ? scope(permission) === "global"
        : serverIds.length > 0 && serverIds.every((serverId) => can(permission, serverId)),
    [can, scope, scopeKind, serverIds],
  );

  /* The grid speaks in grants; a key has one scope for all of them. */
  const grants = React.useMemo<RoleGrant[]>(
    () =>
      scopes.map((permission) => ({
        permission,
        scope:
          scopeKind === "global"
            ? { kind: "global" }
            : { kind: "servers", server_ids: serverIds.length > 0 ? serverIds : [] },
      })),
    [scopeKind, scopes, serverIds],
  );

  const create = useResourceMutation<void, ApiKeyCreated>({
    mutationFn: () =>
      api.post<ApiKeyCreated>("/api-keys", {
        name: name.trim(),
        scopes,
        scope_kind: scopeKind,
        scope_server_ids: scopeKind === "servers" ? serverIds : [],
        ...(expiry ? { expires_in_days: Number(expiry) } : {}),
      }),
    invalidates: ["api-keys"],
    onDone: (result) => {
      onOpenChange(false);
      onIssued(result);
    },
    onFailed: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" dismissible={!create.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <DialogHeader
          title="New API key"
          description="The token is shown once, immediately after creation, and cannot be retrieved afterwards."
        />

        <DialogBody>
          {error && error.fieldEntries.length === 0 && (
            <PageError error={error} onRetry={() => create.mutate()} className="mb-4" />
          )}

          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Name"
                required
                description="How this key is identified in the audit trail."
                error={error?.fields.name}
              >
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="ci-deploy"
                  data-autofocus=""
                />
              </FormField>
              <FormField label="Expiry" error={error?.fields.expires_in_days}>
                <Select
                  value={expiry}
                  onChange={(event) => setExpiry(event.target.value)}
                  options={EXPIRY_OPTIONS}
                />
              </FormField>
            </div>

            <FormField
              label="Applies to"
              required
              description="A fleet-wide key covers servers added after it was created."
            >
              <Select
                value={scopeKind}
                onChange={(event) => setScopeKind(event.target.value as ScopeKind)}
                options={[
                  { value: "global", label: "The whole fleet" },
                  { value: "servers", label: "Named servers only" },
                ]}
              />
            </FormField>

            {scopeKind === "servers" && (
              <FormField label="Servers" required error={error?.fields.scope_server_ids}>
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
                  value={serverIds}
                  onValueChange={setServerIds}
                  loading={servers.isLoading}
                  placeholder="Select at least one server"
                  emptyMessage="No server matches that name."
                  mono
                />
              </FormField>
            )}

            <div className="flex flex-col gap-2">
              <p className="font-medium text-[var(--kn-text)]">Permissions</p>
              {error?.fields.scopes && (
                <p role="alert" className="text-xs text-[var(--kn-danger)]">
                  {error.fields.scopes}
                </p>
              )}
              <PermissionGrid
                value={grants}
                onChange={(next) => setScopes(next.map((grant) => grant.permission))}
                servers={servers.data?.data ?? []}
                perPermissionScope={false}
                canGrant={canGrant}
              />
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={create.isPending}
            disabled={scopes.length === 0 || name.trim().length === 0}
          >
            Create key
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ------------------------------- issued ----------------------------- */

function IssuedKeyDialog({
  issued,
  onClose,
}: {
  issued: ApiKeyCreated | null;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);

  React.useEffect(() => {
    if (issued) setAcknowledged(false);
  }, [issued]);

  if (!issued) return null;

  return (
    <Dialog open onOpenChange={onClose} size="md" dismissible={acknowledged}>
      <DialogHeader
        title={`${issued.key.name} is ready`}
        description="Copy it now. Kaname stores only a hash of this token — there is no route, no support path and no database query that can show it again."
      />
      <DialogBody>
        <div className="flex items-start gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] p-3">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
          <p className="text-[var(--kn-text)]">
            <span className="font-medium">This will not be shown again.</span> If you lose it,
            revoke this key and create another one.
          </p>
        </div>

        <div className="mt-3">
          <CopyableCode value={issued.token} label="Token" block />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CopyButton
            value={issued.token}
            label="Copy the token"
            size="sm"
            onCopied={() => setAcknowledged(true)}
          />
          <Badge tone="neutral" size="sm" icon={KeyRound} mono>
            {issued.key.prefix}
          </Badge>
          <span className="text-[var(--kn-text-2)]">
            {formatCount(issued.key.scopes.length)} permissions ·{" "}
            {issued.key.scope_kind === "global"
              ? "whole fleet"
              : `${formatCount(issued.key.scope_server_ids.length)} servers`}
          </span>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          I have copied it
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
