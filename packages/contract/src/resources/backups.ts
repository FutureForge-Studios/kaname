import { z } from "zod";
import {
  absolutePath,
  bytes,
  cronExpression,
  hostname,
  identifier,
  isoDate,
  listQuery,
  queryBoolean,
  port,
  remediation,
  uuid,
} from "../primitives.js";
import { backupDestinationKind, backupRunStatus, backupScopeKind } from "../enums.js";
import { S3_PROVIDER_PRESETS, r2AccountId, s3Provider, s3Region } from "./s3-presets.js";

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
  /** S3 only: which provider preset filled it, and how buckets are addressed. */
  provider: s3Provider.nullable().default(null),
  path_style: z.boolean().nullable().default(null),
  prefix: z.string().nullable().default(null),
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
/** S3's bucket naming rules: 3-63 lowercase letters, digits, dots and hyphens. */
export const s3BucketName = z
  .string()
  .min(3, "bucket names are at least 3 characters")
  .max(63, "bucket names are at most 63 characters")
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "bucket names are lowercase letters, digits, dots and hyphens")
  .refine((v) => !/\.\./.test(v) && !/^\d+\.\d+\.\d+\.\d+$/.test(v), {
    message: "bucket names may not hold two dots in a row or look like an IP address",
  });

/** A key prefix inside the bucket: no leading slash, no traversal. */
export const s3Prefix = z
  .string()
  .max(512)
  .regex(/^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?\/?$/, "must be a relative path such as kaname/backups")
  .refine((v) => !v.split("/").includes(".."), { message: "may not contain .." });

const destinationTargetUnion = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("s3"),
    /** Which preset filled the form; "minio" is any other S3-compatible service. */
    provider: s3Provider.default("aws"),
    /** Host (or http(s) URL) of the service. Derived from the preset unless given. */
    endpoint: z
      .string()
      .max(255)
      .regex(/^(?:https?:\/\/)?[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/, "must be a host name or URL with no path")
      .optional(),
    region: s3Region.default("us-east-1"),
    /** Cloudflare R2 only: the account id in the endpoint's host name. */
    account_id: r2AccountId.optional(),
    bucket: s3BucketName,
    prefix: s3Prefix.default(""),
    /** Path-style (`host/bucket`) instead of virtual-hosted (`bucket.host`) addressing. */
    path_style: z.boolean().optional(),
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

/**
 * The provider rules a flat object cannot say: R2 needs its account id,
 * a custom service needs an endpoint, and a preset's region list is the
 * provider's own (B2 and MinIO regions are free text).
 */
export const backupDestinationTarget = destinationTargetUnion.superRefine((target, ctx) => {
  if (target.kind !== "s3") return;
  const preset = S3_PROVIDER_PRESETS[target.provider];
  if (preset.needs_account_id && !target.account_id && !target.endpoint) {
    ctx.addIssue({ code: "custom", path: ["account_id"], message: `${preset.label} needs the account id` });
  }
  if (!preset.derived_endpoint && !target.endpoint) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "an endpoint is required for this provider" });
  }
  if (preset.regions.length > 0 && !target.endpoint && !preset.regions.some((r) => r.value === target.region)) {
    ctx.addIssue({
      code: "custom",
      path: ["region"],
      message: `${preset.label} has no region "${target.region}"`,
    });
  }
});
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

/** Why a probe failed, in the terms an operator can act on. */
export const destinationProbeFailure = z.enum([
  "network",
  "auth",
  "bucket_missing",
  "region_mismatch",
  "clock_skew",
  "permission",
  "other",
]);
export type DestinationProbeFailure = z.infer<typeof destinationProbeFailure>;

export const destinationProbeCheck = z.object({
  step: z.enum(["connect", "write", "read", "delete"]),
  ok: z.boolean(),
  detail: z.string().nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
});
export type DestinationProbeCheck = z.infer<typeof destinationProbeCheck>;

