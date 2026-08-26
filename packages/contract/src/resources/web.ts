import { z } from "zod";
import {
  absolutePath,
  bytes,
  domainName,
  emailAddress,
  identifier,
  isoDate,
  listQuery,
  remediation,
  uuid,
} from "../primitives.js";
import {
  certChallenge,
  certStatus,
  deploymentStatus,
  dnsProvider,
  dnsRecordType,
  managedBy,
  siteRuntime,
  siteStatus,
} from "../enums.js";

/* ------------------------------------------------------------------ *
 * Sites
 * ------------------------------------------------------------------ */

/** Enough of a domain to render and link it from a site row. */
export const siteDomainRef = z.object({
  id: uuid,
  name: z.string(),
});
export type SiteDomainRef = z.infer<typeof siteDomainRef>;

export const site = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  name: z.string(),
  webroot: z.string(),
  runtime: siteRuntime,
  runtime_version: z.string().nullable(),
  status: siteStatus,
  primary_domain: z.string().nullable(),
  domains: z.array(siteDomainRef).default([]),
  force_https: z.boolean(),
  /** Origin for `proxy` sites, e.g. "http://127.0.0.1:3000". Null otherwise. */
  upstream: z.string().nullable(),
  config_path: z.string().nullable(),
  owner: z.string().nullable(),
  /**
   * Set independently of `runtime_version`: a static or proxy site can still
   * serve a legacy PHP path through an FPM pool.
   */
  php_version: z.string().nullable(),
  disk_usage: bytes.nullable(),

  last_deployment: z
    .object({
      id: uuid,
      status: deploymentStatus,
      finished_at: isoDate.nullable(),
    })
    .nullable(),

  /** Denormalised from the certificate so a site list renders expiry in one query. */
  ssl: z
    .object({
      certificate_id: uuid,
      status: certStatus,
      expires_at: isoDate.nullable(),
      days_remaining: z.number().int().nullable(),
    })
    .nullable(),

  /** Config path, status and disk usage are reconciled from the host (KD-012). */
  last_synced_at: isoDate.nullable(),

  created_at: isoDate,
  updated_at: isoDate,
});
export type Site = z.infer<typeof site>;

export const createSiteInput = z.object({
  server_id: uuid,
  name: z.string().min(1).max(128),
  webroot: absolutePath,
  runtime: siteRuntime,
  runtime_version: z.string().max(32).optional(),
  php_version: z.string().max(16).optional(),
  primary_domain: domainName,
  /** Additional names to answer on. The primary domain is always included. */
  domains: z.array(domainName).max(50).default([]),
  force_https: z.boolean().default(true),
  upstream: z.string().max(256).optional(),
  owner: identifier.optional(),
});
export type CreateSiteInput = z.infer<typeof createSiteInput>;

/** A site cannot move between servers; that is a create plus a delete. */
export const updateSiteInput = createSiteInput.omit({ server_id: true }).partial();
export type UpdateSiteInput = z.infer<typeof updateSiteInput>;

export const siteListQuery = listQuery.extend({
  server_id: uuid.optional(),
  runtime: siteRuntime.optional(),
  status: siteStatus.optional(),
  ssl_status: certStatus.optional(),
  domain: z.string().max(253).optional(),
});
export type SiteListQuery = z.infer<typeof siteListQuery>;

/* ------------------------------------------------------------------ *
 * Domains
 * ------------------------------------------------------------------ */

/** Not in ../enums.js: a domain's lifecycle is distinct from a site's. */
export const domainStatus = z.enum(["active", "pending", "unverified", "parked", "error"]);
export type DomainStatus = z.infer<typeof domainStatus>;

export const domainVerificationMethod = z.enum(["dns_txt", "http_file", "nameserver", "none"]);
export type DomainVerificationMethod = z.infer<typeof domainVerificationMethod>;

