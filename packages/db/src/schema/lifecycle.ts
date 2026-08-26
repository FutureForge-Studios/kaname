import { relations } from "drizzle-orm";
import { boolean, index, inet, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ComponentKind, UpdateRunStatus } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { users } from "./identity";
import { jobs } from "./platform";

/* ------------------------------------------------------------------ *
 * Install-time setup and the update history.
 * ------------------------------------------------------------------ */

/**
 * Written by the installer and printed once in its final output. It is
 * what gates onboarding on a freshly-installed box that is reachable
 * before anyone has created an account — without it, the first person
 * to find the port owns the fleet.
 */
export const setupTokens = pgTable(
  "setup_tokens",
  {
    id: pk(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at"),
    usedAt: ts("used_at"),
    usedIp: inet("used_ip"),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("setup_tokens_hash_key").on(t.tokenHash)],
);

export const updateRuns = pgTable(
  "update_runs",
  {
    id: pk(),
    kind: text("kind").$type<ComponentKind>().notNull(),
    /** Null for the control plane, set for an agent rollout. */
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
    fromVersion: text("from_version").notNull(),
    toVersion: text("to_version").notNull(),
    status: text("status").$type<UpdateRunStatus>().notNull().default("queued"),
    trigger: text("trigger", { enum: ["manual", "scheduled", "onboarding"] })
      .notNull()
      .default("manual"),
    breaking: boolean("breaking").notNull().default(false),
    /** Full stdout/stderr. A success boolean is not enough to debug from. */
    log: text("log").notNull().default(""),
    error: text("error"),
    rolledBack: boolean("rolled_back").notNull().default(false),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedByName: text("started_by_name"),
    ...timestamps,
  },
  (t) => [
    index("update_runs_kind_idx").on(t.kind, t.createdAt),
    index("update_runs_server_idx").on(t.serverId, t.createdAt),
    index("update_runs_status_idx").on(t.status),
  ],
);

export const updateRunsRelations = relations(updateRuns, ({ one }) => ({
  server: one(servers, { fields: [updateRuns.serverId], references: [servers.id] }),
  job: one(jobs, { fields: [updateRuns.jobId], references: [jobs.id] }),
  startedByUser: one(users, { fields: [updateRuns.startedBy], references: [users.id] }),
}));