export const backupDestinationTestResult = z.object({
  ok: z.boolean(),
  /** What failed, when something did. */
  failure: destinationProbeFailure.nullable().default(null),
  /** Each step of an object-store probe (write, read back, delete), in order. */
  checks: z.array(destinationProbeCheck).default([]),
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
  enabled: queryBoolean.optional(),
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
  verified: queryBoolean.optional(),
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

/* ------------------------------------------------------------------ *
 * App backups
 *
 * An `app` scope names app installs by id. A run captures, per install:
 * its directory under the managed apps root (or its site root for a
 * host-based recipe), a consistent dump of each companion SQL database
 * taken by the engine's own tool inside the install's labelled container
 * (`app.db_dump`), and a manifest. The manifest names the recipe, the
 * images and where the install's secrets live — refs only; the values
 * stay envelope-encrypted in the control plane and never enter the
 * repository.
 * ------------------------------------------------------------------ */

export const appBackupManifest = z.object({
  format: z.literal(1),
  install_id: uuid,
  app_id: z.string(),
  app_name: z.string(),
  /** The recipe version the install was running when the snapshot was taken. */
  app_version: z.string(),
  domain: z.string(),
  ssl: z.boolean(),
  server_id: uuid,
  source: z.enum(["image", "git"]),
  images: z.array(z.string()),
  companions: z.array(
    z.object({ role: z.string(), engine: z.string(), image: z.string(), dumped: z.boolean() }),
  ),
  /** What the person chose at install time. Never a credential. */
  settings: z.record(z.string(), z.unknown()),
  /** Names of the sealed secrets the install uses; never their values. */
  secret_refs: z.array(z.string()),
  /** Paths inside the snapshot, for a restore to find them without guessing. */
  paths: z.object({
    data: z.string().nullable(),
    dumps: z.array(z.object({ role: z.string(), engine: z.string(), path: z.string() })),
    site_root: z.string().nullable(),
    databases: z.array(z.object({ engine: z.string(), name: z.string() })),
  }),
  /** Whether the app container was stopped while the snapshot was taken. */
  stopped: z.boolean(),
  taken_at: isoDate,
});
export type AppBackupManifest = z.infer<typeof appBackupManifest>;

/** A restore point as one app sees it. */
export const appRestorePoint = restorePoint.extend({
  /** The app version inside, when the snapshot holds this app's manifest. */
  app_version: z.string().nullable(),
  /** Newer than the recipe Kaname would install now: such a point cannot be restored. */
  newer_than_recipe: z.boolean(),
});
export type AppRestorePoint = z.infer<typeof appRestorePoint>;

export const appBackupOverview = z.object({
  install_id: uuid,
  app_name: z.string(),
  domain: z.string(),
  /** The schedule "Back up now" runs: the one whose scope is exactly this app. */
  schedule: z
    .object({
      id: uuid,
      name: z.string(),
      destination_id: uuid,
      destination_name: z.string(),
      cron: z.string(),
      enabled: z.boolean(),
      next_run_at: isoDate.nullable(),
    })
    .nullable(),
  /** Every schedule whose scope includes this app, by name. */
  covered_by: z.array(z.object({ id: uuid, name: z.string() })),
  last_run: backupRun.nullable(),
  restore_points: z.array(appRestorePoint),
  /** Destinations a first "Back up now" may write to (names only). */
  destinations: z.array(z.object({ id: uuid, name: z.string(), kind: backupDestinationKind })),
  /** The app container is stopped for the few seconds the snapshot takes. */
  stop_during_backup: z.boolean(),
  /** Null when the app can be backed up; otherwise why not. */
  unsupported_reason: z.string().nullable(),
});
export type AppBackupOverview = z.infer<typeof appBackupOverview>;

export const appBackupNowInput = z.object({
  /** Needed only the first time, when no schedule for this app exists yet. */
  destination_id: uuid.optional(),
});
export type AppBackupNowInput = z.infer<typeof appBackupNowInput>;

/**
 * Restore in place: stop the app, restore its data into a staging
 * directory, swap it in, re-import each database, start, health check.
 * The person retypes the app's domain.
 */
export const appRestoreInput = z.object({
  restore_point_id: uuid,
  confirm_domain: z.string().min(1).max(253),
});
export type AppRestoreInput = z.infer<typeof appRestoreInput>;

/**
 * Restore as new: a fresh install of the same recipe on another server or
 * domain (its own port, site and certificate), the app's own secrets
 * copied across sealed, then the restore into it.
 */
export const appRestoreAsNewInput = z.object({
  restore_point_id: uuid,
  target_server_id: uuid,
  domain: z
    .string()
    .min(1)
    .max(253)
    .transform((v) => v.trim().toLowerCase()),
  ssl: z.boolean().default(true),
  /** Retype the SOURCE app's domain: what is being copied. */
  confirm_domain: z.string().min(1).max(253),
});
export type AppRestoreAsNewInput = z.infer<typeof appRestoreAsNewInput>;

/**
 * Whether `backup` (a version string from a manifest) is newer than
 * `recipe`. Dotted numbers compare numerically; anything else ("stable")
 * is only ever equal to itself, and an unequal pair of non-numeric
 * versions is treated as newer, so an unknown line is refused rather than
 * downgraded onto.
 */
export function isNewerVersion(backup: string, recipe: string): boolean {
  if (backup === recipe) return false;
  const parse = (v: string) => (/^v?\d+(\.\d+)*$/.test(v) ? v.replace(/^v/, "").split(".").map(Number) : null);
  const a = parse(backup);
  const b = parse(recipe);
  if (!a || !b) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
