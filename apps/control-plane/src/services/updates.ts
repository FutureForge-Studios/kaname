import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { and, desc, eq, gte, inArray, sql } from "@kaname/db";
import { backupRuns, jobs, servers, settings, updateRuns } from "@kaname/db/schema";
import {
  JOB_SPECS,
  TERMINAL_JOB_STATUSES,
  compareVersions,
  mayApplyUnattended,
  parseVersion,
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
 * build boots next. That is what `reconcile()` and `confirmBooted()` are
 * for, and it is why a pending run is written to the database before the
 * handover rather than held in memory.
 *
 * While the old process is still alive it does not go blind either: it
 * tails what the host helper writes and reads the helper's verdict, so a
 * pull that fails, a unit that never fires or a script that hangs ends
 * the run here rather than leaving it "running" for ever.
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

/**
 * A failed manifest fetch is retried on a doubling backoff from here,
 * capped at the check interval — never postponed by a whole interval as
 * if the check had happened.
 */
const CHECK_RETRY_BASE_MS = 15 * 60_000;

/** How often the host helper's log and verdict are read while it works. */
const HOST_POLL_MS = 5_000;
/** The path unit fires within seconds; this long with no pickup means it is not running. */
const HOST_PICKUP_TIMEOUT_MS = 2 * 60_000;
/** A pull or a health wait that writes nothing for this long has hung. */
const HOST_QUIET_TIMEOUT_MS = 30 * 60_000;
/** After a run is settled, how long to wait for the helper's closing lines before cleaning up. */
const HOST_TAIL_TIMEOUT_MS = 10 * 60_000;

/**
 * How long an agent gets to download, swap and dial back in. Mirrors
 * the handler's own window in jobs/handlers.ts; a run older than the
 * job's timeout plus this window cannot still have a handler waiting on
 * it, whatever its job row says.
 */
const AGENT_RECONNECT_WINDOW_MS = 5 * 60_000;
const AGENT_RUN_MAX_MS = JOB_SPECS["agent.update"].timeoutMs + AGENT_RECONNECT_WINDOW_MS + 60_000;

export interface UpdatePolicy {
  tier: UpdateTier;
  interval: UpdateCheckInterval;
  channel: ReleaseChannel;
  manifest_url: string;
  last_checked_at: string | null;
  last_check_error: string | null;
  /** Consecutive failed checks, for the retry backoff. */
  check_failures: number;
  retry_after: string | null;
  /**
   * The last manifest a check fetched. Persisted so "an update is
   * available" survives a restart — including the restart that rolled
   * the update back — and so tier `off` still shows what a manual check
   * found.
   */
  last_manifest: ReleaseManifest | null;
  last_apply_error: { version: string; message: string; at: string } | null;
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
  /** Bytes of `log_file` already copied into the run, so a restart does not splice them twice. */
  log_offset?: number;
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

/**
 * What the host helper is asked to do. `kind` is the first thing it
 * branches on, so a new host-side operation is a new kind rather than a
 * second queue.
 */
export type HostRequest = UpdateRequest | ReconfigureRequest;

export interface UpdateRequest {
  kind: "update";
  run_id: string;
  from_version: string;
  to_version: string;
  project: string;
  data_dir: string;
  snapshot_dir: string;
  log_file: string;
  images: { control_plane: string; web: string };
}

/**
 * Regenerate the Caddyfile from .env and recreate the containers that
 * read the address at boot. Used when the panel's domain changes.
 */
export interface ReconfigureRequest {
  kind: "reconfigure";
  project: string;
  data_dir: string;
  log_file: string;
}

export interface UpdateDispatcher {
  /** Whether a host-side helper is installed and watching for requests. */
  available(dataDir: string): boolean;
  dispatch(request: HostRequest): Promise<void>;
  /** Takes back a request the host never consumed. Optional: a fake has nothing to take back. */
  withdraw?(dataDir: string): void;
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

  withdraw(dataDir) {
    const target = join(dataDir, "updates", "queue", "request.json");
    // Both: a write that failed halfway leaves the partial, and a
    // request nobody picked up leaves the real one.
    rmSync(`${target}.partial`, { force: true });
    rmSync(target, { force: true });
  },
};

/* ------------------------------------------------------------------ *
 * The host helper's verdict
 *
 * kaname-host.sh appends one word per line to `<data-dir>/updates/<run
 * id>.result` as it goes: `picked_up` when it consumes the request, a
 * reason if something fails, and a final verdict. The reason is what
 * the run's error is written from; the verdict is what ends it.
 * ------------------------------------------------------------------ */

type HostReason = "pull_failed" | "restart_failed" | "health_failed";
type HostVerdict = "succeeded" | "rolled_back" | "rollback_failed";

interface HostOutcome {
  lines: string[];
  pickedUp: boolean;
  reason: HostReason | null;
  verdict: HostVerdict | null;
}

const HOST_REASONS: readonly HostReason[] = ["pull_failed", "restart_failed", "health_failed"];
const HOST_VERDICTS: readonly HostVerdict[] = ["succeeded", "rolled_back", "rollback_failed"];

function readOutcome(resultFile: string): HostOutcome | null {
  const text = readIfPresent(resultFile);
  if (text === null) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    lines,
    pickedUp: lines.length > 0,
    reason:
      lines.find((line): line is HostReason => (HOST_REASONS as string[]).includes(line)) ?? null,
    verdict:
      [...lines]
        .reverse()
        .find((line): line is HostVerdict => (HOST_VERDICTS as string[]).includes(line)) ?? null,
  };
}

/** The reason in words, in the run's error and in the log. */
function describeReason(reason: HostReason | null, toVersion: string): string {
  switch (reason) {
    case "pull_failed":
      return `the images for ${toVersion} could not be pulled`;
    case "restart_failed":
      return `${toVersion} did not start`;
    case "health_failed":
      return `${toVersion} did not answer on /health within the host's window`;
    default:
      return `${toVersion} failed its health check`;
  }
}

/** By convention next to the log file, named by the run: what kaname-host.sh writes. */
function resultFileFor(pending: Pick<PendingRun, "run_id" | "log_file">): string {
  return join(dirname(pending.log_file), `${pending.run_id}.result`);
}

/**
 * One handover being followed from this process. Lives in memory: if
 * this process is replaced, whatever boots next rebuilds it from the
 * pending record.
 */
interface HostWatch {
  runId: string;
  fromVersion: string;
  toVersion: string;
  logFile: string;
  resultFile: string;
  snapshotDir: string;
  /** Bytes of the log already copied into the run. */
  offset: number;
  seenLines: number;
  startedAt: number;
  lastActivityAt: number;
  /** The run is terminal; only the helper's closing lines and the cleanup remain. */
  settled: boolean;
  settledAt: number;
}

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
  private hostTimer: NodeJS.Timeout | null = null;
  private readonly watches = new Map<string, HostWatch>();
  /**
   * Two clicks, or a click and a scheduler tick, must not both get past
   * the "is one already in flight" check. In-process callers queue on
   * this; the run row and the pending record cover everything else.
   */
  private applyChain: Promise<void> = Promise.resolve();

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
      check_failures: stored.check_failures ?? 0,
      retry_after: stored.retry_after ?? null,
      last_manifest: stored.last_manifest ?? null,
      last_apply_error: stored.last_apply_error ?? null,
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
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.hostTimer = null;
  }

  private async tick(): Promise<void> {
    try {
      const policy = await this.loadPolicy();
      if (policy.tier === "off") return;
      if (!checkDue(policy, Date.now())) return;

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
    const now = new Date().toISOString();

    let manifest: ReleaseManifest;
    try {
      manifest = await this.fetchManifest(policy.manifest_url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed check is state, not a swallowed exception: an instance
      // that has silently stopped checking looks identical to one that is
      // up to date, which is the failure nobody notices. `last_checked_at`
      // is left alone — this was not a check — and the retry is soon.
      const failures = policy.check_failures + 1;
      const backoff = Math.min(
        CHECK_RETRY_BASE_MS * 2 ** (failures - 1),
        INTERVAL_MS[policy.interval],
      );
      const saved = await this.savePolicy({
        last_check_error: message,
        check_failures: failures,
        retry_after: new Date(Date.now() + backoff).toISOString(),
      });
      this.ctx.events.publish("updates", "update.check_failed", { error: message });
      return { policy: saved, pending: null };
    }

    this.manifest = manifest;
    const pending = selectUpgrade(this.currentVersion, manifest, policy.channel);
    const saved = await this.savePolicy({
      last_checked_at: now,
      last_check_error: null,
      check_failures: 0,
      retry_after: null,
      last_manifest: manifest,
      // A refusal is about one release; once the manifest moves on it
      // would be explaining something that is no longer on offer.
      last_apply_error:
        policy.last_apply_error && policy.last_apply_error.version === pending?.version
          ? policy.last_apply_error
          : null,
    });

    if (!pending) return { policy: saved, pending: null };

    this.ctx.events.publish("updates", "update.available", {
      version: pending.version,
      breaking: pending.breaking,
      security: pending.security,
      requires_confirmation: requiresConfirmation(pending),
    });

    if (opts.auto && mayApplyUnattended(saved.tier, this.currentVersion, pending)) {
      if (await this.updateInFlight()) {
        this.ctx.log.info({ version: pending.version }, "an update is in flight; not applying");
        return { policy: saved, pending };
      }
      this.ctx.log.info({ version: pending.version }, "applying update unattended");
      try {
        await this.applyControlPlane({
          toVersion: pending.version,
          confirmBreaking: false,
          skipBackupCheck: false,
          trigger: "scheduled",
          actor: null,
        });
      } catch (err) {
        await this.recordApplyRefusal(pending.version, err);
      }
    }

    return { policy: saved, pending };
  }

  /**
   * A refusal the scheduler ran into is written down where the page can
   * show it. Logged alone, "no backup in 24 hours" is indistinguishable
   * from an update system that has simply not got round to it.
   */
  private async recordApplyRefusal(version: string, err: unknown): Promise<void> {
    const message =
      err instanceof ApiException && err.remediation?.summary
        ? `${err.message} ${err.remediation.summary}`
        : err instanceof Error
          ? err.message
          : String(err);
    this.ctx.log.error({ err, version }, "unattended update refused");
    await this.savePolicy({
      last_apply_error: { version, message, at: new Date().toISOString() },
    });
    this.ctx.events.publish("updates", "update.apply_refused", { version, error: message });
    await this.ctx.audit.record({
      actor: { type: "system", id: null, name: "scheduler" },
      action: "update.unattended_refused",
      targetType: "settings",
      targetId: null,
      targetLabel: version,
      metadata: { version, error: message },
    });
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

  /**
   * The manifest this process knows: fetched by a check, or the one the
   * previous process persisted with the policy. Null only on an instance
   * that has never completed a check.
   */
  private knownManifest(policy: UpdatePolicy): ReleaseManifest | null {
    return this.manifest ?? policy.last_manifest;
  }

  /** Known manifest, fetched once if no check has ever completed. */
  private async manifestOrFetch(policy: UpdatePolicy): Promise<ReleaseManifest> {
    const known = this.knownManifest(policy);
    if (known) return known;
    this.manifest = await this.fetchManifest(policy.manifest_url);
    return this.manifest;
  }

  /* --------------------------- host helper -------------------------- */

  /**
   * Whether this instance can ask its host to do anything. False on an
   * install that did not come from install.sh, which is the difference
   * between "we will apply that" and a precondition failure that says
   * why.
   */
  hostHelperAvailable(): boolean {
    return (
      this.ctx.config.deployment === "compose" && this.dispatcher.available(this.ctx.config.dataDir)
    );
  }

  /** Queues work for the host helper. Shared with the address change. */
  dispatchHostRequest(request: HostRequest): Promise<void> {
    return this.dispatcher.dispatch(request);
  }

  /* ---------------------------- overview ---------------------------- */

  async overview(): Promise<UpdateOverview> {
    const policy = await this.loadPolicy();
    let pending: Release | null = null;
    // Only about the release itself. A failed check is reported on its
    // own row; saying it twice reads like two different problems.
    let blocked: string | null = null;

    const manifest = this.knownManifest(policy);
    if (manifest) {
      pending = selectUpgrade(this.currentVersion, manifest, policy.channel);
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
        next_check_at:
          policy.retry_after ??
          (policy.last_checked_at
            ? new Date(
                Date.parse(policy.last_checked_at) + INTERVAL_MS[policy.interval],
              ).toISOString()
            : null),
        last_apply_error: policy.last_apply_error,
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
        // A version that does not parse ("dev", an empty build stamp) is
        // never "up to date": it is the host most in need of a look.
        up_to_date:
          Boolean(row.agentVersion) &&
          parseVersion(row.agentVersion!) !== null &&
          compareVersions(row.agentVersion!, target) >= 0,
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
    const previous = this.applyChain;
    let release!: () => void;
    this.applyChain = new Promise<void>((resolve) => (release = resolve));
    try {
      await previous;
      return await this.startControlPlaneUpdate(input);
    } finally {
      release();
    }
  }

  private async startControlPlaneUpdate(input: {
    toVersion: string;
    confirmBreaking: boolean;
    skipBackupCheck: boolean;
    trigger: "manual" | "scheduled" | "onboarding";
    actor: { id: string; name: string } | null;
  }): Promise<UpdateRun> {
    // Before anything else: a second run would snapshot an .env already
    // pinned to the new images and overwrite the pending record, so the
    // rollback of the first would restore the wrong thing.
    const inFlight = await this.updateInFlight();
    if (inFlight) throw updateInProgress(inFlight);

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
    if (!this.hostHelperAvailable()) {
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

    // A refusal recorded for this release is answered by this run.
    if (policy.last_apply_error?.version === release.version) {
      await this.savePolicy({ last_apply_error: null });
    }

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

  /** The version an in-flight control-plane update is moving to, if there is one. */
  private async updateInFlight(): Promise<string | null> {
    const pending = await this.readPending();
    if (pending) return pending.to_version;
    const [running] = await this.ctx.db
      .select({ toVersion: updateRuns.toVersion })
      .from(updateRuns)
      .where(and(eq(updateRuns.kind, "control_plane"), eq(updateRuns.status, "running")))
      .limit(1);
    return running?.toVersion ?? null;
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

    // From here on .env is being changed. Whatever fails below, the
    // deployment must not be left pointing at images nobody is going to
    // health-check: the next `compose up` — a reboot, a domain change —
    // would otherwise apply the update with no rollback path at all.
    try {
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

      const pending: PendingRun = {
        run_id: runId,
        from_version: this.currentVersion,
        to_version: release.version,
        snapshot_dir: snapshotDir,
        log_file: logFile,
        migrations_before: migrationsBefore,
        breaking: requiresConfirmation(release),
        started_at: new Date().toISOString(),
        log_offset: 0,
      };
      await this.writePending(pending);

      /* 5. hand the rest to the host — only once the record the next
       *    boot judges by is safely written. It pulls, restarts, verifies
       *    and, if the new build does not answer, puts the snapshot back. */
      await this.append(
        runId,
        `--> handing over to the host updater; this process is about to be replaced`,
      );
      try {
        await this.dispatcher.dispatch({
          kind: "update",
          run_id: runId,
          from_version: this.currentVersion,
          to_version: release.version,
          project,
          data_dir: dataDir,
          snapshot_dir: snapshotDir,
          log_file: logFile,
          images: { control_plane: release.artifacts.control_plane, web: release.artifacts.web },
        });
      } catch (err) {
        this.dispatcher.withdraw?.(dataDir);
        throw err;
      }

      this.watchHost(this.watchFor(pending));
    } catch (err) {
      copyFileSync(join(snapshotDir, ".env"), envFile);
      await this.clearPending();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message}; the configuration was restored from ${snapshotDir}`);
    }
  }

  /* ---------------------------- reconcile --------------------------- */

  /**
   * Phase one of finishing an update the previous process could not: it
   * was replaced by the restart it started. Runs at boot, before
   * anything is served, and only judges what the OLD build coming back
   * proves — the new build being up is not known until it is listening,
   * which is `confirmBooted()`.
   */
  async reconcile(): Promise<void> {
    await this.settleOrphanAgentRuns();

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

    // What the helper wrote while no control plane was there to see it.
    const watch = this.watchFor(pending);
    await this.tailLog(watch, true);

    if (this.currentVersion === pending.to_version) {
      // This is the new build. Booting is not the same as serving: if
      // listen() fails, the host rolls back and the old build judges
      // this record — with the migration count — instead.
      return;
    }

    const outcome = readOutcome(watch.resultFile);
    const migrationsNow = await this.countMigrations();
    const migrated = migrationsNow > pending.migrations_before;

    if (migrated) {
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
      const reason = describeReason(outcome?.reason ?? null, pending.to_version);
      await this.append(
        pending.run_id,
        `!! ${reason}; ${this.currentVersion} was restored from ${pending.snapshot_dir}`,
      );
      // A pull that failed stopped nothing, so nothing was rolled back.
      const status = outcome?.reason === "pull_failed" ? "failed" : "rolled_back";
      await this.finishRun(
        pending.run_id,
        status,
        `${capitalize(reason)}; ${this.currentVersion} was restored.`,
      );
      if (status === "rolled_back") {
        this.ctx.events.publish("updates", "update.rolled_back", { version: pending.to_version });
      }
    }

    await this.clearPending();
    // The helper's own verdict lines land after this build is up; keep
    // reading until they do, then take the files with them.
    this.settle(watch);
  }

  /**
   * Phase two, called once `listen()` has succeeded: this build is not
   * just running but answering, which is the only thing that makes the
   * update a success. Publishing here also means a browser can be
   * connected to receive it.
   */
  async confirmBooted(): Promise<void> {
    const pending = await this.readPending();
    if (!pending || pending.to_version !== this.currentVersion) return;

    const watch = this.watches.get(pending.run_id) ?? this.watchFor(pending);
    await this.tailLog(watch, true);
    await this.append(pending.run_id, `==> ${pending.to_version} is up and answering`);
    await this.finishRun(pending.run_id, "succeeded", null);
    this.ctx.events.publish("updates", "update.succeeded", { version: pending.to_version });
    await this.clearPending();
    this.settle(watch);
  }

  /* --------------------------- host watch --------------------------- */

  private watchFor(pending: PendingRun): HostWatch {
    const startedAt = Date.parse(pending.started_at) || Date.now();
    return {
      runId: pending.run_id,
      fromVersion: pending.from_version,
      toVersion: pending.to_version,
      logFile: pending.log_file,
      resultFile: resultFileFor(pending),
      snapshotDir: pending.snapshot_dir,
      offset: pending.log_offset ?? 0,
      seenLines: 0,
      startedAt,
      lastActivityAt: Math.max(startedAt, Date.now()),
      settled: false,
      settledAt: 0,
    };
  }

  private watchHost(watch: HostWatch): void {
    this.watches.set(watch.runId, watch);
    if (this.hostTimer) return;
    this.hostTimer = setInterval(() => void this.pollHost(), HOST_POLL_MS);
    this.hostTimer.unref?.();
  }

  /** The run is terminal; stay only for the helper's closing lines and the cleanup. */
  private settle(watch: HostWatch): void {
    watch.settled = true;
    watch.settledAt = Date.now();
    this.watchHost(watch);
  }

  /**
   * One pass over every handover being followed. Public so a test can
   * drive it without waiting on the timer; `now` is injectable for the
   * same reason.
   */
  async pollHost(now = Date.now()): Promise<void> {
    for (const watch of [...this.watches.values()]) {
      try {
        await this.pollWatch(watch, now);
      } catch (err) {
        this.ctx.log.warn({ err, runId: watch.runId }, "following the host updater failed");
      }
    }
    if (this.watches.size === 0 && this.hostTimer) {
      clearInterval(this.hostTimer);
      this.hostTimer = null;
    }
  }

  private async pollWatch(watch: HostWatch, now: number): Promise<void> {
    if (await this.tailLog(watch, false)) watch.lastActivityAt = now;

    const outcome = readOutcome(watch.resultFile);
    if (outcome && outcome.lines.length > watch.seenLines) {
      watch.seenLines = outcome.lines.length;
      watch.lastActivityAt = now;
    }

    if (!watch.settled) {
      if (outcome?.verdict) {
        await this.settleFromVerdict(watch, outcome);
      } else if (!outcome?.pickedUp && now - watch.startedAt > HOST_PICKUP_TIMEOUT_MS) {
        await this.giveUp(
          watch,
          "The host updater never picked up the request.",
          "Check `systemctl status kaname-update.path` on the host.",
        );
        this.dispatcher.withdraw?.(this.ctx.config.dataDir);
      } else if (now - watch.lastActivityAt > HOST_QUIET_TIMEOUT_MS) {
        await this.giveUp(
          watch,
          `The host updater wrote nothing for ${HOST_QUIET_TIMEOUT_MS / 60_000} minutes after picking up the request.`,
          `Check \`systemctl status kaname-update.service\` and ${watch.logFile} on the host.`,
        );
      }
    }

    if (watch.settled && (outcome?.verdict || now - watch.settledAt > HOST_TAIL_TIMEOUT_MS)) {
      await this.tailLog(watch, true);
      this.watches.delete(watch.runId);
      // The run holds every line now; the files would only accumulate.
      rmSync(watch.logFile, { force: true });
      rmSync(watch.resultFile, { force: true });
    }
  }

  /**
   * The helper reached a verdict while this process is still alive —
   * which, for anything but a failed pull, means the restart it should
   * have caused did not happen.
   */
  private async settleFromVerdict(watch: HostWatch, outcome: HostOutcome): Promise<void> {
    const reason = describeReason(outcome.reason, watch.toVersion);
    const restored = this.restoreSnapshot(watch);

    if (outcome.verdict === "rolled_back" && outcome.reason === "pull_failed") {
      await this.append(watch.runId, `!! ${reason}; nothing was stopped`);
      await this.finishRun(watch.runId, "failed", `${capitalize(reason)}; nothing was stopped.`);
    } else if (outcome.verdict === "rolled_back") {
      await this.append(watch.runId, `!! ${reason}; ${watch.fromVersion} was restored`);
      await this.finishRun(
        watch.runId,
        "rolled_back",
        `${capitalize(reason)}; ${watch.fromVersion} was restored.`,
      );
      this.ctx.events.publish("updates", "update.rolled_back", { version: watch.toVersion });
    } else if (outcome.verdict === "rollback_failed") {
      const message = `${capitalize(reason)}, and the rollback to ${watch.fromVersion} did not come up either.`;
      await this.append(watch.runId, `!! ${message}`);
      await this.finishRun(watch.runId, "needs_attention", message);
      this.ctx.events.publish("updates", "update.needs_attention", { version: watch.toVersion });
    } else {
      // "succeeded" from the host while the old process is still the one
      // answering: the restart did not replace it.
      const message = `The host reports ${watch.toVersion} is up, but ${this.currentVersion} is still what is running.`;
      await this.append(watch.runId, `!! ${message}`);
      await this.finishRun(watch.runId, "needs_attention", message);
      this.ctx.events.publish("updates", "update.needs_attention", { version: watch.toVersion });
    }

    if (restored) {
      await this.append(watch.runId, `--> configuration restored from ${watch.snapshotDir}`);
    }
    await this.clearPending();
    this.settle(watch);
  }

  /** Nothing is coming from the host. The run cannot stay open, and .env cannot stay pinned. */
  private async giveUp(watch: HostWatch, what: string, how: string): Promise<void> {
    const restored = this.restoreSnapshot(watch);
    const message = `${what} ${how}`;
    await this.append(watch.runId, `!! ${message}`);
    if (restored) {
      await this.append(watch.runId, `--> configuration restored from ${watch.snapshotDir}`);
    }
    await this.finishRun(watch.runId, "needs_attention", message);
    this.ctx.events.publish("updates", "update.needs_attention", { version: watch.toVersion });
    await this.clearPending();
    this.settle(watch);
  }

  /** Puts the snapshot back if .env still names the new version. True when it did. */
  private restoreSnapshot(watch: HostWatch): boolean {
    const envFile = join(this.ctx.config.dataDir, ".env");
    const snapshot = join(watch.snapshotDir, ".env");
    const current = readIfPresent(envFile);
    if (!current || !existsSync(snapshot)) return false;
    const pinned = /^KANAME_VERSION=(.*)$/m.exec(current)?.[1]?.trim();
    if (pinned !== watch.toVersion) return false;
    copyFileSync(snapshot, envFile);
    return true;
  }

  /**
   * Copies what the helper has written since the last look into the
   * run. Unless `final`, a trailing partial line is left for the next
   * pass so a pull's progress does not arrive split in two.
   */
  private async tailLog(watch: HostWatch, final: boolean): Promise<boolean> {
    let buffer: Buffer;
    try {
      if (!existsSync(watch.logFile)) return false;
      buffer = readFileSync(watch.logFile);
    } catch {
      return false;
    }
    // The helper truncates the file when it starts.
    if (buffer.length < watch.offset) watch.offset = 0;
    let end = buffer.length;
    if (!final) {
      const lastNewline = buffer.lastIndexOf(0x0a);
      end = lastNewline === -1 ? watch.offset : lastNewline + 1;
    }
    if (end <= watch.offset) return false;

    const chunk = buffer.subarray(watch.offset, end).toString("utf8");
    watch.offset = end;
    await this.append(watch.runId, chunk);

    if (!watch.settled) {
      const pending = await this.readPending();
      if (pending?.run_id === watch.runId) {
        await this.writePending({ ...pending, log_offset: watch.offset });
      }
    }
    return true;
  }

  /* --------------------------- agent fleet -------------------------- */

  /**
   * An agent run is settled by the job handler that waits on it. When
   * that handler is gone — the control plane was replaced mid-rollout,
   * or the job timed out unclaimed — the run would otherwise say
   * "running" for ever. Called at boot and on a timer.
   */
  async settleOrphanAgentRuns(): Promise<void> {
    const rows = await this.ctx.db
      .select({ run: updateRuns, jobStatus: jobs.status, agentVersion: servers.agentVersion })
      .from(updateRuns)
      .leftJoin(jobs, eq(updateRuns.jobId, jobs.id))
      .leftJoin(servers, eq(updateRuns.serverId, servers.id))
      .where(and(eq(updateRuns.kind, "agent"), inArray(updateRuns.status, ["queued", "running"])));

    const now = Date.now();
    for (const { run, jobStatus, agentVersion } of rows) {
      // A job that is terminal — or gone — has no handler left to finish
      // the run. A run with no job yet is being enqueued right now.
      const jobGone =
        run.jobId !== null && (!jobStatus || TERMINAL_JOB_STATUSES.includes(jobStatus));
      const overdue = now - (run.startedAt ?? run.createdAt).getTime() > AGENT_RUN_MAX_MS;
      if (!jobGone && !overdue) continue;

      if (agentVersion === run.toVersion) {
        await this.append(
          run.id,
          `==> reconnected running ${run.toVersion} (confirmed after the control plane restarted)`,
        );
        await this.finishRun(run.id, "succeeded", null);
      } else {
        const message = `The control plane restarted while this update was in flight; the host reports ${agentVersion ?? "no version"}.`;
        await this.append(run.id, `!! ${message}`);
        await this.finishRun(run.id, "needs_attention", message);
      }
    }
  }

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

/**
 * Whether the scheduler should check now. A failed check sets a retry
 * time that takes precedence over the interval; without one the last
 * successful check plus the interval decides.
 */
export function checkDue(
  policy: Pick<UpdatePolicy, "interval" | "last_checked_at" | "retry_after">,
  now: number,
): boolean {
  if (policy.retry_after) return now >= Date.parse(policy.retry_after);
  if (!policy.last_checked_at) return true;
  return now - Date.parse(policy.last_checked_at) >= INTERVAL_MS[policy.interval];
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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

const updateInProgress = (toVersion: string) =>
  new ApiException("conflict", `An update to ${toVersion} is already in progress.`, {
    remediation: {
      summary: "Wait for it to finish; the run is in History.",
      actions: [{ label: "Open run", href: "/administration/updates" }],
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
