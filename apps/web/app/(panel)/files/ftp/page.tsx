"use client";

import * as React from "react";
import { ArrowLeftRight, KeyRound, Pencil, Plus, Radio, Trash2, Users } from "lucide-react";
import type { FtpAccount, FtpSession } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  ConfirmDialog,
  DataTable,
  Drawer,
  DrawerBody,
  DrawerHeader,
  EmptyState,
  FormField,
  Input,
  MonoText,
  RelativeTime,
  Select,
  Switch,
  Textarea,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { useCan } from "@/lib/queries";
import { HostCell, LifecycleBadge, UsageBar } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import { PasswordField, PasswordResetDialog, generatePassword } from "../../_components/password";
import {
  useCreateFtpAccount,
  useDeleteFtpAccount,
  useFtpAccounts,
  useFtpSessions,
  useResetFtpPassword,
  useUpdateFtpAccount,
} from "../_components/queries";
import { ProtocolBadge } from "../_components/status";

/* ------------------------------------------------------------------ *
 * FTP / SFTP accounts.
 *
 * A transfer account is two things at once: a row in Kaname and a POSIX
 * user with a home directory and a credential on the host. The row
 * appears the moment the operator asks for it and reads `provisioning`
 * until the job that creates the user lands — which is why the status
 * column exists at all, and why nothing here reports its own outcome.
 * ------------------------------------------------------------------ */

const FTP_JOB_TYPES = ["ftp."] as const;
const GIB = 1024 * 1024 * 1024;

type Protocol = FtpAccount["protocol"];
type AccountStatus = FtpAccount["status"];

interface AccountForm {
  serverId: string;
  username: string;
  protocol: Protocol;
  homeDir: string;
  quotaGib: string;
  sshPublicKey: string;
}

const EMPTY_FORM: AccountForm = {
  serverId: "",
  username: "",
  protocol: "sftp",
  homeDir: "",
  quotaGib: "0",
  sshPublicKey: "",
};

function quotaBytes(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * GIB);
}

