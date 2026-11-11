import type { FastifyInstance } from "fastify";
import { and, asc, inArray, isNull } from "@kaname/db";
import { servers } from "@kaname/db/schema";
import {
  bulkUpgradeOsPackagesInput,
  idParam,
  osUpdateSettingsInput,
  upgradeOsPackagesInput,
  type Job,
  type OsUpdatesFleet,
} from "@kaname/contract";
import { accepted, helpers, item, parseBody, parseParams } from "../http/plugin.js";
import { ApiException, agentOffline } from "../lib/errors.js";
import { AgentOfflineError } from "../agent/hub.js";
import {
  emptyOsUpdates,
  loadOne,
  loadOsUpdates,
  refreshOsUpdates,
  saveOsUpdates,
  toDetail,
  toSummary,
} from "../services/os-updates.js";
import { combine, enqueueServerJob, loadServer, scopeFilter } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Operating-system updates (the host's packages, not Kaname's).
 *
 * Reading is `infra.servers:read` and applying is `infra.servers:write`
 * — the permission `system.packages.upgrade` has always been specced
 * with, and the one that already guards rebooting the same host. Scoped
 * reseller and client accounts hold neither, so this is operator-only
 * without any check of its own.
 *
 * Every read serves the cache (services/os-updates.ts); only `refresh`
 * talks to the agent, and it is the one read that needs it connected.
 * ------------------------------------------------------------------ */

/** A refresh this soon after the last one answers from the cache. */
const REFRESH_DEBOUNCE_MS = 15_000;

export async function osUpdateRoutes(app: FastifyInstance): Promise<void> {
  /* ----------------------------- fleet ------------------------------ */

  app.get("/os-updates", async (req, reply) => {
    helpers(req).authorize("infra.servers:read");

    const rows = await req.ctx.db
      .select()
      .from(servers)
      .where(combine(scopeFilter(req, "infra.servers:read", servers.id), isNull(servers.revokedAt)))
      .orderBy(asc(servers.name));

    const cached = await loadOsUpdates(
      req.ctx.db,
      rows.map((r) => r.id),
    );
    const summaries = rows.map((server) => toSummary(server, cached.get(server.id) ?? emptyOsUpdates()));

    const fleet: OsUpdatesFleet = {
      totals: {
        servers: summaries.length,
        servers_with_updates: summaries.filter((s) => s.total > 0).length,
        servers_with_security_updates: summaries.filter((s) => s.security > 0).length,
        packages: summaries.reduce((n, s) => n + s.total, 0),
        security: summaries.reduce((n, s) => n + s.security, 0),
        reboot_required: summaries.filter((s) => s.reboot_required).length,
        unchecked: summaries.filter((s) => s.state === "unknown").length,
      },
      servers: summaries,
    };
    return item(reply, fleet);
  });

  app.post("/os-updates/upgrade", async (req, reply) => {
    const body = parseBody(req, bulkUpgradeOsPackagesInput);
    const h = helpers(req);
    h.authorize("infra.servers:write");

    // Authorise every host before queueing anything, so a scoped role
    // that may touch three of four servers gets a refusal rather than
    // three upgrades and an error.
    for (const id of body.server_ids) h.authorize("infra.servers:write", id);

    const rows = await req.ctx.db
      .select()
      .from(servers)
      .where(and(inArray(servers.id, body.server_ids), isNull(servers.revokedAt)));
    if (rows.length === 0) {
      throw new ApiException("not_found", "None of those servers are in the fleet.", {
        remediation: { summary: "Refresh the page; the server may have been removed.", actions: [] },
      });
    }

    const correlationId = crypto.randomUUID();
    const jobs: Job[] = [];
    for (const server of rows) {
      jobs.push(
        await enqueueServerJob(req, {
          type: "system.packages.upgrade",
          server,
          targetType: "server",
          targetId: server.id,
          targetLabel: server.name,
          correlationId,
          params: { names: [], security_only: body.security_only },
        }),
      );
    }
    return reply.status(202).send({ data: { correlation_id: correlationId, jobs } });
  });

  /* ---------------------------- one host ---------------------------- */

  app.get("/servers/:id/os-updates", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:read");
    return item(reply, toDetail(server, await loadOne(req.ctx.db, id)));
  });

  app.post("/servers/:id/os-updates/refresh", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const server = await loadServer(req, id, "infra.servers:read");

    const cached = await loadOne(req.ctx.db, id);
    if (cached.checked_at && Date.now() - Date.parse(cached.checked_at) < REFRESH_DEBOUNCE_MS) {
      return item(reply, toDetail(server, cached));
    }
    if (!req.ctx.hub.isConnected(id)) throw agentOffline(server);

    try {
      return item(reply, toDetail(server, await refreshOsUpdates(req.ctx, id)));
    } catch (err) {
      if (err instanceof AgentOfflineError) throw agentOffline(server);
      throw err;
    }
  });

  app.post("/servers/:id/os-updates/upgrade", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, upgradeOsPackagesInput);
    const server = await loadServer(req, id, "infra.servers:write");
    if (server.revokedAt) {
      throw new ApiException("conflict", `${server.name} has been revoked.`, {
        remediation: { summary: "A revoked host takes no more jobs.", actions: [] },
      });
    }

    const job = await enqueueServerJob(req, {
      type: "system.packages.upgrade",
      server,
      targetType: "server",
      targetId: id,
      targetLabel: server.name,
      params: { names: [], security_only: body.security_only },
    });
    return accepted(reply, job);
  });

  app.patch("/servers/:id/os-updates/settings", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, osUpdateSettingsInput);
    const h = helpers(req);
    const server = await loadServer(req, id, "infra.servers:write");

    const before = await loadOne(req.ctx.db, id);
    const after = await saveOsUpdates(req.ctx.db, id, { auto_security: body.auto_security });

    if (before.auto_security !== after.auto_security) {
      await req.ctx.audit.record({
        actor: h.actor(),
        action: "server.os_updates.settings_changed",
        targetType: "server",
        targetId: id,
        targetLabel: server.name,
        serverId: id,
        before: { auto_security: before.auto_security },
        after: { auto_security: after.auto_security },
      });
    }
    req.ctx.events.publish("updates", "os_updates.changed", { server_id: id }, id);
    return item(reply, toDetail(server, after));
  });
}

