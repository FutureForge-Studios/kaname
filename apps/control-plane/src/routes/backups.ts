import { connect } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, sql } from "@kaname/db";
import {
  backupDestinations,
  backupRuns,
  backupSchedules,
  dbDatabases,
  restorePoints,
  secrets,
  servers,
} from "@kaname/db/schema";
import {
  backupDestinationListQuery,
  backupRunListQuery,
  backupScheduleListQuery,
  createBackupDestinationInput,
  createBackupScheduleInput,
  idParam,
  restoreInput,
  restoreInputFor,
  restorePointListQuery,
  testBackupDestinationInput,
  updateBackupDestinationInput,
  updateBackupScheduleInput,
  type BackupDestination,
  type BackupDestinationSummary,
  type BackupDestinationTarget,
  type BackupDestinationTestResult,
  type BackupRetention,
  type BackupRun,
  type BackupSchedule,
  type BackupScope,
  type RestorePoint,
} from "@kaname/contract";
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
import { ApiException, badRequest, conflict, notFound } from "../lib/errors.js";
import { generateToken, open, seal } from "../lib/crypto.js";
import {
  combine,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  type ServerRow,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Backups.
 *
 * Three rules shape this module. Destination credentials go in once and
 * are never readable again — the API returns where a destination points,
 * never how it authenticates. A schedule's next run is computed here
 * rather than trusted from the client, so the panel and the worker can
 * never disagree about when a backup is due. And a restore is the one
 * operation that overwrites live data, so it is gated on the operator
 * retyping the restore point's label.
 * ------------------------------------------------------------------ */

const SORTABLE_DESTINATIONS = {
  name: backupDestinations.name,
  kind: backupDestinations.kind,
  status: backupDestinations.status,
  used_bytes: backupDestinations.usedBytes,
  last_checked_at: backupDestinations.lastCheckedAt,
  created_at: backupDestinations.createdAt,
} as const;

const SORTABLE_SCHEDULES = {
  name: backupSchedules.name,
  cron: backupSchedules.cron,
  enabled: backupSchedules.enabled,
  last_run_at: backupSchedules.lastRunAt,
  next_run_at: backupSchedules.nextRunAt,
  server: servers.name,
  created_at: backupSchedules.createdAt,
} as const;

const SORTABLE_RUNS = {
  started_at: backupRuns.startedAt,
  finished_at: backupRuns.finishedAt,
  status: backupRuns.status,
  bytes: backupRuns.bytes,
  duration_ms: backupRuns.durationMs,
  created_at: backupRuns.createdAt,
} as const;

const SORTABLE_POINTS = {
  taken_at: restorePoints.takenAt,
  label: restorePoints.label,
  bytes: restorePoints.bytes,
  verified_at: restorePoints.verifiedAt,
  server: servers.name,
} as const;

/**
 * What a scope covers on the host when the operator names no selectors.
 * `databases` and `files` have no default: an empty selector list there
 * means "everything the schedule's other scopes already name", and
 * silently backing up every database would be a surprise, not a default.
 */
const SCOPE_DEFAULT_PATHS: Record<BackupScope["kind"], string[]> = {
  files: [],
  databases: [],
  mail: ["/var/vmail"],
  config: ["/etc"],
  panel: ["/var/lib/kaname"],
};

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------- destinations -------------------------- */

  app.get("/backups/destinations", async (req, reply) => {
    const q = parseQuery(req, backupDestinationListQuery);
    helpers(req).authorize("backups.schedules:read");

    const term = searchTerm(q.q);
    const where = combine(
      q.kind ? eq(backupDestinations.kind, q.kind) : null,
      q.status ? eq(backupDestinations.status, q.status) : null,
      term ? sql`lower(${backupDestinations.name}) like ${term}` : null,
    );

    const column = sortColumn(SORTABLE_DESTINATIONS, q.sort, "name");
    const rows = await req.ctx.db
      .select()
      .from(backupDestinations)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(backupDestinations)
      .where(where);

    return list(reply, rows.map(toDestination), paginate(total?.n ?? 0, q.page, q.per_page));
  });

  app.get("/backups/destinations/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("backups.schedules:read");
    return item(reply, toDestination(await destinationRow(req, id)));
  });

  app.post("/backups/destinations", async (req, reply) => {
    const body = parseBody(req, createBackupDestinationInput);
    const h = helpers(req);
    h.authorize("backups.schedules:write");

    // A local destination is a directory on a managed host, so it is
    // subject to that host's own permission scope like anything else.
    if (body.target.kind === "local") {
      await loadServer(req, body.target.server_id, "backups.schedules:write");
    }

    const clash = await req.ctx.db
      .select({ id: backupDestinations.id })
      .from(backupDestinations)
      .where(eq(backupDestinations.name, body.name))
      .limit(1);
    if (clash[0]) {
      throw conflict(`A backup destination named "${body.name}" already exists.`, {
        summary: "Destination names are unique, because schedules refer to them by name in the UI.",
        actions: [{ label: "Open it", href: `/backups/destinations/${clash[0].id}` }],
      });
    }

    const [row] = await req.ctx.db
      .insert(backupDestinations)
      .values({
        name: body.name,
        kind: body.target.kind,
        config: publicConfig(body.target),
        status: "untested",
      })
      .returning();

    await storeSecret(
      req,
      secretRef(row!.id),
      "backup_destination",
      row!.id,
      JSON.stringify(body.target),
    );
    await req.ctx.db
      .update(backupDestinations)
      .set({ secretRef: secretRef(row!.id) })
      .where(eq(backupDestinations.id, row!.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "backup_destination.created",
      targetType: "backup_destination",
      targetId: row!.id,
      targetLabel: body.name,
      after: { name: body.name, kind: body.target.kind, config: publicConfig(body.target) },
    });
    req.ctx.events.publish("backups", "destination.created", { destination_id: row!.id });

    return item(reply, toDestination({ ...row!, secretRef: secretRef(row!.id) }), 201);
  });

  app.patch("/backups/destinations/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateBackupDestinationInput);
    const h = helpers(req);
    h.authorize("backups.schedules:write");

    const before = await destinationRow(req, id);
    if (body.target && body.target.kind !== before.kind) {
      throw badRequest(
        `This destination is ${before.kind}; a ${body.target.kind} target would point the same schedules somewhere else entirely.`,
        { target: `kind must stay "${before.kind}" — create a new destination instead` },
      );
    }
    if (body.target?.kind === "local") {
      await loadServer(req, body.target.server_id, "backups.schedules:write");
    }

    const [row] = await req.ctx.db
      .update(backupDestinations)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.target ? { config: publicConfig(body.target), status: "untested" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(backupDestinations.id, id))
      .returning();

    // Re-sending the target is the only way to rotate a credential; the
    // old ciphertext is replaced, never kept alongside.
    if (body.target) {
      await storeSecret(req, secretRef(id), "backup_destination", id, JSON.stringify(body.target));
    }

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "backup_destination.updated",
      targetType: "backup_destination",
      targetId: id,
      targetLabel: row!.name,
      serverId: null,
      before: { name: before.name, config: before.config },
      after: { name: row!.name, config: row!.config, credentials_rotated: Boolean(body.target) },
    });
    req.ctx.events.publish("backups", "destination.updated", { destination_id: id });

    return item(reply, toDestination(row!));
  });

  app.delete("/backups/destinations/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("backups.schedules:delete");

    const destination = await destinationRow(req, id);
    const users = await req.ctx.db
      .select({ id: backupSchedules.id, name: backupSchedules.name })
      .from(backupSchedules)
      .where(eq(backupSchedules.destinationId, id))
      .limit(5);
    if (users.length > 0) {
      throw conflict(
        `"${destination.name}" still holds the backups for ${users.length === 1 ? "a schedule" : `${users.length} schedules`}.`,
        {
          summary: `Point ${users.map((s) => s.name).join(", ")} at another destination first. Deleting this row would leave those snapshots unreachable from the panel.`,
          actions: [{ label: "Open schedules", href: `/backups/schedules?destination_id=${id}` }],
        },
      );
    }

    await req.ctx.db.delete(backupDestinations).where(eq(backupDestinations.id, id));
    await req.ctx.db.delete(secrets).where(eq(secrets.ref, secretRef(id)));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "backup_destination.deleted",
      targetType: "backup_destination",
      targetId: id,
      targetLabel: destination.name,
      before: { name: destination.name, kind: destination.kind, config: destination.config },
    });
    req.ctx.events.publish("backups", "destination.deleted", { destination_id: id });

    return noContent(reply);
  });

  /**
   * Reachability, not authority. For a local destination the agent stats
   * the directory; for the remote kinds the control plane opens the
   * transport and stops there. Whether the credentials can actually write
   * is proven by the first run, and the result says so rather than
   * implying a green tick means more than it does.
   */
  app.post("/backups/destinations/test", async (req, reply) => {
    const body = parseBody(req, testBackupDestinationInput);
    const h = helpers(req);
    h.authorize("backups.schedules:write");

    const saved = body.destination_id ? await destinationRow(req, body.destination_id) : null;
    const target = body.target ?? (saved ? await readTarget(req, saved) : null);
    if (!target) {
      throw new ApiException(
        "precondition_failed",
        `"${saved?.name}" has no stored credentials to test with.`,
        {
          remediation: {
            summary: "Send the destination's target again to store its credentials, then test it.",
            actions: [{ label: "Edit destination", href: `/backups/destinations/${saved?.id}` }],
          },
        },
      );
    }

    const result = await probeDestination(req, target);

    if (saved) {
      await req.ctx.db
        .update(backupDestinations)
        .set({
          status: result.ok ? "ok" : "unreachable",
          lastCheckedAt: new Date(result.checked_at),
          lastError: result.error,
          updatedAt: new Date(),
        })
        .where(eq(backupDestinations.id, saved.id));

      await req.ctx.audit.record({
        actor: h.actor(),
        action: "backup_destination.tested",
        targetType: "backup_destination",
        targetId: saved.id,
        targetLabel: saved.name,
        metadata: { ok: result.ok, latency_ms: result.latency_ms, error: result.error },
      });
      req.ctx.events.publish("backups", "destination.tested", {
        destination_id: saved.id,
        ok: result.ok,
      });
    }

    return item(reply, result);
  });

  /* ---------------------------- schedules --------------------------- */

  app.get("/backups/schedules", async (req, reply) => {
    const q = parseQuery(req, backupScheduleListQuery);
    helpers(req).authorize("backups.schedules:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "backups.schedules:read", backupSchedules.serverId),
      q.server_id ? eq(backupSchedules.serverId, q.server_id) : null,
      q.destination_id ? eq(backupSchedules.destinationId, q.destination_id) : null,
      q.enabled !== undefined ? eq(backupSchedules.enabled, q.enabled) : null,
      q.last_run_status ? eq(backupSchedules.lastRunStatus, q.last_run_status) : null,
      q.scope_kind
        ? sql`${backupSchedules.scope} @> ${JSON.stringify([{ kind: q.scope_kind }])}::jsonb`
        : null,
      term ? sql`lower(${backupSchedules.name}) like ${term}` : null,
    );

    const column = sortColumn(SORTABLE_SCHEDULES, q.sort, "name");
    const rows = await req.ctx.db
      .select({
        schedule: backupSchedules,
        serverName: servers.name,
        destinationName: backupDestinations.name,
      })
      .from(backupSchedules)
      .innerJoin(servers, eq(backupSchedules.serverId, servers.id))
      .innerJoin(backupDestinations, eq(backupSchedules.destinationId, backupDestinations.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(backupSchedules)
      .innerJoin(servers, eq(backupSchedules.serverId, servers.id))
      .where(where);

    const lastRuns = await lastRunIds(
      req,
      rows.map((r) => r.schedule.id),
    );
    return list(
      reply,
      rows.map((r) =>
        toSchedule(
          r.schedule,
          r.serverName,
          r.destinationName,
          lastRuns.get(r.schedule.id) ?? null,
        ),
      ),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/backups/schedules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { schedule, server, destination } = await loadSchedule(req, id, "backups.schedules:read");
    const lastRuns = await lastRunIds(req, [id]);
    return item(
      reply,
      toSchedule(schedule, server.name, destination.name, lastRuns.get(id) ?? null),
    );
  });

  app.post("/backups/schedules", async (req, reply) => {
    const body = parseBody(req, createBackupScheduleInput);
    const server = await loadServer(req, body.server_id, "backups.schedules:write");
    const h = helpers(req);

    const destination = await destinationRow(req, body.destination_id);
    assertDestinationReachableFrom(destination, server);

    const clash = await req.ctx.db
      .select({ id: backupSchedules.id })
      .from(backupSchedules)
      .where(eq(backupSchedules.name, body.name))
      .limit(1);
    if (clash[0]) {
      throw conflict(`A backup schedule named "${body.name}" already exists.`, {
        summary: "Schedule names are unique so a restore point can name where it came from.",
        actions: [{ label: "Open it", href: `/backups/schedules/${clash[0].id}` }],
      });
    }

    const nextRunAt = computeNextRun(body.cron, body.timezone, body.enabled);
    const [row] = await req.ctx.db
      .insert(backupSchedules)
      .values({
        name: body.name,
        serverId: server.id,
        scope: body.scope,
        cron: body.cron,
        timezone: body.timezone,
        destinationId: destination.id,
        retention: body.retention,
        encryption: body.encryption,
        repositoryPath: repositoryFor(destination, body.name),
        enabled: body.enabled,
        nextRunAt,
      })
      .returning();

    // The repository password is generated here and never shown: a
    // restore goes through Kaname, which is the only thing that holds it.
    if (body.encryption) {
      await storeSecret(
        req,
        secretRef(row!.id, "schedule"),
        "backup_schedule",
        row!.id,
        generateToken(),
      );
      await req.ctx.db
        .update(backupSchedules)
        .set({ passwordRef: secretRef(row!.id, "schedule") })
        .where(eq(backupSchedules.id, row!.id));
    }

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "backup_schedule.created",
      targetType: "backup_schedule",
      targetId: row!.id,
      targetLabel: body.name,
      serverId: server.id,
      after: {
        name: body.name,
        cron: body.cron,
        timezone: body.timezone,
        destination: destination.name,
        next_run_at: nextRunAt?.toISOString() ?? null,
      },
    });
    req.ctx.events.publish("backups", "schedule.created", { schedule_id: row!.id }, server.id);

    return item(
      reply,
      toSchedule(
        { ...row!, passwordRef: body.encryption ? secretRef(row!.id, "schedule") : null },
        server.name,
        destination.name,
        null,
      ),
      201,
    );
  });

  app.patch("/backups/schedules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateBackupScheduleInput);
    const { schedule, server } = await loadSchedule(req, id, "backups.schedules:write");
    const h = helpers(req);

    const destination = body.destination_id
      ? await destinationRow(req, body.destination_id)
      : await destinationRow(req, schedule.destinationId);
    if (body.destination_id) assertDestinationReachableFrom(destination, server);

    const cron = body.cron ?? schedule.cron;
    const timezone = body.timezone ?? schedule.timezone;
    const enabled = body.enabled ?? schedule.enabled;
    const name = body.name ?? schedule.name;

    const [row] = await req.ctx.db
      .update(backupSchedules)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.retention !== undefined ? { retention: body.retention } : {}),
        ...(body.encryption !== undefined ? { encryption: body.encryption } : {}),
        ...(body.destination_id !== undefined ? { destinationId: destination.id } : {}),
        cron,
        timezone,
        enabled,
        // Recomputed on every write: a stale next_run_at is how a backup
        // silently stops happening.
        nextRunAt: computeNextRun(cron, timezone, enabled),
        ...(body.name !== undefined || body.destination_id !== undefined
          ? { repositoryPath: repositoryFor(destination, name) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(backupSchedules.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "backup_schedule.updated",
      targetType: "backup_schedule",
      targetId: id,
      targetLabel: row!.name,
      serverId: server.id,
      before: { cron: schedule.cron, timezone: schedule.timezone, enabled: schedule.enabled },
      after: { cron, timezone, enabled, next_run_at: row!.nextRunAt?.toISOString() ?? null },
    });
    req.ctx.events.publish("backups", "schedule.updated", { schedule_id: id }, server.id);

    const lastRuns = await lastRunIds(req, [id]);
    return item(reply, toSchedule(row!, server.name, destination.name, lastRuns.get(id) ?? null));
  });

  app.delete("/backups/schedules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { schedule, server } = await loadSchedule(req, id, "backups.schedules:delete");
    const h = helpers(req);

    await req.ctx.db.delete(backupSchedules).where(eq(backupSchedules.id, id));
    await req.ctx.db.delete(secrets).where(eq(secrets.ref, secretRef(id, "schedule")));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "backup_schedule.deleted",
      targetType: "backup_schedule",
      targetId: id,
      targetLabel: schedule.name,
      serverId: server.id,
      before: { name: schedule.name, cron: schedule.cron, repository: schedule.repositoryPath },
      metadata: {
        // Worth saying out loud: the snapshots outlive the schedule row.
        note: "Snapshots already in the destination are untouched by this deletion.",
      },
    });
    req.ctx.events.publish("backups", "schedule.deleted", { schedule_id: id }, server.id);

    return noContent(reply);
  });

  app.post("/backups/schedules/:id/run", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { schedule, server, destination } = await loadSchedule(
      req,
      id,
      "backups.schedules:write",
    );
    const h = helpers(req);
    const principal = h.requirePrincipal();

    const plan = await planScope(req, schedule);

    const [run] = await req.ctx.db
      .insert(backupRuns)
      .values({
        scheduleId: schedule.id,
        serverId: server.id,
        trigger: "manual",
        status: "queued",
        triggeredBy: principal.kind === "user" ? principal.id : null,
      })
      .returning();

    const job = await enqueueServerJob(req, {
      type: "backup.run",
      server,
      targetType: "backup_run",
      targetId: run!.id,
      targetLabel: schedule.name,
      params: {
        run_id: run!.id,
        repository: schedule.repositoryPath,
        password_ref: schedule.passwordRef ?? "",
        paths: plan.paths,
        exclude: [],
        tags: [`schedule:${schedule.id}`, "trigger:manual"],
        databases: plan.databases,
      },
    });

    await req.ctx.db.update(backupRuns).set({ jobId: job.id }).where(eq(backupRuns.id, run!.id));
    await req.ctx.db
      .update(backupSchedules)
      .set({ lastRunAt: new Date(), lastRunStatus: "queued", updatedAt: new Date() })
      .where(eq(backupSchedules.id, schedule.id));

    req.ctx.events.publish(
      "backups",
      "run.queued",
      { run_id: run!.id, schedule_id: schedule.id, destination: destination.name },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ------------------------------- runs ----------------------------- */

  app.get("/backups/runs", async (req, reply) => {
    const q = parseQuery(req, backupRunListQuery);
    helpers(req).authorize("backups.schedules:read");

    const where = combine(
      scopeFilter(req, "backups.schedules:read", backupRuns.serverId),
      q.schedule_id ? eq(backupRuns.scheduleId, q.schedule_id) : null,
      q.server_id ? eq(backupRuns.serverId, q.server_id) : null,
      q.status ? eq(backupRuns.status, q.status) : null,
      q.trigger ? eq(backupRuns.trigger, q.trigger) : null,
      q.destination_id
        ? sql`exists (select 1 from backup_schedules s where s.id = ${backupRuns.scheduleId} and s.destination_id = ${q.destination_id})`
        : null,
    );

    const column = sortColumn(SORTABLE_RUNS, q.sort, "created_at");
    const rows = await req.ctx.db
      .select({ run: backupRuns, serverName: servers.name, scheduleName: backupSchedules.name })
      .from(backupRuns)
      .innerJoin(servers, eq(backupRuns.serverId, servers.id))
      .leftJoin(backupSchedules, eq(backupRuns.scheduleId, backupSchedules.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(backupRuns)
      .innerJoin(servers, eq(backupRuns.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toRun(r.run, r.serverName, r.scheduleName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/backups/runs/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("backups.schedules:read");

    const rows = await req.ctx.db
      .select({ run: backupRuns, serverName: servers.name, scheduleName: backupSchedules.name })
      .from(backupRuns)
      .innerJoin(servers, eq(backupRuns.serverId, servers.id))
      .leftJoin(backupSchedules, eq(backupRuns.scheduleId, backupSchedules.id))
      .where(eq(backupRuns.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Backup run", id);
    await loadServer(req, row.run.serverId, "backups.schedules:read");

    return item(reply, toRun(row.run, row.serverName, row.scheduleName));
  });

  /* -------------------------- restore points ------------------------ */

  app.get("/backups/restore-points", async (req, reply) => {
    const q = parseQuery(req, restorePointListQuery);
    helpers(req).authorize("backups.schedules:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "backups.schedules:read", restorePoints.serverId),
      q.server_id ? eq(restorePoints.serverId, q.server_id) : null,
      q.schedule_id ? eq(restorePoints.scheduleId, q.schedule_id) : null,
      q.verified === true ? sql`${restorePoints.verifiedAt} is not null` : null,
      q.verified === false ? isNull(restorePoints.verifiedAt) : null,
      q.scope_kind
        ? sql`${restorePoints.scope} @> ${JSON.stringify([{ kind: q.scope_kind }])}::jsonb`
        : null,
      term
        ? sql`(lower(${restorePoints.label}) like ${term} or lower(${restorePoints.snapshotId}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_POINTS, q.sort, "taken_at");
    const rows = await req.ctx.db
      .select({ point: restorePoints, serverName: servers.name })
      .from(restorePoints)
      .innerJoin(servers, eq(restorePoints.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(restorePoints)
      .innerJoin(servers, eq(restorePoints.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map((r) => toRestorePoint(r.point, r.serverName)),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/backups/restore-points/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { point, server } = await loadRestorePoint(req, id, "backups.schedules:read");
    return item(reply, toRestorePoint(point, server.name));
  });

  app.post("/backups/restore-points/:id/verify", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { point, server, schedule } = await loadRestorePoint(req, id, "backups.schedules:read");

    const job = await enqueueServerJob(req, {
      type: "backup.verify",
      server,
      targetType: "restore_point",
      targetId: point.id,
      targetLabel: point.label,
      params: {
        repository: schedule.repositoryPath,
        password_ref: schedule.passwordRef ?? "",
        snapshot_id: point.snapshotId,
      },
    });
    return accepted(reply, job);
  });

  /* ----------------------------- restore ---------------------------- */

  /**
   * The one operation that writes over live data. `confirm_label` must be
   * the restore point's own label, checked against the row rather than
   * against whatever the client believed it was restoring.
   */
  app.post("/backups/restore", async (req, reply) => {
    const preflight = parseBody(req, restoreInput.pick({ restore_point_id: true }));
    const { point, schedule } = await loadRestorePoint(
      req,
      preflight.restore_point_id,
      "backups.restore:exec",
    );

    const body = parseBody(req, restoreInputFor(point.label));
    const target = await loadServer(req, body.target_server_id, "backups.restore:exec");

    const job = await enqueueServerJob(req, {
      type: "backup.restore",
      server: target,
      targetType: "restore_point",
      targetId: point.id,
      targetLabel: `${point.label} → ${target.name}:${body.target_path}`,
      params: {
        repository: schedule.repositoryPath,
        password_ref: schedule.passwordRef ?? "",
        snapshot_id: point.snapshotId,
        target: body.target_path,
        include: body.include,
        overwrite: body.overwrite,
      },
    });

    req.ctx.events.publish(
      "backups",
      "restore.started",
      { restore_point_id: point.id, server_id: target.id, job_id: job.id },
      target.id,
    );

    return reply.status(202).send({
      data: {
        job,
        restore: {
          restore_point: point.label,
          taken_at: point.takenAt.toISOString(),
          target: `${target.name}:${body.target_path}`,
          overwrite: body.overwrite,
          summary: body.overwrite
            ? `Files already at ${body.target_path} on ${target.name} are being overwritten from a snapshot taken ${point.takenAt.toISOString()}. There is no undo.`
            : `Restoring into ${body.target_path} on ${target.name}. Existing files are kept; only what is missing is written.`,
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ *
 * Loaders
 * ------------------------------------------------------------------ */

type DestinationRow = typeof backupDestinations.$inferSelect;
type ScheduleRow = typeof backupSchedules.$inferSelect;
type RestorePointRow = typeof restorePoints.$inferSelect;

async function destinationRow(req: FastifyRequest, id: string): Promise<DestinationRow> {
  const rows = await req.ctx.db
    .select()
    .from(backupDestinations)
    .where(eq(backupDestinations.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Backup destination", id);
  return row;
}

async function loadSchedule(
  req: FastifyRequest,
  id: string,
  permission: "backups.schedules:read" | "backups.schedules:write" | "backups.schedules:delete",
): Promise<{ schedule: ScheduleRow; server: ServerRow; destination: DestinationRow }> {
  helpers(req).authorize(permission);
  const rows = await req.ctx.db
    .select()
    .from(backupSchedules)
    .where(eq(backupSchedules.id, id))
    .limit(1);
  const schedule = rows[0];
  if (!schedule) throw notFound("Backup schedule", id);

  const server = await loadServer(req, schedule.serverId, permission);
  const destination = await destinationRow(req, schedule.destinationId);
  return { schedule, server, destination };
}

async function loadRestorePoint(
  req: FastifyRequest,
  id: string,
  permission: "backups.schedules:read" | "backups.restore:exec",
): Promise<{ point: RestorePointRow; server: ServerRow; schedule: ScheduleRow }> {
  helpers(req).authorize(permission);
  const rows = await req.ctx.db
    .select()
    .from(restorePoints)
    .where(eq(restorePoints.id, id))
    .limit(1);
  const point = rows[0];
  if (!point) throw notFound("Restore point", id);

  const server = await loadServer(req, point.serverId, permission);

  // Repository and password live on the schedule, so a point whose
  // schedule was deleted cannot be read back — say that plainly.
  const scheduleRows = point.scheduleId
    ? await req.ctx.db
        .select()
        .from(backupSchedules)
        .where(eq(backupSchedules.id, point.scheduleId))
        .limit(1)
    : [];
  const schedule = scheduleRows[0];
  if (!schedule) {
    throw new ApiException(
      "precondition_failed",
      `Restore point "${point.label}" has no schedule left to tell Kaname which repository it lives in.`,
      {
        remediation: {
          summary:
            "Recreate a schedule pointing at the same destination and repository, then this snapshot becomes reachable again. The data itself is untouched.",
          actions: [{ label: "New schedule", href: "/backups/schedules/new" }],
        },
      },
    );
  }
  return { point, server, schedule };
}

async function lastRunIds(
  req: FastifyRequest,
  scheduleIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (scheduleIds.length === 0) return out;

  const rows = await req.ctx.db
    .select({ id: backupRuns.id, scheduleId: backupRuns.scheduleId })
    .from(backupRuns)
    .where(inArray(backupRuns.scheduleId, scheduleIds))
    .orderBy(desc(backupRuns.createdAt));
  for (const row of rows) {
    if (row.scheduleId && !out.has(row.scheduleId)) out.set(row.scheduleId, row.id);
  }
  return out;
}

/** A local destination is a path on one host; another host cannot reach it. */
function assertDestinationReachableFrom(destination: DestinationRow, server: ServerRow): void {
  if (destination.kind !== "local") return;
  if (destination.config.server_id === server.id) return;
  throw conflict(
    `"${destination.name}" is a local directory on another host, so ${server.name} cannot write to it.`,
    {
      summary:
        "Local destinations only work for schedules on the same server. Use an S3, B2 or SFTP destination to back this host up somewhere else.",
      actions: [{ label: "Backup destinations", href: "/backups/destinations" }],
    },
  );
}

/* ------------------------------------------------------------------ *
 * Scope planning
 * ------------------------------------------------------------------ */

async function planScope(
  req: FastifyRequest,
  schedule: ScheduleRow,
): Promise<{ paths: string[]; databases: { engine: string; name: string }[] }> {
  const paths: string[] = [];
  const databases: { engine: string; name: string }[] = [];

  for (const scope of schedule.scope as BackupScope[]) {
    if (scope.kind === "databases") {
      for (const selector of scope.selectors) {
        const [engine, name] = selector.includes(":")
          ? [selector.slice(0, selector.indexOf(":")), selector.slice(selector.indexOf(":") + 1)]
          : [null, selector];
        databases.push({ engine: engine ?? (await engineFor(req, schedule.serverId, name)), name });
      }
      continue;
    }
    const selected = scope.selectors.length > 0 ? scope.selectors : SCOPE_DEFAULT_PATHS[scope.kind];
    for (const path of selected) {
      if (!path.startsWith("/")) {
        throw badRequest(`Scope "${scope.kind}" names "${path}", which is not an absolute path.`, {
          scope: `selectors for ${scope.kind} must be absolute paths`,
        });
      }
      paths.push(path);
    }
  }

  if (paths.length === 0 && databases.length === 0) {
    throw new ApiException(
      "precondition_failed",
      `Schedule "${schedule.name}" resolves to nothing to back up.`,
      {
        remediation: {
          summary:
            "Name at least one path in a files scope, or at least one database, otherwise the run would produce an empty snapshot.",
          actions: [{ label: "Edit schedule", href: `/backups/schedules/${schedule.id}` }],
        },
      },
    );
  }
  return { paths, databases };
}

/** A bare database name is only unambiguous once we know its engine. */
async function engineFor(req: FastifyRequest, serverId: string, name: string): Promise<string> {
  const rows = await req.ctx.db
    .select({ engine: dbDatabases.engine })
    .from(dbDatabases)
    .where(and(eq(dbDatabases.serverId, serverId), eq(dbDatabases.name, name)))
    .limit(1);
  const engine = rows[0]?.engine;
  if (!engine) {
    throw badRequest(
      `No database named "${name}" is known on this server, so Kaname cannot tell which engine to dump it from.`,
      {
        scope: `write it as "postgres:${name}" or "mysql:${name}", or sync the server's databases first`,
      },
    );
  }
  return engine;
}

/* ------------------------------------------------------------------ *
 * Destinations: config, secrets and reachability
 * ------------------------------------------------------------------ */

function secretRef(id: string, kind: "destination" | "schedule" = "destination"): string {
  return kind === "schedule" ? `backup_schedule:${id}` : `backup_destination:${id}`;
}

/** Everything about a target except how it authenticates. */
function publicConfig(target: BackupDestinationTarget): Record<string, string> {
  switch (target.kind) {
    case "s3":
      return {
        ...(target.endpoint ? { endpoint: target.endpoint } : {}),
        region: target.region,
        bucket: target.bucket,
        prefix: target.prefix,
        access_key_hint: hint(target.access_key_id),
      };
    case "b2":
      return {
        bucket: target.bucket,
        prefix: target.prefix,
        access_key_hint: hint(target.access_key_id),
      };
    case "sftp":
      return {
        host: target.host,
        port: String(target.port),
        username: target.username,
        path: target.path,
        auth: target.auth.method,
      };
    case "local":
      return { server_id: target.server_id, path: target.path };
  }
}

/** Enough of a key id to tell two credentials apart, not enough to use one. */
function hint(accessKeyId: string): string {
  return accessKeyId.length <= 4 ? "****" : `****${accessKeyId.slice(-4)}`;
}

async function storeSecret(
  req: FastifyRequest,
  ref: string,
  ownerType: string,
  ownerId: string,
  plaintext: string,
): Promise<void> {
  const sealed = seal(plaintext, req.ctx.config.masterKey);
  await req.ctx.db
    .insert(secrets)
    .values({
      ref,
      ownerType,
      ownerId,
      wrappedKey: sealed.wrappedKey,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    })
    .onConflictDoUpdate({
      target: secrets.ref,
      set: {
        wrappedKey: sealed.wrappedKey,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        updatedAt: new Date(),
      },
    });
}

async function readTarget(
  req: FastifyRequest,
  destination: DestinationRow,
): Promise<BackupDestinationTarget | null> {
  if (!destination.secretRef) return null;
  const rows = await req.ctx.db
    .select()
    .from(secrets)
    .where(eq(secrets.ref, destination.secretRef))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const plaintext = open(
    {
      wrappedKey: row.wrappedKey,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
    },
    req.ctx.config.masterKey,
  );
  return JSON.parse(plaintext) as BackupDestinationTarget;
}

const PROBE_TIMEOUT_MS = 8000;

async function probeDestination(
  req: FastifyRequest,
  target: BackupDestinationTarget,
): Promise<BackupDestinationTestResult> {
  const started = Date.now();
  const checkedAt = () => new Date().toISOString();

  if (target.kind === "local") {
    const server = await loadConnectedServer(req, target.server_id, "backups.schedules:write");
    try {
      const stat = await req.ctx.hub.call(
        server.id,
        "fs.stat",
        { path: target.path },
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (stat.kind !== "directory") {
        return {
          ok: false,
          writable: false,
          latency_ms: Date.now() - started,
          used_bytes: null,
          error: `${target.path} on ${server.name} is a ${stat.kind}, not a directory.`,
          remediation: {
            summary: `Point this destination at a directory, or remove ${target.path} and let the first run create it.`,
            actions: [
              {
                label: "Open in files",
                href: `/files/manager?server_id=${server.id}&path=${target.path}`,
              },
            ],
          },
          checked_at: checkedAt(),
        };
      }
      // The agent runs as root, so a directory it can stat is one it can write.
      return {
        ok: true,
        writable: true,
        latency_ms: Date.now() - started,
        used_bytes: null,
        error: null,
        checked_at: checkedAt(),
      };
    } catch (err) {
      return {
        ok: false,
        writable: false,
        latency_ms: Date.now() - started,
        used_bytes: null,
        error: `${target.path} is not reachable on ${server.name}: ${message(err)}`,
        remediation: {
          summary: `Create ${target.path} on ${server.name}, or choose a path the agent can reach.`,
          actions: [{ label: "Open in files", href: `/files/manager?server_id=${server.id}` }],
        },
        checked_at: checkedAt(),
      };
    }
  }

  if (target.kind === "sftp") {
    const banner = await sshBanner(target.host, target.port);
    return {
      ok: banner.ok,
      writable: false,
      latency_ms: banner.latencyMs,
      used_bytes: null,
      error: banner.ok ? null : `${target.host}:${target.port} did not answer: ${banner.error}`,
      remediation: banner.ok
        ? {
            summary: `${target.host}:${target.port} answered with ${banner.banner}. Kaname does not hold an SSH client, so the credentials themselves are proven by the first backup run.`,
            actions: [],
          }
        : {
            summary: `Check that ${target.host} is reachable on port ${target.port} from the control plane, and that no firewall in between drops it.`,
            actions: [{ label: "Firewall", href: "/security/firewall" }],
          },
      checked_at: checkedAt(),
    };
  }

  const url = objectStoreUrl(target);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 401/403 is a perfectly good answer here: something is listening and
    // it speaks the protocol. Only silence is a failure.
    return {
      ok: true,
      writable: false,
      latency_ms: Date.now() - started,
      used_bytes: null,
      error: null,
      remediation: {
        summary: `${url} answered ${response.status}. That proves the endpoint exists; whether these credentials can write is proven by the first backup run.`,
        actions: [],
      },
      checked_at: checkedAt(),
    };
  } catch (err) {
    return {
      ok: false,
      writable: false,
      latency_ms: Date.now() - started,
      used_bytes: null,
      error: `${url} is unreachable from the control plane: ${message(err)}`,
      remediation: {
        summary:
          "Check the endpoint and region, and that the control plane is allowed outbound HTTPS to this host.",
        actions: [{ label: "Copy endpoint", copy: url }],
      },
      checked_at: checkedAt(),
    };
  }
}

function objectStoreUrl(target: Extract<BackupDestinationTarget, { kind: "s3" | "b2" }>): string {
  if (target.kind === "b2") return "https://api.backblazeb2.com";
  if (target.endpoint) {
    return target.endpoint.startsWith("http") ? target.endpoint : `https://${target.endpoint}`;
  }
  return `https://s3.${target.region}.amazonaws.com`;
}

function sshBanner(
  host: string,
  port: number,
): Promise<{ ok: boolean; latencyMs: number; banner: string; error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    const finish = (ok: boolean, banner: string, error: string) => {
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - started, banner, error });
    };
    socket.once("data", (chunk) => {
      const banner = chunk.toString("utf8").trim().slice(0, 120);
      finish(
        banner.startsWith("SSH-"),
        banner,
        banner.startsWith("SSH-") ? "" : "not an SSH service",
      );
    });
    socket.once("timeout", () => finish(false, "", `no banner within ${PROBE_TIMEOUT_MS}ms`));
    socket.once("error", (err) => finish(false, "", err.message));
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ *
 * Repository naming
 * ------------------------------------------------------------------ */

function repositoryFor(destination: DestinationRow, scheduleName: string): string {
  const config = destination.config;
  const name = slugify(scheduleName);
  switch (destination.kind) {
    case "s3": {
      const endpoint = (
        config.endpoint ?? `s3.${config.region ?? "us-east-1"}.amazonaws.com`
      ).replace(/^https?:\/\//, "");
      return `s3:${endpoint}/${config.bucket}/${joinPath(config.prefix, name)}`;
    }
    case "b2":
      return `b2:${config.bucket}:${joinPath(config.prefix, name)}`;
    case "sftp":
      return `sftp:${config.username}@${config.host}:${joinPath(config.path, name)}`;
    default:
      return `/${joinPath(config.path, name)}`;
  }
}

function joinPath(prefix: string | undefined, name: string): string {
  const head = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return head ? `${head}/${name}` : name;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "backup"
  );
}

/* ------------------------------------------------------------------ *
 * Cron
 *
 * A dependency for this would be five fields of parsing plus a timezone
 * database we already have in `Intl`. Standard five-field cron: minute,
 * hour, day-of-month, month, day-of-week.
 * ------------------------------------------------------------------ */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** How far ahead we are willing to look before calling an expression unreachable. */
const CRON_HORIZON_YEARS = 5;

/**
 * The stored next_run_at. A disabled schedule has none; an expression
 * that can never fire is rejected here rather than becoming a backup
 * that silently never happens.
 */
function computeNextRun(cron: string, timeZone: string, enabled: boolean): Date | null {
  if (!enabled) return null;
  const next = nextCronRun(cron, timeZone);
  if (!next) {
    throw new ApiException(
      "validation_failed",
      `"${cron}" never comes round — there is no matching date in the next ${CRON_HORIZON_YEARS} years.`,
      {
        fields: { cron: "matches no real date, e.g. February 30th" },
        remediation: {
          summary: "Check the day-of-month and month fields against each other.",
          actions: [{ label: "Copy example", copy: "30 2 * * *" }],
        },
      },
    );
  }
  return next;
}

function nextCronRun(expression: string, timeZone: string, from = new Date()): Date | null {
  const fields = parseCron(expression);
  assertTimeZone(timeZone);

  // Walk wall-clock time in the schedule's own zone, then convert the
  // match back to an instant. Doing it the other way round drifts by an
  // hour twice a year, which is exactly when nobody is watching.
  const start = zoneParts(new Date(from.getTime() + 60_000), timeZone);
  let cursor = new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute));
  const limit = start.year + CRON_HORIZON_YEARS;

  while (cursor.getUTCFullYear() <= limit) {
    if (!fields.months.has(cursor.getUTCMonth() + 1)) {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 0, 0));
      continue;
    }
    if (!dayMatches(fields, cursor)) {
      cursor = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, 0, 0),
      );
      continue;
    }
    if (!fields.hours.has(cursor.getUTCHours())) {
      cursor = new Date(cursor.getTime() + 3_600_000 - (cursor.getTime() % 3_600_000));
      continue;
    }
    if (!fields.minutes.has(cursor.getUTCMinutes())) {
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }
    return wallClockToInstant(cursor, timeZone);
  }
  return null;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new ApiException(
      "validation_failed",
      `"${expression}" is not a five-field cron expression.`,
      {
        fields: { cron: "expected: minute hour day-of-month month day-of-week" },
        remediation: {
          summary: "Five fields, space separated. Daily at 02:30 is `30 2 * * *`.",
          actions: [{ label: "Copy example", copy: "30 2 * * *" }],
        },
      },
    );
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 0, 59, "minute"),
    hours: parseField(hour, 0, 23, "hour"),
    daysOfMonth: parseField(dom, 1, 31, "day-of-month"),
    months: parseField(month, 1, 12, "month", MONTH_NAMES),
    daysOfWeek: parseField(dow, 0, 6, "day-of-week", DAY_NAMES),
    domRestricted: !isWildcard(dom),
    dowRestricted: !isWildcard(dow),
  };
}

