import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { and, createDb, eq, isNull, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import {
  alertRules,
  alerts,
  appHealthSamples,
  appInstalls,
  appMonitors,
  certificates,
  servers,
} from "@kaname/db/schema";
import type { ContainerInfo } from "@kaname/contract";
import { loadConfig, resetConfigForTests, type Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { bootstrap } from "./bootstrap.js";
import { buildServer } from "./server.js";
import { AlertEvaluator } from "./services/alerts.js";
import { AppHealthMonitor, healthOf, summariseContainers } from "./services/app-health.js";
import type { StreamEvent } from "./services/events.js";

/* ------------------------------------------------------------------ *
 * App health and app alert rules.
 *
 *   - each app kind opens, dedups (one open alert, one firing edge) and
 *     resolves through the same lifecycle as a server rule;
 *   - an install gets its default rules once it is active, sized to
 *     what it is (containers, HTTPS), and loses them when it goes;
 *   - a client sees and tunes only its own apps' health and rules, and
 *     Monitoring (all apps) stays operator-only.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@apphealth.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const STRONG = "Tidal-Basalt-Orchard-47";

let config: Config;
let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let evaluator: AlertEvaluator;
let serverId = "";
let ip = 10;
const seen: StreamEvent[] = [];

/** What the stub "network" answers next, per URL substring. */
let answer: (url: string) => Promise<Response> = async () => new Response("ok", { status: 200 });
const stubFetch = ((input: RequestInfo | URL) => answer(String(input))) as typeof fetch;
let monitor: AppHealthMonitor;

const nextIp = () => `203.0.113.${(ip = (ip % 250) + 1)}`;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (cookie: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });
const data = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body).data as T;
function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.value);
  return cookie ? `${cookie.name}=${cookie.value}` : "";
}
async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: nextIp(),
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}
async function activate(email: string, inviteUrl: string): Promise<string> {
  const token = decodeURIComponent(inviteUrl.split("/invite/")[1]!);
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invite/accept",
    remoteAddress: nextIp(),
    payload: { token, password: STRONG },
  });
  expect(accepted.statusCode).toBe(200);
  return login(email, STRONG);
}

let n = 0;
async function install(
  opts: { appId?: string; ssl?: boolean; status?: "active" | "installing"; createdBy?: string | null; certificateId?: string | null } = {},
) {
  const appId = opts.appId ?? "wordpress";
  const [row] = await handle.db
    .insert(appInstalls)
    .values({
      appId,
      appName: appId === "ghost" ? "Ghost" : "WordPress",
      appVersion: "1",
      serverId,
      domain: `app${++n}.health.test`,
      status: opts.status ?? "active",
      ssl: opts.ssl ?? false,
      inputs: { admin_email: "ops@health.test", system_user: "www-data", php_version: null },
      createdBy: opts.createdBy ?? null,
      certificateId: opts.certificateId ?? null,
      appPort: appId === "ghost" ? 20000 + n : null,
    })
    .returning();
  return row!;
}

async function rulesOf(installId: string) {
  return handle.db.select().from(alertRules).where(eq(alertRules.appInstallId, installId));
}

async function openAlerts(ruleId: string) {
  return handle.db.select().from(alerts).where(and(eq(alerts.ruleId, ruleId), isNull(alerts.resolvedAt)));
}

/** Only this install's rule of `kind` runs: the others are switched off so the test reads one thing. */
async function only(installId: string, kind: string, patch: Partial<typeof alertRules.$inferInsert> = {}) {
  await handle.db.update(alertRules).set({ enabled: false }).where(eq(alertRules.enabled, true));
  const rules = await rulesOf(installId);
  let rule = rules.find((r) => r.metric === kind);
  if (!rule) {
    [rule] = await handle.db
      .insert(alertRules)
      .values({
        name: kind,
        metric: kind,
        comparator: "gt",
        threshold: 0,
        durationSeconds: 0,
        severity: "warning",
        scope: { kind: "app", app_install_id: installId },
        appInstallId: installId,
        enabled: true,
      })
      .returning();
  }
  await handle.db.update(alertRules).set({ enabled: true, ...patch }).where(eq(alertRules.id, rule!.id));
  return rule!;
}

const edges = (ruleId: string, type: string) =>
  seen.filter((e) => e.type === type && (e.data as { rule_id?: string }).rule_id === ruleId);

