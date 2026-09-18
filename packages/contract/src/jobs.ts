import { z } from "zod";
import { isoDate, uuid } from "./primitives.js";
import type { Permission } from "./rbac.js";

/* ------------------------------------------------------------------ *
 * Job lifecycle
 *
 * Every mutation that crosses the network to a managed host is a job.
 * The UI renders a JobStatusPill for these, never a spinner-then-toast.
 * ------------------------------------------------------------------ */

export const jobStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export type JobStatus = z.infer<typeof jobStatus>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

export const jobBlockedReason = z.enum([
  "agent_offline",
  "agent_busy",
  "waiting_on_dependency",
  "rate_limited",
]);

export const JOB_TYPES = [
  // system
  "system.reboot",
  "system.packages.upgrade",
  "system.sync",
  // services
  "service.start",
  "service.stop",
  "service.restart",
  "service.reload",
  "service.enable",
  "service.disable",
  // processes
  "process.signal",
  // containers
  "container.start",
  "container.stop",
  "container.restart",
  "container.remove",
  "container.prune",
  // files
  "fs.write",
  "fs.mkdir",
  "fs.move",
  "fs.copy",
  "fs.remove",
  "fs.chmod",
  "fs.chown",
  "fs.archive",
  "fs.extract",
  "fs.usage",
  // ftp
  "ftp.create",
  "ftp.update",
  "ftp.delete",
  "ftp.reset_password",
  // sites
  "site.create",
  "site.update",
  "site.remove",
  "site.reload",
  // certificates
  "cert.issue",
  "cert.renew",
  "cert.revoke",
  // dns
  "dns.sync",
  "dns.apply",
  // deployments
  "deployment.run",
  "deployment.rollback",
  // mail
  "mail.mailbox.create",
  "mail.mailbox.update",
  "mail.mailbox.delete",
  "mail.mailbox.reset_password",
  "mail.alias.apply",
  "mail.forwarder.apply",
  "mail.auth.check",
  "mail.domain.provision",
  // databases
  "db.database.create",
  "db.database.delete",
  "db.user.create",
  "db.user.update",
  "db.user.delete",
  "db.grant.apply",
  "db.dump",
  "db.restore",
  // firewall / security
  "fw.apply",
  "fw.ban",
  "fw.unban",
  "ssh.keys.apply",
  "ssh.config.apply",
  // backups
  "backup.run",
  "backup.restore",
  "backup.verify",
  "backup.prune",
  // lifecycle
  "agent.update",
] as const;

export type JobType = (typeof JOB_TYPES)[number];
export const jobType = z.enum(JOB_TYPES);

export interface JobTypeSpec {
  /** Sentence rendered in the activity feed and job drawer. */
  label: string;
  /** Permission required to enqueue it. */
  permission: Permission;
  /** Safe to run twice with the same params? Drives retry eligibility. */
  idempotent: boolean;
  /** Automatic retries on transport failure. Never set for non-idempotent work. */
  maxAttempts: number;
  /** Agent-side deadline in milliseconds. */
  timeoutMs: number;
  /** Destructive enough to require typed confirmation in the UI. */
  destructive?: boolean;
}

const S = 1000;
const M = 60 * S;

