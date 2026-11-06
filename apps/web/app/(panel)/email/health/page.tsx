"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BadgeCheck, ChevronDown, ChevronRight, RefreshCw, ShieldCheck, Stethoscope } from "lucide-react";
import type { MailServer } from "@kaname/contract";
import {
  Button,
  EmptyState,
  MonoText,
  PageHeader,
  PropertyList,
  PropertyRow,
  RelativeTime,
  SectionCard,
  Skeleton,
  cn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { formatCount, formatDateTime, pluralize } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { JobActivityBar } from "../../_components/JobActivity";
import {
  useMailPreflight,
  useMailServers,
  useRenewMailCertificate,
  useSyncMailServer,
} from "../_components/queries";
import {
  CHECK_META,
  CertificateStateBadge,
  ChecksList,
  MailCheckBadge,
  MailServerPicker,
  checkTextClass,
  countChecks,
  verdictSentence,
} from "../_components/status";

/* ------------------------------------------------------------------ *
 * Health.
 *
 * Yunori's `doctor` run for one server, laid out the way an operator
 * reads it: the verdict, then what is failing with the fix beside it,
 * then the certificate (the thing that silently expires), then the
 * preflight that talks to the live host on demand. The dashboard links
 * here with `?server_id=`, so the host id is honoured as well as the
 * mail server's own.
 * ------------------------------------------------------------------ */

const HEALTH_JOB_TYPES = ["mail.server.", "mail.certificate."] as const;

export default function MailHealthPage() {
  const router = useRouter();
  const pathname = usePathname() ?? "/email/health";
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get("server_id");

  const query = useMailServers();
  const servers = query.data?.data ?? [];

  const selected = React.useMemo<MailServer | null>(() => {
    if (fromUrl) {
      const match = servers.find((row) => row.id === fromUrl || row.server_id === fromUrl);
      if (match) return match;
    }
    return servers[0] ?? null;
  }, [fromUrl, servers]);

  const select = React.useCallback(
    (server: MailServer | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (server) next.set("server_id", server.server_id);
      else next.delete("server_id");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  /* Reflect the default pick into the URL so a copied link names the host. */
  React.useEffect(() => {
    if (query.isLoading || !selected) return;
    if (fromUrl !== selected.server_id && fromUrl !== selected.id) select(selected);
  }, [fromUrl, query.isLoading, select, selected]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Mail health"
        subtitle={selected?.hostname ?? "What Yunori's doctor says about each server"}
        actions={selected && <ServerActions server={selected} />}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <MailServerPicker
            value={selected?.id ?? null}
            onChange={(_id, server) => select(server)}
          />
          {selected && (
            <>
              <HostCell serverId={selected.server_id} serverName={selected.server_name} />
              <span className="ml-auto text-xs text-[var(--kn-text-3)]">
                {selected.last_synced_at ? (
                  <>
                    host read <RelativeTime value={selected.last_synced_at} />
                  </>
                ) : (
                  "host not read yet"
                )}
              </span>
            </>
          )}
        </div>

        <JobActivityBar types={HEALTH_JOB_TYPES} />

        {query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} context="Mail health" />
        ) : query.isLoading ? (
          <div className="flex flex-col gap-4" aria-busy>
            <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Loading mail servers" />
            <Skeleton className="h-48 rounded-[var(--kn-r-md)]" />
          </div>
        ) : !selected ? (
          <SectionCard>
            <EmptyState
              icon={BadgeCheck}
              title="No mail server to check"
              description="Health comes from Yunori's doctor on a host Kaname manages. Deploy or adopt one first."
              action={
                <Button variant="primary" size="sm" onClick={() => router.push("/email")}>
                  Go to mail servers
                </Button>
              }
            />
          </SectionCard>
        ) : (
          <HealthDetail server={selected} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ServerActions({ server }: { server: MailServer }) {
  const can = useCan();
  const sync = useSyncMailServer();
  const renew = useRenewMailCertificate();
  const vars = { id: server.id, server_name: server.server_name };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={ShieldCheck}
        loading={renew.isPending}
        disabled={!can("email.servers:exec", server.server_id)}
        onClick={() => renew.mutate(vars)}
      >
        Renew certificate
      </Button>
      <Button
        variant="primary"
        size="sm"
        icon={RefreshCw}
        loading={sync.isPending}
        disabled={!can("email.servers:read", server.server_id)}
        onClick={() => sync.mutate(vars)}
      >
        Check now
      </Button>
    </>
  );
}

function HealthDetail({ server }: { server: MailServer }) {
  const counts = countChecks(server.checks);
  const healthLabel =
    server.health === "pass"
      ? "Healthy"
      : server.checks.length === 0
        ? "Not checked"
        : CHECK_META[server.health].label;

  return (
    <div className="flex flex-col gap-4">
      {/* Verdict */}
      <SectionCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={cn("font-medium", checkTextClass(server.health))}>{verdictSentence(server)}</p>
            <p className="mt-1 text-sm text-[var(--kn-text-2)]">
              {server.checks.length === 0
                ? "Press Check now to run yunori-mail doctor on the host."
                : [
                    counts.fail > 0 && pluralize(counts.fail, "failing", "failing"),
                    counts.warn > 0 && pluralize(counts.warn, "warning"),
                    counts.unknown > 0 && pluralize(counts.unknown, "unknown"),
                    pluralize(counts.pass, "passing", "passing"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </p>
            {!server.install_complete && (
              <p className="mt-1 text-sm text-[var(--kn-text-2)]">
                Setup is not finished.{" "}
                <Link href="/email" className="text-[var(--kn-accent-400)] hover:underline">
                  The server card
                </Link>{" "}
                shows the step that is waiting for you.
              </p>
            )}
          </div>
          <MailCheckBadge status={server.health} size="sm" label={healthLabel} />
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* Checks */}
        <SectionCard
          title="Checks"
          icon={Stethoscope}
          description="The last doctor run, failing first. Each row says what was observed and what to do."
        >
          <ChecksList checks={server.checks} collapsePassing emptyLabel="No doctor run yet." />
        </SectionCard>

        <div className="flex flex-col gap-4">
          <CertificateCard server={server} />
          <PreflightCard server={server} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ certificate -------------------------- */

function CertificateCard({ server }: { server: MailServer }) {
  const can = useCan();
  const renew = useRenewMailCertificate();
  const cert = server.certificate;

  return (
    <SectionCard
      title="Certificate"
      icon={ShieldCheck}
      description="Issued by Let's Encrypt for the mail hostname and pushed into the mail engine."
      actions={
        <Button
          variant="secondary"
          size="xs"
          loading={renew.isPending}
          disabled={!can("email.servers:exec", server.server_id)}
          onClick={() => renew.mutate({ id: server.id, server_name: server.server_name })}
        >
          Renew now
        </Button>
      }
    >
      {!cert ? (
        <p className="text-sm text-[var(--kn-text-3)]">The host has not reported a certificate yet.</p>
      ) : (
        <PropertyList labelWidth="md" dense>
          <PropertyRow label="State">
            <span className="flex flex-wrap items-center gap-2">
              <CertificateStateBadge state={cert.state} />
              {cert.days_left != null && (
                <span
                  className={cn(
                    "kn-num",
                    cert.days_left <= 0
                      ? "text-[var(--kn-danger)]"
                      : cert.days_left <= 7
                        ? "text-[var(--kn-danger)]"
                        : cert.days_left <= 30
                          ? "text-[var(--kn-warn)]"
                          : "text-[var(--kn-text-2)]",
                  )}
                >
                  {cert.days_left <= 0 ? "expired" : `${formatCount(cert.days_left)} days left`}
                </span>
              )}
            </span>
          </PropertyRow>
          <PropertyRow label="Covers" mono copyValue={cert.covers.join("\n") || undefined}>
            {cert.covers.length > 0 ? (
              <span className="flex flex-col">
                {cert.covers.map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </span>
            ) : null}
          </PropertyRow>
          <PropertyRow label="Expires">{cert.expires_at ? formatDateTime(cert.expires_at) : null}</PropertyRow>
          <PropertyRow label="Authority" hint="Who issued it. 'staging' means the rehearsal CA, which nothing trusts.">
            {cert.authority ?? cert.issuer}
          </PropertyRow>
          <PropertyRow label="Renews" hint="Renewal starts 30 days before expiry.">
            {cert.renews_at ? formatDateTime(cert.renews_at) : null}
          </PropertyRow>
          <PropertyRow label="Last attempt">
            {cert.last_attempt ? <RelativeTime value={cert.last_attempt} /> : null}
          </PropertyRow>
          <PropertyRow label="Next attempt" empty="none scheduled">
            {cert.next_attempt ? <RelativeTime value={cert.next_attempt} /> : null}
          </PropertyRow>
        </PropertyList>
      )}
    </SectionCard>
  );
}

/* ------------------------------- preflight --------------------------- */

/**
 * Preflight is Yunori's "is this host suitable" run — ports, reverse
 * DNS, blocklists, the hosting provider. It talks to the live agent and
 * takes a while, so it only runs when asked and is kept until asked
 * again.
 */
function PreflightCard({ server }: { server: MailServer }) {
  const [open, setOpen] = React.useState(false);
  const [asked, setAsked] = React.useState(false);
  const preflight = useMailPreflight(server.id, asked);

  React.useEffect(() => {
    setAsked(false);
    setOpen(false);
  }, [server.id]);

  const checks = preflight.data?.checks ?? [];
  const counts = countChecks(checks);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <SectionCard
      padded={false}
      title={
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-[var(--kn-r-xs)] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
        >
          <Chevron size={14} className="text-[var(--kn-text-3)]" aria-hidden />
          Preflight
        </button>
      }
      description="Outbound port 25, reverse DNS, blocklists, provider. Runs on the live host when you ask."
      actions={
        preflight.data && (
          <span className="flex items-center gap-2 text-xs">
            {counts.fail > 0 && <span className="text-[var(--kn-danger)]">{pluralize(counts.fail, "failing", "failing")}</span>}
            {counts.warn > 0 && <span className="text-[var(--kn-warn)]">{pluralize(counts.warn, "warning")}</span>}
            <span className="text-[var(--kn-text-3)]">{pluralize(counts.pass, "passing", "passing")}</span>
          </span>
        )
      }
    >
      {open && (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              loading={preflight.isFetching}
              onClick={() => {
                if (asked) void preflight.refetch();
                else setAsked(true);
              }}
            >
              {preflight.data ? "Run again" : "Run preflight"}
            </Button>
            {preflight.dataUpdatedAt > 0 && (
              <span className="text-xs text-[var(--kn-text-3)]">
                ran <RelativeTime value={preflight.dataUpdatedAt} /> on{" "}
                <MonoText>{server.server_name}</MonoText>
              </span>
            )}
          </div>

          {preflight.isError && (
            <PageError error={preflight.error} onRetry={() => void preflight.refetch()} context="Preflight" />
          )}
          {preflight.isFetching && !preflight.data && (
            <Skeleton className="h-24 rounded-[var(--kn-r-sm)]" label="Running preflight" />
          )}
          {preflight.data && (
            <ChecksList checks={checks} grouped={false} emptyLabel="Preflight reported no checks." />
          )}
          {!asked && !preflight.isFetching && (
            <p className="text-sm text-[var(--kn-text-3)]">
              Nothing has run yet. Preflight needs the agent online and takes a few seconds.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