export default function FtpAccountsPage() {
  const can = useCan();
  const selection = useServerSelection({ permission: "files.ftp:read" });
  const serverId = selection.serverId;

  const state = useResourceListState({
    defaultSort: { id: "username", order: "asc" },
    filterKeys: ["protocol", "status", "over_quota"],
    extraParams: React.useMemo(() => ({ server_id: serverId ?? undefined }), [serverId]),
  });

  const query = useFtpAccounts(state.params);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<FtpAccount | null>(null);
  const [resetting, setResetting] = React.useState<FtpAccount | null>(null);
  const [sessionsFor, setSessionsFor] = React.useState<FtpAccount | null>(null);
  const [deleting, setDeleting] = React.useState<readonly FtpAccount[] | null>(null);
  const [password, setPassword] = React.useState("");

  const create = useCreateFtpAccount();
  const update = useUpdateFtpAccount();
  const remove = useDeleteFtpAccount();
  const reset = useResetFtpPassword();

  const canWrite = can("files.ftp:write", serverId);
  const canDelete = can("files.ftp:delete", serverId);

  const rows = query.data?.data ?? [];
  const byId = React.useMemo(
    () => new Map(rows.map((account) => [account.id, account] as const)),
    [rows],
  );

  const columns = React.useMemo<DataTableColumn<FtpAccount>[]>(
    () => [
      {
        id: "username",
        header: "Username",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 160,
        cell: (account) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
              {account.username}
            </MonoText>
            {account.ssh_key_fingerprint && (
              <Badge
                tone="accent"
                size="xs"
                icon={KeyRound}
                title={`Key authentication is available: ${account.ssh_key_fingerprint}`}
              >
                key
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "protocol",
        header: "Protocol",
        sortable: true,
        width: 96,
        cell: (account) => <ProtocolBadge protocol={account.protocol} />,
      },
      {
        id: "home_dir",
        header: "Home directory",
        sortable: true,
        mono: true,
        minWidth: 200,
        hideBelow: "md",
        cell: (account) => (
          <MonoText muted truncate className="min-w-0">
            {account.home_dir}
          </MonoText>
        ),
      },
      {
        id: "used_bytes",
        header: "Quota",
        sortable: true,
        width: 176,
        cell: (account) => (
          <UsageBar
            used={account.used_bytes}
            total={account.quota_bytes}
            label={`${account.username} quota`}
          />
        ),
      },
      {
        id: "last_login_at",
        header: "Last login",
        sortable: true,
        width: 112,
        align: "right",
        cell: (account) => <RelativeTime value={account.last_login_at} fallback="never" />,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 120,
        cell: (account) => <LifecycleBadge status={account.status} />,
      },
      {
        id: "server_name",
        header: "Server",
        width: 172,
        hideBelow: "lg",
        cell: (account) => (
          <HostCell serverId={account.server_id} serverName={account.server_name} />
        ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (account: FtpAccount): DataTableRowAction<FtpAccount>[] => [
      {
        id: "edit",
        label: "Edit",
        icon: Pencil,
        disabled: !can("files.ftp:write", account.server_id),
        onSelect: () => {
          update.reset();
          setEditing(account);
        },
      },
      {
        id: "reset",
        label: "Reset password",
        icon: KeyRound,
        disabled: !can("files.ftp:write", account.server_id),
        onSelect: () => {
          setPassword(generatePassword());
          reset.reset();
          setResetting(account);
        },
      },
      {
        id: "sessions",
        label: "Active sessions",
        icon: Users,
        onSelect: () => setSessionsFor(account),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled: !can("files.ftp:delete", account.server_id),
        onSelect: () => {
          remove.reset();
          setDeleting([account]);
        },
      },
    ],
    [can, remove, reset, update],
  );

  return (
    <>
      <ResourcePage<FtpAccount>
        title="FTP / SFTP"
        subtitle={selection.server?.hostname}
        state={state}
        query={query}
        columns={columns}
        getRowId={(account) => account.id}
        tableLabel="Transfer accounts"
        density="default"
        searchPlaceholder="Username or home directory"
        errorContext="Transfer accounts"
        emptyIcon={ArrowLeftRight}
        emptyTitle="No transfer accounts"
        emptyDescription="An SFTP or FTPS account gives someone a home directory on a host without giving them the panel."
        emptyAction={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!canWrite}
            onClick={() => {
              setPassword(generatePassword());
              create.reset();
              setCreateOpen(true);
            }}
          >
            New account
          </Button>
        }
        primaryAction={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!canWrite}
            onClick={() => {
              setPassword(generatePassword());
              create.reset();
              setCreateOpen(true);
            }}
          >
            New account
          </Button>
        }
        filters={
          <>
            <Select
              size="sm"
              value={state.filters["protocol"] ?? ""}
              onChange={(event) => state.setFilter("protocol", event.target.value || null)}
              aria-label="Protocol"
              boxClassName="w-32"
              options={[
                { value: "", label: "All protocols" },
                { value: "sftp", label: "SFTP" },
                { value: "ftps", label: "FTPS" },
              ]}
            />
            <Select
              size="sm"
              value={state.filters["status"] ?? ""}
              onChange={(event) => state.setFilter("status", event.target.value || null)}
              aria-label="Status"
              boxClassName="w-36"
              options={[
                { value: "", label: "Any status" },
                { value: "active", label: "Active" },
                { value: "provisioning", label: "Provisioning" },
                { value: "suspended", label: "Suspended" },
                { value: "error", label: "Error" },
              ]}
            />
            <Switch
              checked={state.filters["over_quota"] === "true"}
              onChange={(event) =>
                state.setFilter("over_quota", event.target.checked ? "true" : null)
              }
              label="Over quota"
              labelClassName="text-sm text-[var(--kn-text-2)]"
            />
          </>
        }
        selectable
        bulkActions={(ids) => (
          <Button
            variant="danger-subtle"
            size="xs"
            icon={Trash2}
            disabled={!canDelete}
            onClick={() => {
              remove.reset();
              setDeleting(
                ids
                  .map((id) => byId.get(id))
                  .filter((account): account is FtpAccount => Boolean(account)),
              );
            }}
          >
            Delete
          </Button>
        )}
        rowActions={rowActions}
        onRowClick={(account) => setSessionsFor(account)}
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll allLabel="All servers" />
        </div>
        <JobActivityBar types={FTP_JOB_TYPES} title="Account changes" />
      </ResourcePage>

      {createOpen && (
        <AccountDialog
          mode="create"
          servers={selection.servers.map((server) => ({ id: server.id, name: server.name }))}
          defaultServerId={serverId ?? selection.servers[0]?.id ?? ""}
          password={password}
          onPasswordChange={setPassword}
          submitting={create.isPending}
          error={create.error}
          onClose={() => setCreateOpen(false)}
          onSubmit={(form) =>
            create.mutate(
              {
                server_id: form.serverId,
                username: form.username.trim(),
                password,
                protocol: form.protocol,
                home_dir: form.homeDir.trim(),
                quota_bytes: quotaBytes(form.quotaGib),
                ...(form.sshPublicKey.trim() ? { ssh_public_key: form.sshPublicKey.trim() } : {}),
              },
              { onSuccess: () => setCreateOpen(false) },
            )
          }
        />
      )}

      {editing && (
        <AccountDialog
          mode="edit"
          account={editing}
          servers={[{ id: editing.server_id, name: editing.server_name }]}
          defaultServerId={editing.server_id}
          submitting={update.isPending}
          error={update.error}
          onClose={() => setEditing(null)}
          onSubmit={(form) =>
            update.mutate(
              {
                id: editing.id,
                username: editing.username,
                input: {
                  protocol: form.protocol,
                  home_dir: form.homeDir.trim(),
                  quota_bytes: quotaBytes(form.quotaGib),
                  ...(form.status ? { status: form.status } : {}),
                  ...(form.sshPublicKey.trim() ? { ssh_public_key: form.sshPublicKey.trim() } : {}),
                },
              },
              { onSuccess: () => setEditing(null) },
            )
          }
        />
      )}

      {resetting && (
        <PasswordResetDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setResetting(null);
              reset.reset();
            }
          }}
          subject={resetting.username}
          password={password}
          onPasswordChange={setPassword}
          submitting={reset.isPending}
          error={reset.error}
          job={reset.data?.[0] ?? null}
          onSubmit={() =>
            reset.mutate({ id: resetting.id, username: resetting.username, password })
          }
        />
      )}

      {deleting && deleting.length > 0 && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleting(null);
          }}
          title={
            deleting.length === 1
              ? `Delete ${deleting[0]!.username}?`
              : `Delete ${deleting.length} accounts?`
          }
          description="The POSIX user and its credential are removed from the host. The home directory and everything in it are left where they are."
          confirmText={
            deleting.length === 1 ? deleting[0]!.username : `delete ${deleting.length} accounts`
          }
          confirmLabel="Delete"
          loading={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              deleting.map((account) => ({ id: account.id, username: account.username })),
              {
                onSuccess: () => {
                  setDeleting(null);
                  state.setSelected([]);
                },
              },
            )
          }
        >
          <ul className="rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-2 py-1.5">
            {deleting.map((account) => (
              <li key={account.id} className="kn-mono truncate text-[var(--kn-text-2)]">
                {account.username} — {account.home_dir}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}

      <SessionsDrawer account={sessionsFor} onClose={() => setSessionsFor(null)} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Create / edit
 * ------------------------------------------------------------------ */

interface AccountDialogProps {
  mode: "create" | "edit";
  account?: FtpAccount;
  servers: readonly { id: string; name: string }[];
  defaultServerId: string;
  password?: string;
  onPasswordChange?: (password: string) => void;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (form: AccountForm & { status?: AccountStatus }) => void;
}

function AccountDialog({
  mode,
  account,
  servers,
  defaultServerId,
  password,
  onPasswordChange,
  submitting,
  error,
  onClose,
  onSubmit,
}: AccountDialogProps) {
  const [form, setForm] = React.useState<AccountForm>(() =>
    account
      ? {
          serverId: account.server_id,
          username: account.username,
          protocol: account.protocol,
          homeDir: account.home_dir,
          quotaGib: account.quota_bytes > 0 ? String(account.quota_bytes / GIB) : "0",
          sshPublicKey: "",
        }
      : { ...EMPTY_FORM, serverId: defaultServerId },
  );
  const [status, setStatus] = React.useState<AccountStatus>(account?.status ?? "active");
  /** Stops the derived home directory from overwriting a hand-edited one. */
  const [homeTouched, setHomeTouched] = React.useState(mode === "edit");

  const errors = fieldErrors(error);
  const set = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const username = form.username.trim();
  const homeDir = homeTouched ? form.homeDir : username ? `/home/${username}` : "";
  const usernameProblem =
    username.length > 0 && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(username)
      ? "A POSIX user name starts with a letter or underscore and holds letters, digits, dashes and underscores."
      : null;
  const homeProblem =
    homeDir.length > 0 && !homeDir.startsWith("/") ? "Give an absolute path." : null;

  const canSubmit =
    (mode === "edit" || (username.length > 0 && usernameProblem === null)) &&
    homeDir.length > 0 &&
    homeProblem === null &&
    form.serverId.length > 0 &&
    (mode === "edit" || (password?.length ?? 0) >= 16);

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={mode === "create" ? "New transfer account" : `Edit ${account?.username ?? ""}`}
      description={
        mode === "create"
          ? "Kaname creates the POSIX user, its home directory and its credential on the host."
          : "The server, the username and the password are fixed once the account exists; changing any of them is a new account."
      }
      submitLabel={mode === "create" ? "Create account" : "Save changes"}
      submitting={submitting}
      canSubmit={canSubmit}
      error={error}
      onSubmit={() => onSubmit({ ...form, homeDir, status: mode === "edit" ? status : undefined })}
    >
      {mode === "create" && (
        <FormField label="Server" required error={errors["server_id"]}>
          <Select
            value={form.serverId}
            onChange={(event) => set("serverId", event.target.value)}
            placeholder="Pick a server"
            options={servers.map((server) => ({ value: server.id, label: server.name }))}
            mono
          />
        </FormField>
      )}

      {mode === "create" && (
        <FormField
          label="Username"
          required
          error={usernameProblem ?? errors["username"]}
          description="Becomes a real user on the host, so it has to be unique there."
        >
          <Input
            mono
            data-autofocus=""
            value={form.username}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              set("username", event.target.value)
            }
            placeholder="deploy"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      )}

      <FormField
        label="Protocol"
        description="SFTP rides the host's SSH daemon and is the only protocol whose live sessions Kaname can list."
        error={errors["protocol"]}
      >
        <Select
          value={form.protocol}
          onChange={(event) => set("protocol", event.target.value as Protocol)}
          options={[
            { value: "sftp", label: "SFTP — over SSH" },
            { value: "ftps", label: "FTPS — FTP with TLS" },
          ]}
        />
      </FormField>

      <FormField
        label="Home directory"
        required
        error={homeProblem ?? errors["home_dir"]}
        description="The account is confined to this directory."
      >
        <Input
          mono
          value={homeDir}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setHomeTouched(true);
            set("homeDir", event.target.value);
          }}
          placeholder="/home/deploy"
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField
        label="Quota"
        error={errors["quota_bytes"]}
        description="0 means the account is bounded only by the filesystem."
        hint="GiB"
      >
        <Input
          mono
          type="number"
          min={0}
          step="0.5"
          value={form.quotaGib}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            set("quotaGib", event.target.value)
          }
        />
      </FormField>

      {mode === "edit" && (
        <FormField
          label="Status"
          description="Suspending keeps the user and its files but refuses logins."
        >
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as AccountStatus)}
            options={[
              { value: "active", label: "Active" },
              { value: "suspended", label: "Suspended" },
            ]}
          />
        </FormField>
      )}

      <FormField
        label="SSH public key"
        error={errors["ssh_public_key"]}
        description="Optional, SFTP only. Registered under Security › SSH as well, because the panel must be able to show every key that can reach a host."
      >
        <Textarea
          mono
          rows={3}
          value={form.sshPublicKey}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
            set("sshPublicKey", event.target.value)
          }
          placeholder="ssh-ed25519 AAAA… deploy@laptop"
          spellCheck={false}
        />
      </FormField>

      {mode === "create" && password !== undefined && onPasswordChange && (
        <PasswordField value={password} onChange={onPasswordChange} error={errors["password"]} />
      )}
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Live sessions
 * ------------------------------------------------------------------ */

