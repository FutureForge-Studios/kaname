"use client";

import * as React from "react";
import { Gauge, KeyRound, Mail, Pencil, Plus, Trash2 } from "lucide-react";
import type { MailDomain, Mailbox } from "@kaname/contract";
import {
  Button,
  ByteSize,
  ConfirmDialog,
  FormField,
  Input,
  MonoText,
  RelativeTime,
  Select,
  Switch,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { formatCount } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { HostCell, LifecycleBadge, UsageBar } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import { PasswordField, PasswordResetDialog, generatePassword } from "../../_components/password";
import {
  useCreateMailbox,
  useDeleteMailboxes,
  useMailDomains,
  useMailboxes,
  useResetMailboxPassword,
  useSetMailboxQuota,
  useUpdateMailbox,
} from "../_components/queries";
import { DomainPicker } from "../_components/status";

/* ------------------------------------------------------------------ *
 * Mailboxes.
 *
 * The row exists in Kaname the moment it is asked for and reads
 * `provisioning` until the host has the maildir and the credential — so
 * every column that comes from the host (usage, message count, last
 * login) carries a sync time rather than pretending to be live.
 *
 * Quota is the number operators actually watch here, because a mailbox
 * at its limit stops accepting mail silently as far as its owner is
 * concerned. It gets a bar, not a figure.
 * ------------------------------------------------------------------ */

const MAILBOX_JOB_TYPES = ["mail.mailbox."] as const;
const GIB = 1024 * 1024 * 1024;

type MailStatus = Mailbox["status"];

function quotaBytes(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * GIB);
}

function quotaGib(bytes: number): string {
  return bytes > 0 ? String(Number((bytes / GIB).toFixed(2))) : "0";
}

