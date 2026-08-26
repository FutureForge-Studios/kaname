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
import type { CheckStatus, MailAuthCheck, Remediation } from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { domains } from "./web";

/* ------------------------------------------------------------------ *
 * Mail domains, mailboxes, routing.
 * ------------------------------------------------------------------ */

export const mailDomains = pgTable(
  "mail_domains",
  {
    id: pk(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    /** The HELO / MX hostname, which is NOT the apex and needs its own SPF. */
    mailHostname: text("mail_hostname").notNull(),
    status: text("status", { enum: ["active", "provisioning", "error", "disabled"] })
      .notNull()
      .default("provisioning"),
    dkimSelector: text("dkim_selector").notNull().default("default"),
    dkimPublicKey: text("dkim_public_key"),
    catchallTarget: text("catchall_target"),
    quotaTotal: bigint("quota_total", { mode: "number" }).notNull().default(0),
    lastAuthCheckAt: ts("last_auth_check_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_domains_domain_key").on(t.domainId)],
);

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: pk(),
    mailDomainId: uuid("mail_domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    localPart: text("local_part").notNull(),
    displayName: text("display_name"),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull().default(0),
    usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    status: text("status", { enum: ["active", "suspended", "provisioning", "error"] })
      .notNull()
      .default("provisioning"),
    lastLoginAt: ts("last_login_at"),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mailboxes_address_key").on(t.address),
    index("mailboxes_domain_idx").on(t.mailDomainId),
  ],
);

export const mailAliases = pgTable(
  "mail_aliases",
  {
    id: pk(),
    mailDomainId: uuid("mail_domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    destinations: text("destinations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    comment: text("comment"),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_aliases_address_key").on(t.address)],
);

export const mailForwarders = pgTable(
  "mail_forwarders",
  {
    id: pk(),
    mailDomainId: uuid("mail_domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    destination: text("destination").notNull(),
    keepCopy: boolean("keep_copy").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_forwarders_key").on(t.source, t.destination)],
);

/* ------------------------------------------------------------------ *
 * DNS authentication.
 *
 * This is where real mail setups break, so each result carries a
 * human remediation rather than a raw record dump (PLAN.md section 7).
 * ------------------------------------------------------------------ */

export const mailAuthChecks = pgTable(
  "mail_auth_checks",
  {
    id: pk(),
    mailDomainId: uuid("mail_domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "cascade" }),
    check: text("check").$type<MailAuthCheck>().notNull(),
    status: text("status").$type<CheckStatus>().notNull().default("unknown"),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    expected: text("expected"),
    actual: text("actual"),
    remediation: jsonb("remediation").$type<Remediation | null>(),
    resolverUsed: text("resolver_used"),
    durationMs: integer("duration_ms"),
    checkedAt: ts("checked_at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_auth_checks_key").on(t.mailDomainId, t.check)],
);

export const mailLogEntries = pgTable(
  "mail_log_entries",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    ts: ts("ts").notNull(),
    queueId: text("queue_id"),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    fromAddress: text("from_address").notNull(),
    toAddresses: text("to_addresses")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject"),
    status: text("status").notNull(),
    relay: text("relay"),
    delaySeconds: integer("delay_seconds"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    dsn: text("dsn"),
    message: text("message").notNull().default(""),
  },
  (t) => [
    index("mail_log_server_ts_idx").on(t.serverId, t.ts),
    index("mail_log_queue_idx").on(t.queueId),
  ],
);

/* ---------------------------- relations ---------------------------- */

export const mailDomainsRelations = relations(mailDomains, ({ one, many }) => ({
  domain: one(domains, { fields: [mailDomains.domainId], references: [domains.id] }),
  server: one(servers, { fields: [mailDomains.serverId], references: [servers.id] }),
  mailboxes: many(mailboxes),
  aliases: many(mailAliases),
  forwarders: many(mailForwarders),
  checks: many(mailAuthChecks),
}));

export const mailboxesRelations = relations(mailboxes, ({ one }) => ({
  mailDomain: one(mailDomains, { fields: [mailboxes.mailDomainId], references: [mailDomains.id] }),
}));
