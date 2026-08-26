import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DiskUsage } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { sshKeys } from "./security";

/* ------------------------------------------------------------------ *
 * FTP / SFTP accounts and storage sampling.
 *
 * The file manager itself is stateless — it reads through the agent and
 * caches nothing, because a stale directory listing is worse than a
 * slow one. Only accounts and usage samples are persisted.
 * ------------------------------------------------------------------ */

export const ftpAccounts = pgTable(
  "ftp_accounts",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    protocol: text("protocol", { enum: ["sftp", "ftps"] })
      .notNull()
      .default("sftp"),
    homeDir: text("home_dir").notNull(),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull().default(0),
    usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
    status: text("status", { enum: ["active", "suspended", "provisioning", "error"] })
      .notNull()
      .default("provisioning"),
    /** Password lives in `secrets`; key auth points at an ssh_keys row. */
    secretRef: text("secret_ref"),
    sshKeyId: uuid("ssh_key_id").references(() => sshKeys.id, { onDelete: "set null" }),
    chroot: text("chroot"),
    lastLoginAt: ts("last_login_at"),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("ftp_accounts_key").on(t.serverId, t.username)],
);

export const storageSamples = pgTable(
  "storage_samples",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    sampledAt: ts("sampled_at").notNull().defaultNow(),
    total: bigint("total", { mode: "number" }).notNull(),
    used: bigint("used", { mode: "number" }).notNull(),
    available: bigint("available", { mode: "number" }).notNull(),
    mounts: jsonb("mounts").$type<DiskUsage[]>().notNull().default([]),
    categories: jsonb("categories")
      .$type<{ label: string; path: string; bytes: number; kind: string }[]>()
      .notNull()
      .default([]),
    largest: jsonb("largest")
      .$type<{ path: string; bytes: number; kind: string; modified_at: string }[]>()
      .notNull()
      .default([]),
    inodesTotal: bigint("inodes_total", { mode: "number" }),
    inodesUsed: bigint("inodes_used", { mode: "number" }),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("storage_samples_server_idx").on(t.serverId, t.sampledAt)],
);

export const ftpAccountsRelations = relations(ftpAccounts, ({ one }) => ({
  server: one(servers, { fields: [ftpAccounts.serverId], references: [servers.id] }),
  sshKey: one(sshKeys, { fields: [ftpAccounts.sshKeyId], references: [sshKeys.id] }),
}));
