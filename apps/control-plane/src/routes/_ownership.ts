import type { FastifyRequest } from "fastify";
import { and, eq, inArray, sql, type Database, type SQL } from "@kaname/db";
import type { PgColumn } from "drizzle-orm/pg-core";
import { accountLimits, resourceOwners, users } from "@kaname/db/schema";
import {
  QUOTA_FIELDS,
  RESOURCE_KIND_LABELS,
  UNLIMITED_QUOTA,
  type AccountQuota,
  type QuotaUsage,
  type ResourceKind,
} from "@kaname/contract";
import { ApiException, notFound } from "../lib/errors.js";
import { helpers } from "../http/plugin.js";
import type { ScopedAccount } from "../services/auth.js";

/* ------------------------------------------------------------------ *
 * Ownership scoping for resellers and clients (KD-039).
 *
 * RBAC answers "may this principal use this permission on this
 * server". For an operator that is the whole question. For a reseller
 * or client it is half of it: two clients on one server hold the same
 * permission there, and must still never see each other's sites.
 *
 * So a scoped account's grants are inert until a route calls
 * `ownership(req)`. That call is the route saying "I filter by owner",
 * and it hands back the only tools for doing so:
 *
 *   filter(kind, column)   WHERE clause for a list
 *   assertOwns(kind, id)   a 404 for anything that is not theirs
 *   reserve(kind)          quota check before a create
 *   claim(kind, id)        record the new resource as theirs
 *
 * A route that never calls it refuses scoped accounts outright, which
 * is what keeps every infrastructure, security and administration
 * route operator-only without touching them. For an operator every
 * method here is a no-op.
 * ------------------------------------------------------------------ */

export interface Ownership {
  /** True for a reseller or client; false for an operator or API key. */
  readonly restricted: boolean;
  readonly account: ScopedAccount | null;
  /** Restricts a list to resources the caller owns. Null for an operator. */
  filter(kind: ResourceKind, idColumn: PgColumn): SQL | null;
  /** Throws a 404 unless the caller owns it. Never says "exists but not yours". */
  assertOwns(kind: ResourceKind, resourceId: string, what?: string): Promise<void>;
  /** Throws `quota_exceeded` unless there is room for `count` more, and `diskMb` more disk. */
  reserve(kind: ResourceKind, count?: number, diskMb?: number): Promise<void>;
  /** Records a resource the caller just created as theirs. */
  claim(kind: ResourceKind, resourceId: string): Promise<void>;
}

const OPERATOR: Ownership = {
  restricted: false,
  account: null,
  filter: () => null,
  assertOwns: async () => {},
  reserve: async () => {},
  claim: async () => {},
};

/**
 * Opts this request in to ownership scoping. Call it first in a
 * handler, before anything authorises: only after it do a scoped
 * account's grants count.
 */
export function ownership(req: FastifyRequest): Ownership {
  const principal = helpers(req).requirePrincipal();
  const account = principal.scoped;
  if (!account) return OPERATOR;

  req.ownershipScoped = true;
  const db = req.ctx.db;

  return {
    restricted: true,
    account,
    filter: (kind, idColumn) => ownedBy(kind, idColumn, account.ownerIds),

    async assertOwns(kind, resourceId, what) {
      if (!(await isOwnedBy(db, kind, resourceId, account.ownerIds))) {
        throw notFound(what ?? RESOURCE_KIND_LABELS[kind].one, resourceId);
      }
    },

    async reserve(kind, count = 1, diskMb = 0) {
      if (count <= 0 && diskMb <= 0) return;
      for (const pool of await quotaPools(db, principal.id, account)) {
        const usage = await usageFor(db, pool.ownerIds);
        const field = QUOTA_FIELDS[kind];
        const limit = pool.quota[field.limit];
        if (limit !== null && count > 0 && usage[field.usage] + count > limit) {
          throw quotaExceeded(
            `${pool.label} ${RESOURCE_KIND_LABELS[kind].one.toLowerCase()} limit is ${limit}, and ${usage[field.usage]} ${usage[field.usage] === 1 ? "is" : "are"} in use.`,
            pool.own,
            { kind, limit, used: usage[field.usage] },
          );
        }
        const disk = pool.quota.max_disk_mb;
        if (disk !== null && diskMb > 0 && usage.disk_mb + diskMb > disk) {
          throw quotaExceeded(
            `${pool.label} disk limit is ${disk} MB, and ${usage.disk_mb} MB is in use.`,
            pool.own,
            { kind: "disk", limit: disk, used: usage.disk_mb },
          );
        }
      }
    },

    async claim(kind, resourceId) {
      await db
        .insert(resourceOwners)
        .values({ kind, resourceId, ownerId: principal.id, assignedBy: principal.id })
        .onConflictDoNothing();
    },
  };
}

/**
 * The ownership check for a loader that several routes share. It does
 * not opt the request in: a route that has not called `ownership()`
 * already refuses a scoped account at `authorize`, and one that has
 * gets the owner check here without having to remember it.
 */
export async function assertOwned(
  req: FastifyRequest,
  kind: ResourceKind,
  resourceId: string,
  what?: string,
): Promise<void> {
  const account = req.principal?.scoped;
  if (!account) return;
  if (!(await isOwnedBy(req.ctx.db, kind, resourceId, account.ownerIds))) {
    throw notFound(what ?? RESOURCE_KIND_LABELS[kind].one, resourceId);
  }
}

