import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { and, desc, eq, gte, inArray, sql } from "@kaname/db";
import { backupRuns, servers, settings, updateRuns } from "@kaname/db/schema";
import {
  compareVersions,
  mayApplyUnattended,
  releaseManifest,
  selectUpgrade,
  versionStep,
  type AgentVersionRow,
  type Release,
  type ReleaseChannel,
  type ReleaseManifest,
  type UpdateCheckInterval,
  type UpdateOverview,
  type UpdateRun,
  type UpdateTier,
} from "@kaname/contract";
import { ApiException } from "../lib/errors.js";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * Updates.
 *
 * Two very different problems share this file. A fleet of agents is the
 * easy one: an agent update is an ordinary job, tracked per host, and a
 * host that goes quiet mid-update is a state an operator has to
 * acknowledge rather than a silent failure.
 *
 * The control plane updating itself is the hard one, because the process
 * running the update is the process being replaced. The sequence is
 * therefore split in half at the restart: everything reversible happens
 * while this process is alive, the restart is handed to a unit on the
 * host that outlives it, and the half that can only be judged afterwards
 * — did it come back, did a migration run — is finished by whichever
 * build boots next. That is what `reconcile()` is for, and it is why a
 * pending run is written to the database before the handover rather than
 * held in memory.
 * ------------------------------------------------------------------ */

const POLICY_KEY = "updates";
const PENDING_KEY = "updates.pending";

/** A backup older than this does not count as cover for an upgrade. */
const BACKUP_MAX_AGE_HOURS = 24;

const INTERVAL_MS: Record<UpdateCheckInterval, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

export interface UpdatePolicy {
  tier: UpdateTier;
  interval: UpdateCheckInterval;
  channel: ReleaseChannel;
  manifest_url: string;
  last_checked_at: string | null;
  last_check_error: string | null;
}

/**
 * Written before the restart and read by whatever boots next. Without
 * it the new process would have no way to tell "the update worked" from
 * "someone restarted the container by hand".
 */
interface PendingRun {
  run_id: string;
  from_version: string;
  to_version: string;
  snapshot_dir: string;
  log_file: string;
  migrations_before: number;
  breaking: boolean;
  started_at: string;
}

/* ------------------------------------------------------------------ *
 * Dispatch
 *
 * The restart cannot be run from inside the container being restarted:
 * `docker compose up -d` recreates it, and the shell waiting on the
 * health check dies with it — taking the rollback branch with it. So the
 * control plane does not run Docker at all. It writes a request that a
 * host-side unit installed by install.sh picks up, and that unit is what
 * pulls, restarts, verifies and rolls back.
 *
 * Injectable so the sequence is testable, and so an instance deployed
 * some other way can say so out loud instead of half-applying an update.
 * ------------------------------------------------------------------ */

export interface UpdateRequest {
  run_id: string;
  from_version: string;
  to_version: string;
  project: string;
  data_dir: string;
  snapshot_dir: string;
  log_file: string;
  images: { control_plane: string; web: string };
}

export interface UpdateDispatcher {
  /** Whether a host-side updater is installed and watching for requests. */
  available(dataDir: string): boolean;
  dispatch(request: UpdateRequest): Promise<void>;
}

/**
 * The real one: a file in a directory install.sh creates and a systemd
 * path unit watches. Writing it is the whole handoff.
 */
export const fileDispatcher: UpdateDispatcher = {
  available(dataDir) {
    return existsSync(join(dataDir, "updates", "queue"));
  },

  dispatch(request) {
    const dir = join(request.data_dir, "updates", "queue");
    mkdirSync(dir, { recursive: true });
    // Written to a temporary name and renamed, so the watcher never sees
    // half a request.
    const target = join(dir, "request.json");
    const staging = `${target}.partial`;
    writeFileSync(staging, JSON.stringify(request, null, 2), { mode: 0o600 });
    renameSync(staging, target);
    return Promise.resolve();
  },
};

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export interface UpdateServiceDeps {
  dispatcher?: UpdateDispatcher;
  fetch?: typeof globalThis.fetch;
}

