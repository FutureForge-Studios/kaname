"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Globe, Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Domain, MailDomain } from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  FormField,
  MonoText,
  RelativeTime,
  Skeleton,
  type ComboboxOption,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useOpenFromQuery, useResourceListState } from "@/components/ResourcePage";
import { formatCount } from "@/lib/format";
import { useCan, useList } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import { FilterSelect } from "../../websites/_components/filters";
import { DnsDrawer } from "../_components/DnsDrawer";
import { MailChainChecklist, useMailPrerequisite } from "../_components/prerequisites";
import {
  useAddMailDomain,
  useCheckMailDns,
  useMailDomains,
  useMailServers,
  useRemoveMailDomain,
} from "../_components/queries";
import { MailCheckBadge, MailServerPicker, RowStatusBadge } from "../_components/status";

/* ------------------------------------------------------------------ *
 * Mail domains.
 *
 * A row is a Kaname domain hosted on one Yunori Mail Server. The two
 * columns that matter are the lifecycle (does the host have it) and the
 * DNS verdict (will anyone else's server accept mail from it), kept
 * apart because they fail for different reasons and are fixed in
 * different places.
 * ------------------------------------------------------------------ */

const DOMAIN_JOB_TYPES = ["mail.domain."] as const;

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "provisioning", label: "Provisioning" },
  { value: "removing", label: "Removing" },
  { value: "error", label: "Error" },
];

const DNS_OPTIONS = [
  { value: "fail", label: "Failing" },
  { value: "warn", label: "Warnings" },
  { value: "pass", label: "Passing" },
  { value: "unknown", label: "Not checked" },
];

