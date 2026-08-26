import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DbEngine } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";

/* ------------------------------------------------------------------ *
 * Databases.
 *
 * Modelled as many databases per host with per-database credentials,
 * not one shared superuser connection — which matches how ForgeBase
 * already works and keeps the two conceptually compatible.
 * ------------------------------------------------------------------ */

export const dbInstances = pgTable(
  "db_instances",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    engine: text("engine").$type<DbEngine>().notNull(),
    version: text("version").notNull().default(""),
    host: text("host").notNull().default("127.0.0.1"),
    port: integer("port").notNull(),
    status: text("status", { enum: ["reachable", "unreachable", "degraded"] })
      .notNull()
      .default("unreachable"),
    uptimeSeconds: integer("uptime_seconds"),
    connections: integer("connections"),
    maxConnections: integer("max_connections"),
    dataSize: bigint("data_size", { mode: "number" }),
    /** Admin credential lives in `secrets`; only its ref is stored here. */
    adminSecretRef: text("admin_secret_ref"),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("db_instances_key").on(t.serverId, t.engine, t.port)],
);

export const dbDatabases = pgTable(
  "db_databases",
  {
    id: pk(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => dbInstances.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    engine: text("engine").$type<DbEngine>().notNull(),
    name: text("name").notNull(),
    owner: text("owner"),
    encoding: text("encoding").notNull().default("UTF8"),
    collation: text("collation"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    tableCount: integer("table_count").notNull().default(0),
    lastBackupAt: ts("last_backup_at"),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("db_databases_key").on(t.instanceId, t.name),
    index("db_databases_server_idx").on(t.serverId),
  ],
);

export const dbUsers = pgTable(
  "db_users",
  {
    id: pk(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => dbInstances.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    engine: text("engine").$type<DbEngine>().notNull(),
    username: text("username").notNull(),
    hostPattern: text("host_pattern").notNull().default("localhost"),
    authPlugin: text("auth_plugin"),
    canLogin: boolean("can_login").notNull().default(true),
    isSuperuser: boolean("is_superuser").notNull().default(false),
    secretRef: text("secret_ref"),
    lastUsedAt: ts("last_used_at"),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("db_users_key").on(t.instanceId, t.username, t.hostPattern)],
);

export const dbGrants = pgTable(
  "db_grants",
  {
    id: pk(),
    databaseId: uuid("database_id")
      .notNull()
      .references(() => dbDatabases.id, { onDelete: "cascade" }),
    dbUserId: uuid("db_user_id")
      .notNull()
      .references(() => dbUsers.id, { onDelete: "cascade" }),
    privileges: text("privileges")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    grantOption: boolean("grant_option").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("db_grants_key").on(t.databaseId, t.dbUserId)],
);

/* ---------------------------- relations ---------------------------- */

export const dbInstancesRelations = relations(dbInstances, ({ one, many }) => ({
  server: one(servers, { fields: [dbInstances.serverId], references: [servers.id] }),
  databases: many(dbDatabases),
  users: many(dbUsers),
}));

export const dbDatabasesRelations = relations(dbDatabases, ({ one, many }) => ({
  instance: one(dbInstances, { fields: [dbDatabases.instanceId], references: [dbInstances.id] }),
  grants: many(dbGrants),
}));

export const dbUsersRelations = relations(dbUsers, ({ one, many }) => ({
  instance: one(dbInstances, { fields: [dbUsers.instanceId], references: [dbInstances.id] }),
  grants: many(dbGrants),
}));

export const dbGrantsRelations = relations(dbGrants, ({ one }) => ({
  database: one(dbDatabases, { fields: [dbGrants.databaseId], references: [dbDatabases.id] }),
  user: one(dbUsers, { fields: [dbGrants.dbUserId], references: [dbUsers.id] }),
}));
