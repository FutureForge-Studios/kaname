import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, sql } from "@kaname/db";
import { jobLogs, jobs, servers } from "@kaname/db/schema";
import { idParam, jobListQueryExtra, jobLogQuery, listQuery } from "@kaname/contract";
import { helpers, item, list, offset, paginate, parseParams, parseQuery } from "../http/plugin.js";
import { notFound } from "../lib/errors.js";
import { combine, scopeFilter } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Jobs.
 *
 * The UI's job drawer reads from here and follows /jobs/:id/logs over
 * SSE, which is why a mutation can render a real status pill instead of
 * a spinner that lies (KD-008).
 * ------------------------------------------------------------------ */

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get("/jobs", async (req, reply) => {
    const q = parseQuery(req, listQuery.merge(jobListQueryExtra));
    helpers(req).authorize("infra.servers:read");

    const where = combine(
      scopeFilter(req, "infra.servers:read", jobs.serverId),
      q.status ? eq(jobs.status, q.status) : null,
      q.type ? eq(jobs.type, q.type) : null,
      q.server_id ? eq(jobs.serverId, q.server_id) : null,
      q.correlation_id ? eq(jobs.correlationId, q.correlation_id) : null,
      q.q ? sql`lower(${jobs.type}) like ${`%${q.q.toLowerCase()}%`}` : null,
    );

    const rows = await req.ctx.db
      .select({ job: jobs, serverName: servers.name })
      .from(jobs)
      .leftJoin(servers, eq(jobs.serverId, servers.id))
      .where(where)
      .orderBy(desc(jobs.createdAt))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(jobs)
      .where(where);
    const total = counted[0]?.total ?? 0;

    return list(
      reply,
      rows.map((r) => req.ctx.queue.toApi(r.job, r.serverName)),
      paginate(total, q.page, q.per_page),
    );
  });

  app.get("/jobs/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("infra.servers:read");

    const job = await req.ctx.queue.get(id);
    if (!job) throw notFound("Job", id);
    if (job.server_id) helpers(req).authorize("infra.servers:read", job.server_id);

    const children = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(eq(jobs.parentId, id));

    return item(reply, { ...job, child_count: children[0]?.n ?? 0 });
  });

  app.get("/jobs/:id/logs", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, jobLogQuery);
    helpers(req).authorize("infra.servers:read");

    const job = await req.ctx.queue.get(id);
    if (!job) throw notFound("Job", id);
    if (job.server_id) helpers(req).authorize("infra.servers:read", job.server_id);

    const rows = await req.ctx.db
      .select()
      .from(jobLogs)
      .where(
        q.since_seq === undefined
          ? eq(jobLogs.jobId, id)
          : and(eq(jobLogs.jobId, id), gt(jobLogs.seq, q.since_seq)),
      )
      .orderBy(asc(jobLogs.seq))
      .limit(q.per_page);

    return item(
      reply,
      rows.map((r) => ({
        seq: r.seq,
        ts: r.ts.toISOString(),
        level: r.level,
        message: r.message,
      })),
    );
  });

  app.post("/jobs/:id/cancel", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);

    const job = await req.ctx.queue.get(id);
    if (!job) throw notFound("Job", id);
    h.authorize("infra.servers:write", job.server_id);

    const cancelled = await req.ctx.queue.cancel(id);
    if (cancelled) {
      await req.ctx.audit.record({
        actor: h.actor(),
        action: "job.cancelled",
        targetType: "job",
        targetId: id,
        targetLabel: job.label,
        serverId: job.server_id,
        jobId: id,
      });
      req.ctx.events.publish("jobs", "job.cancelled", { job_id: id }, job.server_id);
    }

    return item(reply, await req.ctx.queue.get(id));
  });
}
