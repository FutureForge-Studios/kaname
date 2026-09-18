import { z } from "zod";
import {
  bytes,
  emailAddress,
  identifier,
  ipAddress,
  isoDate,
  listQuery,
  slug,
  uuid,
} from "../primitives.js";
import { logLevel, logSourceKind } from "../enums.js";
import { permission, roleGrant, scopeKind } from "../rbac.js";
import { logRecord, logSource } from "../agent/payloads.js";

/* ------------------------------------------------------------------ *
 * The surfaces that are not a resource module: logs, terminal,
 * administration, the command palette and the SSE feed.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Logs  (enumerated live — a source list is never cached)
 * ------------------------------------------------------------------ */

export const logSourceRow = logSource.extend({
  server_id: uuid,
  server_name: z.string(),
  kind: logSourceKind,
});
export type LogSourceRow = z.infer<typeof logSourceRow>;

export const logQuery = z.object({
  server_id: uuid,
  source: z.string().max(256).optional(),
  /** Minimum severity: `warn` also returns error and fatal. */
  level: logLevel.optional(),
  /** Substring, unless wrapped in slashes — `/nginx\[\d+\]/` is a regex. */
  q: z.string().max(500).optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  follow: z.coerce.boolean().default(false),
  /** Resumes a tail from the last record the viewer rendered. */
  cursor: z.string().max(256).optional(),
});
export type LogQuery = z.infer<typeof logQuery>;

export const logRecordRow = logRecord.extend({
  /** Stable across re-queries so the virtualized viewer can key rows. */
  id: z.string(),
  server_id: uuid,
  server_name: z.string(),
  ts: isoDate,
});
export type LogRecordRow = z.infer<typeof logRecordRow>;

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

export const terminalSessionRequest = z.object({
  server_id: uuid,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  /** POSIX user to run as. Defaults to root and is audited either way. */
  user: identifier.optional(),
});
export type TerminalSessionRequest = z.infer<typeof terminalSessionRequest>;

export const terminalSessionTicket = z.object({
  /** Single-use, short-lived and IP-bound: the socket cannot be reached by URL guessing (KD-013). */
  ticket: z.string(),
  ws_url: z.string(),
  expires_at: isoDate,
  server_id: uuid,
  server_name: z.string(),
  recorded: z.boolean(),
});
export type TerminalSessionTicket = z.infer<typeof terminalSessionTicket>;

export const terminalSessionRecord = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  user_id: uuid,
  user_name: z.string(),
  started_at: isoDate,
  ended_at: isoDate.nullable(),
  duration_ms: z.number().int().nullable(),
  bytes_in: bytes,
  bytes_out: bytes,
  command_count: z.number().int().nonnegative(),
  recording_available: z.boolean(),
});
export type TerminalSessionRecord = z.infer<typeof terminalSessionRecord>;

export const terminalSessionListQuery = listQuery.extend({
  server_id: uuid.optional(),
  user_id: uuid.optional(),
  active: z.coerce.boolean().optional(),
});
export type TerminalSessionListQuery = z.infer<typeof terminalSessionListQuery>;

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const userStatus = z.enum(["active", "invited", "suspended"]);
export type UserStatus = z.infer<typeof userStatus>;

export const roleRef = z.object({ id: uuid, name: z.string(), slug });
export type RoleRef = z.infer<typeof roleRef>;

