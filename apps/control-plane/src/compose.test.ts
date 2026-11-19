import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { appInstalls, auditEvents, jobs, secrets, servers, sites } from "@kaname/db/schema";
import { COMPOSE_APP_ID } from "@kaname/contract";
import { MANAGED_APPS_ROOT } from "@kaname/contract/agent";
import type { AgentHub } from "./agent/hub.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { CONTAINER_TIMING, appJobHandlers } from "./jobs/apps.js";
import type { JobContext } from "./jobs/worker.js";
import { buildServer } from "./server.js";
import { composeEnvRef } from "./services/app-installer.js";

/* ------------------------------------------------------------------ *
 * Docker Compose import (KD-045), end to end through the routes and
 * the install job against a stub agent: what is refused before any
 * row exists, what reaches the host, and that environment values stay
 * sealed — never on the row, in the job's params or in the audit log.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@compose.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const SECRET = "pg-pass-7f3a9c2e";

const COMPOSE = `services:
  web:
    image: ghcr.io/example/app:1.4
    environment:
      DATABASE_URL: postgres://app:${SECRET}@db:5432/app
    ports: ["8080:3000"]
    depends_on: [db]
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${SECRET}
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let owner = "";
let serverId = "";
let counter = 0;

const call = (method: "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie: owner }, payload });

const body = (compose: string) => ({
  app_id: COMPOSE_APP_ID,
  compose,
  server_id: serverId,
  domain: `compose${(counter += 1)}.example.test`,
  admin_email: "ops@example.test",
  ssl: false,
});

/** A stub agent that answers the verbs a compose install uses and remembers each call. */
function fakeHub() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const running = new Set<string>();
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    calls.push({ method, params });
    switch (method) {
      case "container.image.pull":
        return { image: params.image, id: `sha256:${"0".repeat(64)}` };
      case "container.network.create":
        return { name: `kaname-${params.install_id}`, id: "net0", created: true };
      case "container.create":
        running.add(params.role as string);
        return { id: `c-${params.role}`, name: `kaname-${params.install_id}-${params.role}`, state: "running", ports: [] };
      case "container.app.status":
        return {
          containers: [...running].map((role) => ({ role, name: role, state: "running", status: "Up" })),
          endpoints: [{ role: "web", host_port: 20000, container_port: 3000, reachable: true, http_status: 200 }],
        };
      case "container.app.remove": {
        const containers = [...running];
        running.clear();
        return { containers, networks: ["net"], data_removed: true };
      }
      case "site.test_config":
        return { valid: true, output: "ok" };
      default:
        return { ok: true, config_path: "/etc/nginx/sites-available/x" };
    }
  };
  const hub = {
    call: async (_s: string, method: string, params: Record<string, unknown>) => answer(method, params),
    stream: (_s: string, method: string, params: Record<string, unknown>) => {
      const done = (async () => answer(method, params))();
      return { id: "stream", done, cancel: () => undefined };
    },
    isConnected: () => true,
    capabilities: () => ["nginx", "docker"],
  };
  return { calls, hub: hub as unknown as AgentHub };
}

/** Claims the job a route queued and runs it against the stub agent. */
async function runQueued(jobId: string, hub: AgentHub) {
  const claimed = await ctx.queue.claim("test-worker", 60, [serverId]);
  if (!claimed || claimed.id !== jobId) throw new Error(`claimed the wrong job: ${claimed?.type}`);
  const logs: string[] = [];
  const jobCtx: JobContext = {
    ...ctx,
    hub,
    job: claimed,
    signal: new AbortController().signal,
    log_: async (level, message) => {
      logs.push(`${level}: ${message}`);
    },
    progress: async () => undefined,
  };
  let error: unknown = null;
  try {
    await appJobHandlers()[claimed.type as "app.install"]!(jobCtx);
  } catch (err) {
    error = err;
  }
  await ctx.queue.complete(claimed.id, null);
  return { error, logs };
}

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
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
  await seedDemo(handle.db);
  app = await buildServer(ctx);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((c) => c.value)!;
  owner = `${cookie.name}=${cookie.value}`;
  const [forge] = await handle.db.select().from(servers).where(eq(servers.name, "forge-01"));
  serverId = forge!.id;
  CONTAINER_TIMING.verifyAttempts = 1;
  CONTAINER_TIMING.verifyIntervalMs = 0;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

const data = (res: LightMyRequestResponse) => JSON.parse(res.body).data;

