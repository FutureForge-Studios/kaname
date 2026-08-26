"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Globe, Plus, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  CERT_EXPIRY_SOON_DAYS,
  certificateUrgency,
  type CertStatus,
  type Certificate,
} from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  MonoText,
  RelativeTime,
  SectionCard,
  Skeleton,
  Switch,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import { formatCount } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { CertificateDialog } from "../_components/CertificateDialog";
import { JobPanel } from "../_components/JobPanel";
import { FilterSelect } from "../_components/filters";
import {
  useCertificates,
  useExpiringCertificates,
  useRenewCertificates,
  useRevokeCertificate,
  useSetAutoRenew,
} from "../_components/queries";
import { CertificateStatusBadge, Expiry, HostAxes, useServerById } from "../_components/status";

/* ------------------------------------------------------------------ *
 * SSL / TLS.
 *
 * Sorted by urgency by default, because this list is a work queue: the
 * certificate that lapses first is the one that takes a site down
 * first. The expiring section above the table is the same queue,
 * narrowed to what is actually inside its renewal window.
 *
 * The colour discipline matters here more than anywhere else in the
 * product. Sixty days out is a number, not an alarm; inside a week it
 * turns amber; only an expired certificate is red. A panel that shouts
 * about everything teaches its operator to ignore it.
 * ------------------------------------------------------------------ */

const STATUS_OPTIONS: { value: CertStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "expiring", label: "Renewing" },
  { value: "expired", label: "Expired" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "revoked", label: "Revoked" },
];

const AUTO_RENEW_OPTIONS = [
  { value: "true", label: "Auto-renew on" },
  { value: "false", label: "Auto-renew off" },
];

const WINDOW_OPTIONS = [
  { value: "7", label: "Expiring within 7 days" },
  { value: "30", label: "Expiring within 30 days" },
  { value: "90", label: "Expiring within 90 days" },
];