function container(over: Partial<ContainerInfo> & { role?: string } = {}): ContainerInfo {
  const { role = "app", ...rest } = over;
  return {
    id: crypto.randomUUID(),
    name: `c-${role}`,
    image: "ghost:5",
    image_id: "sha256:x",
    state: "running",
    status: "Up 2 hours",
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    ports: [],
    labels: { "io.kaname.role": role },
    networks: [],
    mounts: [],
    restart_count: 0,
    cpu_percent: 1,
    memory_usage: 100,
    memory_limit: 1000,
    runtime: "docker",
    ...rest,
  };
}

async function containerSample(installId: string, secondsAgo: number, values: Partial<typeof appHealthSamples.$inferInsert>) {
  await handle.db.insert(appHealthSamples).values({
    appInstallId: installId,
    ts: new Date(Date.now() - secondsAgo * 1000),
    kind: "containers",
    containersTotal: 2,
    containersRunning: 2,
    containersUnhealthy: 0,
    restartCount: 0,
    cpuPercent: 5,
    memoryBytes: 100,
    memoryLimit: 1000,
    ...values,
  });
}

beforeAll(async () => {
  resetConfigForTests();
  config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: OWNER_EMAIL,
    KANAME_BOOTSTRAP_PASSWORD: OWNER_PASSWORD,
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);
  ctx.events.on("alerts", (event) => seen.push(event));
  evaluator = new AlertEvaluator(ctx);
  monitor = new AppHealthMonitor(ctx, { fetch: stubFetch });
  app = await buildServer(ctx);
  await app.ready();

  const [server] = await handle.db
    .insert(servers)
    .values({ name: "apps-01", hostname: "apps-01.example.com", connection: "connected", enrolledAt: new Date() })
    .returning({ id: servers.id });
  serverId = server!.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

beforeEach(() => {
  answer = async () => new Response("ok", { status: 200 });
});

/* ------------------------------------------------------------------ */

describe("default rules", () => {
  it("creates app down for a site recipe, plus restart loop and certificate for an HTTPS image recipe", async () => {
    const site = await install({ appId: "wordpress", ssl: false });
    const image = await install({ appId: "ghost", ssl: true });
    await monitor.tick({ containers: false });

    expect((await rulesOf(site.id)).map((r) => r.metric).sort()).toEqual(["app_down"]);
    expect((await rulesOf(image.id)).map((r) => r.metric).sort()).toEqual([
      "app_cert_expiring",
      "app_down",
      "app_restart_loop",
    ]);
    const [rule] = await rulesOf(site.id);
    expect(rule!.scope).toEqual({ kind: "app", app_install_id: site.id });
    expect(rule!.enabled).toBe(true);

    // Idempotent: another pass adds nothing, and a muted default is not recreated.
    await handle.db.update(alertRules).set({ enabled: false }).where(eq(alertRules.id, rule!.id));
    await monitor.tick({ containers: false });
    expect(await rulesOf(site.id)).toHaveLength(1);
    expect((await rulesOf(site.id))[0]!.enabled).toBe(false);

    // The recipe's own health path is the default probe path.
    const [mon] = await handle.db.select().from(appMonitors).where(eq(appMonitors.appInstallId, image.id));
    expect(mon!.probePath).toBe("/ghost/api/admin/site/");
  });

  it("waits for the install to be active, and goes with it on uninstall", async () => {
    const pending = await install({ status: "installing" });
    await monitor.tick({ containers: false });
    expect(await rulesOf(pending.id)).toHaveLength(0);

    await handle.db.update(appInstalls).set({ status: "active" }).where(eq(appInstalls.id, pending.id));
    await monitor.tick({ containers: false });
    const rules = await rulesOf(pending.id);
    expect(rules).toHaveLength(1);
    await handle.db.insert(alerts).values({
      ruleId: rules[0]!.id,
      serverId,
      state: "firing",
      severity: "critical",
      value: 3,
      threshold: 3,
      message: "down",
    });

    // What the uninstall job does once the host is clean.
    await handle.db.delete(appInstalls).where(eq(appInstalls.id, pending.id));
    expect(await rulesOf(pending.id)).toHaveLength(0);
    expect(await handle.db.select().from(alerts).where(eq(alerts.ruleId, rules[0]!.id))).toHaveLength(0);
    expect(
      await handle.db.select().from(appMonitors).where(eq(appMonitors.appInstallId, pending.id)),
    ).toHaveLength(0);
  });
});

describe("app rule evaluation", () => {
  it("app_down fires after N failed probes, once, and resolves on the first success", async () => {
    const row = await install();
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_down");
    answer = async () => new Response("bad gateway", { status: 502 });

    await monitor.tick({ containers: false });
    await monitor.tick({ containers: false });
    await evaluator.evaluate();
    expect(await openAlerts(rule.id)).toHaveLength(0);

    await monitor.tick({ containers: false });
    await evaluator.evaluate();
    await monitor.tick({ containers: false });
    await evaluator.evaluate();
    const open = await openAlerts(rule.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe("firing");
    expect(open[0]!.message).toContain("HTTP 502");
    const firing = edges(rule.id, "alert.firing");
    expect(firing).toHaveLength(1);
    expect(firing[0]!.data).toMatchObject({
      app_install_id: row.id,
      href: `/apps/installs/${row.id}`,
      notify: true,
    });

    answer = async () => new Response("ok", { status: 200 });
    await monitor.tick({ containers: false });
    await evaluator.evaluate();
    expect(await openAlerts(rule.id)).toHaveLength(0);
    expect(edges(rule.id, "alert.resolved")).toHaveLength(1);
  });

  it("app_down counts a timeout or refusal as a failure", async () => {
    const row = await install();
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_down", { threshold: 1 });
    answer = async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await monitor.tick({ containers: false });
    await evaluator.evaluate();
    const [open] = await openAlerts(rule.id);
    expect(open?.message).toContain("connection refused");
    const [mon] = await handle.db.select().from(appMonitors).where(eq(appMonitors.appInstallId, row.id));
    expect(mon!.status).toBe("down");
  });

  it("app_slow needs the whole window slow, and resolves when a fast answer arrives", async () => {
    const row = await install();
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_slow", { comparator: "gt", threshold: 1000, durationSeconds: 600 });
    // The tick's own (instant) probe would be the latest sample; start from a clean history.
    await handle.db.delete(appHealthSamples).where(eq(appHealthSamples.appInstallId, row.id));
    for (let back = 0; back <= 660; back += 60) {
      await handle.db.insert(appHealthSamples).values({
        appInstallId: row.id,
        ts: new Date(Date.now() - back * 1000 - 1000),
        kind: "http",
        ok: true,
        statusCode: 200,
        latencyMs: 2500,
      });
    }
    await evaluator.evaluate();
    await evaluator.evaluate();
    expect((await openAlerts(rule.id))[0]?.state).toBe("firing");
    expect(edges(rule.id, "alert.firing")).toHaveLength(1);

    await handle.db.insert(appHealthSamples).values({
      appInstallId: row.id,
      kind: "http",
      ok: true,
      statusCode: 200,
      latencyMs: 120,
    });
    await evaluator.evaluate();
    expect(await openAlerts(rule.id)).toHaveLength(0);
  });

  it("app_slow is only pending while the window is not yet covered", async () => {
    const row = await install();
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_slow", { comparator: "gt", threshold: 1000, durationSeconds: 900 });
    await handle.db.delete(appHealthSamples).where(eq(appHealthSamples.appInstallId, row.id));
    await handle.db.insert(appHealthSamples).values({
      appInstallId: row.id,
      kind: "http",
      ok: true,
      statusCode: 200,
      latencyMs: 4000,
    });
    await evaluator.evaluate();
    const [open] = await openAlerts(rule.id);
    expect(open?.state).toBe("pending");
    expect(edges(rule.id, "alert.firing")).toHaveLength(0);
  });

  it("app_restart_loop fires on restarts inside the window and dedups", async () => {
    const row = await install({ appId: "ghost" });
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_restart_loop", { threshold: 3, durationSeconds: 900 });
    await containerSample(row.id, 600, { restartCount: 1 });
    await containerSample(row.id, 300, { restartCount: 3 });
    // Through the real writer, as a poll would record it.
    await monitor.recordContainers({ install: row }, [
      container({ restart_count: 5, status: "Restarting (1) 2 seconds ago", state: "restarting" }),
      container({ role: "db" }),
    ]);
    await evaluator.evaluate();
    await evaluator.evaluate();
    const open = await openAlerts(rule.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.value).toBe(4);
    expect(edges(rule.id, "alert.firing")).toHaveLength(1);
  });

  it("app_container_unhealthy fires when a container stays exited or unhealthy, then resolves", async () => {
    const row = await install({ appId: "ghost" });
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_container_unhealthy", {
      comparator: "gt",
      threshold: 0,
      durationSeconds: 240,
    });
    for (const back of [300, 240, 180, 120, 60, 1]) {
      await containerSample(row.id, back, { containersRunning: 2, containersUnhealthy: 1 });
    }
    await evaluator.evaluate();
    expect((await openAlerts(rule.id))[0]?.state).toBe("firing");

    await monitor.recordContainers({ install: row }, [container(), container({ role: "db", status: "Up 1 hour (healthy)" })]);
    await evaluator.evaluate();
    expect(await openAlerts(rule.id)).toHaveLength(0);
  });

  it("app_memory and app_cpu compare the summed containers over the window", async () => {
    const row = await install({ appId: "ghost" });
    await monitor.tick({ containers: false });
    for (const back of [700, 600, 450, 300, 150, 1]) {
      await containerSample(row.id, back, { memoryBytes: 950, memoryLimit: 1000, cpuPercent: 40 });
    }
    const memory = await only(row.id, "app_memory", { comparator: "gt", threshold: 90, durationSeconds: 600 });
    await evaluator.evaluate();
    expect((await openAlerts(memory.id))[0]?.state).toBe("firing");

    const cpu = await only(row.id, "app_cpu", { comparator: "gt", threshold: 90, durationSeconds: 600 });
    await evaluator.evaluate();
    expect(await openAlerts(cpu.id)).toHaveLength(0);
  });

  it("app_cert_expiring opens on the app without sending a second notification", async () => {
    const [cert] = await handle.db
      .insert(certificates)
      .values({
        serverId,
        subject: "cert.health.test",
        status: "active",
        expiresAt: new Date(Date.now() + 5 * 24 * 3_600_000),
      })
      .returning();
    const row = await install({ ssl: true, certificateId: cert!.id });
    await monitor.tick({ containers: false });
    const rule = await only(row.id, "app_cert_expiring");
    await evaluator.evaluate();
    const [open] = await openAlerts(rule.id);
    expect(open?.value).toBe(4);
    expect(edges(rule.id, "alert.firing")[0]!.data).toMatchObject({ notify: false });
  });

  it("server rules keep working beside app rules", async () => {
    await handle.db.update(alertRules).set({ enabled: false });
    await handle.db.insert(alertRules).values({
      name: "cpu",
      metric: "cpu",
      comparator: "gt",
      threshold: 99,
      durationSeconds: 60,
      severity: "warning",
      scope: { kind: "fleet" },
    });
    await expect(evaluator.evaluate()).resolves.toBeUndefined();
  });
});

