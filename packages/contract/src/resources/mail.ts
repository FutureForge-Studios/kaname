import { z } from "zod";
import { bytes, domainName, emailAddress, isoDate, listQuery, uuid } from "../primitives.js";
import { mailCheckStatus, mailRelayProvider, mailSendingMode, mailServerStatus } from "../enums.js";
import {
  mailCertificateStatus,
  mailCheck,
  mailDnsRecord,
  mailInstallStep,
  mailServiceState,
} from "../agent/payloads.js";

/* ------------------------------------------------------------------ *
 * Email — Yunori Mail Server (KD-023).
 *
 * Kaname does not run a mail stack of its own. A managed host runs
 * Yunori Mail Server (`yunori-mail` driving an unmodified Stalwart), and
 * Kaname deploys it, shows what it says and sends it the mutations an
 * operator asks for. Domains, mailboxes and aliases are rows here so the
 * fleet view can count and search them; the host is authoritative and a
 * sync re-reads it.
 *
 * Mailbox credentials are generated on the host and handed back exactly
 * once. The create and reset calls are therefore synchronous (KD-024):
 * the password crosses one HTTPS response and is never persisted, not
 * even in a job result.
 * ------------------------------------------------------------------ */

export { mailCheck, mailDnsRecord, mailInstallStep, mailServiceState, mailCertificateStatus };

/* ------------------------------ servers ------------------------------ */

export const mailRelayInput = z.object({
  provider: mailRelayProvider,
  /** Ignored for providers whose host follows the region (Amazon SES). */
  host: z.string().max(253).optional(),
  region: z.string().max(64).optional(),
  port: z.number().int().min(1).max(65535).default(587),
  /** Empty = the provider's fixed username (Resend). */
  username: z.string().max(320).optional(),
  /** Write-only: travels to the host once and is never stored by Kaname. */
  password: z.string().min(1).max(1024).optional(),
});
export type MailRelayInput = z.infer<typeof mailRelayInput>;

export const mailServer = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  /** Kaname's view of the lifecycle; `install_complete` is the host's. */
  status: mailServerStatus,
  version: z.string().nullable(),
  install_complete: z.boolean(),
  hostname: z.string().nullable(),
  primary_domain: z.string().nullable(),
  admin_email: z.string().nullable(),
  sending_mode: mailSendingMode.nullable(),
  relay_provider: mailRelayProvider.nullable(),
  console_url: z.string().nullable(),
  steps: z.array(mailInstallStep),
  services: z.array(mailServiceState),
  /** Last `yunori-mail doctor` run, when there was one. */
  checks: z.array(mailCheck),
  /** Worst status across the last doctor run. */
  health: mailCheckStatus,
  certificate: mailCertificateStatus.nullable(),
  domain_count: z.number().int().nonnegative(),
  mailbox_count: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  /** When the host was last read (KD-012: staleness is shown, not hidden). */
  last_synced_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type MailServer = z.infer<typeof mailServer>;

export const deployMailServerInput = z.object({
  server_id: uuid,
  /** The Kaname domain that becomes the primary mail domain. */
  domain_id: uuid,
  /** Defaults to mail.<domain>. */
  hostname: domainName.optional(),
  /** On ANOTHER provider: it receives certificate and alert mail about this server. */
  admin_email: emailAddress,
  first_mailbox: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._%+-]+$/, "must be a valid local part")
    .transform((value) => value.toLowerCase())
    .default("hello"),
  sending: mailSendingMode.default("direct"),
  relay: mailRelayInput.optional(),
  /** Pin a yunori-mail release instead of the newest one the control plane knows. */
  version: z.string().max(64).optional(),
  force: z.boolean().default(false),
  skip_ptr: z.boolean().default(false),
});
export type DeployMailServerInput = z.infer<typeof deployMailServerInput>;

/** Records a Yunori Mail Server that was installed by hand, so Kaname manages it from here. */
export const adoptMailServerInput = z.object({
  server_id: uuid,
  hostname: domainName.optional(),
  admin_email: emailAddress.optional(),
});
export type AdoptMailServerInput = z.infer<typeof adoptMailServerInput>;

export const mailServerListQuery = listQuery.extend({
  status: mailServerStatus.optional(),
  health: mailCheckStatus.optional(),
});
export type MailServerListQuery = z.infer<typeof mailServerListQuery>;

/** What `mail.deploy` handed back once, surfaced on the job for the operator. */
export const mailDeploySecrets = z.object({
  setup_url: z.string().nullable(),
  first_mailbox: z.string().nullable(),
  first_mailbox_password: z.string().nullable(),
});
export type MailDeploySecrets = z.infer<typeof mailDeploySecrets>;

/* ------------------------------ domains ------------------------------ */