export default function SslPage() {
  const router = useRouter();
  const can = useCan();

  const selection = useServerSelection({ permission: "websites.ssl:read" });
  const extraParams = React.useMemo(
    () => ({ server_id: selection.serverId ?? undefined }),
    [selection.serverId],
  );

  const state = useResourceListState({
    defaultSort: { id: "expires_at", order: "asc" },
    filterKeys: ["status", "auto_renew", "expiring_within_days"],
    extraParams,
  });
  const query = useCertificates(state.params);

  const expiring = useExpiringCertificates({
    ...extraParams,
    expiring_within_days: CERT_EXPIRY_SOON_DAYS,
    per_page: 6,
  });

  const renew = useRenewCertificates();
  const revoke = useRevokeCertificate();
  const autoRenew = useSetAutoRenew();

  const [issuing, setIssuing] = React.useState(false);
  const [pendingRevoke, setPendingRevoke] = React.useState<Certificate | null>(null);
  const [watchedJobId, setWatchedJobId] = React.useState<string | null>(null);

  const startRenew = React.useCallback(
    (ids: readonly string[], force = false) => {
      renew.mutate({ ids, force }, { onSuccess: (jobs) => setWatchedJobId(jobs[0]?.id ?? null) });
    },
    [renew],
  );

  const columns = React.useMemo<DataTableColumn<Certificate>[]>(
    () => [
      {
        id: "subject",
        header: "Subject",
        locked: true,
        sortable: true,
        minWidth: 208,
        cell: (certificate) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
              {certificate.subject}
            </MonoText>
            {certificate.sans.length > 0 && (
              <Badge
                tone="neutral"
                size="xs"
                title={`Also covers:\n${certificate.sans.join("\n")}`}
              >
                +{certificate.sans.length}
              </Badge>
            )}
            {certificate.last_error && (
              <Badge
                tone="danger"
                size="xs"
                icon={TriangleAlert}
                title={certificate.last_error.message}
              >
                Last attempt failed
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        sortable: true,
        width: 116,
        cell: (certificate) => <CertificateStatusBadge status={certificate.status} />,
      },
      {
        id: "expires_at",
        header: "Expires in",
        sortable: true,
        width: 124,
        align: "right",
        cell: (certificate) => (
          <Expiry days={certificate.days_remaining} at={certificate.expires_at} />
        ),
      },
      {
        id: "domain",
        header: "Domain",
        minWidth: 168,
        hideBelow: "lg",
        cell: (certificate) => (
          <Link
            href={`/websites/domains/${certificate.domain_id}`}
            className="kn-mono min-w-0 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
          >
            {certificate.domain_name}
          </Link>
        ),
      },
      {
        id: "server",
        header: "Server",
        minWidth: 168,
        hideBelow: "lg",
        cell: (certificate) => <CertificateServerCell certificate={certificate} />,
      },
      {
        id: "auto_renew",
        header: "Auto-renew",
        width: 112,
        cell: (certificate) => (
          <Switch
            checked={certificate.auto_renew}
            disabled={
              !can("websites.ssl:write", certificate.server_id) || certificate.status === "revoked"
            }
            aria-label={`Automatic renewal for ${certificate.subject}`}
            onChange={(event) =>
              autoRenew.mutate({
                id: certificate.id,
                subject: certificate.subject,
                autoRenew: event.target.checked,
              })
            }
          />
        ),
      },
      {
        id: "issuer",
        header: "Issuer",
        sortable: true,
        minWidth: 148,
        hideBelow: "md",
        accessor: (certificate) => certificate.issuer,
      },
      {
        id: "last_renewal_at",
        header: "Last renewal",
        width: 116,
        align: "right",
        hideBelow: "md",
        cell: (certificate) => (
          <RelativeTime value={certificate.last_renewal_at} fallback="never" />
        ),
      },
    ],
    [autoRenew, can],
  );

  const rowActions = React.useCallback(
    (certificate: Certificate): DataTableRowAction<Certificate>[] => [
      {
        id: "open",
        label: "Open",
        icon: ShieldCheck,
        onSelect: () => router.push(`/websites/ssl/${certificate.id}`),
      },
      {
        id: "renew",
        label: "Renew now",
        icon: RefreshCw,
        disabled:
          !can("websites.ssl:write", certificate.server_id) || certificate.status === "revoked",
        onSelect: () => startRenew([certificate.id], true),
      },
      {
        id: "domain",
        label: "Open the domain",
        icon: Globe,
        onSelect: () => router.push(`/websites/domains/${certificate.domain_id}`),
      },
      {
        id: "revoke",
        label: "Revoke",
        icon: Ban,
        destructive: true,
        separatorBefore: true,
        disabled:
          !can("websites.ssl:delete", certificate.server_id) || certificate.status === "revoked",
        onSelect: () => setPendingRevoke(certificate),
      },
    ],
    [can, router, startRenew],
  );

  const issueCertificate = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => setIssuing(true)}
      disabled={!can("websites.ssl:write")}
    >
      Issue certificate
    </Button>
  );

  return (
    <>
      <ResourcePage<Certificate>
        title="SSL / TLS"
        subtitle={selection.server ? selection.server.hostname : "Every host in scope"}
        primaryAction={issueCertificate}
        state={state}
        query={query}
        columns={columns}
        getRowId={(certificate) => certificate.id}
        tableLabel="Certificates"
        searchPlaceholder="Search subjects and SANs"
        errorContext="Certificates"
        emptyIcon={ShieldCheck}
        emptyTitle="No certificates yet"
        emptyDescription="Kaname runs the ACME order on the host and installs the result. Issue one to serve a domain over HTTPS."
        emptyAction={issueCertificate}
        selectable
        isRowSelectable={(certificate) => certificate.status !== "revoked"}
        onRowClick={(certificate) => router.push(`/websites/ssl/${certificate.id}`)}
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
              label="Renewal"
              value={state.filters["auto_renew"]}
              onChange={(value) => state.setFilter("auto_renew", value)}
              options={AUTO_RENEW_OPTIONS}
            />
            <FilterSelect
              label="Window"
              value={state.filters["expiring_within_days"]}
              onChange={(value) => state.setFilter("expiring_within_days", value)}
              options={WINDOW_OPTIONS}
            />
          </>
        }
        bulkActions={(ids) => (
          <Button
            variant="secondary"
            size="xs"
            icon={RefreshCw}
            loading={renew.isPending}
            onClick={() => {
              startRenew(ids, true);
              state.setSelected([]);
            }}
          >
            Renew {ids.length === 1 ? "certificate" : `${ids.length} certificates`}
          </Button>
        )}
      >
        <ServerPicker selection={selection} allowAll />

        {watchedJobId && (
          <JobPanel
            jobId={watchedJobId}
            title="Certificate job"
            onDismiss={() => setWatchedJobId(null)}
          />
        )}

        <ExpiringSection
          query={expiring}
          onRenew={(certificate) => startRenew([certificate.id], true)}
          renewing={renew.isPending}
        />
      </ResourcePage>

      <CertificateDialog
        open={issuing}
        onOpenChange={setIssuing}
        defaultServerId={selection.serverId}
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
        title={`Revoke ${pendingRevoke?.subject ?? "certificate"}?`}
        description="Every client that checks revocation will reject it immediately. This cannot be undone — the name needs a new certificate afterwards."
        confirmText={pendingRevoke?.subject}
        confirmLabel="Revoke certificate"
        loading={revoke.isPending}
        onConfirm={() => {
          if (!pendingRevoke) return;
          revoke.mutate(
            { id: pendingRevoke.id, subject: pendingRevoke.subject },
            {
              onSuccess: (jobs) => {
                setWatchedJobId(jobs[0]?.id ?? null);
                setPendingRevoke(null);
              },
            },
          );
        }}
      />
    </>
  );
}

