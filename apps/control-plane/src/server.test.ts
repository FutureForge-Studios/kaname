import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createDb, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { NAV_LEAVES } from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * End-to-end API surface test.
 *
 * Boots the real control plane against an in-memory Postgres with the
 * demo fleet loaded, then walks the API the way the panel does. No
 * agent is connected, so this also pins the "the box is unreachable"
 * behaviour: reads of cached state still work, and host-touching
 * mutations queue rather than fail (KD-008).
 * ------------------------------------------------------------------ */

const PASSWORD = "kaname-integration-test-password";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: PASSWORD,
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

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@kaname.test", password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  expect(cookie).not.toBe("");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

function get(url: string, withAuth = true) {
  return app.inject({ method: "GET", url, headers: withAuth ? { cookie } : {} });
}

async function serverId(): Promise<string> {
  const res = await get("/api/v1/servers");
  return JSON.parse(res.body).data[0].id as string;
}

describe("health and auth", () => {
  it("reports health without a session", async () => {
    const res = await get("/health", false);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("refuses the API without a session", async () => {
    const res = await get("/api/v1/servers", false);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("unauthenticated");
  });

  it("rejects a wrong password without leaking whether the account exists", async () => {
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "owner@kaname.test", password: "not-it" },
    });
    const noSuchUser = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@kaname.test", password: "not-it" },
    });
    expect(wrongPassword.statusCode).toBe(noSuchUser.statusCode);
    expect(JSON.parse(wrongPassword.body).error.message).toBe(
      JSON.parse(noSuchUser.body).error.message,
    );
  });

  it("returns the session with the caller's effective permissions", async () => {
    const res = await get("/api/v1/auth/session");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).data;
    expect(body.user.email).toBe("owner@kaname.test");
    const granted = body.permissions.map((g: { permission: string }) => g.permission);
    expect(granted).toContain("infra.servers:read");
    // Owner is global everywhere, which is what makes the scope check meaningful elsewhere.
    expect(
      body.permissions.every((g: { scope: { kind: string } }) => g.scope.kind === "global"),
    ).toBe(true);
  });

  it("404s an unknown route with the standard envelope", async () => {
    const res = await get("/api/v1/nope");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
  });
});

describe("the seeded fleet is readable", () => {
  it("lists servers with both status axes", async () => {
    const res = await get("/api/v1/servers");
    expect(res.statusCode).toBe(200);
    const { data, meta } = JSON.parse(res.body);
    expect(data.length).toBe(4);
    expect(meta.total).toBe(4);

    for (const server of data) {
      expect(server).toHaveProperty("connection");
      expect(server).toHaveProperty("health");
      expect(server.simulated).toBe(true);
    }
  });

  it("searches, sorts and paginates consistently", async () => {
    const search = await get("/api/v1/servers?q=mail");
    expect(JSON.parse(search.body).data).toHaveLength(1);

    const paged = await get("/api/v1/servers?per_page=2&page=1&sort=name&order=asc");
    const body = JSON.parse(paged.body);
    expect(body.data).toHaveLength(2);
    expect(body.meta.has_more).toBe(true);
    expect(body.data[0].name < body.data[1].name).toBe(true);
  });

  it("returns metric history for a server", async () => {
    const res = await get(`/api/v1/servers/${await serverId()}/metrics?range=24h`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.samples.length).toBeGreaterThan(0);
  });

  it("404s a server that does not exist", async () => {
    const res = await get("/api/v1/servers/00000000-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(404);
  });

  it("rejects a malformed id with a field error rather than a 500", async () => {
    const res = await get("/api/v1/servers/not-a-uuid");
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.fields).toBeDefined();
  });
});

