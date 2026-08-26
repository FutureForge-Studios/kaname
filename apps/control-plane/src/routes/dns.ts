import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, isNotNull, isNull, sql, type Database } from "@kaname/db";
import { certificates, dnsRecords, domains, mailDomains, servers, sites } from "@kaname/db/schema";
import {
  createDnsRecordInput,
  dnsRecordListQuery,
  idParam,
  syncDnsInput,
  updateDnsRecordInput,
  type DnsRecord,
  type DnsRecordType,
  type DnsValidationIssue,
  type DnsValidationResult,
  type Permission,
  type Remediation,
} from "@kaname/contract";
import {
  helpers,
  item,
  list,
  noContent,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { ApiException, badRequest, conflict, notFound } from "../lib/errors.js";
import {
  dnsProviderFor,
  fqdn,
  PROXYABLE_TYPES,
  zoneLine,
  type DnsProviderTarget,
  type ProviderRecordDraft,
  type ProviderWrite,
} from "../services/dns-provider.js";
import { combine, searchTerm, sortColumn } from "./_shared.js";
import { domainScope, loadDomainRow, normalizeName } from "./domains.js";

/* ------------------------------------------------------------------ *
 * DNS records.
 *
 * The zone lives at a registrar, not on a managed host, so these are
 * control-plane mutations that return the resource rather than a job.
 * What they do not do is pretend: when the provider stores something
 * other than what Kaname asked for — or cannot store it at all — the
 * difference is written down as drift and shown, never smoothed over
 * (KD-012).
 * ------------------------------------------------------------------ */

const SORTABLE = {
  name: dnsRecords.name,
  type: dnsRecords.type,
  content: dnsRecords.content,
  ttl: dnsRecords.ttl,
  last_synced_at: dnsRecords.lastSyncedAt,
  created_at: dnsRecords.createdAt,
  updated_at: dnsRecords.updatedAt,
} as const;

/** Above this, a record cannot be re-pointed the same day it is changed. */
const TTL_CUTOVER_MAX = 3600;
const TTL_CUTOVER_TARGET = 300;
/** Types that answer "where does this name point", for target lookups. */
const ADDRESS_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];

type DriftColumn = (typeof dnsRecords.$inferInsert)["drift"];
type RecordRow = typeof dnsRecords.$inferSelect;
type DomainRow = typeof domains.$inferSelect;

const recordSelection = {
  record: dnsRecords,
  domain_name: domains.name,
};

type RecordApiRow = { record: RecordRow; domain_name: string };

