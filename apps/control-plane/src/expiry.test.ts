import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { eq } from "@kaname/db";
import { createDb, type DbHandle } from "@kaname/db";
import { apiKeys, roles, setupTokens, users } from "@kaname/db/schema";
import { migrateHandle } from "@kaname/db/migrate";
import { loadConfig, resetConfigForTests, type Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import { AuthService } from "./services/auth.js";
import { DEPLOY_SECRETS_TTL_MS, MailSecretStore, deploySecretsKey } from "./services/mail-secrets.js";
import { SETUP_TOKEN_TTL_MINUTES, claimSetupToken } from "./services/setup.js";
import { CHALLENGE_TTL_MS, openChallenge, signChallenge } from "./routes/auth.js";
import { TICKET_TTL_MS, ticketRefusal } from "./routes/terminal.js";
import { hashToken } from "./lib/crypto.js";

/* ------------------------------------------------------------------ *
 * Every credential with a clock on it, walked past its expiry by
 * moving the clock rather than by waiting.
 *
 * The clock is the AuthService's `now`: injected through its
 * constructor where the test builds one, and spied on the running
 * context's service where a route reads it. Each case checks both
 * sides of the edge — one second before (still good) and the instant
 * itself (gone) — because an off-by-one there is the usual bug.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@expiry.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const STRONG = "Tidal-Basalt-Orchard-47";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

let config: Config;
let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let ownerCookie = "";

function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.value);
  return cookie ? `${cookie.name}=${cookie.value}` : "";
}

/** Moves the running control plane's clock to `at`. */
function clockAt(at: number): void {
  vi.spyOn(ctx.auth, "now").mockReturnValue(at);
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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

/* ------------------------------------------------------------------ */

describe("API key expiry", () => {
  it("authenticates until expires_at and not at it", async () => {
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: { cookie: ownerCookie },
      payload: { name: "short-lived", scopes: ["infra.servers:read"], expires_in_days: 1 },
    });
    expect(minted.statusCode).toBe(201);
    const created = JSON.parse(minted.body) as { data: { token: string; key: { id: string } } };
    const [row] = await handle.db
      .select({ expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, created.data.key.id));
    const expiresAt = row!.expiresAt!.getTime();

    // One day, as asked for.
    expect(Math.abs(expiresAt - Date.now() - DAY)).toBeLessThan(MINUTE);

    let now = expiresAt - SECOND;
    const auth = new AuthService(handle.db, config, () => now);
    expect(await auth.principalFromApiKey(created.data.token)).not.toBeNull();
    now = expiresAt;
    expect(await auth.principalFromApiKey(created.data.token)).toBeNull();
    now = expiresAt + DAY;
    expect(await auth.principalFromApiKey(created.data.token)).toBeNull();
  });
});

describe("invitation expiry (7 days)", () => {
  async function invite(email: string): Promise<{ token: string; expiresAt: number }> {
    const [viewer] = await handle.db.select().from(roles).where(eq(roles.slug, "viewer")).limit(1);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { cookie: ownerCookie },
      payload: { email, name: "Invitee", role_ids: [viewer!.id], send_invite: false },
    });
    expect(res.statusCode).toBe(201);
    const invite = (JSON.parse(res.body) as { data: { invite: { url: string; expires_at: string } } })
      .data.invite;
    return {
      token: decodeURIComponent(invite.url.split("/invite/")[1]!),
      expiresAt: Date.parse(invite.expires_at),
    };
  }

  const accept = (token: string, ip: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/invite/accept",
      remoteAddress: ip,
      payload: { token, password: STRONG },
    });

  it("is issued for seven days", async () => {
    const { expiresAt } = await invite("seven@expiry.test");
    expect(Math.abs(expiresAt - Date.now() - 7 * DAY)).toBeLessThan(MINUTE);
  });

  it("can be accepted a second before it expires", async () => {
    const { token, expiresAt } = await invite("late@expiry.test");
    clockAt(expiresAt - SECOND);
    expect((await accept(token, "203.0.113.70")).statusCode).toBe(200);
  });

  it("is refused at the instant it expires, and the account stays invited", async () => {
    const { token, expiresAt } = await invite("expired@expiry.test");
    clockAt(expiresAt);
    const res = await accept(token, "203.0.113.71");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe("This invitation is not valid any more.");
    const [row] = await handle.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.email, "expired@expiry.test"));
    expect(row!.status).toBe("invited");
  });
});

