import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "@kaname/db";
import { deployments, jobLogs, sites } from "@kaname/db/schema";
import {
  TERMINAL_JOB_STATUSES,
  deploymentListQuery,
  idParam,
  triggerDeploymentInput,
  type Deployment,
  type Permission,
} from "@kaname/contract";
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
import { ApiException, conflict, notFound } from "../lib/errors.js";
import type { EventTopic } from "../services/events.js";
import {
  combine,
  enqueueServerJob,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Deployments.
 *
 * A deployment row is the operator-visible record; the work itself is a
 * `deployment.run` job (KD-008), so the log endpoint below is a view of
 * that job's log rather than a second, divergent stream.
 * ------------------------------------------------------------------ */

const SORTABLE = {
  created_at: deployments.createdAt,
  finished_at: deployments.finishedAt,
  status: deployments.status,
  branch: deployments.branch,
  duration_ms: deployments.durationMs,
} as const;

/** Statuses that mean the release directory is being written right now. */
const IN_FLIGHT = ["queued", "building", "deploying"] as const;

const LOG_REPLAY_LIMIT = 5000;
const KEEPALIVE_MS = 20_000;

export const deploymentSelection = {
  deployment: deployments,
  site_name: sites.name,
  server_id: sites.serverId,
};

export type DeploymentRow = {
  deployment: typeof deployments.$inferSelect;
  site_name: string;
  server_id: string;
};

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/deployments", async (req, reply) => {
    const q = parseQuery(req, deploymentListQuery);
    helpers(req).authorize("websites.deployments:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "websites.deployments:read", sites.serverId),
      q.site_id ? eq(deployments.siteId, q.site_id) : null,
      q.server_id ? eq(sites.serverId, q.server_id) : null,
      q.status ? eq(deployments.status, q.status) : null,
      q.source ? eq(deployments.source, q.source) : null,
      q.branch ? eq(deployments.branch, q.branch) : null,
      term
        ? sql`(lower(${sites.name}) like ${term} or lower(coalesce(${deployments.commitMessage}, '')) like ${term}
               or lower(coalesce(${deployments.commitSha}, '')) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "created_at");
    const rows = await req.ctx.db
      .select(deploymentSelection)
      .from(deployments)
      .innerJoin(sites, eq(deployments.siteId, sites.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(deployments)
      .innerJoin(sites, eq(deployments.siteId, sites.id))
      .where(where);

    return list(
      reply,
      rows.map(deploymentToApi),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/deployments/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadDeploymentRow(req, id, "websites.deployments:read");
    return item(reply, deploymentToApi(row));
  });

  /* ------------------------------ log ------------------------------- */

  app.get("/deployments/:id/log", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadDeploymentRow(req, id, "websites.deployments:read");
    const jobId = row.deployment.jobId;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers SSE by default and makes the feed look broken.
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`retry: 3000\n\n`);

    const write = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!jobId) {
      // job_id is set null when the job is pruned, which is exactly what
      // `log_available: false` means on the resource.
      write("end", { deployment_id: id, status: row.deployment.status, reason: "log_expired" });
      reply.raw.end();
      return reply;
    }

    const existing = await req.ctx.db
      .select()
      .from(jobLogs)
      .where(eq(jobLogs.jobId, jobId))
      .orderBy(asc(jobLogs.seq))
      .limit(LOG_REPLAY_LIMIT);

    for (const line of existing) {
      write("log", {
        seq: line.seq,
        ts: line.ts.toISOString(),
        level: line.level,
        message: line.message,
      });
    }

    const job = await req.ctx.queue.get(jobId);
    if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) {
      write("end", {
        deployment_id: id,
        status: row.deployment.status,
        error: job?.error ?? null,
      });
      reply.raw.end();
      return reply;
    }

    let closed = false;
    const sub = req.ctx.events.subscribe({
      topics: new Set<EventTopic>(["jobs", "deployments"]),
      scope: new Set([row.server_id]),
      send: (event) => {
        const data = (event.data ?? {}) as Record<string, unknown>;
        if (event.topic === "deployments") {
          if (data.deployment_id === id) write("status", data);
          return;
        }
        if (data.job_id !== jobId) return;

        switch (event.type) {
          case "job.log":
            write("log", {
              ts: event.ts,
              level: data.level ?? "info",
              message: data.message ?? "",
            });
            break;
          case "job.progress":
            write("progress", { progress: data.progress ?? null });
            break;
          case "job.succeeded":
          case "job.failed":
          case "job.cancelled":
            write("end", { deployment_id: id, job_status: event.type, error: data.error ?? null });
            close();
            reply.raw.end();
            break;
          default:
            break;
        }
      },
    });

    const keepalive = setInterval(() => reply.raw.write(`: keepalive\n\n`), KEEPALIVE_MS);
    keepalive.unref?.();

    function close(): void {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      sub.unsubscribe();
    }
    req.raw.on("close", close);
    req.raw.on("error", close);

    // Never resolves: the reply belongs to the stream until the client leaves.
    return reply;
  });

  /* ---------------------------- trigger ----------------------------- */

  app.post("/deployments", async (req, reply) => {
    const body = parseBody(req, triggerDeploymentInput);
    const site = await loadSiteRow(req, body.site_id, "websites.deployments:exec");
    const server = await loadServer(req, site.serverId, "websites.deployments:exec");
    const h = helpers(req);
    const principal = h.requirePrincipal();

    const repoUrl = body.repo_url ?? site.repoUrl;
    const branch = body.branch ?? site.branch ?? "main";

    if (body.source === "git" && !repoUrl) {
      throw new ApiException(
        "precondition_failed",
        `${site.name} has no repository configured, so there is nothing to deploy.`,
        {
          remediation: {
            summary:
              "Set a repository URL and branch on the site, or pass repo_url with this request. An upload deployment needs no repository.",
            actions: [{ label: "Site settings", href: `/websites/sites/${site.id}` }],
          },
        },
      );
    }

    const running = await req.ctx.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.siteId, site.id), inArray(deployments.status, [...IN_FLIGHT])))
      .limit(1);
    if (running[0]) {
      throw conflict(`A deployment for ${site.name} is already in flight.`, {
        summary:
          "Two runs writing the same release directory would race and leave the site in a state neither of them intended. Wait for it, or cancel its job first.",
        actions: [
          { label: "Open running deployment", href: `/websites/deployments/${running[0].id}` },
          { label: "Deployments", href: `/websites/deployments?site_id=${site.id}` },
        ],
      });
    }

    if (!body.force && body.commit_sha) {
      const already = await req.ctx.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.siteId, site.id),
            eq(deployments.status, "succeeded"),
            eq(deployments.commitSha, body.commit_sha),
          ),
        )
        .limit(1);
      if (already[0]) {
        throw conflict(`${site.name} already runs ${body.commit_sha}.`, {
          summary: "Nothing would change. Send force to redeploy the same revision anyway.",
          actions: [
            { label: "Open that deployment", href: `/websites/deployments/${already[0].id}` },
            { label: "Deploy anyway", action: "deployments.force" },
          ],
        });
      }
    }

    const [row] = await req.ctx.db
      .insert(deployments)
      .values({
        siteId: site.id,
        source: body.source,
        repoUrl: repoUrl ?? null,
        branch,
        commitSha: body.commit_sha ?? null,
        status: "queued",
        triggeredBy: principal.kind === "user" ? principal.id : null,
        triggeredByName: principal.name,
      })
      .returning();

    const job = await enqueueServerJob(req, {
      type: "deployment.run",
      server,
      targetType: "deployment",
      targetId: row!.id,
      targetLabel: site.name,
      params: {
        deployment_id: row!.id,
        site_id: site.id,
        site_name: site.name,
        source: body.source,
        repo_url: repoUrl ?? null,
        branch,
        commit_sha: body.commit_sha ?? null,
        force: body.force,
        webroot: site.webroot,
        build_command: site.buildCommand,
        output_dir: site.outputDir,
        deploy_key_ref: site.deployKeyRef,
      },
    });

    await req.ctx.db
      .update(deployments)
      .set({ jobId: job.id, updatedAt: new Date() })
      .where(eq(deployments.id, row!.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "deployment.triggered",
      targetType: "deployment",
      targetId: row!.id,
      targetLabel: site.name,
      serverId: server.id,
      jobId: job.id,
      after: { site_id: site.id, source: body.source, branch, commit_sha: body.commit_sha ?? null },
    });
    req.ctx.events.publish(
      "deployments",
      "deployment.queued",
      { deployment_id: row!.id, site_id: site.id, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ---------------------------- rollback ---------------------------- */

  app.post("/deployments/:id/rollback", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const target = await loadDeploymentRow(req, id, "websites.deployments:exec");
    const site = await loadSiteRow(req, target.deployment.siteId, "websites.deployments:exec");
    const server = await loadServer(req, site.serverId, "websites.deployments:exec");
    const h = helpers(req);
    const principal = h.requirePrincipal();

    if (target.deployment.status !== "succeeded") {
      throw conflict(
        `Deployment ${short(target.deployment.commitSha) ?? id} never finished, so there is no release to go back to.`,
        {
          summary: `Its status is ${target.deployment.status}. Roll back to a run that succeeded, or deploy a known-good revision.`,
          actions: [
            { label: "Site deployments", href: `/websites/deployments?site_id=${site.id}` },
          ],
        },
      );
    }

    if (!target.deployment.releasePath) {
      throw new ApiException(
        "precondition_failed",
        `The release directory for that deployment is no longer recorded on ${server.name}.`,
        {
          remediation: {
            summary:
              "Kaname keeps a bounded number of releases on the host; this one has been pruned. Deploy the revision again from git to reproduce it.",
            actions: [
              { label: "Deploy this revision", action: "deployments.trigger" },
              { label: "Site settings", href: `/websites/sites/${site.id}` },
            ],
          },
        },
      );
    }

    const running = await req.ctx.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.siteId, site.id), inArray(deployments.status, [...IN_FLIGHT])))
      .limit(1);
    if (running[0]) {
      throw conflict(`A deployment for ${site.name} is already in flight.`, {
        summary:
          "Rolling back on top of a running deploy would leave the release symlink pointing at a half-written tree.",
        actions: [
          { label: "Open running deployment", href: `/websites/deployments/${running[0].id}` },
        ],
      });
    }

    const [row] = await req.ctx.db
      .insert(deployments)
      .values({
        siteId: site.id,
        source: target.deployment.source,
        repoUrl: target.deployment.repoUrl,
        branch: target.deployment.branch,
        commitSha: target.deployment.commitSha,
        commitMessage: target.deployment.commitMessage,
        commitAuthor: target.deployment.commitAuthor,
        releasePath: target.deployment.releasePath,
        status: "queued",
        triggeredBy: principal.kind === "user" ? principal.id : null,
        triggeredByName: principal.name,
      })
      .returning();

    const job = await enqueueServerJob(req, {
      type: "deployment.rollback",
      server,
      targetType: "deployment",
      targetId: row!.id,
      targetLabel: site.name,
      params: {
        deployment_id: row!.id,
        rollback_to_deployment_id: target.deployment.id,
        site_id: site.id,
        site_name: site.name,
        release_path: target.deployment.releasePath,
        webroot: site.webroot,
      },
    });

    await req.ctx.db
      .update(deployments)
      .set({ jobId: job.id, updatedAt: new Date() })
      .where(eq(deployments.id, row!.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "deployment.rolled_back",
      targetType: "deployment",
      targetId: row!.id,
      targetLabel: site.name,
      serverId: server.id,
      jobId: job.id,
      before: { deployment_id: target.deployment.id, commit_sha: target.deployment.commitSha },
      after: { deployment_id: row!.id, release_path: target.deployment.releasePath },
    });
    req.ctx.events.publish(
      "deployments",
      "deployment.rollback_queued",
      {
        deployment_id: row!.id,
        rollback_to: target.deployment.id,
        site_id: site.id,
        job_id: job.id,
      },
      server.id,
    );

    return accepted(reply, job);
  });
}

/* ------------------------------------------------------------------ */

/** Loads a deployment and asserts the caller holds `permission` on its host. */
export async function loadDeploymentRow(
  req: FastifyRequest,
  deploymentId: string,
  permission: Permission,
): Promise<DeploymentRow> {
  const rows = await req.ctx.db
    .select(deploymentSelection)
    .from(deployments)
    .innerJoin(sites, eq(deployments.siteId, sites.id))
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Deployment", deploymentId);
  helpers(req).authorize(permission, row.server_id);
  return row;
}

/** Loads a site and asserts the caller holds `permission` on its host. */
async function loadSiteRow(
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

export function deploymentToApi(row: DeploymentRow): Deployment {
  const d = row.deployment;
  return {
    id: d.id,
    site_id: d.siteId,
    site_name: row.site_name,
    source: d.source,
    repo_url: d.repoUrl,
    branch: d.branch,
    commit_sha: d.commitSha,
    commit_message: d.commitMessage,
    commit_author: d.commitAuthor,
    status: d.status,
    started_at: d.startedAt?.toISOString() ?? null,
    finished_at: d.finishedAt?.toISOString() ?? null,
    duration_ms: d.durationMs,
    triggered_by: d.triggeredBy,
    triggered_by_name: d.triggeredByName,
    job_id: d.jobId,
    // job_id is nulled when the job row is pruned, which is precisely
    // when the log stops being available.
    log_available: d.jobId !== null,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

function short(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}