describe("every list endpoint answers", () => {
  const endpoints = [
    "/api/v1/dashboard",
    "/api/v1/servers",
    "/api/v1/services",
    "/api/v1/containers",
    "/api/v1/sites",
    "/api/v1/domains",
    "/api/v1/certificates",
    "/api/v1/deployments",
    "/api/v1/ftp-accounts",
    "/api/v1/mailboxes",
    "/api/v1/mail-aliases",
    "/api/v1/mail-forwarders",
    "/api/v1/db-instances",
    "/api/v1/databases",
    "/api/v1/db-users",
    "/api/v1/firewall",
    "/api/v1/threats",
    "/api/v1/ssh/keys",
    "/api/v1/audit",
    "/api/v1/backups/destinations",
    "/api/v1/backups/schedules",
    "/api/v1/backups/runs",
    "/api/v1/backups/restore-points",
    "/api/v1/monitoring/overview",
    // Aggregation-heavy endpoints get their own entries: a GROUP BY that
    // does not match its SELECT expression only fails at runtime.
    "/api/v1/monitoring/series?metric=cpu&range=24h",
    "/api/v1/threats/summary",
    "/api/v1/threats/summary?window=7d",
    "/api/v1/certificates/expiring",
    "/api/v1/jobs",
    "/api/v1/users",
    "/api/v1/roles",
    "/api/v1/api-keys",
    "/api/v1/settings",
  ];

  for (const url of endpoints) {
    it(url, async () => {
      const res = await get(url);
      expect(res.statusCode, `${url} → ${res.body.slice(0, 300)}`).toBe(200);
      expect(JSON.parse(res.body)).toHaveProperty("data");
    });
  }

  // Server-scoped reads take the id in the query, and are expected to
  // insist on it rather than quietly answering for the whole fleet.
  it("/api/v1/storage requires a server and then answers", async () => {
    const missing = await get("/api/v1/storage");
    expect(missing.statusCode).toBe(422);
    expect(JSON.parse(missing.body).error.fields.server_id).toBeTruthy();

    const scoped = await get(`/api/v1/storage?server_id=${await serverId()}`);
    expect(scoped.statusCode, scoped.body.slice(0, 300)).toBe(200);
    const breakdown = JSON.parse(scoped.body).data;
    expect(breakdown.used_percent).toBeGreaterThan(0);
    expect(breakdown.categories.length).toBeGreaterThan(0);
  });
});

describe("mutations that reach a host become jobs", () => {
  it("queues a service restart instead of failing when the agent is offline", async () => {
    const id = await serverId();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/servers/${id}/sync`,
      headers: { cookie },
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const job = JSON.parse(res.body).data.job;
    expect(job.status).toBe("queued");
    expect(job.type).toBe("system.sync");
    expect(job.server_id).toBe(id);
  });

  it("records an audit entry for the request", async () => {
    const res = await get("/api/v1/audit?per_page=10");
    const { data } = JSON.parse(res.body);
    expect(data.some((e: { action: string }) => e.action.endsWith(".requested"))).toBe(true);
  });

  it("keeps the audit chain verified after all of the above", async () => {
    const res = await get("/api/v1/audit/verify");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).data;
    expect(body.verified).toBe(true);
    expect(body.events_checked).toBeGreaterThan(0);
  });
});

describe("live reads degrade honestly", () => {
  it("returns agent_offline with remediation, not a timeout", async () => {
    const res = await get(`/api/v1/processes?server_id=${await serverId()}`);
    expect(res.statusCode).toBe(503);
    const error = JSON.parse(res.body).error;
    expect(error.code).toBe("agent_offline");
    expect(error.remediation.summary).toBeTruthy();
  });
});

describe("navigation and search", () => {
  it("exposes a route for every navigation leaf", () => {
    for (const leaf of NAV_LEAVES) {
      expect(leaf.href.startsWith("/")).toBe(true);
      expect(leaf.permission).toMatch(/^[a-z_]+\.[a-z_]+:/);
    }
  });

  it("finds resources and offers actions from one query", async () => {
    const res = await get("/api/v1/search?q=mail");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body).data;
    const hits = body.groups.flatMap((g: { results: unknown[] }) => g.results);
    expect(hits.length).toBeGreaterThan(0);
    expect(Array.isArray(body.actions)).toBe(true);
  });
});
