import { and, eq, inArray, isNotNull, type Database } from "@kaname/db";
import { dnsRecords, domains } from "@kaname/db/schema";
import type { DnsProvider as DnsProviderKind, DnsRecordDraft } from "@kaname/contract";
import type { Config } from "../config.js";
import { ApiException } from "../lib/errors.js";
import {
  dnsProviderFor,
  fqdn,
  type DnsProvider,
  type DnsProviderTarget,
  type ProviderRecordDraft,
  type ProviderWrite,
} from "./dns-provider.js";

/* ------------------------------------------------------------------ *
 * Zone sync and apply.
 *
 * Both talk to the registrar's API for as long as the zone takes, so
 * they run as `dns.sync` / `dns.apply` jobs rather than inside a request
 * (a 400-record Cloudflare zone is four paginated calls, and a rate
 * limit can stretch that to minutes). They live here, not in the route,
 * so the job handler and the route's preflight share one definition of
 * "drift" and one way of turning a stored row into a provider draft.
 * ------------------------------------------------------------------ */

export type DomainRow = typeof domains.$inferSelect;
type RecordRow = typeof dnsRecords.$inferSelect;
type DriftColumn = (typeof dnsRecords.$inferInsert)["drift"];

export interface ZoneDeps {
  db: Database;
  config: Config;
}

export interface ZoneSyncSummary {
  domain_id: string;
  domain_name: string;
  zone_id: string;
  provider: DnsProviderKind;
  checked_at: string;
  total: number;
  created: number;
  updated: number;
  adopted: number;
  drifted: number;
  removed: number;
  /** Reported rather than hidden: these stay untouched at the provider. */
  unsupported: { type: string; name: string }[];
}

export interface ZoneApplySummary {
  domain_id: string;
  domain_name: string;
  provider: DnsProviderKind;
  applied_at: string;
  created: number;
  updated: number;
  deleted: number;
  /** Drifted records written back to Kaname's value. */
  restored: number;
}

export interface ZoneApplyInput {
  records: DnsRecordDraft[];
  delete_ids: string[];
  fail_on_drift: boolean;
}

export function providerTarget(domain: DomainRow): DnsProviderTarget {
  return {
    id: domain.id,
    name: domain.name,
    dnsProvider: domain.dnsProvider,
    dnsZoneId: domain.dnsZoneId,
  };
}

/** A record the provider no longer has is drift with no current value;
 *  the column's declared shape predates that case. */
export function drift(expected: string, actual: string | null): DriftColumn {
  return { expected, actual, detected_at: new Date().toISOString() } as DriftColumn;
}

/**
 * Drift is the gap between what Kaname asked for and what the zone
 * actually holds. A manual provider applied nothing, so everything it
 * accepts is drift until the operator publishes it.
 */
export function driftBetween(draft: ProviderRecordDraft, write: ProviderWrite): DriftColumn {
  if (write.manual) return drift(draft.content, null);
  return write.record.content === draft.content ? null : drift(draft.content, write.record.content);
}

export function shapeKey(type: string, name: string, content: string): string {
  return `${type}|${name.trim().toLowerCase().replace(/\.$/, "")}|${content.trim()}`;
}

export function toDraft(zoneName: string, draft: ProviderRecordDraft): ProviderRecordDraft {
  const normalized: ProviderRecordDraft = {
    ...draft,
    name: fqdn(zoneName, draft.name),
    content: draft.content.trim(),
  };
  if ((normalized.type === "MX" || normalized.type === "SRV") && normalized.priority === null) {
    throw new ApiException("validation_failed", `An ${normalized.type} record needs a priority.`, {
      fields: { priority: "required" },
      remediation: {
        summary:
          "Lower numbers are tried first. Use 10 for a single mail host, or 10 and 20 for a primary and a backup.",
        actions: [],
      },
    });
  }
  return normalized;
}

/**
 * The refusal for a zone Kaname cannot drive. Sync keeps the wording it
 * always had; apply says "push" because that is what it would have done.
 */
export function manualZoneRefusal(domain: DomainRow, verb: "pull" | "push to"): ApiException {
  return new ApiException(
    "precondition_failed",
    `${domain.name} has no API-driven DNS provider, so there is no authoritative zone to ${verb}.`,
    {
      remediation: {
        summary:
          "Kaname holds the intended records for a manual domain and nothing to compare them against. Move the zone to a supported provider to get drift detection and automatic dns-01 challenges.",
        actions: [{ label: "Domain settings", href: `/websites/domains/${domain.id}` }],
      },
    },
  );
}

/** Resolves the provider and refuses a manual zone, before anything is queued. */
export async function authoritativeProvider(
  deps: ZoneDeps,
  domain: DomainRow,
  verb: "pull" | "push to",
): Promise<DnsProvider> {
  const provider = await dnsProviderFor(deps, providerTarget(domain));
  if (!provider.authoritative) throw manualZoneRefusal(domain, verb);
  return provider;
}

