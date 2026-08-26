import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { JobStatus, JobType } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { users } from "./identity";

/* ------------------------------------------------------------------ *
 * Jobs — every host-touching mutation (KD-008).
 *
 * Claimed with FOR UPDATE SKIP LOCKED and held under a renewable lease,
 * so a crashed worker's job returns to the queue instead of vanishing.
 * ------------------------------------------------------------------ */

export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    type: text("type").$type<JobType>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),

    /** What the job acts on, for the activity feed and audit linkage. */
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),

    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<unknown>(),
    error: jsonb("error").$type<{ code: string; message: string; detail?: unknown } | null>(),

    progress: real("progress"),
    blockedReason: text("blocked_reason"),

    priority: integer("priority").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    timeoutMs: integer("timeout_ms").notNull().default(60_000),

    /** Fan-out: one operator action across N hosts shares a correlation id. */
    correlationId: uuid("correlation_id"),
    parentId: uuid("parent_id"),

    runAfter: ts("run_after").notNull().defaultNow(),
    leaseUntil: ts("lease_until"),
    leaseOwner: text("lease_owner"),
    expiresAt: ts("expires_at"),

    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    ...timestamps,
  },
  (t) => [
    /** The claim query's index: status + run_after + priority. */
    index("jobs_claim_idx")
      .on(t.status, t.runAfter, t.priority)
      .where(sql`${t.status} = 'queued'`),
    index("jobs_server_idx").on(t.serverId, t.createdAt),
    index("jobs_correlation_idx").on(t.correlationId),
    index("jobs_parent_idx").on(t.parentId),
    index("jobs_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const jobLogs = pgTable(
  "job_logs",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    ts: ts("ts").notNull().defaultNow(),
    level: text("level", { enum: ["debug", "info", "warn", "error"] })
      .notNull()
      .default("info"),
    message: text("message").notNull(),
  },
  (t) => [index("job_logs_job_idx").on(t.jobId, t.seq)],
);

/* ------------------------------------------------------------------ *
 * Terminal — ticketed, permissioned and recorded (KD-013)
 * ------------------------------------------------------------------ */

export const terminalSessions = pgTable(
  "terminal_sessions",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    userName: text("user_name").notNull(),
    posixUser: text("posix_user").notNull().default("root"),
    ticketHash: text("ticket_hash").notNull(),
    ip: inet("ip"),
    startedAt: ts("started_at"),
    endedAt: ts("ended_at"),
    durationMs: integer("duration_ms"),
    bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
    bytesOut: bigint("bytes_out", { mode: "number" }).notNull().default(0),
    commandCount: integer("command_count").notNull().default(0),
    recorded: boolean("recorded").notNull().default(true),
    expiresAt: ts("expires_at").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("terminal_sessions_ticket_key").on(t.ticketHash),
    index("terminal_sessions_server_idx").on(t.serverId, t.createdAt),
  ],
);

export const terminalRecordings = pgTable(
  "terminal_recordings",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => terminalSessions.id, { onDelete: "cascade" }),
    offsetMs: integer("offset_ms").notNull(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    data: text("data").notNull(),
  },
  (t) => [index("terminal_recordings_session_idx").on(t.sessionId, t.seq)],
);

/* ------------------------------------------------------------------ *
 * Settings, secrets and notification channels
 * ------------------------------------------------------------------ */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamps.updatedAt,
});

/**
 * Envelope encryption: each row holds its own AES-256-GCM data key,
 * itself wrapped with the KEK derived from KANAME_MASTER_KEY. Rotating
 * the master key rewraps DEKs without touching ciphertexts.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: pk(),
    ref: text("ref").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id"),
    wrappedKey: text("wrapped_key").notNull(),
    nonce: text("nonce").notNull(),
    ciphertext: text("ciphertext").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("secrets_ref_key").on(t.ref),
    index("secrets_owner_idx").on(t.ownerType, t.ownerId),
  ],
);

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: pk(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["email", "webhook", "slack"] }).notNull(),
    /** Endpoint/address only; credentials live in `secrets`. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secretRef: text("secret_ref"),
    events: text("events")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    lastDeliveryAt: ts("last_delivery_at"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("notification_channels_name_key").on(t.name)],
);

/* ---------------------------- relations ---------------------------- */

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  server: one(servers, { fields: [jobs.serverId], references: [servers.id] }),
  creator: one(users, { fields: [jobs.createdBy], references: [users.id] }),
  logs: many(jobLogs),
}));

export const jobLogsRelations = relations(jobLogs, ({ one }) => ({
  job: one(jobs, { fields: [jobLogs.jobId], references: [jobs.id] }),
}));

export const terminalSessionsRelations = relations(terminalSessions, ({ one, many }) => ({
  server: one(servers, { fields: [terminalSessions.serverId], references: [servers.id] }),
  user: one(users, { fields: [terminalSessions.userId], references: [users.id] }),
  recording: many(terminalRecordings),
}));
