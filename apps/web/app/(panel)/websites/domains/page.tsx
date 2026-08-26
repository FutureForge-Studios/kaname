"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BadgeCheck, Globe, Link2, Network, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { DnsProvider, Domain } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  MonoText,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { formatCount } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { CertificateDialog } from "../_components/CertificateDialog";
import { DomainDialog } from "../_components/DomainDialog";
import { FilterSelect } from "../_components/filters";
import { useDeleteDomain, useDomains, useVerifyDomains } from "../_components/queries";
import {
  DNS_PROVIDER_LABELS,
  DnsProviderBadge,
  DomainStatusBadge,
  Expiry,
  ProxiedBadge,
  VerificationBadge,
} from "../_components/status";

/* ------------------------------------------------------------------ *
 * Domains.
 *
 * The columns are the questions that decide whether a name works: who
 * it is registered with and when that lapses, which zone answers for
 * it, whether traffic runs through a proxy, how many records Kaname
 * knows about, whether it carries mail, and whether control of it has
 * ever actually been proved.
 *
 * Registration expiry is a slower clock than a certificate's, so it
 * warns at 45 days and turns urgent at 14 rather than 30 and 7.
 * ------------------------------------------------------------------ */

const REGISTRATION_SOON_DAYS = 45;
const REGISTRATION_URGENT_DAYS = 14;

const PROVIDERS: readonly DnsProvider[] = ["cloudflare", "route53", "digitalocean", "manual"];

const PROVIDER_OPTIONS = PROVIDERS.map((provider) => ({
  value: provider,
  label: DNS_PROVIDER_LABELS[provider],
}));

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "pending", label: "Pending" },
  { value: "unverified", label: "Unverified" },
  { value: "parked", label: "Parked" },
  { value: "error", label: "Error" },
];

const MAIL_OPTIONS = [
  { value: "true", label: "Carries mail" },
  { value: "false", label: "No mail" },
];

const EXPIRY_OPTIONS = [
  { value: "14", label: "Lapses within 14 days" },
  { value: "45", label: "Lapses within 45 days" },
  { value: "90", label: "Lapses within 90 days" },
];

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  return Math.floor((new Date(value).getTime() - Date.now()) / 86_400_000);
}

