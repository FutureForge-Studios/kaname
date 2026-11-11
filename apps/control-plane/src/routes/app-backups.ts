import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, sql } from "@kaname/db";
import {
  appInstalls,
  backupDestinations,
  backupRuns,
  backupSchedules,
  jobs,
  restorePoints,
  secrets,
  servers,
} from "@kaname/db/schema";
import {
  appBackupNowInput,
  appRestoreAsNewInput,
  appRestoreInput,
  findApp,
  idParam,
  isNewerVersion,
  type AppBackupOverview,
  type AppRestorePoint,
  type Job,
} from "@kaname/contract";
import { accepted, helpers, item, parseBody, parseParams } from "../http/plugin.js";
import { ApiException, conflict, notFound } from "../lib/errors.js";
import { generateToken, open, seal } from "../lib/crypto.js";
import { computeNextRun } from "../lib/cron.js";
import { STOP_DURING_BACKUP, unsupportedReason } from "../services/app-backup-plan.js";
import { containerSecretNames, containerSecretRef } from "../services/app-installer.js";
import type { AppRestoreParams } from "../jobs/app-backups.js";
import { enqueueServerJob, loadServer, type ServerRow } from "./_shared.js";
import { isOwnedBy, ownership } from "./_ownership.js";
import {
  assertDestinationReachableFrom,
  destinationRow,
  repositoryFor,
  secretRef,
  startScheduleRun,
  storeSecret,
  toRestorePoint,
  toRun,
  type ScheduleRow,
} from "./backups.js";

/* ------------------------------------------------------------------ *
 * /backups/apps/:install_id — an app's backups, as its own page shows them.
 *
 * Every route opts in to ownership (KD-039): a reseller or client may
 * back up and restore only an install it started or whose site it owns,
 * and an install that is not theirs is a 404 like any other. Operators
 * are unaffected.
 *
 * "Back up now" runs the app's own schedule — the one whose scope is
 * exactly this app — creating it (nightly, on a destination the person
 * picks) the first time. A restore is gated on retyping the app's
 * domain, refused while another restore of it is in flight, and refused
 * when the snapshot holds a newer app version than the recipe Kaname
 * installs today: restoring newer data under an older image is how an
 * app's database migrations get run backwards.
 * ------------------------------------------------------------------ */

type InstallRow = typeof appInstalls.$inferSelect;

const APP_SCHEDULE_CRON = "30 3 * * *";
const APP_SCHEDULE_RETENTION = { keep_last: 7, keep_daily: 7, keep_weekly: 4, keep_monthly: 6 };

