import { and, eq, isNull, type Database } from "@kaname/db";
import { backupDestinations, backupSchedules, restorePoints, secrets } from "@kaname/db/schema";
import { s3SigningRegion, type BackupDestinationTarget } from "@kaname/contract";
import { AgentRpcError, type AgentHub } from "../agent/hub.js";
import { ApiException } from "../lib/errors.js";
import { generateToken, open, seal } from "../lib/crypto.js";
import type { JobContext } from "../jobs/worker.js";
import { pathStyle } from "./s3-probe.js";

/* ------------------------------------------------------------------ *
 * Backup secrets on the host.
 *
 * restic reads its repository password and its S3/B2 credentials from a
 * file the agent keeps under its `backup-secrets/<ref>` directory. The
 * values live here, envelope-encrypted in the `secrets` table, and reach
 * the host only through the write-only `backup.secret_put` verb — opened
 * inside the job worker immediately before that RPC. They are never put
 * in job params (persisted), job logs, audit entries, events or API
 * responses, and no error message built here contains one.
 *
 * Refs: the database keeps `backup_schedule:<uuid>` (what every schedule
 * row and every queued job already carries). The agent refuses `:` in a
 * ref, so `agentSecretRef` maps it to `backup_schedule.<uuid>` at the
 * agent boundary only — no data migration, and jobs queued before this
 * change keep working.
 * ------------------------------------------------------------------ */

const SCHEDULE_REF = /^backup_schedule:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The ref a backup secret is stored under in the `secrets` table. */
export function secretRef(id: string, kind: "destination" | "schedule" = "destination"): string {
  return kind === "schedule" ? `backup_schedule:${id}` : `backup_destination:${id}`;
}

/** The stored ref as the agent accepts it (`[A-Za-z0-9._-]`, no `:`). */
export function agentSecretRef(storedRef: string): string {
  return storedRef.replaceAll(":", ".");
}

/** The schedule id a stored ref names, or a precondition error for anything else. */
export function scheduleIdFromRef(storedRef: string): string {
  const match = SCHEDULE_REF.exec(storedRef);
  if (!match) {
    throw new ApiException(
      "precondition_failed",
      "This backup job does not name a schedule's repository password, so Kaname cannot hand the host its credentials.",
    );
  }
  return match[1]!.toLowerCase();
}

/* ------------------------------ storage ----------------------------- */

