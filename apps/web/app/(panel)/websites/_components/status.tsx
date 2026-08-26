"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldOff, TriangleAlert } from "lucide-react";
import {
  CERT_EXPIRY_SOON_DAYS,
  CERT_EXPIRY_URGENT_DAYS,
  certificateUrgency,
  type CertStatus,
  type DeploymentStatus,
  type DnsProvider,
  type Domain,
  type Server,
  type Site,
  type SiteRuntime,
} from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Badge,
  HealthBadge,
  MonoText,
  StatusBadge,
  cn,
  type Tone,
} from "@kaname/ui";
import { formatDaysLeft, formatDateTime } from "@/lib/format";
import { useServers } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The Websites module's shared vocabulary.
 *
 * Five pages render the same handful of states — a site's lifecycle, a
 * certificate's remaining days, a record's drift — and they have to
 * mean the same thing on every one of them. Defining each once here is
 * what stops the sites list calling 20 days "expiring" while the SSL
 * list calls it "active".
 *
 * Expiry in particular is deliberately calm: colour escalates on the
 * contract's own thresholds (30 days, then 7), and nothing two months
 * out is ever painted as a failure.
 * ------------------------------------------------------------------ */

/* ------------------------------- sites ------------------------------ */

const SITE_STATUS_META: Record<Site["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  provisioning: { label: "Provisioning", tone: "accent" },
  suspended: { label: "Suspended", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

export function SiteStatusBadge({ status }: { status: Site["status"] }) {
  const meta = SITE_STATUS_META[status];
  return (
    <StatusBadge tone={meta.tone} size="xs" pulse={status === "provisioning"}>
      {meta.label}
    </StatusBadge>
  );
}

export const RUNTIME_LABELS: Record<SiteRuntime, string> = {
  static: "Static",
  php: "PHP",
  node: "Node",
  python: "Python",
  proxy: "Proxy",
  container: "Container",
};

export function RuntimeCell({ site }: { site: Site }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className="text-[var(--kn-text)]">{RUNTIME_LABELS[site.runtime]}</span>
      {site.runtime_version && (
        <MonoText muted className="text-xs">
          {site.runtime_version}
        </MonoText>
      )}
    </span>
  );
}

/* ------------------------------ domains ----------------------------- */

const DOMAIN_STATUS_META: Record<Domain["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "ok" },
  pending: { label: "Pending", tone: "warn" },
  unverified: { label: "Unverified", tone: "neutral" },
  parked: { label: "Parked", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

export function DomainStatusBadge({ status }: { status: Domain["status"] }) {
  const meta = DOMAIN_STATUS_META[status];
  return (
    <StatusBadge tone={meta.tone} size="xs">
      {meta.label}
    </StatusBadge>
  );
}

const VERIFICATION_LABELS: Record<Domain["verified"]["method"], string> = {
  dns_txt: "TXT record",
  http_file: "HTTP file",
  nameserver: "Nameservers",
  none: "Not proved",
};

export function VerificationBadge({ verified }: { verified: Domain["verified"] }) {
  const method = VERIFICATION_LABELS[verified.method];
  const when = verified.checked_at ? ` Last checked ${formatDateTime(verified.checked_at)}.` : "";

  return (
    <StatusBadge
      tone={verified.ok ? "ok" : "neutral"}
      size="xs"
      hollow={!verified.ok}
      title={
        verified.ok
          ? `Control of this domain was proved by ${method.toLowerCase()}.${when}`
          : `Kaname has no proof this domain is yours.${when}`
      }
    >
      {verified.ok ? "Verified" : "Unverified"}
    </StatusBadge>
  );
}

export const DNS_PROVIDER_LABELS: Record<DnsProvider, string> = {
  cloudflare: "Cloudflare",
  route53: "Route 53",
  digitalocean: "DigitalOcean",
  manual: "Manual",
};

/** Manual zones have no API to drive, which changes what every page can offer. */
export function DnsProviderBadge({ provider }: { provider: DnsProvider }) {
  return (
    <Badge tone={provider === "manual" ? "neutral" : "info"} size="xs">
      {DNS_PROVIDER_LABELS[provider]}
    </Badge>
  );
}

export function ProxiedBadge({ proxied }: { proxied: boolean }) {
  if (!proxied) {
    return <span className="text-[var(--kn-text-3)]">Direct</span>;
  }
  return (
    <Badge tone="info" size="xs" title="Traffic is served through the provider's edge network.">
      Proxied
    </Badge>
  );
}

export function ManagedByBadge({ managedBy }: { managedBy: "kaname" | "external" }) {
  return (
    <Badge
      tone={managedBy === "kaname" ? "accent" : "neutral"}
      size="xs"
      title={
        managedBy === "kaname"
          ? "Kaname owns this record and will write it back on the next apply."
          : "This record was found at the provider and is left untouched."
      }
    >
      {managedBy === "kaname" ? "Kaname" : "External"}
    </Badge>
  );
}

/* -------------------------------- drift ------------------------------ */

export interface DriftIndicatorProps {
  drift: { expected: string; actual: string | null; detected_at: string } | null;
  className?: string;
}

/**
 * Drift is the gap between what Kaname asked the zone for and what the
 * zone holds. It is a warning rather than an error: the provider is
 * authoritative, and adopting its copy is often the right answer.
 */
export function DriftIndicator({ drift, className }: DriftIndicatorProps) {
  if (!drift) return null;

  const detail = drift.actual
    ? `Kaname expects "${drift.expected}"; the zone serves "${drift.actual}".`
    : `Kaname expects "${drift.expected}"; the zone no longer has this record.`;

  return (
    <Badge
      tone="warn"
      size="xs"
      icon={TriangleAlert}
      className={className}
      title={`Changed outside Kaname ${formatDateTime(drift.detected_at)}. ${detail}`}
    >
      Drifted
    </Badge>
  );
}

/* ---------------------------- certificates --------------------------- */

const CERT_STATUS_META: Record<CertStatus, { label: string; tone: Tone }> = {
  none: { label: "None", tone: "neutral" },
  pending: { label: "Pending", tone: "accent" },
  active: { label: "Active", tone: "ok" },
  expiring: { label: "Renewing", tone: "warn" },
  expired: { label: "Expired", tone: "danger" },
  revoked: { label: "Revoked", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function CertificateStatusBadge({ status }: { status: CertStatus }) {
  const meta = CERT_STATUS_META[status];
  return (
    <StatusBadge
      tone={meta.tone}
      size="xs"
      pulse={status === "pending"}
      icon={status === "revoked" ? ShieldOff : undefined}
    >
      {meta.label}
    </StatusBadge>
  );
}

const EXPIRY_TONE_CLASS: Record<"ok" | "soon" | "urgent" | "expired", string> = {
  ok: "text-[var(--kn-text)]",
  soon: "text-[var(--kn-text)]",
  urgent: "text-[var(--kn-warn)]",
  expired: "text-[var(--kn-danger)]",
};

export interface ExpiryProps {
  /** Whole days until expiry; negative once past. Null when unknown. */
  days: number | null | undefined;
  /** Rendered in the title so the exact date is one hover away. */
  at?: string | null;
  soonDays?: number;
  urgentDays?: number;
  className?: string;
}

/**
 * One number, coloured only when it has started to matter. An operator
 * reads this column dozens of times a week; painting 60 days red is how
 * a panel teaches people to ignore it.
 */
export function Expiry({
  days,
  at,
  soonDays = CERT_EXPIRY_SOON_DAYS,
  urgentDays = CERT_EXPIRY_URGENT_DAYS,
  className,
}: ExpiryProps) {
  if (days == null || !Number.isFinite(days)) {
    return <span className={cn("text-[var(--kn-text-3)]", className)}>—</span>;
  }

  const level =
    days <= 0 ? "expired" : days <= urgentDays ? "urgent" : days <= soonDays ? "soon" : "ok";
  const label = days <= 0 ? `Expired ${formatDaysLeft(days)}` : formatDaysLeft(days);

  return (
    <span
      className={cn("kn-num whitespace-nowrap", EXPIRY_TONE_CLASS[level], className)}
      title={at ? formatDateTime(at) : undefined}
    >
      {label}
    </span>
  );
}

/** The site list's SSL column: status and remaining days in one cell. */
export function SiteSslCell({ site }: { site: Site }) {
  if (!site.ssl) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--kn-text-3)]">
        <ShieldOff size={12} aria-hidden />
        No certificate
      </span>
    );
  }

  const urgency =
    site.ssl.days_remaining == null ? null : certificateUrgency(site.ssl.days_remaining);

  return (
    <Link
      href={`/websites/ssl/${site.ssl.certificate_id}`}
      className="inline-flex min-w-0 items-center gap-2 rounded-[var(--kn-r-xs)] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
    >
      <CertificateStatusBadge status={site.ssl.status} />
      {urgency !== "expired" && (
        <Expiry days={site.ssl.days_remaining} at={site.ssl.expires_at} className="text-xs" />
      )}
    </Link>
  );
}

/* ---------------------------- deployments ---------------------------- */

const DEPLOYMENT_STATUS_META: Record<DeploymentStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  building: { label: "Building", tone: "accent" },
  deploying: { label: "Deploying", tone: "accent" },
  succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rolled_back: { label: "Rolled back", tone: "warn" },
};

