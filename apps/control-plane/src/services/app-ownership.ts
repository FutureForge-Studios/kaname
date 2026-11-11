import type { Database } from "@kaname/db";
import type { AppInstallResourceKind } from "@kaname/contract";

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
 * It is deliberately a no-op today: scoped accounts (resellers and
 * clients) are not granted `apps.installs:*`, the app routes do not opt
 * in to ownership, and an operator's resources belong to the install
 * itself, which is recorded by having no owner row at all. When the
 * installer is opened to scoped accounts, this is the only function
 * that has to change — insert into `resource_owners` for the kinds
 * that table models ("site", "domain", "database"), for a creator who
 * is a scoped account.
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

let recorder: OwnershipRecorder | null = null;

/** Installs the real implementation. Called once at boot by whoever owns the ownership model. */
export function setOwnershipRecorder(next: OwnershipRecorder | null): void {
  recorder = next;
}

/** Attributes a resource an install just created to the installing user. */
export async function recordOwnership(db: Database, record: OwnershipRecord): Promise<void> {
  if (!recorder || !record.userId) return;
  await recorder(db, record);
}