/** Records Kaname manages whose provider copy differs from what it asked for. */
export async function stagedDrift(db: Database, domainId: string): Promise<RecordRow[]> {
  return db
    .select()
    .from(dnsRecords)
    .where(
      and(
        eq(dnsRecords.domainId, domainId),
        eq(dnsRecords.managedBy, "kaname"),
        isNotNull(dnsRecords.drift),
      ),
    );
}

/* ------------------------------- sync ------------------------------ */

/**
 * Pulls the provider's zone and reconciles the table against it. The
 * provider is authoritative, so its copy wins; what Kaname wanted is
 * kept as the drift's expected value, which is what `applyZone` pushes.
 */
export async function syncZone(
  deps: ZoneDeps,
  domain: DomainRow,
  opts: { adoptUnmanaged: boolean },
): Promise<ZoneSyncSummary> {
  const provider = await authoritativeProvider(deps, domain, "pull");
  const zone = await provider.zone();
  const { records: live, unsupported } = await provider.listRecords();
  const stored = await deps.db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));

  const byExternal = new Map(
    stored
      .filter((r): r is RecordRow & { externalId: string } => r.externalId !== null)
      .map((r) => [r.externalId, r]),
  );
  const byShape = new Map(stored.map((r) => [shapeKey(r.type, r.name, r.content), r]));
  // A record whose content changed at the provider no longer matches its
  // own shape, and one Kaname created before it had an external id has
  // nothing else to match on; type and name still identify it.
  const byName = new Map<string, RecordRow[]>();
  for (const r of stored) {
    const key = `${r.type}|${r.name}`;
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }

  const now = new Date();
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let adopted = 0;
  let drifted = 0;
  let removed = 0;

  for (const rec of live) {
    const sameName = (byName.get(`${rec.type}|${rec.name}`) ?? []).filter(
      (r) => !seen.has(r.id) && r.externalId === null,
    );
    const match =
      (rec.external_id ? byExternal.get(rec.external_id) : undefined) ??
      byShape.get(shapeKey(rec.type, rec.name, rec.content)) ??
      (sameName.length === 1 ? sameName[0] : undefined);

    if (!match || seen.has(match.id)) {
      await deps.db
        .insert(dnsRecords)
        .values({
          domainId: domain.id,
          type: rec.type,
          name: rec.name,
          content: rec.content,
          ttl: rec.ttl,
          priority: rec.priority,
          proxied: rec.proxied,
          managedBy: opts.adoptUnmanaged ? "kaname" : "external",
          externalId: rec.external_id,
          lastSyncedAt: now,
        })
        .onConflictDoNothing();
      created += 1;
      if (opts.adoptUnmanaged) adopted += 1;
      continue;
    }

    seen.add(match.id);
    // What Kaname wanted survives a sync: an existing drift keeps its
    // expected value even when the provider changes again.
    const wanted = match.drift?.expected ?? match.content;
    const diverged = match.managedBy === "kaname" && wanted !== rec.content;
    await deps.db
      .update(dnsRecords)
      .set({
        type: rec.type,
        name: rec.name,
        content: rec.content,
        ttl: rec.ttl,
        priority: rec.priority,
        proxied: rec.proxied,
        externalId: rec.external_id,
        drift: diverged ? drift(wanted, rec.content) : null,
        ...(opts.adoptUnmanaged ? { managedBy: "kaname" as const } : {}),
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(dnsRecords.id, match.id));
    updated += 1;
    if (diverged) drifted += 1;
  }

  for (const row of stored) {
    if (seen.has(row.id)) continue;
    if (row.managedBy === "external") {
      await deps.db.delete(dnsRecords).where(eq(dnsRecords.id, row.id));
      removed += 1;
      continue;
    }
    // Kaname asked for this record and the zone no longer has it.
    await deps.db
      .update(dnsRecords)
      .set({
        drift: drift(row.drift?.expected ?? row.content, null),
        externalId: null,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(dnsRecords.id, row.id));
    drifted += 1;
  }

  await deps.db
    .update(domains)
    .set({
      dnsZoneId: zone.id,
      ...(zone.nameservers.length > 0 ? { nameservers: zone.nameservers } : {}),
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(domains.id, domain.id));

  const total = (
    await deps.db
      .select({ id: dnsRecords.id })
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id))
  ).length;

  return {
    domain_id: domain.id,
    domain_name: domain.name,
    zone_id: zone.id,
    provider: provider.kind,
    checked_at: now.toISOString(),
    total,
    created,
    updated,
    adopted,
    drifted,
    removed,
    unsupported,
  };
}

/* ------------------------------- apply ----------------------------- */

/**
 * Pushes Kaname's intended state to the provider: the explicit drafts and
 * deletions, then every staged drift — a record changed or removed at the
 * provider goes back to the value Kaname holds for it. Every write is
 * recorded from what the provider echoed, so a provider that stores
 * something else leaves the drift in place rather than claiming success.
 */
