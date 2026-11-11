import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { auditEvents, jobs, roleGrants, roles, userRoles, users } from "@kaname/db/schema";
import type {
  CommandCenterSummary,
  OsUpdatesFleet,
  Permission,
  ServerOsUpdates,
} from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import { AgentRpcError } from "./agent/hub.js";
import {
  OsUpdateScheduler,
  REFRESH_AFTER_MS,
  loadOne,
  recordUpgrade,
  saveOsUpdates,
} from "./services/os-updates.js";

/* ------------------------------------------------------------------ *
 * Operating-system updates.
 *
 * What this defends: pages read a cache and never fan a package-manager
 * run across the fleet; upgrading is a job, audited, and refused to a
 * role that may only look; and "reboot required" is cleared by a boot,
 * not by time passing.
 * ------------------------------------------------------------------ */

const OWNER_PASSWORD = "kaname-os-updates-owner";
const VIEWER_PASSWORD = "kaname-os-updates-viewer";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let ownerCookie: string;
let viewerCookie: string;
let forge: string;
let mail: string;

const PACKAGES = [
  { name: "openssl", installed_version: "3.0.2-0ubuntu1.14", available_version: "3.0.2-0ubuntu1.15", security: true },
  { name: "curl", installed_version: "7.81.0-1ubuntu1.15", available_version: "7.81.0-1ubuntu1.16", security: false },
  { name: "bash", installed_version: "5.1-6ubuntu1", available_version: null, security: false },
];

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function as(cookie: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: "POST", url, headers: { cookie }, payload }),
    patch: (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: "PATCH", url, headers: { cookie }, payload }),
  };
}

function data<T>(res: LightMyRequestResponse): T {
  return (JSON.parse(res.body) as { data: T }).data;
}

async function createViewer(permissions: Permission[]): Promise<void> {
  const [role] = await handle.db
    .insert(roles)
    .values({ name: "Looker", slug: "looker", description: "Reads servers.", isSystem: false })
    .returning({ id: roles.id });
  await handle.db
    .insert(roleGrants)
    .values(permissions.map((permission) => ({ roleId: role!.id, permission, scope: { kind: "global" as const } })));
  const [user] = await handle.db
    .insert(users)
    .values({
      email: "looker@kaname.test",
      name: "Looker",
      passwordHash: await ctx.auth.hashPassword(VIEWER_PASSWORD),
      status: "active",
    })
    .returning({ id: users.id });
  await handle.db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
}

/** Stands in for a connected agent answering the two package verbs. */
function fakeAgent(opts: { connected?: string[]; bootTime?: string; listError?: Error } = {}) {
  const connected = new Set(opts.connected ?? [forge]);
  vi.spyOn(ctx.hub, "isConnected").mockImplementation((id) => connected.has(id));
  const call = vi.spyOn(ctx.hub, "call").mockImplementation((async (
    serverId: string,
    method: string,
  ) => {
    if (!connected.has(serverId)) throw new Error("offline");
    if (method === "system.packages.list") {
      if (opts.listError) throw opts.listError;
      return { packages: PACKAGES };
    }
    if (method === "system.info") return { boot_time: opts.bootTime ?? "2020-01-01T00:00:00Z" };
    throw new Error(`unexpected ${method}`);
  }) as never);
  return call;
}

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: OWNER_PASSWORD,
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);
  await seedDemo(handle.db);

  app = await buildServer(ctx);
  await app.ready();

  ownerCookie = await login("owner@kaname.test", OWNER_PASSWORD);
  const all = data<{ id: string; name: string }[]>(await as(ownerCookie).get("/api/v1/servers"));
  forge = all.find((s) => s.name === "forge-01")!.id;
  mail = all.find((s) => s.name === "mail-01")!.id;

  await createViewer(["infra.servers:read"]);
  viewerCookie = await login("looker@kaname.test", VIEWER_PASSWORD);
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

