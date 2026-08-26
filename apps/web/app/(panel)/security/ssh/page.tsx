"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  KeyRound,
  Plus,
  RefreshCw,
  Server as ServerIcon,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import {
  openSshPublicKey,
  type Job,
  type SshConfig,
  type SshKey,
  type SshSession,
} from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Duration,
  EmptyState,
  FormField,
  IconButton,
  Input,
  MonoText,
  PageHeader,
  PropertyList,
  PropertyRow,
  RelativeTime,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  Textarea,
  TruncatedText,
  useToast,
  type DataTableColumn,
  type DataTableRowAction,
  type SortState,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import { ViewTabs } from "@/components/ViewTabs";
import {
  LockoutNotice,
  RollbackBanner,
  type LockoutAssessment,
  type RollbackWindow,
} from "@/components/RollbackBanner";
import { api, type ApiError } from "@/lib/api";
import {
  queryKeys,
  useCan,
  useList,
  useMutationWithJob,
  useResourceMutation,
  useServers,
} from "@/lib/queries";
import { formatCount, formatDateTime, pluralize } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * SSH security — three panels over one host context.
 *
 * Keys are fleet-level: one public key is normally trusted on several
 * hosts, so that panel can span the fleet. sshd configuration and live
 * sessions are host-level and always name the machine they belong to.
 *
 * Applying an sshd configuration gets the firewall's rollback treatment
 * for the same reason: it is the other way to lock yourself out of a
 * machine you are administering. The difference is that the host proves
 * the new configuration itself, so there is nothing to confirm — the
 * banner counts down and says exactly that.
 * ------------------------------------------------------------------ */

type View = "keys" | "config" | "sessions";

const ROOT_LOGIN_OPTIONS = [
  { value: "prohibit-password", label: "prohibit-password (keys only)" },
  { value: "no", label: "no" },
  { value: "forced-commands-only", label: "forced-commands-only" },
  { value: "yes", label: "yes" },
];

const ROLLBACK_OPTIONS = [
  { value: "30", label: "30 seconds" },
  { value: "60", label: "60 seconds" },
  { value: "120", label: "2 minutes" },
  { value: "300", label: "5 minutes" },
  { value: "0", label: "No rollback window" },
];

interface ApplyConfigResponse {
  job: Job;
  lockout: LockoutAssessment;
  rollback: { seconds: number; summary: string };
}

interface KeyResponse {
  ssh_key: SshKey;
  job: Job | null;
  jobs: Job[];
  correlation_id: string;
}

