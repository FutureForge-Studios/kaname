import { and, eq, inArray, isNull, sql, type Database } from "@kaname/db";
import { jobs, servers, settings } from "@kaname/db/schema";
import type {
  MethodResult,
  OsPackageUpdate,
  OsUpdateState,
  ServerOsUpdates,
  ServerOsUpdatesSummary,
} from "@kaname/contract";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "../agent/hub.js";
import type { AppContext } from "../context.js";
import type { EventBus } from "./events.js";

/* ------------------------------------------------------------------ *
 * Operating-system updates.
 *
 * The agent can list a host's pending package updates and apply them
 * (`system.packages.list` / `system.packages.upgrade`); this is what
 * turns those two verbs into something a page can show without running
 * apt on every render.
 *
 * The last answer per server is cached in `settings` under
 * `os_updates:<server id>` — one row per host, so a refresh on one box
 * and a settings change on another never overwrite each other, and no
 * migration is needed for what is, in the end, a cache. Writes merge at
 * the top level of the JSON (`value || patch`), so a refresh does not
 * clobber the auto-update switch and vice versa.
 *
 * Who writes it:
 *  - an explicit refresh (POST /servers/:id/os-updates/refresh);
 *  - the background pass below, for any connected host whose cache is
 *    older than REFRESH_AFTER_MS;
 *  - the `system.packages.upgrade` job handler, which records whether
 *    the run left a reboot pending and re-reads the list afterwards.
 *
 * "Reboot required" is only ever learned from an upgrade (the agent
 * reports it from that run); it is cleared by a later refresh that sees
 * the host has booted since.
 * ------------------------------------------------------------------ */

const KEY_PREFIX = "os_updates:";

/** A cached list older than this is refreshed by the background pass. */
export const REFRESH_AFTER_MS = 6 * 60 * 60_000;
/** How often the background pass looks for stale caches. */
const TICK_MS = 10 * 60_000;
/** After boot, give agents time to dial in before the first pass. */
const FIRST_TICK_MS = 90_000;
/** Automatic security upgrades run at most this often per host. */
export const AUTO_SECURITY_MIN_GAP_MS = 20 * 60 * 60_000;
/** A package-manager refresh on a slow mirror can take a while. */
const LIST_TIMEOUT_MS = 5 * 60_000;

export interface StoredOsUpdates {
  state: OsUpdateState;
  checked_at: string | null;
  error: string | null;
  packages: OsPackageUpdate[];
  reboot_required: boolean;
  reboot_required_since: string | null;
  last_upgrade_at: string | null;
  auto_security: boolean;
  last_auto_at: string | null;
}

const EMPTY: StoredOsUpdates = {
  state: "unknown",
  checked_at: null,
  error: null,
  packages: [],
  reboot_required: false,
  reboot_required_since: null,
  last_upgrade_at: null,
  auto_security: false,
  last_auto_at: null,
};

type ServerRow = typeof servers.$inferSelect;

export function emptyOsUpdates(): StoredOsUpdates {
  return { ...EMPTY, packages: [] };
}

export interface OsUpdateDeps {
  db: Database;
  hub: AgentHub;
  events: EventBus;
}

export function osUpdatesKey(serverId: string): string {
  return `${KEY_PREFIX}${serverId}`;
}

/* ------------------------------ storage ------------------------------ */

export async function loadOsUpdates(
  db: Database,
  serverIds: readonly string[],
): Promise<Map<string, StoredOsUpdates>> {
  const out = new Map<string, StoredOsUpdates>();
  if (serverIds.length === 0) return out;
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, serverIds.map(osUpdatesKey)));
  for (const row of rows) {
    out.set(row.key.slice(KEY_PREFIX.length), { ...EMPTY, ...(row.value as Partial<StoredOsUpdates>) });
  }
  return out;
}

export async function loadOne(db: Database, serverId: string): Promise<StoredOsUpdates> {
  return (await loadOsUpdates(db, [serverId])).get(serverId) ?? { ...EMPTY };
}

