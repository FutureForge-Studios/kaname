import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, notInArray, sql, type Database } from "@kaname/db";
import { deployments, domains, servers, sites } from "@kaname/db/schema";
import {
  createSiteInput,
  deploymentListQuery,
  idParam,
  siteListQuery,
  updateSiteInput,
  type CertStatus,
  type DeploymentStatus,
  type Permission,
  type Site,
  type SiteDomainRef,
} from "@kaname/contract";
import { z } from "zod";
import {
  accepted,
  helpers,
  item,
  list,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { ApiException, agentOffline, conflict, fromAgentError, notFound } from "../lib/errors.js";
import {
  combine,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
} from "./_shared.js";
import { deploymentSelection, deploymentToApi } from "./deployments.js";

/* ------------------------------------------------------------------ *
 * Sites.
 *
 * A site row is Kaname's intent; the vhost on the host is the effect.
 * Every write therefore lands in the table first and reaches nginx as a
 * job (KD-008), which is what lets "provisioning" be a real, resumable
 * state instead of an HTTP timeout.
 * ------------------------------------------------------------------ */

const SORTABLE = {
  name: sites.name,
  runtime: sites.runtime,
  status: sites.status,
  disk_usage: sites.diskUsage,
  created_at: sites.createdAt,
  updated_at: sites.updatedAt,
} as const;

/** `nginx -t` on a busy host is slow but never minutes; fail fast instead. */
const CONFIG_TEST_TIMEOUT_MS = 20_000;

interface SslSummary {
  certificate_id: string;
  status: CertStatus;
  expires_at: string | null;
}

interface DeploymentSummary {
  id: string;
  status: DeploymentStatus;
  finished_at: string | null;
}

/**
 * The vhost fields the host owns and the API exposes, kept in `config`
 * so a reconcile can write them back without a schema change.
 */
type SiteConfig = {
  primary_domain?: string;
  php_version?: string;
  last_synced_at?: string;
};

const siteSelection = {
  site: sites,
  server_name: servers.name,
  domain_refs: sql<SiteDomainRef[]>`coalesce((
    select json_agg(json_build_object('id', d.id, 'name', d.name) order by d.name)
    from domains d where d.site_id = ${sites.id}
  ), '[]'::json)`,
  ssl: sql<SslSummary | null>`(
    select json_build_object('certificate_id', c.id, 'status', c.status, 'expires_at', c.expires_at)
    from certificates c join domains cd on cd.id = c.domain_id
    where cd.site_id = ${sites.id} and c.server_id = ${sites.serverId}
    order by (c.status = 'active') desc, c.expires_at desc nulls last
    limit 1
  )`,
  last_deployment: sql<DeploymentSummary | null>`(
    select json_build_object('id', dep.id, 'status', dep.status, 'finished_at', dep.finished_at)
    from deployments dep where dep.site_id = ${sites.id}
    order by dep.created_at desc
    limit 1
  )`,
};

type SiteApiRow = {
  site: typeof sites.$inferSelect;
  server_name: string;
  domain_refs: SiteDomainRef[];
  ssl: SslSummary | null;
  last_deployment: DeploymentSummary | null;
};

/**
 * `z.coerce.boolean()` reads the string "false" as true. A webroot is
 * not something that may be deleted by a coercion bug.
 */
const removeSiteQuery = z.object({
  delete_webroot: z.enum(["true", "false"]).default("false"),
});

export async function siteRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/sites", async (req, reply) => {
    const q = parseQuery(req, siteListQuery);
    helpers(req).authorize("websites.sites:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "websites.sites:read", sites.serverId),
      q.server_id ? eq(sites.serverId, q.server_id) : null,
      q.runtime ? eq(sites.runtime, q.runtime) : null,
      q.status ? eq(sites.status, q.status) : null,
      q.domain
        ? sql`exists (select 1 from domains d where d.site_id = ${sites.id}
              and lower(d.name) like ${`%${q.domain.toLowerCase()}%`})`
        : null,
      q.ssl_status
        ? sql`exists (select 1 from certificates c join domains cd on cd.id = c.domain_id
              where cd.site_id = ${sites.id} and c.status = ${q.ssl_status})`
        : null,
      term
        ? sql`(lower(${sites.name}) like ${term} or lower(${sites.webroot}) like ${term}
               or exists (select 1 from domains d where d.site_id = ${sites.id} and lower(d.name) like ${term}))`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "name");
    const rows = await req.ctx.db
      .select(siteSelection)
      .from(sites)
      .innerJoin(servers, eq(sites.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(sites)
      .innerJoin(servers, eq(sites.serverId, servers.id))
      .where(where);

    return list(reply, rows.map(siteToApi), paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/sites/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    await loadSiteRow(req, id, "websites.sites:read");
    return item(reply, await siteApi(req.ctx.db, id));
  });

  /* ----------------------------- create ----------------------------- */

  app.post("/sites", async (req, reply) => {
    const body = parseBody(req, createSiteInput);
    const server = await loadServer(req, body.server_id, "websites.sites:write");
    const h = helpers(req);

    assertUpstream(body.runtime, body.upstream);

    const existing = await req.ctx.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.serverId, body.server_id), eq(sites.name, body.name)))
      .limit(1);
    if (existing[0]) {
      throw conflict(`${server.name} already has a site named "${body.name}".`, {
        summary: "Site names are the vhost file name, so they are unique per host.",
        actions: [{ label: "Open it", href: `/websites/sites/${existing[0].id}` }],
      });
    }

    const names = serverNames(body.primary_domain, body.domains);
    const known = await assertDomainsAvailable(req.ctx.db, names, null);

    const [row] = await req.ctx.db
      .insert(sites)
      .values({
        serverId: body.server_id,
        name: body.name,
        webroot: body.webroot,
        runtime: body.runtime,
        runtimeVersion: body.runtime_version ?? null,
        upstream: body.upstream ?? null,
        forceHttps: body.force_https,
        owner: body.owner ?? null,
        status: "provisioning",
        config: configOf(body.primary_domain, body.php_version),
      })
      .returning();

    await attachDomains(req.ctx.db, row!, names, known);

    const job = await enqueueServerJob(req, {
      type: "site.create",
      server,
      targetType: "site",
      targetId: row!.id,
      targetLabel: row!.name,
      params: {
        site_id: row!.id,
        name: row!.name,
        server_names: names,
        webroot: row!.webroot,
        runtime: row!.runtime,
        ...(row!.runtimeVersion ? { runtime_version: row!.runtimeVersion } : {}),
        ...(row!.upstream ? { upstream: row!.upstream } : {}),
        force_https: row!.forceHttps,
        ...(row!.owner ? { owner: row!.owner } : {}),
      },
    });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "site.created",
      targetType: "site",
      targetId: row!.id,
      targetLabel: row!.name,
      serverId: server.id,
      jobId: job.id,
      after: { ...body, domains: names },
    });
    // There is no `sites` event topic; a site is a property of its host,
    // and the UI already follows that server's feed.
    req.ctx.events.publish(
      "servers",
      "site.created",
      { site_id: row!.id, server_id: server.id, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ----------------------------- update ----------------------------- */

  app.patch("/sites/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateSiteInput);
    const before = await loadSiteRow(req, id, "websites.sites:write");
    const server = await loadServer(req, before.serverId, "websites.sites:write");
    const h = helpers(req);

    const runtime = body.runtime ?? before.runtime;
    assertUpstream(runtime, body.upstream ?? before.upstream ?? undefined);

    if (body.name && body.name !== before.name) {
      const clash = await req.ctx.db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.serverId, before.serverId), eq(sites.name, body.name)))
        .limit(1);
      if (clash[0]) {
        throw conflict(`${server.name} already has a site named "${body.name}".`, {
          summary: "Site names are the vhost file name, so they are unique per host.",
          actions: [{ label: "Open it", href: `/websites/sites/${clash[0].id}` }],
        });
      }
    }

    const config = siteConfig(before);
    const primary = body.primary_domain ?? config.primary_domain;
    const renaming = body.primary_domain !== undefined || body.domains !== undefined;

    const [row] = await req.ctx.db
      .update(sites)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.webroot !== undefined ? { webroot: body.webroot } : {}),
        ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
        ...(body.runtime_version !== undefined ? { runtimeVersion: body.runtime_version } : {}),
        ...(body.upstream !== undefined ? { upstream: body.upstream } : {}),
        ...(body.force_https !== undefined ? { forceHttps: body.force_https } : {}),
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        config: { ...config, ...configOf(primary, body.php_version ?? config.php_version) },
        updatedAt: new Date(),
      })
      .where(eq(sites.id, id))
      .returning();

    const attached = await currentNames(req.ctx.db, id, config.primary_domain);
    let names = attached;
    if (renaming) {
      if (!primary) {
        throw new ApiException("validation_failed", "A site needs a primary domain to answer on.", {
          fields: { primary_domain: "required" },
        });
      }
      // Promoting a primary domain must not silently drop the aliases, so
      // an absent `domains` means "keep what is attached".
      names = serverNames(primary, body.domains ?? attached);
      const known = await assertDomainsAvailable(req.ctx.db, names, id);
      await attachDomains(req.ctx.db, row!, names, known);
    }

    const job = await enqueueServerJob(req, {
      type: "site.update",
      server,
      targetType: "site",
      targetId: id,
      targetLabel: row!.name,
      params: {
        site_id: id,
        name: row!.name,
        server_names: names,
        webroot: row!.webroot,
        ...(row!.runtimeVersion ? { runtime_version: row!.runtimeVersion } : {}),
        ...(row!.upstream ? { upstream: row!.upstream } : {}),
        force_https: row!.forceHttps,
      },
    });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "site.updated",
      targetType: "site",
      targetId: id,
      targetLabel: row!.name,
      serverId: server.id,
      jobId: job.id,
      before: {
        name: before.name,
        webroot: before.webroot,
        runtime: before.runtime,
        upstream: before.upstream,
        force_https: before.forceHttps,
      },
      after: body,
    });
    req.ctx.events.publish(
      "servers",
      "site.updated",
      { site_id: id, server_id: server.id, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ----------------------------- delete ----------------------------- */

  app.delete("/sites/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, removeSiteQuery);
    const site = await loadSiteRow(req, id, "websites.sites:delete");
    const server = await loadServer(req, site.serverId, "websites.sites:delete");
    const h = helpers(req);

    const job = await enqueueServerJob(req, {
      type: "site.remove",
      server,
      targetType: "site",
      targetId: id,
      targetLabel: site.name,
      params: { site_id: id, name: site.name, delete_webroot: q.delete_webroot === "true" },
    });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "site.deleted",
      targetType: "site",
      targetId: id,
      targetLabel: site.name,
      serverId: server.id,
      jobId: job.id,
      before: {
        name: site.name,
        webroot: site.webroot,
        delete_webroot: q.delete_webroot === "true",
      },
    });
    req.ctx.events.publish(
      "servers",
      "site.deleted",
      { site_id: id, server_id: server.id, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ----------------------------- reload ----------------------------- */

  app.post("/sites/:id/reload", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const site = await loadSiteRow(req, id, "websites.sites:write");
    const server = await loadConnectedServer(req, site.serverId, "websites.sites:write");

    // Read-only, so it passes through synchronously (KD-008). Reloading a
    // broken config takes down every other site on the host, so the check
    // has to happen before the job is even queued.
    let test: { valid: boolean; output: string };
    try {
      test = await req.ctx.hub.call(
        server.id,
        "site.test_config",
        {},
        { timeoutMs: CONFIG_TEST_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof AgentRpcError) throw fromAgentError(server.name, err.agentError);
      if (err instanceof AgentOfflineError) throw agentOffline(server.name, server.lastSeenAt);
      throw err;
    }

    if (!test.valid) {
      throw new ApiException(
        "precondition_failed",
        `The web server configuration on ${server.name} is invalid, so reloading would take every site on the host offline.`,
        {
          detail: { output: test.output },
          remediation: {
            summary: lastLines(test.output, 3) || "The web server reported an error but no output.",
            actions: [
              { label: "Copy the error", copy: test.output.slice(0, 2048) },
              {
                label: "Open the vhost",
                href: `/files/manager?server_id=${server.id}&path=${encodeURIComponent(site.configPath ?? "/etc/nginx")}`,
              },
              { label: "Test again", action: "sites.reload" },
            ],
          },
        },
      );
    }

    const job = await enqueueServerJob(req, {
      type: "site.reload",
      server,
      targetType: "site",
      targetId: id,
      targetLabel: site.name,
    });
    return accepted(reply, job);
  });

  /* -------------------------- deployments --------------------------- */

  app.get("/sites/:id/deployments", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, deploymentListQuery);
    await loadSiteRow(req, id, "websites.deployments:read");

    const where = combine(
      eq(deployments.siteId, id),
      q.status ? eq(deployments.status, q.status) : null,
      q.source ? eq(deployments.source, q.source) : null,
      q.branch ? eq(deployments.branch, q.branch) : null,
    );

    const rows = await req.ctx.db
      .select(deploymentSelection)
      .from(deployments)
      .innerJoin(sites, eq(deployments.siteId, sites.id))
      .where(where)
      .orderBy(desc(deployments.createdAt))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(deployments)
      .where(where);

    return list(
      reply,
      rows.map(deploymentToApi),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });
}

/* ------------------------------------------------------------------ */

/** Loads a site and asserts the caller holds `permission` on its host. */
export async function loadSiteRow(
  req: FastifyRequest,
  siteId: string,
  permission: Permission,
): Promise<typeof sites.$inferSelect> {
  const rows = await req.ctx.db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("Site", siteId);
  helpers(req).authorize(permission, row.serverId);
  return row;
}

export async function siteApi(db: Database, siteId: string): Promise<Site> {
  const rows = await db
    .select(siteSelection)
    .from(sites)
    .innerJoin(servers, eq(sites.serverId, servers.id))
    .where(eq(sites.id, siteId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Site", siteId);
  return siteToApi(row);
}

export function siteToApi(row: SiteApiRow): Site {
  const s = row.site;
  const config = siteConfig(s);
  const refs = row.domain_refs ?? [];

  return {
    id: s.id,
    server_id: s.serverId,
    server_name: row.server_name,
    name: s.name,
    webroot: s.webroot,
    runtime: s.runtime,
    runtime_version: s.runtimeVersion,
    status: s.status,
    primary_domain: config.primary_domain ?? refs[0]?.name ?? null,
    domains: refs,
    force_https: s.forceHttps,
    upstream: s.upstream,
    config_path: s.configPath,
    owner: s.owner,
    php_version: s.runtime === "php" ? s.runtimeVersion : (config.php_version ?? null),
    disk_usage: s.diskUsage,
    last_deployment: row.last_deployment
      ? {
          id: row.last_deployment.id,
          status: row.last_deployment.status,
          finished_at: isoOrNull(row.last_deployment.finished_at),
        }
      : null,
    ssl: row.ssl
      ? {
          certificate_id: row.ssl.certificate_id,
          status: row.ssl.status,
          expires_at: isoOrNull(row.ssl.expires_at),
          days_remaining: daysUntil(row.ssl.expires_at),
        }
      : null,
    last_synced_at: config.last_synced_at ?? null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

/* ---------------------------- internals ---------------------------- */

function siteConfig(row: typeof sites.$inferSelect): SiteConfig {
  return (row.config ?? {}) as SiteConfig;
}

function configOf(primaryDomain: string | undefined, phpVersion: string | undefined): SiteConfig {
  return {
    ...(primaryDomain ? { primary_domain: primaryDomain } : {}),
    ...(phpVersion ? { php_version: phpVersion } : {}),
  };
}

/** Primary first: nginx uses the first server_name as the canonical host. */
function serverNames(primary: string, extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [primary, ...extra]) {
    const normalized = name.trim().toLowerCase().replace(/\.$/, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function currentNames(
  db: Database,
  siteId: string,
  primary: string | undefined,
): Promise<string[]> {
  const rows = await db
    .select({ name: domains.name })
    .from(domains)
    .where(eq(domains.siteId, siteId))
    .orderBy(asc(domains.name));
  const names = rows.map((r) => r.name);
  if (!primary) return names;
  return serverNames(primary, names);
}

function assertUpstream(runtime: string, upstream: string | undefined): void {
  if ((runtime === "proxy" || runtime === "container") && !upstream) {
    throw new ApiException(
      "validation_failed",
      `A ${runtime} site needs an upstream to forward to.`,
      {
        fields: { upstream: `required for ${runtime} sites` },
        remediation: {
          summary:
            'Set an origin such as "http://127.0.0.1:3000". Kaname renders it as the vhost\'s proxy target; without it the generated config would have nowhere to send traffic.',
          actions: [],
        },
      },
    );
  }
}

/** A name answers on exactly one site, so a clash has to be refused up front. */
async function assertDomainsAvailable(
  db: Database,
  names: string[],
  siteId: string | null,
): Promise<(typeof domains.$inferSelect)[]> {
  if (names.length === 0) return [];
  const rows = await db.select().from(domains).where(inArray(domains.name, names));

  for (const row of rows) {
    if (row.siteId && row.siteId !== siteId) {
      throw conflict(`${row.name} already answers on another site.`, {
        summary:
          "A domain belongs to one site at a time, or two vhosts would claim the same server_name and nginx would pick whichever loaded first. Detach it there, then retry.",
        actions: [{ label: "Open that site", href: `/websites/sites/${row.siteId}` }],
      });
    }
  }
  return rows;
}

async function attachDomains(
  db: Database,
  site: typeof sites.$inferSelect,
  names: string[],
  known: (typeof domains.$inferSelect)[],
): Promise<void> {
  const byName = new Map(known.map((d) => [d.name, d]));

  for (const name of names) {
    const existing = byName.get(name);
    if (existing) {
      await db
        .update(domains)
        .set({ siteId: site.id, serverId: site.serverId, updatedAt: new Date() })
        .where(eq(domains.id, existing.id));
    } else {
      await db
        .insert(domains)
        .values({ name, siteId: site.id, serverId: site.serverId, status: "pending" });
    }
  }

  // A name removed from the site stops answering on it, but the domain row
  // survives so its DNS records and certificate history are not lost.
  if (names.length > 0) {
    await db
      .update(domains)
      .set({ siteId: null, updatedAt: new Date() })
      .where(and(eq(domains.siteId, site.id), notInArray(domains.name, names)));
  }
}

function lastLines(output: string, count: number): string {
  return output.trim().split("\n").slice(-count).join(" ").trim().slice(0, 480);
}

function isoOrNull(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function daysUntil(value: string | null): number | null {
  if (!value) return null;
  return Math.floor((new Date(value).getTime() - Date.now()) / 86_400_000);
}