describe("listing and the cache", () => {
  it("reports a host that was never checked as unknown, without calling it", async () => {
    const call = fakeAgent();
    const res = await as(ownerCookie).get(`/api/v1/servers/${mail}/os-updates`);
    expect(res.statusCode, res.body).toBe(200);
    const body = data<ServerOsUpdates>(res);
    expect(body.state).toBe("unknown");
    expect(body.packages).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses a live refresh of a host that is not connected", async () => {
    fakeAgent({ connected: [] });
    const res = await as(ownerCookie).post(`/api/v1/servers/${mail}/os-updates/refresh`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(res.body).error.code).toBe("agent_offline");
  });

  it("caches a refresh: upgradable packages only, security first", async () => {
    const call = fakeAgent();
    const res = await as(ownerCookie).post(`/api/v1/servers/${forge}/os-updates/refresh`);
    expect(res.statusCode, res.body).toBe(200);
    const body = data<ServerOsUpdates>(res);
    expect(body.state).toBe("pending");
    expect(body.packages.map((p) => p.name)).toEqual(["openssl", "curl"]);
    expect(body.total).toBe(2);
    expect(body.security).toBe(1);
    expect(call).toHaveBeenCalledWith(
      forge,
      "system.packages.list",
      { upgradable_only: true },
      expect.anything(),
    );

    // Reading serves the cache; a second refresh right away does too.
    call.mockClear();
    const read = data<ServerOsUpdates>(await as(ownerCookie).get(`/api/v1/servers/${forge}/os-updates`));
    expect(read.packages).toHaveLength(2);
    await as(ownerCookie).post(`/api/v1/servers/${forge}/os-updates/refresh`);
    expect(call).not.toHaveBeenCalled();
  });

  it("records a host without a package manager as unsupported", async () => {
    fakeAgent({
      connected: [mail],
      listError: new AgentRpcError({ code: "unsupported", message: "no supported package manager" }),
    });
    const res = await as(ownerCookie).post(`/api/v1/servers/${mail}/os-updates/refresh`);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<ServerOsUpdates>(res).state).toBe("unsupported");
  });

  it("summarises the fleet from the cache", async () => {
    const call = fakeAgent();
    const res = await as(ownerCookie).get("/api/v1/os-updates");
    expect(res.statusCode, res.body).toBe(200);
    const fleet = data<OsUpdatesFleet>(res);
    expect(fleet.totals.servers_with_updates).toBe(1);
    expect(fleet.totals.servers_with_security_updates).toBe(1);
    expect(fleet.totals.security).toBe(1);
    expect(fleet.totals.packages).toBe(2);
    expect(fleet.servers.find((s) => s.server_id === forge)?.total).toBe(2);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("upgrading", () => {
  it("enqueues a security-only upgrade as an audited job", async () => {
    fakeAgent();
    const res = await as(ownerCookie).post(`/api/v1/servers/${forge}/os-updates/upgrade`, {
      security_only: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    const job = data<{ job: { id: string; type: string } }>(res).job;
    expect(job.type).toBe("system.packages.upgrade");

    const row = (await handle.db.select().from(jobs).where(eq(jobs.id, job.id)))[0]!;
    expect(row.params).toEqual({ names: [], security_only: true });

    const audit = await handle.db.select().from(auditEvents).where(eq(auditEvents.jobId, job.id));
    expect(audit[0]?.action).toBe("system.packages.upgrade.requested");
  });

  it("fans a bulk upgrade out under one correlation id", async () => {
    fakeAgent({ connected: [forge, mail] });
    const res = await as(ownerCookie).post("/api/v1/os-updates/upgrade", {
      server_ids: [forge, mail],
    });
    expect(res.statusCode, res.body).toBe(202);
    const body = data<{ correlation_id: string; jobs: { server_id: string }[] }>(res);
    expect(body.jobs).toHaveLength(2);
  });

  it("refuses a role that may only read servers", async () => {
    fakeAgent();
    const read = await as(viewerCookie).get(`/api/v1/servers/${forge}/os-updates`);
    expect(read.statusCode, read.body).toBe(200);

    const before = (await handle.db.select().from(jobs)).length;
    const one = await as(viewerCookie).post(`/api/v1/servers/${forge}/os-updates/upgrade`, {});
    expect(one.statusCode).toBe(403);
    const bulk = await as(viewerCookie).post("/api/v1/os-updates/upgrade", { server_ids: [forge] });
    expect(bulk.statusCode).toBe(403);
    const toggle = await as(viewerCookie).patch(`/api/v1/servers/${forge}/os-updates/settings`, {
      auto_security: true,
    });
    expect(toggle.statusCode).toBe(403);
    expect((await handle.db.select().from(jobs)).length).toBe(before);
  });

  it("remembers a reboot the upgrade asked for until the host has booted", async () => {
    fakeAgent({ bootTime: "2020-01-01T00:00:00Z" });
    await recordUpgrade(ctx, forge, { upgraded: ["openssl"], reboot_required: true });
    const pending = await loadOne(handle.db, forge);
    expect(pending.reboot_required).toBe(true);
    expect(pending.last_upgrade_at).not.toBeNull();

    // A refresh before any reboot keeps it.
    await saveOsUpdates(handle.db, forge, { checked_at: null });
    vi.restoreAllMocks();
    fakeAgent({ bootTime: "2020-01-01T00:00:00Z" });
    await as(ownerCookie).post(`/api/v1/servers/${forge}/os-updates/refresh`);
    expect((await loadOne(handle.db, forge)).reboot_required).toBe(true);

    // A boot after the upgrade clears it.
    await saveOsUpdates(handle.db, forge, { checked_at: null });
    vi.restoreAllMocks();
    fakeAgent({ bootTime: new Date(Date.now() + 60_000).toISOString() });
    await as(ownerCookie).post(`/api/v1/servers/${forge}/os-updates/refresh`);
    expect((await loadOne(handle.db, forge)).reboot_required).toBe(false);
  });
});

describe("the background pass", () => {
  it("refreshes only stale caches and applies automatic security updates once", async () => {
    const call = fakeAgent();
    await saveOsUpdates(handle.db, forge, { checked_at: new Date().toISOString() });

    const fresh = new OsUpdateScheduler(ctx);
    const first = await fresh.tick();
    expect(first.refreshed).toEqual([]);
    expect(first.auto).toEqual([]);
    expect(call).not.toHaveBeenCalled();

    // Opt in, and let the cache age past the cadence.
    const toggled = await as(ownerCookie).patch(`/api/v1/servers/${forge}/os-updates/settings`, {
      auto_security: true,
    });
    expect(toggled.statusCode, toggled.body).toBe(200);
    // Earlier tests queued upgrades for forge; clear them so the "nothing in flight" rule passes.
    await handle.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.serverId, forge));

    const later = new OsUpdateScheduler(ctx, {
      now: () => new Date(Date.now() + REFRESH_AFTER_MS + 60_000),
    });
    await saveOsUpdates(handle.db, forge, {
      checked_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const second = await later.tick();
    expect(second.refreshed).toEqual([forge]);
    expect(second.auto).toHaveLength(1);

    const job = (await handle.db.select().from(jobs).where(eq(jobs.id, second.auto[0]!.jobId)))[0]!;
    expect(job.type).toBe("system.packages.upgrade");
    expect(job.params).toEqual({ names: [], security_only: true });

    // Not again the same day, even with the job finished.
    await handle.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, job.id));
    const third = await later.tick();
    expect(third.auto).toEqual([]);
  });
});

describe("Command Center", () => {
  it("lists servers with pending security updates under Needs attention", async () => {
    fakeAgent();
    const res = await as(ownerCookie).get("/api/v1/dashboard");
    expect(res.statusCode, res.body).toBe(200);
    const summary = data<CommandCenterSummary>(res);
    const row = summary.attention.find(
      (a) => a.kind === "os_updates" && a.title.includes("security"),
    );
    expect(row?.server_id).toBe(forge);
    expect(row?.href).toBe(`/infrastructure/servers/${forge}?tab=updates`);
  });
});