export async function dnsRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/dns", async (req, reply) => {
    const q = parseQuery(req, dnsRecordListQuery);
    helpers(req).authorize("websites.dns:read");

    const term = searchTerm(q.q);
    const where = combine(
      domainScope(req, "websites.dns:read"),
      q.domain_id ? eq(dnsRecords.domainId, q.domain_id) : null,
      q.type ? eq(dnsRecords.type, q.type) : null,
      q.managed_by ? eq(dnsRecords.managedBy, q.managed_by) : null,
      q.drifted === undefined
        ? null
        : q.drifted
          ? isNotNull(dnsRecords.drift)
          : isNull(dnsRecords.drift),
      term
        ? sql`(lower(${dnsRecords.name}) like ${term} or lower(${dnsRecords.content}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "name");
    const rows = await req.ctx.db
      .select(recordSelection)
      .from(dnsRecords)
      .innerJoin(domains, eq(dnsRecords.domainId, domains.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(dnsRecords)
      .innerJoin(domains, eq(dnsRecords.domainId, domains.id))
      .where(where);

    return list(reply, rows.map(recordToApi), paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  /* ----------------------------- create ----------------------------- */

  app.post("/dns", async (req, reply) => {
    const body = parseBody(req, createDnsRecordInput);
    const domain = await loadDomainRow(req, body.domain_id, "websites.dns:write");
    const h = helpers(req);

    const provider = await dnsProviderFor(req.ctx, providerTarget(domain));
    const zone = await provider.zone();
    const draft = toDraft(zone.name, {
      type: body.type,
      name: body.name,
      content: body.content,
      ttl: body.ttl,
      priority: body.priority ?? null,
      proxied: body.proxied,
    });

    const duplicate = await req.ctx.db
      .select({ id: dnsRecords.id })
      .from(dnsRecords)
      .where(
        and(
          eq(dnsRecords.domainId, domain.id),
          eq(dnsRecords.type, draft.type),
          eq(dnsRecords.name, draft.name),
          eq(dnsRecords.content, draft.content),
        ),
      )
      .limit(1);
    if (duplicate[0]) {
      throw conflict(`${domain.name} already has that exact ${draft.type} record.`, {
        summary: `${zoneLine(draft)} is already in the zone. Edit the existing record instead of adding a second identical one.`,
        actions: [{ label: "Open the record", href: `/websites/dns?domain_id=${domain.id}` }],
      });
    }

    const write = await provider.createRecord(draft);
    const [row] = await req.ctx.db
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
        lastSyncedAt: provider.authoritative ? new Date() : null,
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "dns.record.created",
      targetType: "dns_record",
      targetId: row!.id,
      targetLabel: `${draft.type} ${draft.name}`,
      serverId: domain.serverId,
      metadata: { domain: domain.name, provider: provider.kind, manual: write.manual },
      after: body,
    });
    req.ctx.events.publish(
      "servers",
      "dns.record.created",
      { record_id: row!.id, domain_id: domain.id, manual: write.manual },
      domain.serverId,
    );

    return item(reply, await recordApi(req.ctx.db, row!.id), 201);
  });

  /* ----------------------------- update ----------------------------- */

  app.patch("/dns/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateDnsRecordInput);
    const before = await loadRecordRow(req, id, "websites.dns:write");
    const domain = await loadDomainRow(req, before.domainId, "websites.dns:write");
    const h = helpers(req);

    const provider = await dnsProviderFor(req.ctx, providerTarget(domain));
    const zone = await provider.zone();
    const draft = toDraft(zone.name, {
      type: body.type ?? before.type,
      name: body.name ?? before.name,
      content: body.content ?? before.content,
      ttl: body.ttl ?? before.ttl,
      priority: body.priority ?? before.priority,
      proxied: body.proxied ?? before.proxied,
    });

    const write = await provider.updateRecord(before.externalId, draft);
    await req.ctx.db
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
        lastSyncedAt: provider.authoritative ? new Date() : before.lastSyncedAt,
        updatedAt: new Date(),
      })
      .where(eq(dnsRecords.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "dns.record.updated",
      targetType: "dns_record",
      targetId: id,
      targetLabel: `${draft.type} ${draft.name}`,
      serverId: domain.serverId,
      metadata: { domain: domain.name, provider: provider.kind, manual: write.manual },
      before: {
        type: before.type,
        name: before.name,
        content: before.content,
        ttl: before.ttl,
        priority: before.priority,
        proxied: before.proxied,
      },
      after: body,
    });
    req.ctx.events.publish(
      "servers",
      "dns.record.updated",
      { record_id: id, domain_id: domain.id, manual: write.manual },
      domain.serverId,
    );

    return item(reply, await recordApi(req.ctx.db, id));
  });

  /* ----------------------------- delete ----------------------------- */

  app.delete("/dns/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const before = await loadRecordRow(req, id, "websites.dns:delete");
    const domain = await loadDomainRow(req, before.domainId, "websites.dns:delete");
    const h = helpers(req);

    const provider = await dnsProviderFor(req.ctx, providerTarget(domain));
    const zone = await provider.zone();
    const draft = toDraft(zone.name, {
      type: before.type,
      name: before.name,
      content: before.content,
      ttl: before.ttl,
      priority: before.priority,
      proxied: before.proxied,
    });

    const write = await provider.deleteRecord(before.externalId, draft);
    await req.ctx.db.delete(dnsRecords).where(eq(dnsRecords.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "dns.record.deleted",
      targetType: "dns_record",
      targetId: id,
      targetLabel: `${before.type} ${before.name}`,
      serverId: domain.serverId,
      metadata: { domain: domain.name, provider: provider.kind, manual: write.manual },
      before: { type: before.type, name: before.name, content: before.content },
    });
    // A manual provider applied nothing, so the operator still has to
    // remove the line themselves; the instruction rides the event.
    req.ctx.events.publish(
      "servers",
      "dns.record.deleted",
      { record_id: id, domain_id: domain.id, manual: write.manual },
      domain.serverId,
    );

    return noContent(reply);
  });

  /* ------------------------------ sync ------------------------------ */

  app.post("/dns/sync", async (req, reply) => {
    const q = parseQuery(req, dnsRecordListQuery.pick({ domain_id: true }));
    // Defaulted so `POST /dns/sync?domain_id=...` needs no body at all.
    const body = parseBody(req, syncDnsInput.partial({ domain_id: true }).default({}));
    const domainId = body.domain_id ?? q.domain_id;
    if (!domainId) {
      throw badRequest("domain_id is required to sync a zone.", { domain_id: "required" });
    }

    const domain = await loadDomainRow(req, domainId, "websites.dns:read");
    const h = helpers(req);

    const provider = await dnsProviderFor(req.ctx, providerTarget(domain));
    if (!provider.authoritative) {
      throw new ApiException(
        "precondition_failed",
        `${domain.name} has no API-driven DNS provider, so there is no authoritative zone to pull.`,
        {
          remediation: {
            summary:
              "Kaname holds the intended records for a manual domain and nothing to compare them against. Move the zone to a supported provider to get drift detection and automatic dns-01 challenges.",
            actions: [{ label: "Domain settings", href: `/websites/domains/${domain.id}` }],
          },
        },
      );
    }

    const zone = await provider.zone();
    const { records: live, unsupported } = await provider.listRecords();
    const stored = await req.ctx.db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const byExternal = new Map(
      stored
        .filter((r): r is RecordRow & { externalId: string } => r.externalId !== null)
        .map((r) => [r.externalId, r]),
    );
    const byShape = new Map(stored.map((r) => [shapeKey(r.type, r.name, r.content), r]));

    const now = new Date();
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    let adopted = 0;
    let drifted = 0;
    let removed = 0;

    for (const rec of live) {
      const match =
        (rec.external_id ? byExternal.get(rec.external_id) : undefined) ??
        byShape.get(shapeKey(rec.type, rec.name, rec.content));

      if (!match) {
        await req.ctx.db
          .insert(dnsRecords)
          .values({
            domainId: domain.id,
            type: rec.type,
            name: rec.name,
            content: rec.content,
            ttl: rec.ttl,
            priority: rec.priority,
            proxied: rec.proxied,
            managedBy: body.adopt_unmanaged ? "kaname" : "external",
            externalId: rec.external_id,
            lastSyncedAt: now,
          })
          .onConflictDoNothing();
        created += 1;
        if (body.adopt_unmanaged) adopted += 1;
        continue;
      }

      seen.add(match.id);
      // The provider is authoritative, so its copy wins and what Kaname
      // wanted is preserved as the drift's expected value.
      const diverged = match.content !== rec.content && match.managedBy === "kaname";
      await req.ctx.db
        .update(dnsRecords)
        .set({
          type: rec.type,
          name: rec.name,
          content: rec.content,
          ttl: rec.ttl,
          priority: rec.priority,
          proxied: rec.proxied,
          externalId: rec.external_id,
          drift: diverged ? drift(match.content, rec.content) : null,
          ...(body.adopt_unmanaged ? { managedBy: "kaname" as const } : {}),
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
        await req.ctx.db.delete(dnsRecords).where(eq(dnsRecords.id, row.id));
        removed += 1;
        continue;
      }
      // Kaname asked for this record and the zone no longer has it.
      await req.ctx.db
        .update(dnsRecords)
        .set({
          drift: drift(row.content, null),
          externalId: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(dnsRecords.id, row.id));
      drifted += 1;
    }

    await req.ctx.db
      .update(domains)
      .set({
        dnsZoneId: zone.id,
        ...(zone.nameservers.length > 0 ? { nameservers: zone.nameservers } : {}),
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(domains.id, domain.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "dns.synced",
      targetType: "domain",
      targetId: domain.id,
      targetLabel: domain.name,
      serverId: domain.serverId,
      metadata: { provider: provider.kind, created, updated, adopted, drifted, removed },
    });
    req.ctx.events.publish(
      "servers",
      "dns.synced",
      { domain_id: domain.id, drifted, created, removed },
      domain.serverId,
    );

    const refreshed = await req.ctx.db
      .select(recordSelection)
      .from(dnsRecords)
      .innerJoin(domains, eq(dnsRecords.domainId, domains.id))
      .where(eq(dnsRecords.domainId, domain.id))
      .orderBy(asc(dnsRecords.name));

    return item(reply, {
      domain_id: domain.id,
      domain_name: domain.name,
      zone_id: zone.id,
      provider: provider.kind,
      checked_at: now.toISOString(),
      total: refreshed.length,
      created,
      updated,
      adopted,
      drifted,
      removed,
      // Reported rather than hidden: these stay untouched at the provider.
      unsupported,
      records: refreshed.map(recordToApi),
    });
  });

  /* ---------------------------- validate ---------------------------- */

  app.post("/dns/validate", async (req, reply) => {
    const q = parseQuery(req, dnsRecordListQuery.pick({ domain_id: true }));
    if (!q.domain_id) {
      throw badRequest("domain_id is required to validate a zone.", { domain_id: "required" });
    }
    const domain = await loadDomainRow(req, q.domain_id, "websites.dns:read");

    const result: DnsValidationResult = {
      domain_id: domain.id,
      domain_name: domain.name,
      checked_at: new Date().toISOString(),
      issues: await validateZone(req.ctx.db, domain),
    };
    return item(reply, result);
  });
}

/* ------------------------------------------------------------------ */

/** Loads a record and asserts the caller holds `permission` on its host. */
async function loadRecordRow(
  req: FastifyRequest,
  recordId: string,
  permission: Permission,
): Promise<RecordRow> {
  const rows = await req.ctx.db
    .select({ record: dnsRecords, serverId: domains.serverId })
    .from(dnsRecords)
    .innerJoin(domains, eq(dnsRecords.domainId, domains.id))
    .where(eq(dnsRecords.id, recordId))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("DNS record", recordId);
  helpers(req).authorize(permission, row.serverId);
  return row.record;
}

async function recordApi(db: Database, recordId: string): Promise<DnsRecord> {
  const rows = await db
    .select(recordSelection)
    .from(dnsRecords)
    .innerJoin(domains, eq(dnsRecords.domainId, domains.id))
    .where(eq(dnsRecords.id, recordId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("DNS record", recordId);
  return recordToApi(row);
}

function recordToApi(row: RecordApiRow): DnsRecord {
  const r = row.record;
  return {
    id: r.id,
    domain_id: r.domainId,
    domain_name: row.domain_name,
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: r.ttl,
    priority: r.priority,
    proxied: r.proxied,
    managed_by: r.managedBy,
    external_id: r.externalId,
    last_synced_at: (r.lastSyncedAt ?? r.updatedAt).toISOString(),
    drift: r.drift
      ? {
          expected: r.drift.expected,
          actual: r.drift.actual ?? null,
          detected_at: r.drift.detected_at,
        }
      : null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/* ---------------------------- internals ---------------------------- */

function providerTarget(domain: DomainRow): DnsProviderTarget {
  return {
    id: domain.id,
    name: domain.name,
    dnsProvider: domain.dnsProvider,
    dnsZoneId: domain.dnsZoneId,
  };
}

function toDraft(zoneName: string, draft: ProviderRecordDraft): ProviderRecordDraft {
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
 * Drift is the gap between what Kaname asked for and what the zone
 * actually holds. A manual provider applied nothing, so everything it
 * accepts is drift until the operator publishes it.
 */
function driftBetween(draft: ProviderRecordDraft, write: ProviderWrite): DriftColumn {
  if (write.manual) return drift(draft.content, null);
  return write.record.content === draft.content ? null : drift(draft.content, write.record.content);
}

/** A record the provider no longer has is drift with no current value;
 *  the column's declared shape predates that case. */
function drift(expected: string, actual: string | null): DriftColumn {
  return { expected, actual, detected_at: new Date().toISOString() } as DriftColumn;
}

function shapeKey(type: string, name: string, content: string): string {
  return `${type}|${normalizeName(name)}|${content.trim()}`;
}

/* ------------------------------------------------------------------ *
 * Validation
 *
 * Every issue names the exact record to add or change, because "your DNS
 * is wrong" is the least useful sentence an infrastructure panel can
 * print.
 * ------------------------------------------------------------------ */

async function validateZone(db: Database, domain: DomainRow): Promise<DnsValidationIssue[]> {
  const records = await db.select().from(dnsRecords).where(eq(dnsRecords.domainId, domain.id));

  const site = domain.siteId
    ? ((await db.select().from(sites).where(eq(sites.id, domain.siteId)).limit(1))[0] ?? null)
    : null;
  const serverId = site?.serverId ?? domain.serverId;
  const server = serverId
    ? ((
        await db
          .select({ name: servers.name, address: servers.address })
          .from(servers)
          .where(eq(servers.id, serverId))
          .limit(1)
      )[0] ?? null)
    : null;
  const certs = await db
    .select({ status: certificates.status })
    .from(certificates)
    .where(eq(certificates.domainId, domain.id));
  const mail =
    (
      await db
        .select({ mailHostname: mailDomains.mailHostname })
        .from(mailDomains)
        .where(eq(mailDomains.domainId, domain.id))
        .limit(1)
    )[0] ?? null;

  const apex = domain.name;
  const address = server?.address ?? null;
  const apexRecords = records.filter((r) => normalizeName(r.name) === apex);
  const issues: DnsValidationIssue[] = [];

  const add = (
    severity: DnsValidationIssue["severity"],
    recordId: string | null,
    code: string,
    message: string,
    remediation: Remediation | null,
  ): void => {
    issues.push({ severity, record_id: recordId, code, message, remediation });
  };

  /* ------------------------------ apex ------------------------------ */

  const apexCname = apexRecords.find((r) => r.type === "CNAME");
  if (apexCname) {
    const line = `${apex}. ${TTL_CUTOVER_TARGET} IN A ${address ?? "<server address>"}`;
    add(
      "error",
      apexCname.id,
      "cname_at_apex",
      `${apex} has a CNAME at the zone apex. RFC 1034 forbids a CNAME next to the SOA and NS records every zone must carry, so resolvers may return SERVFAIL or drop the zone's mail routing entirely.`,
      {
        summary: `Replace it with an address record: ${line}`,
        actions: [
          ...(address ? [{ label: "Copy the record", copy: line }] : []),
          { label: "Open DNS", href: `/websites/dns?domain_id=${domain.id}` },
        ],
      },
    );
  }

  const apexAddresses = apexRecords.filter(
    (r) => r.type === "A" || r.type === "AAAA" || r.type === "ALIAS",
  );
  if (site && apexAddresses.length === 0 && !apexCname) {
    const line = `${apex}. ${TTL_CUTOVER_TARGET} IN A ${address ?? "<server address>"}`;
    add(
      "error",
      null,
      "missing_a_record",
      `${apex} has no address record, so nothing resolves to the site "${site.name}".`,
      {
        summary: `Add ${line}`,
        actions: [
          ...(address ? [{ label: "Copy the record", copy: line }] : []),
          { label: "Open DNS", href: `/websites/dns?domain_id=${domain.id}` },
          { label: "Open the site", href: `/websites/sites/${site.id}` },
        ],
      },
    );
  }

  if (site && address) {
    const wrong = apexAddresses.filter((r) => r.type === "A" && r.content.trim() !== address);
    for (const record of wrong) {
      add(
        "error",
        record.id,
        "apex_address_mismatch",
        `${apex} resolves to ${record.content}, but "${site.name}" is served from ${server?.name ?? "its host"} at ${address}.`,
        {
          summary: `Point it at the host that actually serves the site: ${apex}. ${TTL_CUTOVER_TARGET} IN A ${address}`,
          actions: [
            { label: "Copy the record", copy: `${apex}. ${TTL_CUTOVER_TARGET} IN A ${address}` },
            { label: "Open the site", href: `/websites/sites/${site.id}` },
          ],
        },
      );
    }
  }

  /* ------------------------------- spf ------------------------------ */

  const spf = apexRecords.filter((r) => r.type === "TXT" && /^"?v=spf1\b/i.test(r.content.trim()));
  if (spf.length > 1) {
    const merged = mergeSpf(spf.map((r) => r.content));
    const line = `${apex}. ${TTL_CUTOVER_TARGET} IN TXT "${merged}"`;
    add(
      "error",
      spf[1]!.id,
      "multiple_spf",
      `${apex} publishes ${spf.length} SPF records. RFC 7208 makes more than one a permerror, so every receiver fails the check and your mail is treated as unauthenticated.`,
      {
        summary: `Merge them into one record and delete the rest: ${line}`.slice(0, 500),
        actions: [
          { label: "Copy the merged record", copy: line },
          { label: "Open DNS", href: `/websites/dns?domain_id=${domain.id}` },
        ],
      },
    );
  }

  if (domain.hasMail && spf.length === 0) {
    const line = `${apex}. ${TTL_CUTOVER_TARGET} IN TXT "v=spf1 a mx -all"`;
    add("warning", null, "spf_missing", `${apex} sends mail but publishes no SPF record.`, {
      summary: `Authorise this host and nothing else: ${line}`,
      actions: [
        { label: "Copy the record", copy: line },
        { label: "Mail authentication", href: "/email/authentication" },
      ],
    });
  }

  /* -------------------------------- mx ------------------------------ */

  const mxRecords = apexRecords.filter((r) => r.type === "MX");
  if (domain.hasMail && mxRecords.length === 0) {
    const host = mail?.mailHostname ?? `mail.${apex}`;
    const line = `${apex}. ${TTL_CUTOVER_TARGET} IN MX 10 ${host}.`;
    add(
      "error",
      null,
      "mx_missing",
      `${apex} has mailboxes but no MX record, so nothing can deliver to it.`,
      {
        summary: `Add ${line}`,
        actions: [
          { label: "Copy the record", copy: line },
          { label: "Mail authentication", href: "/email/authentication" },
        ],
      },
    );
  }

  for (const mx of mxRecords) {
    const target = normalizeName(mx.content.replace(/^\s*\d+\s+/, ""));
    const targetRecords = records.filter(
      (r) => normalizeName(r.name) === target && ADDRESS_TYPES.includes(r.type),
    );
    const proxiedTarget = targetRecords.find((r) => r.proxied);
    if (!proxiedTarget && !(target === apex && domain.proxied)) continue;

    add(
      "error",
      mx.id,
      "mx_proxied_host",
      `${apex} routes mail to ${target}, and ${target} is proxied through a CDN. SMTP does not traverse an HTTP proxy, so delivery fails — and SPF ends up authorising the proxy's address range instead of your own.`,
      {
        summary: `Set ${target} to DNS-only at the provider (grey cloud on Cloudflare) and leave the MX record pointing at it. Use a separate name from the website if the site must stay proxied.`,
        actions: [
          ...(proxiedTarget
            ? [{ label: "Open the record", href: `/websites/dns?domain_id=${domain.id}` }]
            : []),
          { label: "Mail authentication", href: "/email/authentication" },
        ],
      },
    );
  }

  if (
    domain.hasMail &&
    !records.some((r) => normalizeName(r.name) === `_dmarc.${apex}` && r.type === "TXT")
  ) {
    const line = `_dmarc.${apex}. ${TTL_CUTOVER_TARGET} IN TXT "v=DMARC1; p=none; rua=mailto:postmaster@${apex}"`;
    add(
      "warning",
      null,
      "dmarc_missing",
      `${apex} publishes no DMARC policy, so nobody reports on mail forged in its name.`,
      {
        summary:
          `Start in report-only mode, read the reports for a fortnight, then tighten to p=quarantine: ${line}`.slice(
            0,
            500,
          ),
        actions: [
          { label: "Copy the record", copy: line },
          { label: "Mail authentication", href: "/email/authentication" },
        ],
      },
    );
  }

  /* ------------------------------- ttl ------------------------------ */

  const changeImminent =
    site?.status === "provisioning" ||
    certs.some(
      (c) =>
        c.status === "pending" ||
        c.status === "expiring" ||
        c.status === "expired" ||
        c.status === "failed",
    );

  if (changeImminent) {
    for (const record of records) {
      if (record.managedBy !== "kaname" || !ADDRESS_TYPES.includes(record.type)) continue;
      if (record.ttl <= TTL_CUTOVER_MAX) continue;
      add(
        "warning",
        record.id,
        "ttl_too_high",
        `${record.name} carries a ${formatTtl(record.ttl)} TTL while a change to ${apex} is still pending, so resolvers can keep serving the old answer for that long after the cutover.`,
        {
          summary: `Lower it to ${TTL_CUTOVER_TARGET} seconds now, make the change, then raise it again once traffic has settled.`,
          actions: [
            {
              label: "Copy the record",
              copy: `${record.name}. ${TTL_CUTOVER_TARGET} IN ${record.type} ${record.content}`,
            },
          ],
        },
      );
    }
  }

  /* ------------------------------- caa ------------------------------ */

  const caaIssuers = apexRecords
    .filter((r) => r.type === "CAA" && /\bissue(wild)?\b/.test(r.content))
    .map((r) => r.content.match(/"([^"]*)"/)?.[1]?.trim() ?? "");
  if (
    certs.length > 0 &&
    caaIssuers.length > 0 &&
    !caaIssuers.some((i) => i === "letsencrypt.org")
  ) {
    const line = `${apex}. ${TTL_CUTOVER_TARGET} IN CAA 0 issue "letsencrypt.org"`;
    add(
      "error",
      apexRecords.find((r) => r.type === "CAA")?.id ?? null,
      "caa_blocks_acme",
      `${apex} restricts issuance to ${caaIssuers.filter(Boolean).join(", ") || "no CA at all"}, so Let's Encrypt will refuse every renewal for this domain.`,
      {
        summary: `Add ${line} alongside the existing CAA records, or remove them.`,
        actions: [
          { label: "Copy the record", copy: line },
          { label: "Open certificates", href: `/websites/ssl?domain_id=${domain.id}` },
        ],
      },
    );
  }

  /* ---------------------------- delegation --------------------------- */

  const expectedNs = domain.nameservers.map(normalizeName).filter(Boolean);
  const zoneNs = apexRecords.filter((r) => r.type === "NS").map((r) => normalizeName(r.content));
  if (expectedNs.length > 0 && zoneNs.length > 0 && !expectedNs.every((n) => zoneNs.includes(n))) {
    add(
      "warning",
      null,
      "ns_mismatch",
      `The NS records inside the zone (${zoneNs.join(", ")}) do not match the delegation Kaname recorded (${expectedNs.join(", ")}).`,
      {
        summary:
          "A lame delegation answers from whichever set the registrar publishes, so half your changes appear to do nothing. Sync the zone to re-read the provider's nameservers, then fix the registrar to match.",
        actions: [
          { label: "Sync zone", action: "dns.sync" },
          { label: "Domain settings", href: `/websites/domains/${domain.id}` },
        ],
      },
    );
  }

  /* ------------------------------ state ----------------------------- */

  for (const record of records) {
    if (record.proxied && !PROXYABLE_TYPES.includes(record.type)) {
      add(
        "warning",
        record.id,
        "proxied_unsupported",
        `${record.name} is marked proxied, but a ${record.type} record cannot be proxied — the provider silently serves it directly.`,
        {
          summary: "Clear the proxied flag so Kaname's copy matches what the zone actually does.",
          actions: [{ label: "Open the record", href: `/websites/dns?domain_id=${domain.id}` }],
        },
      );
    }

    if (!record.drift) continue;
    add("warning", record.id, "record_drift", `${record.name} was changed outside Kaname.`, {
      summary: `Kaname expects "${record.drift.expected}" and the zone serves ${
        record.drift.actual ? `"${record.drift.actual}"` : "nothing"
      }. Sync to adopt the provider's copy, or edit the record here to push Kaname's back.`.slice(
        0,
        500,
      ),
      actions: [
        { label: "Sync zone", action: "dns.sync" },
        { label: "Open the record", href: `/websites/dns?domain_id=${domain.id}` },
      ],
    });
  }

  const rank: Record<DnsValidationIssue["severity"], number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Strictest wins: a merged record must not be weaker than its parts. */
const ALL_RANK: Record<string, number> = { "-all": 0, "~all": 1, "?all": 2, "+all": 3 };

function mergeSpf(contents: string[]): string {
  const mechanisms: string[] = [];
  let all = "-all";

  for (const raw of contents) {
    const parts = raw
      .trim()
      .replace(/^"(.*)"$/s, "$1")
      .split(/\s+/)
      .slice(1);
    for (const part of parts) {
      if (/^[-~?+]?all$/i.test(part)) {
        const normalized = part.length === 3 ? `+${part}` : part.toLowerCase();
        if ((ALL_RANK[normalized] ?? 3) < (ALL_RANK[all] ?? 3)) all = normalized;
        continue;
      }
      if (!mechanisms.includes(part)) mechanisms.push(part);
    }
  }
  return ["v=spf1", ...mechanisms, all].join(" ");
}

function formatTtl(seconds: number): string {
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}-day`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}-hour`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}-minute`;
  return `${seconds}-second`;
}
