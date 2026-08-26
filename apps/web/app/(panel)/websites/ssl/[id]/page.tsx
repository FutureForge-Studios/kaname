"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Globe, MoreHorizontal, Network, RefreshCw, ShieldCheck } from "lucide-react";
import type { RemediationAction } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DetailLayout,
  DropdownMenu,
  ErrorState,
  IconButton,
  MenuItem,
  MenuSeparator,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Switch,
  Tag,
} from "@kaname/ui";
import { formatDateTime } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { JobPanel } from "../../_components/JobPanel";
import { DetailBody, DetailFailed, DetailLoading } from "../../_components/detail";
import {
  useCertificate,
  useRenewCertificates,
  useRevokeCertificate,
  useSetAutoRenew,
} from "../../_components/queries";
import { CertificateStatusBadge, Expiry, useServerById } from "../../_components/status";

/* ------------------------------------------------------------------ *
 * Certificate detail.
 *
 * The three things worth a page of their own: exactly what this
 * certificate covers, exactly when it stops working, and — when the
 * last attempt failed — the specific record or URL that has to be
 * fixed. The control plane already turns certbot's output into that
 * remediation, so it is rendered as given rather than paraphrased.
 * ------------------------------------------------------------------ */

export default function CertificateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const can = useCan();

  const query = useCertificate(id);
  const certificate = query.data ?? null;
  const server = useServerById(certificate?.server_id);

  const renew = useRenewCertificates();
  const revoke = useRevokeCertificate();
  const autoRenew = useSetAutoRenew();

  const [watchedJobId, setWatchedJobId] = React.useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = React.useState(false);

  const startRenew = React.useCallback(
    (certificateId: string) => {
      renew.mutate(
        { ids: [certificateId], force: true },
        { onSuccess: (jobs) => setWatchedJobId(jobs[0]?.id ?? null) },
      );
    },
    [renew],
  );

  const handleRemediation = React.useCallback(
    (action: RemediationAction) => {
      if (action.href) {
        router.push(action.href);
        return;
      }
      if (
        action.action === "certificates.renew" ||
        action.action === "certificates.issue" ||
        action.action === "certificates.issue_staging" ||
        action.action === "certificates.issue_http"
      ) {
        if (certificate) startRenew(certificate.id);
      }
    },
    [certificate, router, startRenew],
  );

  if (query.isLoading) return <DetailLoading />;
  if (query.isError || !certificate) {
    return (
      <DetailFailed
        error={query.error}
        onRetry={() => void query.refetch()}
        context="Certificate"
        title="Certificate"
      />
    );
  }

  const writable = can("websites.ssl:write", certificate.server_id);
  const revoked = certificate.status === "revoked";

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceHeader
          name={certificate.subject}
          identity={`${certificate.issuer} · ${certificate.key_type.toUpperCase()} · ${certificate.challenge}`}
          connection={server?.connection}
          lastSeenAt={server?.last_seen_at}
          health={server?.health}
          healthReasons={server?.health_reasons}
          badges={
            <>
              <CertificateStatusBadge status={certificate.status} />
              <Badge tone={certificate.auto_renew ? "neutral" : "warn"} size="xs">
                {certificate.auto_renew ? "Auto-renew on" : "Manual renewal"}
              </Badge>
            </>
          }
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={RefreshCw}
              loading={renew.isPending}
              disabled={!writable || revoked}
              title={revoked ? "A revoked certificate cannot be renewed." : undefined}
              onClick={() => startRenew(certificate.id)}
            >
              Renew now
            </Button>
          }
          menu={
            <DropdownMenu
              trigger={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
              placement="bottom-end"
              label={`${certificate.subject} actions`}
            >
              <MenuItem
                icon={Globe}
                onSelect={() => router.push(`/websites/domains/${certificate.domain_id}`)}
              >
                Open the domain
              </MenuItem>
              <MenuItem
                icon={Network}
                onSelect={() => router.push(`/websites/dns?domain_id=${certificate.domain_id}`)}
              >
                Open the zone
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={Ban}
                destructive
                disabled={!can("websites.ssl:delete", certificate.server_id) || revoked}
                onSelect={() => setConfirmingRevoke(true)}
              >
                Revoke certificate
              </MenuItem>
            </DropdownMenu>
          }
        />

        <DetailBody>
          {certificate.last_error && (
            <ErrorState
              code={certificate.last_error.code}
              message={certificate.last_error.message}
              remediation={certificate.last_error.remediation}
              onAction={handleRemediation}
              tone={certificate.status === "active" ? "warn" : "danger"}
            >
              <p className="mt-2 text-xs text-[var(--kn-text-3)]">
                Recorded {formatDateTime(certificate.last_error.at)}
              </p>
            </ErrorState>
          )}

          {watchedJobId && (
            <JobPanel
              jobId={watchedJobId}
              title="Certificate job"
              onDismiss={() => setWatchedJobId(null)}
            />
          )}

          <DetailLayout
            rail={
              <SectionCard title="Certificate" headingLevel={3}>
                <PropertyList dense labelWidth="sm">
                  <PropertyRow label="Domain">
                    <Link
                      href={`/websites/domains/${certificate.domain_id}`}
                      className="kn-mono rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
                    >
                      {certificate.domain_name}
                    </Link>
                  </PropertyRow>
                  <PropertyRow label="Server">
                    <Link
                      href={`/infrastructure/servers/${certificate.server_id}`}
                      className="kn-mono rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
                    >
                      {certificate.server_name}
                    </Link>
                  </PropertyRow>
                  <PropertyRow label="Issuer">{certificate.issuer}</PropertyRow>
                  <PropertyRow label="Challenge" mono>
                    {certificate.challenge}
                  </PropertyRow>
                  <PropertyRow label="Key type" mono>
                    {certificate.key_type}
                  </PropertyRow>
                  <PropertyRow label="Issued">
                    <RelativeTime value={certificate.issued_at} fallback="never" />
                  </PropertyRow>
                  <PropertyRow label="Expires" hint={certificate.expires_at ?? undefined}>
                    <Expiry days={certificate.days_remaining} at={certificate.expires_at} />
                  </PropertyRow>
                  <PropertyRow label="Last renewal">
                    <RelativeTime value={certificate.last_renewal_at} fallback="never" />
                  </PropertyRow>
                  <PropertyRow
                    label="Installed at"
                    mono
                    copyValue={certificate.installed_path ?? undefined}
                  >
                    {certificate.installed_path}
                  </PropertyRow>
                </PropertyList>
              </SectionCard>
            }
          >
            <SectionCard title="Renewal" icon={RefreshCw} headingLevel={3}>
              <div className="flex flex-col gap-3">
                <Switch
                  checked={certificate.auto_renew}
                  disabled={!writable || revoked}
                  onChange={(event) =>
                    autoRenew.mutate({
                      id: certificate.id,
                      subject: certificate.subject,
                      autoRenew: event.target.checked,
                    })
                  }
                  label="Renew automatically"
                  description={`Kaname renews inside the 30-day window without being asked. Turning this off means the ${certificate.subject} certificate lapses unless someone renews it by hand.`}
                />

                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--kn-border-subtle)] pt-3">
                  <Expiry days={certificate.days_remaining} at={certificate.expires_at} />
                  <span className="text-[var(--kn-text-2)]">
                    {certificate.expires_at
                      ? `until ${formatDateTime(certificate.expires_at)}`
                      : "no expiry recorded"}
                  </span>
                  <Button
                    variant="secondary"
                    size="xs"
                    icon={RefreshCw}
                    loading={renew.isPending}
                    disabled={!writable || revoked}
                    className="ml-auto"
                    onClick={() => startRenew(certificate.id)}
                  >
                    Renew now
                  </Button>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Covered names"
              icon={ShieldCheck}
              headingLevel={3}
              description="Every name a browser will accept this certificate for."
            >
              <div className="flex flex-wrap gap-1">
                <Tag size="sm" mono>
                  {certificate.subject}
                </Tag>
                {certificate.sans.map((san) => (
                  <Tag key={san} size="sm" mono>
                    {san}
                  </Tag>
                ))}
              </div>
              {certificate.sans.length === 0 && (
                <p className="mt-2 text-[var(--kn-text-2)]">
                  Only the subject. A request for{" "}
                  <MonoText muted>www.{certificate.subject}</MonoText> would be rejected by the
                  browser before it reached the site.
                </p>
              )}
            </SectionCard>
          </DetailLayout>
        </DetailBody>
      </div>

      <ConfirmDialog
        open={confirmingRevoke}
        onOpenChange={setConfirmingRevoke}
        title={`Revoke ${certificate.subject}?`}
        description="Every client that checks revocation will reject it immediately. This cannot be undone — the name needs a new certificate afterwards."
        confirmText={certificate.subject}
        confirmLabel="Revoke certificate"
        loading={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(
            { id: certificate.id, subject: certificate.subject },
            {
              onSuccess: (jobs) => {
                setWatchedJobId(jobs[0]?.id ?? null);
                setConfirmingRevoke(false);
              },
            },
          )
        }
      />
    </>
  );
}
