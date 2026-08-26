"use client";

import * as React from "react";
import { AtSign, Pencil, Plus, ToggleLeft, ToggleRight, Trash2, X } from "lucide-react";
import type { MailAlias, MailDomain } from "@kaname/contract";
import {
  Button,
  ConfirmDialog,
  FormField,
  IconButton,
  Input,
  MonoText,
  Select,
  StatusBadge,
  Switch,
  Tag,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { useCan } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import {
  useCreateAlias,
  useDeleteAliases,
  useMailAliases,
  useMailDomains,
  useSetAliasesEnabled,
  useUpdateAlias,
} from "../_components/queries";
import { DomainPicker } from "../_components/status";

/* ------------------------------------------------------------------ *
 * Aliases — the fan-out half of mail routing.
 *
 * An alias rewrites one address this domain receives into one or more
 * destinations. It is a map, not a row, as far as Postfix is concerned:
 * the control plane rewrites the domain's whole table on every change,
 * which is why creating, editing, toggling and deleting all end in the
 * same apply job.
 *
 * "Disabled" is the panel's word for "absent from the map we apply" —
 * the host has no other notion of it — and the column says so rather
 * than implying the mail stack is holding the alias back somehow.
 * ------------------------------------------------------------------ */

const ALIAS_JOB_TYPES = ["mail.alias."] as const;
const MAX_VISIBLE_DESTINATIONS = 3;

export default function MailAliasesPage() {
  const can = useCan();
  const domains = useMailDomains();

  const state = useResourceListState({
    defaultSort: { id: "address", order: "asc" },
    filterKeys: ["mail_domain_id", "enabled"],
  });

  const query = useMailAliases(state.params);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MailAlias | null>(null);
  const [deleting, setDeleting] = React.useState<readonly MailAlias[] | null>(null);

  const create = useCreateAlias();
  const update = useUpdateAlias();
  const setEnabled = useSetAliasesEnabled();
  const remove = useDeleteAliases();

  const rows = query.data?.data ?? [];
  const byId = React.useMemo(
    () => new Map(rows.map((alias) => [alias.id, alias] as const)),
    [rows],
  );
  const domainList = domains.data?.data ?? [];
  const selectedDomainId = state.filters["mail_domain_id"] ?? null;
  const canCreate =
    domainList.length > 0 &&
    domainList.some((domain) => can("email.routing:write", domain.server_id));

  const selectedRows = React.useCallback(
    (ids: readonly string[]) =>
      ids.map((id) => byId.get(id)).filter((alias): alias is MailAlias => Boolean(alias)),
    [byId],
  );

  const columns = React.useMemo<DataTableColumn<MailAlias>[]>(
    () => [
      {
        id: "address",
        header: "Address",
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
        id: "destinations",
        header: "Delivers to",
        minWidth: 280,
        cell: (alias) => <DestinationTags destinations={alias.destinations} />,
      },
      {
        id: "domain_name",
        header: "Domain",
        width: 150,
        mono: true,
        hideBelow: "lg",
        cell: (alias) => (
          <MonoText muted truncate className="min-w-0">
            {alias.domain_name}
          </MonoText>
        ),
      },
      {
        id: "server_name",
        header: "Host",
        width: 172,
        hideBelow: "lg",
        cell: (alias) => <HostCell serverId={alias.server_id} serverName={alias.server_name} />,
      },
      {
        id: "enabled",
        header: "In the map",
        sortable: true,
        width: 120,
        cell: (alias) => (
          <StatusBadge
            tone={alias.enabled ? "ok" : "neutral"}
            size="xs"
            hollow={!alias.enabled}
            title={
              alias.enabled
                ? "Present in the alias map the host is running."
                : "Kept in Kaname but left out of the map, so mail to this address is not rewritten."
            }
          >
            {alias.enabled ? "Applied" : "Held back"}
          </StatusBadge>
        ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (alias: MailAlias): DataTableRowAction<MailAlias>[] => {
      const writable = can("email.routing:write", alias.server_id);
      return [
        {
          id: "edit",
          label: "Edit destinations",
          icon: Pencil,
          disabled: !writable,
          onSelect: () => {
            update.reset();
            setEditing(alias);
          },
        },
        {
          id: "toggle",
          label: alias.enabled ? "Hold back" : "Apply",
          icon: alias.enabled ? ToggleLeft : ToggleRight,
          disabled: !writable,
          onSelect: () =>
            setEnabled.mutate({
              rows: [{ id: alias.id, label: alias.address }],
              enabled: !alias.enabled,
            }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          disabled: !can("email.routing:delete", alias.server_id),
          onSelect: () => {
            remove.reset();
            setDeleting([alias]);
          },
        },
      ];
    },
    [can, remove, setEnabled, update],
  );

  return (
    <>
      <ResourcePage<MailAlias>
        title="Aliases"
        subtitle="One address in, one or more addresses out"
        state={state}
        query={query}
        columns={columns}
        getRowId={(alias) => alias.id}
        tableLabel="Mail aliases"
        searchPlaceholder="Address or destination"
        errorContext="Aliases"
        emptyIcon={AtSign}
        emptyTitle="No aliases"
        emptyDescription="An alias delivers mail sent to one address to a set of real mailboxes — support@, sales@, a whole team."
        emptyAction={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!canCreate}
            onClick={() => {
              create.reset();
              setCreateOpen(true);
            }}
          >
            New alias
          </Button>
        }
        primaryAction={
          <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!canCreate}
            onClick={() => {
              create.reset();
              setCreateOpen(true);
            }}
          >
            New alias
          </Button>
        }
        filters={
          /* Present-or-absent rather than true/false: the list query
           * coerces its boolean, and "false" would coerce to true. */
          <Switch
            checked={state.filters["enabled"] === "true"}
            onChange={(event) => state.setFilter("enabled", event.target.checked ? "true" : null)}
            label="Applied only"
            labelClassName="text-sm text-[var(--kn-text-2)]"
          />
        }
        selectable
        bulkActions={(ids) => (
          <>
            <Button
              variant="ghost"
              size="xs"
              icon={ToggleRight}
              onClick={() =>
                setEnabled.mutate({
                  rows: selectedRows(ids).map((alias) => ({
                    id: alias.id,
                    label: alias.address,
                  })),
                  enabled: true,
                })
              }
            >
              Apply
            </Button>
            <Button
              variant="ghost"
              size="xs"
              icon={ToggleLeft}
              onClick={() =>
                setEnabled.mutate({
                  rows: selectedRows(ids).map((alias) => ({
                    id: alias.id,
                    label: alias.address,
                  })),
                  enabled: false,
                })
              }
            >
              Hold back
            </Button>
            <Button
              variant="danger-subtle"
              size="xs"
              icon={Trash2}
              onClick={() => {
                remove.reset();
                setDeleting(selectedRows(ids));
              }}
            >
              Delete
            </Button>
          </>
        )}
        rowActions={rowActions}
        onRowClick={(alias) => {
          update.reset();
          setEditing(alias);
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <DomainPicker
            value={selectedDomainId}
            onChange={(next) => state.setFilter("mail_domain_id", next)}
            allowAll
          />
        </div>
        <JobActivityBar types={ALIAS_JOB_TYPES} title="Routing changes" />
      </ResourcePage>

      {createOpen && (
        <AliasDialog
          mode="create"
          domains={domainList}
          defaultDomainId={selectedDomainId ?? domainList[0]?.id ?? ""}
          submitting={create.isPending}
          error={create.error}
          onClose={() => setCreateOpen(false)}
          onSubmit={({ domainId, address, destinations, enabled }) =>
            create.mutate(
              { mail_domain_id: domainId, address, destinations, enabled },
              { onSuccess: () => setCreateOpen(false) },
            )
          }
        />
      )}

      {editing && (
        <AliasDialog
          mode="edit"
          alias={editing}
          domains={domainList}
          defaultDomainId={editing.mail_domain_id}
          submitting={update.isPending}
          error={update.error}
          onClose={() => setEditing(null)}
          onSubmit={({ address, destinations, enabled }) =>
            update.mutate(
              {
                id: editing.id,
                address: editing.address,
                input: { address, destinations, enabled },
              },
              { onSuccess: () => setEditing(null) },
            )
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
              ? `Delete the alias for ${deleting[0]!.address}?`
              : `Delete ${deleting.length} aliases?`
          }
          description="Mail sent to the address stops being rewritten. If nothing else claims it, senders start getting a rejection."
          confirmText={
            deleting.length === 1 ? deleting[0]!.address : `delete ${deleting.length} aliases`
          }
          confirmLabel="Delete"
          loading={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              deleting.map((alias) => ({ id: alias.id, address: alias.address })),
              {
                onSuccess: () => {
                  setDeleting(null);
                  state.setSelected([]);
                },
              },
            )
          }
        >
          <ul className="max-h-32 overflow-y-auto rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-2 py-1.5">
            {deleting.map((alias) => (
              <li key={alias.id} className="kn-mono truncate text-[var(--kn-text-2)]">
                {alias.address} → {alias.destinations.join(", ")}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Destinations
 * ------------------------------------------------------------------ */

function DestinationTags({ destinations }: { destinations: readonly string[] }) {
  const visible = destinations.slice(0, MAX_VISIBLE_DESTINATIONS);
  const rest = destinations.length - visible.length;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map((destination) => (
        <Tag key={destination} size="xs" mono>
          {destination}
        </Tag>
      ))}
      {rest > 0 && (
        <span
          className="text-xs text-[var(--kn-text-3)]"
          title={destinations.slice(MAX_VISIBLE_DESTINATIONS).join("\n")}
        >
          +{rest} more
        </span>
      )}
    </span>
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DestinationsFieldProps {
  values: string[];
  onChange: (values: string[]) => void;
  error?: React.ReactNode;
}

/**
 * A row per destination rather than one comma-separated box: this is the
 * field an operator edits when someone leaves a team, and picking the
 * right address out of a comma soup is where mistakes happen. Pasting a
 * list still works — a value containing separators is split on the spot.
 */
function DestinationsField({ values, onChange, error }: DestinationsFieldProps) {
  const setAt = (index: number, value: string) => {
    const parts = value
      .split(/[,;\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length > 1) {
      const next = [...values];
      next.splice(index, 1, ...parts);
      onChange(next);
      return;
    }
    onChange(values.map((current, position) => (position === index ? value : current)));
  };

  const invalid = values.some(
    (value) => value.trim().length > 0 && !EMAIL_PATTERN.test(value.trim()),
  );

  return (
    <FormField
      label="Destinations"
      required
      error={error ?? (invalid ? "Every destination has to be a full email address." : undefined)}
      description="Mail is delivered to each of these. They can live on any domain."
      hint={`${values.filter((value) => value.trim().length > 0).length} in the map`}
    >
      <div className="flex flex-col gap-2">
        {values.map((value, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              mono
              value={value}
              data-autofocus={index === 0 ? "" : undefined}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setAt(index, event.target.value)
              }
              placeholder="alice@example.com"
              autoComplete="off"
              spellCheck={false}
              aria-label={`Destination ${index + 1}`}
              invalid={value.trim().length > 0 && !EMAIL_PATTERN.test(value.trim())}
            />
            <IconButton
              icon={X}
              label={`Remove destination ${index + 1}`}
              size="sm"
              disabled={values.length === 1}
              onClick={() => onChange(values.filter((_, position) => position !== index))}
            />
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            size="xs"
            icon={Plus}
            onClick={() => onChange([...values, ""])}
          >
            Add destination
          </Button>
        </div>
      </div>
    </FormField>
  );
}

/* ------------------------------------------------------------------ *
 * Create / edit
 * ------------------------------------------------------------------ */

interface AliasSubmit {
  domainId: string;
  address: string;
  destinations: string[];
  enabled: boolean;
}

interface AliasDialogProps {
  mode: "create" | "edit";
  alias?: MailAlias;
  domains: readonly MailDomain[];
  defaultDomainId: string;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (values: AliasSubmit) => void;
}

function AliasDialog({
  mode,
  alias,
  domains,
  defaultDomainId,
  submitting,
  error,
  onClose,
  onSubmit,
}: AliasDialogProps) {
  const [domainId, setDomainId] = React.useState(defaultDomainId);
  const [localPart, setLocalPart] = React.useState(() =>
    alias ? alias.address.slice(0, alias.address.lastIndexOf("@")) : "",
  );
  const [destinations, setDestinations] = React.useState<string[]>(() =>
    alias ? [...alias.destinations] : [""],
  );
  const [enabled, setEnabled] = React.useState(alias?.enabled ?? true);

  const errors = fieldErrors(error);
  const domain = domains.find((entry) => entry.id === domainId) ?? null;
  const domainName = alias?.domain_name ?? domain?.domain_name ?? "";
  const trimmed = localPart.trim();
  const address = trimmed && domainName ? `${trimmed}@${domainName}` : "";
  const cleaned = destinations.map((value) => value.trim()).filter((value) => value.length > 0);
  const allValid = cleaned.every((value) => EMAIL_PATTERN.test(value));

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={mode === "create" ? "New alias" : `Edit ${alias?.address ?? "alias"}`}
      description="The whole alias map for this domain is rewritten on the host when this is saved."
      submitLabel={mode === "create" ? "Create alias" : "Save alias"}
      submitting={submitting}
      canSubmit={address.length > 0 && cleaned.length > 0 && allValid}
      error={error}
      onSubmit={() => onSubmit({ domainId, address, destinations: cleaned, enabled })}
    >
      {mode === "create" && (
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
      )}

      <FormField
        label="Address"
        required
        error={errors["address"]}
        description={
          address ? (
            <MonoText muted>{address}</MonoText>
          ) : (
            "The left-hand side has to belong to this domain."
          )
        }
      >
        <Input
          mono
          value={localPart}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setLocalPart(event.target.value)
          }
          placeholder="support"
          autoComplete="off"
          spellCheck={false}
          trailing={
            domainName ? (
              <span className="kn-mono text-[var(--kn-text-3)]">@{domainName}</span>
            ) : undefined
          }
        />
      </FormField>

      <DestinationsField
        values={destinations}
        onChange={setDestinations}
        error={errors["destinations"]}
      />

      <FormField
        label="Apply this alias"
        description="Off keeps the row in Kaname but leaves it out of the map the host runs."
      >
        <Select
          value={enabled ? "true" : "false"}
          onChange={(event) => setEnabled(event.target.value === "true")}
          options={[
            { value: "true", label: "Applied" },
            { value: "false", label: "Held back" },
          ]}
        />
      </FormField>
    </FormDialog>
  );
}