export const DEPLOYMENT_IN_FLIGHT: readonly DeploymentStatus[] = [
  "queued",
  "building",
  "deploying",
];

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  const meta = DEPLOYMENT_STATUS_META[status];
  return (
    <StatusBadge tone={meta.tone} size="xs" pulse={DEPLOYMENT_IN_FLIGHT.includes(status)}>
      {meta.label}
    </StatusBadge>
  );
}

export function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

export interface CommitCellProps {
  sha: string | null;
  message: string | null;
}

/**
 * One line: the abbreviated object id, then the subject. Table rows are
 * a fixed 36px, so the author and branch get columns of their own
 * rather than a second line that would clip.
 */
export function CommitCell({ sha, message }: CommitCellProps) {
  const short = shortSha(sha);

  if (!short && !message) {
    return <span className="text-[var(--kn-text-3)]">Uploaded build</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      {short && (
        <MonoText className="shrink-0 text-[var(--kn-accent-400)]" title={sha ?? undefined}>
          {short}
        </MonoText>
      )}
      <span className="min-w-0 truncate text-[var(--kn-text)]">
        {message ?? "No commit message"}
      </span>
    </span>
  );
}

/* ------------------------------- hosts ------------------------------- */

/** Resolves a server row from the fleet list every page already holds. */
export function useServerById(serverId: string | null | undefined): Server | null {
  const { data } = useServers();
  if (!serverId) return null;
  return data?.data.find((server) => server.id === serverId) ?? null;
}

export interface HostAxesProps {
  server: Server | null;
  /** Falls back to a plain name when the host is outside this account's scope. */
  fallbackName?: string | null;
  className?: string;
}

/**
 * Both status axes, never collapsed (PLAN.md 2.6). "Can we reach it"
 * and "is it OK" answer different questions, and a site that is healthy
 * on an unreachable host is exactly the case a single dot would hide.
 */
export function HostAxes({ server, fallbackName, className }: HostAxesProps) {
  if (!server) {
    return fallbackName ? (
      <MonoText muted className={className}>
        {fallbackName}
      </MonoText>
    ) : (
      <span className={cn("text-[var(--kn-text-3)]", className)}>—</span>
    );
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <AgentConnectionIndicator
        connection={server.connection}
        since={server.last_seen_at}
        showLabel={false}
      />
      <Link
        href={`/infrastructure/servers/${server.id}`}
        className="kn-mono min-w-0 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-text)] outline-none hover:text-[var(--kn-accent-400)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
      >
        {server.name}
      </Link>
      <HealthBadge
        health={server.health}
        reasons={server.health_reasons}
        since={server.latest?.sampled_at ?? null}
        size="xs"
        showLabel={false}
      />
    </span>
  );
}