describe("container summaries", () => {
  it("reads the healthcheck from docker's status line and sums the stats", () => {
    expect(healthOf("Up 2 hours (healthy)")).toBe("healthy");
    expect(healthOf("Up 5 seconds (health: starting)")).toBe("starting");
    expect(healthOf("Up 1 minute (unhealthy)")).toBe("unhealthy");
    expect(healthOf("Exited (1) 3 minutes ago")).toBe("none");
    const s = summariseContainers([
      container({ status: "Up 1 minute (unhealthy)", restart_count: 2 }),
      container({ role: "db", state: "exited", cpu_percent: null, memory_usage: null, memory_limit: null }),
    ]);
    expect(s).toMatchObject({ total: 2, running: 1, unhealthy: 1, restartCount: 2, cpuPercent: 1, memoryBytes: 100 });
  });
});

/* ------------------------------------------------------------------ */

describe("ownership", () => {
  let owner = "";
  let alice = "";
  let bob = "";
  let aliceInstall = "";
  let bobInstall = "";

  beforeAll(async () => {
    owner = await login(OWNER_EMAIL, OWNER_PASSWORD);
    const reseller = await call(owner, "POST", "/resellers", {
      email: "reseller@apphealth.test",
      name: "Northwind Hosting",
      server_ids: [serverId],
      send_invite: false,
    });
    expect(reseller.statusCode).toBe(201);
    const resellerCookie = await activate("reseller@apphealth.test", data(reseller).invite.url);
    const a = await call(resellerCookie, "POST", "/reseller/clients", {
      email: "alice@apphealth.test",
      name: "Alice",
      send_invite: false,
    });
    const b = await call(resellerCookie, "POST", "/reseller/clients", {
      email: "bob@apphealth.test",
      name: "Bob",
      send_invite: false,
    });
    alice = await activate("alice@apphealth.test", data(a).invite.url);
    bob = await activate("bob@apphealth.test", data(b).invite.url);
    aliceInstall = (await install({ createdBy: data(a).id })).id;
    bobInstall = (await install({ createdBy: data(b).id })).id;
    await handle.db.update(alertRules).set({ enabled: true });
    await monitor.tick({ containers: false });
  });

  it("shows a client only its own apps' health", async () => {
    const list = await call(alice, "GET", "/apps/health");
    expect(list.statusCode).toBe(200);
    const ids = data<{ install_id: string }[]>(list).map((r) => r.install_id);
    expect(ids).toEqual([aliceInstall]);

    const mine = await call(alice, "GET", `/apps/installs/${aliceInstall}/health`);
    expect(mine.statusCode).toBe(200);
    expect(data(mine)).toMatchObject({ install_id: aliceInstall, status: "up", can_manage: true });
    expect(data(mine).rules.map((r: { metric: string }) => r.metric)).toEqual(["app_down"]);

    expect((await call(alice, "GET", `/apps/installs/${bobInstall}/health`)).statusCode).toBe(404);
    expect((await call(bob, "GET", `/apps/installs/${aliceInstall}/health`)).statusCode).toBe(404);
    expect(data<{ install_id: string }[]>(await call(bob, "GET", "/apps/health")).map((r) => r.install_id)).toEqual([
      bobInstall,
    ]);
    const all = data<{ install_id: string }[]>(await call(owner, "GET", "/apps/health")).map((r) => r.install_id);
    expect(all).toEqual(expect.arrayContaining([aliceInstall, bobInstall]));
  });

  it("lets a client tune and mute its own app's rules, and nobody else's", async () => {
    const [rule] = await rulesOf(aliceInstall);
    const tuned = await call(alice, "PATCH", `/apps/installs/${aliceInstall}/alert-rules/${rule!.id}`, {
      threshold: 5,
      enabled: false,
    });
    expect(tuned.statusCode).toBe(200);
    expect(data(tuned)).toMatchObject({ threshold: 5, enabled: false, app_install_id: aliceInstall });

    // Routing stays the operator's: there is no per-user channel to choose.
    const channels = await call(alice, "PATCH", `/apps/installs/${aliceInstall}/alert-rules/${rule!.id}`, {
      channels: [],
    });
    expect(channels.statusCode).toBe(422);

    const [bobRule] = await rulesOf(bobInstall);
    expect(
      (await call(alice, "PATCH", `/apps/installs/${bobInstall}/alert-rules/${bobRule!.id}`, { enabled: false }))
        .statusCode,
    ).toBe(404);
    // A rule id from another app under one's own install is not found either.
    expect(
      (await call(alice, "PATCH", `/apps/installs/${aliceInstall}/alert-rules/${bobRule!.id}`, { enabled: false }))
        .statusCode,
    ).toBe(404);

    const added = await call(alice, "POST", `/apps/installs/${aliceInstall}/alert-rules`, { kind: "app_slow" });
    expect(added.statusCode).toBe(201);
    const container = await call(alice, "POST", `/apps/installs/${aliceInstall}/alert-rules`, { kind: "app_cpu" });
    expect(container.statusCode).toBe(422);

    const path = await call(alice, "PATCH", `/apps/installs/${aliceInstall}/monitor`, { probe_path: "/health" });
    expect(path.statusCode).toBe(200);
    expect(data(path).probe.path).toBe("/health");
    expect(
      (await call(alice, "PATCH", `/apps/installs/${aliceInstall}/monitor`, { probe_path: "https://evil.test/" }))
        .statusCode,
    ).toBe(422);
  });

  it("keeps Monitoring operator-only, with every app's alerts filterable by app", async () => {
    expect((await call(alice, "GET", "/monitoring/alerts")).statusCode).toBe(403);
    expect((await call(alice, "GET", "/monitoring/alert-rules")).statusCode).toBe(403);

    const rules = await call(owner, "GET", `/monitoring/alert-rules?app_install_id=${bobInstall}`);
    expect(rules.statusCode).toBe(200);
    const listed = data<{ app_install_id: string; app_name: string }[]>(rules);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((r) => r.app_install_id === bobInstall)).toBe(true);
    expect(listed[0]!.app_name).toMatch(/^WordPress on /);

    const any = data<{ app_install_id: string | null }[]>(
      await call(owner, "GET", "/monitoring/alert-rules?app_install_id=any&per_page=100"),
    );
    expect(any.every((r) => r.app_install_id !== null)).toBe(true);

    // An app kind is refused on a server scope, and the reverse.
    const crossed = await call(owner, "POST", "/monitoring/alert-rules", {
      name: "x",
      metric: "app_down",
      comparator: "gte",
      threshold: 3,
      duration_seconds: 0,
      severity: "critical",
      scope: { kind: "fleet" },
    });
    expect(crossed.statusCode).toBe(422);
  });
});