export const user = z.object({
  id: uuid,
  email: emailAddress,
  name: z.string(),
  status: userStatus,
  totp_enabled: z.boolean(),
  roles: z.array(roleRef),
  last_login_at: isoDate.nullable(),
  last_login_ip: ipAddress.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type User = z.infer<typeof user>;

/** Users are invited, never created with a password the inviter has seen. */
export const createUserInput = z.object({
  email: emailAddress,
  name: z.string().min(1).max(96),
  role_ids: z.array(uuid).min(1),
  send_invite: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof createUserInput>;

export const updateUserInput = z.object({
  name: z.string().min(1).max(96).optional(),
  status: userStatus.optional(),
  role_ids: z.array(uuid).min(1).optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserInput>;

export const password = z.string().min(12).max(256);

export const changePasswordInput = z
  .object({
    current_password: z.string().min(1).max(256),
    new_password: password,
  })
  .refine((v) => v.new_password !== v.current_password, {
    path: ["new_password"],
    message: "must differ from the current password",
  });
export type ChangePasswordInput = z.infer<typeof changePasswordInput>;

export const userListQuery = listQuery.extend({
  status: userStatus.optional(),
  role: slug.optional(),
  totp_enabled: z.coerce.boolean().optional(),
});
export type UserListQuery = z.infer<typeof userListQuery>;

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

export const role = z.object({
  id: uuid,
  name: z.string(),
  slug,
  description: z.string(),
  is_system: z.boolean(),
  user_count: z.number().int().nonnegative(),
  grants: z.array(roleGrant),
  created_at: isoDate,
  updated_at: isoDate,
});
export type Role = z.infer<typeof role>;

export const createRoleInput = z.object({
  name: z.string().min(1).max(64),
  /** Derived from the name when omitted. Immutable afterwards. */
  slug: slug.optional(),
  description: z.string().max(500).default(""),
  grants: z.array(roleGrant),
});
export type CreateRoleInput = z.infer<typeof createRoleInput>;

export const updateRoleInput = createRoleInput.omit({ slug: true }).partial();
export type UpdateRoleInput = z.infer<typeof updateRoleInput>;

export const roleListQuery = listQuery.extend({
  is_system: z.coerce.boolean().optional(),
});
export type RoleListQuery = z.infer<typeof roleListQuery>;

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

export const apiKey = z.object({
  id: uuid,
  name: z.string(),
  /** Everything up to the secret, e.g. "kn_live_9f3a" — enough to identify a key in a log. */
  prefix: z.string(),
  scopes: z.array(permission),
  scope_kind: scopeKind,
  scope_server_ids: z.array(uuid),
  expires_at: isoDate.nullable(),
  last_used_at: isoDate.nullable(),
  last_used_ip: ipAddress.nullable(),
  created_by: uuid,
  created_by_name: z.string(),
  revoked_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type ApiKey = z.infer<typeof apiKey>;

export const createApiKeyInput = z
  .object({
    name: z.string().min(1).max(64),
    /** The control plane intersects these with the creator's own grants — never more. */
    scopes: z.array(permission).min(1),
    scope_kind: scopeKind.default("global"),
    scope_server_ids: z.array(uuid).default([]),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
  })
  .refine((v) => v.scope_kind === "global" || v.scope_server_ids.length > 0, {
    path: ["scope_server_ids"],
    message: "select at least one server",
  });
export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;

/** Scopes are fixed once issued; a narrower key is a new key. */
export const updateApiKeyInput = z.object({ name: z.string().min(1).max(64) });
export type UpdateApiKeyInput = z.infer<typeof updateApiKeyInput>;

/** The only place the full token is ever returned. It is not retrievable again. */
export const apiKeyCreated = z.object({
  key: apiKey,
  token: z.string(),
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreated>;

export const apiKeyListQuery = listQuery.extend({
  created_by: uuid.optional(),
  revoked: z.coerce.boolean().optional(),
});
export type ApiKeyListQuery = z.infer<typeof apiKeyListQuery>;

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

export const session = z.object({
  id: uuid,
  ip: ipAddress,
  user_agent: z.string(),
  created_at: isoDate,
  last_seen_at: isoDate,
  expires_at: isoDate,
  /** The session making this request — revoking it logs you out. */
  current: z.boolean(),
});
export type Session = z.infer<typeof session>;

export const totpCode = z.string().regex(/^\d{6}$/, "must be a six-digit code");

export const loginInput = z.object({
  email: emailAddress,
  password: z.string().min(1).max(256),
  /** Sent on the second leg, after a `totp_required` response. */
  totp_code: totpCode.optional(),
  challenge: z.string().max(256).optional(),
  remember: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginInput>;

export const loginResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), user }),
  z.object({ status: z.literal("totp_required"), challenge: z.string() }),
]);
export type LoginResponse = z.infer<typeof loginResponse>;

export const totpSetupResponse = z.object({
  secret: z.string(),
  otpauth_url: z.string(),
  /** Shown once, at setup. The control plane stores only their hashes. */
  recovery_codes: z.array(z.string()).min(1),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponse>;

export const totpVerifyInput = z.object({ code: totpCode });
export type TotpVerifyInput = z.infer<typeof totpVerifyInput>;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export const notificationChannelKind = z.enum(["email", "webhook", "slack"]);
export type NotificationChannelKind = z.infer<typeof notificationChannelKind>;

export const notificationEvent = z.enum([
  "job_failed",
  "server_offline",
  "service_failed",
  "certificate_expiring",
  "backup_failed",
  "threat_detected",
  "alert_firing",
  "deployment_failed",
  "update_available",
  "update_applied",
  "update_failed",
]);
export type NotificationEvent = z.infer<typeof notificationEvent>;

/** Human labels, shared by the settings page and the wizard. */
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  job_failed: "Job failed",
  server_offline: "Server went offline (and came back)",
  service_failed: "Service failed",
  certificate_expiring: "Certificate expiring",
  backup_failed: "Backup failed",
  threat_detected: "Threat detected",
  alert_firing: "Alert firing",
  deployment_failed: "Deployment failed",
  update_available: "Update available",
  update_applied: "Update applied",
  update_failed: "Update failed, rolled back, or could not be checked",
};

/** The set a fresh channel starts with: the things worth a phone call. */
export const DEFAULT_NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  "job_failed",
  "server_offline",
  "backup_failed",
  "certificate_expiring",
  "update_failed",
];

const channelTarget = (
  channel: { kind: NotificationChannelKind; target: string },
  ctx: z.RefinementCtx,
) => {
  const target = channel.target.trim();
  if (channel.kind === "email") {
    if (!emailAddress.safeParse(target).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "An email channel needs an email address to send to.",
      });
    }
    return;
  }
  const url = z.string().url().safeParse(target);
  if (!url.success || !/^https?:\/\//i.test(target)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target"],
      message:
        channel.kind === "slack"
          ? "A Slack channel needs its incoming-webhook URL."
          : "A webhook channel needs an http(s) URL to POST to.",
    });
  }
};

const notificationChannelBase = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(64),
  kind: notificationChannelKind,
  /** Address or webhook URL. A webhook signing secret is never returned. */
  target: z.string().trim().min(1).max(2048),
  events: z.array(notificationEvent),
  enabled: z.boolean(),
  /** When this channel last delivered anything. Read-only. */
  last_delivery_at: isoDate.nullable().optional(),
  /** Why the last delivery failed, or null. Read-only. */
  last_error: z.string().nullable().optional(),
  /** Whether a signing secret is stored for a webhook. Read-only. */
  secret_set: z.boolean().optional(),
});

export const notificationChannel = notificationChannelBase.superRefine(channelTarget);
export type NotificationChannel = z.infer<typeof notificationChannel>;

/**
 * What the settings form sends. `secret` is write-only: omitted keeps
 * the stored one, null clears it. It signs webhook deliveries
 * (`X-Kaname-Signature: sha256=<hmac of the body>`).
 */
export const notificationChannelInput = notificationChannelBase
  .extend({ secret: z.string().max(1024).nullable().optional() })
  .superRefine(channelTarget);
export type NotificationChannelInput = z.infer<typeof notificationChannelInput>;

/* ------------------------------ smtp ------------------------------ */

export const smtpSecurity = z.enum(["starttls", "tls", "none"]);
export type SmtpSecurity = z.infer<typeof smtpSecurity>;

/**
 * The outgoing mail server every email channel sends through. An empty
 * host means "not configured", and email channels say so instead of
 * silently doing nothing.
 */
export const smtpSettings = z.object({
  host: z.string().trim().max(253),
  port: z.number().int().min(1).max(65535),
  security: smtpSecurity,
  username: z.string().trim().max(320),
  from_address: z.string().trim().max(320),
  from_name: z.string().trim().max(120),
  /** Whether a password is stored. Read-only; write it with `password`. */
  password_set: z.boolean(),
});
export type SmtpSettings = z.infer<typeof smtpSettings>;

/** `password` is write-only: omitted keeps the stored one, null clears it. */
export const smtpSettingsInput = smtpSettings
  .omit({ password_set: true })
  .partial()
  .extend({ password: z.string().max(1024).nullable().optional() })
  .superRefine((value, ctx) => {
    if (value.from_address && !emailAddress.safeParse(value.from_address).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from_address"],
        message: "The sender must be an email address.",
      });
    }
  });
