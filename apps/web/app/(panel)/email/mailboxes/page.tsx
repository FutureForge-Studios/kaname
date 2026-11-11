"use client";

import * as React from "react";
import { KeyRound, Mail, Plus, Trash2 } from "lucide-react";
import type { Mailbox } from "@kaname/contract";
import {
  Button,
  ByteSize,
  ConfirmDialog,
  FormField,
  Input,
  MonoText,
  RelativeTime,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useOpenFromQuery, useResourceListState } from "@/components/ResourcePage";
import { formatCount } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { Blank, HostCell } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import { FilterSelect } from "../../websites/_components/filters";
import { CredentialDialog, type Credential } from "../_components/CredentialDialog";
import { MailChainChecklist, useMailPrerequisite } from "../_components/prerequisites";
import {
  useCreateMailbox,
  useDeleteMailbox,
  useMailDomains,
  useMailboxes,
  useResetMailboxPassword,
} from "../_components/queries";
import { DomainPicker, MailServerPicker, RowStatusBadge } from "../_components/status";

/* ------------------------------------------------------------------ *
 * Mailboxes.
 *
 * Creating one is the only synchronous host mutation in the product
 * (KD-024): Yunori generates the password and it comes back in the
 * response, shown once in the credential dialog and then gone. Deleting
 * is a job like everything else, and reads `removing` until it lands.
 * ------------------------------------------------------------------ */

const MAILBOX_JOB_TYPES = ["mail.mailbox."] as const;
const LOCAL_PART = /^[A-Za-z0-9._%+-]+$/;

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "removing", label: "Removing" },
  { value: "error", label: "Error" },
];