export const JOB_SPECS: Record<JobType, JobTypeSpec> = {
  "system.reboot": {
    label: "Reboot server",
    permission: "infra.servers:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 2 * M,
    destructive: true,
  },
  "system.packages.upgrade": {
    label: "Upgrade packages",
    permission: "infra.servers:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 30 * M,
  },
  "system.sync": {
    label: "Sync inventory",
    permission: "infra.servers:read",
    idempotent: true,
    maxAttempts: 3,
    timeoutMs: 60 * S,
  },

  "service.start": {
    label: "Start service",
    permission: "infra.services:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 90 * S,
  },
  "service.stop": {
    label: "Stop service",
    permission: "infra.services:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 90 * S,
    destructive: true,
  },
  "service.restart": {
    label: "Restart service",
    permission: "infra.services:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 90 * S,
  },
  "service.reload": {
    label: "Reload service",
    permission: "infra.services:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "service.enable": {
    label: "Enable service at boot",
    permission: "infra.services:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 30 * S,
  },
  "service.disable": {
    label: "Disable service at boot",
    permission: "infra.services:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 30 * S,
  },

  "process.signal": {
    label: "Signal process",
    permission: "infra.processes:exec",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 15 * S,
    destructive: true,
  },

  "container.start": {
    label: "Start container",
    permission: "infra.containers:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 2 * M,
  },
  "container.stop": {
    label: "Stop container",
    permission: "infra.containers:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 2 * M,
    destructive: true,
  },
  "container.restart": {
    label: "Restart container",
    permission: "infra.containers:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 2 * M,
  },
  "container.remove": {
    label: "Remove container",
    permission: "infra.containers:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 2 * M,
    destructive: true,
  },
  "container.prune": {
    label: "Prune unused containers",
    permission: "infra.containers:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
    destructive: true,
  },

  "fs.write": {
    label: "Write file",
    permission: "files.manager:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 60 * S,
  },
  "fs.mkdir": {
    label: "Create directory",
    permission: "files.manager:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 30 * S,
  },
  "fs.move": {
    label: "Move",
    permission: "files.manager:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 5 * M,
  },
  "fs.copy": {
    label: "Copy",
    permission: "files.manager:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 15 * M,
  },
  "fs.remove": {
    label: "Delete",
    permission: "files.manager:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
    destructive: true,
  },
  "fs.chmod": {
    label: "Change permissions",
    permission: "files.manager:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "fs.chown": {
    label: "Change ownership",
    permission: "files.manager:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "fs.archive": {
    label: "Create archive",
    permission: "files.manager:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 30 * M,
  },
  "fs.extract": {
    label: "Extract archive",
    permission: "files.manager:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 30 * M,
  },
  "fs.usage": {
    label: "Compute storage usage",
    permission: "files.manager:read",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 10 * M,
  },

  "ftp.create": {
    label: "Create FTP account",
    permission: "files.ftp:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 60 * S,
  },
  "ftp.update": {
    label: "Update FTP account",
    permission: "files.ftp:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "ftp.delete": {
    label: "Delete FTP account",
    permission: "files.ftp:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 60 * S,
    destructive: true,
  },
  "ftp.reset_password": {
    label: "Reset FTP password",
    permission: "files.ftp:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 60 * S,
  },

  "site.create": {
    label: "Create site",
    permission: "websites.sites:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 5 * M,
  },
  "site.update": {
    label: "Update site",
    permission: "websites.sites:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
  },
  "site.remove": {
    label: "Remove site",
    permission: "websites.sites:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
    destructive: true,
  },
  "site.reload": {
    label: "Reload web server",
    permission: "websites.sites:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },

  "cert.issue": {
    label: "Issue certificate",
    permission: "websites.ssl:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 10 * M,
  },
  "cert.renew": {
    label: "Renew certificate",
    permission: "websites.ssl:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 10 * M,
  },
  "cert.revoke": {
    label: "Revoke certificate",
    permission: "websites.ssl:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
    destructive: true,
  },

  "dns.sync": {
    label: "Sync DNS records",
    permission: "websites.dns:read",
    idempotent: true,
    maxAttempts: 3,
    timeoutMs: 2 * M,
  },
  "dns.apply": {
    label: "Apply DNS records",
    permission: "websites.dns:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 2 * M,
  },

  "deployment.run": {
    label: "Deploy",
    permission: "websites.deployments:exec",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 30 * M,
  },
  "deployment.rollback": {
    label: "Roll back deployment",
    permission: "websites.deployments:exec",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 10 * M,
    destructive: true,
  },

  "mail.mailbox.create": {
    label: "Create mailbox",
    permission: "email.mailboxes:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 2 * M,
  },
  "mail.mailbox.update": {
    label: "Update mailbox",
    permission: "email.mailboxes:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 2 * M,
  },
  "mail.mailbox.delete": {
    label: "Delete mailbox",
    permission: "email.mailboxes:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
    destructive: true,
  },
  "mail.mailbox.reset_password": {
    label: "Reset mailbox password",
    permission: "email.mailboxes:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 60 * S,
  },
  "mail.alias.apply": {
    label: "Apply aliases",
    permission: "email.routing:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "mail.forwarder.apply": {
    label: "Apply forwarders",
    permission: "email.routing:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "mail.auth.check": {
    label: "Check mail DNS authentication",
    permission: "email.auth:exec",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 2 * M,
  },
  "mail.domain.provision": {
    label: "Provision mail domain",
    permission: "email.mailboxes:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 5 * M,
  },

  "db.database.create": {
    label: "Create database",
    permission: "databases.mysql:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 2 * M,
  },
  "db.database.delete": {
    label: "Drop database",
    permission: "databases.mysql:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 5 * M,
    destructive: true,
  },
  "db.user.create": {
    label: "Create database user",
    permission: "databases.mysql:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 60 * S,
  },
  "db.user.update": {
    label: "Update database user",
    permission: "databases.mysql:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 60 * S,
  },
  "db.user.delete": {
    label: "Drop database user",
    permission: "databases.mysql:delete",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 60 * S,
    destructive: true,
  },
  "db.grant.apply": {
    label: "Apply database grants",
    permission: "databases.mysql:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "db.dump": {
    label: "Dump database",
    permission: "databases.mysql:read",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 60 * M,
  },
  "db.restore": {
    label: "Restore database",
    permission: "databases.mysql:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 60 * M,
    destructive: true,
  },

  "fw.apply": {
    label: "Apply firewall rules",
    permission: "security.firewall:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 2 * M,
  },
  "fw.ban": {
    label: "Ban address",
    permission: "security.threats:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "fw.unban": {
    label: "Unban address",
    permission: "security.threats:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "ssh.keys.apply": {
    label: "Apply SSH keys",
    permission: "security.ssh:write",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * S,
  },
  "ssh.config.apply": {
    label: "Apply SSH configuration",
    permission: "security.ssh:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 2 * M,
    destructive: true,
  },

  "backup.run": {
    label: "Run backup",
    permission: "backups.schedules:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 6 * 60 * M,
  },
  "backup.restore": {
    label: "Restore backup",
    permission: "backups.restore:exec",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 6 * 60 * M,
    destructive: true,
  },
  "backup.verify": {
    label: "Verify restore point",
    permission: "backups.schedules:read",
    idempotent: true,
    maxAttempts: 2,
    timeoutMs: 60 * M,
  },
  "backup.prune": {
    label: "Prune restore points",
    permission: "backups.schedules:write",
    idempotent: true,
    maxAttempts: 1,
    timeoutMs: 60 * M,
    destructive: true,
  },

  "agent.update": {
    label: "Update agent",
    permission: "admin.settings:write",
    idempotent: false,
    maxAttempts: 1,
    timeoutMs: 10 * M,
  },
};

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

export const jobLogLine = z.object({
  seq: z.number().int(),
  ts: isoDate,
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});
export type JobLogLine = z.infer<typeof jobLogLine>;

export const job = z.object({
  id: uuid,
  type: jobType,
  label: z.string(),
  status: jobStatus,
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  /** Human name of what the job acted on, e.g. "nginx.service on web-01". */
  target_label: z.string().nullable(),
  /** 0..100 when the job type reports progress, otherwise null. */
  progress: z.number().min(0).max(100).nullable(),
  blocked_reason: jobBlockedReason.nullable(),
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  correlation_id: uuid.nullable(),
  parent_id: uuid.nullable(),
  child_count: z.number().int().default(0),
  error: z
    .object({ code: z.string(), message: z.string(), detail: z.unknown().optional() })
    .nullable(),
  result: z.unknown().nullable(),
  created_by: uuid.nullable(),
  created_by_name: z.string().nullable(),
  created_at: isoDate,
  started_at: isoDate.nullable(),
  finished_at: isoDate.nullable(),
  duration_ms: z.number().int().nullable(),
});
export type Job = z.infer<typeof job>;

/**
 * A job log is not a paginated list: the drawer wants the whole thing
 * in order, and the SSE bridge appends to it. So it has its own cap,
 * well above the list cap, and a cursor for "only what I have not seen".
 */
export const jobLogQuery = z.object({
  per_page: z.coerce.number().int().min(1).max(5000).default(2000),
  since_seq: z.coerce.number().int().min(0).optional(),
});
export type JobLogQuery = z.infer<typeof jobLogQuery>;

export const jobListQueryExtra = z.object({
  status: jobStatus.optional(),
  type: jobType.optional(),
  server_id: uuid.optional(),
  correlation_id: uuid.optional(),
});

/** 202 body for any mutation that reaches a host. */
export const jobAccepted = z.object({ data: z.object({ job }) });
export type JobAccepted = z.infer<typeof jobAccepted>;