function isWildcard(field: string): boolean {
  return field === "*" || field === "?";
}

function parseField(
  field: string,
  min: number,
  max: number,
  label: string,
  names?: string[],
): Set<number> {
  const out = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw cronFieldError(label, part, "the step after `/` must be a positive whole number");
    }

    let low: number;
    let high: number;
    if (range === undefined || isWildcard(range)) {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      low = fieldValue(a, min, max, label, names);
      high = fieldValue(b, min, max, label, names);
    } else {
      low = fieldValue(range, min, max, label, names);
      // "5/15" means "from 5 onwards, every 15", not "just 5".
      high = stepText === undefined ? low : max;
    }
    if (low > high) throw cronFieldError(label, part, `${low} is after ${high}`);

    for (let value = low; value <= high; value += step) out.add(value);
  }

  if (out.size === 0) throw cronFieldError(label, field, "it matches nothing");
  return out;
}

function fieldValue(
  text: string | undefined,
  min: number,
  max: number,
  label: string,
  names?: string[],
): number {
  if (text === undefined || text === "") throw cronFieldError(label, "", "it is empty");

  // Names index from the field's own minimum: JAN is month 1, SUN is day 0.
  const named = names?.indexOf(text.toUpperCase()) ?? -1;
  if (named >= 0) return named + min;

  const value = Number(text);
  // Cron allows 7 for Sunday as well as 0.
  if (label === "day-of-week" && value === 7) return 0;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw cronFieldError(label, text, `it must be between ${min} and ${max}`);
  }
  return value;
}

