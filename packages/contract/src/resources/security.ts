import { z } from "zod";
import { cidr, identifier, ipAddress, isoDate, listQuery, port, uuid } from "../primitives.js";
import {
  auditActorType,
  firewallAction,
  firewallDirection,
  firewallProtocol,
  managedBy,
  threatDisposition,
  threatKind,
  timeRange,
} from "../enums.js";

/* ------------------------------------------------------------------ *
 * Firewall
 * ------------------------------------------------------------------ */

/** "22", "80,443" or "3000-4000". The agent revalidates against its backend. */
export const portSpec = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/,
    "must be a port, a comma-separated list, or a range",
  );
export type PortSpec = z.infer<typeof portSpec>;

export const firewallBackend = z.enum(["nftables", "iptables", "ufw"]);
export type FirewallBackend = z.infer<typeof firewallBackend>;

export const firewallRule = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  priority: z.number().int(),
  action: firewallAction,
  direction: firewallDirection,
  protocol: firewallProtocol,
  port_spec: portSpec.nullable(),
  source_cidr: cidr.nullable(),
  dest_cidr: cidr.nullable(),
  comment: z.string().nullable(),
  enabled: z.boolean(),
  managed_by: managedBy,
  /** Null when the backend does not expose counters, which is not the same as zero. */
  hit_count: z.number().int().nonnegative().nullable(),
  /** How stale this row is. Surfaced in the UI, never hidden (KD-012). */
  last_synced_at: isoDate,
  created_at: isoDate,
  updated_at: isoDate,
});
export type FirewallRule = z.infer<typeof firewallRule>;

export const createFirewallRuleInput = z.object({
  server_id: uuid,
  priority: z.number().int().min(0).max(65535).default(100),
  action: firewallAction,
  direction: firewallDirection.default("inbound"),
  protocol: firewallProtocol.default("tcp"),
  port_spec: portSpec.optional(),
  source_cidr: cidr.optional(),
  dest_cidr: cidr.optional(),
  comment: z.string().max(200).optional(),
  enabled: z.boolean().default(true),
});
export type CreateFirewallRuleInput = z.infer<typeof createFirewallRuleInput>;

export const updateFirewallRuleInput = createFirewallRuleInput.omit({ server_id: true }).partial();
export type UpdateFirewallRuleInput = z.infer<typeof updateFirewallRuleInput>;

export const firewallRuleListQuery = listQuery.extend({
  server_id: uuid.optional(),
  action: firewallAction.optional(),
  direction: firewallDirection.optional(),
  protocol: firewallProtocol.optional(),
  managed_by: managedBy.optional(),
  enabled: z.coerce.boolean().optional(),
});
export type FirewallRuleListQuery = z.infer<typeof firewallRuleListQuery>;

/**
 * A chain's default policy, which is not the same set as a rule action:
 * "reject" sends an ICMP refusal and only makes sense per rule. The
 * agent's fw.apply params enforce the same distinction.
 */
export const firewallPolicy = z.enum(["allow", "deny"]);
export type FirewallPolicy = z.infer<typeof firewallPolicy>;

export const firewallStatus = z.object({
  server_id: uuid,
  server_name: z.string(),
  backend: firewallBackend,
  enabled: z.boolean(),
  default_inbound: firewallPolicy,
  default_outbound: firewallPolicy,
  rule_count: z.number().int().nonnegative(),
  last_applied_at: isoDate.nullable(),
  /** Rules edited in the panel that the host has not been given yet. */
  pending_changes: z.number().int().nonnegative(),
  last_synced_at: isoDate,
});
export type FirewallStatus = z.infer<typeof firewallStatus>;

export const applyFirewallInput = z.object({
  server_id: uuid,
  rules: z.array(createFirewallRuleInput.omit({ server_id: true })).max(500),
  default_inbound: firewallPolicy.default("deny"),
  default_outbound: firewallPolicy.default("allow"),
  /**
   * Revert the whole set unless it is confirmed within this window. This is the
   * lockout guard: an operator who firewalls off their own SSH gets it back.
   */
  rollback_seconds: z.number().int().min(0).max(300).default(60),
});
export type ApplyFirewallInput = z.infer<typeof applyFirewallInput>;

/* ------------------------------------------------------------------ *
 * Threat protection
 * ------------------------------------------------------------------ */

