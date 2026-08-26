import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { roleGrants, roles, userRoles, users } from "@kaname/db/schema";
import type { Permission } from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * RBAC, exercised through the real API.
 *
 * Per-permission, per-server scoping is the thing several competing
 * panels get wrong with a single admin flag, so it is worth proving
 * rather than asserting: a scoped principal must not see, act on, or
 * even learn about servers outside its grant.
 * ------------------------------------------------------------------ */

const OWNER_PASSWORD = "kaname-rbac-test-owner";
const SCOPED_PASSWORD = "kaname-rbac-test-scoped";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;

let ownerCookie: string;
let scopedCookie: string;
let scopedServerId: string;
let otherServerId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Injected = Promise<LightMyRequestResponse>;

function as(cookie: string) {
  return {
    get: (url: string): Injected => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload: Record<string, unknown> = {}): Injected =>
      app.inject({ method: "POST", url, headers: { cookie }, payload }),
    del: (url: string): Injected => app.inject({ method: "DELETE", url, headers: { cookie } }),
  };
}

/** Creates a role scoped to exactly one server and a user holding it. */
async function createScopedPrincipal(serverId: string, permissions: Permission[]): Promise<void> {
  const [role] = await handle.db
    .insert(roles)
    .values({
      name: "Scoped Developer",
      slug: "scoped-developer",
      description: "Only web-scope permissions, and only on one server.",
      isSystem: false,
    })
    .returning({ id: roles.id });

  await handle.db.insert(roleGrants).values(
    permissions.map((permission) => ({
      roleId: role!.id,
      permission,
      scope: { kind: "servers" as const, server_ids: [serverId] },
    })),
  );

  const [user] = await handle.db
    .insert(users)
    .values({
      email: "scoped@kaname.test",
      name: "Scoped User",
      passwordHash: await ctx.auth.hashPassword(SCOPED_PASSWORD),
      status: "active",
    })
    .returning({ id: users.id });

  await handle.db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
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

  const all = JSON.parse((await as(ownerCookie).get("/api/v1/servers")).body).data as {
    id: string;
    name: string;
  }[];
  scopedServerId = all.find((s) => s.name === "forge-01")!.id;
  otherServerId = all.find((s) => s.name === "mail-01")!.id;

  await createScopedPrincipal(scopedServerId, [
    "infra.servers:read",
    "infra.services:read",
    "infra.services:exec",
    "websites.sites:read",
    "logs.streams:read",
  ]);
  scopedCookie = await login("scoped@kaname.test", SCOPED_PASSWORD);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

describe("a server-scoped role", () => {
  it("sees only the servers it is scoped to", async () => {
    const res = await as(scopedCookie).get("/api/v1/servers");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(scopedServerId);
    // The count must agree with the rows, or pagination leaks the total.
    expect(body.meta.total).toBe(1);
  });

  it("cannot read a server outside its scope", async () => {
    const res = await as(scopedCookie).get(`/api/v1/servers/${otherServerId}`);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("forbidden");
  });

  it("can read the server it is scoped to", async () => {
    const res = await as(scopedCookie).get(`/api/v1/servers/${scopedServerId}`);
    expect(res.statusCode).toBe(200);
  });

  it("cannot act on a server outside its scope", async () => {
    const res = await as(scopedCookie).post(`/api/v1/servers/${otherServerId}/sync`);
    expect(res.statusCode).toBe(403);
  });

  it("is refused a permission it was never granted, even in scope", async () => {
    const res = await as(scopedCookie).post(`/api/v1/servers/${scopedServerId}/reboot`, {
      delay_seconds: 0,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.message).toContain("infra.servers:write");
  });

  it("cannot open a terminal without terminal.session:exec", async () => {
    const res = await as(scopedCookie).post("/api/v1/terminal/sessions", {
      server_id: scopedServerId,
      cols: 80,
      rows: 24,
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot reach administration at all", async () => {
    for (const url of ["/api/v1/users", "/api/v1/roles", "/api/v1/api-keys", "/api/v1/settings"]) {
      const res = await as(scopedCookie).get(url);
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("cannot read the audit trail", async () => {
    expect((await as(scopedCookie).get("/api/v1/audit")).statusCode).toBe(403);
  });

  it("scopes derived resources too, not just servers", async () => {
    const services = await as(scopedCookie).get("/api/v1/services");
    expect(services.statusCode).toBe(200);
    const rows = JSON.parse(services.body).data as { server_id: string }[];
    expect(rows.every((r) => r.server_id === scopedServerId)).toBe(true);

    const sites = await as(scopedCookie).get("/api/v1/sites");
    expect(sites.statusCode).toBe(200);
    const siteRows = JSON.parse(sites.body).data as { server_id: string }[];
    expect(siteRows.every((r) => r.server_id === scopedServerId)).toBe(true);
  });

  it("reports its own effective grants honestly", async () => {
    const res = await as(scopedCookie).get("/api/v1/auth/session");
    const grants = JSON.parse(res.body).data.permissions as {
      permission: string;
      scope: { kind: string; server_ids?: string[] };
    }[];

    expect(grants).toHaveLength(5);
    for (const grant of grants) {
      expect(grant.scope.kind).toBe("servers");
      expect(grant.scope.server_ids).toEqual([scopedServerId]);
    }
  });
});

describe("the owner", () => {
  it("sees the whole fleet", async () => {
    const res = await as(ownerCookie).get("/api/v1/servers");
    expect(JSON.parse(res.body).data.length).toBe(4);
  });

  it("can act anywhere", async () => {
    expect((await as(ownerCookie).post(`/api/v1/servers/${otherServerId}/sync`)).statusCode).toBe(
      202,
    );
  });
});

describe("system role integrity", () => {
  it("refuses to delete a system role", async () => {
    const list = JSON.parse((await as(ownerCookie).get("/api/v1/roles")).body).data as {
      id: string;
      slug: string;
      is_system: boolean;
    }[];
    const owner = list.find((r) => r.slug === "owner")!;
    expect(owner.is_system).toBe(true);

    const res = await as(ownerCookie).del(`/api/v1/roles/${owner.id}`);
    expect([403, 409, 412]).toContain(res.statusCode);
  });

  it("keeps the seeded system roles in place after bootstrap re-runs", async () => {
    await bootstrap(ctx);
    const slugs = (
      JSON.parse((await as(ownerCookie).get("/api/v1/roles")).body).data as { slug: string }[]
    ).map((r) => r.slug);
    for (const slug of ["owner", "operator", "developer", "auditor", "viewer"]) {
      expect(slugs).toContain(slug);
    }

    // Re-running bootstrap must not detach the owner from their role.
    const owner = await handle.db
      .select()
      .from(users)
      .where(eq(users.email, "owner@kaname.test"))
      .limit(1);
    expect(owner[0]).toBeTruthy();
    expect((await as(ownerCookie).get("/api/v1/servers")).statusCode).toBe(200);
  });
});
