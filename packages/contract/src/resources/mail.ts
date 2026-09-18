import { z } from "zod";
import {
  bytes,
  domainName,
  emailAddress,
  ipAddress,
  isoDate,
  listQuery,
  percent,
  remediation,
  uuid,
} from "../primitives.js";
import { checkStatus, mailAuthCheck, mailDeliveryStatus } from "../enums.js";
import type { MailAuthCheck } from "../enums.js";

/** enums.ts has no mail lifecycle status; siteStatus is a websites concept. */
export const mailStatus = z.enum(["active", "provisioning", "suspended", "error"]);
export type MailStatus = z.infer<typeof mailStatus>;

/** Long because a mailbox credential is pasted into a client once and then lives for years. */
const mailPassword = z.string().min(16).max(256);

/**
 * Dovecot and Postfix match addresses case-insensitively, so the panel
 * folds them at the boundary: two rows differing only in case would be
 * one account on the host, and the second create would fail there.
 */
const lowerEmail = emailAddress.transform((value) => value.toLowerCase());

/* ------------------------------------------------------------------ *
 * Mail domains
 * ------------------------------------------------------------------ */

export const mailAuthSummary = z.object({
  pass: z.number().int().nonnegative(),
  warn: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  /** Worst status across the checks — what the domain row's badge shows. */
  worst: checkStatus,
  checked_at: isoDate.nullable(),
});
export type MailAuthSummary = z.infer<typeof mailAuthSummary>;

export const mailDomain = z.object({
  id: uuid,
  domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  status: mailStatus,
  dkim_selector: z.string(),
  dkim_public_key: z.string().nullable(),
  catchall_target: emailAddress.nullable(),
  mailbox_count: z.number().int().nonnegative(),
  alias_count: z.number().int().nonnegative(),
  forwarder_count: z.number().int().nonnegative(),
  quota_used: bytes,
  quota_total: bytes,
  auth_summary: mailAuthSummary,
  created_at: isoDate,
  updated_at: isoDate,
});
export type MailDomain = z.infer<typeof mailDomain>;

export const createMailDomainInput = z.object({
  domain_id: uuid,
  server_id: uuid,
  dkim_selector: z.string().min(1).max(63).default("kaname"),
  catchall_target: emailAddress.optional(),
});
export type CreateMailDomainInput = z.infer<typeof createMailDomainInput>;

/** The domain and its host are fixed once provisioned; moving mail is a migration, not an edit. */
export const updateMailDomainInput = createMailDomainInput
  .omit({ domain_id: true, server_id: true })
  .partial()
  .extend({ status: mailStatus.optional() });
export type UpdateMailDomainInput = z.infer<typeof updateMailDomainInput>;

export const mailDomainListQuery = listQuery.extend({
  server_id: uuid.optional(),
  status: mailStatus.optional(),
  auth_status: checkStatus.optional(),
});
export type MailDomainListQuery = z.infer<typeof mailDomainListQuery>;

/* ------------------------------------------------------------------ *
 * Mailboxes
 * ------------------------------------------------------------------ */

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
  used_bytes: bytes,
  used_percent: percent,
  status: mailStatus,
  message_count: z.number().int().nonnegative(),
  last_login_at: isoDate.nullable(),
  /** Usage and login come from the host, so their staleness is surfaced (KD-012). */
  last_synced_at: isoDate,
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
  password: mailPassword,
  display_name: z.string().max(128).optional(),
  quota_bytes: bytes.default(0),
});
export type CreateMailboxInput = z.infer<typeof createMailboxInput>;

/** The address is the mailbox's identity on the host; renaming one is a create plus a migration. */
export const updateMailboxInput = createMailboxInput
  .omit({ mail_domain_id: true, local_part: true, password: true })
  .partial()
  .extend({ status: mailStatus.optional() });
export type UpdateMailboxInput = z.infer<typeof updateMailboxInput>;

export const resetMailboxPasswordInput = z.object({
  password: mailPassword,
  /** Kills active IMAP/POP sessions so a compromised client cannot keep reading. */
  revoke_sessions: z.boolean().default(true),
});
export type ResetMailboxPasswordInput = z.infer<typeof resetMailboxPasswordInput>;

export const mailboxListQuery = listQuery.extend({
  mail_domain_id: uuid.optional(),
  domain: domainName.optional(),
  server_id: uuid.optional(),
  status: mailStatus.optional(),
  over_quota: z.coerce.boolean().optional(),
});
export type MailboxListQuery = z.infer<typeof mailboxListQuery>;

/* ------------------------------------------------------------------ *
 * Aliases and forwarders
 * ------------------------------------------------------------------ */