export default function SshPage() {
  const pathname = usePathname() ?? "/security/ssh";
  const searchParams = useSearchParams();
  const can = useCan();
  const { toast } = useToast();

  const requested = searchParams.get("panel");
  const view: View = requested === "config" || requested === "sessions" ? requested : "keys";

  const selection = useServerSelection({
    permission: "security.ssh:read",
    required: view !== "keys",
  });
  const serverId = selection.serverId;
  const serverName = selection.server?.name ?? "this server";

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["type"],
    extraParams: { server_id: serverId ?? undefined },
  });

  const keys = useList<SshKey>("ssh", state.params, {
    path: "/ssh/keys",
    enabled: view === "keys",
  });

  const config = useQuery<SshConfig, ApiError>({
    queryKey: queryKeys.sub("ssh", serverId ?? "none", "config"),
    queryFn: ({ signal }) =>
      api.get<SshConfig>("/ssh/config", { params: { server_id: serverId }, signal }),
    enabled: Boolean(serverId) && view === "config",
    staleTime: 30_000,
  });

  const sessions = useQuery<SshSession[], ApiError>({
    queryKey: queryKeys.sub("ssh", serverId ?? "none", "sessions"),
    queryFn: async ({ signal }) => {
      const result = await api.list<SshSession>("/ssh/sessions", {
        params: { server_id: serverId },
        signal,
      });
      return result.data;
    },
    enabled: Boolean(serverId) && view === "sessions",
    staleTime: 0,
    refetchInterval: view === "sessions" ? 15_000 : false,
  });

  const [addingKey, setAddingKey] = React.useState(false);
  const [removingKeys, setRemovingKeys] = React.useState<SshKey[] | null>(null);
  const [rollback, setRollback] = React.useState<RollbackWindow | null>(null);
  const [configError, setConfigError] = React.useState<ApiError | null>(null);
  const [lockout, setLockout] = React.useState<LockoutAssessment | null>(null);

  const mayWriteKeys = can("security.ssh:write");
  const mayWriteConfig = can("security.ssh:write", serverId);

  const addKey = useMutationWithJob<{ name: string; publicKey: string; serverIds: string[] }>({
    mutationFn: async ({ name, publicKey, serverIds }) => {
      const response = await api.post<KeyResponse>("/ssh/keys", {
        name,
        public_key: publicKey,
        server_ids: serverIds,
        user_id: null,
      });
      // A key with no servers is a control-plane row and returns no jobs;
      // the shared helper handles the empty list.
      return response;
    },
    invalidates: ["ssh"],
    describe: ({ name }) => `Install key ${name}`,
    onQueued: (jobs, { name }) => {
      setAddingKey(false);
      // A key trusted on no server never reaches a host, so there is no
      // job to watch and no pill to show.
      if (jobs.length === 0) {
        toast({
          variant: "success",
          title: `${name} registered`,
          description: "Trusted on no server yet, so nothing was written to a host.",
        });
      }
    },
  });

  const removeKeys = useMutationWithJob<SshKey[]>({
    mutationFn: async (rows) => {
      const jobs: Job[] = [];
      for (const row of rows) {
        const response = await api.del<{ job: Job | null; jobs: Job[] } | undefined>(
          `/ssh/keys/${row.id}`,
        );
        if (response?.jobs) jobs.push(...response.jobs);
      }
      return { jobs, correlation_id: globalThis.crypto.randomUUID() };
    },
    invalidates: ["ssh"],
    describe: (rows) =>
      rows.length === 1 ? `Remove key ${rows[0]!.name}` : `Remove ${rows.length} keys`,
    onQueued: () => {
      setRemovingKeys(null);
      state.setSelected([]);
    },
  });

  const reread = useResourceMutation<void, SshConfig>({
    mutationFn: () =>
      api.get<SshConfig>("/ssh/config", { params: { server_id: serverId, refresh: true } }),
    invalidates: ["ssh"],
    successMessage: () => `Re-read sshd configuration from ${serverName}.`,
  });

  const applyConfig = useMutationWithJob<{ patch: Partial<SshConfig>; rollbackSeconds: number }>({
    mutationFn: async ({ patch, rollbackSeconds }) => {
      setConfigError(null);
      const response = await api.put<ApplyConfigResponse>(
        "/ssh/config",
        { ...patch, rollback_seconds: rollbackSeconds },
        { params: { server_id: serverId } },
      );
      setLockout(response.lockout);
      setRollback({
        serverId: serverId!,
        serverName,
        subject: "sshd configuration",
        seconds: response.rollback.seconds,
        expiresAt: Date.now() + response.rollback.seconds * 1000,
        summary: response.rollback.summary,
        lockout: response.lockout,
      });
      return response;
    },
    invalidates: ["ssh"],
    describe: () => `Apply sshd configuration to ${serverName}`,
    onQueued: () => void config.refetch(),
    onFailed: (error) => setConfigError(error),
  });

  const tabsHref = React.useCallback(
    (next: View) => {
      const params = new URLSearchParams();
      if (serverId) params.set("server_id", serverId);
      if (next !== "keys") params.set("panel", next);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, serverId],
  );

  const tabs = (
    <ViewTabs
      label="SSH panels"
      current={view}
      tabs={[
        {
          id: "keys",
          label: "Authorized keys",
          href: tabsHref("keys"),
          icon: KeyRound,
          badge: keys.data ? formatCount(keys.data.meta.total) : undefined,
        },
        {
          id: "config",
          label: "sshd configuration",
          href: tabsHref("config"),
          icon: SlidersHorizontal,
        },
        {
          id: "sessions",
          label: "Active sessions",
          href: tabsHref("sessions"),
          icon: Terminal,
          badge: sessions.data ? formatCount(sessions.data.length) : undefined,
        },
      ]}
    />
  );

  const subtitle =
    view === "keys"
      ? "Public keys Kaname writes into authorized_keys"
      : (selection.server?.hostname ?? undefined);

  const newKey = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      disabled={!mayWriteKeys}
      onClick={() => setAddingKey(true)}
    >
      Add key
    </Button>
  );

  const keyColumns = React.useMemo<DataTableColumn<SshKey>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        sortable: true,
        locked: true,
        minWidth: 160,
        cell: (row) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">{row.name}</span>
            {row.comment && (
              <span className="truncate text-xs text-[var(--kn-text-3)]">{row.comment}</span>
            )}
          </div>
        ),
      },
      {
        id: "fingerprint",
        header: "Fingerprint",
        sortable: true,
        minWidth: 220,
        cell: (row) => <TruncatedText value={row.fingerprint} max={34} />,
      },
      {
        id: "type",
        header: "Type",
        sortable: true,
        mono: true,
        width: 156,
        accessor: (row) => row.type,
      },
      {
        id: "servers",
        header: "Servers",
        minWidth: 180,
        cell: (row) => <ServerList ids={row.server_ids} />,
      },
      {
        id: "last_used_at",
        header: "Last used",
        sortable: true,
        align: "right",
        width: 112,
        cell: (row) =>
          row.last_used_at ? (
            <RelativeTime value={row.last_used_at} />
          ) : (
            <span className="text-[var(--kn-text-3)]">never</span>
          ),
      },
    ],
    [],
  );

  const keyActions = React.useCallback(
    (row: SshKey): DataTableRowAction<SshKey>[] => [
      {
        id: "remove",
        label: "Remove key",
        icon: Trash2,
        destructive: true,
        disabled: !mayWriteKeys,
        onSelect: () => setRemovingKeys([row]),
      },
    ],
    [mayWriteKeys],
  );

  const dialogs = (
    <>
      <AddKeyDialog
        open={addingKey}
        pending={addKey.isPending}
        onClose={() => setAddingKey(false)}
        onSubmit={(name, publicKey, serverIds) => addKey.mutate({ name, publicKey, serverIds })}
      />

      <ConfirmDialog
        open={removingKeys !== null && removingKeys.length > 0}
        onOpenChange={(next) => !next && setRemovingKeys(null)}
        title={
          removingKeys && removingKeys.length === 1
            ? `Remove ${removingKeys[0]!.name}?`
            : `Remove ${removingKeys?.length ?? 0} keys?`
        }
        description="Kaname rewrites authorized_keys on every server the key was trusted on. An open session using it stays open until it disconnects."
        confirmText={
          removingKeys && removingKeys.length === 1
            ? removingKeys[0]!.name
            : `remove ${removingKeys?.length ?? 0} keys`
        }
        confirmLabel="Remove"
        loading={removeKeys.isPending}
        onConfirm={() => removingKeys && removeKeys.mutate(removingKeys)}
      >
        <ul className="flex flex-col gap-1">
          {removingKeys?.map((row) => (
            <li key={row.id}>
              <MonoText muted>{row.fingerprint}</MonoText>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );

  if (view === "keys") {
    return (
      <>
        <ResourcePage<SshKey>
          title="SSH security"
          subtitle={subtitle}
          tabs={tabs}
          primaryAction={newKey}
          state={state}
          query={keys}
          columns={keyColumns}
          getRowId={(row) => row.id}
          tableLabel="Authorized keys"
          density="compact"
          searchPlaceholder="Search name, comment or fingerprint"
          filters={
            <Select
              size="sm"
              aria-label="Key type"
              value={state.filters.type ?? ""}
              onChange={(event) => state.setFilter("type", event.target.value || null)}
              options={[
                { value: "", label: "Any key type" },
                { value: "ssh-ed25519", label: "ssh-ed25519" },
                { value: "ssh-rsa", label: "ssh-rsa" },
                { value: "ecdsa-sha2-nistp256", label: "ecdsa-sha2-nistp256" },
                { value: "ecdsa-sha2-nistp384", label: "ecdsa-sha2-nistp384" },
                { value: "ecdsa-sha2-nistp521", label: "ecdsa-sha2-nistp521" },
                { value: "sk-ssh-ed25519@openssh.com", label: "sk-ssh-ed25519 (FIDO)" },
                { value: "sk-ecdsa-sha2-nistp256@openssh.com", label: "sk-ecdsa-sha2 (FIDO)" },
              ]}
              boxClassName="w-52"
            />
          }
          selectable
          bulkActions={(ids) => (
            <Button
              variant="danger-subtle"
              size="xs"
              icon={Trash2}
              disabled={!mayWriteKeys}
              onClick={() =>
                setRemovingKeys((keys.data?.data ?? []).filter((row) => ids.includes(row.id)))
              }
            >
              Remove {ids.length === 1 ? "key" : `${ids.length} keys`}
            </Button>
          )}
          rowActions={keyActions}
          emptyIcon={KeyRound}
          emptyTitle="No keys registered"
          emptyDescription="Kaname writes authorized_keys from this list. A host with no key here depends entirely on password authentication."
          emptyAction={newKey}
          errorContext="SSH keys"
        >
          <ServerPicker selection={selection} allowAll allLabel="Every server" />
        </ResourcePage>
        {dialogs}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="SSH security"
        subtitle={subtitle}
        tabs={tabs}
        actions={
          view === "sessions" ? (
            <IconButton
              icon={RefreshCw}
              label="Refresh sessions"
              size="sm"
              disabled={sessions.isFetching}
              onClick={() => void sessions.refetch()}
            />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={reread.isPending || config.isFetching}
              disabled={!serverId}
              onClick={() => reread.mutate()}
            >
              Re-read from host
            </Button>
          )
        }
      />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        {rollback && <RollbackBanner window={rollback} onDismiss={() => setRollback(null)} />}

        <ServerPicker selection={selection} />

        {view === "config" ? (
          <ConfigPanel
            query={config}
            serverName={serverName}
            canWrite={mayWriteConfig}
            error={configError}
            lockout={lockout}
            submitting={applyConfig.isPending}
            onApply={(patch, rollbackSeconds) => applyConfig.mutate({ patch, rollbackSeconds })}
          />
        ) : (
          <SessionsPanel query={sessions} serverName={serverName} />
        )}
      </div>

      {dialogs}
    </div>
  );
}

/* ---------------------------- server names -------------------------- */

function ServerList({ ids }: { ids: readonly string[] }) {
  const servers = useServers();
  const byId = React.useMemo(
    () => new Map((servers.data?.data ?? []).map((server) => [server.id, server.name])),
    [servers.data],
  );

  if (ids.length === 0) {
    return (
      <span className="text-[var(--kn-text-3)]" title="Registered in Kaname but on no host.">
        no server
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {ids.slice(0, 3).map((id) => (
        <Badge key={id} tone="neutral" size="xs" mono>
          {byId.get(id) ?? id.slice(0, 8)}
        </Badge>
      ))}
      {ids.length > 3 && (
        <span className="kn-num text-xs text-[var(--kn-text-3)]">+{ids.length - 3}</span>
      )}
    </span>
  );
}

/* ----------------------------- add a key ---------------------------- */

interface AddKeyDialogProps {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string, publicKey: string, serverIds: string[]) => void;
}

function AddKeyDialog({ open, pending, onClose, onSubmit }: AddKeyDialogProps) {
  const servers = useServers();
  const [name, setName] = React.useState("");
  const [publicKey, setPublicKey] = React.useState("");
  const [serverIds, setServerIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) return;
    setName("");
    setPublicKey("");
    setServerIds([]);
  }, [open]);

  const keyError =
    publicKey.trim().length > 0 && !openSshPublicKey.safeParse(publicKey.trim()).success
      ? 'must be an OpenSSH public key, e.g. "ssh-ed25519 AAAAC3Nza... you@laptop"'
      : undefined;
  const valid = name.trim().length > 0 && !keyError && publicKey.trim().length > 0;

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
          onSubmit(name.trim(), publicKey.trim(), serverIds);
        }}
      >
        <DialogHeader
          title="Add an authorized key"
          description="Public key material only. Kaname never holds a private key."
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            <FormField label="Name" description="How this key is identified in the panel." required>
              <Input
                data-autofocus=""
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Laptop — ops"
                maxLength={64}
              />
            </FormField>

            <FormField label="Public key" error={keyError} required>
              <Textarea
                mono
                autoGrow
                maxRows={6}
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... you@laptop"
                spellCheck={false}
              />
            </FormField>

            <FormField
              label="Trust on"
              description="Each server named here gets its authorized_keys rewritten as a job."
            >
              <Combobox
                multiple
                options={(servers.data?.data ?? []).map((server) => ({
                  value: server.id,
                  label: server.name,
                  description: server.hostname,
                  mono: true,
                }))}
                value={serverIds}
                onValueChange={setServerIds}
                placeholder="No server yet"
                emptyMessage="No server matches that name."
                loading={servers.isLoading}
                mono
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
            Add key
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* --------------------------- sshd configuration --------------------- */

