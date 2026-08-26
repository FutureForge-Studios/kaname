import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CertStatus,
  DeploymentStatus,
  DnsProvider,
  DnsRecordType,
  SiteRuntime,
} from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { users } from "./identity";
import { jobs } from "./platform";

/* ------------------------------------------------------------------ *
 * Sites
 * ------------------------------------------------------------------ */

export const sites = pgTable(
  "sites",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    webroot: text("webroot").notNull(),
    runtime: text("runtime").$type<SiteRuntime>().notNull().default("static"),
    runtimeVersion: text("runtime_version"),
    /** Set for runtime = proxy or container. */
    upstream: text("upstream"),
    status: text("status", { enum: ["active", "suspended", "provisioning", "error"] })
      .notNull()
      .default("provisioning"),
    forceHttps: boolean("force_https").notNull().default(true),
    configPath: text("config_path"),
    owner: text("owner"),
    /** Denormalised: the domain shown as the site's identity in lists. */
    primaryDomainId: uuid("primary_domain_id"),
    diskUsage: bigint("disk_usage", { mode: "number" }),
    lastError: text("last_error"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Deploy configuration lives with the site, not the deployment. */
    repoUrl: text("repo_url"),
    branch: text("branch"),
    buildCommand: text("build_command"),
    outputDir: text("output_dir"),
    deployKeyRef: text("deploy_key_ref"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sites_server_name_key").on(t.serverId, t.name),
    index("sites_status_idx").on(t.status),
  ],
);

/* ------------------------------------------------------------------ *
 * Domains and DNS
 * ------------------------------------------------------------------ */

export const domains = pgTable(
  "domains",
  {
    id: pk(),
    name: text("name").notNull(),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    dnsProvider: text("dns_provider").$type<DnsProvider>().notNull().default("manual"),
    dnsZoneId: text("dns_zone_id"),
    /** Whether the apex sits behind a CDN proxy. Drives the mail proxy_exposure check. */
    proxied: boolean("proxied").notNull().default(false),
    status: text("status", { enum: ["active", "pending", "error", "disabled"] })
      .notNull()
      .default("pending"),
    registrar: text("registrar"),
    expiresAt: ts("expires_at"),
    nameservers: text("nameservers")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    verified: boolean("verified").notNull().default(false),
    verificationMethod: text("verification_method"),
    verifiedAt: ts("verified_at"),
    hasMail: boolean("has_mail").notNull().default(false),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("domains_name_key").on(t.name), index("domains_site_idx").on(t.siteId)],
);

export const dnsRecords = pgTable(
  "dns_records",
  {
    id: pk(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    type: text("type").$type<DnsRecordType>().notNull(),
    name: text("name").notNull(),
    content: text("content").notNull(),
    ttl: integer("ttl").notNull().default(300),
    priority: integer("priority"),
    proxied: boolean("proxied").notNull().default(false),
    managedBy: text("managed_by", { enum: ["kaname", "external"] })
      .notNull()
      .default("kaname"),
    externalId: text("external_id"),
    /** Non-null when the provider's copy diverged from ours. */
    drift: jsonb("drift").$type<{ expected: string; actual: string; detected_at: string } | null>(),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [
    index("dns_records_domain_idx").on(t.domainId),
    uniqueIndex("dns_records_unique").on(t.domainId, t.type, t.name, t.content),
  ],
);

/* ------------------------------------------------------------------ *
 * Certificates
 * ------------------------------------------------------------------ */

export const certificates = pgTable(
  "certificates",
  {
    id: pk(),
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    sans: text("sans")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    issuer: text("issuer").notNull().default("Let's Encrypt"),
    challenge: text("challenge", { enum: ["http-01", "dns-01"] })
      .notNull()
      .default("http-01"),
    keyType: text("key_type", { enum: ["ecdsa", "rsa"] })
      .notNull()
      .default("ecdsa"),
    status: text("status").$type<CertStatus>().notNull().default("none"),
    issuedAt: ts("issued_at"),
    expiresAt: ts("expires_at"),
    autoRenew: boolean("auto_renew").notNull().default(true),
    lastRenewalAt: ts("last_renewal_at"),
    lastRenewalJobId: uuid("last_renewal_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    lastError: text("last_error"),
    installedPath: text("installed_path"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("certificates_server_subject_key").on(t.serverId, t.subject),
    index("certificates_expiry_idx").on(t.expiresAt),
  ],
);

/* ------------------------------------------------------------------ *
 * Deployments
 * ------------------------------------------------------------------ */

export const deployments = pgTable(
  "deployments",
  {
    id: pk(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["git", "upload"] })
      .notNull()
      .default("git"),
    repoUrl: text("repo_url"),
    branch: text("branch"),
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),
    status: text("status").$type<DeploymentStatus>().notNull().default("queued"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    triggeredBy: uuid("triggered_by").references(() => users.id, { onDelete: "set null" }),
    triggeredByName: text("triggered_by_name"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** The release directory kept for rollback. */
    releasePath: text("release_path"),
    supersededBy: uuid("superseded_by"),
    ...timestamps,
  },
  (t) => [
    index("deployments_site_idx").on(t.siteId, t.createdAt),
    index("deployments_status_idx").on(t.status),
  ],
);

/* ---------------------------- relations ---------------------------- */

export const sitesRelations = relations(sites, ({ one, many }) => ({
  server: one(servers, { fields: [sites.serverId], references: [servers.id] }),
  domains: many(domains),
  deployments: many(deployments),
}));

export const domainsRelations = relations(domains, ({ one, many }) => ({
  site: one(sites, { fields: [domains.siteId], references: [sites.id] }),
  records: many(dnsRecords),
  certificates: many(certificates),
}));

export const dnsRecordsRelations = relations(dnsRecords, ({ one }) => ({
  domain: one(domains, { fields: [dnsRecords.domainId], references: [domains.id] }),
}));

export const certificatesRelations = relations(certificates, ({ one }) => ({
  domain: one(domains, { fields: [certificates.domainId], references: [domains.id] }),
  server: one(servers, { fields: [certificates.serverId], references: [servers.id] }),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  site: one(sites, { fields: [deployments.siteId], references: [sites.id] }),
}));