function cronFieldError(label: string, part: string, why: string): ApiException {
  return new ApiException(
    "validation_failed",
    `The ${label} field of this cron expression is invalid.`,
    {
      fields: { cron: `"${part}": ${why}` },
      remediation: {
        summary: "Five fields, space separated. Daily at 02:30 is `30 2 * * *`.",
        actions: [{ label: "Copy example", copy: "30 2 * * *" }],
      },
    },
  );
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const dom = fields.daysOfMonth.has(date.getUTCDate());
  const dow = fields.daysOfWeek.has(date.getUTCDay());
  // Standard cron: when both are restricted, either one matching is enough.
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  if (fields.domRestricted) return dom;
  if (fields.dowRestricted) return dow;
  return true;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ApiException("validation_failed", `"${timeZone}" is not a known time zone.`, {
      fields: { timezone: "must be an IANA zone name" },
      remediation: {
        summary: 'Use an IANA name such as "Europe/Berlin", "America/New_York" or "UTC".',
        actions: [{ label: "Copy UTC", copy: "UTC" }],
      },
    });
  }
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    // Some ICU builds render midnight as hour 24.
    hour: Number(map.get("hour")) % 24,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

function wallEpoch(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** `wall` carries the intended local clock encoded as UTC. */
function wallClockToInstant(wall: Date, timeZone: string): Date {
  const target = wall.getTime();
  // One correction pass, because the offset at the guessed instant is the
  // one that actually applies across a DST boundary.
  const guess = new Date(target - zoneOffsetMs(wall, timeZone));
  let instant = new Date(target - zoneOffsetMs(guess, timeZone));

  // The hour a spring-forward skips has no instant at all, and the
  // arithmetic above lands before it. Running a backup early and then
  // again at the real time is worse than running it late, so walk up to
  // the first minute the local clock actually reaches.
  for (let i = 0; i < 180 && wallEpoch(instant, timeZone) < target; i += 1) {
    instant = new Date(instant.getTime() + 60_000);
  }
  return instant;
}

/* ------------------------------------------------------------------ *
 * Row to API shape
 * ------------------------------------------------------------------ */

function toDestination(row: DestinationRow): BackupDestination {
  const config = row.config;
  const summary: BackupDestinationSummary = {
    endpoint: config.endpoint ?? null,
    region: config.region ?? null,
    bucket: config.bucket ?? null,
    host: config.host ?? null,
    path: config.path ?? null,
    access_key_hint: config.access_key_hint ?? null,
  };
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: summary,
    status: row.status,
    status_detail: row.lastError,
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    used_bytes: row.usedBytes,
    snapshot_count: row.snapshotCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toSchedule(
  row: ScheduleRow,
  serverName: string,
  destinationName: string,
  lastRunId: string | null,
): BackupSchedule {
  return {
    id: row.id,
    name: row.name,
    server_id: row.serverId,
    server_name: serverName,
    scope: row.scope as BackupScope[],
    cron: row.cron,
    timezone: row.timezone,
    destination_id: row.destinationId,
    destination_name: destinationName,
    retention: row.retention as BackupRetention,
    encryption: row.encryption,
    enabled: row.enabled,
    last_run_at: row.lastRunAt?.toISOString() ?? null,
    last_run_status: row.lastRunStatus ?? null,
    last_run_id: lastRunId,
    next_run_at: row.nextRunAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toRun(
  row: typeof backupRuns.$inferSelect,
  serverName: string,
  scheduleName: string | null,
): BackupRun {
  return {
    id: row.id,
    schedule_id: row.scheduleId!,
    schedule_name: scheduleName ?? "(deleted schedule)",
    server_id: row.serverId,
    server_name: serverName,
    trigger: row.trigger,
    status: row.status,
    bytes: row.bytes,
    files: row.files,
    started_at: (row.startedAt ?? row.createdAt).toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
    duration_ms: row.durationMs,
    job_id: row.jobId!,
    error: row.error,
    restore_point_id: row.restorePointId,
  };
}

function toRestorePoint(row: RestorePointRow, serverName: string): RestorePoint {
  return {
    id: row.id,
    run_id: row.runId,
    schedule_id: row.scheduleId!,
    server_id: row.serverId,
    server_name: serverName,
    label: row.label,
    taken_at: row.takenAt.toISOString(),
    bytes: row.bytes,
    file_count: row.fileCount,
    scope: row.scope as BackupScope[],
    verified_at: row.verifiedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
  };
}