interface ConfigDraft {
  port: number;
  permit_root_login: SshConfig["permit_root_login"];
  password_authentication: boolean;
  pubkey_authentication: boolean;
  max_auth_tries: number;
  allow_users: string;
  allow_groups: string;
  x11_forwarding: boolean;
}

function toDraft(config: SshConfig): ConfigDraft {
  return {
    port: config.port,
    permit_root_login: config.permit_root_login,
    password_authentication: config.password_authentication,
    pubkey_authentication: config.pubkey_authentication,
    max_auth_tries: config.max_auth_tries,
    allow_users: config.allow_users.join(", "),
    allow_groups: config.allow_groups.join(", "),
    x11_forwarding: config.x11_forwarding,
  };
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface Change {
  label: string;
  from: string;
  to: string;
  /** Why this one is worth a second look before applying. */
  caution?: string;
}

function diffConfig(config: SshConfig, draft: ConfigDraft): Change[] {
  const changes: Change[] = [];

  if (draft.port !== config.port) {
    changes.push({
      label: "Port",
      from: String(config.port),
      to: String(draft.port),
      caution: `The firewall must already allow inbound TCP ${draft.port}, or the host becomes unreachable the moment sshd restarts.`,
    });
  }
  if (draft.permit_root_login !== config.permit_root_login) {
    changes.push({
      label: "PermitRootLogin",
      from: config.permit_root_login,
      to: draft.permit_root_login,
      caution:
        draft.permit_root_login === "no"
          ? "Make sure a non-root account with a working key exists on the host."
          : undefined,
    });
  }
  if (draft.password_authentication !== config.password_authentication) {
    changes.push({
      label: "PasswordAuthentication",
      from: String(config.password_authentication),
      to: String(draft.password_authentication),
      caution: draft.password_authentication
        ? undefined
        : "Every account that logs in must already have a key in authorized_keys.",
    });
  }
  if (draft.pubkey_authentication !== config.pubkey_authentication) {
    changes.push({
      label: "PubkeyAuthentication",
      from: String(config.pubkey_authentication),
      to: String(draft.pubkey_authentication),
      caution: draft.pubkey_authentication
        ? undefined
        : "Turning off key authentication leaves only passwords.",
    });
  }
  if (draft.max_auth_tries !== config.max_auth_tries) {
    changes.push({
      label: "MaxAuthTries",
      from: String(config.max_auth_tries),
      to: String(draft.max_auth_tries),
    });
  }

  const users = parseList(draft.allow_users);
  if (users.join(",") !== config.allow_users.join(",")) {
    changes.push({
      label: "AllowUsers",
      from: config.allow_users.join(" ") || "(unset — every account)",
      to: users.join(" ") || "(unset — every account)",
      caution:
        users.length > 0 ? "Any account not on this list can no longer log in at all." : undefined,
    });
  }

  const groups = parseList(draft.allow_groups);
  if (groups.join(",") !== config.allow_groups.join(",")) {
    changes.push({
      label: "AllowGroups",
      from: config.allow_groups.join(" ") || "(unset — every group)",
      to: groups.join(" ") || "(unset — every group)",
    });
  }

  if (draft.x11_forwarding !== config.x11_forwarding) {
    changes.push({
      label: "X11Forwarding",
      from: String(config.x11_forwarding),
      to: String(draft.x11_forwarding),
    });
  }

  return changes;
}

function toPatch(draft: ConfigDraft): Partial<SshConfig> {
  return {
    port: draft.port,
    permit_root_login: draft.permit_root_login,
    password_authentication: draft.password_authentication,
    pubkey_authentication: draft.pubkey_authentication,
    max_auth_tries: draft.max_auth_tries,
    allow_users: parseList(draft.allow_users),
    allow_groups: parseList(draft.allow_groups),
    x11_forwarding: draft.x11_forwarding,
  };
}

interface ConfigPanelProps {
  query: UseQueryResult<SshConfig, ApiError>;
  serverName: string;
  canWrite: boolean;
  error: ApiError | null;
  lockout: LockoutAssessment | null;
  submitting: boolean;
  onApply: (patch: Partial<SshConfig>, rollbackSeconds: number) => void;
}

function ConfigPanel({
  query,
  serverName,
  canWrite,
  error,
  lockout,
  submitting,
  onApply,
}: ConfigPanelProps) {
  const config = query.data ?? null;
  const [draft, setDraft] = React.useState<ConfigDraft | null>(null);
  const [reviewing, setReviewing] = React.useState(false);
  const [rollbackSeconds, setRollbackSeconds] = React.useState(60);

  React.useEffect(() => {
    if (config) setDraft(toDraft(config));
  }, [config]);

  if (query.isError) {
    return (
      <PageError
        error={query.error}
        onRetry={() => void query.refetch()}
        context="sshd configuration"
      />
    );
  }

  if (!config || !draft) {
    return (
      <Skeleton className="h-72 rounded-[var(--kn-r-md)]" label="Loading sshd configuration" />
    );
  }

  const set = <K extends keyof ConfigDraft>(key: K, value: ConfigDraft[K]) =>
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));

  const changes = diffConfig(config, draft);

  return (
    <>
      {error && <PageError error={error} context="Apply sshd configuration" />}
      <LockoutNotice assessment={lockout} subject="The applied sshd configuration" />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_288px]">
        <SectionCard
          title="sshd configuration"
          icon={SlidersHorizontal}
          description={`Read from ${serverName}. Nothing is written until you apply.`}
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={Zap}
              disabled={!canWrite || changes.length === 0}
              onClick={() => setReviewing(true)}
            >
              Review and apply
            </Button>
          }
          footer={
            changes.length === 0
              ? "No unapplied change."
              : `${pluralize(changes.length, "unapplied change")}.`
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <FormField label="Port" required>
                <Input
                  type="number"
                  mono
                  min={1}
                  max={65535}
                  value={String(draft.port)}
                  disabled={!canWrite}
                  onChange={(event) => set("port", Number(event.target.value))}
                />
              </FormField>
              <FormField label="PermitRootLogin">
                <Select
                  value={draft.permit_root_login}
                  disabled={!canWrite}
                  onChange={(event) =>
                    set("permit_root_login", event.target.value as ConfigDraft["permit_root_login"])
                  }
                  options={ROOT_LOGIN_OPTIONS}
                />
              </FormField>
              <FormField label="MaxAuthTries" description="Failures allowed per connection.">
                <Input
                  type="number"
                  mono
                  min={1}
                  max={20}
                  value={String(draft.max_auth_tries)}
                  disabled={!canWrite}
                  onChange={(event) => set("max_auth_tries", Number(event.target.value))}
                />
              </FormField>
            </div>

            <div className="flex flex-col gap-3">
              <Switch
                checked={draft.password_authentication}
                disabled={!canWrite}
                onChange={(event) => set("password_authentication", event.target.checked)}
                label="PasswordAuthentication"
                description="Off is the safer setting once every account has a key."
              />
              <Switch
                checked={draft.pubkey_authentication}
                disabled={!canWrite}
                onChange={(event) => set("pubkey_authentication", event.target.checked)}
                label="PubkeyAuthentication"
              />
              <Switch
                checked={draft.x11_forwarding}
                disabled={!canWrite}
                onChange={(event) => set("x11_forwarding", event.target.checked)}
                label="X11Forwarding"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="AllowUsers"
                description="Comma separated. Empty means every account may log in."
              >
                <Input
                  mono
                  value={draft.allow_users}
                  disabled={!canWrite}
                  onChange={(event) => set("allow_users", event.target.value)}
                  placeholder="deploy, ops"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField
                label="AllowGroups"
                description="Comma separated. Empty means every group."
              >
                <Input
                  mono
                  value={draft.allow_groups}
                  disabled={!canWrite}
                  onChange={(event) => set("allow_groups", event.target.value)}
                  placeholder="wheel"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Applied state" icon={ServerIcon} headingLevel={3}>
          <PropertyList dense labelWidth="sm">
            <PropertyRow label="Server">{config.server_name}</PropertyRow>
            <PropertyRow label="Port" mono copyValue={String(config.port)}>
              {config.port}
            </PropertyRow>
            <PropertyRow label="Root login" mono>
              {config.permit_root_login}
            </PropertyRow>
            <PropertyRow label="Passwords">
              <StatusBadge tone={config.password_authentication ? "warn" : "ok"} size="xs">
                {config.password_authentication ? "enabled" : "disabled"}
              </StatusBadge>
            </PropertyRow>
            <PropertyRow label="Keys">
              <StatusBadge tone={config.pubkey_authentication ? "ok" : "danger"} size="xs">
                {config.pubkey_authentication ? "enabled" : "disabled"}
              </StatusBadge>
            </PropertyRow>
            <PropertyRow label="AllowUsers" mono>
              {config.allow_users.join(" ") || null}
            </PropertyRow>
            <PropertyRow label="Last applied">
              {config.last_applied_at ? formatDateTime(config.last_applied_at) : null}
            </PropertyRow>
            <PropertyRow label="Read from host">
              <RelativeTime value={config.last_synced_at} />
            </PropertyRow>
          </PropertyList>
        </SectionCard>
      </div>

      <Dialog open={reviewing} onOpenChange={setReviewing} size="md" dismissible={!submitting}>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting) return;
            onApply(toPatch(draft), rollbackSeconds);
            setReviewing(false);
          }}
        >
          <DialogHeader
            title={`Apply sshd configuration to ${serverName}`}
            description="sshd is reloaded on the host. Open a second session before you close this one."
          />
          <DialogBody>
            <div className="flex flex-col gap-4">
              <dl className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)]">
                {changes.map((change) => (
                  <div
                    key={change.label}
                    className="border-t border-[var(--kn-border-subtle)] px-3 py-2 first:border-t-0"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <dt className="kn-mono font-medium text-[var(--kn-text)]">{change.label}</dt>
                      <dd className="kn-mono m-0 text-[var(--kn-text-2)]">
                        <span className="line-through">{change.from}</span>
                        <span className="mx-1 text-[var(--kn-text-3)]">→</span>
                        <span className="text-[var(--kn-text)]">{change.to}</span>
                      </dd>
                    </div>
                    {change.caution && (
                      <p className="mt-1 text-[var(--kn-warn)]">{change.caution}</p>
                    )}
                  </div>
                ))}
              </dl>

              <FormField
                label="Rollback window"
                description="The host restores its current configuration if the new one does not hold."
              >
                <Select
                  value={String(rollbackSeconds)}
                  onChange={(event) => setRollbackSeconds(Number(event.target.value))}
                  options={ROLLBACK_OPTIONS}
                />
              </FormField>

              {rollbackSeconds === 0 && (
                <p className="text-[var(--kn-danger)]">
                  With no rollback window, a configuration that locks you out stays that way until
                  someone reaches the console.
                </p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={() => setReviewing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={rollbackSeconds === 0 ? "danger" : "primary"}
              loading={submitting}
            >
              Apply
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  );
}

/* ------------------------------ sessions ---------------------------- */

function SessionsPanel({
  query,
  serverName,
}: {
  query: UseQueryResult<SshSession[], ApiError>;
  serverName: string;
}) {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortState | null>({ id: "started_at", order: "desc" });

  const rows = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = (query.data ?? []).filter((session) =>
      needle.length === 0
        ? true
        : session.user.toLowerCase().includes(needle) ||
          session.from_ip.toLowerCase().includes(needle) ||
          session.tty.toLowerCase().includes(needle),
    );
    if (!sort) return filtered;
    const factor = sort.order === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => factor * compareSessions(a, b, sort.id));
  }, [query.data, search, sort]);

  const columns = React.useMemo<DataTableColumn<SshSession>[]>(
    () => [
      {
        id: "user",
        header: "User",
        sortable: true,
        locked: true,
        mono: true,
        minWidth: 140,
        accessor: (row) => row.user,
      },
      {
        id: "from_ip",
        header: "From",
        sortable: true,
        mono: true,
        minWidth: 160,
        accessor: (row) => row.from_ip,
      },
      {
        id: "tty",
        header: "TTY",
        mono: true,
        width: 108,
        accessor: (row) => row.tty,
      },
      {
        id: "pid",
        header: "PID",
        mono: true,
        align: "right",
        width: 88,
        hideBelow: "md",
        accessor: (row) => row.pid,
      },
      {
        id: "started_at",
        header: "Started",
        sortable: true,
        align: "right",
        width: 116,
        cell: (row) => <RelativeTime value={row.started_at} />,
      },
      {
        id: "idle_seconds",
        header: "Idle",
        sortable: true,
        align: "right",
        width: 96,
        cell: (row) => <Duration ms={row.idle_seconds * 1000} units={2} />,
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Active sessions"
      icon={Terminal}
      padded={false}
      footer={`Read live from ${serverName} on every refresh — a session list is only true at the instant it is taken. Nothing here is cached.`}
    >
      <DataTable<SshSession>
        columns={columns}
        rows={rows}
        getRowId={(row) => `${row.pid}:${row.tty}`}
        label="Active SSH sessions"
        density="compact"
        columnVisibility={false}
        sort={sort}
        onSortChange={setSort}
        toolbar={
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <SearchInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => setSearch("")}
              placeholder="Search user, address or tty"
              aria-label="Search active sessions"
              size="sm"
              boxClassName="w-56"
            />
            <span className="ml-auto text-xs text-[var(--kn-text-3)]">
              {formatCount(rows.length)} open
            </span>
          </div>
        }
        loading={query.isLoading}
        skeletonRows={3}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Active sessions"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={Terminal}
            title="No open SSH session"
            description={`Nobody is logged into ${serverName} over SSH right now.`}
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

function compareSessions(a: SshSession, b: SshSession, id: string): number {
  switch (id) {
    case "user":
      return a.user.localeCompare(b.user);
    case "from_ip":
      return a.from_ip.localeCompare(b.from_ip);
    case "idle_seconds":
      return a.idle_seconds - b.idle_seconds;
    case "started_at":
    default:
      return Date.parse(a.started_at) - Date.parse(b.started_at);
  }
}
