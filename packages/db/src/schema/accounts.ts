import { sql } from "drizzle-orm";
import { index, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./common";
import { users } from "./identity";

/* ------------------------------------------------------------------ *
 * Scoped accounts: resellers and their clients (KD-039).
 *
 * There is still no tenant: no org_id, no per-tenant schema, nothing
 * billed. A reseller is a user, a client is a user with a `parent_id`,
 * and what either may touch is one row per resource in
 * `resource_owners`. Everything not listed there belongs to the
 * install, which is to say to its operators.
 * ------------------------------------------------------------------ */

/** The resource kinds that can be handed to a scoped account. */
export const RESOURCE_KINDS = ["site", "domain", "mailbox", "database"] as const;

/**
 * One owner per resource, keyed by kind + id rather than a column on
 * four tables: an unowned resource has no row, ownership moves without
 * touching the resource, and a new kind is a new enum value. There is
 * deliberately no foreign key to the resource (it is polymorphic), so
 * every reader joins the live table and a row that outlives its
 * resource counts for nothing.
 */
export const resourceOwners = pgTable(
  "resource_owners",
  {
    kind: text("kind", { enum: RESOURCE_KINDS }).notNull(),
    resourceId: uuid("resource_id").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.resourceId] }),
    index("resource_owners_owner_idx").on(t.ownerId, t.kind),
  ],
);

/**
 * What a scoped account may use. A null ceiling means "no limit of its
 * own" — a client is still held inside its reseller's. `server_ids` is
 * where a reseller may place new resources; clients inherit theirs.
 */
export const accountLimits = pgTable("account_limits", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  serverIds: uuid("server_ids")
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  maxSites: integer("max_sites"),
  maxDomains: integer("max_domains"),
  maxMailboxes: integer("max_mailboxes"),
  maxDatabases: integer("max_databases"),
  maxDiskMb: integer("max_disk_mb"),
  ...timestamps,
});

/** What a reseller's clients see in place of the install's own name. */
export const resellerBranding = pgTable("reseller_branding", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  /** Up to four characters drawn in the sidebar mark, e.g. "NW". */
  logoText: text("logo_text"),
  supportEmail: text("support_email"),
  supportUrl: text("support_url"),
  ...timestamps,
});