export type SmtpSettingsInput = z.infer<typeof smtpSettingsInput>;

export const smtpTestInput = z.object({
  to: emailAddress,
  /** Unsaved draft values to try, merged over what is stored. */
  smtp: smtpSettingsInput.optional(),
});
export type SmtpTestInput = z.infer<typeof smtpTestInput>;

/** The answer to "send a test": either it arrived, or exactly why not. */
export const notificationTestResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  duration_ms: z.number().int().min(0),
});
export type NotificationTestResult = z.infer<typeof notificationTestResult>;

export const panelSettings = z.object({
  name: z.string().min(1).max(64),
  url: z.string().url(),
  timezone: z.string().min(1).max(64),
  date_format: z.enum(["iso", "us", "eu", "relative"]),
});
export type PanelSettings = z.infer<typeof panelSettings>;

export const failedLoginLockout = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().min(1).max(100),
  window_minutes: z.number().int().min(1).max(1440),
  lockout_minutes: z.number().int().min(1).max(10080),
});
export type FailedLoginLockout = z.infer<typeof failedLoginLockout>;

export const securitySettings = z.object({
  session_ttl_hours: z.number().int().min(1).max(720),
  require_totp: z.boolean(),
  /** Turning this off is itself an audited settings change (KD-013). */
  terminal_recording: z.boolean(),
  failed_login_lockout: failedLoginLockout,
});
export type SecuritySettings = z.infer<typeof securitySettings>;