export const domain = z.object({
  id: uuid,
  name: z.string(),
  site_id: uuid.nullable(),
  site_name: z.string().nullable(),
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  dns_provider: dnsProvider,
  /** Zone identifier at the provider. Null while the zone is unlinked. */
  dns_zone_id: z.string().nullable(),
  proxied: z.boolean(),
  status: domainStatus,
  registrar: z.string().nullable(),
  /** Registration expiry, not certificate expiry. */
  expires_at: isoDate.nullable(),
  nameservers: z.array(z.string()).default([]),
  record_count: z.number().int(),
  verified: z.object({
    ok: z.boolean(),
    method: domainVerificationMethod,
    checked_at: isoDate.nullable(),
  }),
  /** Drives whether the Email module offers this domain. */
  has_mail: z.boolean(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type Domain = z.infer<typeof domain>;

export const createDomainInput = z.object({
  name: domainName,
  site_id: uuid.nullable().optional(),
  server_id: uuid.nullable().optional(),
  dns_provider: dnsProvider.default("manual"),
  dns_zone_id: z.string().max(128).optional(),
  proxied: z.boolean().default(false),
  registrar: z.string().max(128).optional(),
});
export type CreateDomainInput = z.infer<typeof createDomainInput>;

export const updateDomainInput = createDomainInput.partial();
export type UpdateDomainInput = z.infer<typeof updateDomainInput>;

export const domainListQuery = listQuery.extend({
  site_id: uuid.optional(),
  server_id: uuid.optional(),
  dns_provider: dnsProvider.optional(),
  status: domainStatus.optional(),
  has_mail: z.coerce.boolean().optional(),
  expiring_within_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type DomainListQuery = z.infer<typeof domainListQuery>;

/* ------------------------------------------------------------------ *
 * DNS records
 * ------------------------------------------------------------------ */

/** A record that changed at the provider without going through Kaname. */
export const dnsRecordDrift = z.object({
  expected: z.string(),
  /** Null when the record was deleted outside Kaname. */
  actual: z.string().nullable(),
  detected_at: isoDate,
});
export type DnsRecordDrift = z.infer<typeof dnsRecordDrift>;

export const dnsRecord = z.object({
  id: uuid,
  domain_id: uuid,
  domain_name: z.string(),
  type: dnsRecordType,
  name: z.string(),
  content: z.string(),
  /** 0 or 1 means "automatic" at providers that support it. */
  ttl: z.number().int(),
  priority: z.number().int().nullable(),
  proxied: z.boolean(),
  managed_by: managedBy,
  /** The provider's own record id, so an apply can address it. */
  external_id: z.string().nullable(),
  /** How stale this row is. Surfaced in the UI, never hidden (KD-012). */
  last_synced_at: isoDate,
  drift: dnsRecordDrift.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type DnsRecord = z.infer<typeof dnsRecord>;

export const createDnsRecordInput = z.object({
  domain_id: uuid,
  type: dnsRecordType,
  name: z.string().min(1).max(253),
  content: z.string().min(1).max(2048),
  ttl: z.number().int().min(0).max(604800).default(3600),
  priority: z.number().int().min(0).max(65535).optional(),
  proxied: z.boolean().default(false),
});
export type CreateDnsRecordInput = z.infer<typeof createDnsRecordInput>;

/** A record cannot move zone; that is a delete plus a create. */
export const updateDnsRecordInput = createDnsRecordInput.omit({ domain_id: true }).partial();
export type UpdateDnsRecordInput = z.infer<typeof updateDnsRecordInput>;

export const dnsRecordListQuery = listQuery.extend({
  domain_id: uuid.optional(),
  type: dnsRecordType.optional(),
  managed_by: managedBy.optional(),
  drifted: z.coerce.boolean().optional(),
});
export type DnsRecordListQuery = z.infer<typeof dnsRecordListQuery>;

/* ------------------------------------------------------------------ *
 * DNS validation
 * ------------------------------------------------------------------ */

export const dnsValidationSeverity = z.enum(["error", "warning", "info"]);
export type DnsValidationSeverity = z.infer<typeof dnsValidationSeverity>;

export const dnsValidationIssue = z.object({
  severity: dnsValidationSeverity,
  /** Null for zone-level findings (missing apex A, conflicting SPF count). */
  record_id: uuid.nullable(),
  code: z.string(),
  message: z.string(),
  /** Null only where an informational finding has nothing to act on. */
  remediation: remediation.nullable(),
});
export type DnsValidationIssue = z.infer<typeof dnsValidationIssue>;

export const dnsValidationResult = z.object({
  domain_id: uuid,
  domain_name: z.string(),
  checked_at: isoDate,
  issues: z.array(dnsValidationIssue).default([]),
});
export type DnsValidationResult = z.infer<typeof dnsValidationResult>;

export const syncDnsInput = z.object({
  domain_id: uuid,
  /** Take ownership of provider-side records instead of reporting them as external. */
  adopt_unmanaged: z.boolean().default(false),
});
export type SyncDnsInput = z.infer<typeof syncDnsInput>;

/** One entry of a bulk apply. Omit `id` to create, supply it to update. */
export const dnsRecordDraft = z.object({
  id: uuid.optional(),
  type: dnsRecordType,
  name: z.string().min(1).max(253),
  content: z.string().min(1).max(2048),
  ttl: z.number().int().min(0).max(604800).default(3600),
  priority: z.number().int().min(0).max(65535).optional(),
  proxied: z.boolean().default(false),
});
export type DnsRecordDraft = z.infer<typeof dnsRecordDraft>;

export const applyDnsInput = z.object({
  domain_id: uuid,
  records: z.array(dnsRecordDraft).max(1000).default([]),
  delete_ids: z.array(uuid).max(1000).default([]),
  /** Refuse the whole apply if any targeted record drifted since it was read. */
  fail_on_drift: z.boolean().default(true),
});
export type ApplyDnsInput = z.infer<typeof applyDnsInput>;

/* ------------------------------------------------------------------ *
 * Certificates
 * ------------------------------------------------------------------ */

/** Not in ../enums.js: only the ACME surface names key types. */
export const certKeyType = z.enum(["ecdsa", "rsa"]);
export type CertKeyType = z.infer<typeof certKeyType>;

export const certificate = z.object({
  id: uuid,
  domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  subject: z.string(),
  sans: z.array(z.string()).default([]),
  issuer: z.string(),
  challenge: certChallenge,
  key_type: certKeyType,
  status: certStatus,
  issued_at: isoDate.nullable(),
  expires_at: isoDate.nullable(),
  /** Precomputed so every list can call `certificateUrgency` without date math. */
  days_remaining: z.number().int().nullable(),
  auto_renew: z.boolean(),
  last_renewal_at: isoDate.nullable(),
  /** Carries its own remediation: a failed renewal is the operator's problem to fix. */
  last_error: z
    .object({
      code: z.string(),
      message: z.string(),
      at: isoDate,
      remediation: remediation.nullable(),
    })
    .nullable(),
  installed_path: z.string().nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type Certificate = z.infer<typeof certificate>;

export const issueCertificateInput = z.object({
  domain_id: uuid,
  server_id: uuid,
  /** Extra names on the certificate; the domain itself is always the subject. */
  sans: z.array(domainName).max(99).default([]),
  challenge: certChallenge.default("http-01"),
  key_type: certKeyType.default("ecdsa"),
  contact_email: emailAddress,
  auto_renew: z.boolean().default(true),
  /** Rehearse against the ACME staging directory without spending rate limit. */
  staging: z.boolean().default(false),
});
export type IssueCertificateInput = z.infer<typeof issueCertificateInput>;

export const renewCertificateInput = z.object({
  /** Renew even though the certificate is not yet inside its renewal window. */
  force: z.boolean().default(false),
});
export type RenewCertificateInput = z.infer<typeof renewCertificateInput>;

/** Everything else about a certificate comes from ACME, not from the operator. */
export const updateCertificateInput = z.object({ auto_renew: z.boolean() }).partial();
export type UpdateCertificateInput = z.infer<typeof updateCertificateInput>;

export const certificateListQuery = listQuery.extend({
  server_id: uuid.optional(),
  domain_id: uuid.optional(),
  status: certStatus.optional(),
  auto_renew: z.coerce.boolean().optional(),
  expiring_within_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type CertificateListQuery = z.infer<typeof certificateListQuery>;

export type CertificateUrgency = "ok" | "soon" | "urgent" | "expired";

/** ACME clients renew at 30 days, so anything inside that window is in progress. */
export const CERT_EXPIRY_SOON_DAYS = 30;
/** Inside a week, a renewal that keeps failing is an outage with a date on it. */
export const CERT_EXPIRY_URGENT_DAYS = 7;

/**
 * The single expiry threshold set. The dashboard, the SSL list and the site
 * detail page must never disagree about what "expiring" means.
 */
export function certificateUrgency(daysRemaining: number): CertificateUrgency {
  if (daysRemaining <= 0) return "expired";
  if (daysRemaining <= CERT_EXPIRY_URGENT_DAYS) return "urgent";
  if (daysRemaining <= CERT_EXPIRY_SOON_DAYS) return "soon";
  return "ok";
}

/* ------------------------------------------------------------------ *
 * Deployments
 * ------------------------------------------------------------------ */

export const deploymentSource = z.enum(["git", "upload"]);
export type DeploymentSource = z.infer<typeof deploymentSource>;

export const deployment = z.object({
  id: uuid,
  site_id: uuid,
  site_name: z.string(),
  source: deploymentSource,
  repo_url: z.string().nullable(),
  branch: z.string().nullable(),
  commit_sha: z.string().nullable(),
  commit_message: z.string().nullable(),
  commit_author: z.string().nullable(),
  status: deploymentStatus,
  started_at: isoDate.nullable(),
  finished_at: isoDate.nullable(),
  duration_ms: z.number().int().nullable(),
  /** Null when a webhook or a schedule triggered the run rather than a person. */
  triggered_by: uuid.nullable(),
  triggered_by_name: z.string().nullable(),
  job_id: uuid.nullable(),
  /** False once the run's log has aged out of retention. */
  log_available: z.boolean(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type Deployment = z.infer<typeof deployment>;

export const triggerDeploymentInput = z.object({
  site_id: uuid,
  source: deploymentSource.default("git"),
  repo_url: z.string().max(512).optional(),
  branch: z.string().max(200).optional(),
  /** Pin the run to one revision; omit to take the branch head. */
  commit_sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "must be a git object id")
    .optional(),
  /** Deploy even when the site already runs this revision. */
  force: z.boolean().default(false),
});
export type TriggerDeploymentInput = z.infer<typeof triggerDeploymentInput>;

export const deploymentListQuery = listQuery.extend({
  site_id: uuid.optional(),
  server_id: uuid.optional(),
  status: deploymentStatus.optional(),
  source: deploymentSource.optional(),
  branch: z.string().max(200).optional(),
});
export type DeploymentListQuery = z.infer<typeof deploymentListQuery>;
