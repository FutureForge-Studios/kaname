import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { eq } from "@kaname/db";
import { createDb, type DbHandle } from "@kaname/db";
import { roles } from "@kaname/db/schema";
import { migrateHandle } from "@kaname/db/migrate";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * Accepting an invitation.
 *
 * An invitation link is a bearer credential for an account, so the
 * property worth proving is that it is spent exactly once — including
 * when two requests present it at the same moment.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@invite.test";
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

async function inviteToken(email: string): Promise<string> {
  const [viewer] = await handle.db.select().from(roles).where(eq(roles.slug, "viewer")).limit(1);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: { cookie: ownerCookie },
    payload: { email, name: "Invitee", role_ids: [viewer!.id], send_invite: false },
  });
  expect(res.statusCode).toBe(201);
  const url = (JSON.parse(res.body) as { data: { invite: { url: string } } }).data.invite.url;
  return decodeURIComponent(url.split("/invite/")[1]!);
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

describe("accepting an invitation", () => {
  it("activates the account, signs it in, and spends the token", async () => {
    const token = await inviteToken("once@invite.test");
    const first = await accept(token);
    expect(first.statusCode).toBe(200);
    expect(cookieOf(first)).not.toBe("");

    const second = await accept(token, "Another-Strong-Passphrase-88");
    expect(second.statusCode).toBe(401);
    expect(JSON.parse(second.body).error.message).toBe("This invitation is not valid any more.");

    // The first password is the one that stuck.
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "203.0.113.11",
      payload: { email: "once@invite.test", password: STRONG },
    });
    expect(login.statusCode).toBe(200);
  });

  it("lets exactly one of two concurrent accepts of the same token win", async () => {
    const token = await inviteToken("race@invite.test");
    const results = await Promise.all([
      accept(token, STRONG, "203.0.113.20"),
      accept(token, "Another-Strong-Passphrase-88", "203.0.113.21"),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 401]);
  });

  it("refuses a weak password with the reason on the field, and keeps the token", async () => {
    const token = await inviteToken("weak@invite.test");
    const weak = await accept(token, "aaaaaaaaaaaa", "203.0.113.30");
    expect(weak.statusCode).toBe(422);
    expect(JSON.parse(weak.body).error.fields.password).toMatch(/Mix upper and lower case/);
    expect((await accept(token, STRONG, "203.0.113.31")).statusCode).toBe(200);
  });

  it("refuses a token that was never issued", async () => {
    const res = await accept("kn_invite_not-a-real-token", STRONG, "203.0.113.40");
    expect(res.statusCode).toBe(401);
  });
});