describe("two-factor challenge (5 minutes)", () => {
  const key = Buffer.alloc(32, 7);
  const t0 = Date.parse("2026-03-01T12:00:00Z");

  it("lasts five minutes", () => {
    expect(CHALLENGE_TTL_MS).toBe(5 * MINUTE);
  });

  it("opens until five minutes have passed, then never", () => {
    const challenge = signChallenge(key, "203.0.113.5", "user-1", true, t0);
    expect(openChallenge(key, "203.0.113.5", challenge, t0)).toEqual({
      userId: "user-1",
      remember: true,
    });
    expect(openChallenge(key, "203.0.113.5", challenge, t0 + 5 * MINUTE - SECOND)).not.toBeNull();
    expect(openChallenge(key, "203.0.113.5", challenge, t0 + 5 * MINUTE)).toBeNull();
  });

  it("is still bound to the address that started it", () => {
    const challenge = signChallenge(key, "203.0.113.5", "user-1", false, t0);
    expect(openChallenge(key, "203.0.113.6", challenge, t0)).toBeNull();
  });

  it("expires through the route too", async () => {
    // A TOTP account, signed in on its first leg at a moved clock.
    const [owner] = await handle.db.select().from(users).where(eq(users.email, OWNER_EMAIL));
    await ctx.auth.setupTotp(owner!.id, OWNER_EMAIL, "Kaname");
    await ctx.auth.enableTotp(owner!.id);
    try {
      const start = Date.now();
      clockAt(start);
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "203.0.113.80",
        payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
      });
      expect(first.statusCode).toBe(200);
      const { challenge } = JSON.parse(first.body).data as { challenge: string };

      clockAt(start + 5 * MINUTE);
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/auth/totp",
        remoteAddress: "203.0.113.80",
        payload: { challenge, code: "123456" },
      });
      expect(second.statusCode).toBe(401);
      expect(JSON.parse(second.body).error.message).toBe("This sign-in attempt has expired.");
    } finally {
      await ctx.auth.disableTotp(owner!.id);
    }
  });
});

describe("deploy-secret hand-off (15 minutes)", () => {
  it("waits fifteen minutes to be read, then is gone", () => {
    expect(DEPLOY_SECRETS_TTL_MS).toBe(15 * MINUTE);
    let now = 1_000_000;
    const store = new MailSecretStore(() => now);
    const key = deploySecretsKey("mail-1");
    store.put(key, { setup_url: "https://mail.example/setup" }, DEPLOY_SECRETS_TTL_MS);

    now += DEPLOY_SECRETS_TTL_MS - SECOND;
    expect(store.has(key)).toBe(true);
    now += SECOND;
    expect(store.has(key)).toBe(false);
    expect(store.take(key)).toBeNull();
  });

  it("is handed out once inside the window", () => {
    let now = 0;
    const store = new MailSecretStore(() => now);
    store.put("k", "v", DEPLOY_SECRETS_TTL_MS);
    now = DEPLOY_SECRETS_TTL_MS - 1;
    expect(store.take("k")).toBe("v");
    expect(store.take("k")).toBeNull();
  });
});

describe("terminal ticket (30 seconds)", () => {
  const t0 = Date.parse("2026-03-01T12:00:00Z");
  const session = {
    startedAt: null,
    expiresAt: new Date(t0 + TICKET_TTL_MS),
    ip: "203.0.113.9",
  };

  it("lasts thirty seconds", () => {
    expect(TICKET_TTL_MS).toBe(30 * SECOND);
  });

  it("opens until it expires, and is refused at the instant it does", () => {
    expect(ticketRefusal(session, "203.0.113.9", t0)).toBeNull();
    expect(ticketRefusal(session, "::ffff:203.0.113.9", t0 + TICKET_TTL_MS - 1)).toBeNull();
    expect(ticketRefusal(session, "203.0.113.9", t0 + TICKET_TTL_MS)).toEqual({
      code: 4401,
      reason: "ticket expired",
    });
  });

  it("is single-use and address-bound regardless of the clock", () => {
    expect(ticketRefusal({ ...session, startedAt: new Date(t0) }, "203.0.113.9", t0)?.reason).toBe(
      "ticket already used",
    );
    expect(ticketRefusal(session, "203.0.113.10", t0)?.code).toBe(4403);
  });
});

describe("setup token (24 hours)", () => {
  it("lasts a day", () => {
    expect(SETUP_TOKEN_TTL_MINUTES).toBe(24 * 60);
  });

  it("is accepted until the day is up and refused at the instant it is", async () => {
    // A row exactly as bootstrap writes one for a fresh install.
    const token = "kn_setup_expiry_test_0123456789";
    const issuedAt = Date.now();
    const expiresAt = new Date(issuedAt + SETUP_TOKEN_TTL_MINUTES * MINUTE);
    await handle.db.insert(setupTokens).values({ tokenHash: hashToken(token), expiresAt });

    clockAt(expiresAt.getTime() - SECOND);
    await expect(claimSetupToken(ctx, token, "203.0.113.90")).resolves.toBe(hashToken(token));

    clockAt(expiresAt.getTime());
    await expect(claimSetupToken(ctx, token, "203.0.113.90")).rejects.toThrow(
      "That setup token has expired.",
    );
  });
});
