import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createDb, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * A site's git source: set, cleared and validated through PATCH, the
 * way the project page's Settings tab saves it.
 * ------------------------------------------------------------------ */

const PASSWORD = "kaname-sites-test-password";

let handle: DbHandle;
let app: FastifyInstance;
let cookie: string;
let siteId: string;

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
  const ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
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

  const sites = await app.inject({ method: "GET", url: "/api/v1/sites", headers: { cookie } });
  siteId = JSON.parse(sites.body).data[0].id as string;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

function patch(payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/v1/sites/${siteId}`, headers: { cookie }, payload });
}

async function current() {
  const res = await app.inject({ method: "GET", url: `/api/v1/sites/${siteId}`, headers: { cookie } });
  return JSON.parse(res.body).data as { repo_url: string | null; branch: string | null };
}

describe("PATCH /sites/:id git source", () => {
  it("sets the repository and branch", async () => {
    const res = await patch({ repo_url: "https://github.com/acme/shop.git", branch: "release/1.0" });
    expect(res.statusCode, res.body).toBe(202);
    expect(await current()).toMatchObject({
      repo_url: "https://github.com/acme/shop.git",
      branch: "release/1.0",
    });
  });

  it("accepts an scp-like ssh address", async () => {
    const res = await patch({ repo_url: "git@github.com:acme/shop.git" });
    expect(res.statusCode, res.body).toBe(202);
    expect((await current()).repo_url).toBe("git@github.com:acme/shop.git");
  });

  it("clears them with null", async () => {
    const res = await patch({ repo_url: null, branch: null });
    expect(res.statusCode, res.body).toBe(202);
    expect(await current()).toMatchObject({ repo_url: null, branch: null });
  });

  it.each([
    ["--upload-pack=touch /tmp/x", undefined],
    ["file:///etc", undefined],
    ["https://example.com/a repo.git", undefined],
    ["https://user:token@example.com/a.git", undefined],
    ["git@-oProxyCommand=x:y", undefined],
    [undefined, "-x"],
    [undefined, "main..evil"],
    [undefined, "feat;rm"],
  ])("refuses repo_url %j / branch %j", async (repo_url, branch) => {
    const res = await patch({ ...(repo_url ? { repo_url } : {}), ...(branch ? { branch } : {}) });
    expect(res.statusCode, res.body).toBe(422);
    expect(await current()).toMatchObject({ repo_url: null, branch: null });
  });
});