export const mailDomainStatus = z.enum(["active", "provisioning", "removing", "error"]);
export type MailDomainStatus = z.infer<typeof mailDomainStatus>;

export const mailDomain = z.object({
  id: uuid,
  domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  mail_server_id: uuid,
  /** Whether this is the domain the server was installed with. */
  is_primary: z.boolean(),
  status: mailDomainStatus,
  dns_status: mailCheckStatus,
  dns_checked_at: isoDate.nullable(),
  mailbox_count: z.number().int().nonnegative(),
  alias_count: z.number().int().nonnegative(),
  last_synced_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type MailDomain = z.infer<typeof mailDomain>;

export const createMailDomainInput = z.object({
  domain_id: uuid,
  server_id: uuid,
});
export type CreateMailDomainInput = z.infer<typeof createMailDomainInput>;

export const mailDomainListQuery = listQuery.extend({
  server_id: uuid.optional(),
  status: mailDomainStatus.optional(),
  dns_status: mailCheckStatus.optional(),
});
export type MailDomainListQuery = z.infer<typeof mailDomainListQuery>;

export const mailDnsReport = z.object({
  mail_domain_id: uuid,
  domain_name: z.string(),
  overall: mailCheckStatus,
  records: z.array(mailDnsRecord),
  /** BIND-style zone data for "copy all". */
  zone_file: z.string(),
  checked_at: isoDate.nullable(),
});
export type MailDnsReport = z.infer<typeof mailDnsReport>;

/* ----------------------------- mailboxes ----------------------------- */

export const mailboxStatus = z.enum(["active", "removing", "error"]);
export type MailboxStatus = z.infer<typeof mailboxStatus>;

export const mailbox = z.object({
  id: uuid,
  mail_domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  address: emailAddress,
  local_part: z.string(),
  display_name: z.string().nullable(),
  /** 0 means unlimited. */
  quota_bytes: bytes,
  status: mailboxStatus,
  aliases: z.array(z.string()),
  last_synced_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type Mailbox = z.infer<typeof mailbox>;

export const createMailboxInput = z.object({
  mail_domain_id: uuid,
  local_part: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._%+-]+$/, "must be a valid local part")
    .transform((value) => value.toLowerCase()),
  display_name: z.string().max(128).optional(),
  /** Omit or 0 for unlimited. */
  quota_mb: z.number().int().nonnegative().default(0),
});
export type CreateMailboxInput = z.infer<typeof createMailboxInput>;

/** The one response in the product that carries a credential. Shown once. */
export const mailboxCredential = z.object({
  mailbox,
  password: z.string(),
});
export type MailboxCredential = z.infer<typeof mailboxCredential>;

export const mailboxListQuery = listQuery.extend({
  mail_domain_id: uuid.optional(),
  domain: domainName.optional(),
  server_id: uuid.optional(),
  status: mailboxStatus.optional(),
});
export type MailboxListQuery = z.infer<typeof mailboxListQuery>;

/* ------------------------------ aliases ------------------------------ */

export const mailAlias = z.object({
  id: uuid,
  mail_domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  address: emailAddress,
  mailbox_id: uuid.nullable(),
  mailbox_address: emailAddress,
  status: mailboxStatus,
  created_at: isoDate,
  updated_at: isoDate,
});
export type MailAlias = z.infer<typeof mailAlias>;

export const createMailAliasInput = z.object({
  mail_domain_id: uuid,
  local_part: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._%+-]+$/, "must be a valid local part")
    .transform((value) => value.toLowerCase()),
  mailbox_id: uuid,
});
export type CreateMailAliasInput = z.infer<typeof createMailAliasInput>;

export const mailAliasListQuery = listQuery.extend({
  mail_domain_id: uuid.optional(),
  domain: domainName.optional(),
  server_id: uuid.optional(),
  mailbox_id: uuid.optional(),
});
export type MailAliasListQuery = z.infer<typeof mailAliasListQuery>;

/* ------------------------------- logs -------------------------------- */

export const mailLogTailQuery = z.object({
  server_id: uuid,
  q: z.string().max(200).optional(),
  lines: z.coerce.number().int().min(1).max(5000).default(200),
});
export type MailLogTailQuery = z.infer<typeof mailLogTailQuery>;

/* ---------------------------- release feed --------------------------- */

/** A yunori-mail release the control plane can hand to `mail.deploy`. */
export const mailRelease = z.object({
  version: z.string(),
  /** Archive URL per CPU architecture. */
  assets: z.record(z.enum(["amd64", "arm64"]), z.object({ url: z.string().url(), sha256: z.string() })),
  published_at: isoDate.nullable(),
  notes_url: z.string().nullable(),
});
export type MailRelease = z.infer<typeof mailRelease>;