export async function applyZone(
  deps: ZoneDeps,
  domain: DomainRow,
  input: ZoneApplyInput,
  log: (line: string) => Promise<void> = async () => undefined,
): Promise<ZoneApplySummary> {
  const provider = await authoritativeProvider(deps, domain, "push to");
  const zone = await provider.zone();
  const now = new Date();
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let restored = 0;

  const targeted = input.records.flatMap((r) => (r.id ? [r.id] : []));
  const existing =
    targeted.length + input.delete_ids.length > 0
      ? await deps.db
          .select()
          .from(dnsRecords)
          .where(
            and(
              eq(dnsRecords.domainId, domain.id),
              inArray(dnsRecords.id, [...targeted, ...input.delete_ids]),
            ),
          )
      : [];
  const byId = new Map(existing.map((r) => [r.id, r]));

  if (input.fail_on_drift) {
    const moved = targeted.map((id) => byId.get(id)).filter((r) => r?.drift);
    if (moved.length > 0) {
      throw new ApiException(
        "precondition_failed",
        `${moved.length} of the records in this apply changed at the provider since they were read.`,
        {
          detail: { record_ids: moved.map((r) => r!.id) },
          remediation: {
            summary:
              "Sync the zone to see what the provider holds now, or apply without fail_on_drift to overwrite it with Kaname's value.",
            actions: [{ label: "Sync zone", action: "dns.sync" }],
          },
        },
      );
    }
  }

  for (const id of input.delete_ids) {
    const row = byId.get(id);
    if (!row) continue;
    await provider.deleteRecord(row.externalId, rowDraft(row, row.content));
    await deps.db.delete(dnsRecords).where(eq(dnsRecords.id, id));
    await log(`deleted ${row.type} ${row.name}`);
    deleted += 1;
  }

  const touched = new Set<string>();
  for (const raw of input.records) {
    const draft = toDraft(zone.name, {
      type: raw.type,
      name: raw.name,
      content: raw.content,
      ttl: raw.ttl,
      priority: raw.priority ?? null,
      proxied: raw.proxied,
    });
    const row = raw.id ? byId.get(raw.id) : undefined;
    if (row) {
      const write = await provider.updateRecord(row.externalId, draft);
      await recordWrite(deps.db, row.id, draft, write, now);
      touched.add(row.id);
      updated += 1;
      await log(`updated ${draft.type} ${draft.name}`);
    } else {
      const write = await provider.createRecord(draft);
      await deps.db
        .insert(dnsRecords)
        .values({
          domainId: domain.id,
          type: write.record.type,
          name: write.record.name,
          content: write.record.content,
          ttl: write.record.ttl,
          priority: write.record.priority,
          proxied: write.record.proxied,
          managedBy: "kaname",
          externalId: write.record.external_id,
          drift: driftBetween(draft, write),
          lastSyncedAt: now,
        })
        .onConflictDoNothing();
      created += 1;
      await log(`created ${draft.type} ${draft.name}`);
    }
  }

  for (const row of await stagedDrift(deps.db, domain.id)) {
    if (touched.has(row.id) || !row.drift) continue;
    const draft = rowDraft(row, row.drift.expected);
    // Gone at the provider (actual null, or never written): create it
    // again. Otherwise overwrite the provider's copy in place.
    const gone = row.drift.actual === null || row.externalId === null;
    const write = gone
      ? await provider.createRecord(draft)
      : await provider.updateRecord(row.externalId, draft);
    await recordWrite(deps.db, row.id, draft, write, now);
    restored += 1;
    await log(
      `${gone ? "re-created" : "restored"} ${draft.type} ${draft.name} to ${draft.content}`,
    );
  }

  await deps.db
    .update(domains)
    .set({ dnsZoneId: zone.id, lastSyncedAt: now, updatedAt: now })
    .where(eq(domains.id, domain.id));

  return {
    domain_id: domain.id,
    domain_name: domain.name,
    provider: provider.kind,
    applied_at: now.toISOString(),
    created,
    updated,
    deleted,
    restored,
  };
}

function rowDraft(row: RecordRow, content: string): ProviderRecordDraft {
  return {
    type: row.type,
    name: row.name,
    content,
    ttl: row.ttl,
    priority: row.priority,
    proxied: row.proxied,
  };
}

async function recordWrite(
  db: Database,
  id: string,
  draft: ProviderRecordDraft,
  write: ProviderWrite,
  now: Date,
): Promise<void> {
  await db
    .update(dnsRecords)
    .set({
      type: write.record.type,
      name: write.record.name,
      content: write.record.content,
      ttl: write.record.ttl,
      priority: write.record.priority,
      proxied: write.record.proxied,
      externalId: write.record.external_id,
      drift: driftBetween(draft, write),
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(dnsRecords.id, id));
}
