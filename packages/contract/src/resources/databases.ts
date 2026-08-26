import { z } from "zod";
import { absolutePath, bytes, identifier, isoDate, listQuery, port, uuid } from "../primitives.js";
import { dbEngine, dbPrivilege } from "../enums.js";

/* ------------------------------------------------------------------ *
 * Instances
 *
 * A host may run several engines side by side, and each engine holds
 * many databases with their own users. Nothing here assumes a single
 * shared instance with one god credential.
 * ------------------------------------------------------------------ */

export const dbInstanceStatus = z.enum(["reachable", "unreachable", "degraded"]);
export type DbInstanceStatus = z.infer<typeof dbInstanceStatus>;

export const dbInstance = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  engine: dbEngine,
  version: z.string(),
  host: z.string(),
  port,
  status: dbInstanceStatus,
  uptime_seconds: z.number().int().nonnegative().nullable(),
  connections: z.number().int().nonnegative().nullable(),
  max_connections: z.number().int().nonnegative().nullable(),
  data_size: bytes.nullable(),
  database_count: z.number().int().nonnegative(),
  user_count: z.number().int().nonnegative(),
  /** How stale this row is. Surfaced in the UI, never hidden (KD-012). */
  last_synced_at: isoDate,
  created_at: isoDate,
  updated_at: isoDate,
});
export type DbInstance = z.infer<typeof dbInstance>;

export const dbInstanceListQuery = listQuery.extend({
  server_id: uuid.optional(),
  engine: dbEngine.optional(),
  status: dbInstanceStatus.optional(),
});
export type DbInstanceListQuery = z.infer<typeof dbInstanceListQuery>;

/* ------------------------------------------------------------------ *
 * Databases
 * ------------------------------------------------------------------ */

/** A user as it appears on a database row, so the detail page needs one query. */
export const databaseUserRef = z.object({
  id: uuid,
  username: z.string(),
  privileges: z.array(dbPrivilege),
});
export type DatabaseUserRef = z.infer<typeof databaseUserRef>;

export const database = z.object({
  id: uuid,
  instance_id: uuid,
  server_id: uuid,
  server_name: z.string(),
  engine: dbEngine,
  name: z.string(),
  owner: z.string().nullable(),
  encoding: z.string(),
  collation: z.string().nullable(),
  size_bytes: bytes,
  table_count: z.number().int().nonnegative(),
  /**
   * Placeholders only, e.g. "mysql://{user}:{password}@127.0.0.1:3306/shop".
   * Credentials live envelope-encrypted in db_credentials and are never
   * denormalised onto a list row.
   */
  connection_string_template: z.string(),
  users: z.array(databaseUserRef),
  last_backup_at: isoDate.nullable(),
  last_synced_at: isoDate,
  created_at: isoDate,
  updated_at: isoDate,
});
export type Database = z.infer<typeof database>;

export const createDatabaseInput = z.object({
  instance_id: uuid,
  engine: dbEngine,
  name: identifier,
  owner: identifier.optional(),
  /** Omitted means the engine default (utf8mb4 on MySQL, UTF8 on Postgres). */
  encoding: z.string().max(32).optional(),
  collation: z.string().max(64).optional(),
  /** Provisions a dedicated user in the same job, so a database is never born shared. */
  create_user: z
    .object({
      username: identifier,
      password: z.string().min(16).max(256),
      host_pattern: z.string().max(64).default("localhost"),
      privileges: z.array(dbPrivilege).min(1).default(["ALL"]),
    })
    .optional(),
});
export type CreateDatabaseInput = z.infer<typeof createDatabaseInput>;

/** Only ownership moves in place; a rename is a dump and restore under a new name. */
export const updateDatabaseInput = z.object({ owner: identifier }).partial();
export type UpdateDatabaseInput = z.infer<typeof updateDatabaseInput>;

export const databaseListQuery = listQuery.extend({
  server_id: uuid.optional(),
  instance_id: uuid.optional(),
  engine: dbEngine.optional(),
});
export type DatabaseListQuery = z.infer<typeof databaseListQuery>;

/* ------------------------------------------------------------------ *
 * Users and grants
 * ------------------------------------------------------------------ */

export const dbGrant = z.object({
  database_id: uuid,
  database_name: z.string(),
  privileges: z.array(dbPrivilege),
  grant_option: z.boolean(),
});
export type DbGrant = z.infer<typeof dbGrant>;

export const dbUser = z.object({
  id: uuid,
  instance_id: uuid,
  server_id: uuid,
  server_name: z.string(),
  engine: dbEngine,
  username: z.string(),
  host_pattern: z.string(),
  auth_plugin: z.string().nullable(),
  can_login: z.boolean(),
  is_superuser: z.boolean(),
  grants: z.array(dbGrant),
  last_used_at: isoDate.nullable(),
  last_synced_at: isoDate,
  created_at: isoDate,
  updated_at: isoDate,
});
export type DbUser = z.infer<typeof dbUser>;

export const grantInput = z.object({
  database_id: uuid,
  privileges: z.array(dbPrivilege).min(1),
  grant_option: z.boolean().default(false),
});
export type GrantInput = z.infer<typeof grantInput>;

export const createDbUserInput = z.object({
  instance_id: uuid,
  username: identifier,
  password: z.string().min(16).max(256),
  host_pattern: z.string().max(64).default("localhost"),
  can_login: z.boolean().default(true),
  grants: z.array(grantInput).max(64).default([]),
});
export type CreateDbUserInput = z.infer<typeof createDbUserInput>;

/** Identity is immutable: renaming a user is a drop and create, and is audited as such. */
export const updateDbUserInput = createDbUserInput
  .omit({ instance_id: true, username: true })
  .partial();
export type UpdateDbUserInput = z.infer<typeof updateDbUserInput>;

/** Replaces the whole grant set — a database absent from the list loses access. */
export const applyGrantsInput = z.object({
  grants: z.array(grantInput).max(64),
});
export type ApplyGrantsInput = z.infer<typeof applyGrantsInput>;

export const dbUserListQuery = listQuery.extend({
  server_id: uuid.optional(),
  instance_id: uuid.optional(),
  engine: dbEngine.optional(),
  database_id: uuid.optional(),
  can_login: z.coerce.boolean().optional(),
});
export type DbUserListQuery = z.infer<typeof dbUserListQuery>;

/* ------------------------------------------------------------------ *
 * Dump and restore
 * ------------------------------------------------------------------ */

export const dumpDatabaseInput = z.object({
  destination: absolutePath,
  compress: z.boolean().default(true),
});
export type DumpDatabaseInput = z.infer<typeof dumpDatabaseInput>;

export const restoreDatabaseInput = z
  .object({
    source: absolutePath,
    /** The target as the client believes it to be named; the route rechecks it against the row. */
    database_name: identifier,
    drop_existing: z.boolean().default(false),
    /** Typed confirmation. A restore overwrites live data, so it is never one click. */
    confirm_name: z.string().min(1).max(63),
  })
  .refine((input) => input.confirm_name === input.database_name, {
    message: "confirmation must match the database name exactly",
    path: ["confirm_name"],
  });
export type RestoreDatabaseInput = z.infer<typeof restoreDatabaseInput>;