export default function MailboxesPage() {
  const can = useCan();

  const state = useResourceListState({
    defaultSort: { id: "address", order: "asc" },
    filterKeys: ["mail_domain_id", "server_id", "status"],
  });
  const query = useMailboxes(state.params);

  const reset = useResetMailboxPassword();
  const remove = useDeleteMailbox();

  const [creating, setCreating] = React.useState(false);
  useOpenFromQuery("new", () => setCreating(true), can("email.mailboxes:write"));
  const prerequisite = useMailPrerequisite("domain");
  const [credential, setCredential] = React.useState<Credential | null>(null);
  const [resetting, setResetting] = React.useState<Mailbox | null>(null);
  const [deleting, setDeleting] = React.useState<Mailbox | null>(null);

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
        header: "Name",
        sortable: true,
        minWidth: 140,
        hideBelow: "md",
        cell: (mailbox) =>
          mailbox.display_name ? (
            <span className="truncate">{mailbox.display_name}</span>
          ) : (
            <Blank />
          ),
      },
      {
        id: "domain_name",
        header: "Domain",
        sortable: true,
        mono: true,
        minWidth: 140,
        hideBelow: "lg",
        cell: (mailbox) => (
          <MonoText muted truncate className="min-w-0">
            {mailbox.domain_name}
          </MonoText>
        ),
      },
      {
        id: "server_name",
        header: "Server",
        minWidth: 160,
        hideBelow: "md",
        cell: (mailbox) => (
          <HostCell serverId={mailbox.server_id} serverName={mailbox.server_name} />
        ),
      },
      {
        id: "quota_bytes",
        header: "Quota",
        sortable: true,
        width: 104,
        align: "right",
        hideBelow: "lg",
        cell: (mailbox) =>
          mailbox.quota_bytes > 0 ? (
            <ByteSize bytes={mailbox.quota_bytes} />
          ) : (
            <span className="text-[var(--kn-text-3)]">unlimited</span>
          ),
      },
      {
        id: "aliases",
        header: "Aliases",
        width: 88,
        align: "right",
        hideBelow: "lg",
        cell: (mailbox) => (
          <span className="kn-num" title={mailbox.aliases.join("\n") || undefined}>
            {formatCount(mailbox.aliases.length)}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 112,
        cell: (mailbox) => <RowStatusBadge status={mailbox.status} />,
      },
      {
        id: "last_synced_at",
        header: "Synced",
        sortable: true,
        width: 112,
        align: "right",
        hideBelow: "lg",
        cell: (mailbox) =>
          mailbox.last_synced_at ? (
            <RelativeTime value={mailbox.last_synced_at} className="text-[var(--kn-text-2)]" />
          ) : (
            <span className="text-[var(--kn-text-3)]">never</span>
          ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (mailbox: Mailbox): DataTableRowAction<Mailbox>[] => [
      {
        id: "reset",
        label: "Reset password",
        icon: KeyRound,
        disabled: mailbox.status !== "active" || !can("email.mailboxes:write", mailbox.server_id),
        onSelect: () => setResetting(mailbox),
      },
      {
        id: "delete",
        label: "Delete mailbox",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled:
          mailbox.status === "removing" || !can("email.mailboxes:delete", mailbox.server_id),
        onSelect: () => setDeleting(mailbox),
      },
    ],
    [can],
  );

  const createButton = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => setCreating(true)}
      disabled={!can("email.mailboxes:write")}
    >
      Create mailbox
    </Button>
  );

  return (
    <>
      <ResourcePage<Mailbox>
        eyebrow="Email"
        title="Mailboxes"
        lede="Accounts people sign in to. Passwords are generated on the host and shown once, never stored by Kaname."
        subtitle="Accounts on your Yunori Mail Servers"
        primaryAction={createButton}
        state={state}
        query={query}
        columns={columns}
        getRowId={(mailbox) => mailbox.id}
        tableLabel="Mailboxes"
        searchPlaceholder="Search addresses and names"
        errorContext="Mailboxes"
        emptyIcon={Mail}
        emptyTitle="No mailboxes yet"
        emptyDescription="A mailbox is an account people sign in to. Its password is generated on the host and shown once."
        emptyAction={createButton}
        prerequisite={prerequisite}
        rowActions={rowActions}
        filters={
          <FilterSelect
            label="Status"
            value={state.filters["status"]}
            onChange={(value) => state.setFilter("status", value)}
            options={STATUS_OPTIONS}
          />
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <MailServerPicker
            value={state.filters["server_id"] ?? null}
            onChange={(_id, server) => state.setFilter("server_id", server?.server_id ?? null)}
            allowAll
          />
          <DomainPicker
            value={state.filters["mail_domain_id"] ?? null}
            onChange={(next) => state.setFilter("mail_domain_id", next)}
            allowAll
          />
        </div>
        <MailChainChecklist needs="mailbox" prerequisite={prerequisite} />
        <JobActivityBar types={MAILBOX_JOB_TYPES} />
      </ResourcePage>

      <CreateMailboxDialog
        open={creating}
        onOpenChange={setCreating}
        defaultDomainId={state.filters["mail_domain_id"] ?? null}
        onCreated={(address, password) => setCredential({ address, password, reason: "created" })}
      />

      <CredentialDialog credential={credential} onClose={() => setCredential(null)} />

      <ConfirmDialog
        open={resetting !== null}
        onOpenChange={(open) => !open && setResetting(null)}
        title={`Reset the password for ${resetting?.address ?? "this mailbox"}?`}
        description="Yunori generates a new password on the host and the old one stops working at once. Every device signed in as this mailbox will need the new one. It is shown here exactly once."
        confirmLabel="Reset password"
        destructive={false}
        loading={reset.isPending}
        onConfirm={() => {
          if (!resetting) return;
          reset.mutate(
            { id: resetting.id, address: resetting.address },
            {
              onSuccess: (result) => {
                setResetting(null);
                setCredential({
                  address: result.address,
                  password: result.password,
                  reason: "reset",
                });
              },
            },
          );
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.address ?? "mailbox"}?`}
        description={
          deleting && deleting.aliases.length > 0
            ? `Its mail is removed from the host and cannot be recovered. ${formatCount(deleting.aliases.length)} ${deleting.aliases.length === 1 ? "alias delivers" : "aliases deliver"} here and will stop working.`
            : "Its mail is removed from the host and cannot be recovered from Kaname. Mail sent to this address afterwards bounces."
        }
        confirmText={deleting?.address}
        confirmLabel="Delete mailbox"
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(
            { id: deleting.id, address: deleting.address },
            { onSuccess: () => setDeleting(null) },
          );
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

interface CreateMailboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDomainId: string | null;
  onCreated: (address: string, password: string) => void;
}

function CreateMailboxDialog({
  open,
  onOpenChange,
  defaultDomainId,
  onCreated,
}: CreateMailboxDialogProps) {
  const create = useCreateMailbox();
  const domains = useMailDomains();

  const [domainId, setDomainId] = React.useState<string | null>(defaultDomainId);
  const [localPart, setLocalPart] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [quotaMb, setQuotaMb] = React.useState("0");

  React.useEffect(() => {
    if (open) {
      setDomainId(defaultDomainId);
      return;
    }
    setLocalPart("");
    setDisplayName("");
    setQuotaMb("0");
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open/close only
  }, [open]);

  const domain = (domains.data?.data ?? []).find((row) => row.id === domainId) ?? null;
  const fields = fieldErrors(create.error);
  const localValid = LOCAL_PART.test(localPart);
  const quota = Number.parseInt(quotaMb, 10);
  const quotaValid = quotaMb.trim() === "" || (Number.isFinite(quota) && quota >= 0);
  const preview = `${localPart || "…"}@${domain?.domain_name ?? "…"}`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a mailbox"
      description="Yunori creates the account on the host and hands back a generated password. It is shown once, on the next screen."
      submitLabel="Create mailbox"
      submitting={create.isPending}
      canSubmit={domain !== null && localValid && quotaValid}
      error={create.error}
      onSubmit={() => {
        if (!domain) return;
        create.mutate(
          {
            mail_domain_id: domain.id,
            local_part: localPart.trim().toLowerCase(),
            ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
            quota_mb: Number.isFinite(quota) ? quota : 0,
          },
          {
            onSuccess: (result) => {
              onOpenChange(false);
              onCreated(result.mailbox.address, result.password);
            },
          },
        );
      }}
    >
      <FormField label="Domain" required error={fields["mail_domain_id"]}>
        <DomainPicker value={domainId} onChange={setDomainId} size="md" className="w-full" />
      </FormField>

      <FormField
        label="Address"
        required
        description="The part before the @. Letters, digits, dots, dashes and underscores."
        hint={<MonoText muted>{preview}</MonoText>}
        error={
          fields["local_part"] ??
          (localPart.length > 0 && !localValid
            ? "Use letters, digits, dots, dashes or underscores."
            : undefined)
        }
      >
        <Input
          mono
          value={localPart}
          placeholder="alice"
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setLocalPart(event.target.value)
          }
          autoComplete="off"
          autoCorrect="off"
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
        description="Shown to recipients as the sender's name."
        error={fields["display_name"]}
      >
        <Input
          value={displayName}
          placeholder="Alice Example"
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setDisplayName(event.target.value)
          }
          autoComplete="off"
        />
      </FormField>

      <FormField
        label="Quota"
        description="In megabytes. 0 means unlimited."
        hint="MB"
        error={
          fields["quota_mb"] ??
          (!quotaValid ? "Enter a whole number of megabytes, or 0." : undefined)
        }
      >
        <Input
          mono
          inputMode="numeric"
          value={quotaMb}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuotaMb(event.target.value)}
          autoComplete="off"
        />
      </FormField>
    </FormDialog>
  );
}
