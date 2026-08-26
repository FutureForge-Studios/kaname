"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Certificate, DnsRecord, Domain } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  DetailLayout,
  DropdownMenu,
  EmptyState,
  IconButton,
  MenuItem,
  MenuSeparator,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Tag,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { formatCount } from "@/lib/format";
import { useCan } from "@/lib/queries";
import type { ApiError } from "@/lib/api";
import { CertificateDialog } from "../../_components/CertificateDialog";
import { DnsRecordDialog } from "../../_components/DnsRecordDialog";
import { DomainDialog } from "../../_components/DomainDialog";
import { DetailBody, DetailFailed, DetailLoading } from "../../_components/detail";
import { useDnsColumns } from "../../_components/dnsColumns";
import {
  useCertificates,
  useDeleteDnsRecord,
  useDeleteDomain,
  useDnsRecords,
  useDomain,
  useReconcileDnsRecord,
  useSyncDns,
  useVerifyDomain,
} from "../../_components/queries";
import {
  CertificateStatusBadge,
  DnsProviderBadge,
  DomainStatusBadge,
  Expiry,
  HostAxes,
  ProxiedBadge,
  VerificationBadge,
  useServerById,
} from "../../_components/status";

/* ------------------------------------------------------------------ *
 * Domain detail.
 *
 * A domain is only interesting because of what answers for it, so the
 * zone is on the page rather than a click away. Verification failures
 * keep the control plane's remediation — the exact TXT record to
 * publish — instead of being reduced to "could not verify".
 * ------------------------------------------------------------------ */

const REGISTRATION_SOON_DAYS = 45;
const REGISTRATION_URGENT_DAYS = 14;

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  return Math.floor((new Date(value).getTime() - Date.now()) / 86_400_000);
}

