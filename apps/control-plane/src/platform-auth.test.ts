import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { eq } from "@kaname/db";
import { createDb, type DbHandle } from "@kaname/db";
import { roles, users } from "@kaname/db/schema";
import { migrateHandle } from "@kaname/db/migrate";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * Account security fixes found by the platform e2e suite: API keys live
 * and narrow with their creator, the lockout lasts as long as Settings
 * says, and a typo on your own account page is a 422 rather than the
 * 401 that signs the panel out.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@auth.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const STRONG = "Tidal-Basalt-Orchard-47";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let ownerCookie = "";

function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.value);
  return cookie ? `${cookie.name}=${cookie.value}` : "";
}

function accept(token: string, password = STRONG, ip = "203.0.113.10") {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/invite/accept",
    remoteAddress: ip,
    payload: { token, password },
  });
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
  app = await buildServer(ctx);
  await app.ready();

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = cookieOf(login);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});


async function member(email: string, slug: string): Promise<{ id: string; cookie: string }> {
  const [role] = await handle.db.select().from(roles).where(eq(roles.slug, slug)).limit(1);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: { cookie: ownerCookie },
    payload: { email, name: "Member", role_ids: [role!.id], send_invite: false },
  });
  const created = JSON.parse(res.body) as { data: { id: string; invite: { url: string } } };
  const token = decodeURIComponent(created.data.invite.url.split("/invite/")[1]!);
  const accepted = await accept(token, STRONG, `203.0.113.${50 + Math.floor(Math.random() * 100)}`);
  expect(accepted.statusCode).toBe(200);
  return { id: created.data.id, cookie: cookieOf(accepted) };
}

function as(cookie: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });
}

describe("API keys follow their creator", () => {
  it("narrows to what the creator holds now, and dies while they are suspended", async () => {
    const owner = await member("keys@auth.test", "owner");
    const minted = await as(owner.cookie, "POST", "/api-keys", {
      name: "bound",
      scopes: ["admin.users:read", "infra.servers:read"],
    });
    expect(minted.statusCode).toBe(201);
    const token = (JSON.parse(minted.body) as { data: { token: string } }).data.token;
    const bearer = (url: string) =>
      app.inject({ method: "GET", url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

    expect((await bearer("/users")).statusCode).toBe(200);

    const [viewer] = await handle.db.select().from(roles).where(eq(roles.slug, "viewer")).limit(1);
    await as(ownerCookie, "POST", `/users/${owner.id}/roles`, { role_ids: [viewer!.id] });
    expect((await bearer("/users")).statusCode).toBe(403);
    expect((await bearer("/servers")).statusCode).toBe(200);

    await as(ownerCookie, "POST", `/users/${owner.id}/suspend`);
    expect((await bearer("/servers")).statusCode).toBe(401);
  });
});

describe("lockout", () => {
  it("lasts the configured lockout duration", async () => {
    await as(ownerCookie, "PATCH", "/settings", {
      security: { failed_login_lockout: { enabled: true, threshold: 2, lockout_minutes: 3 } },
    });
    await member("lock@auth.test", "viewer");
    const attempt = (password: string, ip: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: ip,
        payload: { email: "lock@auth.test", password },
      });
    await attempt("wrong-wrong-wrong", "203.0.113.200");
    await attempt("wrong-wrong-wrong", "203.0.113.201");
    const started = Date.now();
    const locked = await attempt(STRONG, "203.0.113.202");
    expect(locked.statusCode).toBe(429);
    const until = Date.parse(JSON.parse(locked.body).error.detail.locked_until);
    expect(until - started).toBeLessThanOrEqual(3 * 60_000 + 5_000);
    expect(until - started).toBeGreaterThan(2 * 60_000);
  });
});

describe("mistakes on your own account page", () => {
  it("answers 422 on the field, never 401", async () => {
    const me = await member("typo@auth.test", "viewer");
    const wrong = await as(me.cookie, "POST", "/auth/password", {
      current_password: "not-it-at-all",
      new_password: "Granite-Lantern-Meadow-91",
    });
    expect(wrong.statusCode).toBe(422);
    expect(JSON.parse(wrong.body).error.fields.current_password).toBe("does not match");

    const weak = await as(me.cookie, "POST", "/auth/password", {
      current_password: STRONG,
      new_password: "aaaaaaaaaaaaaaaa",
    });
    expect(weak.statusCode).toBe(422);
    expect(JSON.parse(weak.body).error.fields.new_password).toMatch(/Mix upper and lower case/);

    await as(me.cookie, "POST", "/auth/totp/setup");
    const code = await as(me.cookie, "POST", "/auth/totp/verify", { code: "000000" });
    // One in a million that 000000 is the live code; the field is what matters.
    if (code.statusCode !== 200) {
      expect(code.statusCode).toBe(422);
      expect(JSON.parse(code.body).error.fields.code).toBe("That authentication code is not valid.");
    }
    // Still signed in after both.
    expect((await as(me.cookie, "GET", "/auth/session")).statusCode).toBe(200);
  });
});

describe("two-factor codes", () => {
  it("accepts a code once, even inside its 30-second window", async () => {
    const [owner] = await handle.db.select().from(users).where(eq(users.email, OWNER_EMAIL));
    const { secret } = await ctx.auth.setupTotp(owner!.id, OWNER_EMAIL, "Kaname");
    const { Secret, TOTP } = await import("otpauth");
    const code = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

    const [first, second] = await Promise.all([
      ctx.auth.verifyTotp(owner!.id, code),
      ctx.auth.verifyTotp(owner!.id, code),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await ctx.auth.verifyTotp(owner!.id, code)).toBe(false);

    // A fresh enrolment starts a fresh history.
    await ctx.auth.disableTotp(owner!.id);
  });
});
