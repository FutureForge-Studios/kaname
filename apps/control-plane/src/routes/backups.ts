import { connect } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, sql } from "@kaname/db";
import {
  backupDestinations,
  backupRuns,
  backupSchedules,
  jobs,
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
  type Job,
  type RestorePoint,
  s3BaseUrl,
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
import { generateToken } from "../lib/crypto.js";
import { computeNextRun } from "../lib/cron.js";
import { planScope } from "../services/backup-scheduler.js";
import {
  ensureSchedulePassword,
  readDestinationTarget,
  secretRef,
  storeSecret as storeSecretRow,
} from "../services/backup-secrets.js";
import { pathStyle, probeS3 } from "../services/s3-probe.js";
import { appBackupRoutes } from "./app-backups.js";
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


export async function backupRoutes(app: FastifyInstance): Promise<void> {
  // App backup & restore: /backups/apps/* (routes/app-backups.ts).
  await appBackupRoutes(app);

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
      // Every host writing to this destination gets the new credentials.
      const using = await req.ctx.db
        .select()
        .from(backupSchedules)
        .where(eq(backupSchedules.destinationId, id));
      for (const schedule of using) {
        await queueBackupSecretJob(req, { type: "backup.provision", schedule });
      }
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
    // The host gets the password and the destination's credentials now,
    // not at 03:00 when the first run would find them missing.
    await queueBackupSecretJob(req, { type: "backup.provision", schedule: row!, serverName: server.name });

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
    // What the host's secret holds: the destination's credentials. A name
    // change moves the repository path, which every job carries itself.
    const credentialsMoved =
      (body.destination_id !== undefined && body.destination_id !== schedule.destinationId) ||
      (body.encryption !== undefined && body.encryption !== schedule.encryption);
    if (credentialsMoved) {
      await queueBackupSecretJob(req, { type: "backup.provision", schedule: row!, serverName: server.name });
    }

    const lastRuns = await lastRunIds(req, [id]);
    return item(reply, toSchedule(row!, server.name, destination.name, lastRuns.get(id) ?? null));
  });

  app.delete("/backups/schedules/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { schedule, server } = await loadSchedule(req, id, "backups.schedules:delete");
    const h = helpers(req);

    // Queued first, while the row still names its ref and its server: the
    // host's copy of the password goes with the schedule.
    if (schedule.passwordRef) {
      await queueBackupSecretJob(req, {
        type: "backup.unprovision",
        schedule,
        serverName: server.name,
        ref: schedule.passwordRef,
      });
    }
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
    const job = await startScheduleRun(req, schedule, server, destination);
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
        password_ref: await ensureSchedulePassword(req.ctx.db, req.ctx.config.masterKey, schedule),
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
        password_ref: await ensureSchedulePassword(req.ctx.db, req.ctx.config.masterKey, schedule),
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


/**
 * Queues one run of a schedule: plans its scope, records the run and
 * enqueues the job. Shared by "Run now" and an app's "Back up now".
 */
export async function startScheduleRun(
  req: FastifyRequest,
  schedule: ScheduleRow,
  server: ServerRow,
  destination: DestinationRow,
) {
  const h = helpers(req);
  const principal = h.requirePrincipal();

  const plan = await planScope(req.ctx.db, schedule);
  // restic always needs a password, encryption flag or not.
  const passwordRef = await ensureSchedulePassword(req.ctx.db, req.ctx.config.masterKey, schedule);

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
      password_ref: passwordRef,
      paths: plan.paths,
      exclude: plan.exclude,
      tags: [`schedule:${schedule.id}`, "trigger:manual"],
      databases: plan.databases,
      ...(plan.apps.length > 0 ? { apps: plan.apps } : {}),
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

  return job;
}

/**
 * Queues a `backup.provision` (hand the schedule's host its password and
 * destination credentials) or `backup.unprovision` (take them away). The
 * params name the schedule or the ref only; the worker opens the values.
 *
 * Not enqueueServerJob: the change that calls for this was authorised
 * already, and a credential rotation on a destination has to reach every
 * host using it, including ones outside the rotating user's own scope.
 * A provision already waiting for the same schedule covers a second one
 * (it reads the secrets when it runs), and a revoked host gets nothing.
 */
export async function queueBackupSecretJob(
  req: FastifyRequest,
  opts: {
    type: "backup.provision" | "backup.unprovision";
    schedule: { id: string; name: string; serverId: string };
    serverName?: string;
    /** The stored ref to remove (unprovision only). */
    ref?: string;
  },
): Promise<Job | null> {
  const { schedule } = opts;
  const [server] = await req.ctx.db
    .select({ name: servers.name, revokedAt: servers.revokedAt })
    .from(servers)
    .where(eq(servers.id, schedule.serverId))
    .limit(1);
  if (!server || server.revokedAt) return null;

  if (opts.type === "backup.provision") {
    const waiting = await req.ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "backup.provision"),
          eq(jobs.targetId, schedule.id),
          eq(jobs.status, "queued"),
        ),
      )
      .limit(1);
    if (waiting[0]) return null;
  }

  const h = helpers(req);
  const principal = h.requirePrincipal();
  const params =
    opts.type === "backup.provision" ? { schedule_id: schedule.id } : { ref: opts.ref ?? "" };
  const job = await req.ctx.queue.enqueue({
    type: opts.type,
    serverId: schedule.serverId,
    targetType: "backup_schedule",
    targetId: schedule.id,
    targetLabel: schedule.name,
    params,
    createdBy: principal.kind === "user" ? principal.id : null,
    createdByName: principal.name,
    blockedReason: req.ctx.hub.isConnected(schedule.serverId) ? null : "agent_offline",
  });
  await req.ctx.audit.record({
    actor: h.actor(),
    action: `${opts.type}.requested`,
    targetType: "backup_schedule",
    targetId: schedule.id,
    targetLabel: schedule.name,
    serverId: schedule.serverId,
    jobId: job.id,
    metadata: { params },
  });
  const named = { ...job, server_name: opts.serverName ?? server.name };
  req.ctx.events.publish("jobs", "job.queued", named, schedule.serverId);
  return named;
}

