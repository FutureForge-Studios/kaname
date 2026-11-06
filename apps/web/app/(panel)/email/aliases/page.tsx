"use client";

import * as React from "react";
import { ArrowRight, AtSign, Plus, Trash2 } from "lucide-react";
import type { MailAlias } from "@kaname/contract";
import {
  Button,
  Combobox,
  ConfirmDialog,
  FormField,
  Input,
  MonoText,
  Skeleton,
  type ComboboxOption,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { useCan } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import {
  useCreateMailAlias,
  useDeleteMailAlias,
  useMailAliases,
  useMailDomains,
  useMailboxes,
} from "../_components/queries";
import { DomainPicker, MailServerPicker, RowStatusBadge } from "../_components/status";

/* ------------------------------------------------------------------ *
 * Aliases.
 *
 * An alias is one extra address that delivers into an existing mailbox
 * on the same domain. Yunori has no notion of a disabled alias and no
 * forwarding to outside addresses from here, so the table is exactly
 * two columns of identity — alias and target — plus where it lives.
 * ------------------------------------------------------------------ */

const ALIAS_JOB_TYPES = ["mail.alias."] as const;
const LOCAL_PART = /^[A-Za-z0-9._%+-]+$/;

export default function AliasesPage() {
  const can = useCan();

  const state = useResourceListState({
    defaultSort: { id: "address", order: "asc" },
    filterKeys: ["mail_domain_id", "server_id"],
  });
  const query = useMailAliases(state.params);
  const remove = useDeleteMailAlias();

  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<MailAlias | null>(null);

  const columns = React.useMemo<DataTableColumn<MailAlias>[]>(
    () => [
      {
        id: "address",
        header: "Alias",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 220,
        cell: (alias) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {alias.address}
          </MonoText>
        ),
      },
      {
        id: "mailbox_address",
        header: "Delivers to",
        sortable: true,
        mono: true,
        minWidth: 220,
        cell: (alias) => (
          <span className="flex min-w-0 items-center gap-2">
            <ArrowRight size={12} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
            <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
              {alias.mailbox_address}
            </MonoText>
          </span>
        ),
      },
      {
        id: "domain_name",
        header: "Domain",
        sortable: true,
        mono: true,
        minWidth: 140,
        hideBelow: "lg",
        cell: (alias) => (
          <MonoText muted truncate className="min-w-0">
            {alias.domain_name}
          </MonoText>
        ),
      },
      {
        id: "server_name",
        header: "Server",
        minWidth: 160,
        hideBelow: "md",
        cell: (alias) => <HostCell serverId={alias.server_id} serverName={alias.server_name} />,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 112,
        cell: (alias) => <RowStatusBadge status={alias.status} />,
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (alias: MailAlias): DataTableRowAction<MailAlias>[] => [
      {
        id: "delete",
        label: "Remove alias",
        icon: Trash2,
        destructive: true,
        disabled: alias.status === "removing" || !can("email.routing:delete", alias.server_id),
        onSelect: () => setDeleting(alias),
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
      disabled={!can("email.routing:write")}
    >
      Add alias
    </Button>
  );

  return (
    <>
      <ResourcePage<MailAlias>
        title="Aliases"
        subtitle="Extra addresses that deliver into a mailbox"
        primaryAction={createButton}
        state={state}
        query={query}
        columns={columns}
        getRowId={(alias) => alias.id}
        tableLabel="Aliases"
        searchPlaceholder="Search aliases and mailboxes"
        errorContext="Aliases"
        emptyIcon={AtSign}
        emptyTitle="No aliases yet"
        emptyDescription="An alias is a second address for a mailbox on the same domain: sales@ delivering to alice@."
        emptyAction={createButton}
        rowActions={rowActions}
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
        <JobActivityBar types={ALIAS_JOB_TYPES} />
      </ResourcePage>

      <CreateAliasDialog
        open={creating}
        onOpenChange={setCreating}
        defaultDomainId={state.filters["mail_domain_id"] ?? null}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.address ?? "alias"}?`}
        description={`Mail sent to this address will bounce. ${deleting?.mailbox_address ?? "The mailbox"} and its mail are untouched.`}
        confirmLabel="Remove alias"
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

interface CreateAliasDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDomainId: string | null;
}

function CreateAliasDialog({ open, onOpenChange, defaultDomainId }: CreateAliasDialogProps) {
  const create = useCreateMailAlias();
  const domains = useMailDomains();

  const [domainId, setDomainId] = React.useState<string | null>(defaultDomainId);
  const [localPart, setLocalPart] = React.useState("");
  const [mailboxId, setMailboxId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setDomainId(defaultDomainId);
      return;
    }
    setLocalPart("");
    setMailboxId(null);
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open/close only
  }, [open]);

  /* A target on another domain is not an alias in Yunori's model, so the
   * mailbox list follows the chosen domain and resets with it. */
  React.useEffect(() => {
    setMailboxId(null);
  }, [domainId]);

  const mailboxes = useMailboxes(
    { mail_domain_id: domainId ?? undefined, status: "active", per_page: 200, sort: "address", order: "asc" },
    open && domainId !== null,
  );

  const domain = (domains.data?.data ?? []).find((row) => row.id === domainId) ?? null;
  const options = React.useMemo<ComboboxOption[]>(
    () =>
      (mailboxes.data?.data ?? []).map((mailbox) => ({
        value: mailbox.id,
        label: mailbox.address,
        description: mailbox.display_name ?? undefined,
        mono: true,
      })),
    [mailboxes.data],
  );

  const fields = fieldErrors(create.error);
  const localValid = LOCAL_PART.test(localPart);
  const address = `${localPart || "…"}@${domain?.domain_name ?? "…"}`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add an alias"
      description="Mail to the alias is delivered into the mailbox you pick, on the same domain."
      submitLabel="Add alias"
      submitting={create.isPending}
      canSubmit={domain !== null && localValid && mailboxId !== null}
      error={create.error}
      onSubmit={() => {
        if (!domain || !mailboxId) return;
        create.mutate(
          {
            mail_domain_id: domain.id,
            local_part: localPart.trim().toLowerCase(),
            mailbox_id: mailboxId,
            address: `${localPart.trim().toLowerCase()}@${domain.domain_name}`,
          },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
    >
      <FormField label="Domain" required error={fields["mail_domain_id"]}>
        <DomainPicker value={domainId} onChange={setDomainId} size="md" className="w-full" />
      </FormField>

      <FormField
        label="Alias"
        required
        description="The part before the @."
        hint={<MonoText muted>{address}</MonoText>}
        error={
          fields["local_part"] ??
          (localPart.length > 0 && !localValid ? "Use letters, digits, dots, dashes or underscores." : undefined)
        }
      >
        <Input
          mono
          value={localPart}
          placeholder="sales"
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setLocalPart(event.target.value)}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          trailing={domain ? <span className="kn-mono text-[var(--kn-text-3)]">@{domain.domain_name}</span> : undefined}
        />
      </FormField>

      <FormField
        label="Delivers to"
        required
        description={domain ? `An active mailbox on ${domain.domain_name}.` : "Pick a domain first."}
        error={fields["mailbox_id"]}
      >
        {mailboxes.isLoading ? (
          <Skeleton className="h-8 w-full rounded-[var(--kn-r-md)]" label="Loading mailboxes" />
        ) : (
          <Combobox
            size="md"
            options={options}
            value={mailboxId ?? ""}
            onValueChange={(next) => setMailboxId(next && next.length > 0 ? next : null)}
            placeholder={
              domain === null
                ? "Pick a domain first"
                : options.length === 0
                  ? "No active mailbox on this domain"
                  : "Select a mailbox"
            }
            emptyMessage="No mailbox matches that address."
            disabled={domain === null || options.length === 0}
            mono
            aria-label="Target mailbox"
          />
        )}
      </FormField>
    </FormDialog>
  );
}