export const mailAlias = z.object({
  id: uuid,
  mail_domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  address: emailAddress,
  destinations: z.array(emailAddress).min(1),
  enabled: z.boolean(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type MailAlias = z.infer<typeof mailAlias>;

export const createMailAliasInput = z.object({
  mail_domain_id: uuid,
  address: lowerEmail,
  destinations: z.array(lowerEmail).min(1).max(100),
  enabled: z.boolean().default(true),
});
export type CreateMailAliasInput = z.infer<typeof createMailAliasInput>;

export const updateMailAliasInput = createMailAliasInput.omit({ mail_domain_id: true }).partial();
export type UpdateMailAliasInput = z.infer<typeof updateMailAliasInput>;

export const mailAliasListQuery = listQuery.extend({
  mail_domain_id: uuid.optional(),
  domain: domainName.optional(),
  server_id: uuid.optional(),
  enabled: z.coerce.boolean().optional(),
});
export type MailAliasListQuery = z.infer<typeof mailAliasListQuery>;

export const mailForwarder = z.object({
  id: uuid,
  mail_domain_id: uuid,
  domain_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  source: emailAddress,
  destination: emailAddress,
  keep_copy: z.boolean(),
  enabled: z.boolean(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type MailForwarder = z.infer<typeof mailForwarder>;

export const createMailForwarderInput = z.object({
  mail_domain_id: uuid,
  source: lowerEmail,
  destination: lowerEmail,
  keep_copy: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type CreateMailForwarderInput = z.infer<typeof createMailForwarderInput>;

export const updateMailForwarderInput = createMailForwarderInput
  .omit({ mail_domain_id: true })
  .partial();
export type UpdateMailForwarderInput = z.infer<typeof updateMailForwarderInput>;

export const mailForwarderListQuery = listQuery.extend({
  mail_domain_id: uuid.optional(),
  domain: domainName.optional(),
  server_id: uuid.optional(),
  enabled: z.coerce.boolean().optional(),
});
export type MailForwarderListQuery = z.infer<typeof mailForwarderListQuery>;

/* ------------------------------------------------------------------ *
 * DNS authentication
 *
 * This is where real mail setups break, so every failure carries a
 * remediation the operator can act on instead of a record dump.
 * ------------------------------------------------------------------ */

export const mailAuthCheckResult = z.object({
  id: uuid,
  mail_domain_id: uuid,
  check: mailAuthCheck,
  status: checkStatus,
  title: z.string(),
  detail: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  remediation: remediation.nullable(),
  checked_at: isoDate,
  duration_ms: z.number().int().nonnegative(),
});
export type MailAuthCheckResult = z.infer<typeof mailAuthCheckResult>;

export const mailAuthReport = z.object({
  mail_domain_id: uuid,
  domain_name: z.string(),
  overall: checkStatus,
  checks: z.array(mailAuthCheckResult),
  checked_at: isoDate,
  /** Named so a disagreement with the operator's own resolver can be explained. */
  resolver_used: z.string(),
});
export type MailAuthReport = z.infer<typeof mailAuthReport>;

export const mailAuthQuery = z.object({
  mail_domain_id: uuid,
  refresh: z.coerce.boolean().default(false),
});
export type MailAuthQuery = z.infer<typeof mailAuthQuery>;

export const runMailAuthCheckInput = z.object({
  mail_domain_id: uuid,
  /** Omit to run the whole list. */
  checks: z.array(mailAuthCheck).min(1).optional(),
  /** A nameserver address to ask instead of the host's own resolver. */
  resolver: ipAddress.optional(),
});
export type RunMailAuthCheckInput = z.infer<typeof runMailAuthCheckInput>;

export const MAIL_AUTH_CHECK_META: Record<MailAuthCheck, { title: string; why: string }> = {
  mx: {
    title: "MX records",
    why: "Inbound mail is delivered to whatever the MX names, so a missing MX — or one pointing at a host with no A record — silently sends every message somewhere else or bounces it.",
  },
  host_spf: {
    title: "Mail host SPF",
    why: "Bounces and delivery-status notifications are sent from the mail hostname itself, and receivers check that hostname's own SPF record, not the domain's, when deciding whether to accept them.",
  },
  spf: {
    title: "SPF",
    why: "SPF is what tells receivers which hosts may send as this domain; missing, duplicated, or permissive records mean either your own mail lands in spam or anyone can spoof you.",
  },
  dkim: {
    title: "DKIM",
    why: "Outbound mail is signed with the key on the host, so a selector that is absent, mismatched, or under 1024-bit makes every signed message fail verification at the receiver.",
  },
  dmarc: {
    title: "DMARC",
    why: "DMARC decides what a receiver does when SPF and DKIM fail and where the reports go, so without it you get neither enforcement against spoofing nor visibility into it.",
  },
  ptr: {
    title: "Reverse DNS (PTR)",
    why: "Large providers throttle or reject mail from an IP whose PTR is missing or disagrees with the HELO name, and this is the one record that must be set at the hosting provider.",
  },
  tls: {
    title: "STARTTLS",
    why: "Receivers increasingly require an encrypted session presenting a certificate that covers the HELO name; without one, mail is downgraded, deferred, or refused outright.",
  },
  proxy_exposure: {
    title: "Proxy exposure",
    why: "A proxied or wildcard DNS record (Cloudflare's orange cloud) only forwards HTTP, so SMTP to a proxied mail hostname never reaches the server and the proxy's addresses hide the real sending IP from SPF — the mail hostname must be set DNS-only and carry its own SPF TXT record separate from the apex.",
  },
};

/* ------------------------------------------------------------------ *
 * Mail logs
 * ------------------------------------------------------------------ */

export const mailDirection = z.enum(["inbound", "outbound"]);
export type MailDirection = z.infer<typeof mailDirection>;

export const mailLogEntry = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  ts: isoDate,
  queue_id: z.string(),
  direction: mailDirection,
  /** Envelope sender, not a strict address: bounces arrive with "<>". */
  from: z.string(),
  to: z.array(z.string()).min(1),
  subject: z.string().nullable(),
  status: mailDeliveryStatus,
  relay: z.string().nullable(),
  delay_seconds: z.number().nonnegative(),
  size_bytes: bytes,
  dsn: z.string().nullable(),
  message: z.string(),
});
export type MailLogEntry = z.infer<typeof mailLogEntry>;

export const mailLogListQuery = listQuery.extend({
  server_id: uuid.optional(),
  mail_domain_id: uuid.optional(),
  direction: mailDirection.optional(),
  status: mailDeliveryStatus.optional(),
  queue_id: z.string().max(64).optional(),
  address: z.string().max(320).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
});
export type MailLogListQuery = z.infer<typeof mailLogListQuery>;
