import { eq, type Database } from "@kaname/db";
import { resourceOwners, users } from "@kaname/db/schema";
import type { AppInstallResourceKind, ResourceKind } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * The ownership hook for the app installer.
 *
 * An install creates several resources — a site, a domain, a database
 * and its user, a certificate — on behalf of whoever pressed Install.
 * It creates them inside a job, long after the request that asked for
 * them has ended, so the request-scoped `ownership(req).claim()` in
 * routes/_ownership.ts (KD-039) cannot be what attributes them.
 *
 * This is the one place that attribution happens. The installer calls
 * it once per resource, right after the row exists, with the kind, the
 * id and the user the install belongs to.
 *
 * For a scoped account (a reseller or client, KD-039) it records the
 * site, domain and database in `resource_owners`, so the installer
 * owns what it installed and its quota counts it. The other kinds
 * (db_user, certificate, app_install) are not modelled there: they are
 * reached through the site or the install row, whose `created_by` the
 * app routes filter on. An operator's resources belong to the install
 * itself, recorded by having no owner row at all.
 * ------------------------------------------------------------------ */

export interface OwnershipRecord {
  /** The user the install was started by. Null for an API key or the system. */
  userId: string | null;
  kind: AppInstallResourceKind;
  resourceId: string;
  serverId: string;
  /** The install the resource belongs to, so a later transfer can move the bundle together. */
  installId: string;
}

export type OwnershipRecorder = (db: Database, record: OwnershipRecord) => Promise<void>;

const OWNABLE: Partial<Record<AppInstallResourceKind, ResourceKind>> = {
  site: "site",
  domain: "domain",
  database: "database",
};

/** The real recorder: owner rows for a scoped creator, nothing for an operator. */
export const scopedOwnershipRecorder: OwnershipRecorder = async (db, record) => {
  const kind = OWNABLE[record.kind];
  if (!kind || !record.userId) return;
  const rows = await db
    .select({ audience: users.audience })
    .from(users)
    .where(eq(users.id, record.userId))
    .limit(1);
  const audience = rows[0]?.audience;
  if (audience !== "reseller" && audience !== "client") return;
  await db
    .insert(resourceOwners)
    .values({ kind, resourceId: record.resourceId, ownerId: record.userId, assignedBy: record.userId })
    .onConflictDoNothing();
};

let recorder: OwnershipRecorder | null = scopedOwnershipRecorder;

/** Replaces the recorder (tests). The default is `scopedOwnershipRecorder`. */
export function setOwnershipRecorder(next: OwnershipRecorder | null): void {
  recorder = next;
}

/** Attributes a resource an install just created to the installing user. */
export async function recordOwnership(db: Database, record: OwnershipRecord): Promise<void> {
  if (!recorder || !record.userId) return;
  await recorder(db, record);
}
