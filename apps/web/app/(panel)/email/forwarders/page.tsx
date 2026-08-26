"use client";

import * as React from "react";
import { Forward, Pencil, Plus, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import type { MailDomain, MailForwarder } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  FormField,
  Input,
  MonoText,
  Select,
  StatusBadge,
  Switch,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { useCan } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import {
  useCreateForwarder,
  useDeleteForwarders,
  useMailDomains,
  useMailForwarders,
  useSetForwardersEnabled,
  useUpdateForwarder,
} from "../_components/queries";
import { DomainPicker } from "../_components/status";

/* ------------------------------------------------------------------ *
 * Forwarders — the send-onward half of mail routing.
 *
 * Where an alias fans one address out to several, a forwarder takes one
 * address somewhere else, optionally leaving a copy behind. The
 * distinction matters operationally: a forwarder without a kept copy is
 * the setup where mail silently stops existing on this host, and the
 * table says which of the two each row is rather than hiding it in a
 * boolean column called "keep_copy".
 * ------------------------------------------------------------------ */

const FORWARDER_JOB_TYPES = ["mail.forwarder."] as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function MailForwardersPage() {
  const can = useCan();
  const domains = useMailDomains();

  const state = useResourceListState({
    defaultSort: { id: "source", order: "asc" },
    filterKeys: ["mail_domain_id", "enabled"],
  });

  const query = useMailForwarders(state.params);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MailForwarder | null>(null);
  const [deleting, setDeleting] = React.useState<readonly MailForwarder[] | null>(null);

  const create = useCreateForwarder();
  const update = useUpdateForwarder();
  const setEnabled = useSetForwardersEnabled();
  const remove = useDeleteForwarders();

  const rows = query.data?.data ?? [];
  const byId = React.useMemo(() => new Map(rows.map((row) => [row.id, row] as const)), [rows]);
  const domainList = domains.data?.data ?? [];
  const selectedDomainId = state.filters["mail_domain_id"] ?? null;
  const canCreate =
    domainList.length > 0 &&
    domainList.some((domain) => can("email.routing:write", domain.server_id));

  const selectedRows = React.useCallback(
    (ids: readonly string[]) =>
      ids
        .map((id) => byId.get(id))
        .filter((forwarder): forwarder is MailForwarder => Boolean(forwarder)),
    [byId],
  );

  const columns = React.useMemo<DataTableColumn<MailForwarder>[]>(
    () => [
      {
        id: "source",
        header: "From",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 220,
        cell: (forwarder) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {forwarder.source}
          </MonoText>
        ),
      },
      {
        id: "destination",
        header: "To",
        sortable: true,
        mono: true,
        minWidth: 220,
        cell: (forwarder) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {forwarder.destination}
          </MonoText>
        ),
      },
      {
        id: "keep_copy",
        header: "Local copy",
        width: 140,
        cell: (forwarder) => (
          <Badge
            tone={forwarder.keep_copy ? "info" : "warn"}
            size="xs"
            title={
              forwarder.keep_copy
                ? "The message is delivered to the mailbox here as well as forwarded."
                : "Nothing is kept on this host. If the destination bounces, the message is gone."
            }
          >
            {forwarder.keep_copy ? "Kept" : "Not kept"}
          </Badge>
        ),
      },
      {
        id: "domain_name",
        header: "Domain",
        width: 150,
        mono: true,
        hideBelow: "lg",
        cell: (forwarder) => (
          <MonoText muted truncate className="min-w-0">
            {forwarder.domain_name}
          </MonoText>
        ),
      },
      {
        id: "server_name",
        header: "Host",
        width: 172,
        hideBelow: "lg",
        cell: (forwarder) => (
          <HostCell serverId={forwarder.server_id} serverName={forwarder.server_name} />
        ),
      },
      {
        id: "enabled",
        header: "In the map",
        sortable: true,
        width: 120,
        cell: (forwarder) => (
          <StatusBadge
            tone={forwarder.enabled ? "ok" : "neutral"}
            size="xs"
            hollow={!forwarder.enabled}
            title={
              forwarder.enabled
                ? "Present in the forwarder map the host is running."
                : "Kept in Kaname but left out of the map, so nothing is forwarded."
            }
          >
            {forwarder.enabled ? "Applied" : "Held back"}
          </StatusBadge>
        ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (forwarder: MailForwarder): DataTableRowAction<MailForwarder>[] => {
      const writable = can("email.routing:write", forwarder.server_id);
      return [
        {
          id: "edit",
          label: "Edit",
          icon: Pencil,
          disabled: !writable,
          onSelect: () => {
            update.reset();
            setEditing(forwarder);
          },
        },
        {
          id: "toggle",
          label: forwarder.enabled ? "Hold back" : "Apply",
          icon: forwarder.enabled ? ToggleLeft : ToggleRight,
          disabled: !writable,
          onSelect: () =>
            setEnabled.mutate({
              rows: [{ id: forwarder.id, label: forwarder.source }],
              enabled: !forwarder.enabled,
            }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          disabled: !can("email.routing:delete", forwarder.server_id),
          onSelect: () => {
            remove.reset();
            setDeleting([forwarder]);
          },
        },
      ];
    },
    [can, remove, setEnabled, update],
  );

  return (
    <>
      <ResourcePage<MailForwarder>
        title="Forwarders"
        subtitle="One address in, one address onward"
        state={state}
        query={query}
        columns={columns}
        getRowId={(forwarder) => forwarder.id}
        tableLabel="Mail forwarders"
        searchPlaceholder="Source or destination"
        errorContext="Forwarders"
        emptyIcon={Forward}
        emptyTitle="No forwarders"
        emptyDescription="A forwarder sends mail for one address on to another — a person who left, a shared inbox that lives elsewhere."
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
            New forwarder
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
            New forwarder
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
                  rows: selectedRows(ids).map((forwarder) => ({
                    id: forwarder.id,
                    label: forwarder.source,
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
                  rows: selectedRows(ids).map((forwarder) => ({
                    id: forwarder.id,
                    label: forwarder.source,
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
        onRowClick={(forwarder) => {
          update.reset();
          setEditing(forwarder);
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <DomainPicker
            value={selectedDomainId}
            onChange={(next) => state.setFilter("mail_domain_id", next)}
            allowAll
          />
        </div>
        <JobActivityBar types={FORWARDER_JOB_TYPES} title="Routing changes" />
      </ResourcePage>

      {createOpen && (
        <ForwarderDialog
          mode="create"
          domains={domainList}
          defaultDomainId={selectedDomainId ?? domainList[0]?.id ?? ""}
          submitting={create.isPending}
          error={create.error}
          onClose={() => setCreateOpen(false)}
          onSubmit={(values) =>
            create.mutate(
              {
                mail_domain_id: values.domainId,
                source: values.source,
                destination: values.destination,
                keep_copy: values.keepCopy,
                enabled: values.enabled,
              },
              { onSuccess: () => setCreateOpen(false) },
            )
          }
        />
      )}

      {editing && (
        <ForwarderDialog
          mode="edit"
          forwarder={editing}
          domains={domainList}
          defaultDomainId={editing.mail_domain_id}
          submitting={update.isPending}
          error={update.error}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            update.mutate(
              {
                id: editing.id,
                source: editing.source,
                input: {
                  source: values.source,
                  destination: values.destination,
                  keep_copy: values.keepCopy,
                  enabled: values.enabled,
                },
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
              ? `Delete the forwarder for ${deleting[0]!.source}?`
              : `Delete ${deleting.length} forwarders?`
          }
          description="Mail for the source address stops being sent onward. Anything already delivered is untouched."
          confirmText={
            deleting.length === 1 ? deleting[0]!.source : `delete ${deleting.length} forwarders`
          }
          confirmLabel="Delete"
          loading={remove.isPending}
          onConfirm={() =>
            remove.mutate(
              deleting.map((forwarder) => ({ id: forwarder.id, source: forwarder.source })),
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
            {deleting.map((forwarder) => (
              <li key={forwarder.id} className="kn-mono truncate text-[var(--kn-text-2)]">
                {forwarder.source} → {forwarder.destination}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Create / edit
 * ------------------------------------------------------------------ */

interface ForwarderSubmit {
  domainId: string;
  source: string;
  destination: string;
  keepCopy: boolean;
  enabled: boolean;
}

interface ForwarderDialogProps {
  mode: "create" | "edit";
  forwarder?: MailForwarder;
  domains: readonly MailDomain[];
  defaultDomainId: string;
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (values: ForwarderSubmit) => void;
}

function ForwarderDialog({
  mode,
  forwarder,
  domains,
  defaultDomainId,
  submitting,
  error,
  onClose,
  onSubmit,
}: ForwarderDialogProps) {
  const [domainId, setDomainId] = React.useState(defaultDomainId);
  const [localPart, setLocalPart] = React.useState(() =>
    forwarder ? forwarder.source.slice(0, forwarder.source.lastIndexOf("@")) : "",
  );
  const [destination, setDestination] = React.useState(forwarder?.destination ?? "");
  const [keepCopy, setKeepCopy] = React.useState(forwarder?.keep_copy ?? true);
  const [enabled, setEnabled] = React.useState(forwarder?.enabled ?? true);

  const errors = fieldErrors(error);
  const domain = domains.find((entry) => entry.id === domainId) ?? null;
  const domainName = forwarder?.domain_name ?? domain?.domain_name ?? "";
  const source = localPart.trim() && domainName ? `${localPart.trim()}@${domainName}` : "";
  const trimmedDestination = destination.trim();

  const destinationProblem =
    trimmedDestination.length > 0 && !EMAIL_PATTERN.test(trimmedDestination)
      ? "That is not a full email address."
      : source.length > 0 && trimmedDestination.toLowerCase() === source.toLowerCase()
        ? "Forwarding an address to itself is a delivery loop; the mail stack bounces it."
        : null;

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={mode === "create" ? "New forwarder" : `Edit ${forwarder?.source ?? "forwarder"}`}
      description="The whole forwarder map for this domain is rewritten on the host when this is saved."
      submitLabel={mode === "create" ? "Create forwarder" : "Save forwarder"}
      submitting={submitting}
      canSubmit={source.length > 0 && trimmedDestination.length > 0 && destinationProblem === null}
      error={error}
      onSubmit={() =>
        onSubmit({ domainId, source, destination: trimmedDestination, keepCopy, enabled })
      }
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
        label="Forward mail sent to"
        required
        error={errors["source"]}
        description={source ? <MonoText muted>{source}</MonoText> : "An address on this domain."}
      >
        <Input
          mono
          data-autofocus=""
          value={localPart}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setLocalPart(event.target.value)
          }
          placeholder="jordan"
          autoComplete="off"
          spellCheck={false}
          trailing={
            domainName ? (
              <span className="kn-mono text-[var(--kn-text-3)]">@{domainName}</span>
            ) : undefined
          }
        />
      </FormField>

      <FormField
        label="Onward to"
        required
        error={destinationProblem ?? errors["destination"]}
        description="Any address, on this fleet or anywhere else."
      >
        <Input
          mono
          value={destination}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setDestination(event.target.value)
          }
          placeholder="jordan@newcompany.com"
          autoComplete="off"
          spellCheck={false}
          invalid={destinationProblem !== null}
        />
      </FormField>

      <Switch
        checked={keepCopy}
        onChange={(event) => setKeepCopy(event.target.checked)}
        label="Keep a copy in the local mailbox"
        description="Off means this host stores nothing. If the destination bounces or the address stops existing, the message is gone."
      />

      <FormField
        label="Apply this forwarder"
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
