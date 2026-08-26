import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { ThreatKind } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { users } from "./identity";

/* ------------------------------------------------------------------ *
 * Firewall
 * ------------------------------------------------------------------ */

export const firewallRules = pgTable(
  "firewall_rules",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(100),
    action: text("action", { enum: ["allow", "deny", "reject"] }).notNull(),
    direction: text("direction", { enum: ["inbound", "outbound"] })
      .notNull()
      .default("inbound"),
    protocol: text("protocol", { enum: ["tcp", "udp", "icmp", "any"] })
      .notNull()
      .default("tcp"),
    portSpec: text("port_spec"),
    sourceCidr: text("source_cidr"),
    destCidr: text("dest_cidr"),
    comment: text("comment"),
    enabled: boolean("enabled").notNull().default(true),
    managedBy: text("managed_by", { enum: ["kaname", "external"] })
      .notNull()
      .default("kaname"),
    hitCount: bigint("hit_count", { mode: "number" }),
    ...timestamps,
  },
  (t) => [index("firewall_rules_server_idx").on(t.serverId, t.priority)],
);

export const firewallState = pgTable("firewall_state", {
  serverId: uuid("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  backend: text("backend").notNull().default("nftables"),
  enabled: boolean("enabled").notNull().default(false),
  defaultInbound: text("default_inbound", { enum: ["allow", "deny"] })
    .notNull()
    .default("deny"),
  defaultOutbound: text("default_outbound", { enum: ["allow", "deny"] })
    .notNull()
    .default("allow"),
  lastAppliedAt: ts("last_applied_at"),
  /** Set while a rule set is inside its lockout-rollback window. */
  pendingRollbackToken: text("pending_rollback_token"),
  pendingRollbackUntil: ts("pending_rollback_until"),
  updatedAt: timestamps.updatedAt,
});

/* ------------------------------------------------------------------ *
 * Threat protection — deliberately calm and factual, not gamified.
 * ------------------------------------------------------------------ */

export const threatEvents = pgTable(
  "threat_events",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ThreatKind>().notNull(),
    sourceIp: inet("source_ip").notNull(),
    sourceCountry: text("source_country"),
    sourceAsn: text("source_asn"),
    target: text("target").notNull().default(""),
    attempts: integer("attempts").notNull().default(1),
    firstSeen: ts("first_seen").notNull().defaultNow(),
    lastSeen: ts("last_seen").notNull().defaultNow(),
    disposition: text("disposition", { enum: ["observed", "banned", "ignored"] })
      .notNull()
      .default("observed"),
    sample: text("sample"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("threat_events_key").on(t.serverId, t.kind, t.sourceIp),
    index("threat_events_last_seen_idx").on(t.lastSeen),
  ],
);

export const ipBlocks = pgTable(
  "ip_blocks",
  {
    id: pk(),
    /** Null means fleet-wide. */
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
    cidr: text("cidr").notNull(),
    reason: text("reason").notNull().default(""),
    source: text("source", { enum: ["manual", "fail2ban", "rule"] })
      .notNull()
      .default("manual"),
    expiresAt: ts("expires_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("ip_blocks_server_idx").on(t.serverId),
    uniqueIndex("ip_blocks_key").on(t.serverId, t.cidr),
  ],
);

/* ------------------------------------------------------------------ *
 * SSH
 * ------------------------------------------------------------------ */

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: pk(),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    type: text("type").notNull(),
    comment: text("comment").notNull().default(""),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    serverIds: uuid("server_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    posixUser: text("posix_user").notNull().default("root"),
    lastUsedAt: ts("last_used_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("ssh_keys_fingerprint_key").on(t.fingerprint)],
);

export const sshConfigs = pgTable("ssh_configs", {
  serverId: uuid("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  port: integer("port").notNull().default(22),
  permitRootLogin: text("permit_root_login", {
    enum: ["yes", "no", "prohibit-password", "forced-commands-only"],
  })
    .notNull()
    .default("prohibit-password"),
  passwordAuthentication: boolean("password_authentication").notNull().default(false),
  pubkeyAuthentication: boolean("pubkey_authentication").notNull().default(true),
  maxAuthTries: integer("max_auth_tries").notNull().default(4),
  allowUsers: text("allow_users")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  allowGroups: text("allow_groups")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  x11Forwarding: boolean("x11_forwarding").notNull().default(false),
  lastAppliedAt: ts("last_applied_at"),
  pendingRollbackToken: text("pending_rollback_token"),
  pendingRollbackUntil: ts("pending_rollback_until"),
  lastSyncedAt: ts("last_synced_at"),
  updatedAt: timestamps.updatedAt,
});

export const sshSessions = pgTable(
  "ssh_sessions",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    user: text("user").notNull(),
    fromIp: inet("from_ip"),
    tty: text("tty"),
    pid: integer("pid"),
    startedAt: ts("started_at").notNull(),
    idleSeconds: integer("idle_seconds").notNull().default(0),
    endedAt: ts("ended_at"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
  },
  (t) => [index("ssh_sessions_server_idx").on(t.serverId, t.startedAt)],
);

/* ---------------------------- relations ---------------------------- */

export const firewallRulesRelations = relations(firewallRules, ({ one }) => ({
  server: one(servers, { fields: [firewallRules.serverId], references: [servers.id] }),
}));

export const threatEventsRelations = relations(threatEvents, ({ one }) => ({
  server: one(servers, { fields: [threatEvents.serverId], references: [servers.id] }),
}));