export const threatEvent = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  kind: threatKind,
  source_ip: ipAddress,
  /** ISO 3166-1 alpha-2, null when geolocation is unavailable or disabled. */
  source_country: z.string().length(2).nullable(),
  source_asn: z.string().max(64).nullable(),
  target: z.string(),
  attempts: z.number().int().positive(),
  first_seen: isoDate,
  last_seen: isoDate,
  disposition: threatDisposition,
  /** One representative log line, truncated by the agent. */
  sample: z.string().max(1000).nullable(),
  last_synced_at: isoDate,
  created_at: isoDate,
  updated_at: isoDate,
});
export type ThreatEvent = z.infer<typeof threatEvent>;

export const threatEventListQuery = listQuery.extend({
  server_id: uuid.optional(),
  kind: threatKind.optional(),
  disposition: threatDisposition.optional(),
  source_ip: ipAddress.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ThreatEventListQuery = z.infer<typeof threatEventListQuery>;

/**
 * Counts over a window, nothing else. There is no score, no streak and no
 * "attacks blocked" hero number: background SSH scanning is weather, and a
 * page that dramatises it trains the operator to ignore the day it matters.
 */
export const threatSummary = z.object({
  window: timeRange,
  total_attempts: z.number().int().nonnegative(),
  unique_sources: z.number().int().nonnegative(),
  banned_count: z.number().int().nonnegative(),
  by_kind: z.array(z.object({ kind: threatKind, count: z.number().int().nonnegative() })),
  top_sources: z.array(
    z.object({
      ip: ipAddress,
      country: z.string().length(2).nullable(),
      attempts: z.number().int().nonnegative(),
      kind: threatKind,
      banned: z.boolean(),
    }),
  ),
  timeline: z.array(
    z.object({
      ts: isoDate,
      attempts: z.number().int().nonnegative(),
      banned: z.number().int().nonnegative(),
    }),
  ),
});
export type ThreatSummary = z.infer<typeof threatSummary>;

export const threatSummaryQuery = z.object({
  window: timeRange.default("24h"),
  server_id: uuid.optional(),
});
export type ThreatSummaryQuery = z.infer<typeof threatSummaryQuery>;

export const ipBlockSource = z.enum(["manual", "fail2ban", "rule"]);
export type IpBlockSource = z.infer<typeof ipBlockSource>;

export const ipBlock = z.object({
  id: uuid,
  /** Null means the block applies to every server in the fleet. */
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  /** Single addresses are normalised to /32 or /128 so one column covers both. */
  cidr,
  reason: z.string(),
  source: ipBlockSource,
  expires_at: isoDate.nullable(),
  created_by: uuid.nullable(),
  created_at: isoDate,
});
export type IpBlock = z.infer<typeof ipBlock>;

export const createIpBlockInput = z.object({
  server_id: uuid.nullable().default(null),
  target: cidr.or(ipAddress),
  reason: z.string().min(1).max(200),
  /** Zero is permanent. */
  duration_seconds: z.number().int().min(0).max(31536000).default(0),
});
export type CreateIpBlockInput = z.infer<typeof createIpBlockInput>;

export const updateIpBlockInput = createIpBlockInput
  .omit({ server_id: true, target: true })
  .partial();
export type UpdateIpBlockInput = z.infer<typeof updateIpBlockInput>;

export const ipBlockListQuery = listQuery.extend({
  server_id: uuid.optional(),
  source: ipBlockSource.optional(),
  /** Expired blocks are kept for the audit trail, so they are opt-in on read. */
  include_expired: z.coerce.boolean().default(false),
});
export type IpBlockListQuery = z.infer<typeof ipBlockListQuery>;

/* ------------------------------------------------------------------ *
 * SSH security
 * ------------------------------------------------------------------ */

export const sshKeyType = z.enum([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);
export type SshKeyType = z.infer<typeof sshKeyType>;

export const openSshPublicKey = z
  .string()
  .trim()
  .min(80)
  .max(4096)
  .regex(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( \S.*)?$/,
    'must be an OpenSSH public key, e.g. "ssh-ed25519 AAAAC3Nza... you@laptop"',
  );
export type OpenSshPublicKey = z.infer<typeof openSshPublicKey>;

export const sshKey = z.object({
  id: uuid,
  name: z.string(),
  public_key: z.string(),
  fingerprint: z.string(),
  type: sshKeyType,
  comment: z.string().nullable(),
  /** Null for a shared deploy key that belongs to no panel user. */
  user_id: uuid.nullable(),
  server_ids: z.array(uuid),
  last_used_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type SshKey = z.infer<typeof sshKey>;

export const createSshKeyInput = z.object({
  name: z.string().min(1).max(64),
  public_key: openSshPublicKey,
  user_id: uuid.nullable().default(null),
  server_ids: z.array(uuid).max(200).default([]),
});
export type CreateSshKeyInput = z.infer<typeof createSshKeyInput>;

/** Key material is immutable; rotating means a new row, so a fingerprint always names one key. */
export const updateSshKeyInput = createSshKeyInput.omit({ public_key: true }).partial();
export type UpdateSshKeyInput = z.infer<typeof updateSshKeyInput>;

export const sshKeyListQuery = listQuery.extend({
  server_id: uuid.optional(),
  user_id: uuid.optional(),
  type: sshKeyType.optional(),
});
export type SshKeyListQuery = z.infer<typeof sshKeyListQuery>;

export const permitRootLogin = z.enum(["yes", "no", "prohibit-password", "forced-commands-only"]);
export type PermitRootLogin = z.infer<typeof permitRootLogin>;

export const sshConfig = z.object({
  server_id: uuid,
  server_name: z.string(),
  port,
  permit_root_login: permitRootLogin,
  password_authentication: z.boolean(),
  pubkey_authentication: z.boolean(),
  max_auth_tries: z.number().int().min(1).max(20),
  allow_users: z.array(identifier),
  allow_groups: z.array(identifier),
  x11_forwarding: z.boolean(),
  last_applied_at: isoDate.nullable(),
  last_synced_at: isoDate,
});
export type SshConfig = z.infer<typeof sshConfig>;

export const applySshConfigInput = sshConfig
  .omit({ server_id: true, server_name: true, last_applied_at: true, last_synced_at: true })
  .partial()
  .extend({
    /** Same lockout guard as the firewall: a bad sshd config reverts itself. */
    rollback_seconds: z.number().int().min(0).max(300).default(60),
  });
export type ApplySshConfigInput = z.infer<typeof applySshConfigInput>;

/** Live only — read straight from the host, never cached. */
export const sshSession = z.object({
  server_id: uuid,
  server_name: z.string(),
  user: z.string(),
  from_ip: ipAddress,
  tty: z.string(),
  pid: z.number().int(),
  started_at: isoDate,
  idle_seconds: z.number().int().nonnegative(),
});
export type SshSession = z.infer<typeof sshSession>;

/* ------------------------------------------------------------------ *
 * Audit
 *
 * Insert-only and hash-chained (KD-009). Rows have `ts` rather than
 * created_at/updated_at because nothing about them is ever updated.
 * ------------------------------------------------------------------ */

export const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");
export type Sha256Hex = z.infer<typeof sha256Hex>;

/** Secrets are redacted before the row is written, not at render time. */
export const auditDiff = z.object({
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditDiff = z.infer<typeof auditDiff>;

export const auditEvent = z.object({
  id: uuid,
  ts: isoDate,
  actor_type: auditActorType,
  /** Null for `system` actors and for a deleted user whose events outlive them. */
  actor_id: uuid.nullable(),
  actor_name: z.string(),
  action: z.string(),
  target_type: z.string(),
  target_id: uuid.nullable(),
  target_label: z.string(),
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  ip: ipAddress.nullable(),
  user_agent: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  diff: auditDiff.nullable(),
  job_id: uuid.nullable(),
  prev_hash: sha256Hex,
  hash: sha256Hex,
});
export type AuditEvent = z.infer<typeof auditEvent>;

export const auditEventListQuery = listQuery.extend({
  actor_type: auditActorType.optional(),
  actor_id: uuid.optional(),
  action: z.string().max(64).optional(),
  target_type: z.string().max(64).optional(),
  target_id: uuid.optional(),
  server_id: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type AuditEventListQuery = z.infer<typeof auditEventListQuery>;

export const auditVerification = z.object({
  verified: z.boolean(),
  events_checked: z.number().int().nonnegative(),
  first_event_at: isoDate.nullable(),
  last_event_at: isoDate.nullable(),
  /** Id of the first row whose hash does not chain. Null when the chain is intact. */
  broken_at: uuid.nullable(),
  checked_at: isoDate,
});
export type AuditVerification = z.infer<typeof auditVerification>;