function SessionsDrawer({ account, onClose }: { account: FtpAccount | null; onClose: () => void }) {
  const query = useFtpSessions(account?.id ?? null, { page: 1, per_page: 50 });

  const columns = React.useMemo<DataTableColumn<FtpSession>[]>(
    () => [
      {
        id: "from_ip",
        header: "From",
        mono: true,
        minWidth: 140,
        accessor: (session) => session.from_ip,
      },
      {
        id: "started_at",
        header: "Started",
        width: 112,
        align: "right",
        cell: (session) => <RelativeTime value={session.started_at} />,
      },
      {
        id: "bytes_transferred",
        header: "Transferred",
        width: 112,
        align: "right",
        cell: (session) =>
          session.bytes_transferred > 0 ? (
            <ByteSize bytes={session.bytes_transferred} />
          ) : (
            <span className="text-[var(--kn-text-3)]">not reported</span>
          ),
      },
    ],
    [],
  );

  return (
    <Drawer
      open={account !== null}
      onOpenChange={(next) => !next && onClose()}
      side="right"
      size="md"
    >
      <DrawerHeader
        title={account ? `Sessions — ${account.username}` : "Sessions"}
        description="Read live from the host, so this list is exactly what is connected right now."
        actions={
          <Button variant="ghost" size="xs" onClick={() => void query.refetch()}>
            Refresh
          </Button>
        }
      />
      <DrawerBody className="px-4 py-3">
        {query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} context="Sessions" />
        ) : (
          <DataTable<FtpSession>
            columns={columns}
            rows={query.data?.data ?? []}
            getRowId={(session) => `${session.from_ip}-${session.started_at}`}
            label="Active sessions"
            density="compact"
            columnVisibility={false}
            loading={query.isLoading}
            skeletonRows={3}
            empty={
              <EmptyState
                icon={Radio}
                title="Nobody is connected"
                description="No open session belongs to this account right now."
                size="sm"
              />
            }
          />
        )}
      </DrawerBody>
    </Drawer>
  );
}