export const notificationSettings = z.object({
  channels: z.array(notificationChannel),
  smtp: smtpSettings,
});
export type NotificationSettings = z.infer<typeof notificationSettings>;

export const notificationSettingsInput = z.object({
  /** The supplied array is the whole set: anything omitted is removed. */
  channels: z.array(notificationChannelInput).optional(),
  smtp: smtpSettingsInput.optional(),
});
export type NotificationSettingsInput = z.infer<typeof notificationSettingsInput>;

export const agentSettings = z.object({
  heartbeat_seconds: z.number().int().min(5).max(300),
  /** Drives the `degraded` -> `disconnected` transition on the connection axis. */
  offline_after_seconds: z.number().int().min(15).max(3600),
  metrics_retention_days: z.number().int().min(1).max(3650),
});
export type AgentSettings = z.infer<typeof agentSettings>;

export const backupSettings = z.object({
  default_destination_id: uuid.nullable(),
});
export type BackupSettings = z.infer<typeof backupSettings>;

export const acmeSettings = z.object({
  email: emailAddress,
  directory_url: z.string().url(),
  staging: z.boolean(),
});
export type AcmeSettings = z.infer<typeof acmeSettings>;

export const settingsDocument = z.object({
  panel: panelSettings,
  security: securitySettings,
  notifications: notificationSettings,
  agents: agentSettings,
  backups: backupSettings,
  acme: acmeSettings,
});
export type SettingsDocument = z.infer<typeof settingsDocument>;