/** Merges `patch` into the stored value at the top level, atomically. */
export async function saveOsUpdates(
  db: Database,
  serverId: string,
  patch: Partial<StoredOsUpdates>,
): Promise<StoredOsUpdates> {
  await db
    .insert(settings)
    .values({ key: osUpdatesKey(serverId), value: { ...EMPTY, ...patch } })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: sql`${settings.value} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      },
    });
  return loadOne(db, serverId);
}

/* ------------------------------ shaping ------------------------------ */

export function toSummary(server: ServerRow, stored: StoredOsUpdates): ServerOsUpdatesSummary {
  return {
    server_id: server.id,
    server_name: server.name,
    hostname: server.hostname,
    connection: server.connection,
    simulated: server.simulated,
    state: stored.state,
    checked_at: stored.checked_at,
    error: stored.error,
    total: stored.packages.length,
    security: stored.packages.filter((p) => p.security).length,
    reboot_required: stored.reboot_required,
    reboot_required_since: stored.reboot_required_since,
    last_upgrade_at: stored.last_upgrade_at,
    auto_security: stored.auto_security,
  };
}

export function toDetail(server: ServerRow, stored: StoredOsUpdates): ServerOsUpdates {
  return { ...toSummary(server, stored), packages: stored.packages };
}

/* ------------------------------ refresh ------------------------------ */

/** Security first, then by name: what an operator scans for. */
function sortPackages(list: OsPackageUpdate[]): OsPackageUpdate[] {
  return [...list].sort(
    (a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name),
  );
}

/**
 * Asks the agent for its upgradable packages and caches the answer. A
 * failure is cached too — as `error` or `unsupported` — and keeps the
 * previous list, so a flaky mirror does not make pending updates vanish.
 * Throws only AgentOfflineError, which callers decide how to report.
 */
export async function refreshOsUpdates(
  deps: OsUpdateDeps,
  serverId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<StoredOsUpdates> {
  const before = await loadOne(deps.db, serverId);
  const now = new Date();
  let patch: Partial<StoredOsUpdates>;

  try {
    const result = await deps.hub.call(
      serverId,
      "system.packages.list",
      { upgradable_only: true },
      { timeoutMs: LIST_TIMEOUT_MS, signal: opts.signal },
    );
    const packages = sortPackages(
      result.packages
        .filter((p) => p.available_version !== null && p.available_version !== undefined)
        .map((p) => ({
          name: p.name,
          installed_version: p.installed_version,
          available_version: p.available_version!,
          security: p.security ?? false,
        })),
    );
    patch = {
      state: packages.length > 0 ? "pending" : "current",
      checked_at: now.toISOString(),
      error: null,
      packages,
    };
  } catch (err) {
    if (err instanceof AgentOfflineError) throw err;
    const unsupported = err instanceof AgentRpcError && err.agentError.code === "unsupported";
    patch = {
      state: unsupported ? "unsupported" : "error",
      checked_at: now.toISOString(),
      error: err instanceof Error ? err.message : String(err),
      packages: unsupported ? [] : before.packages,
    };
  }

  // A reboot the last upgrade asked for is done once the host has booted
  // since. Best effort: a host that will not say keeps the flag.
  if (before.reboot_required && before.reboot_required_since) {
    const booted = await bootTime(deps, serverId, opts.signal);
    if (booted && booted.getTime() > Date.parse(before.reboot_required_since)) {
      patch.reboot_required = false;
      patch.reboot_required_since = null;
    }
  }

  const after = await saveOsUpdates(deps.db, serverId, patch);
  deps.events.publish("updates", "os_updates.changed", { server_id: serverId }, serverId);
  return after;
}

async function bootTime(
  deps: OsUpdateDeps,
  serverId: string,
  signal?: AbortSignal,
): Promise<Date | null> {
  try {
    const info = await deps.hub.call(serverId, "system.info", {}, { signal });
    const at = new Date(info.boot_time);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/**
 * Called by the `system.packages.upgrade` handler once the agent has
 * answered: records what the run said about a reboot, then re-reads
 * the list so the page shows what is left rather than what was there.
 */
export async function recordUpgrade(
  deps: OsUpdateDeps,
  serverId: string,
  result: MethodResult<"system.packages.upgrade">,
  opts: { signal?: AbortSignal } = {},
): Promise<StoredOsUpdates> {
  const before = await loadOne(deps.db, serverId);
  const now = new Date().toISOString();
  await saveOsUpdates(deps.db, serverId, {
    last_upgrade_at: now,
    ...(result.reboot_required
      ? {
          reboot_required: true,
          reboot_required_since: before.reboot_required_since ?? now,
        }
      : {}),
  });
  try {
    return await refreshOsUpdates(deps, serverId, opts);
  } catch {
    // The upgrade itself succeeded; a list that cannot be re-read now is
    // picked up by the next background pass.
    deps.events.publish("updates", "os_updates.changed", { server_id: serverId }, serverId);
    return loadOne(deps.db, serverId);
  }
}

/* ----------------------------- scheduler ----------------------------- */

export interface OsUpdatePassResult {
  refreshed: string[];
  failed: string[];
  /** Automatic security upgrades enqueued, by server id. */
  auto: { serverId: string; jobId: string }[];
}

/**
 * Keeps the cache fresh and applies automatic security updates. Shaped
 * like the backup scheduler: a timer that calls one pass, a pass that
 * never overlaps itself, and an injectable clock for the tests.
 *
 * Hosts are refreshed one at a time — a package-manager refresh is
 * disk- and network-heavy, and nothing here is urgent.
 */
export class OsUpdateScheduler {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => Date;
  private readonly onConnected = (serverId: string) => {
    // A reconnect may be the reboot an upgrade asked for; checking now
    // rather than in six hours is what clears the banner promptly.
    void loadOne(this.ctx.db, serverId)
      .then((stored) => {
        if (!stored.reboot_required) return;
        const later = setTimeout(
          () => void refreshOsUpdates(this.ctx, serverId).catch(() => undefined),
          10_000,
        );
        later.unref?.();
      })
      .catch(() => undefined);
  };

  constructor(
    private readonly ctx: AppContext,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    this.first.unref?.();
    this.ctx.hub.on("connected", this.onConnected);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
    this.ctx.hub.off("connected", this.onConnected);
  }

  async tick(): Promise<OsUpdatePassResult> {
    const result: OsUpdatePassResult = { refreshed: [], failed: [], auto: [] };
    if (this.running) return result;
    this.running = true;
    try {
      const fleet = await this.ctx.db.select().from(servers).where(isNull(servers.revokedAt));
      const cached = await loadOsUpdates(
        this.ctx.db,
        fleet.map((s) => s.id),
      );

      for (const server of fleet) {
        if (!this.ctx.hub.isConnected(server.id)) continue;
        let stored = cached.get(server.id) ?? { ...EMPTY };

        const age = stored.checked_at
          ? this.now().getTime() - Date.parse(stored.checked_at)
          : Number.POSITIVE_INFINITY;
        if (age >= REFRESH_AFTER_MS) {
          try {
            stored = await refreshOsUpdates(this.ctx, server.id);
            result.refreshed.push(server.id);
          } catch (err) {
            result.failed.push(server.id);
            this.ctx.log.warn({ err, serverId: server.id }, "os update refresh failed");
            continue;
          }
        }

        const jobId = await this.maybeAutoUpgrade(server, stored);
        if (jobId) result.auto.push({ serverId: server.id, jobId });
      }
    } catch (err) {
      this.ctx.log.error({ err }, "os update pass failed");
    } finally {
      this.running = false;
    }
    return result;
  }

  /**
   * Security-only, at most once per AUTO_SECURITY_MIN_GAP_MS, never
   * stacked on an upgrade that is already queued or running.
   */
  private async maybeAutoUpgrade(
    server: ServerRow,
    stored: StoredOsUpdates,
  ): Promise<string | null> {
    if (!stored.auto_security) return null;
    if (!stored.packages.some((p) => p.security)) return null;
    const now = this.now();
    if (stored.last_auto_at && now.getTime() - Date.parse(stored.last_auto_at) < AUTO_SECURITY_MIN_GAP_MS) {
      return null;
    }

    const inFlight = await this.ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.serverId, server.id),
          eq(jobs.type, "system.packages.upgrade"),
          inArray(jobs.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (inFlight.length > 0) return null;

    const params = { names: [], security_only: true };
    const job = await this.ctx.queue.enqueue({
      type: "system.packages.upgrade",
      serverId: server.id,
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      params,
      createdByName: "automatic security updates",
      blockedReason: this.ctx.hub.isConnected(server.id) ? null : "agent_offline",
    });
    await saveOsUpdates(this.ctx.db, server.id, { last_auto_at: now.toISOString() });

    await this.ctx.audit.record({
      actor: { type: "system", id: null, name: "scheduler" },
      action: "system.packages.upgrade.requested",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
      jobId: job.id,
      metadata: { params, trigger: "scheduled" },
    });
    this.ctx.events.publish("jobs", "job.queued", { ...job, server_name: server.name }, server.id);
    return job.id;
  }
}