export default function MailDomainsPage() {
  const can = useCan();
  const router = useRouter();

  const state = useResourceListState({
    defaultSort: { id: "domain_name", order: "asc" },
    filterKeys: ["server_id", "status", "dns_status"],
  });
  const query = useMailDomains(state.params);
  const servers = useMailServers();

  const check = useCheckMailDns();
  const remove = useRemoveMailDomain();

  const [adding, setAdding] = React.useState(false);
  const [dnsFor, setDnsFor] = React.useState<MailDomain | null>(null);
  const [removing, setRemoving] = React.useState<MailDomain | null>(null);

  useOpenFromQuery("new", () => setAdding(true), can("email.mailboxes:write"));

  // A mail domain is created on a mail server; with none, point at deploying one.
  const prerequisite = useMailPrerequisite("server");

  /* The filter accepts either the mail server id or its host id, because
   * the server card links here with the former and the fleet with the latter. */
  const serverFilter = state.filters["server_id"];
  const serverLabel = React.useMemo(() => {
    if (!serverFilter) return undefined;
    const match = (servers.data?.data ?? []).find(
      (row) => row.id === serverFilter || row.server_id === serverFilter,
    );
    return match?.hostname ?? match?.server_name;
  }, [serverFilter, servers.data]);

  const columns = React.useMemo<DataTableColumn<MailDomain>[]>(
    () => [
      {
        id: "domain_name",
        header: "Domain",
        locked: true,
        sortable: true,
        minWidth: 200,
        cell: (domain) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
              {domain.domain_name}
            </MonoText>
            {domain.is_primary && (
              <Badge
                tone="accent"
                size="xs"
                title="The domain this server was installed with. It names the server and cannot be removed."
              >
                Primary
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "server_name",
        header: "Server",
        sortable: true,
        minWidth: 160,
        cell: (domain) => <HostCell serverId={domain.server_id} serverName={domain.server_name} />,
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 120,
        cell: (domain) => <RowStatusBadge status={domain.status} />,
      },
      {
        id: "dns_status",
        header: "DNS",
        sortable: true,
        width: 104,
        cell: (domain) => <MailCheckBadge status={domain.dns_status} />,
      },
      {
        id: "mailbox_count",
        header: "Mailboxes",
        sortable: true,
        width: 96,
        align: "right",
        hideBelow: "md",
        cell: (domain) => <span className="kn-num">{formatCount(domain.mailbox_count)}</span>,
      },
      {
        id: "alias_count",
        header: "Aliases",
        sortable: true,
        width: 88,
        align: "right",
        hideBelow: "md",
        cell: (domain) => <span className="kn-num">{formatCount(domain.alias_count)}</span>,
      },
      {
        id: "dns_checked_at",
        header: "DNS checked",
        sortable: true,
        width: 124,
        align: "right",
        hideBelow: "lg",
        cell: (domain) =>
          domain.dns_checked_at ? (
            <RelativeTime value={domain.dns_checked_at} className="text-[var(--kn-text-2)]" />
          ) : (
            <span className="text-[var(--kn-text-3)]">never</span>
          ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (domain: MailDomain): DataTableRowAction<MailDomain>[] => [
      {
        id: "dns",
        label: "DNS records",
        icon: Network,
        onSelect: () => setDnsFor(domain),
      },
      {
        id: "check",
        label: "Check DNS now",
        icon: RefreshCw,
        disabled: !can("email.servers:exec", domain.server_id),
        onSelect: () => check.mutate({ id: domain.id, domain_name: domain.domain_name }),
      },
      {
        id: "remove",
        label: "Remove from server",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled: domain.is_primary || !can("email.mailboxes:delete", domain.server_id),
        onSelect: () => setRemoving(domain),
      },
    ],
    [can, check],
  );

  const addButton = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => setAdding(true)}
      disabled={!can("email.mailboxes:write")}
    >
      Add domain
    </Button>
  );

  // The control plane refuses while either mailboxes or aliases remain, so
  // the dialog has to know about both or it arms a removal that cannot work.
  const blocked = removing !== null && (removing.mailbox_count > 0 || removing.alias_count > 0);

  return (
    <>
      <ResourcePage<MailDomain>
        eyebrow="Email"
        title="Mail domains"
        lede="Domains your mail servers accept mail for. Click a row for the DNS records it needs, with the exact values to publish."
        subtitle={serverLabel ?? "Every mail server in scope"}
        primaryAction={addButton}
        state={state}
        query={query}
        columns={columns}
        getRowId={(domain) => domain.id}
        tableLabel="Mail domains"
        searchPlaceholder="Search domains"
        errorContext="Mail domains"
        emptyIcon={Globe}
        emptyTitle="No domain hosts mail yet"
        emptyDescription="Add a Kaname domain to a mail server and Yunori tells you the DNS records to publish."
        emptyAction={addButton}
        prerequisite={prerequisite}
        onRowClick={(domain) => setDnsFor(domain)}
        rowActions={rowActions}
        filters={
          <>
            <FilterSelect
              label="Status"
              value={state.filters["status"]}
              onChange={(value) => state.setFilter("status", value)}
              options={STATUS_OPTIONS}
            />
            <FilterSelect
              label="DNS"
              value={state.filters["dns_status"]}
              onChange={(value) => state.setFilter("dns_status", value)}
              options={DNS_OPTIONS}
            />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <MailServerPicker
            value={serverFilter ?? null}
            onChange={(_id, server) => state.setFilter("server_id", server?.server_id ?? null)}
            allowAll
          />
        </div>
        <MailChainChecklist needs="domain" prerequisite={prerequisite} />
        <JobActivityBar types={DOMAIN_JOB_TYPES} />
      </ResourcePage>

      <AddDomainDialog
        open={adding}
        onOpenChange={setAdding}
        defaultServerId={serverFilter ?? null}
      />

      <DnsDrawer domain={dnsFor} onClose={() => setDnsFor(null)} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.domain_name ?? "domain"} from ${removing?.server_name ?? "the server"}?`}
        description={
          blocked
            ? `${removing?.domain_name} still has ${formatCount(removing?.mailbox_count)} ${removing?.mailbox_count === 1 ? "mailbox" : "mailboxes"} and ${formatCount(removing?.alias_count)} ${removing?.alias_count === 1 ? "alias" : "aliases"}. Delete them first: removing the domain would take their mail with it, so Kaname refuses.`
            : "Yunori stops accepting mail for this domain and drops its aliases and DKIM keys. The records at your DNS provider stay; remove them yourself. The domain itself stays in Kaname."
        }
        confirmText={blocked ? undefined : removing?.domain_name}
        // Blocked, the only useful next step is the list to empty. This
        // button used to read "Remove anyway" and silently do nothing.
        confirmLabel={blocked ? "Open its mailboxes" : "Remove domain"}
        destructive={!blocked}
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          if (blocked) {
            router.push(`/email/mailboxes?mail_domain_id=${removing.id}`);
            return;
          }
          remove.mutate(
            { id: removing.id, domain_name: removing.domain_name },
            { onSuccess: () => setRemoving(null) },
          );
        }}
      >
        {blocked && (
          <p className="text-sm text-[var(--kn-text-2)]">
            Delete each mailbox and alias on this domain, then come back.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Add
 * ------------------------------------------------------------------ */

interface AddDomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId: string | null;
}

function AddDomainDialog({ open, onOpenChange, defaultServerId }: AddDomainDialogProps) {
  const add = useAddMailDomain();
  const domains = useList<Domain>(
    "domains",
    { per_page: 200, sort: "name", order: "asc" },
    { enabled: open },
  );
  const hosted = useMailDomains();
  const servers = useMailServers();

  const [domainId, setDomainId] = React.useState<string | null>(null);
  const [mailServerId, setMailServerId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setDomainId(null);
      add.reset();
      return;
    }
    const match = (servers.data?.data ?? []).find(
      (row) => row.id === defaultServerId || row.server_id === defaultServerId,
    );
    setMailServerId(match?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed from the filter when opening
  }, [open]);

  const hostedIds = React.useMemo(
    () => new Set((hosted.data?.data ?? []).map((row) => row.domain_id)),
    [hosted.data],
  );

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      (domains.data?.data ?? []).map((domain) => ({
        value: domain.id,
        label: domain.name,
        description: hostedIds.has(domain.id)
          ? "Already hosts mail"
          : domain.verified
            ? "Control verified"
            : "Control not yet verified",
        disabled: hostedIds.has(domain.id),
        mono: true,
      })),
    [domains.data, hostedIds],
  );

  const fields = fieldErrors(add.error);
  const chosenServer = (servers.data?.data ?? []).find((row) => row.id === mailServerId) ?? null;
  const chosenDomain = (domains.data?.data ?? []).find((domain) => domain.id === domainId) ?? null;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a mail domain"
      description="Yunori creates the domain and its DKIM keys on the host, then tells you which DNS records to publish."
      submitLabel="Add domain"
      submitting={add.isPending}
      canSubmit={domainId !== null && chosenServer !== null}
      error={add.error}
      onSubmit={() => {
        if (!domainId || !chosenServer || !chosenDomain) return;
        add.mutate(
          {
            domain_id: domainId,
            server_id: chosenServer.server_id,
            domain_name: chosenDomain.name,
          },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
    >
      <FormField label="Mail server" required error={fields["server_id"]}>
        <MailServerPicker
          value={mailServerId}
          onChange={setMailServerId}
          size="md"
          className="w-full"
        />
      </FormField>

      <FormField
        label="Domain"
        required
        description="A domain Kaname already knows. Domains that host mail elsewhere are greyed out."
        error={fields["domain_id"]}
      >
        {domains.isLoading ? (
          <Skeleton className="h-8 w-full rounded-[var(--kn-r-md)]" label="Loading domains" />
        ) : (
          <Combobox
            size="md"
            options={options}
            value={domainId ?? ""}
            onValueChange={(next) => setDomainId(next && next.length > 0 ? next : null)}
            placeholder={options.length === 0 ? "No domain in Kaname yet" : "Select a domain"}
            emptyMessage="No domain matches that name."
            disabled={options.length === 0}
            mono
            aria-label="Domain"
          />
        )}
      </FormField>
    </FormDialog>
  );
}