/** Settings are edited one section at a time, so every level is optional. */
export const updateSettingsInput = z.object({
  panel: panelSettings.partial().optional(),
  security: securitySettings
    .partial()
    .extend({ failed_login_lockout: failedLoginLockout.partial().optional() })
    .optional(),
  notifications: notificationSettingsInput.optional(),
  agents: agentSettings.partial().optional(),
  backups: backupSettings.partial().optional(),
  acme: acmeSettings.partial().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

/* ------------------------------------------------------------------ *
 * The panel's own address
 *
 * An install starts life on its server's IP over plain HTTP, because
 * asking for a domain before anyone has seen the product is a worse
 * first run than asking for one afterwards. Setting a domain ADDS an
 * HTTPS site; the IP keeps working, so this can never lock an operator
 * out of the address they are currently using.
 * ------------------------------------------------------------------ */

export const addressSettings = z.object({
  /** Null while the panel is reachable only by IP. */
  domain: z.string().nullable(),
  public_url: z.string(),
  /** True once a domain is set and Caddy can provision a certificate. */
  tls: z.boolean(),
  /**
   * False when this instance was not deployed by install.sh — there is
   * no host helper to reconfigure, so the panel says so rather than
   * offering a form that cannot work.
   */
  managed: z.boolean(),
});
export type AddressSettings = z.infer<typeof addressSettings>;

/** A bare hostname. Empty clears the domain and returns to IP-only. */
export const setAddressInput = z.object({
  domain: z
    .string()
    .max(253)
    .refine(
      (value) =>
        value === "" ||
        /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value),
      "Enter a hostname like panel.example.com, or leave it empty to use the IP address.",
    ),
});
export type SetAddressInput = z.infer<typeof setAddressInput>;

/* ------------------------------------------------------------------ *
 * Per-user preferences
 *
 * Kept on the account rather than in browser storage: a hint dismissed
 * on a laptop should stay dismissed on the machine in the rack room.
 * ------------------------------------------------------------------ */

export const userPreferences = z.object({
  /** Ids of one-time nudges this account has closed. */
  dismissed_hints: z.array(z.string().max(64)).max(100).default([]),
});
export type UserPreferences = z.infer<typeof userPreferences>;

export const updateUserPreferencesInput = userPreferences.partial();
export type UpdateUserPreferencesInput = z.infer<typeof updateUserPreferencesInput>;

/** The Command Center's first-run nudge. */
export const GETTING_STARTED_HINT = "getting-started";

/* ------------------------------------------------------------------ *
 * Search  (the command palette backend)
 * ------------------------------------------------------------------ */

export const searchResultKind = z.enum([
  "server",
  "site",
  "domain",
  "mailbox",
  "database",
  "container",
  "service",
  "file",
  "job",
  "user",
  "action",
]);
export type SearchResultKind = z.infer<typeof searchResultKind>;

export const searchResult = z.object({
  kind: searchResultKind,
  /** Not always a uuid — a file result is keyed by its path. */
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  href: z.string(),
  server_name: z.string().nullable(),
  /** lucide-react icon name, e.g. "Server". Rendered by name, not imported here. */
  icon: z.string(),
  score: z.number().min(0).max(1),
});
export type SearchResult = z.infer<typeof searchResult>;

export const searchAction = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string(),
  /** The palette hides what the actor cannot do; the API re-checks on dispatch. */
  permission,
  href: z.string().optional(),
  action: z.string().optional(),
});
export type SearchAction = z.infer<typeof searchAction>;

export const searchQuery = z.object({
  q: z.string().min(1).max(200),
  kind: searchResultKind.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuery>;

export const searchResponse = z.object({
  groups: z.array(
    z.object({
      kind: searchResultKind,
      label: z.string(),
      results: z.array(searchResult),
    }),
  ),
  /** The palette runs things — "restart nginx on web-01" — it does not only navigate. */
  actions: z.array(searchAction),
});
export type SearchResponse = z.infer<typeof searchResponse>;

/* ------------------------------------------------------------------ *
 * Event stream
 * ------------------------------------------------------------------ */

export const eventTopic = z.enum([
  "jobs",
  "servers",
  "services",
  "containers",
  "threats",
  "alerts",
  "deployments",
  "certificates",
  "backups",
  "audit",
  "updates",
]);
export type EventTopic = z.infer<typeof eventTopic>;

export const streamEvent = z.object({
  /** SSE id; the browser resumes from it with Last-Event-ID after a reconnect. */
  id: z.string(),
  topic: eventTopic,
  type: z.string().max(64),
  ts: isoDate,
  /** Shape depends on `topic` + `type`; the consumer parses it with that resource's schema. */
  data: z.unknown(),
});
export type StreamEvent = z.infer<typeof streamEvent>;

export const eventStreamQuery = z.object({
  /** Comma-separated in the URL: ?topics=jobs,servers. */
  topics: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(eventTopic))
    .optional(),
  server_id: uuid.optional(),
});
export type EventStreamQuery = z.infer<typeof eventStreamQuery>;
