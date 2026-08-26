import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "@kaname/db";
import { servers, updateRuns } from "@kaname/db/schema";
import {
  applyAgentUpdateInput,
  applyControlPlaneUpdateInput,
  idParam,
  updatePolicyInput,
  updateRunListQuery,
  type Job,
} from "@kaname/contract";
import {
  helpers,
  item,
  list,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { ApiException, notFound } from "../lib/errors.js";
import { toApiRun } from "../services/updates.js";
import { combine, enqueueServerJob } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Updates.
 *
 * Reading is `admin.settings:read` and everything that changes the
 * running software is `admin.settings:write`, including the cadence —
 * the setting that decides whether releases apply themselves is as
 * consequential as pressing the button once.
 * ------------------------------------------------------------------ */

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- overview ---------------------------- */

  app.get("/updates", async (req, reply) => {
    helpers(req).authorize("admin.settings:read");
    return item(reply, await req.ctx.updates.overview());
  });

  app.post("/updates/check", async (req, reply) => {
    const h = helpers(req);
    h.authorize("admin.settings:write");

    const result = await req.ctx.updates.checkNow();
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "update.checked",
      targetType: "settings",
      targetId: null,
      targetLabel: result.pending?.version ?? "no update",
    });

    return item(reply, await req.ctx.updates.overview());
  });

  /* ----------------------------- policy ----------------------------- */

  app.patch("/updates/policy", async (req, reply) => {
    const body = parseBody(req, updatePolicyInput);
    const h = helpers(req);
    h.authorize("admin.settings:write");

    const before = await req.ctx.updates.loadPolicy();

    // Moving to `auto_all` is deliberately not one click away from
    // `notify`: it is the tier that applies major releases without
    // asking, so the acknowledgement is part of the request.
    if (
      body.tier === "auto_all" &&
      before.tier !== "auto_all" &&
      !body.acknowledge_unattended_majors
    ) {
      throw new ApiException(
        "precondition_failed",
        "Applying everything automatically has to be acknowledged.",
        {
          fields: { tier: "needs acknowledgement" },
          remediation: {
            summary:
              "At this tier, major releases apply on a schedule with nobody watching. A release marked as breaking still asks first — but nothing else will.",
            actions: [],
          },
        },
      );
    }

    const after = await req.ctx.updates.savePolicy({
      ...(body.tier ? { tier: body.tier } : {}),
      ...(body.interval ? { interval: body.interval } : {}),
      ...(body.channel ? { channel: body.channel } : {}),
      ...(body.manifest_url ? { manifest_url: body.manifest_url } : {}),
    });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "update.policy_changed",
      targetType: "settings",
      targetId: null,
      targetLabel: after.tier,
      before: { tier: before.tier, interval: before.interval, channel: before.channel },
      after: { tier: after.tier, interval: after.interval, channel: after.channel },
    });

    return item(reply, await req.ctx.updates.overview());
  });

  /* ------------------------- control plane -------------------------- */

  app.post("/updates/control-plane", async (req, reply) => {
    const body = parseBody(req, applyControlPlaneUpdateInput);
    const h = helpers(req);
    const principal = h.authorize("admin.settings:write");

    const run = await req.ctx.updates.applyControlPlane({
      toVersion: body.to_version,
      confirmBreaking: body.confirm_breaking,
      skipBackupCheck: body.skip_backup_check,
      trigger: "manual",
      actor: { id: principal.id, name: principal.name },
    });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "update.control_plane_started",
      targetType: "update_run",
      targetId: run.id,
      targetLabel: run.to_version,
      metadata: {
        from: run.from_version,
        to: run.to_version,
        confirmed_breaking: body.confirm_breaking,
        skipped_backup_check: body.skip_backup_check,
      },
    });

    return reply.status(202).send({ data: run });
  });

  /* ---------------------------- agents ------------------------------ */

  app.post("/updates/agents", async (req, reply) => {
    const body = parseBody(req, applyAgentUpdateInput);
    const h = helpers(req);
    const principal = h.authorize("admin.settings:write");

    const release = await req.ctx.updates.releaseFor(body.to_version);

    const rows =
      body.server_ids.length > 0
        ? await req.ctx.db.select().from(servers).where(inArray(servers.id, body.server_ids))
        : await req.ctx.db.select().from(servers);

    if (rows.length === 0) {
      throw new ApiException("not_found", "No servers matched.", {
        remediation: { summary: "Register a server first.", actions: [] },
      });
    }

    const correlationId = crypto.randomUUID();
    const jobs: Job[] = [];

    for (const server of rows) {
      // Simulated hosts have no binary to swap, and pretending otherwise
      // would make the development fleet lie about a destructive action.
      if (server.simulated) continue;

      const artifact = req.ctx.updates.releaseArtifactFor(release, server.arch);
      const run = await req.ctx.updates.createRun({
        kind: "agent",
        serverId: server.id,
        fromVersion: server.agentVersion ?? "unknown",
        toVersion: release.version,
        trigger: "manual",
        breaking: false,
        actor: { id: principal.id, name: principal.name },
      });

      const job = await enqueueServerJob(req, {
        type: "agent.update",
        server,
        targetType: "server",
        targetId: server.id,
        targetLabel: server.name,
        correlationId,
        params: {
          version: release.version,
          url: artifact.url,
          sha256: artifact.sha256,
          run_id: run.id,
        },
      });

      await req.ctx.db.update(updateRuns).set({ jobId: job.id }).where(eq(updateRuns.id, run.id));
      jobs.push(job);
    }

    if (jobs.length === 0) {
      throw new ApiException("precondition_failed", "Every server selected is a simulated host.", {
        remediation: {
          summary:
            "Simulated agents exist so the panel can be developed without a fleet; they have no binary to replace.",
          actions: [],
        },
      });
    }

    return reply.status(202).send({ data: { correlation_id: correlationId, jobs } });
  });

  /* ------------------------------ runs ------------------------------ */

  app.get("/updates/runs", async (req, reply) => {
    const q = parseQuery(req, updateRunListQuery);
    helpers(req).authorize("admin.settings:read");

    const where = combine(
      q.kind ? eq(updateRuns.kind, q.kind) : null,
      q.status ? eq(updateRuns.status, q.status) : null,
      q.server_id ? eq(updateRuns.serverId, q.server_id) : null,
    );

    const rows = await req.ctx.db
      .select({ run: updateRuns, serverName: servers.name })
      .from(updateRuns)
      .leftJoin(servers, eq(updateRuns.serverId, servers.id))
      .where(where)
      .orderBy(desc(updateRuns.createdAt))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(updateRuns)
      .where(where);

    return list(
      reply,
      // The list is a summary; a full log per row would be megabytes.
      rows.map(({ run, serverName }) => ({ ...toApiRun(run, serverName), log: "" })),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  app.get("/updates/runs/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("admin.settings:read");

    const rows = await req.ctx.db
      .select({ run: updateRuns, serverName: servers.name })
      .from(updateRuns)
      .leftJoin(servers, eq(updateRuns.serverId, servers.id))
      .where(eq(updateRuns.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound("Update run", id);
    return item(reply, toApiRun(row.run, row.serverName));
  });

  /**
   * A host that went quiet mid-update stays visible until somebody says
   * they have looked at it. Acknowledging files the run as failed with
   * the acknowledgement in its log — it does not make it succeed.
   */
  app.post("/updates/runs/:id/acknowledge", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("admin.settings:write");

    const rows = await req.ctx.db
      .select()
      .from(updateRuns)
      .where(and(eq(updateRuns.id, id), eq(updateRuns.status, "needs_attention")))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiException("conflict", "That update run is not waiting on anyone.", {
        remediation: {
          summary: "Only a run that needs attention can be acknowledged.",
          actions: [{ label: "Updates", href: "/administration/updates" }],
        },
      });
    }

    await req.ctx.updates.append(id, `-- acknowledged by ${h.actor().name}`);
    await req.ctx.updates.finishRun(id, "failed", row.error);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "update.acknowledged",
      targetType: "update_run",
      targetId: id,
      targetLabel: row.toVersion,
      serverId: row.serverId,
    });

    const after = await req.ctx.db.select().from(updateRuns).where(eq(updateRuns.id, id)).limit(1);
    return item(reply, toApiRun(after[0]!, null));
  });
}