export default function DomainDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const can = useCan();

  const query = useDomain(id);
  const domain = query.data ?? null;
  const server = useServerById(domain?.server_id);

  const [verifyError, setVerifyError] = React.useState<ApiError | null>(null);
  const verify = useVerifyDomain(setVerifyError);
  const sync = useSyncDns();
  const remove = useDeleteDomain();

  const [editing, setEditing] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);
  const [addingRecord, setAddingRecord] = React.useState(false);
  const [editingRecord, setEditingRecord] = React.useState<DnsRecord | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);

  if (query.isLoading) return <DetailLoading />;
  if (query.isError || !domain) {
    return (
      <DetailFailed
        error={query.error}
        onRetry={() => void query.refetch()}
        context="Domain"
        title="Domain"
      />
    );
  }

  const writable = can("websites.domains:write", domain.server_id);
  const manual = domain.dns_provider === "manual";

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceHeader
          name={domain.name}
          identity={
            domain.registrar
              ? `${domain.registrar}${domain.dns_zone_id ? ` · zone ${domain.dns_zone_id}` : ""}`
              : domain.nameservers.join("  ") || "No registrar recorded"
          }
          connection={server?.connection}
          lastSeenAt={server?.last_seen_at}
          health={server?.health}
          healthReasons={server?.health_reasons}
          badges={
            <>
              <DomainStatusBadge status={domain.status} />
              <VerificationBadge verified={domain.verified} />
              <DnsProviderBadge provider={domain.dns_provider} />
              {domain.proxied && <ProxiedBadge proxied />}
              {domain.has_mail && (
                <Badge tone="info" size="xs">
                  Mail
                </Badge>
              )}
            </>
          }
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={BadgeCheck}
                loading={verify.isPending}
                disabled={!writable}
                onClick={() =>
                  verify.mutate(
                    { id: domain.id, name: domain.name },
                    { onSuccess: () => setVerifyError(null) },
                  )
                }
              >
                Check control
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Plus}
                disabled={!can("websites.dns:write", domain.server_id)}
                onClick={() => setAddingRecord(true)}
              >
                Add record
              </Button>
            </>
          }
          menu={
            <DropdownMenu
              trigger={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
              placement="bottom-end"
              label={`${domain.name} actions`}
            >
              <MenuItem icon={Pencil} disabled={!writable} onSelect={() => setEditing(true)}>
                Edit domain
              </MenuItem>
              <MenuItem
                icon={RefreshCw}
                disabled={manual || !can("websites.dns:read", domain.server_id)}
                onSelect={() => sync.mutate({ domainId: domain.id })}
              >
                {manual ? "Sync zone (needs an API provider)" : "Sync zone from provider"}
              </MenuItem>
              <MenuItem
                icon={Network}
                onSelect={() => router.push(`/websites/dns?domain_id=${domain.id}`)}
              >
                Open in DNS manager
              </MenuItem>
              <MenuItem
                icon={ShieldCheck}
                disabled={!can("websites.ssl:write", domain.server_id)}
                onSelect={() => setIssuing(true)}
              >
                Issue certificate
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                destructive
                disabled={!can("websites.domains:delete", domain.server_id)}
                onSelect={() => setConfirmingDelete(true)}
              >
                Delete domain
              </MenuItem>
            </DropdownMenu>
          }
        />

        <DetailBody>
          {verifyError && (
            <PageError
              error={verifyError}
              onRetry={() =>
                verify.mutate(
                  { id: domain.id, name: domain.name },
                  { onSuccess: () => setVerifyError(null) },
                )
              }
              context="Verification"
            />
          )}

          <DetailLayout
            rail={
              <SectionCard title="Registration" headingLevel={3}>
                <PropertyList dense labelWidth="sm">
                  <PropertyRow label="Site">
                    {domain.site_id && domain.site_name ? (
                      <Link
                        href={`/websites/sites/${domain.site_id}`}
                        className="rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
                      >
                        {domain.site_name}
                      </Link>
                    ) : null}
                  </PropertyRow>
                  <PropertyRow label="Server">
                    <HostAxes server={server} fallbackName={domain.server_name} />
                  </PropertyRow>
                  <PropertyRow label="Registrar">{domain.registrar}</PropertyRow>
                  <PropertyRow label="Registration">
                    <Expiry
                      days={daysUntil(domain.expires_at)}
                      at={domain.expires_at}
                      soonDays={REGISTRATION_SOON_DAYS}
                      urgentDays={REGISTRATION_URGENT_DAYS}
                    />
                  </PropertyRow>
                  <PropertyRow
                    label="Zone id"
                    mono
                    copyValue={domain.dns_zone_id ?? undefined}
                    hint="The zone's identifier at the DNS provider."
                  >
                    {domain.dns_zone_id}
                  </PropertyRow>
                  <PropertyRow label="Records">{formatCount(domain.record_count)}</PropertyRow>
                  <PropertyRow label="Mail">{domain.has_mail ? "Yes" : "No"}</PropertyRow>
                  <PropertyRow label="Control" hint="How Kaname last proved this domain is yours.">
                    <span className="flex flex-wrap items-center gap-2">
                      <VerificationBadge verified={domain.verified} />
                      <RelativeTime
                        value={domain.verified.checked_at}
                        className="text-xs text-[var(--kn-text-2)]"
                        fallback="never checked"
                      />
                    </span>
                  </PropertyRow>
                  <PropertyRow label="Added">
                    <RelativeTime value={domain.created_at} />
                  </PropertyRow>
                </PropertyList>

                {domain.nameservers.length > 0 && (
                  <div className="mt-3 border-t border-[var(--kn-border-subtle)] pt-3">
                    <p className="mb-1.5 text-[var(--kn-text-2)]">Delegation</p>
                    <div className="flex flex-wrap gap-1">
                      {domain.nameservers.map((nameserver) => (
                        <Tag key={nameserver} size="xs" mono>
                          {nameserver}
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
              </SectionCard>
            }
          >
            <DomainRecords
              domain={domain}
              onAdd={() => setAddingRecord(true)}
              onEdit={setEditingRecord}
              onSync={() => sync.mutate({ domainId: domain.id })}
              syncing={sync.isPending}
            />
            <DomainCertificates domain={domain} onIssue={() => setIssuing(true)} />
          </DetailLayout>
        </DetailBody>
      </div>

      <DomainDialog open={editing} onOpenChange={setEditing} domain={domain} />
      <CertificateDialog open={issuing} onOpenChange={setIssuing} domain={domain} />
      <DnsRecordDialog open={addingRecord} onOpenChange={setAddingRecord} domain={domain} />
      <DnsRecordDialog
        open={editingRecord !== null}
        onOpenChange={(open) => !open && setEditingRecord(null)}
        domain={domain}
        record={editingRecord}
      />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${domain.name}?`}
        description="Its DNS records and certificate history are removed from Kaname. Nothing is deleted at the registrar or the DNS provider."
        confirmText={domain.name}
        confirmLabel="Delete domain"
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { id: domain.id, name: domain.name },
            {
              onSuccess: () => {
                setConfirmingDelete(false);
                router.push("/websites/domains");
              },
            },
          )
        }
      />
    </>
  );
}

/* ------------------------------ records ----------------------------- */

interface DomainRecordsProps {
  domain: Domain;
  onAdd: () => void;
  onEdit: (record: DnsRecord) => void;
  onSync: () => void;
  syncing: boolean;
}

function DomainRecords({ domain, onAdd, onEdit, onSync, syncing }: DomainRecordsProps) {
  const can = useCan();
  const query = useDnsRecords({
    domain_id: domain.id,
    per_page: 200,
    sort: "name",
    order: "asc",
  });
  const reconcile = useReconcileDnsRecord();
  const removeRecord = useDeleteDnsRecord();
  const [pendingDelete, setPendingDelete] = React.useState<DnsRecord | null>(null);

  const writable = can("websites.dns:write", domain.server_id);
  const canWrite = React.useCallback(() => writable, [writable]);

  const onReconcile = React.useCallback(
    (record: DnsRecord, direction: "kaname" | "zone") => {
      if (!record.drift) return;
      const content = direction === "kaname" ? record.drift.expected : record.drift.actual;
      if (content === null) return;
      reconcile.mutate({
        id: record.id,
        label: `${record.type} ${record.name}`,
        content,
        direction,
      });
    },
    [reconcile],
  );

  const columns = useDnsColumns({
    onReconcile,
    reconcilingId: reconcile.isPending ? (reconcile.variables?.id ?? null) : null,
    canWrite,
  });

  const rowActions = React.useCallback(
    (record: DnsRecord): DataTableRowAction<DnsRecord>[] => [
      {
        id: "edit",
        label: "Edit record",
        icon: Pencil,
        disabled: !writable,
        onSelect: () => onEdit(record),
      },
      {
        id: "adopt",
        label: "Adopt the zone's value",
        icon: RefreshCw,
        disabled: !writable || !record.drift || record.drift.actual === null,
        onSelect: () => onReconcile(record, "zone"),
      },
      {
        id: "delete",
        label: "Delete record",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled: !can("websites.dns:delete", domain.server_id),
        onSelect: () => setPendingDelete(record),
      },
    ],
    [can, domain.server_id, onEdit, onReconcile, writable],
  );

  const drifted = (query.data?.data ?? []).filter((record) => record.drift !== null).length;

  return (
    <>
      <SectionCard
        title="DNS records"
        icon={Network}
        padded={false}
        headingLevel={3}
        actions={
          <>
            {drifted > 0 && (
              <Badge tone="warn" size="xs">
                {formatCount(drifted)} drifted
              </Badge>
            )}
            <Button
              variant="ghost"
              size="xs"
              icon={RefreshCw}
              loading={syncing}
              disabled={domain.dns_provider === "manual"}
              onClick={onSync}
              title={
                domain.dns_provider === "manual"
                  ? "A manual zone has no API to pull from."
                  : "Re-read the zone from the provider."
              }
            >
              Sync
            </Button>
            <Button variant="secondary" size="xs" icon={Plus} disabled={!writable} onClick={onAdd}>
              Add record
            </Button>
          </>
        }
      >
        <DataTable<DnsRecord>
          columns={columns}
          rows={query.data?.data ?? []}
          getRowId={(record) => record.id}
          label={`${domain.name} DNS records`}
          density="compact"
          columnVisibility={false}
          rowActions={rowActions}
          loading={query.isLoading}
          skeletonRows={6}
          error={
            query.isError ? (
              <PageError
                error={query.error}
                onRetry={() => void query.refetch()}
                context="DNS records"
              />
            ) : undefined
          }
          empty={
            <EmptyState
              icon={Network}
              title="No records in this zone"
              description={
                domain.dns_provider === "manual"
                  ? "Kaname holds your intended records for a manual zone and shows you the lines to publish."
                  : "Sync to pull what the provider already serves, or add the first record here."
              }
              size="sm"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon={Plus}
                  disabled={!writable}
                  onClick={onAdd}
                >
                  Add a record
                </Button>
              }
            />
          }
          className="rounded-none border-0"
        />
      </SectionCard>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this record?"
        description={
          pendingDelete
            ? `${pendingDelete.type} ${pendingDelete.name} will be removed from the zone.`
            : undefined
        }
        confirmLabel="Delete record"
        loading={removeRecord.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          removeRecord.mutate(
            { id: pendingDelete.id, label: `${pendingDelete.type} ${pendingDelete.name}` },
            { onSuccess: () => setPendingDelete(null) },
          );
        }}
      >
        {pendingDelete && (
          <MonoText className="block break-all text-[var(--kn-text-2)]">
            {pendingDelete.content}
          </MonoText>
        )}
      </ConfirmDialog>
    </>
  );
}

/* --------------------------- certificates --------------------------- */

function DomainCertificates({ domain, onIssue }: { domain: Domain; onIssue: () => void }) {
  const router = useRouter();
  const can = useCan();
  const query = useCertificates({
    domain_id: domain.id,
    per_page: 50,
    sort: "expires_at",
    order: "asc",
  });

  const columns = React.useMemo<DataTableColumn<Certificate>[]>(
    () => [
      {
        id: "subject",
        header: "Subject",
        minWidth: 200,
        locked: true,
        cell: (certificate) => (
          <MonoText truncate className="min-w-0">
            {certificate.subject}
          </MonoText>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 116,
        cell: (certificate) => <CertificateStatusBadge status={certificate.status} />,
      },
      {
        id: "expires",
        header: "Expires in",
        width: 116,
        align: "right",
        cell: (certificate) => (
          <Expiry days={certificate.days_remaining} at={certificate.expires_at} />
        ),
      },
      {
        id: "auto_renew",
        header: "Auto-renew",
        width: 104,
        hideBelow: "md",
        accessor: (certificate) => (certificate.auto_renew ? "On" : "Off"),
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Certificates"
      icon={ShieldCheck}
      padded={false}
      headingLevel={3}
      actions={
        <Button
          variant="secondary"
          size="xs"
          icon={Plus}
          disabled={!can("websites.ssl:write", domain.server_id)}
          onClick={onIssue}
        >
          Issue certificate
        </Button>
      }
    >
      <DataTable<Certificate>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(certificate) => certificate.id}
        label={`${domain.name} certificates`}
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={2}
        onRowClick={(certificate) => router.push(`/websites/ssl/${certificate.id}`)}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Certificates"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={ShieldCheck}
            title="No certificate for this domain"
            description="HTTPS will not answer for it until one is issued and installed on a host."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={ShieldCheck} onClick={onIssue}>
                Issue a certificate
              </Button>
            }
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}
