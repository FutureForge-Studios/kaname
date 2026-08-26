import { z } from "zod";
import {
  absolutePath,
  bytes,
  cronExpression,
  hostname,
  identifier,
  isoDate,
  listQuery,
  port,
  remediation,
  uuid,
} from "../primitives.js";
import { backupDestinationKind, backupRunStatus, backupScopeKind } from "../enums.js";

/* ------------------------------------------------------------------ *
 * Destinations
 * ------------------------------------------------------------------ */

export const backupDestinationStatus = z.enum(["ok", "unreachable", "untested"]);
export type BackupDestinationStatus = z.infer<typeof backupDestinationStatus>;

/**
 * Where a destination points — never how it authenticates. Credentials are
 * envelope-encrypted at rest and never leave the control plane, so this is the
 * only view of a destination the API ever returns.
 */
export const backupDestinationSummary = z.object({
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  host: z.string().nullable(),
  path: z.string().nullable(),
  /** Last characters of the key id, enough to tell two credentials apart. */
  access_key_hint: z.string().nullable(),
});
export type BackupDestinationSummary = z.infer<typeof backupDestinationSummary>;

export const backupDestination = z.object({
  id: uuid,
  name: z.string(),
  kind: backupDestinationKind,
  config: backupDestinationSummary,
  status: backupDestinationStatus,
  status_detail: z.string().nullable(),
  last_checked_at: isoDate.nullable(),
  used_bytes: bytes,
  snapshot_count: z.number().int().nonnegative(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type BackupDestination = z.infer<typeof backupDestination>;

/**
 * Write-only half of a destination. Every secret in here is accepted once and
 * is unreadable afterwards; rotating a credential means sending the target
 * again. Nested unions rather than optional pairs, so "an sftp destination with
 * neither a password nor a key" is unrepresentable.
 */
export const backupDestinationTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("s3"),
    endpoint: z.string().max(255).optional(),
    region: z.string().min(1).max(64).default("us-east-1"),
    bucket: z.string().min(1).max(255),
    prefix: z.string().max(512).default(""),
    access_key_id: z.string().min(1).max(128),
    secret_access_key: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal("b2"),
    bucket: z.string().min(1).max(255),
    prefix: z.string().max(512).default(""),
    access_key_id: z.string().min(1).max(128),
    secret_access_key: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal("sftp"),
    host: hostname,
    port: port.default(22),
    username: identifier,
    path: absolutePath,
    auth: z.discriminatedUnion("method", [
      z.object({ method: z.literal("password"), password: z.string().min(1).max(256) }),
      z.object({
        method: z.literal("key"),
        private_key: z.string().min(1).max(16384),
        passphrase: z.string().max(256).optional(),
      }),
    ]),
  }),
  z.object({
    kind: z.literal("local"),
    server_id: uuid,
    path: absolutePath,
  }),
]);
export type BackupDestinationTarget = z.infer<typeof backupDestinationTarget>;

export const createBackupDestinationInput = z.object({
  name: z.string().min(1).max(64),
  target: backupDestinationTarget,
});
export type CreateBackupDestinationInput = z.infer<typeof createBackupDestinationInput>;

export const updateBackupDestinationInput = z.object({
  name: z.string().min(1).max(64).optional(),
  /** Re-sending the target is how credentials rotate; `kind` may not change. */
  target: backupDestinationTarget.optional(),
});
export type UpdateBackupDestinationInput = z.infer<typeof updateBackupDestinationInput>;

/** Tests a saved destination, or a target still being typed into the form. */
export const testBackupDestinationInput = z
  .object({
    destination_id: uuid.optional(),
    target: backupDestinationTarget.optional(),
  })
  .refine((v) => Boolean(v.destination_id) !== Boolean(v.target), {
    path: ["destination_id"],
    message: "provide either a destination_id or a target, not both",
  });
export type TestBackupDestinationInput = z.infer<typeof testBackupDestinationInput>;

export const backupDestinationTestResult = z.object({
  ok: z.boolean(),
  writable: z.boolean(),
  latency_ms: z.number().int().nonnegative().nullable(),
  used_bytes: bytes.nullable(),
  error: z.string().nullable(),
  remediation: remediation.optional(),
  checked_at: isoDate,
});
export type BackupDestinationTestResult = z.infer<typeof backupDestinationTestResult>;

export const backupDestinationListQuery = listQuery.extend({
  kind: backupDestinationKind.optional(),
  status: backupDestinationStatus.optional(),
});
export type BackupDestinationListQuery = z.infer<typeof backupDestinationListQuery>;

/* ------------------------------------------------------------------ *
 * Schedules
 * ------------------------------------------------------------------ */

export const backupScope = z.object({
  kind: backupScopeKind,
  /**
   * What the kind selects: paths for `files`, database names for `databases`,
   * mail domains for `mail`. Empty means everything the kind covers.
   */
  selectors: z.array(z.string().min(1).max(1024)).default([]),
});
export type BackupScope = z.infer<typeof backupScope>;

