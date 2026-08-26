import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import type { PairingInstructions, SetupState } from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * First-run setup.
 *
 * The thing worth proving here is the gate, not the happy path: a panel
 * that has just been installed is reachable before anybody has an
 * account on it, so "can a stranger claim it" and "can it be claimed
 * twice" are the questions these tests answer.
 * ------------------------------------------------------------------ */

const SETUP_TOKEN = "kn_setup_test_0123456789abcdef";
const OWNER_PASSWORD = "correct-horse-battery-92!";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;

/** Cookies accumulate across the flow the way a browser's would. */
const jar = new Map<string, string>();

function cookieHeader(): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorb(res: LightMyRequestResponse): LightMyRequestResponse {
  for (const cookie of res.cookies) {
    if (cookie.value) jar.set(cookie.name, cookie.value);
    else jar.delete(cookie.name);
  }
  return res;
}

function post(url: string, payload: Record<string, unknown> = {}): Promise<LightMyRequestResponse> {
  return app
    .inject({ method: "POST", url, payload, headers: { cookie: cookieHeader() } })
    .then(absorb);
}

function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url, headers: { cookie: cookieHeader() } }).then(absorb);
}

function body<T>(res: LightMyRequestResponse): T {
  return (JSON.parse(res.body) as { data: T }).data;
}

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    // Deliberately no KANAME_BOOTSTRAP_*: this is the fresh-install path.
    KANAME_SETUP_TOKEN: SETUP_TOKEN,
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);

  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);

  app = await buildServer(ctx);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

describe("first-run setup", () => {
  it("reports a fresh instance as needing onboarding", async () => {
    const state = body<SetupState>(await get("/api/v1/setup/state"));

    expect(state.needs_onboarding).toBe(true);
    expect(state.has_owner).toBe(false);
    expect(state.token_required).toBe(true);
    expect(state.authorized).toBe(false);
    expect(state.step).toBe("welcome");
  });

  it("refuses every mutation without the installer's token", async () => {
    for (const url of [
      "/api/v1/setup/welcome",
      "/api/v1/setup/owner",
      "/api/v1/setup/instance",
      "/api/v1/setup/complete",
    ]) {
      const res = await app.inject({ method: "POST", url, payload: {} });
      expect([401, 409], `${url} answered ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it("rejects a token that does not match", async () => {
    const res = await post("/api/v1/setup/token", { token: "kn_setup_not_the_right_one_at_all" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.fields.token).toBeTruthy();
  });

  it("accepts the installer's token and authorises the flow", async () => {
    const res = await post("/api/v1/setup/token", { token: SETUP_TOKEN });
    expect(res.statusCode, res.body).toBe(200);
    expect(body<SetupState>(res).authorized).toBe(true);
  });

  it("acknowledges the install check and moves to the account step", async () => {
    const res = await post("/api/v1/setup/welcome");
    expect(res.statusCode, res.body).toBe(200);
    expect(body<SetupState>(res).step).toBe("owner");
  });

  it("refuses a weak password server-side, with the reason on the field", async () => {
    const res = await post("/api/v1/setup/owner", {
      name: "Ada",
      email: "ada@example.com",
      password: "password1234",
      password_confirmation: "password1234",
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.fields.password).toContain("common password");
  });

  it("refuses a long passphrase that reuses the account's own address", async () => {
    // Length alone is not a pass: this one is 24 characters and would
    // clear every composition rule.
    const password = "ada.lovelace-is-my-key-42";
    const res = await post("/api/v1/setup/owner", {
      name: "Ada Lovelace",
      email: "ada.lovelace@example.com",
      password,
      password_confirmation: password,
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.fields.password).toContain("Do not reuse");
  });

  it("creates the owner account and signs it in", async () => {
    const res = await post("/api/v1/setup/owner", {
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: OWNER_PASSWORD,
      password_confirmation: OWNER_PASSWORD,
    });

    expect(res.statusCode, res.body).toBe(200);
    const state = body<SetupState>(res);
    expect(state.has_owner).toBe(true);
    expect(state.step).toBe("instance");

    // The session cookie arrives with the account, so the remaining
    // steps run as that account rather than as the installer's token.
    const session = await get("/api/v1/auth/session");
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).data.user.email).toBe("ada@example.com");
  });

  it("cannot be claimed a second time", async () => {
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/setup/token",
      payload: { token: SETUP_TOKEN },
    });
    expect(claim.statusCode).toBe(409);

    const second = await post("/api/v1/setup/owner", {
      name: "Mallory",
      email: "mallory@example.com",
      password: "another-good-passphrase-77!",
      password_confirmation: "another-good-passphrase-77!",
    });
    expect(second.statusCode).toBe(409);
  });

  it("requires a session for the steps after the account exists", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/setup/instance",
      payload: { instance_name: "Not Mine" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("names the instance", async () => {
    const res = await post("/api/v1/setup/instance", { instance_name: "Forge" });
    expect(res.statusCode, res.body).toBe(200);

    const state = body<SetupState>(res);
    expect(state.instance_name).toBe("Forge");
    expect(state.step).toBe("server");
  });

  it("issues a single-use pairing command that expires in minutes", async () => {
    const res = await post("/api/v1/setup/server", { name: "edge-01" });
    expect(res.statusCode, res.body).toBe(200);

    const pairing = body<PairingInstructions>(res);
    expect(pairing.command).toContain("--agent-only");
    expect(pairing.command).toContain(pairing.token);

    const minutes = (Date.parse(pairing.expires_at) - Date.now()) / 60_000;
    expect(minutes).toBeLessThanOrEqual(ctx.config.ENROLLMENT_TOKEN_TTL_MINUTES);
    expect(minutes).toBeGreaterThan(0);
  });

  it("will not confirm a first server that does not exist", async () => {
    await ctx.db.execute("delete from servers");
    const res = await post("/api/v1/setup/server/confirm");
    expect(res.statusCode).toBe(412);
  });

  it("walks the rest of the flow and closes the door behind it", async () => {
    await post("/api/v1/setup/server", { name: "edge-01" });
    expect((await post("/api/v1/setup/server/confirm")).statusCode).toBe(200);

    const prefs = await post("/api/v1/setup/preferences", {
      update_tier: "notify",
      update_interval: "daily",
      notification: { kind: "none" },
    });
    expect(prefs.statusCode, prefs.body).toBe(200);
    expect(body<SetupState>(prefs).step).toBe("done");

    const done = await post("/api/v1/setup/complete");
    expect(done.statusCode, done.body).toBe(200);
    expect(body<SetupState>(done).needs_onboarding).toBe(false);
  });

  it("refuses every setup mutation once it has completed", async () => {
    for (const url of [
      "/api/v1/setup/welcome",
      "/api/v1/setup/instance",
      "/api/v1/setup/server",
      "/api/v1/setup/preferences",
      "/api/v1/setup/complete",
    ]) {
      const res = await post(url, { instance_name: "Renamed", name: "another" });
      expect(res.statusCode, `${url} answered ${res.statusCode}`).toBe(409);
    }
  });

  it("still reports state after completion, so the panel can route", async () => {
    const state = body<SetupState>(await get("/api/v1/setup/state"));
    expect(state.needs_onboarding).toBe(false);
    expect(state.has_owner).toBe(true);
    expect(state.instance_name).toBe("Forge");
  });
});
