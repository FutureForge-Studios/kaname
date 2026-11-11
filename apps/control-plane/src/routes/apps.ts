import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, ne, or, sql, type SQL } from "@kaname/db";
import {
  appInstalls,
  certificates,
  dbInstances,
  domains,
  servers,
  sites,
  type AppInstallStepState,
} from "@kaname/db/schema";
import {
  APP_CATALOG,
  TERMINAL_JOB_STATUSES,
  appInstallListQuery,
  appInstallSteps,
  findApp,
  idParam,
  installAppInput,
  type AppInstall,
  type AppInstallPlan,
  type AppRecipe,
  type DbEngine,
  type InstallAppInput,
} from "@kaname/contract";
import { z } from "zod";
import {
  accepted,
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
import { ApiException, conflict, notFound } from "../lib/errors.js";
import { buildPlan, chooseEngine, installNames } from "../services/app-installer.js";
import { combine, enqueueServerJob, loadServer, scopeFilter, type ServerRow } from "./_shared.js";
import { isOwnedBy, ownership } from "./_ownership.js";

/* ------------------------------------------------------------------ *
 * Apps — the one-click installer.
 *
 * The catalog is data in the contract package; an install is a row
 * here plus one job. This module's whole job is to refuse an install
 * that cannot work *before* anything is created (wrong server, no
 * database engine, a name already taken) and then hand over to the
 * queue: like every other route, it never performs an agent RPC with
 * a side effect (KD-008).
 *
 * `apps.installs:write` is the only grant an install needs. The
 * installer creates the site, the database and the certificate itself,
 * from a recipe the caller cannot alter, so it does not also ask for
 * websites.* and databases.* — that would make "may install WordPress"
 * unusable without handing over the modules it is a safer front for.
 *
 * Every route opts in to ownership (KD-039): a reseller or client sees
 * only installs it started or whose site it owns, may only install on
 * a domain that is new or already theirs, and has to fit its quota.
 * What the install job creates is recorded as theirs by
 * services/app-ownership.ts.
 * ------------------------------------------------------------------ */

type InstallRow = typeof appInstalls.$inferSelect;

const catalogParam = z.object({ id: z.string().min(1).max(64) });

/** Install statuses during which a job is (or should be) working on the row. */
const IN_FLIGHT = new Set(["queued", "installing", "rolling_back", "removing"]);

export async function appRoutes(app: FastifyInstance): Promise<void> {
  /* ----------------------------- catalog ---------------------------- */

  app.get("/apps/catalog", async (req, reply) => {
    ownership(req);
    helpers(req).authorize("apps.installs:read", null);
    return list(reply, [...APP_CATALOG], paginate(APP_CATALOG.length, 1, APP_CATALOG.length || 1));
  });

  app.get("/apps/catalog/:id", async (req, reply) => {
    ownership(req);
    helpers(req).authorize("apps.installs:read", null);
    const { id } = parseParams(req, catalogParam);
    const recipe = findApp(id);
    if (!recipe) throw notFound("App", id);
    return item(reply, recipe);
  });

  /* ------------------------------ plan ------------------------------ */

  /**
   * The dry run. Runs every check the install runs and answers with
   * what would be created, so the review screen shows real names and a
   * refusal arrives while the form is still open.
   */
  app.post("/apps/installs/plan", async (req, reply) => {
    const body = parseBody(req, installAppInput);
    const { plan } = await preflight(req, body);
    return item(reply, plan);
  });

  /* ----------------------------- install ---------------------------- */

  app.post("/apps/installs", async (req, reply) => {
    const body = parseBody(req, installAppInput);
    const { recipe, server, engine, plan } = await preflight(req, body);
    const h = helpers(req);
    const principal = h.requirePrincipal();

    // A failed install of the same domain that left nothing behind is
    // history, not an obstacle: the new attempt replaces it.
    // (Preflight has already refused if one of them left anything behind.)
    await req.ctx.db
      .delete(appInstalls)
      .where(and(eq(appInstalls.domain, body.domain), eq(appInstalls.status, "failed")));

    const steps: AppInstallStepState[] = appInstallSteps(recipe, { ssl: body.ssl }).map((step) => ({
      id: step.id,
      status: "pending",
      message: null,
      started_at: null,
      finished_at: null,
    }));

    const [row] = await req.ctx.db
      .insert(appInstalls)
      .values({
        id: plan.plan_id,
        appId: recipe.id,
        appName: recipe.name,
        appVersion: recipe.version,
        serverId: server.id,
        domain: body.domain,
        status: "queued",
        ssl: body.ssl,
        dbEngine: engine,
        inputs: {
          admin_email: body.admin_email,
          system_user: body.system_user,
          php_version: body.php_version ?? null,
        },
        steps,
        createdBy: principal.kind === "user" ? principal.id : null,
        createdByName: principal.name,
      })
      .returning();

    let job;
    try {
      job = await enqueueServerJob(req, {
        type: "app.install",
        server,
        targetType: "app_install",
        targetId: row!.id,
        targetLabel: `${recipe.name} on ${body.domain}`,
        // The row is the job's whole input. No credential travels here:
        // the database password is generated inside the job and sealed.
        params: { install_id: row!.id, app_id: recipe.id, domain: body.domain },
      });
    } catch (err) {
      await req.ctx.db.delete(appInstalls).where(eq(appInstalls.id, row!.id));
      throw err;
    }

    await req.ctx.db
      .update(appInstalls)
      .set({ jobId: job.id, updatedAt: new Date() })
      .where(eq(appInstalls.id, row!.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "app.install.created",
      targetType: "app_install",
      targetId: row!.id,
      targetLabel: `${recipe.name} on ${body.domain}`,
      serverId: server.id,
      jobId: job.id,
      after: {
        app_id: recipe.id,
        version: recipe.version,
        domain: body.domain,
        ssl: body.ssl,
        db_engine: engine,
        system_user: body.system_user,
      },
    });

    const install = await installApi(req, row!.id);
    return reply.status(202).send({ data: { job, install } });
  });

  /* ------------------------------ list ------------------------------ */

  app.get("/apps/installs", async (req, reply) => {
    const own = ownership(req);
    const q = parseQuery(req, appInstallListQuery);
    helpers(req).authorize("apps.installs:read", q.server_id ?? null);

    const where = combine(
      scopeFilter(req, "apps.installs:read", appInstalls.serverId),
      own.account ? installsOwnedBy(own.account.ownerIds) : null,
      q.server_id ? eq(appInstalls.serverId, q.server_id) : null,
      q.app_id ? eq(appInstalls.appId, q.app_id) : null,
      q.status ? eq(appInstalls.status, q.status) : null,
      q.q
        ? sql`(lower(${appInstalls.domain}) like ${`%${q.q.trim().toLowerCase()}%`}
            or lower(${appInstalls.appName}) like ${`%${q.q.trim().toLowerCase()}%`})`
        : null,
    );

    const [rows, counted] = await Promise.all([
      req.ctx.db
        .select({ install: appInstalls, server_name: servers.name })
        .from(appInstalls)
        .innerJoin(servers, eq(appInstalls.serverId, servers.id))
        .where(where)
        .orderBy(desc(appInstalls.createdAt))
        .limit(q.per_page)
        .offset(offset(q.page, q.per_page)),
      req.ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(appInstalls)
        .where(where),
    ]);

    return list(
      reply,
      rows.map((r) => installToApi(r.install, r.server_name)),
      paginate(counted[0]?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/apps/installs/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const row = await loadInstall(req, id, "apps.installs:read");
    return item(reply, await installApi(req, row.id));
  });

  /* ---------------------------- uninstall --------------------------- */

  /**
   * Removes the app and everything the install created for it: the
   * vhost, the files, the database and its user, the certificate. A
   * failed install that already rolled itself back has nothing on the
   * host, so its row is simply dismissed (204) with no job.
   */
  app.delete("/apps/installs/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const row = await loadInstall(req, id, "apps.installs:delete");
    const server = await loadServer(req, row.serverId, "apps.installs:delete");
    const h = helpers(req);

    if (IN_FLIGHT.has(row.status)) {
      const job = row.jobId ? await req.ctx.queue.get(row.jobId) : null;
      if (job && !TERMINAL_JOB_STATUSES.includes(job.status)) {
        throw conflict(`${row.appName} on ${row.domain} is still being worked on.`, {
          summary:
            "An install or uninstall job is in flight for it. Wait for that job to finish, or cancel it, then try again.",
          actions: [{ label: "Open the job", href: `/jobs/${job.id}` }],
        });
      }
    }

    if (row.status === "failed" && nothingLeft(row)) {
      await req.ctx.db.delete(appInstalls).where(eq(appInstalls.id, row.id));
      await req.ctx.audit.record({
        actor: h.actor(),
        action: "app.install.dismissed",
        targetType: "app_install",
        targetId: row.id,
        targetLabel: `${row.appName} on ${row.domain}`,
        serverId: server.id,
        before: { app_id: row.appId, domain: row.domain, error: row.error },
      });
      return noContent(reply);
    }

    const job = await enqueueServerJob(req, {
      type: "app.uninstall",
      server,
      targetType: "app_install",
      targetId: row.id,
      targetLabel: `${row.appName} on ${row.domain}`,
      params: { install_id: row.id, app_id: row.appId, domain: row.domain },
    });
    await req.ctx.db
      .update(appInstalls)
      .set({ status: "removing", jobId: job.id, updatedAt: new Date() })
      .where(eq(appInstalls.id, row.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "app.install.removed",
      targetType: "app_install",
      targetId: row.id,
      targetLabel: `${row.appName} on ${row.domain}`,
      serverId: server.id,
      jobId: job.id,
      before: {
        app_id: row.appId,
        domain: row.domain,
        site_id: row.siteId,
        database_id: row.databaseId,
        certificate_id: row.certificateId,
      },
    });

    return accepted(reply, job);
  });
}

/* ------------------------------------------------------------------ *
 * Preflight
 * ------------------------------------------------------------------ */

interface Preflight {
  recipe: AppRecipe;
  server: ServerRow;
  engine: DbEngine | null;
  plan: AppInstallPlan;
}

function precondition(
  messageText: string,
  summary: string,
  actions: { label: string; href: string }[] = [],
  fields?: Record<string, string>,
): ApiException {
  return new ApiException("precondition_failed", messageText, {
    remediation: { summary, actions },
    ...(fields ? { fields } : {}),
  });
}

/**
 * Everything that can be known to be wrong without touching the host.
 * Shared by the dry run and the real install, so "the plan said yes"
 * and "the install was refused" cannot both be true of the same input.
 */
async function preflight(req: FastifyRequest, body: InstallAppInput): Promise<Preflight> {
  const own = ownership(req);
  const recipe = findApp(body.app_id);
  if (!recipe) throw notFound("App", body.app_id);

  const server = await loadServer(req, body.server_id, "apps.installs:write");
  const db = req.ctx.db;
  const notices: string[] = [];

  if (recipe.availability !== "available") {
    throw precondition(
      `${recipe.name} cannot be installed yet.`,
      recipe.unavailable_reason ?? "It is listed in the catalog but not available on this version.",
    );
  }

  /* host capabilities — known only while the agent is connected */
  if (req.ctx.hub.isConnected(server.id)) {
    const has = req.ctx.hub.capabilities(server.id);
    const missing = recipe.requirements.capabilities.filter((c) => !has.includes(c));
    if (missing.length > 0) {
      throw precondition(
        `${server.name} does not have ${missing.join(" or ")}, which ${recipe.name} needs.`,
        `Install ${missing.join(" and ")} on the server, wait for its agent to report it, and try again.`,
        [{ label: "Open the server", href: `/infrastructure/servers/${server.id}` }],
        { server_id: `needs ${missing.join(", ")}` },
      );
    }
  } else {
    notices.push(
      `${server.name} is offline. The install is queued and starts when its agent reconnects.`,
    );
  }

  /* database engine */
  const instances = await db
    .select({ engine: dbInstances.engine })
    .from(dbInstances)
    .where(eq(dbInstances.serverId, server.id));
  const choice = chooseEngine(
    recipe,
    body.db_engine,
    instances.map((i) => i.engine),
  );
  if (choice.problem) {
    throw precondition(
      choice.problem,
      `${recipe.name} keeps its data in a database on the same server as the site. Pick a server that runs one of ${recipe.requirements.database?.engines.join(", ")}, or install the engine there first.`,
      [{ label: "Databases", href: "/databases/mysql" }],
      { [body.db_engine ? "db_engine" : "server_id"]: choice.problem },
    );
  }

  /* names */
  const domain = body.domain;
  const clash = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.serverId, server.id), eq(sites.name, domain)))
    .limit(1);
  if (clash[0]) {
    throw conflict(`${server.name} already has a site named "${domain}".`, {
      summary:
        "The installer names the site after its domain. Remove the existing site, or install on a different domain.",
      actions: [{ label: "Open it", href: `/websites/sites/${clash[0].id}` }],
    });
  }

  const known = await db.select().from(domains).where(eq(domains.name, domain)).limit(1);
  // A scoped account installs on a domain that is new or already its own.
  if (known[0]) await own.assertOwns("domain", known[0].id, `Domain ${domain}`);
  if (known[0]?.siteId) {
    throw conflict(`${domain} already answers on another site.`, {
      summary:
        "A domain belongs to one site at a time. Detach it from that site, or install on a different domain or subdomain.",
      actions: [{ label: "Open that site", href: `/websites/sites/${known[0].siteId}` }],
    });
  }

  const planId = body.plan_id ?? crypto.randomUUID();
  const taken = await db
    .select({ id: appInstalls.id, status: appInstalls.status, appName: appInstalls.appName })
    .from(appInstalls)
    .where(and(eq(appInstalls.domain, domain), ne(appInstalls.status, "failed")))
    .limit(1);
  if (taken[0]) {
    throw conflict(`${taken[0].appName} is already installed on ${domain}.`, {
      summary: "One app per domain. Uninstall it first, or choose a different domain or subdomain.",
      actions: [{ label: "Installed apps", href: "/apps?tab=installed" }],
    });
  }
  const stale = await db
    .select()
    .from(appInstalls)
    .where(and(eq(appInstalls.domain, domain), eq(appInstalls.status, "failed")));
  const dirty = stale.find((row) => !nothingLeft(row));
  if (dirty) {
    throw conflict(`An earlier install of ${dirty.appName} on ${domain} could not be fully removed.`, {
      summary:
        "Uninstall it from Installed apps so its leftovers are cleaned up, then install again.",
      actions: [{ label: "Installed apps", href: "/apps?tab=installed" }],
    });
  }

  // A plan id is only a way to keep names stable between review and
  // install; one that is already a row is replaced rather than trusted.
  const reused = await db
    .select({ id: appInstalls.id })
    .from(appInstalls)
    .where(eq(appInstalls.id, planId))
    .limit(1);
  const installId = reused[0] ? crypto.randomUUID() : planId;

  if (body.ssl) {
    const cert = await db
      .select({ id: certificates.id })
      .from(certificates)
      .where(and(eq(certificates.serverId, server.id), eq(certificates.subject, domain)))
      .limit(1);
    notices.push(
      cert[0]
        ? `${server.name} already holds a certificate for ${domain}; the site will use it.`
        : `The certificate can only be issued once ${domain} points at ${server.name}. If it does not yet, the app is still installed and the certificate can be retried from SSL / TLS.`,
    );
  }

  // What the job will create has to fit the caller's allowance (KD-039).
  await own.reserve("site");
  if (!known[0]) await own.reserve("domain");
  if (choice.engine) await own.reserve("database");

  const names = installNames(recipe, body, installId);
  notices.push(`Files go in ${names.deployRoot}, owned by the "${body.system_user}" account.`);

  return {
    recipe,
    server,
    engine: choice.engine,
    plan: buildPlan(recipe, body, {
      installId,
      serverName: server.name,
      engine: choice.engine,
      notices,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

async function loadInstall(
  req: FastifyRequest,
  id: string,
  permission: "apps.installs:read" | "apps.installs:delete",
): Promise<InstallRow> {
  const rows = await req.ctx.db.select().from(appInstalls).where(eq(appInstalls.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("App install", id);
  helpers(req).authorize(permission, row.serverId);
  const account = req.principal?.scoped;
  if (account && !(await installVisibleTo(req, row, account.ownerIds))) {
    throw notFound("App install", id);
  }
  return row;
}

/** Installs a scoped account may see: ones it started, or whose site it owns. */
function installsOwnedBy(ownerIds: readonly string[]): SQL {
  if (ownerIds.length === 0) return sql`false`;
  return or(
    inArray(appInstalls.createdBy, [...ownerIds]),
    siteOwnedBy(appInstalls.siteId, ownerIds),
  )!;
}

function siteOwnedBy(column: typeof appInstalls.siteId, ownerIds: readonly string[]): SQL {
  return sql`exists (select 1 from resource_owners o
    where o.kind = 'site' and o.resource_id = ${column}
      and o.owner_id in (${sql.join(
        ownerIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}))`;
}

async function installVisibleTo(
  req: FastifyRequest,
  row: InstallRow,
  ownerIds: readonly string[],
): Promise<boolean> {
  if (row.createdBy && ownerIds.includes(row.createdBy)) return true;
  return row.siteId ? isOwnedBy(req.ctx.db, "site", row.siteId, ownerIds) : false;
}

async function installApi(req: FastifyRequest, id: string): Promise<AppInstall> {
  const rows = await req.ctx.db
    .select({ install: appInstalls, server_name: servers.name })
    .from(appInstalls)
    .innerJoin(servers, eq(appInstalls.serverId, servers.id))
    .where(eq(appInstalls.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("App install", id);
  return installToApi(row.install, row.server_name);
}

/** True when a failed install has no host resource or row left to remove. */
function nothingLeft(row: InstallRow): boolean {
  const r = row.resources;
  const flags = [
    r.database_attempted,
    r.database_created,
    r.db_user_attempted,
    r.db_user_created,
    r.files_attempted,
    r.files_created,
    r.site_attempted,
    r.site_created,
    r.certificate_issued,
  ];
  return (
    !flags.some(Boolean) &&
    !row.siteId &&
    !row.databaseId &&
    !row.dbUserId &&
    !row.certificateId &&
    !row.domainId
  );
}

export function installToApi(row: InstallRow, serverName: string): AppInstall {
  const recipe = findApp(row.appId);
  const specs = recipe ? appInstallSteps(recipe, { ssl: row.ssl }) : [];
  const byId = new Map(specs.map((s) => [s.id, s]));

  return {
    id: row.id,
    app_id: row.appId,
    app_name: row.appName,
    app_version: row.appVersion,
    category: recipe?.category ?? null,
    server_id: row.serverId,
    server_name: serverName,
    domain: row.domain,
    url: `${row.ssl ? "https" : "http"}://${row.domain}`,
    status: row.status,
    ssl: row.ssl,
    db_engine: row.dbEngine,
    site_id: row.siteId,
    domain_id: row.domainId,
    database_id: row.databaseId,
    db_user_id: row.dbUserId,
    certificate_id: row.certificateId,
    steps: row.steps.map((step) => ({
      id: step.id,
      title: byId.get(step.id)?.title ?? step.id,
      description: byId.get(step.id)?.description ?? "",
      status: step.status,
      message: step.message,
      started_at: step.started_at,
      finished_at: step.finished_at,
    })),
    error: row.error ?? null,
    job_id: row.jobId,
    finish: recipe?.finish ?? "",
    created_by: row.createdBy,
    created_by_name: row.createdByName,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