export default function MailboxesPage() {
  const can = useCan();
  const domains = useMailDomains();

  const state = useResourceListState({
    defaultSort: { id: "address", order: "asc" },
    filterKeys: ["mail_domain_id", "status", "over_quota"],
  });

  const query = useMailboxes(state.params);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Mailbox | null>(null);
  const [quotaFor, setQuotaFor] = React.useState<Mailbox | null>(null);
  const [resetting, setResetting] = React.useState<Mailbox | null>(null);
  const [deleting, setDeleting] = React.useState<readonly Mailbox[] | null>(null);
  const [password, setPassword] = React.useState("");
  const [revokeSessions, setRevokeSessions] = React.useState(true);
  const [deleteMaildir, setDeleteMaildir] = React.useState(false);

  const create = useCreateMailbox();
  const update = useUpdateMailbox();
  const quota = useSetMailboxQuota();
  const reset = useResetMailboxPassword();
  const remove = useDeleteMailboxes();

  const rows = query.data?.data ?? [];
  const byId = React.useMemo(
    () => new Map(rows.map((mailbox) => [mailbox.id, mailbox] as const)),
    [rows],
  );

  const domainList = domains.data?.data ?? [];
  const selectedDomainId = state.filters["mail_domain_id"] ?? null;
  const canCreate =
    domainList.length > 0 &&
    domainList.some((domain) => can("email.mailboxes:write", domain.server_id));

  const openCreate = () => {
    setPassword(generatePassword());
    create.reset();
    setCreateOpen(true);
  };

  const columns = React.useMemo<DataTableColumn<Mailbox>[]>(
    () => [
      {
        id: "address",
        header: "Address",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 220,
        cell: (mailbox) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {mailbox.address}
          </MonoText>
        ),
      },
      {
        id: "display_name",
        header: "Display name",
        minWidth: 160,
        hideBelow: "lg",
        cell: (mailbox) =>
          mailbox.display_name ? (
            <span className="truncate">{mailbox.display_name}</span>
          ) : (
            <span className="text-[var(--kn-text-3)]">—</span>
          ),
      },
      {
        id: "used_bytes",
        header: "Quota",
        sortable: true,
        width: 176,
        cell: (mailbox) => (
          <UsageBar
            used={mailbox.used_bytes}
            total={mailbox.quota_bytes}
            label={`${mailbox.address} quota`}
          />
        ),
      },
      {
        id: "message_count",
        header: "Messages",
        sortable: true,
        width: 96,
        align: "right",
        accessor: (mailbox) => formatCount(mailbox.message_count),
      },
      {
        id: "last_login_at",
        header: "Last login",
        sortable: true,
        width: 112,
        align: "right",
        cell: (mailbox) => <RelativeTime value={mailbox.last_login_at} fallback="never" />,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 120,
        cell: (mailbox) => <LifecycleBadge status={mailbox.status} />,
      },
      {
        id: "server_name",
        header: "Host",
        width: 172,
        hideBelow: "lg",
        cell: (mailbox) => (
          <HostCell serverId={mailbox.server_id} serverName={mailbox.server_name} />
        ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (mailbox: Mailbox): DataTableRowAction<Mailbox>[] => {
      const writable = can("email.mailboxes:write", mailbox.server_id);
      return [
        {
          id: "edit",
          label: "Edit",
          icon: Pencil,
          disabled: !writable,
          onSelect: () => {
            update.reset();
            setEditing(mailbox);
          },
        },
        {
          id: "quota",
          label: "Change quota",
          icon: Gauge,
          disabled: !writable,
          onSelect: () => {
            quota.reset();
            setQuotaFor(mailbox);
          },
        },
        {
          id: "reset",
          label: "Reset password",
          icon: KeyRound,
          disabled: !writable,
          onSelect: () => {
            setPassword(generatePassword());
            setRevokeSessions(true);
            reset.reset();
            setResetting(mailbox);
          },
        },
        {
          id: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          disabled: !can("email.mailboxes:delete", mailbox.server_id),
          onSelect: () => {
            setDeleteMaildir(false);
            remove.reset();
            setDeleting([mailbox]);
          },
        },
      ];
    },
    [can, quota, remove, reset, update],
  );

  return (
    <>
      <ResourcePage<Mailbox>
        title="Mailboxes"
        subtitle={
          domainList.length > 0
            ? `${formatCount(domainList.reduce((sum, domain) => sum + domain.mailbox_count, 0))} across ${formatCount(domainList.length)} domains`
            : undefined
        }
        state={state}
        query={query}
        columns={columns}
        getRowId={(mailbox) => mailbox.id}
        tableLabel="Mailboxes"
        searchPlaceholder="Address or display name"
        errorContext="Mailboxes"
        emptyIcon={Mail}
        emptyTitle="No mailboxes"
        emptyDescription="A mailbox is an address on a domain this fleet hosts mail for, with its own maildir and credential."
        emptyAction={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!canCreate}
            onClick={openCreate}
          >
            New mailbox
          </Button>
        }
        primaryAction={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!canCreate}
            onClick={openCreate}
          >
            New mailbox
          </Button>
        }
        filters={
          <>
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
            onClick={() => {
              setDeleteMaildir(false);
              remove.reset();
              setDeleting(
                ids
                  .map((id) => byId.get(id))
                  .filter((mailbox): mailbox is Mailbox => Boolean(mailbox)),
              );
            }}
          >
            Delete
          </Button>
        )}
        rowActions={rowActions}
      >
        <div className="flex flex-wrap items-center gap-3">
          <DomainPicker
            value={selectedDomainId}
            onChange={(next) => state.setFilter("mail_domain_id", next)}
            allowAll
          />
        </div>
        <JobActivityBar types={MAILBOX_JOB_TYPES} title="Mailbox changes" />
      </ResourcePage>

      {createOpen && (
        <CreateMailboxDialog
          domains={domainList}
          defaultDomainId={selectedDomainId ?? domainList[0]?.id ?? ""}
          password={password}
          onPasswordChange={setPassword}
          submitting={create.isPending}
          error={create.error}
          onClose={() => setCreateOpen(false)}
          onSubmit={(input) => create.mutate(input, { onSuccess: () => setCreateOpen(false) })}
        />
      )}

      {editing && (
        <EditMailboxDialog
          mailbox={editing}
          submitting={update.isPending}
          error={update.error}
          onClose={() => setEditing(null)}
          onSubmit={(input) =>
            update.mutate(
              { id: editing.id, address: editing.address, input },
              { onSuccess: () => setEditing(null) },
            )
          }
        />
      )}

      {quotaFor && (
        <QuotaDialog
          mailbox={quotaFor}
          submitting={quota.isPending}
          error={quota.error}
          onClose={() => setQuotaFor(null)}
          onSubmit={(bytes) =>
            quota.mutate(
              { id: quotaFor.id, address: quotaFor.address, quota_bytes: bytes },
              { onSuccess: () => setQuotaFor(null) },
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
          subject={resetting.address}
          password={password}
          onPasswordChange={setPassword}
          submitting={reset.isPending}
          error={reset.error}
          job={reset.data?.[0] ?? null}
          extra={
            <Switch
              checked={revokeSessions}
              onChange={(event) => setRevokeSessions(event.target.checked)}
              label="Sign out open IMAP and POP sessions"
              description="A password change on its own does not close a session that is already authenticated, so a stolen client keeps reading until this is on."
            />
          }
          onSubmit={() =>
            reset.mutate({
              id: resetting.id,
              address: resetting.address,
              password,
              revoke_sessions: revokeSessions,
            })
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
              ? `Delete ${deleting[0]!.address}?`
              : `Delete ${deleting.length} mailboxes?`
          }
          description="Mail already delivered stays on disk unless you also remove the maildir. Either way the address stops accepting new mail."
          confirmText={
            deleting.length === 1 ? deleting[0]!.address : `delete ${deleting.length} mailboxes`
          }
          confirmLabel="Delete"
          loading={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              {
                mailboxes: deleting.map((mailbox) => ({
                  id: mailbox.id,
                  address: mailbox.address,
                })),
                deleteMaildir,
              },
              {
                onSuccess: () => {
                  setDeleting(null);
                  state.setSelected([]);
                },
              },
            )
          }
        >
          <div className="flex flex-col gap-3">
            <ul className="max-h-32 overflow-y-auto rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-2 py-1.5">
              {deleting.map((mailbox) => (
                <li key={mailbox.id} className="kn-mono truncate text-[var(--kn-text-2)]">
                  {mailbox.address}
                </li>
              ))}
            </ul>
            <Switch
              checked={deleteMaildir}
              onChange={(event) => setDeleteMaildir(event.target.checked)}
              label="Also delete the stored mail"
              description={`Removes the maildir on the host. ${deleting.length === 1 ? `That is ${formatBytesLabel(deleting[0]!.used_bytes)} of messages` : "That is every message these mailboxes hold"}, and Kaname keeps no copy.`}
            />
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

function formatBytesLabel(bytes: number): string {
  const gib = bytes / GIB;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MiB`;
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

interface CreateMailboxDialogProps {
  domains: readonly MailDomain[];
  defaultDomainId: string;
  password: string;
  onPasswordChange: (password: string) => void;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: {
    mail_domain_id: string;
    local_part: string;
    password: string;
    display_name?: string;
    quota_bytes: number;
    address: string;
  }) => void;
}

function CreateMailboxDialog({
  domains,
  defaultDomainId,
  password,
  onPasswordChange,
  submitting,
  error,
  onClose,
  onSubmit,
}: CreateMailboxDialogProps) {
  const [domainId, setDomainId] = React.useState(defaultDomainId);
  const [localPart, setLocalPart] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [gib, setGib] = React.useState("2");

  const errors = fieldErrors(error);
  const domain = domains.find((entry) => entry.id === domainId) ?? null;
  const trimmed = localPart.trim();
  const localProblem =
    trimmed.length > 0 && !/^[A-Za-z0-9._%+-]+$/.test(trimmed)
      ? "A local part holds letters, digits and . _ % + - only."
      : null;

  const canSubmit =
    domainId.length > 0 && trimmed.length > 0 && localProblem === null && password.length >= 16;

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="New mailbox"
      description="Kaname creates the maildir and the credential on the host that carries this domain's mail."
      submitLabel="Create mailbox"
      submitting={submitting}
      canSubmit={canSubmit}
      error={error}
      onSubmit={() =>
        onSubmit({
          mail_domain_id: domainId,
          local_part: trimmed,
          password,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          quota_bytes: quotaBytes(gib),
          address: `${trimmed}@${domain?.domain_name ?? ""}`,
        })
      }
    >
      <FormField label="Domain" required error={errors["mail_domain_id"]}>
        <Select
          value={domainId}
          onChange={(event) => setDomainId(event.target.value)}
          placeholder="Pick a domain"
          options={domains.map((entry) => ({
            value: entry.id,
            label: `${entry.domain_name} — ${entry.server_name}`,
          }))}
          mono
        />
      </FormField>

      <FormField
        label="Address"
        required
        error={localProblem ?? errors["local_part"]}
        description={
          domain ? (
            <MonoText muted>{`${trimmed || "name"}@${domain.domain_name}`}</MonoText>
          ) : (
            "Pick a domain first."
          )
        }
      >
        <Input
          mono
          data-autofocus=""
          value={localPart}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setLocalPart(event.target.value)
          }
          placeholder="alice"
          autoComplete="off"
          spellCheck={false}
          trailing={
            domain ? (
              <span className="kn-mono text-[var(--kn-text-3)]">@{domain.domain_name}</span>
            ) : undefined
          }
        />
      </FormField>

      <FormField
        label="Display name"
        error={errors["display_name"]}
        description="What recipients see in the From header when this mailbox sends."
      >
        <Input
          value={displayName}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setDisplayName(event.target.value)
          }
          placeholder="Alice Okafor"
          autoComplete="off"
        />
      </FormField>

      <FormField
        label="Quota"
        hint="GiB"
        error={errors["quota_bytes"]}
        description="0 means the mailbox is bounded only by the domain's own quota."
      >
        <Input
          mono
          type="number"
          min={0}
          step="0.5"
          value={gib}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setGib(event.target.value)}
        />
      </FormField>

      <PasswordField value={password} onChange={onPasswordChange} error={errors["password"]} />
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Edit
 * ------------------------------------------------------------------ */

function EditMailboxDialog({
  mailbox,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  mailbox: Mailbox;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: { display_name?: string; status?: MailStatus }) => void;
}) {
  const [displayName, setDisplayName] = React.useState(mailbox.display_name ?? "");
  const [status, setStatus] = React.useState<MailStatus>(mailbox.status);
  const errors = fieldErrors(error);

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Edit ${mailbox.address}`}
      description="The address itself is the mailbox's identity on the host — renaming one is a create plus a migration, not an edit."
      submitLabel="Save changes"
      submitting={submitting}
      error={error}
      onSubmit={() => onSubmit({ display_name: displayName.trim(), status })}
      size="sm"
    >
      <FormField label="Display name" error={errors["display_name"]}>
        <Input
          data-autofocus=""
          value={displayName}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setDisplayName(event.target.value)
          }
          autoComplete="off"
        />
      </FormField>

      <FormField
        label="Status"
        description="Suspending keeps the maildir and refuses logins and delivery."
      >
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value as MailStatus)}
          options={[
            { value: "active", label: "Active" },
            { value: "suspended", label: "Suspended" },
          ]}
        />
      </FormField>
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Quota
 * ------------------------------------------------------------------ */

function QuotaDialog({
  mailbox,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  mailbox: Mailbox;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (bytes: number) => void;
}) {
  const [gib, setGib] = React.useState(() => quotaGib(mailbox.quota_bytes));
  const errors = fieldErrors(error);
  const next = quotaBytes(gib);
  const belowUsage = next > 0 && next < mailbox.used_bytes;

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Quota for ${mailbox.address}`}
      description="Applied on the host, so it takes effect when the job lands rather than when this dialog closes."
      submitLabel="Set quota"
      submitting={submitting}
      canSubmit={!belowUsage}
      error={error}
      onSubmit={() => onSubmit(next)}
      size="sm"
    >
      <FormField label="Currently stored">
        <span className="flex items-baseline gap-2">
          <ByteSize bytes={mailbox.used_bytes} />
          <span className="text-[var(--kn-text-3)]">
            in {formatCount(mailbox.message_count)} messages
          </span>
        </span>
      </FormField>

      <FormField
        label="Quota"
        hint="GiB"
        required
        error={
          belowUsage
            ? "That is below what the mailbox already stores, so it would stop accepting mail immediately."
            : errors["quota_bytes"]
        }
        description="0 removes the limit."
      >
        <Input
          mono
          data-autofocus=""
          type="number"
          min={0}
          step="0.5"
          value={gib}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setGib(event.target.value)}
        />
      </FormField>
    </FormDialog>
  );
}
