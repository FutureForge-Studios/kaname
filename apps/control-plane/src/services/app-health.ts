import { and, eq, inArray, lt, sql } from "@kaname/db";
import { alertRules, appHealthSamples, appInstalls, appMonitors, servers } from "@kaname/db/schema";
import {
  APP_ALERT_KIND_LABELS,
  APP_RULE_TEMPLATES,
  CONTAINER_ALERT_KINDS,
  defaultHealthPath,
  findApp,
  type AppAlertKind,
  type AppContainerHealth,
  type ContainerInfo,
} from "@kaname/contract";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * The app monitor (KD-041).
 *
 * Once a minute, for every active install:
 *   - an HTTP(S) GET of its own address and probe path, from the
 *     control plane — the vantage point of someone visiting the site,
 *     which is the thing that has to work — 10 s timeout, eight at a
 *     time, redirects followed; 2xx is up, anything else is a failure;
 * every other minute, for image recipes:
 *   - one `container.list` with stats per server that has any, never
 *     one per install, grouped by the io.kaname.install label;
 * every six hours, for image recipes:
 *   - one `fs.usage` of its managed data directory.
 * Samples are kept eight days (a 7-day uptime figure needs seven).
 *
 * A simulated host has no reachable address, so its probe is answered
 * here from what the simulator reports about the app's container: up
 * with a plausible latency while the app container runs, down when it
 * does not. Like the rest of a simulated host's data it is fiction by
 * design (KD-010); a real host is always probed over the network.
 *
 * The monitor also keeps each install's default alert rules: created
 * once the install is active (app down; restart loop for image
 * recipes; certificate expiring with HTTPS), removed with the install
 * by the alert_rules.app_install_id cascade.
 * ------------------------------------------------------------------ */

const TICK_MS = 60_000;
const FIRST_TICK_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 8;
const CONTAINER_EVERY_TICKS = 2;
const PRUNE_EVERY_TICKS = 60;
const DATA_EVERY_MS = 6 * 3_600_000;
export const SAMPLE_RETENTION_DAYS = 8;

export const LABEL_INSTALL = "io.kaname.install";
export const LABEL_ROLE = "io.kaname.role";

type InstallRow = typeof appInstalls.$inferSelect;
type MonitorRow = typeof appMonitors.$inferSelect;

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface AppHealthDeps {
  fetch?: typeof globalThis.fetch;
}

interface Target {
  install: InstallRow;
  monitor: MonitorRow;
  simulated: boolean;
  image: boolean;
}

export function isImageInstall(install: Pick<InstallRow, "appId" | "appPort">): boolean {
  const recipe = findApp(install.appId);
  return recipe ? recipe.source.kind === "image" : install.appPort !== null;
}

/** The kinds that apply to an install: container ones need containers, the certificate one HTTPS. */
export function applicableKinds(install: Pick<InstallRow, "appId" | "appPort" | "ssl">): AppAlertKind[] {
  const image = isImageInstall(install);
  return APP_RULE_TEMPLATES.map((t) => t.kind).filter(
    (kind) =>
      (image || !CONTAINER_ALERT_KINDS.has(kind)) && (install.ssl || kind !== "app_cert_expiring"),
  );
}

export function appRuleName(kind: AppAlertKind, install: Pick<InstallRow, "domain">): string {
  return `${APP_ALERT_KIND_LABELS[kind]} · ${install.domain}`.slice(0, 96);
}

/** The values one app rule of `kind` starts from. */
export function appRuleValues(kind: AppAlertKind, install: InstallRow, enabled: boolean) {
  const template = APP_RULE_TEMPLATES.find((t) => t.kind === kind)!;
  return {
    name: appRuleName(kind, install),
    metric: kind,
    comparator: template.comparator,
    threshold: template.threshold,
    durationSeconds: template.duration_seconds,
    severity: template.severity,
    scope: { kind: "app" as const, app_install_id: install.id },
    enabled,
    channels: [] as string[],
    appInstallId: install.id,
  };
}

