import { relations } from "drizzle-orm";
import { bigint, boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  MailCertificateStatus,
  MailCheck,
  MailCheckStatus,
  MailDnsRecord,
  MailInstallStep,
  MailRelayProvider,
  MailSendingMode,
  MailServerStatus,
  MailServiceState,
} from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { servers } from "./fleet";
import { domains } from "./web";

/* ------------------------------------------------------------------ *
 * Mail: Yunori Mail Server on a managed host (KD-023).
 *
 * The host is authoritative for everything below. These rows exist so
 * the fleet view can list, count and search without fanning out to
 * every host (KD-012), and `last_synced_at` says how stale they are. A
 * sync re-reads the host and reconciles; nothing here is a source the
 * host is written from.
 *
 * There is deliberately no column for a credential anywhere: mailbox
 * passwords and relay secrets cross one response and are gone.
 * ------------------------------------------------------------------ */

export const mailServers = pgTable(
  "mail_servers",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    /** Kaname's lifecycle; the host's own view is `install_complete` and `steps`. */
    status: text("status").$type<MailServerStatus>().notNull().default("not_installed"),
    version: text("version"),
    installComplete: boolean("install_complete").notNull().default(false),
    hostname: text("hostname"),
    primaryDomain: text("primary_domain"),
    adminEmail: text("admin_email"),
    sendingMode: text("sending_mode").$type<MailSendingMode>(),
    relayProvider: text("relay_provider").$type<MailRelayProvider>(),
    consoleUrl: text("console_url"),
    steps: jsonb("steps").$type<MailInstallStep[]>().notNull().default([]),
    services: jsonb("services").$type<MailServiceState[]>().notNull().default([]),
    /** The last `yunori-mail doctor` run, verbatim. */
    checks: jsonb("checks").$type<MailCheck[]>().notNull().default([]),
    /** Worst status across `checks`, denormalised so lists can filter on it. */
    health: text("health").$type<MailCheckStatus>().notNull().default("unknown"),
    certificate: jsonb("certificate").$type<MailCertificateStatus | null>(),
    lastError: text("last_error"),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_servers_server_key").on(t.serverId)],
);

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
    mailServerId: uuid("mail_server_id")
      .notNull()
      .references(() => mailServers.id, { onDelete: "cascade" }),
    /** The domain the server was installed with. */
    isPrimary: boolean("is_primary").notNull().default(false),
    status: text("status", { enum: ["active", "provisioning", "removing", "error"] })
      .notNull()
      .default("provisioning"),
    /** Worst status over the required records of the last DNS check. */
    dnsStatus: text("dns_status").$type<MailCheckStatus>().notNull().default("unknown"),
    dnsCheckedAt: ts("dns_checked_at"),
    dnsRecords: jsonb("dns_records").$type<MailDnsRecord[]>().notNull().default([]),
    /** BIND-style zone data from the host, for "copy all". */
    zoneFile: text("zone_file").notNull().default(""),
    lastSyncedAt: ts("last_synced_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mail_domains_domain_key").on(t.domainId),
    index("mail_domains_mail_server_idx").on(t.mailServerId),
  ],
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
    /** 0 means unlimited. */
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull().default(0),
    status: text("status", { enum: ["active", "removing", "error"] })
      .notNull()
      .default("active"),
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
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    /** Null when the target mailbox is one Kaname has no row for (yet). */
    mailboxId: uuid("mailbox_id").references(() => mailboxes.id, { onDelete: "set null" }),
    /** Kept beside the id so the alias still reads after a mailbox row goes. */
    mailboxAddress: text("mailbox_address").notNull(),
    status: text("status", { enum: ["active", "removing", "error"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("mail_aliases_address_key").on(t.address),
    index("mail_aliases_domain_idx").on(t.mailDomainId),
  ],
);

/* ---------------------------- relations ---------------------------- */

export const mailServersRelations = relations(mailServers, ({ one, many }) => ({
  server: one(servers, { fields: [mailServers.serverId], references: [servers.id] }),
  domains: many(mailDomains),
}));

export const mailDomainsRelations = relations(mailDomains, ({ one, many }) => ({
  domain: one(domains, { fields: [mailDomains.domainId], references: [domains.id] }),
  server: one(servers, { fields: [mailDomains.serverId], references: [servers.id] }),
  mailServer: one(mailServers, {
    fields: [mailDomains.mailServerId],
    references: [mailServers.id],
  }),
  mailboxes: many(mailboxes),
  aliases: many(mailAliases),
}));

export const mailboxesRelations = relations(mailboxes, ({ one, many }) => ({
  mailDomain: one(mailDomains, { fields: [mailboxes.mailDomainId], references: [mailDomains.id] }),
  aliases: many(mailAliases),
}));

export const mailAliasesRelations = relations(mailAliases, ({ one }) => ({
  mailDomain: one(mailDomains, { fields: [mailAliases.mailDomainId], references: [mailDomains.id] }),
  mailbox: one(mailboxes, { fields: [mailAliases.mailboxId], references: [mailboxes.id] }),
}));
