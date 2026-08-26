import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { GrantScope, Permission } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";

/* ------------------------------------------------------------------ *
 * Users, roles, sessions, API keys, audit.
 * ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** argon2id. Null for an invited user who has not set one yet. */
    passwordHash: text("password_hash"),
    /** Envelope-encrypted TOTP secret; never readable in a query result. */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    recoveryCodesEnc: text("recovery_codes_enc"),
    status: text("status", { enum: ["active", "invited", "suspended"] })
      .notNull()
      .default("invited"),
    inviteTokenHash: text("invite_token_hash"),
    inviteExpiresAt: ts("invite_expires_at"),
    lastLoginAt: ts("last_login_at"),
    lastLoginIp: inet("last_login_ip"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: ts("locked_until"),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_key").on(sql`lower(${t.email})`)],
);

export const roles = pgTable(
  "roles",
  {
    id: pk(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    /** System roles cannot be deleted; Owner additionally cannot be edited. */
    isSystem: boolean("is_system").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("roles_slug_key").on(t.slug)],
);

export const roleGrants = pgTable(
  "role_grants",
  {
    id: pk(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").$type<Permission>().notNull(),
    /** "global" or an explicit server list — never an implicit all. */
    scope: jsonb("scope").$type<GrantScope>().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("role_grants_role_idx").on(t.roleId),
    uniqueIndex("role_grants_unique").on(t.roleId, t.permission),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    /** Set once TOTP has been satisfied for this session. */
    mfaSatisfiedAt: ts("mfa_satisfied_at"),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("sessions_token_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
    index("sessions_expiry_idx").on(t.expiresAt),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: pk(),
    name: text("name").notNull(),
    /** Visible identifier, e.g. "kn_live_7f2c". The secret half is hashed. */
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    /** Always a subset of the creator's own grants — never a superset. */
    scopes: jsonb("scopes").$type<Permission[]>().notNull().default([]),
    scopeKind: text("scope_kind", { enum: ["global", "servers"] })
      .notNull()
      .default("global"),
    scopeServerIds: uuid("scope_server_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    expiresAt: ts("expires_at"),
    lastUsedAt: ts("last_used_at"),
    lastUsedIp: inet("last_used_ip"),
    revokedAt: ts("revoked_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("api_keys_prefix_key").on(t.prefix),
    index("api_keys_created_by_idx").on(t.createdBy),
  ],
);

/* ------------------------------------------------------------------ *
 * Audit — append-only and hash-chained (KD-009).
 *
 * The migration adds a rule that rejects UPDATE and DELETE on this
 * table, so tampering requires database superuser access and is still
 * detectable via the chain.
 * ------------------------------------------------------------------ */

export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    /** Monotonic ordering that survives identical timestamps, and defines chain order. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    ts: ts("ts").notNull().defaultNow(),
    actorType: text("actor_type", { enum: ["user", "api_key", "agent", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    targetLabel: text("target_label").notNull().default(""),
    serverId: uuid("server_id"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** { before, after } with secret-bearing keys already redacted. */
    diff: jsonb("diff").$type<{ before: unknown; after: unknown } | null>(),
    jobId: uuid("job_id"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("audit_ts_idx").on(t.ts),
    index("audit_actor_idx").on(t.actorType, t.actorId),
    index("audit_target_idx").on(t.targetType, t.targetId),
    index("audit_server_idx").on(t.serverId),
    uniqueIndex("audit_hash_key").on(t.hash),
  ],
);

/* ---------------------------- relations ---------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  roles: many(userRoles),
  sessions: many(sessions),
  apiKeys: many(apiKeys),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  grants: many(roleGrants),
  users: many(userRoles),
}));

export const roleGrantsRelations = relations(roleGrants, ({ one }) => ({
  role: one(roles, { fields: [roleGrants.roleId], references: [roles.id] }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