describe("compose install", () => {
  it("plans every service and passes the translation's notices on", async () => {
    const res = await call("POST", "/apps/installs/plan", body(COMPOSE));
    expect(res.statusCode, res.body).toBe(200);
    const plan = data(res);
    expect(plan.app_name).toBe("Docker Compose");
    expect(plan.containers).toEqual([
      { role: "db", image: "postgres:16" },
      { role: "web", image: "ghcr.io/example/app:1.4" },
    ]);
    expect(plan.notices.join("\n")).toMatch(/line 6: Host ports aren't published/);
    expect(res.body).not.toContain(SECRET);
  });

  it("installs app + Postgres + a volume, with the environment from the sealed secret, then uninstalls", async () => {
    const res = await call("POST", "/apps/installs", body(COMPOSE));
    expect(res.statusCode, res.body).toBe(202);
    const { job, install } = data(res);
    expect(res.body).not.toContain(SECRET);

    const { calls, hub } = fakeHub();
    const { error, logs } = await runQueued(job.id, hub);
    expect(error).toBeNull();

    const creates = calls.filter((c) => c.method === "container.create").map((c) => c.params);
    expect(creates.map((p) => p.role)).toEqual(["db", "web"]);
    const [db, web] = creates;
    expect(db).toMatchObject({
      install_id: install.id,
      ports: [],
      env: { POSTGRES_PASSWORD: SECRET },
      mounts: [{ source: `${MANAGED_APPS_ROOT}/${install.id}/volumes/pgdata`, target: "/var/lib/postgresql/data", read_only: false }],
    });
    const [row] = await handle.db.select().from(appInstalls).where(eq(appInstalls.id, install.id));
    expect(web).toMatchObject({ ports: [{ container_port: 3000, host_port: row!.appPort }] });
    expect((web!.env as Record<string, string>).DATABASE_URL).toContain(SECRET);

    expect(row!.status).toBe("active");
    expect(row!.appId).toBe(COMPOSE_APP_ID);
    const [site] = await handle.db.select().from(sites).where(eq(sites.id, row!.siteId!));
    expect(site).toMatchObject({ runtime: "container", status: "active" });

    // The value reaches the host only inside the create specs.
    const [jobRow] = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.targetId, install.id));
    expect(audits.length).toBeGreaterThan(0);
    for (const [what, value] of [
      ["inputs", row!.inputs],
      ["row", row],
      ["job params", jobRow!.params],
      ["audit", audits],
      ["logs", logs],
    ] as const) {
      expect(JSON.stringify(value), what).not.toContain(SECRET);
    }
    const [sealed] = await handle.db.select().from(secrets).where(eq(secrets.ref, composeEnvRef(install.id)));
    expect(sealed).toMatchObject({ ownerType: "app_install", ownerId: install.id });

    const removed = await call("DELETE", `/apps/installs/${install.id}`);
    expect(removed.statusCode, removed.body).toBe(202);
    const uninstall = fakeHub();
    expect((await runQueued(data(removed).job.id, uninstall.hub)).error).toBeNull();
    expect(uninstall.calls.map((c) => c.method)).toContain("container.app.remove");
    expect(await handle.db.select().from(appInstalls).where(eq(appInstalls.id, install.id))).toHaveLength(0);
    expect(await handle.db.select().from(secrets).where(eq(secrets.ownerId, install.id))).toHaveLength(0);
  });

  it("starts a service that depends on web after web, and what web depends on before it", async () => {
    const text = `services:
  cache:
    image: redis:7
  web:
    image: nginx:1.27
    ports: ["80"]
    depends_on: [cache]
  worker:
    image: busybox:1.36
    depends_on: [web]
`;
    const res = await call("POST", "/apps/installs", body(text));
    expect(res.statusCode, res.body).toBe(202);
    const { calls, hub } = fakeHub();
    const { error } = await runQueued(data(res).job.id, hub);
    expect(error).toBeNull();
    expect(calls.filter((c) => c.method === "container.create").map((c) => c.params.role)).toEqual(["cache", "web", "worker"]);
    // verify counted all three, so it saw worker running too.
    const [row] = await handle.db.select().from(appInstalls).where(eq(appInstalls.id, data(res).install.id));
    expect(row!.status).toBe("active");
  });

  it.each([
    ["privileged: true", "    privileged: true\n", /line 5: `privileged` isn't allowed/],
    ["the Docker socket", "    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n", /line 6: \/var\/run\/docker\.sock is a host path/],
  ])("refuses %s before anything is created", async (_label, extra, message) => {
    const text = `services:\n  web:\n    image: nginx:1.27\n    ports: ["80"]\n${extra}`;
    const before = (await handle.db.select({ id: appInstalls.id }).from(appInstalls)).length;
    const jobsBefore = (await handle.db.select({ id: jobs.id }).from(jobs)).length;
    for (const url of ["/apps/installs/plan", "/apps/installs"]) {
      const res = await call("POST", url, body(text));
      expect(res.statusCode, res.body).toBe(400);
      expect(JSON.parse(res.body).error.message).toMatch(message);
    }
    expect((await handle.db.select({ id: appInstalls.id }).from(appInstalls)).length).toBe(before);
    expect((await handle.db.select({ id: jobs.id }).from(jobs)).length).toBe(jobsBefore);
  });

  it("refuses to back a compose project up", async () => {
    const [row] = await handle.db
      .insert(appInstalls)
      .values({
        appId: COMPOSE_APP_ID,
        appName: "Docker Compose",
        appVersion: "compose",
        serverId,
        domain: "backup-compose.example.test",
        status: "active",
        appPort: 29990,
        inputs: { admin_email: "ops@example.test", system_user: "www-data", php_version: null },
      })
      .returning();
    const res = await call("POST", `/backups/apps/${row!.id}/run`, {});
    expect(JSON.parse(res.body).error?.message ?? "").toMatch(/Docker Compose projects aren't backed up yet/);
  });
});