export class UpdateService {
  private readonly dispatcher: UpdateDispatcher;
  private readonly fetchImpl: typeof globalThis.fetch;
  private manifest: ReleaseManifest | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    deps: UpdateServiceDeps = {},
  ) {
    this.dispatcher = deps.dispatcher ?? fileDispatcher;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  get currentVersion(): string {
    return this.ctx.config.KANAME_VERSION;
  }

  /* ----------------------------- policy ---------------------------- */

  async loadPolicy(): Promise<UpdatePolicy> {
    const rows = await this.ctx.db.select().from(settings).where(eq(settings.key, POLICY_KEY));
    const stored = (rows[0]?.value ?? {}) as Partial<UpdatePolicy>;
    return {
      tier: stored.tier ?? "notify",
      interval: stored.interval ?? "daily",
      channel: stored.channel ?? "stable",
      manifest_url: stored.manifest_url ?? this.ctx.config.manifestUrl,
      last_checked_at: stored.last_checked_at ?? null,
      last_check_error: stored.last_check_error ?? null,
    };
  }

  async savePolicy(patch: Partial<UpdatePolicy>): Promise<UpdatePolicy> {
    const next = { ...(await this.loadPolicy()), ...patch };
    await this.ctx.db
      .insert(settings)
      .values({ key: POLICY_KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    return next;
  }

  /* ---------------------------- scheduler --------------------------- */

  start(): void {
    if (this.timer) return;
    // One coarse tick; the policy decides whether this tick is due, so
    // changing the interval takes effect without rescheduling anything.
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      const policy = await this.loadPolicy();
      if (policy.tier === "off") return;

      const due =
        !policy.last_checked_at ||
        Date.now() - Date.parse(policy.last_checked_at) >= INTERVAL_MS[policy.interval];
      if (!due) return;

      await this.checkNow({ auto: true });
    } catch (err) {
      this.ctx.log.warn({ err }, "scheduled update check failed");
    }
  }

  /* ------------------------------ check ----------------------------- */

  async checkNow(opts: { auto?: boolean } = {}): Promise<{
    policy: UpdatePolicy;
    pending: Release | null;
  }> {
    const policy = await this.loadPolicy();

    let manifest: ReleaseManifest;
    try {
      manifest = await this.fetchManifest(policy.manifest_url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed check is state, not a swallowed exception: an instance
      // that has silently stopped checking looks identical to one that is
      // up to date, which is the failure nobody notices.
      const saved = await this.savePolicy({
        last_checked_at: new Date().toISOString(),
        last_check_error: message,
      });
      this.ctx.events.publish("updates", "update.check_failed", { error: message });
      return { policy: saved, pending: null };
    }

    this.manifest = manifest;
    const saved = await this.savePolicy({
      last_checked_at: new Date().toISOString(),
      last_check_error: null,
    });

    const pending = selectUpgrade(this.currentVersion, manifest, saved.channel);
    if (!pending) return { policy: saved, pending: null };

    this.ctx.events.publish("updates", "update.available", {
      version: pending.version,
      breaking: pending.breaking,
      security: pending.security,
      requires_confirmation: requiresConfirmation(pending),
    });

    if (opts.auto && mayApplyUnattended(saved.tier, this.currentVersion, pending)) {
      this.ctx.log.info({ version: pending.version }, "applying update unattended");
      await this.applyControlPlane({
        toVersion: pending.version,
        confirmBreaking: false,
        skipBackupCheck: false,
        trigger: "scheduled",
        actor: null,
      }).catch((err) => this.ctx.log.error({ err }, "unattended update refused"));
    }

    return { policy: saved, pending };
  }

  async fetchManifest(url: string): Promise<ReleaseManifest> {
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`the release manifest at ${url} answered ${response.status}`);
    }
    const parsed = releaseManifest.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(`the release manifest at ${url} is not in a shape this version understands`);
    }
    return parsed.data;
  }

  /** Cached manifest, fetched once if the scheduler has not run yet. */
  private async manifestOrFetch(policy: UpdatePolicy): Promise<ReleaseManifest> {
    if (this.manifest) return this.manifest;
    this.manifest = await this.fetchManifest(policy.manifest_url);
    return this.manifest;
  }

  /* ---------------------------- overview ---------------------------- */

  async overview(): Promise<UpdateOverview> {
    const policy = await this.loadPolicy();
    let pending: Release | null = null;
    // Only about the release itself. A failed check is reported on its
    // own row; saying it twice reads like two different problems.
    let blocked: string | null = null;

    if (this.manifest) {
      pending = selectUpgrade(this.currentVersion, this.manifest, policy.channel);
    }
    if (
      pending?.min_upgrade_from &&
      compareVersions(this.currentVersion, pending.min_upgrade_from) < 0
    ) {
      blocked = `${pending.version} can only be applied from ${pending.min_upgrade_from} or later. Upgrade to ${pending.min_upgrade_from} first.`;
    }

    const [controlRun] = await this.ctx.db
      .select()
      .from(updateRuns)
      .where(eq(updateRuns.kind, "control_plane"))
      .orderBy(desc(updateRuns.createdAt))
      .limit(1);

    return {
      control_plane: {
        current_version: this.currentVersion,
        latest_version: pending?.version ?? null,
        update_available: Boolean(pending),
        requires_confirmation: pending ? requiresConfirmation(pending) : false,
        blocked_reason: blocked,
        pending,
        run: controlRun ? toApiRun(controlRun, null) : null,
      },
      agents: await this.agentRows(pending),
      settings: {
        tier: policy.tier,
        interval: policy.interval,
        channel: policy.channel,
        manifest_url: policy.manifest_url,
        last_checked_at: policy.last_checked_at,
        last_check_error: policy.last_check_error,
        next_check_at: policy.last_checked_at
          ? new Date(
              Date.parse(policy.last_checked_at) + INTERVAL_MS[policy.interval],
            ).toISOString()
          : null,
      },
    };
  }

  private async agentRows(pending: Release | null): Promise<AgentVersionRow[]> {
    const rows = await this.ctx.db.select().from(servers).orderBy(servers.name);
    if (rows.length === 0) return [];

    const runRows = await this.ctx.db
      .select()
      .from(updateRuns)
      .where(
        and(
          eq(updateRuns.kind, "agent"),
          inArray(
            updateRuns.serverId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(updateRuns.createdAt));

    const latest = new Map<string, (typeof runRows)[number]>();
    for (const run of runRows) {
      if (run.serverId && !latest.has(run.serverId)) latest.set(run.serverId, run);
    }

    const target = pending?.version ?? this.currentVersion;
    return rows.map((row) => {
      const run = row.id ? latest.get(row.id) : undefined;
      return {
        server_id: row.id,
        server_name: row.name,
        hostname: row.hostname,
        connection: this.ctx.hub.isConnected(row.id) ? "connected" : row.connection,
        agent_version: row.agentVersion,
        last_seen_at: row.lastSeenAt?.toISOString() ?? null,
        up_to_date: Boolean(row.agentVersion) && compareVersions(row.agentVersion!, target) >= 0,
        run: run ? toApiRun(run, row.name) : null,
      };
    });
  }

  /* ------------------------ control-plane apply --------------------- */

  async applyControlPlane(input: {
    toVersion: string;
    confirmBreaking: boolean;
    skipBackupCheck: boolean;
    trigger: "manual" | "scheduled" | "onboarding";
    actor: { id: string; name: string } | null;
  }): Promise<UpdateRun> {
    const policy = await this.loadPolicy();
    const manifest = await this.manifestOrFetch(policy);
    const release = manifest.releases.find((r) => r.version === input.toVersion);
    if (!release) throw unknownRelease(input.toVersion, policy.manifest_url);

    if (compareVersions(this.currentVersion, release.version) >= 0) {
      throw new ApiException(
        "conflict",
        `This instance is already running ${this.currentVersion}.`,
        {
          remediation: { summary: "There is nothing to apply.", actions: [] },
        },
      );
    }
    if (
      release.min_upgrade_from &&
      compareVersions(this.currentVersion, release.min_upgrade_from) < 0
    ) {
      throw stepThroughRequired(this.currentVersion, release);
    }

    // The hard rule (spec 3.6). It is checked here, at the boundary,
    // before the tier is ever consulted — a breaking release cannot
    // reach the sequence below without a human having said so.
    if (requiresConfirmation(release) && !input.confirmBreaking) {
      throw confirmationRequired(release);
    }
    if (this.ctx.config.deployment !== "compose") {
      throw notComposeManaged();
    }
    if (!this.dispatcher.available(this.ctx.config.dataDir)) {
      throw updaterMissing(this.ctx.config.dataDir);
    }

    if (!input.skipBackupCheck) await this.assertRecentBackup();

    const run = await this.createRun({
      kind: "control_plane",
      serverId: null,
      fromVersion: this.currentVersion,
      toVersion: release.version,
      trigger: input.trigger,
      breaking: requiresConfirmation(release),
      actor: input.actor,
    });

    if (input.skipBackupCheck) {
      await this.ctx.audit.record({
        actor: {
          type: "user",
          id: input.actor?.id ?? null,
          name: input.actor?.name ?? "system",
        },
        action: "update.backup_check_skipped",
        targetType: "update_run",
        targetId: run.id,
        targetLabel: release.version,
        metadata: { from: this.currentVersion, to: release.version },
      });
    }

    // Deliberately not awaited: the caller gets the run row immediately
    // and follows it, and the sequence has to survive them navigating
    // away or losing the connection.
    void this.executeControlPlane(run.id, release).catch(async (err) => {
      await this.failRun(run.id, err instanceof Error ? err.message : String(err));
    });

    return toApiRun(run, null);
  }

  private async executeControlPlane(runId: string, release: Release): Promise<void> {
    const dataDir = this.ctx.config.dataDir;
    const project = this.ctx.config.KANAME_COMPOSE_PROJECT;
    const snapshotDir = join(dataDir, "rollback", runId);
    const logFile = join(dataDir, "updates", `${runId}.log`);
    const envFile = join(dataDir, ".env");

    mkdirSync(snapshotDir, { recursive: true });
    mkdirSync(join(dataDir, "updates"), { recursive: true });

    await this.append(runId, `==> updating the control plane to ${release.version}`);
    await this.setStatus(runId, "running");

    /* 1. snapshot what we are about to change, so there is a way back. */
    if (!existsSync(envFile)) {
      throw new Error(
        `no environment file at ${envFile}. This instance was not deployed by install.sh, so there is nothing safe to roll back to.`,
      );
    }
    copyFileSync(envFile, join(snapshotDir, ".env"));
    writeFileSync(
      join(snapshotDir, "images.json"),
      JSON.stringify({ version: this.currentVersion, taken_at: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    await this.append(runId, `--> snapshot written to ${snapshotDir}`);

    /* 2. add the keys this release declares it needs (KD-028). */
    const added = mergeEnv(envFile, release.migrations.adds_config, release.version);
    await this.append(
      runId,
      added.length > 0
        ? `--> added ${added.length} configuration key(s): ${added.join(", ")}`
        : "--> configuration needs no new keys",
    );

    /* 3. point the deployment at the new images. These three are ours,
     *    so they are replaced rather than merged. */
    setEnv(envFile, {
      KANAME_VERSION: release.version,
      KANAME_IMAGE_CONTROL_PLANE: release.artifacts.control_plane,
      KANAME_IMAGE_WEB: release.artifacts.web,
    });
    await this.append(runId, `--> pinned to ${release.artifacts.control_plane}`);

    /* 4. record the migration state so the next boot can tell whether
     *    the new build migrated before it failed. */
    const migrationsBefore = await this.countMigrations();
    await this.append(runId, `--> ${migrationsBefore} migration(s) applied before this upgrade`);

    await this.writePending({
      run_id: runId,
      from_version: this.currentVersion,
      to_version: release.version,
      snapshot_dir: snapshotDir,
      log_file: logFile,
      migrations_before: migrationsBefore,
      breaking: requiresConfirmation(release),
      started_at: new Date().toISOString(),
    });

    /* 5. hand the rest to the host. It pulls, restarts, verifies and —
     *    if the new build does not answer — puts the snapshot back. */
    await this.append(
      runId,
      `--> handing over to the host updater; this process is about to be replaced`,
    );
    await this.dispatcher.dispatch({
      run_id: runId,
      from_version: this.currentVersion,
      to_version: release.version,
      project,
      data_dir: dataDir,
      snapshot_dir: snapshotDir,
      log_file: logFile,
      images: { control_plane: release.artifacts.control_plane, web: release.artifacts.web },
    });
  }

  /* ---------------------------- reconcile --------------------------- */

  /**
   * Finishes an update the previous process could not: it was replaced
   * by the restart it started. Runs at boot, before anything is served.
   */
  async reconcile(): Promise<void> {
    const pending = await this.readPending();

    if (!pending) {
      // A run left `running` with no pending record means the process
      // died somewhere it should not have. That is not a failure we can
      // characterise, so it is one an operator has to look at.
      const orphans = await this.ctx.db
        .select()
        .from(updateRuns)
        .where(and(eq(updateRuns.kind, "control_plane"), eq(updateRuns.status, "running")));
      for (const run of orphans) {
        await this.append(run.id, "!! the control plane restarted without finishing this update");
        await this.finishRun(
          run.id,
          "needs_attention",
          "Interrupted before the restart completed.",
        );
      }
      return;
    }

    const detached = readIfPresent(pending.log_file);
    if (detached) await this.append(pending.run_id, detached);

    const migrationsNow = await this.countMigrations();
    const migrated = migrationsNow > pending.migrations_before;

    if (this.currentVersion === pending.to_version) {
      await this.append(pending.run_id, `==> ${pending.to_version} is up and answering`);
      await this.finishRun(pending.run_id, "succeeded", null);
      this.ctx.events.publish("updates", "update.succeeded", { version: pending.to_version });
    } else if (migrated) {
      // The new build migrated the database and then failed to stay up,
      // and the old build is now running against a schema it does not
      // know. Restoring the image silently would hide that.
      await this.append(
        pending.run_id,
        `!! ${migrationsNow - pending.migrations_before} migration(s) from ${pending.to_version} were applied before it failed. ` +
          `The previous version is running against a migrated database; restore the backup taken before this upgrade, or move forward to ${pending.to_version}.`,
      );
      await this.finishRun(
        pending.run_id,
        "needs_attention",
        `Migrations from ${pending.to_version} ran, but ${this.currentVersion} is what came back up.`,
      );
      this.ctx.events.publish("updates", "update.needs_attention", { version: pending.to_version });
    } else {
      await this.append(
        pending.run_id,
        `!! ${pending.to_version} did not come up; ${this.currentVersion} was restored from ${pending.snapshot_dir}`,
      );
      await this.finishRun(
        pending.run_id,
        "rolled_back",
        `${pending.to_version} failed its health check.`,
      );
      this.ctx.events.publish("updates", "update.rolled_back", { version: pending.to_version });
    }

    await this.clearPending();
  }

  /* --------------------------- agent fleet -------------------------- */

  /** The artifact for one host, or a specific reason there is none. */
  releaseArtifactFor(release: Release, arch: string | null): { url: string; sha256: string } {
    const key = `linux-${arch ?? "amd64"}`;
    const artifact = release.artifacts.agent[key];
    if (!artifact) {
      throw new ApiException(
        "precondition_failed",
        `Release ${release.version} publishes no agent binary for ${key}.`,
        {
          remediation: {
            summary: `Available builds: ${Object.keys(release.artifacts.agent).join(", ") || "none"}.`,
            actions: [],
          },
        },
      );
    }
    return artifact;
  }

  async releaseFor(version: string): Promise<Release> {
    const policy = await this.loadPolicy();
    const manifest = await this.manifestOrFetch(policy);
    const release = manifest.releases.find((r) => r.version === version);
    if (!release) throw unknownRelease(version, policy.manifest_url);
    return release;
  }

  /* ------------------------------ runs ------------------------------ */

  async createRun(input: {
    kind: "control_plane" | "agent";
    serverId: string | null;
    serverName?: string | null;
    fromVersion: string;
    toVersion: string;
    trigger: "manual" | "scheduled" | "onboarding";
    breaking: boolean;
    actor: { id: string; name: string } | null;
    jobId?: string | null;
  }): Promise<typeof updateRuns.$inferSelect> {
    const [row] = await this.ctx.db
      .insert(updateRuns)
      .values({
        kind: input.kind,
        serverId: input.serverId,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        status: input.kind === "agent" ? "queued" : "running",
        trigger: input.trigger,
        breaking: input.breaking,
        startedAt: new Date(),
        jobId: input.jobId ?? null,
        startedBy: input.actor?.id ?? null,
        startedByName: input.actor?.name ?? "system",
      })
      .returning();
    this.ctx.events.publish("updates", "update.started", {
      run_id: row!.id,
      kind: input.kind,
      server_id: input.serverId,
      to_version: input.toVersion,
    });
    return row!;
  }

  /** Appends to the run's log immediately, not at the end (spec 3.3.8). */
  async append(runId: string, text: string): Promise<void> {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    await this.ctx.db
      .update(updateRuns)
      .set({ log: sql`${updateRuns.log} || ${line}`, updatedAt: new Date() })
      .where(eq(updateRuns.id, runId));
    this.ctx.events.publish("updates", "update.log", { run_id: runId, line: line.trimEnd() });
  }

  async setStatus(runId: string, status: UpdateRun["status"]): Promise<void> {
    await this.ctx.db
      .update(updateRuns)
      .set({ status, updatedAt: new Date() })
      .where(eq(updateRuns.id, runId));
    this.ctx.events.publish("updates", "update.status", { run_id: runId, status });
  }

  async finishRun(runId: string, status: UpdateRun["status"], error: string | null): Promise<void> {
    const [row] = await this.ctx.db
      .select()
      .from(updateRuns)
      .where(eq(updateRuns.id, runId))
      .limit(1);
    const startedAt = row?.startedAt ?? row?.createdAt ?? new Date();
    const finishedAt = new Date();

    await this.ctx.db
      .update(updateRuns)
      .set({
        status,
        error,
        rolledBack: status === "rolled_back",
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        updatedAt: finishedAt,
      })
      .where(eq(updateRuns.id, runId));

    this.ctx.events.publish("updates", "update.finished", { run_id: runId, status });
  }

  async failRun(runId: string, message: string): Promise<void> {
    await this.append(runId, `!! ${message}`);
    await this.finishRun(runId, "failed", message);
  }

  /* ----------------------------- helpers ---------------------------- */

  private async assertRecentBackup(): Promise<void> {
    const since = new Date(Date.now() - BACKUP_MAX_AGE_HOURS * 60 * 60_000);
    const rows = await this.ctx.db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(and(eq(backupRuns.status, "succeeded"), gte(backupRuns.finishedAt, since)))
      .limit(1);
    if (rows.length > 0) return;

    throw new ApiException(
      "precondition_failed",
      `No backup has succeeded in the last ${BACKUP_MAX_AGE_HOURS} hours.`,
      {
        remediation: {
          summary:
            "An upgrade that migrates the database is far easier to undo with a backup taken minutes before it. Run one now, or apply the update with the backup check explicitly skipped — that choice is written to the audit trail.",
          actions: [{ label: "Backups", href: "/backups" }],
        },
      },
    );
  }

  /**
   * How many migrations the database has applied. Drizzle keeps this in
   * its own schema; a database that has never been migrated by drizzle
   * answers zero rather than throwing.
   */
  private async countMigrations(): Promise<number> {
    try {
      const result = await this.ctx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      );
      const rows =
        (result as unknown as { rows?: { n: number }[] }).rows ??
        (result as unknown as { n: number }[]);
      return Number(rows?.[0]?.n ?? 0);
    } catch {
      return 0;
    }
  }

  private async writePending(pending: PendingRun): Promise<void> {
    await this.ctx.db
      .insert(settings)
      .values({ key: PENDING_KEY, value: pending })
      .onConflictDoUpdate({ target: settings.key, set: { value: pending, updatedAt: new Date() } });
  }

  private async readPending(): Promise<PendingRun | null> {
    const rows = await this.ctx.db.select().from(settings).where(eq(settings.key, PENDING_KEY));
    const value = rows[0]?.value as PendingRun | undefined;
    return value?.run_id ? value : null;
  }

  private async clearPending(): Promise<void> {
    await this.ctx.db.delete(settings).where(eq(settings.key, PENDING_KEY));
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Breaking OR destructively migrating: both always ask (spec 3.6). */
export function requiresConfirmation(release: Release): boolean {
  return release.breaking || release.migrations.destructive;
}

export function toApiRun(
  row: typeof updateRuns.$inferSelect,
  serverName: string | null,
): UpdateRun {
  return {
    id: row.id,
    kind: row.kind,
    server_id: row.serverId,
    server_name: serverName,
    from_version: row.fromVersion,
    to_version: row.toVersion,
    status: row.status,
    trigger: row.trigger,
    breaking: row.breaking,
    started_at: row.startedAt?.toISOString() ?? null,
    finished_at: row.finishedAt?.toISOString() ?? null,
    duration_ms: row.durationMs,
    error: row.error,
    log: row.log,
    job_id: row.jobId,
    started_by: row.startedBy,
    started_by_name: row.startedByName,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Adds the keys a release declares it needs and nothing else. A
 * heuristic diff of two example files would eventually rewrite a value
 * an operator set on purpose, so the release names its keys and an
 * existing value always wins (KD-028).
 */
export function mergeEnv(envFile: string, declared: string[], version: string): string[] {
  const source = readFileSync(envFile, "utf8");
  const present = new Set(
    source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.slice(0, line.indexOf("=")).trim())
      .filter(Boolean),
  );

  const additions = declared.filter((key) => !present.has(key));
  if (additions.length === 0) return [];

  const lines = [``, `# added by the upgrade to ${version}`];
  for (const key of additions) lines.push(`${key}=${defaultValueFor(key)}`);

  writeFileSync(envFile, `${source.replace(/\n+$/, "")}\n${lines.join("\n")}\n`, { mode: 0o600 });
  return additions;
}

/**
 * A new key that is obviously a secret gets a real one rather than a
 * placeholder — an install that ships with a blank secret is an install
 * with a known secret.
 */
function defaultValueFor(key: string): string {
  return /_(KEY|SECRET|PASSWORD|TOKEN)$/.test(key) ? randomBytes(32).toString("base64") : "";
}

/**
 * Replaces values Kaname owns. Unlike `mergeEnv` these are not the
 * operator's to keep: the image tags and the version are what the
 * deployment is being moved to.
 */
export function setEnv(envFile: string, values: Record<string, string>): void {
  const lines = readFileSync(envFile, "utf8").replace(/\s*$/, "").split("\n");

  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }

  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const unknownRelease = (version: string, manifestUrl: string) =>
  new ApiException("not_found", `Release ${version} is not in the manifest.`, {
    remediation: {
      summary: `Check for updates again — the manifest at ${manifestUrl} may have moved on since this page was loaded.`,
      actions: [{ label: "Check now", action: "updates.check" }],
    },
  });

const stepThroughRequired = (current: string, release: Release) =>
  new ApiException(
    "precondition_failed",
    `${release.version} cannot be applied directly from ${current}.`,
    {
      remediation: {
        summary: `It requires ${release.min_upgrade_from} or later. Apply ${release.min_upgrade_from} first, then come back to ${release.version}.`,
        actions: [],
      },
    },
  );

const confirmationRequired = (release: Release) =>
  new ApiException(
    "precondition_failed",
    `${release.version} contains ${release.breaking ? "breaking changes" : "a destructive migration"} and has to be confirmed.`,
    {
      detail: { version: release.version, step: versionStep("0.0.0", release.version) },
      remediation: {
        summary:
          "This runs real infrastructure, so a release that can break it is never applied on a schedule — whatever the update cadence is set to. Review the release notes and confirm it explicitly.",
        actions: release.notes_url ? [{ label: "Release notes", href: release.notes_url }] : [],
      },
    },
  );

const updaterMissing = (dataDir: string) =>
  new ApiException("precondition_failed", "The host-side updater is not installed.", {
    remediation: {
      summary: `A container cannot restart itself and still be there to check the result, so the restart runs on the host. Re-run install.sh on this box to install it; nothing else is changed by doing so. Expected ${dataDir}/updates/queue to exist.`,
      actions: [],
    },
  });

const notComposeManaged = () =>
  new ApiException(
    "precondition_failed",
    "This control plane does not manage its own deployment.",
    {
      remediation: {
        summary:
          "Self-update drives the Compose project that install.sh creates. This instance was started some other way, so update it however it was deployed — the agent fleet can still be updated from here.",
        actions: [],
      },
    },
  );