export async function appBackupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/backups/apps/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const row = await loadOwnedInstall(req, id, "backups.schedules:read");
    return item(reply, await overview(req, row));
  });

  app.post("/backups/apps/:id/run", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const body = parseBody(req, appBackupNowInput);
    const row = await loadOwnedInstall(req, id, "backups.schedules:write");
    const server = await loadServer(req, row.serverId, "backups.schedules:write");
    const recipe = findApp(row.appId);
    const reason = unsupportedReason(row, recipe);
    if (reason) throw new ApiException("precondition_failed", reason);

    let schedule = (await coveringSchedules(req, row)).find((s) => isOwnSchedule(s, row.id)) ?? null;
    if (!schedule) {
      if (!body.destination_id) {
        throw new ApiException("validation_failed", "Pick where this app's backups go.", {
          fields: { destination_id: "required for the first backup of this app" },
        });
      }
      schedule = await createAppSchedule(req, row, server, body.destination_id);
    }
    const destination = await destinationRow(req, schedule.destinationId);
    const job = await startScheduleRun(req, schedule, server, destination);
    return accepted(reply, job);
  });

  app.post("/backups/apps/:id/restore", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const body = parseBody(req, appRestoreInput);
    const row = await loadOwnedInstall(req, id, "backups.restore:exec");
    const server = await loadServer(req, row.serverId, "backups.restore:exec");
    confirmDomain(body.confirm_domain, row);
    const { point, schedule, manifest } = await loadAppPoint(req, body.restore_point_id, row.id);
    if (point.serverId !== row.serverId) {
      throw conflict("This restore point was taken on another server.", {
        summary: "Use Restore as new to put it on a different server.",
        actions: [],
      });
    }
    if (row.status !== "active") {
      throw new ApiException("precondition_failed", `${row.appName} on ${row.domain} is ${row.status}; it can be restored once it is active.`);
    }
    await assertNoRestoreInFlight(req, row.id);

    const job = await enqueueServerJob(req, {
      type: "app.restore",
      server,
      targetType: "app_install",
      targetId: row.id,
      targetLabel: `${row.appName} on ${row.domain} ← ${point.label}`,
      params: restoreParams(row.id, row.id, point, schedule, "in_place"),
    });
    req.ctx.events.publish("backups", "app_restore.queued", { install_id: row.id, job_id: job.id }, server.id);
    return reply.status(202).send({
      data: {
        job,
        restore: {
          restore_point: point.label,
          app_version: manifest.app_version,
          summary: `${row.appName} on ${row.domain} will be stopped, its data and database replaced from ${point.label} (taken ${point.takenAt.toISOString()}), then started and checked. A copy of today's database is kept until the restore succeeds.`,
        },
      },
    });
  });

  app.post("/backups/apps/:id/restore-as-new", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const body = parseBody(req, appRestoreAsNewInput);
    const source = await loadOwnedInstall(req, id, "backups.restore:exec");
    confirmDomain(body.confirm_domain, source);
    const target = await loadServer(req, body.target_server_id, "backups.restore:exec");
    const { point, schedule, manifest } = await loadAppPoint(req, body.restore_point_id, source.id);
    const recipe = findApp(source.appId);
    if (!recipe || recipe.source.kind !== "image") {
      throw new ApiException(
        "precondition_failed",
        `${source.appName} keeps its own address in its files and database, so a copy on another domain would still point at ${source.domain}. Restore it in place instead.`,
      );
    }
    const destination = await destinationRow(req, schedule.destinationId);
    assertDestinationReachableFrom(destination, target);

    // The new install's id is chosen here so its secrets can be sealed
    // under it before its job reads them: it then starts with the
    // source's database password, encryption keys and session secrets,
    // which is what lets the restored data open.
    const newId = randomUUID();
    const copied = await copySecrets(req, recipe, source.id, newId);

    const created = await req.server.inject({
      method: "POST",
      url: "/api/v1/apps/installs",
      headers: forwardedAuth(req),
      payload: {
        app_id: source.appId,
        server_id: target.id,
        domain: body.domain,
        admin_email: source.inputs.admin_email,
        ssl: body.ssl,
        system_user: source.inputs.system_user,
        plan_id: newId,
      },
    });
    if (created.statusCode !== 202) {
      await req.ctx.db.delete(secrets).where(inArray(secrets.ref, copied));
      // The installer's own refusal (domain taken, quota, server) is the answer.
      return reply.status(created.statusCode).headers({ "content-type": "application/json" }).send(created.body);
    }

    const job = await enqueueServerJob(req, {
      type: "app.restore",
      server: target,
      targetType: "app_install",
      targetId: newId,
      targetLabel: `${source.appName} on ${body.domain} ← ${point.label}`,
      params: restoreParams(newId, source.id, point, schedule, "as_new"),
    });
    const install = (created.json() as { data: { install: unknown; job: Job } }).data;
    return reply.status(202).send({
      data: {
        job,
        install: install.install,
        install_job: install.job,
        restore: {
          restore_point: point.label,
          app_version: manifest.app_version,
          summary: `A new ${source.appName} is being installed on ${body.domain} (${target.name}). Once it is up, ${point.label} is restored into it with ${source.domain}'s secrets.`,
        },
      },
    });
  });
}

/* ------------------------------------------------------------------ *
 * Loaders and checks
 * ------------------------------------------------------------------ */

