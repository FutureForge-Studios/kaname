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
import type { BackupRunStatus } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { users } from "./identity";
import { jobs } from "./platform";

/* ------------------------------------------------------------------ *
 * Backups.
 *
 * Destination credentials never live in these tables — only a ref into
 * `secrets`. What is stored here is what the operator needs to see.
 * ------------------------------------------------------------------ */

export const backupDestinations = pgTable(
  "backup_destinations",
  {
    id: pk(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["s3", "b2", "sftp", "local"] }).notNull(),
    /** Redacted summary: endpoint, bucket, prefix, host, path. No secrets. */
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    secretRef: text("secret_ref"),
    status: text("status", { enum: ["ok", "unreachable", "untested"] })
      .notNull()
      .default("untested"),
    lastCheckedAt: ts("last_checked_at"),
    lastError: text("last_error"),
    usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
    snapshotCount: integer("snapshot_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("backup_destinations_name_key").on(t.name)],
);

export const backupSchedules = pgTable(
  "backup_schedules",
  {
    id: pk(),
    name: text("name").notNull(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    scope: jsonb("scope").$type<{ kind: string; selectors: string[] }[]>().notNull().default([]),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => backupDestinations.id, { onDelete: "restrict" }),
    retention: jsonb("retention")
      .$type<{ keep_last: number; keep_daily: number; keep_weekly: number; keep_monthly: number }>()
      .notNull()
      .default({ keep_last: 7, keep_daily: 7, keep_weekly: 4, keep_monthly: 6 }),
    encryption: boolean("encryption").notNull().default(true),
    repositoryPath: text("repository_path").notNull(),
    passwordRef: text("password_ref"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: ts("last_run_at"),
    lastRunStatus: text("last_run_status").$type<BackupRunStatus>(),
    nextRunAt: ts("next_run_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("backup_schedules_name_key").on(t.name),
    index("backup_schedules_next_run_idx")
      .on(t.nextRunAt)
      .where(sql`${t.enabled}`),
  ],
);

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: pk(),
    scheduleId: uuid("schedule_id").references(() => backupSchedules.id, { onDelete: "set null" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["scheduled", "manual"] })
      .notNull()
      .default("scheduled"),
    status: text("status").$type<BackupRunStatus>().notNull().default("queued"),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    files: integer("files").notNull().default(0),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    error: text("error"),
    restorePointId: uuid("restore_point_id"),
    triggeredBy: uuid("triggered_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("backup_runs_schedule_idx").on(t.scheduleId, t.createdAt)],
);

export const restorePoints = pgTable(
  "restore_points",
  {
    id: pk(),
    runId: uuid("run_id")
      .notNull()
      .references(() => backupRuns.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id").references(() => backupSchedules.id, { onDelete: "set null" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    takenAt: ts("taken_at").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    scope: jsonb("scope").$type<{ kind: string; selectors: string[] }[]>().notNull().default([]),
    verifiedAt: ts("verified_at"),
    expiresAt: ts("expires_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("restore_points_snapshot_key").on(t.serverId, t.snapshotId),
    index("restore_points_taken_idx").on(t.takenAt),
  ],
);

/* ---------------------------- relations ---------------------------- */

export const backupSchedulesRelations = relations(backupSchedules, ({ one, many }) => ({
  server: one(servers, { fields: [backupSchedules.serverId], references: [servers.id] }),
  destination: one(backupDestinations, {
    fields: [backupSchedules.destinationId],
    references: [backupDestinations.id],
  }),
  runs: many(backupRuns),
}));

export const backupRunsRelations = relations(backupRuns, ({ one, many }) => ({
  schedule: one(backupSchedules, {
    fields: [backupRuns.scheduleId],
    references: [backupSchedules.id],
  }),
  restorePoints: many(restorePoints),
}));

export const restorePointsRelations = relations(restorePoints, ({ one }) => ({
  run: one(backupRuns, { fields: [restorePoints.runId], references: [backupRuns.id] }),
}));