/**
 * Makes sure an active install has its monitor row and, the first time,
 * its default rules. Idempotent; called every tick and safe to call from
 * anywhere an install becomes active.
 */
export async function ensureAppMonitoring(ctx: AppContext, install: InstallRow): Promise<MonitorRow> {
  await ctx.db
    .insert(appMonitors)
    .values({ appInstallId: install.id, probePath: defaultHealthPath(install.appId) })
    .onConflictDoNothing();
  const [monitor] = await ctx.db
    .select()
    .from(appMonitors)
    .where(eq(appMonitors.appInstallId, install.id))
    .limit(1);
  if (monitor!.defaultsSeededAt || install.status !== "active") return monitor!;

  // Claim the seeding first, so two ticks (or a tick and a request)
  // racing here cannot both create the defaults.
  const claimed = await ctx.db
    .update(appMonitors)
    .set({ defaultsSeededAt: new Date(), updatedAt: new Date() })
    .where(and(eq(appMonitors.appInstallId, install.id), sql`${appMonitors.defaultsSeededAt} is null`))
    .returning({ id: appMonitors.appInstallId });
  if (claimed.length === 0) return monitor!;

  const kinds = new Set(applicableKinds(install));
  const defaults = APP_RULE_TEMPLATES.filter((t) => t.default && kinds.has(t.kind));
  if (defaults.length > 0) {
    await ctx.db.insert(alertRules).values(defaults.map((t) => appRuleValues(t.kind, install, true)));
    ctx.events.publish("alerts", "alert_rule.created", { app_install_id: install.id }, install.serverId);
  }
  return { ...monitor!, defaultsSeededAt: new Date() };
}

/** Docker's status line carries the healthcheck verdict: "Up 2 hours (healthy)". */
export function healthOf(status: string): AppContainerHealth["health"] {
  if (/\(unhealthy\)/i.test(status)) return "unhealthy";
  if (/health: starting/i.test(status)) return "starting";
  if (/\(healthy\)/i.test(status)) return "healthy";
  return "none";
}

/** Folds one install's containers into the sample row and the per-container list. */
export function summariseContainers(list: readonly ContainerInfo[]): {
  items: AppContainerHealth[];
  total: number;
  running: number;
  unhealthy: number;
  restartCount: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimit: number | null;
} {
  const items: AppContainerHealth[] = list.map((c) => ({
    name: c.name,
    role: c.labels[LABEL_ROLE] ?? "app",
    state: c.state,
    status: c.status,
    health: healthOf(c.status),
    restart_count: c.restart_count ?? 0,
    cpu_percent: c.cpu_percent,
    memory_bytes: c.memory_usage,
    memory_limit: c.memory_limit,
  }));
  const sum = (values: (number | null)[]): number | null =>
    values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  return {
    items,
    total: items.length,
    running: items.filter((i) => i.state === "running").length,
    unhealthy: items.filter((i) => i.health === "unhealthy").length,
    restartCount: items.reduce((a, i) => a + i.restart_count, 0),
    cpuPercent: sum(items.map((i) => i.cpu_percent)),
    memoryBytes: sum(items.map((i) => i.memory_bytes)),
    memoryLimit: sum(items.map((i) => i.memory_limit)),
  };
}

