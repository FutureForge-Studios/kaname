import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, isNull, or, sql, type Database, type SQL } from "@kaname/db";
import { certificates, domains, servers, sites } from "@kaname/db/schema";
import {
  createDomainInput,
  domainListQuery,
  idParam,
  updateDomainInput,
  type Domain,
  type DomainStatus,
  type DomainVerificationMethod,
  type Permission,
  type ResolvedRecord,
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
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { ApiException, agentOffline, conflict, fromAgentError, notFound } from "../lib/errors.js";
import { hmac } from "../lib/crypto.js";
import { combine, loadConnectedServer, scopeFilter, searchTerm, sortColumn } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Domains.
 *
 * A domain row is control-plane state only: nothing here touches a
 * managed host, so every mutation returns the resource. The one call
 * that leaves the panel is `/verify`, and it is a read-only resolve
 * from the host's own vantage point (KD-008) — which is the whole
 * point, because resolving from the control plane would answer a
 * different question than "can the box that serves this see it".
 * ------------------------------------------------------------------ */

const SORTABLE = {
  name: domains.name,
  status: domains.status,
  dns_provider: domains.dnsProvider,
  expires_at: domains.expiresAt,
  created_at: domains.createdAt,
  updated_at: domains.updatedAt,
} as const;

/** Label of the TXT record Kaname asks for when it cannot check nameservers. */
const VERIFICATION_HOST = "_kaname";
const VERIFICATION_TTL = 300;
const RESOLVE_TIMEOUT_MS = 10_000;

type ResolveAnswer = { records: ResolvedRecord[] };

const domainSelection = {
  domain: domains,
  site_name: sites.name,
  server_name: servers.name,
  record_count: sql<number>`(select count(*) from dns_records r where r.domain_id = ${domains.id})::int`,
};

type DomainApiRow = {
  domain: typeof domains.$inferSelect;
  site_name: string | null;
  server_name: string | null;
  record_count: number;
};

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/domains", async (req, reply) => {
    const q = parseQuery(req, domainListQuery);
    helpers(req).authorize("websites.domains:read");

    const term = searchTerm(q.q);
    const where = combine(
      domainScope(req, "websites.domains:read"),
      q.site_id ? eq(domains.siteId, q.site_id) : null,
      q.server_id ? eq(domains.serverId, q.server_id) : null,
      q.dns_provider ? eq(domains.dnsProvider, q.dns_provider) : null,
      q.status ? statusFilter(q.status) : null,
      q.has_mail !== undefined ? eq(domains.hasMail, q.has_mail) : null,
      q.expiring_within_days
        ? sql`${domains.expiresAt} is not null
              and ${domains.expiresAt} < now() + ${sql.raw(`interval '${q.expiring_within_days} days'`)}`
        : null,
      term
        ? sql`(lower(${domains.name}) like ${term} or lower(coalesce(${domains.registrar}, '')) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "name");
    const rows = await req.ctx.db
      .select(domainSelection)
      .from(domains)
      .leftJoin(sites, eq(domains.siteId, sites.id))
      .leftJoin(servers, eq(domains.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(domains)
      .where(where);

    return list(reply, rows.map(domainToApi), paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    await loadDomainRow(req, id, "websites.domains:read");
    return item(reply, await domainApi(req.ctx.db, id));
  });

  /* ----------------------------- create ----------------------------- */

  app.post("/domains", async (req, reply) => {
    const body = parseBody(req, createDomainInput);
    const h = helpers(req);
    const name = normalizeName(body.name);

    // A domain is server-scoped only once it has a server; until then the
    // caller just needs the permission somewhere.
    h.authorize("websites.domains:write", body.server_id ?? null);

    const existing = await req.ctx.db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.name, name))
      .limit(1);
    if (existing[0]) {
      throw conflict(`${name} is already registered in Kaname.`, {
        summary:
          "One row per name, so DNS records and certificates for a domain never split across two entries. Edit the existing one instead.",
        actions: [{ label: "Open it", href: `/websites/domains/${existing[0].id}` }],
      });
    }

    if (body.site_id) await assertSiteVisible(req, body.site_id);

    const [row] = await req.ctx.db
      .insert(domains)
      .values({
        name,
        siteId: body.site_id ?? null,
        serverId: body.server_id ?? null,
        dnsProvider: body.dns_provider,
        dnsZoneId: body.dns_zone_id ?? null,
        proxied: body.proxied,
        registrar: body.registrar ?? null,
        status: "pending",
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "domain.created",
      targetType: "domain",
      targetId: row!.id,
      targetLabel: name,
      serverId: row!.serverId,
      after: body,
    });
    req.ctx.events.publish(
      "servers",
      "domain.created",
      { domain_id: row!.id, name },
      row!.serverId,
    );

    return item(reply, await domainApi(req.ctx.db, row!.id), 201);
  });

  /* ----------------------------- update ----------------------------- */

  app.patch("/domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateDomainInput);
    const before = await loadDomainRow(req, id, "websites.domains:write");
    const h = helpers(req);

    if (body.name && normalizeName(body.name) !== before.name) {
      throw conflict(
        `A domain cannot be renamed from ${before.name} to ${normalizeName(body.name)}.`,
        {
          summary:
            "Its DNS records, certificates and mail routing are all keyed to the current name. Create the new domain and move the site across instead.",
          actions: [{ label: "Add a domain", href: "/websites/domains" }],
        },
      );
    }
    if (body.site_id) await assertSiteVisible(req, body.site_id);
    if (body.server_id) helpers(req).authorize("websites.domains:write", body.server_id);

    // Changing provider invalidates the zone id, and keeping a stale one
    // would point every later write at somebody else's zone.
    const providerChanged =
      body.dns_provider !== undefined && body.dns_provider !== before.dnsProvider;

    const [row] = await req.ctx.db
      .update(domains)
      .set({
        ...(body.site_id !== undefined ? { siteId: body.site_id } : {}),
        ...(body.server_id !== undefined ? { serverId: body.server_id } : {}),
        ...(body.dns_provider !== undefined ? { dnsProvider: body.dns_provider } : {}),
        ...(body.dns_zone_id !== undefined
          ? { dnsZoneId: body.dns_zone_id }
          : providerChanged
            ? { dnsZoneId: null }
            : {}),
        ...(body.proxied !== undefined ? { proxied: body.proxied } : {}),
        ...(body.registrar !== undefined ? { registrar: body.registrar } : {}),
        updatedAt: new Date(),
      })
      .where(eq(domains.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "domain.updated",
      targetType: "domain",
      targetId: id,
      targetLabel: before.name,
      serverId: row!.serverId,
      before: {
        site_id: before.siteId,
        server_id: before.serverId,
        dns_provider: before.dnsProvider,
        dns_zone_id: before.dnsZoneId,
        proxied: before.proxied,
        registrar: before.registrar,
      },
      after: body,
    });
    req.ctx.events.publish(
      "servers",
      "domain.updated",
      { domain_id: id, name: before.name },
      row!.serverId,
    );

    return item(reply, await domainApi(req.ctx.db, id));
  });

  /* ----------------------------- delete ----------------------------- */

  app.delete("/domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const domain = await loadDomainRow(req, id, "websites.domains:delete");
    const h = helpers(req);

    if (domain.siteId) {
      throw conflict(`${domain.name} still answers on a site.`, {
        summary:
          "Deleting it here would leave the vhost advertising a server_name Kaname no longer tracks. Remove it from the site's domain list first.",
        actions: [{ label: "Open the site", href: `/websites/sites/${domain.siteId}` }],
      });
    }

    const live = await req.ctx.db
      .select({ id: certificates.id, subject: certificates.subject })
      .from(certificates)
      .where(and(eq(certificates.domainId, id), eq(certificates.status, "active")))
      .limit(1);
    if (live[0]) {
      throw conflict(`An active certificate still covers ${domain.name}.`, {
        summary: `${live[0].subject} would be orphaned and stop renewing. Revoke it first, or turn its auto-renew off and let it lapse.`,
        actions: [{ label: "Open the certificate", href: `/websites/ssl/${live[0].id}` }],
      });
    }

    await req.ctx.db.delete(domains).where(eq(domains.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "domain.deleted",
      targetType: "domain",
      targetId: id,
      targetLabel: domain.name,
      serverId: domain.serverId,
      before: { name: domain.name, dns_provider: domain.dnsProvider, registrar: domain.registrar },
    });
    req.ctx.events.publish(
      "servers",
      "domain.deleted",
      { domain_id: id, name: domain.name },
      domain.serverId,
    );

    return noContent(reply);
  });

  /* ----------------------------- verify ----------------------------- */

  app.post("/domains/:id/verify", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const domain = await loadDomainRow(req, id, "websites.domains:write");
    const h = helpers(req);

    const serverId = domain.serverId ?? (await siteServerId(req.ctx.db, domain.siteId));
    if (!serverId) {
      throw new ApiException(
        "precondition_failed",
        `${domain.name} is not attached to a server, so Kaname has nowhere to resolve it from.`,
        {
          remediation: {
            summary:
              "Verification asks the managed host what it sees, which is the only answer that predicts whether the site will actually serve. Attach the domain to a site, or set a server on it.",
            actions: [{ label: "Edit the domain", href: `/websites/domains/${id}` }],
          },
        },
      );
    }
    const server = await loadConnectedServer(req, serverId, "websites.domains:write");

    const token = verificationToken(req.ctx.config.masterKey, domain.id);
    const expectedTxt = `kaname-verification=${token}`;
    const txtName = `${VERIFICATION_HOST}.${domain.name}`;

    let txtValues: string[];
    let nsValues: string[];
    let resolver: string | null;
    try {
      const [txt, ns]: [ResolveAnswer, ResolveAnswer] = await Promise.all([
        req.ctx.hub.call(
          server.id,
          "dns.resolve",
          { name: txtName, type: "TXT" },
          { timeoutMs: RESOLVE_TIMEOUT_MS },
        ),
        req.ctx.hub.call(
          server.id,
          "dns.resolve",
          { name: domain.name, type: "NS" },
          { timeoutMs: RESOLVE_TIMEOUT_MS },
        ),
      ]);
      txtValues = txt.records.flatMap((r) => r.values).map(unquote);
      nsValues = ns.records.flatMap((r) => r.values).map(normalizeName);
      resolver = txt.records[0]?.resolver ?? ns.records[0]?.resolver ?? null;
    } catch (err) {
      if (err instanceof AgentRpcError) throw fromAgentError(server.name, err.agentError);
      if (err instanceof AgentOfflineError) throw agentOffline(server.name, server.lastSeenAt);
      throw err;
    }

    const expectedNs = domain.nameservers.map(normalizeName);
    const byTxt = txtValues.includes(expectedTxt);
    const byNs = expectedNs.length > 0 && expectedNs.every((n) => nsValues.includes(n));
    const ok = byTxt || byNs;
    const method: DomainVerificationMethod = byTxt ? "dns_txt" : byNs ? "nameserver" : "none";

    await req.ctx.db
      .update(domains)
      .set({
        verified: ok,
        verificationMethod: method,
        verifiedAt: new Date(),
        ...(ok && domain.status === "pending" ? { status: "active" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(domains.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: ok ? "domain.verified" : "domain.verification_failed",
      targetType: "domain",
      targetId: id,
      targetLabel: domain.name,
      serverId: server.id,
      metadata: { method, resolver, checked_from: server.name },
    });
    req.ctx.events.publish(
      "servers",
      ok ? "domain.verified" : "domain.verification_failed",
      { domain_id: id, name: domain.name, method },
      server.id,
    );

    if (!ok) {
      const line = `${txtName}. ${VERIFICATION_TTL} IN TXT "${expectedTxt}"`;
      throw new ApiException(
        "precondition_failed",
        `${server.name} cannot see proof that you control ${domain.name}.`,
        {
          detail: {
            resolver,
            txt_found: txtValues,
            ns_found: nsValues,
            expected_nameservers: expectedNs,
          },
          remediation: {
            summary: `Publish this record, wait for the TTL to pass, then verify again: ${line}`,
            actions: [
              { label: "Copy the record", copy: line },
              { label: "Open DNS", href: `/websites/dns?domain_id=${id}` },
              { label: "Verify again", action: "domains.verify" },
            ],
          },
        },
      );
    }

    return item(reply, await domainApi(req.ctx.db, id));
  });
}

/* ------------------------------------------------------------------ */

/** Loads a domain and asserts the caller holds `permission` on its host. */
export async function loadDomainRow(
  req: FastifyRequest,
  domainId: string,
  permission: Permission,
): Promise<typeof domains.$inferSelect> {
  const rows = await req.ctx.db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("Domain", domainId);
  helpers(req).authorize(permission, row.serverId);
  return row;
}

/**
 * Scope filter for domain-backed lists. A domain with no server is not
 * bound to a host, so a server-scoped principal may still see it.
 */
export function domainScope(req: FastifyRequest, permission: Permission): SQL | null {
  const filter = scopeFilter(req, permission, domains.serverId);
  return filter ? (or(filter, isNull(domains.serverId)) ?? null) : null;
}

export async function domainApi(db: Database, domainId: string): Promise<Domain> {
  const rows = await db
    .select(domainSelection)
    .from(domains)
    .leftJoin(sites, eq(domains.siteId, sites.id))
    .leftJoin(servers, eq(domains.serverId, servers.id))
    .where(eq(domains.id, domainId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Domain", domainId);
  return domainToApi(row);
}

export function domainToApi(row: DomainApiRow): Domain {
  const d = row.domain;
  return {
    id: d.id,
    name: d.name,
    site_id: d.siteId,
    site_name: row.site_name,
    server_id: d.serverId,
    server_name: row.server_name,
    dns_provider: d.dnsProvider,
    dns_zone_id: d.dnsZoneId,
    proxied: d.proxied,
    status: apiStatus(d),
    registrar: d.registrar,
    expires_at: d.expiresAt?.toISOString() ?? null,
    nameservers: d.nameservers,
    record_count: row.record_count,
    verified: {
      ok: d.verified,
      method: (d.verificationMethod as DomainVerificationMethod | null) ?? "none",
      checked_at: d.verifiedAt?.toISOString() ?? null,
    },
    has_mail: d.hasMail,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

/* ---------------------------- internals ---------------------------- */

/**
 * The stored lifecycle has four states; the API has five, because the
 * UI needs to tell "waiting on DNS" apart from "we never proved this is
 * yours". `verified` is what separates them.
 */
function apiStatus(row: typeof domains.$inferSelect): DomainStatus {
  switch (row.status) {
    case "active":
      return "active";
    case "error":
      return "error";
    case "disabled":
      return "parked";
    default:
      return row.verified ? "pending" : "unverified";
  }
}

function statusFilter(status: DomainStatus): SQL {
  switch (status) {
    case "active":
      return eq(domains.status, "active");
    case "error":
      return eq(domains.status, "error");
    case "parked":
      return eq(domains.status, "disabled");
    case "pending":
      return and(eq(domains.status, "pending"), eq(domains.verified, true))!;
    default:
      return and(eq(domains.status, "pending"), eq(domains.verified, false))!;
  }
}

/** Deterministic, so the operator can publish the record before verifying. */
function verificationToken(masterKey: Buffer, domainId: string): string {
  return hmac(masterKey, "domain-verification", domainId).slice(0, 32);
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$/s, "$1");
}

async function siteServerId(db: Database, siteId: string | null): Promise<string | null> {
  if (!siteId) return null;
  const rows = await db
    .select({ serverId: sites.serverId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  return rows[0]?.serverId ?? null;
}

/** Attaching a domain to a site is a write against that site's host. */
async function assertSiteVisible(req: FastifyRequest, siteId: string): Promise<void> {
  const rows = await req.ctx.db
    .select({ serverId: sites.serverId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Site", siteId);
  helpers(req).authorize("websites.sites:write", row.serverId);
}