/** The install, if the caller may see it; a 404 otherwise. */
async function loadOwnedInstall(
  req: FastifyRequest,
  id: string,
  permission: "backups.schedules:read" | "backups.schedules:write" | "backups.restore:exec",
): Promise<InstallRow> {
  const rows = await req.ctx.db.select().from(appInstalls).where(eq(appInstalls.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("App install", id);
  helpers(req).authorize(permission, row.serverId);
  const account = req.principal?.scoped;
  if (account) {
    const mine =
      (row.createdBy && account.ownerIds.includes(row.createdBy)) ||
      (row.siteId ? await isOwnedBy(req.ctx.db, "site", row.siteId, account.ownerIds) : false);
    if (!mine) throw notFound("App install", id);
  }
  return row;
}

function confirmDomain(typed: string, row: InstallRow): void {
  if (typed.trim().toLowerCase() !== row.domain.toLowerCase()) {
    throw new ApiException("validation_failed", "The confirmation does not match.", {
      fields: { confirm_domain: `type ${row.domain} to confirm` },
    });
  }
}

const scopeIncludes = (installId: string) =>
  sql`${JSON.stringify([{ kind: "app", selectors: [installId] }])}::jsonb`;

async function coveringSchedules(req: FastifyRequest, row: InstallRow): Promise<ScheduleRow[]> {
  return req.ctx.db
    .select()
    .from(backupSchedules)
    .where(
      and(
        eq(backupSchedules.serverId, row.serverId),
        sql`${backupSchedules.scope} @> ${scopeIncludes(row.id)}`,
      ),
    )
    .orderBy(backupSchedules.createdAt);
}

/** A schedule whose scope is this app and nothing else. */
function isOwnSchedule(schedule: ScheduleRow, installId: string): boolean {
  const scope = schedule.scope;
  return (
    scope.length === 1 &&
    scope[0]!.kind === "app" &&
    scope[0]!.selectors.length === 1 &&
    scope[0]!.selectors[0] === installId
  );
}

async function loadAppPoint(req: FastifyRequest, pointId: string, installId: string) {
  const rows = await req.ctx.db.select().from(restorePoints).where(eq(restorePoints.id, pointId)).limit(1);
  const point = rows[0];
  const manifest = point?.manifest?.apps?.[installId];
  if (!point || !manifest) throw notFound("Restore point", pointId);

  const recipe = findApp(manifest.app_id);
  if (!recipe) {
    throw new ApiException("precondition_failed", `${manifest.app_name} is no longer in the catalog.`);
  }
  if (isNewerVersion(manifest.app_version, recipe.version)) {
    throw conflict(
      `This restore point holds ${manifest.app_name} ${manifest.app_version}, newer than the ${recipe.version} Kaname installs.`,
      {
        summary:
          "Restoring newer data under an older version can run the app's database migrations backwards. Update Kaname (and its app catalog) first, then restore.",
        actions: [{ label: "Updates", href: "/administration/updates" }],
      },
    );
  }

  const schedules = point.scheduleId
    ? await req.ctx.db.select().from(backupSchedules).where(eq(backupSchedules.id, point.scheduleId)).limit(1)
    : [];
  const schedule = schedules[0];
  if (!schedule) {
    throw new ApiException(
      "precondition_failed",
      `Restore point "${point.label}" has no schedule left to tell Kaname which repository it lives in.`,
    );
  }
  return { point, schedule, manifest };
}

async function assertNoRestoreInFlight(req: FastifyRequest, installId: string): Promise<void> {
  const busy = await req.ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "app.restore"),
        eq(jobs.targetId, installId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (busy[0]) {
    throw conflict("A restore of this app is already in progress.", {
      summary: "Wait for it to finish, or cancel it, then try again.",
      actions: [{ label: "Open the job", href: `/jobs/${busy[0].id}` }],
    });
  }
}

function restoreParams(
  installId: string,
  sourceId: string,
  point: typeof restorePoints.$inferSelect,
  schedule: ScheduleRow,
  mode: AppRestoreParams["mode"],
): Record<string, unknown> {
  const params: AppRestoreParams = {
    install_id: installId,
    source_install_id: sourceId,
    restore_point_id: point.id,
    repository: schedule.repositoryPath,
    password_ref: schedule.passwordRef ?? "",
    snapshot_id: point.snapshotId,
    mode,
  };
  return { ...params };
}

/** The headers that carry the caller's identity into an internal request. */
function forwardedAuth(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["cookie", "authorization", "x-forwarded-proto", "host", "user-agent"]) {
    const value = req.headers[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** Seals the source install's secrets again under the new install's refs. */
async function copySecrets(
  req: FastifyRequest,
  recipe: NonNullable<ReturnType<typeof findApp>>,
  sourceId: string,
  targetId: string,
): Promise<string[]> {
  const copied: string[] = [];
  for (const name of containerSecretNames(recipe)) {
    const rows = await req.ctx.db
      .select()
      .from(secrets)
      .where(eq(secrets.ref, containerSecretRef(sourceId, name)))
      .limit(1);
    const row = rows[0];
    if (!row) continue;
    const plaintext = open(
      { wrappedKey: row.wrappedKey, nonce: row.nonce, ciphertext: row.ciphertext, keyVersion: row.keyVersion },
      req.ctx.config.masterKey,
    );
    const ref = containerSecretRef(targetId, name);
    const sealed = seal(plaintext, req.ctx.config.masterKey);
    await req.ctx.db
      .insert(secrets)
      .values({ ref, ownerType: "app_install", ownerId: targetId, ...sealed })
      .onConflictDoNothing();
    copied.push(ref);
  }
  return copied;
}

/** The app's own schedule: nightly, on the destination picked, encrypted. */
async function createAppSchedule(
  req: FastifyRequest,
  row: InstallRow,
  server: ServerRow,
  destinationId: string,
): Promise<ScheduleRow> {
  const destination = await destinationRow(req, destinationId);
  assertDestinationReachableFrom(destination, server);
  let name = `app ${row.domain}`.slice(0, 64);
  const clash = await req.ctx.db
    .select({ id: backupSchedules.id })
    .from(backupSchedules)
    .where(eq(backupSchedules.name, name))
    .limit(1);
  if (clash[0]) name = `app ${row.domain} ${row.id.slice(0, 8)}`.slice(0, 64);

  const [created] = await req.ctx.db
    .insert(backupSchedules)
    .values({
      name,
      serverId: server.id,
      scope: [{ kind: "app", selectors: [row.id] }],
      cron: APP_SCHEDULE_CRON,
      timezone: "UTC",
      destinationId: destination.id,
      retention: APP_SCHEDULE_RETENTION,
      encryption: true,
      repositoryPath: repositoryFor(destination, name),
      enabled: true,
      nextRunAt: computeNextRun(APP_SCHEDULE_CRON, "UTC", true),
    })
    .returning();
  await storeSecret(req, secretRef(created!.id, "schedule"), "backup_schedule", created!.id, generateToken());
  const [schedule] = await req.ctx.db
    .update(backupSchedules)
    .set({ passwordRef: secretRef(created!.id, "schedule") })
    .where(eq(backupSchedules.id, created!.id))
    .returning();

  await req.ctx.audit.record({
    actor: helpers(req).actor(),
    action: "backup_schedule.created",
    targetType: "backup_schedule",
    targetId: created!.id,
    targetLabel: name,
    serverId: server.id,
    after: { name, cron: APP_SCHEDULE_CRON, destination: destination.name, app_install: row.id },
  });
  req.ctx.events.publish("backups", "schedule.created", { schedule_id: created!.id }, server.id);
  return schedule!;
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

async function overview(req: FastifyRequest, row: InstallRow): Promise<AppBackupOverview> {
  const recipe = findApp(row.appId);
  const schedules = await coveringSchedules(req, row);
  const own = schedules.find((s) => isOwnSchedule(s, row.id)) ?? null;
  const ownDestination = own ? await destinationRow(req, own.destinationId) : null;

  const [server] = await req.ctx.db.select({ name: servers.name }).from(servers).where(eq(servers.id, row.serverId)).limit(1);
  const serverName = server?.name ?? "";

  const lastRunRows = schedules.length
    ? await req.ctx.db
        .select({ run: backupRuns, scheduleName: backupSchedules.name })
        .from(backupRuns)
        .leftJoin(backupSchedules, eq(backupRuns.scheduleId, backupSchedules.id))
        .where(inArray(backupRuns.scheduleId, schedules.map((s) => s.id)))
        .orderBy(desc(backupRuns.createdAt))
        .limit(1)
    : [];

  const points = await req.ctx.db
    .select()
    .from(restorePoints)
    .where(sql`${restorePoints.scope} @> ${scopeIncludes(row.id)}`)
    .orderBy(desc(restorePoints.takenAt))
    .limit(30);

  const destinations = await req.ctx.db
    .select({
      id: backupDestinations.id,
      name: backupDestinations.name,
      kind: backupDestinations.kind,
      config: backupDestinations.config,
    })
    .from(backupDestinations)
    .orderBy(backupDestinations.name);

  return {
    install_id: row.id,
    app_name: row.appName,
    domain: row.domain,
    schedule:
      own && ownDestination
        ? {
            id: own.id,
            name: own.name,
            destination_id: own.destinationId,
            destination_name: ownDestination.name,
            cron: own.cron,
            enabled: own.enabled,
            next_run_at: own.nextRunAt?.toISOString() ?? null,
          }
        : null,
    covered_by: schedules.map((s) => ({ id: s.id, name: s.name })),
    last_run: lastRunRows[0] ? toRun(lastRunRows[0].run, serverName, lastRunRows[0].scheduleName) : null,
    restore_points: points.map((point): AppRestorePoint => {
      const version = point.manifest?.apps?.[row.id]?.app_version ?? null;
      return {
        ...toRestorePoint(point, serverName),
        app_version: version,
        newer_than_recipe: version !== null && recipe ? isNewerVersion(version, recipe.version) : false,
      };
    }),
    destinations: destinations
      .filter((d) => d.kind !== "local" || d.config.server_id === row.serverId)
      .map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
    stop_during_backup: STOP_DURING_BACKUP[row.appId] ?? false,
    unsupported_reason: unsupportedReason(row, recipe),
  };
}