/* ------------------------------------------------------------------ *
 * Loaders
 * ------------------------------------------------------------------ */

export type DestinationRow = typeof backupDestinations.$inferSelect;
export type ScheduleRow = typeof backupSchedules.$inferSelect;
export type RestorePointRow = typeof restorePoints.$inferSelect;

export async function destinationRow(req: FastifyRequest, id: string): Promise<DestinationRow> {
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
export function assertDestinationReachableFrom(destination: DestinationRow, server: ServerRow): void {
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
 * Destinations: config, secrets and reachability
 * ------------------------------------------------------------------ */

export { secretRef };

/** Everything about a target except how it authenticates. */
function publicConfig(target: BackupDestinationTarget): Record<string, string> {
  switch (target.kind) {
    case "s3": {
      const base = s3BaseUrl({
        provider: target.provider,
        region: target.region,
        endpoint: target.endpoint ?? null,
        account_id: target.account_id ?? null,
      });
      return {
        // The endpoint as it will be used, preset-derived or typed.
        ...(base ? { endpoint: base.replace(/^https:\/\//, "") } : {}),
        provider: target.provider,
        region: target.region,
        bucket: target.bucket,
        prefix: target.prefix,
        // The addressing "Test connection" and restic both use.
        path_style: String(pathStyle(target)),
        access_key_hint: hint(target.access_key_id),
      };
    }
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

export async function storeSecret(
  req: FastifyRequest,
  ref: string,
  ownerType: string,
  ownerId: string,
  plaintext: string,
): Promise<void> {
  await storeSecretRow(req.ctx.db, req.ctx.config.masterKey, { ref, ownerType, ownerId, plaintext });
}

function readTarget(
  req: FastifyRequest,
  destination: DestinationRow,
): Promise<BackupDestinationTarget | null> {
  return readDestinationTarget(req.ctx.db, req.ctx.config.masterKey, destination);
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
          failure: "other",
          checks: [],
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
        failure: null,
        checks: [],
        latency_ms: Date.now() - started,
        used_bytes: null,
        error: null,
        checked_at: checkedAt(),
      };
    } catch (err) {
      return {
        ok: false,
        writable: false,
        failure: "network",
        checks: [],
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
      failure: banner.ok ? null : "network",
      checks: [],
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

  if (target.kind === "s3") {
    const probe = await probeS3(target, { timeoutMs: PROBE_TIMEOUT_MS });
    return {
      ok: probe.ok,
      writable: probe.writable,
      failure: probe.failure,
      checks: probe.checks,
      latency_ms: Date.now() - started,
      used_bytes: null,
      error: probe.error,
      remediation: probe.ok
        ? {
            summary: `Wrote, read back and deleted a probe object in ${target.bucket}. These credentials can do what a backup does.`,
            actions: [],
          }
        : {
            summary: probe.hint ?? "The storage service refused the probe.",
            actions: probe.url ? [{ label: "Copy URL", copy: probe.url }] : [],
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
      failure: null,
      checks: [],
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
      failure: "network",
      checks: [],
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

function objectStoreUrl(_target: Extract<BackupDestinationTarget, { kind: "b2" }>): string {
  return "https://api.backblazeb2.com";
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

export function repositoryFor(destination: DestinationRow, scheduleName: string): string {
  const config = destination.config;
  const name = slugify(scheduleName);
  switch (destination.kind) {
    case "s3": {
      // restic's form: s3:<host>/<bucket>/<prefix>, with an explicit
      // scheme only when it is not https (a MinIO on plain HTTP).
      const endpoint = (
        config.endpoint ?? `s3.${config.region ?? "us-east-1"}.amazonaws.com`
      ).replace(/^https:\/\//, "");
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
    provider: (config.provider as BackupDestinationSummary["provider"]) ?? (row.kind === "s3" ? "aws" : null),
    path_style: config.path_style === undefined ? null : config.path_style === "true",
    prefix: config.prefix ?? null,
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

export function toRun(
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

export function toRestorePoint(row: RestorePointRow, serverName: string): RestorePoint {
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