/** Seals and stores one secret. `overwrite: false` keeps a row that already exists. */
export async function storeSecret(
  db: Database,
  masterKey: Buffer,
  opts: { ref: string; ownerType: string; ownerId: string; plaintext: string; overwrite?: boolean },
): Promise<void> {
  const sealed = seal(opts.plaintext, masterKey);
  const insert = db.insert(secrets).values({
    ref: opts.ref,
    ownerType: opts.ownerType,
    ownerId: opts.ownerId,
    wrappedKey: sealed.wrappedKey,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    keyVersion: sealed.keyVersion,
  });
  if (opts.overwrite === false) {
    await insert.onConflictDoNothing({ target: secrets.ref });
    return;
  }
  await insert.onConflictDoUpdate({
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

/** Opens one stored secret, or null when there is none under that ref. */
export async function readSecret(db: Database, masterKey: Buffer, ref: string): Promise<string | null> {
  const rows = await db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return open(
    { wrappedKey: row.wrappedKey, nonce: row.nonce, ciphertext: row.ciphertext, keyVersion: row.keyVersion },
    masterKey,
  );
}

/** A destination's full target, credentials included, or null when none is stored. */
export async function readDestinationTarget(
  db: Database,
  masterKey: Buffer,
  destination: { secretRef: string | null },
): Promise<BackupDestinationTarget | null> {
  if (!destination.secretRef) return null;
  const plaintext = await readSecret(db, masterKey, destination.secretRef);
  if (plaintext === null) return null;
  try {
    return JSON.parse(plaintext) as BackupDestinationTarget;
  } catch {
    // Not the SyntaxError: its message quotes the text it choked on, and
    // that text holds the destination's credentials.
    throw new Error("A backup destination's stored target could not be read; send its target again.");
  }
}

/* --------------------------- restic env ----------------------------- */

/** What the agent writes beside the password: restic's own variable names. */
export interface ResticEnv {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_DEFAULT_REGION?: string;
  B2_ACCOUNT_ID?: string;
  B2_ACCOUNT_KEY?: string;
  KANAME_S3_BUCKET_LOOKUP?: "auto" | "dns" | "path";
}

/** The environment restic needs to reach a destination. */
export function resticEnvFor(target: BackupDestinationTarget): ResticEnv {
  switch (target.kind) {
    case "s3": {
      // The rule "Test connection" and the destination's public config
      // use: asked for, the preset's preference, or a dotted bucket name
      // (which breaks TLS on a virtual-hosted name).
      return {
        AWS_ACCESS_KEY_ID: target.access_key_id,
        AWS_SECRET_ACCESS_KEY: target.secret_access_key,
        // The region requests are signed for, as "Test connection" signs.
        AWS_DEFAULT_REGION: s3SigningRegion(target.provider, target.region),
        KANAME_S3_BUCKET_LOOKUP: pathStyle(target) ? "path" : "dns",
      };
    }
    case "b2":
      return { B2_ACCOUNT_ID: target.access_key_id, B2_ACCOUNT_KEY: target.secret_access_key };
    case "local":
      return {};
    case "sftp":
      throw sftpUnsupported();
  }
}

function sftpUnsupported(): ApiException {
  return new ApiException(
    "precondition_failed",
    "SFTP destinations need an SSH key on the host, which Kaname does not provision yet; use S3, B2 or a local destination.",
    {
      remediation: {
        summary: "Point this schedule at an S3, B2 or local destination.",
        actions: [{ label: "Backup destinations", href: "/backups/destinations" }],
      },
    },
  );
}

/* ---------------------------- passwords ----------------------------- */

/** The refusal when a schedule names a password Kaname no longer holds. */
export function passwordMissing(scheduleName?: string): ApiException {
  return new ApiException(
    "precondition_failed",
    `${scheduleName ? `The repository password of "${scheduleName}"` : "This schedule's repository password"} is missing from Kaname's secret store; it cannot be regenerated without losing access to existing snapshots.`,
    {
      remediation: {
        summary:
          "Restore the secret from a backup of Kaname's database, or create a new schedule (a new repository) for this data.",
        actions: [{ label: "Backup schedules", href: "/backups/schedules" }],
      },
    },
  );
}

async function hasSecret(db: Database, ref: string): Promise<boolean> {
  const [row] = await db.select({ id: secrets.id }).from(secrets).where(eq(secrets.ref, ref)).limit(1);
  return Boolean(row);
}

/**
 * The schedule's repository password ref, with a password stored behind
 * it. restic always needs one, so a schedule saved with
 * `encryption: false` (no ref) could never run; it gets a generated
 * password the first time anything is queued for it. Only a schedule with
 * no ref is ever given one: no Kaname repository exists for it yet. A
 * schedule that names a ref whose secret is gone is refused, because a new
 * password would lock everyone out of the snapshots already taken. Safe
 * to call twice, or from two passes at once: an existing password is
 * never replaced.
 */
export async function ensureSchedulePassword(
  db: Database,
  masterKey: Buffer,
  schedule: { id: string; name?: string; passwordRef: string | null },
): Promise<string> {
  if (schedule.passwordRef) {
    if (!(await hasSecret(db, schedule.passwordRef))) throw passwordMissing(schedule.name);
    return schedule.passwordRef;
  }
  const ref = secretRef(schedule.id, "schedule");
  await storeSecret(db, masterKey, {
    ref,
    ownerType: "backup_schedule",
    ownerId: schedule.id,
    plaintext: generateToken(),
    overwrite: false,
  });
  await db
    .update(backupSchedules)
    .set({ passwordRef: ref })
    .where(and(eq(backupSchedules.id, schedule.id), isNull(backupSchedules.passwordRef)));
  const [row] = await db
    .select({ passwordRef: backupSchedules.passwordRef })
    .from(backupSchedules)
    .where(eq(backupSchedules.id, schedule.id))
    .limit(1);
  schedule.passwordRef = row?.passwordRef ?? ref;
  return schedule.passwordRef;
}

/* --------------------------- provisioning --------------------------- */

export interface BackupSecretDeps {
  db: Database;
  hub: AgentHub;
  masterKey: Buffer;
  signal?: AbortSignal;
}

export interface ProvisionOutcome {
  /** The ref to send as `password_ref` to every restic verb. */
  ref: string;
  /** The server the schedule backs up: the secret's long-term home. */
  scheduleServerId: string;
  /** Something the operator should know (credentials missing). Never contains a value. */
  warning?: string;
}

export const AGENT_TOO_OLD =
  "This host's agent is too old to receive backup credentials; upgrade the agent (kanamed) and retry.";

/** Everything a `backup.secret_put` needs, opened from the secrets table. */
interface PreparedSecret {
  /** The stored ref in the agent's form: the schedule's home ref. */
  ref: string;
  password: string;
  env: ResticEnv;
  scheduleId: string;
  scheduleName: string;
  scheduleServerId: string;
  warning?: string;
}

/**
 * Opens a schedule's repository password and its destination's
 * credentials. A schedule with no password ref at all gets a generated
 * password (see ensureSchedulePassword); one whose ref has no stored
 * secret is refused. A remote destination with no stored credentials
 * yields the password alone, and says so: restic will then report the
 * authentication failure itself.
 */
async function prepareBackupSecret(deps: BackupSecretDeps, storedRef: string): Promise<PreparedSecret> {
  const scheduleId = scheduleIdFromRef(storedRef);

  const [schedule] = await deps.db
    .select()
    .from(backupSchedules)
    .where(eq(backupSchedules.id, scheduleId))
    .limit(1);
  if (!schedule) {
    throw new ApiException(
      "precondition_failed",
      "The backup schedule this job belongs to no longer exists, so Kaname has no credentials to hand the host.",
    );
  }
  const [destination] = await deps.db
    .select()
    .from(backupDestinations)
    .where(eq(backupDestinations.id, schedule.destinationId))
    .limit(1);
  if (!destination) {
    throw new ApiException(
      "precondition_failed",
      `Schedule "${schedule.name}" points at a destination that no longer exists.`,
    );
  }

  const target = await readDestinationTarget(deps.db, deps.masterKey, destination);
  // Refused before anything is opened: an SFTP key is not ours to place.
  if (destination.kind === "sftp" || target?.kind === "sftp") throw sftpUnsupported();

  // Generated only for a schedule that never had a password.
  if (!schedule.passwordRef) await ensureSchedulePassword(deps.db, deps.masterKey, schedule);
  const password = await readSecret(deps.db, deps.masterKey, storedRef);
  if (password === null) throw passwordMissing(schedule.name);
  const warning =
    !target && destination.kind !== "local"
      ? `"${destination.name}" has no stored credentials; send its target again to store them.`
      : undefined;
  return {
    ref: agentSecretRef(storedRef),
    password,
    env: target ? resticEnvFor(target) : {},
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    scheduleServerId: schedule.serverId,
    ...(warning ? { warning } : {}),
  };
}

async function putBackupSecret(
  deps: BackupSecretDeps,
  serverId: string,
  ref: string,
  prepared: PreparedSecret,
): Promise<void> {
  try {
    await deps.hub.call(
      serverId,
      "backup.secret_put",
      { ref, password: prepared.password, env: prepared.env },
      { signal: deps.signal },
    );
  } catch (err) {
    throw agentSecretError(err);
  }
}

/**
 * Hands a schedule's repository password and its destination's
 * credentials to a host, under the agent-safe form of `storedRef` (the
 * schedule's home ref).
 */
export async function provisionBackupSecret(
  deps: BackupSecretDeps,
  serverId: string,
  storedRef: string,
): Promise<ProvisionOutcome> {
  const prepared = await prepareBackupSecret(deps, storedRef);
  await putBackupSecret(deps, serverId, prepared.ref, prepared);
  return {
    ref: prepared.ref,
    scheduleServerId: prepared.scheduleServerId,
    ...(prepared.warning ? { warning: prepared.warning } : {}),
  };
}

/** Removes a backup secret from a host. */
export async function removeBackupSecret(
  deps: BackupSecretDeps,
  serverId: string,
  storedRef: string,
): Promise<{ ref: string; removed: boolean }> {
  try {
    return await deps.hub.call(
      serverId,
      "backup.secret_delete",
      { ref: agentSecretRef(storedRef) },
      { signal: deps.signal },
    );
  } catch (err) {
    throw agentSecretError(err);
  }
}

/** An agent that predates the secret verbs answers unknown_method; say what to do. */
function agentSecretError(err: unknown): unknown {
  if (err instanceof AgentRpcError && err.agentError.code === "unknown_method") {
    return new ApiException("precondition_failed", AGENT_TOO_OLD, {
      remediation: {
        summary: "Update the agent on this server, then run the backup again.",
        actions: [{ label: "Updates", href: "/administration/updates" }],
      },
    });
  }
  return err;
}

/* ------------------------------ in jobs ----------------------------- */

/**
 * The stored ref a job should use. Jobs queued before every enqueue point
 * ensured a password could carry `""`; their schedule is found from the
 * run or restore point they act on, and given a password then.
 */
export async function storedRefForJob(
  ctx: Pick<JobContext, "db" | "config" | "job">,
  given: string | undefined,
  scheduleId?: string | null,
): Promise<string> {
  if (given) return given;
  let id = scheduleId ?? null;
  if (!id && ctx.job.targetType === "restore_point" && ctx.job.targetId) {
    const [point] = await ctx.db
      .select({ scheduleId: restorePoints.scheduleId })
      .from(restorePoints)
      .where(eq(restorePoints.id, ctx.job.targetId))
      .limit(1);
    id = point?.scheduleId ?? null;
  }
  const [schedule] = id
    ? await ctx.db.select().from(backupSchedules).where(eq(backupSchedules.id, id)).limit(1)
    : [];
  if (!schedule) {
    throw new ApiException(
      "precondition_failed",
      "This backup job names no repository password and no schedule to take one from.",
    );
  }
  return ensureSchedulePassword(ctx.db, ctx.config.masterKey, schedule);
}

/**
 * The agent ref a job on a host that is not the schedule's own uses: the
 * home ref plus the job's id, so two restores onto the same host at once
 * never remove each other's secret. Fits the agent's ref rules (66 of
 * `[A-Za-z0-9._-]`, starts with a letter, does not end in `.env`).
 */
export function foreignAgentRef(homeRef: string, jobId: string): string {
  return `${homeRef}.j${jobId.replaceAll("-", "").slice(0, 12).toLowerCase()}`;
}

/**
 * Provisions once for a job, on the job's own server. On the schedule's
 * own server the secret is put under its home ref and stays there for the
 * next job. On any other host (a restore elsewhere) it goes under a ref
 * unique to this job, and `cleanup` removes it again; that removal is
 * also tried when the put itself failed or timed out, and when it cannot
 * be done now a `backup.unprovision` job is queued for that host and ref
 * (its params hold the ref only).
 */
export async function provisionForJob(
  ctx: Pick<JobContext, "db" | "hub" | "config" | "job" | "signal" | "log_" | "queue" | "events">,
  serverId: string,
  storedRef: string,
): Promise<{ ref: string; cleanup: () => Promise<void> }> {
  const deps: BackupSecretDeps = {
    db: ctx.db,
    hub: ctx.hub,
    masterKey: ctx.config.masterKey,
    signal: ctx.signal,
  };
  const prepared = await prepareBackupSecret(deps, storedRef);
  const foreign = prepared.scheduleServerId !== serverId;
  const ref = foreign ? foreignAgentRef(prepared.ref, ctx.job.id) : prepared.ref;

  const cleanup = async () => {
    if (!foreign) return;
    try {
      // Not the job's signal: a cancelled restore still cleans up.
      await removeBackupSecret({ ...deps, signal: undefined }, serverId, ref);
      await ctx.log_("info", "backup credentials removed from this host again");
    } catch (err) {
      const reason =
        err instanceof AgentRpcError
          ? err.agentError.code
          : err instanceof Error
            ? err.message
            : "unknown error";
      await ctx.log_("warn", `could not remove the backup credentials from this host (${reason})`);
      await queueForeignUnprovision(ctx, serverId, ref, prepared);
    }
  };

  try {
    await putBackupSecret(deps, serverId, ref, prepared);
  } catch (err) {
    // A put that failed or timed out may still have landed. An agent too
    // old for the secret verbs has nothing to remove.
    const tooOld = err instanceof ApiException && err.message === AGENT_TOO_OLD;
    if (!tooOld) await cleanup();
    throw err;
  }
  await ctx.log_("info", "backup credentials handed to the host");
  if (prepared.warning) await ctx.log_("warn", prepared.warning);
  return { ref, cleanup };
}

/** Leaves the removal of a foreign host's secret to a job of its own. */
async function queueForeignUnprovision(
  ctx: Pick<JobContext, "hub" | "job" | "log_" | "queue" | "events">,
  serverId: string,
  ref: string,
  prepared: PreparedSecret,
): Promise<void> {
  try {
    const job = await ctx.queue.enqueue({
      type: "backup.unprovision",
      serverId,
      targetType: "backup_schedule",
      targetId: prepared.scheduleId,
      targetLabel: prepared.scheduleName,
      params: { ref },
      parentId: ctx.job.id,
      createdByName: "backup credential cleanup",
      blockedReason: ctx.hub.isConnected(serverId) ? null : "agent_offline",
    });
    ctx.events.publish("jobs", "job.queued", job, serverId);
    await ctx.log_("info", `queued job ${job.id} to remove them later`);
  } catch (err) {
    await ctx.log_(
      "error",
      `could not queue their removal either (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
}