function CertificateServerCell({ certificate }: { certificate: Certificate }) {
  const server = useServerById(certificate.server_id);
  return <HostAxes server={server} fallbackName={certificate.server_name} />;
}

/* --------------------------- expiring queue -------------------------- */

interface ExpiringSectionProps {
  query: ReturnType<typeof useExpiringCertificates>;
  onRenew: (certificate: Certificate) => void;
  renewing: boolean;
}

function ExpiringSection({ query, onRenew, renewing }: ExpiringSectionProps) {
  const can = useCan();
  const rows = query.data?.data ?? [];
  const urgent = rows.filter(
    (certificate) =>
      certificate.days_remaining != null &&
      certificateUrgency(certificate.days_remaining) !== "soon",
  ).length;

  if (query.isLoading) {
    return (
      <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Loading expiring certificates" />
    );
  }

  if (query.isError) {
    return (
      <PageError
        error={query.error}
        onRetry={() => void query.refetch()}
        context="Expiring certificates"
      />
    );
  }

  if (rows.length === 0) {
    return (
      <SectionCard title="Renewal window" icon={ShieldCheck} headingLevel={3}>
        <p className="text-[var(--kn-text-2)]">
          Nothing is inside its {CERT_EXPIRY_SOON_DAYS}-day renewal window. Certificates with
          auto-renew on are handled without being asked.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Renewal window"
      icon={ShieldCheck}
      padded={false}
      headingLevel={3}
      description={`Inside ${CERT_EXPIRY_SOON_DAYS} days of expiry, soonest first.`}
      actions={
        urgent > 0 ? (
          <Badge tone="warn" size="xs">
            {formatCount(urgent)} need attention
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            {formatCount(rows.length)} in window
          </Badge>
        )
      }
    >
      <ul className="divide-y divide-[var(--kn-border-subtle)]">
        {rows.map((certificate) => (
          <li key={certificate.id} className="flex items-center gap-3 px-4 py-2">
            <Link
              href={`/websites/ssl/${certificate.id}`}
              className="kn-mono min-w-0 flex-1 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-text)] outline-none hover:text-[var(--kn-accent-400)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
            >
              {certificate.subject}
            </Link>
            <MonoText muted className="hidden text-xs sm:inline">
              {certificate.server_name}
            </MonoText>
            {!certificate.auto_renew && (
              <Badge tone="warn" size="xs" title="Automatic renewal is off for this certificate.">
                Manual
              </Badge>
            )}
            <Expiry
              days={certificate.days_remaining}
              at={certificate.expires_at}
              className="w-20 text-right"
            />
            <Button
              variant="secondary"
              size="xs"
              icon={RefreshCw}
              loading={renewing}
              disabled={!can("websites.ssl:write", certificate.server_id)}
              onClick={() => onRenew(certificate)}
            >
              Renew
            </Button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