export default function DomainsPage() {
  const router = useRouter();
  const can = useCan();

  const selection = useServerSelection({ permission: "websites.domains:read" });
  const extraParams = React.useMemo(
    () => ({ server_id: selection.serverId ?? undefined }),
    [selection.serverId],
  );

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["dns_provider", "status", "has_mail", "expiring_within_days"],
    extraParams,
  });
  const query = useDomains(state.params);

  const verify = useVerifyDomains();
  const remove = useDeleteDomain();

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Domain | null>(null);
  const [issuing, setIssuing] = React.useState<Domain | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Domain | null>(null);

  const columns = React.useMemo<DataTableColumn<Domain>[]>(
    () => [
      {
        id: "name",
        header: "Domain",
        locked: true,
        sortable: true,
        minWidth: 200,
        cell: (domain) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
              {domain.name}
            </MonoText>
            {domain.has_mail && (
              <Badge tone="info" size="xs" title="This domain has mailboxes.">
                Mail
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 112,
        cell: (domain) => <DomainStatusBadge status={domain.status} />,
      },
      {
        id: "verified",
        header: "Control",
        width: 112,
        cell: (domain) => <VerificationBadge verified={domain.verified} />,
      },
      {
        id: "site",
        header: "Site",
        minWidth: 148,
        hideBelow: "lg",
        cell: (domain) =>
          domain.site_id && domain.site_name ? (
            <Link
              href={`/websites/sites/${domain.site_id}`}
              className="min-w-0 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
            >
              {domain.site_name}
            </Link>
          ) : (
            <span className="text-[var(--kn-text-3)]">Not attached</span>
          ),
      },
      {
        id: "dns_provider",
        header: "DNS",
        sortable: true,
        width: 128,
        cell: (domain) => <DnsProviderBadge provider={domain.dns_provider} />,
      },
      {
        id: "proxied",
        header: "Edge",
        width: 96,
        hideBelow: "md",
        cell: (domain) => <ProxiedBadge proxied={domain.proxied} />,
      },
      {
        id: "record_count",
        header: "Records",
        width: 88,
        align: "right",
        hideBelow: "md",
        cell: (domain) => (
          <Link
            href={`/websites/dns?domain_id=${domain.id}`}
            className="kn-num rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
          >
            {formatCount(domain.record_count)}
          </Link>
        ),
      },
      {
        id: "registrar",
        header: "Registrar",
        minWidth: 128,
        hideBelow: "lg",
        accessor: (domain) => domain.registrar ?? "—",
      },
      {
        id: "expires_at",
        header: "Registration",
        sortable: true,
        width: 124,
        align: "right",
        cell: (domain) => (
          <Expiry
            days={daysUntil(domain.expires_at)}
            at={domain.expires_at}
            soonDays={REGISTRATION_SOON_DAYS}
            urgentDays={REGISTRATION_URGENT_DAYS}
          />
        ),
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (domain: Domain): DataTableRowAction<Domain>[] => [
      {
        id: "open",
        label: "Open",
        icon: Globe,
        onSelect: () => router.push(`/websites/domains/${domain.id}`),
      },
      {
        id: "dns",
        label: "DNS records",
        icon: Network,
        onSelect: () => router.push(`/websites/dns?domain_id=${domain.id}`),
      },
      {
        id: "verify",
        label: "Check control",
        icon: BadgeCheck,
        disabled: !can("websites.domains:write", domain.server_id),
        onSelect: () => verify.mutate([{ id: domain.id, label: domain.name }]),
      },
      {
        id: "certificate",
        label: "Issue certificate",
        icon: ShieldCheck,
        disabled: !can("websites.ssl:write", domain.server_id),
        onSelect: () => setIssuing(domain),
      },
      {
        id: "edit",
        label: "Edit domain",
        icon: Pencil,
        separatorBefore: true,
        disabled: !can("websites.domains:write", domain.server_id),
        onSelect: () => setEditing(domain),
      },
      {
        id: "delete",
        label: "Delete domain",
        icon: Trash2,
        destructive: true,
        disabled: !can("websites.domains:delete", domain.server_id),
        onSelect: () => setPendingDelete(domain),
      },
    ],
    [can, router, verify],
  );

  const addDomain = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => setCreating(true)}
      disabled={!can("websites.domains:write")}
    >
      Add domain
    </Button>
  );

  return (
    <>
      <ResourcePage<Domain>
        title="Domains"
        subtitle={selection.server ? selection.server.hostname : "Every host in scope"}
        primaryAction={addDomain}
        state={state}
        query={query}
        columns={columns}
        getRowId={(domain) => domain.id}
        tableLabel="Domains"
        searchPlaceholder="Search domains and registrars"
        errorContext="Domains"
        emptyIcon={Link2}
        emptyTitle="No domains yet"
        emptyDescription="A domain is the name Kaname manages records, certificates and mail routing for."
        emptyAction={addDomain}
        selectable
        onRowClick={(domain) => router.push(`/websites/domains/${domain.id}`)}
        rowActions={rowActions}
        filters={
          <>
            <FilterSelect
              label="Provider"
              value={state.filters["dns_provider"]}
              onChange={(value) => state.setFilter("dns_provider", value)}
              options={PROVIDER_OPTIONS}
            />
            <FilterSelect
              label="Status"
              value={state.filters["status"]}
              onChange={(value) => state.setFilter("status", value)}
              options={STATUS_OPTIONS}
            />
            <FilterSelect
              label="Mail"
              value={state.filters["has_mail"]}
              onChange={(value) => state.setFilter("has_mail", value)}
              options={MAIL_OPTIONS}
            />
            <FilterSelect
              label="Registration"
              value={state.filters["expiring_within_days"]}
              onChange={(value) => state.setFilter("expiring_within_days", value)}
              options={EXPIRY_OPTIONS}
            />
          </>
        }
        bulkActions={(ids) => {
          const rows = (query.data?.data ?? []).filter((domain) => ids.includes(domain.id));
          return (
            <Button
              variant="secondary"
              size="xs"
              icon={BadgeCheck}
              loading={verify.isPending}
              onClick={() => {
                verify.mutate(rows.map((domain) => ({ id: domain.id, label: domain.name })));
                state.setSelected([]);
              }}
            >
              Check control of {ids.length === 1 ? "1 domain" : `${ids.length} domains`}
            </Button>
          );
        }}
      >
        <ServerPicker selection={selection} allowAll />
      </ResourcePage>

      <DomainDialog
        open={creating}
        onOpenChange={setCreating}
        defaultServerId={selection.serverId}
      />
      <DomainDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        domain={editing}
      />
      <CertificateDialog
        open={issuing !== null}
        onOpenChange={(open) => !open && setIssuing(null)}
        domain={issuing}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.name ?? "domain"}?`}
        description="Its DNS records and certificate history are removed from Kaname. Nothing is deleted at the registrar or the DNS provider."
        confirmText={pendingDelete?.name}
        confirmLabel="Delete domain"
        loading={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          remove.mutate(
            { id: pendingDelete.id, name: pendingDelete.name },
            { onSuccess: () => setPendingDelete(null) },
          );
        }}
      />
    </>
  );
}