/** Restic-style retention. All zeroes would prune every snapshot, so it is rejected. */
export const backupRetention = z
  .object({
    keep_last: z.number().int().min(0).max(1000),
    keep_daily: z.number().int().min(0).max(365),
    keep_weekly: z.number().int().min(0).max(520),
    keep_monthly: z.number().int().min(0).max(240),
  })
  .refine((r) => r.keep_last + r.keep_daily + r.keep_weekly + r.keep_monthly > 0, {
    message: "retention must keep at least one snapshot",
  });
export type BackupRetention = z.infer<typeof backupRetention>;

export const backupSchedule = z.object({
  id: uuid,
  name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  scope: z.array(backupScope),
  cron: cronExpression,
  timezone: z.string(),
  destination_id: uuid,
  destination_name: z.string(),
  retention: backupRetention,
  encryption: z.boolean(),
  enabled: z.boolean(),
  last_run_at: isoDate.nullable(),
  last_run_status: backupRunStatus.nullable(),
  last_run_id: uuid.nullable(),
  /** Null while the schedule is disabled. */
  next_run_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type BackupSchedule = z.infer<typeof backupSchedule>;

export const createBackupScheduleInput = z.object({
  name: z.string().min(1).max(64),
  server_id: uuid,
  scope: z.array(backupScope).min(1),
  cron: cronExpression,
  timezone: z.string().min(1).max(64).default("UTC"),
  destination_id: uuid,
  retention: backupRetention,
  encryption: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type CreateBackupScheduleInput = z.infer<typeof createBackupScheduleInput>;

/** A schedule belongs to the host it protects; re-targeting it is a new schedule. */
export const updateBackupScheduleInput = createBackupScheduleInput
  .omit({ server_id: true })
  .partial();
export type UpdateBackupScheduleInput = z.infer<typeof updateBackupScheduleInput>;

export const backupScheduleListQuery = listQuery.extend({
  server_id: uuid.optional(),
  destination_id: uuid.optional(),
  scope_kind: backupScopeKind.optional(),
  enabled: z.coerce.boolean().optional(),
  last_run_status: backupRunStatus.optional(),
});
export type BackupScheduleListQuery = z.infer<typeof backupScheduleListQuery>;

/* ------------------------------------------------------------------ *
 * Runs  (written by the job worker, never created by a client)
 * ------------------------------------------------------------------ */

export const backupTrigger = z.enum(["scheduled", "manual"]);
export type BackupTrigger = z.infer<typeof backupTrigger>;

export const backupRun = z.object({
  id: uuid,
  schedule_id: uuid,
  schedule_name: z.string(),
  server_id: uuid,
  server_name: z.string(),
  trigger: backupTrigger,
  status: backupRunStatus,
  bytes,
  files: z.number().int().nonnegative(),
  started_at: isoDate,
  finished_at: isoDate.nullable(),
  duration_ms: z.number().int().nullable(),
  job_id: uuid,
  error: z.string().nullable(),
  restore_point_id: uuid.nullable(),
});
export type BackupRun = z.infer<typeof backupRun>;

export const backupRunListQuery = listQuery.extend({
  schedule_id: uuid.optional(),
  server_id: uuid.optional(),
  destination_id: uuid.optional(),
  status: backupRunStatus.optional(),
  trigger: backupTrigger.optional(),
});
export type BackupRunListQuery = z.infer<typeof backupRunListQuery>;

/* ------------------------------------------------------------------ *
 * Restore points and restores
 * ------------------------------------------------------------------ */

export const restorePoint = z.object({
  id: uuid,
  run_id: uuid,
  schedule_id: uuid,
  server_id: uuid,
  server_name: z.string(),
  label: z.string(),
  taken_at: isoDate,
  bytes,
  file_count: z.number().int().nonnegative(),
  scope: z.array(backupScope),
  verified_at: isoDate.nullable(),
  /** When retention will prune it. Null means it is pinned. */
  expires_at: isoDate.nullable(),
});
export type RestorePoint = z.infer<typeof restorePoint>;

export const restorePointListQuery = listQuery.extend({
  server_id: uuid.optional(),
  schedule_id: uuid.optional(),
  scope_kind: backupScopeKind.optional(),
  verified: z.coerce.boolean().optional(),
});
export type RestorePointListQuery = z.infer<typeof restorePointListQuery>;

export const restoreInput = z.object({
  restore_point_id: uuid,
  target_server_id: uuid,
  target_path: absolutePath,
  /** Empty restores the whole restore point. */
  include: z.array(z.string().min(1).max(1024)).default([]),
  overwrite: z.boolean().default(false),
  /**
   * A restore writes over live data, so the operator retypes the restore point
   * label. Bind it with `restoreInputFor` to reject a mismatch before a job is
   * ever enqueued.
   */
  confirm_label: z.string().min(1).max(128),
});
export type RestoreInput = z.infer<typeof restoreInput>;

export function restoreInputFor(label: string) {
  return restoreInput.refine((v) => v.confirm_label === label, {
    path: ["confirm_label"],
    message: `must be exactly "${label}"`,
  });
}