/* ------------------------------ SQL -------------------------------- */

function ownedBy(kind: ResourceKind, idColumn: PgColumn, ownerIds: readonly string[]): SQL {
  if (ownerIds.length === 0) return sql`false`;
  return sql`exists (select 1 from ${resourceOwners}
    where ${resourceOwners.kind} = ${kind}
      and ${resourceOwners.resourceId} = ${idColumn}
      and ${inArray(resourceOwners.ownerId, [...ownerIds])})`;
}

export async function isOwnedBy(
  db: Database,
  kind: ResourceKind,
  resourceId: string,
  ownerIds: readonly string[],
): Promise<boolean> {
  if (ownerIds.length === 0) return false;
  const rows = await db
    .select({ ownerId: resourceOwners.ownerId })
    .from(resourceOwners)
    .where(
      and(
        eq(resourceOwners.kind, kind),
        eq(resourceOwners.resourceId, resourceId),
        inArray(resourceOwners.ownerId, [...ownerIds]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/* ----------------------------- quotas ------------------------------ */

/**
 * What a set of owners is using. Counted against the live tables, so an
 * ownership row whose resource has since been deleted counts for
 * nothing. Disk is database size plus the space promised to mailboxes.
 */
export async function usageFor(db: Database, ownerIds: readonly string[]): Promise<QuotaUsage> {
  if (ownerIds.length === 0) {
    return { sites: 0, domains: 0, mailboxes: 0, databases: 0, disk_mb: 0 };
  }
  const owners = sql.join(
    ownerIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db.execute(sql`
    select
      (select count(*)::int from resource_owners o join sites r on r.id = o.resource_id
        where o.kind = 'site' and o.owner_id in (${owners})) as sites,
      (select count(*)::int from resource_owners o join domains r on r.id = o.resource_id
        where o.kind = 'domain' and o.owner_id in (${owners})) as domains,
      (select count(*)::int from resource_owners o join mailboxes r on r.id = o.resource_id
        where o.kind = 'mailbox' and o.owner_id in (${owners})) as mailboxes,
      (select count(*)::int from resource_owners o join db_databases r on r.id = o.resource_id
        where o.kind = 'database' and o.owner_id in (${owners})) as databases,
      (select coalesce(sum(r.size_bytes), 0)::float8 from resource_owners o
        join db_databases r on r.id = o.resource_id
        where o.kind = 'database' and o.owner_id in (${owners})) as database_bytes,
      (select coalesce(sum(r.quota_bytes), 0)::float8 from resource_owners o
        join mailboxes r on r.id = o.resource_id
        where o.kind = 'mailbox' and o.owner_id in (${owners})) as mailbox_bytes
  `);
  const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as
    | Record<string, number | string>
    | undefined;
  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    sites: n("sites"),
    domains: n("domains"),
    mailboxes: n("mailboxes"),
    databases: n("databases"),
    disk_mb: Math.ceil((n("database_bytes") + n("mailbox_bytes")) / 1_048_576),
  };
}

export async function quotaOf(db: Database, userId: string): Promise<AccountQuota> {
  const rows = await db
    .select()
    .from(accountLimits)
    .where(eq(accountLimits.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return { ...UNLIMITED_QUOTA };
  return {
    max_sites: row.maxSites,
    max_domains: row.maxDomains,
    max_mailboxes: row.maxMailboxes,
    max_databases: row.maxDatabases,
    max_disk_mb: row.maxDiskMb,
  };
}

interface QuotaPool {
  label: string;
  /** True when this is the caller's own allowance rather than their reseller's. */
  own: boolean;
  ownerIds: readonly string[];
  quota: AccountQuota;
}

/**
 * The allowances a create has to fit inside. A reseller has one: its
 * own, counted across itself and every client. A client has two: its
 * own, and its reseller's as a whole, so a reseller cannot be oversold
 * past what the owner gave it.
 */
async function quotaPools(
  db: Database,
  userId: string,
  account: ScopedAccount,
): Promise<QuotaPool[]> {
  if (account.audience === "reseller") {
    return [
      { label: "Your", own: true, ownerIds: account.ownerIds, quota: await quotaOf(db, userId) },
    ];
  }

  const pools: QuotaPool[] = [
    { label: "Your", own: true, ownerIds: [userId], quota: await quotaOf(db, userId) },
  ];
  if (account.resellerId) {
    const siblings = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.parentId, account.resellerId), eq(users.audience, "client")));
    pools.push({
      label: "Your provider's",
      own: false,
      ownerIds: [account.resellerId, ...siblings.map((s) => s.id)],
      quota: await quotaOf(db, account.resellerId),
    });
  }
  return pools;
}

function quotaExceeded(message: string, own: boolean, detail: Record<string, unknown>) {
  return new ApiException("quota_exceeded", message, {
    detail,
    remediation: {
      summary: own
        ? "Remove something you no longer need, or ask whoever manages your account to raise the limit."
        : "Your provider's plan is full. Contact them to make room.",
      actions: [],
    },
  });
}