export class AppHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly ctx: AppContext,
    deps: AppHealthDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    this.first.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
  }

  /** One pass. Safe to call directly (tests); passes never overlap. */
  async tick(opts: { containers?: boolean; data?: boolean } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    const tick = this.ticks++;
    try {
      const targets = await this.targets();
      await pool(targets, PROBE_CONCURRENCY, (t) => this.probe(t));
      if (opts.containers ?? tick % CONTAINER_EVERY_TICKS === 0) await this.pollContainers(targets);
      if (opts.data ?? true) await this.measureData(targets);
      if (tick % PRUNE_EVERY_TICKS === 0) await this.prune();
    } catch (err) {
      this.ctx.log.warn({ err }, "app health pass failed");
    } finally {
      this.running = false;
    }
  }

  private async targets(): Promise<Target[]> {
    const rows = await this.ctx.db
      .select({ install: appInstalls, simulated: servers.simulated })
      .from(appInstalls)
      .innerJoin(servers, eq(appInstalls.serverId, servers.id))
      .where(eq(appInstalls.status, "active"));
    const out: Target[] = [];
    for (const { install, simulated } of rows) {
      try {
        const monitor = await ensureAppMonitoring(this.ctx, install);
        out.push({ install, monitor, simulated: simulated === true, image: isImageInstall(install) });
      } catch (err) {
        this.ctx.log.warn({ err, installId: install.id }, "app monitor setup failed");
      }
    }
    return out;
  }

  /* ------------------------------ HTTP ------------------------------ */

  private async probe(target: Target): Promise<void> {
    const { install, monitor } = target;
    if (!monitor.probeEnabled) return;
    const result = target.simulated
      ? await this.simulatedProbe(target)
      : await this.httpProbe(probeUrl(install, monitor.probePath));
    await this.record(target, result);
  }

  async httpProbe(url: string): Promise<ProbeResult> {
    const started = performance.now();
    try {
      const res = await this.fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "user-agent": "Kaname-Health/1", accept: "*/*" },
      });
      const latencyMs = Math.round(performance.now() - started);
      // The body is not needed; cancel it so the socket is released.
      await res.body?.cancel().catch(() => undefined);
      const ok = res.status >= 200 && res.status < 300;
      return { ok, statusCode: res.status, latencyMs, error: ok ? null : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, statusCode: null, latencyMs: null, error: probeError(err) };
    }
  }

  /** A simulated host: answer from its app container's state; see the header. */
  private async simulatedProbe(target: Target): Promise<ProbeResult> {
    if (target.image && target.monitor.containersSampledAt) {
      const app = target.monitor.containers.find((c) => c.role === "app");
      if (app && app.state !== "running") {
        return { ok: false, statusCode: 502, latencyMs: null, error: `HTTP 502 (app container ${app.state})` };
      }
    }
    const seed = [...target.install.id].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const wave = Math.sin(Date.now() / 600_000 + seed) * 0.5 + 0.5;
    return { ok: true, statusCode: 200, latencyMs: Math.round(60 + (seed % 90) + wave * 70), error: null };
  }

  private async record(target: Target, result: ProbeResult): Promise<void> {
    const { db, events } = this.ctx;
    const { install, monitor } = target;
    const now = new Date();
    await db.insert(appHealthSamples).values({
      appInstallId: install.id,
      ts: now,
      kind: "http",
      ok: result.ok,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      error: result.error,
    });
    const status = result.ok ? "up" : "down";
    await db
      .update(appMonitors)
      .set({
        status,
        consecutiveFailures: result.ok ? 0 : sql`${appMonitors.consecutiveFailures} + 1`,
        lastCheckedAt: now,
        lastStatusCode: result.statusCode,
        lastLatencyMs: result.latencyMs,
        lastError: result.error,
        updatedAt: now,
      })
      .where(eq(appMonitors.appInstallId, install.id));
    if (status !== monitor.status) {
      events.publish(
        "alerts",
        "app_health.changed",
        { app_install_id: install.id, status, previous: monitor.status },
        install.serverId,
      );
    }
  }

  /* --------------------------- containers --------------------------- */

  private async pollContainers(targets: readonly Target[]): Promise<void> {
    const { hub } = this.ctx;
    const byServer = new Map<string, Target[]>();
    for (const t of targets) {
      if (!t.image) continue;
      byServer.set(t.install.serverId, [...(byServer.get(t.install.serverId) ?? []), t]);
    }
    for (const [serverId, group] of byServer) {
      const caps = hub.capabilities(serverId);
      if (!hub.isConnected(serverId) || !(caps.includes("docker") || caps.includes("podman"))) continue;
      let listed: ContainerInfo[];
      try {
        const result = await hub.call(
          serverId,
          "container.list",
          { all: true, with_stats: true },
          { timeoutMs: 20_000 },
        );
        listed = result.containers;
      } catch (err) {
        this.ctx.log.debug({ err, serverId }, "app container poll failed");
        continue;
      }
      for (const target of group) {
        const mine = listed.filter((c) => c.labels[LABEL_INSTALL] === target.install.id);
        await this.recordContainers(target, mine);
      }
    }
  }

  async recordContainers(target: Pick<Target, "install">, list: readonly ContainerInfo[]): Promise<void> {
    const summary = summariseContainers(list);
    const now = new Date();
    await this.ctx.db.insert(appHealthSamples).values({
      appInstallId: target.install.id,
      ts: now,
      kind: "containers",
      containersTotal: summary.total,
      containersRunning: summary.running,
      containersUnhealthy: summary.unhealthy,
      restartCount: summary.restartCount,
      cpuPercent: summary.cpuPercent,
      memoryBytes: summary.memoryBytes,
      memoryLimit: summary.memoryLimit,
    });
    await this.ctx.db
      .update(appMonitors)
      .set({ containers: summary.items, containersSampledAt: now, updatedAt: now })
      .where(eq(appMonitors.appInstallId, target.install.id));
  }

  /* ------------------------------ data ------------------------------ */

  /**
   * `fs.usage` walks the tree, so it is the expensive one: once every six
   * hours per install, and only for a directory the install recorded.
   */
  private async measureData(targets: readonly Target[]): Promise<void> {
    const { hub, db } = this.ctx;
    for (const { install, monitor, image } of targets) {
      const dir = install.resources.data_dir;
      if (!image || !dir || !hub.isConnected(install.serverId)) continue;
      if (monitor.dataMeasuredAt && Date.now() - monitor.dataMeasuredAt.getTime() < DATA_EVERY_MS) continue;
      try {
        const usage = await hub.call(install.serverId, "fs.usage", { path: dir, depth: 1 }, { timeoutMs: 60_000 });
        await db
          .update(appMonitors)
          .set({ dataBytes: usage.total, dataMeasuredAt: new Date(), updatedAt: new Date() })
          .where(eq(appMonitors.appInstallId, install.id));
      } catch (err) {
        // Not worth a retry storm: try again at the next interval.
        await db
          .update(appMonitors)
          .set({ dataMeasuredAt: new Date() })
          .where(eq(appMonitors.appInstallId, install.id));
        this.ctx.log.debug({ err, installId: install.id }, "app data usage failed");
      }
    }
  }

  private async prune(): Promise<void> {
    await this.ctx.db
      .delete(appHealthSamples)
      .where(lt(appHealthSamples.ts, new Date(Date.now() - SAMPLE_RETENTION_DAYS * 24 * 3_600_000)));
  }
}

export function probeUrl(install: Pick<InstallRow, "ssl" | "domain">, path: string): string {
  return `${install.ssl ? "https" : "http"}://${install.domain}${path.startsWith("/") ? path : `/${path}`}`;
}

function probeError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `timed out after ${PROBE_TIMEOUT_MS / 1000}s`;
  const code = e?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "domain does not resolve";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  if (code && /CERT|SSL|TLS/i.test(code)) return `TLS: ${code}`;
  return (e?.cause?.message ?? e?.message ?? "request failed").slice(0, 200);
}

async function pool<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await run(item).catch(() => undefined);
    }
  });
  await Promise.all(workers);
}

/** Every install that still has an app rule; used by the routes for "Add rule". */
export async function rulesForInstall(ctx: AppContext, installIds: readonly string[]) {
  if (installIds.length === 0) return [];
  return ctx.db.select().from(alertRules).where(inArray(alertRules.appInstallId, [...installIds]));
}
