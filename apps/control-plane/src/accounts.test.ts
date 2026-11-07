import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { and, eq } from "@kaname/db";
import { createDb, type DbHandle } from "@kaname/db";
import { auditEvents, roles, users } from "@kaname/db/schema";
import { migrateHandle } from "@kaname/db/migrate";
import { loadConfig, resetConfigForTests, type Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import { AuthService } from "./services/auth.js";
import type { MailEnvelope } from "./services/notifications.js";

/* ------------------------------------------------------------------ *
 * Accounts: the invitation email, the lockout's counting window, the
 * way out of a lockout, and the two ways an invited account used to be
 * mishandled (activated with no password; told nothing useful at the
 * sign-in form — or told too much).
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@accounts.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const STRONG = "Tidal-Basalt-Orchard-47";
const MINUTE = 60_000;

let config: Config;
let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let ownerCookie = "";
const sent: MailEnvelope[] = [];
let ip = 10;

function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.value);
  return cookie ? `${cookie.name}=${cookie.value}` : "";
}

/** A fresh address per sign-in attempt, so the route's rate limit never decides a test. */
const nextIp = () => `203.0.113.${(ip = (ip % 250) + 1)}`;

const as = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie: ownerCookie }, payload });

const login = (email: string, password: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: nextIp(),
    payload: { email, password },
  });

async function viewerId(): Promise<string> {
  const [viewer] = await handle.db.select().from(roles).where(eq(roles.slug, "viewer")).limit(1);
  return viewer!.id;
}

async function invite(email: string, sendInvite = false) {
  const res = await as("POST", "/users", {
    email,
    name: "Ines Invitee",
    role_ids: [await viewerId()],
    send_invite: sendInvite,
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).data as {
    id: string;
    invite: { url: string; expires_at: string; email: { sent: boolean; error: string | null } | null };
  };
}

async function member(email: string): Promise<string> {
  const created = await invite(email);
  const token = decodeURIComponent(created.invite.url.split("/invite/")[1]!);
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invite/accept",
    remoteAddress: nextIp(),
    payload: { token, password: STRONG },
  });
  expect(accepted.statusCode).toBe(200);
  return created.id;
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
  ctx = createContext(
    { config, log: pino({ level: "fatal" }), dbHandle: handle },
    {},
    // The real composition and routing; only the socket is a recorder.
    { mailer: () => ({ send: async (mail) => void sent.push(mail), close: () => {} }) },
  );
  await ctx.ca.load();
  await bootstrap(ctx);
  app = await buildServer(ctx);
  await app.ready();

  const res = await login(OWNER_EMAIL, OWNER_PASSWORD);
  expect(res.statusCode).toBe(200);
  ownerCookie = cookieOf(res);
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

describe("emailing the invitation", () => {
  it("without an outgoing mail server, still invites, and says why no email went", async () => {
    const created = await invite("nomail@accounts.test", true);
    expect(created.invite.url).toMatch(/\/invite\/kn_invite/);
    expect(created.invite.email).toEqual({
      sent: false,
      error: expect.stringMatching(/No outgoing mail server is configured/),
    });
    expect(sent).toHaveLength(0);
  });

  it("sends the accept link and the panel's name through Settings > Outgoing mail", async () => {
    expect(
      (
        await as("PATCH", "/settings", {
          panel: { name: "Forge Fleet" },
          notifications: {
            smtp: { host: "smtp.accounts.test", port: 2525, security: "none", from_address: "panel@accounts.test" },
          },
        })
      ).statusCode,
    ).toBe(200);

    const created = await invite("mailed@accounts.test", true);
    expect(created.invite.email).toEqual({ sent: true, error: null });
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe("mailed@accounts.test");
    expect(mail.subject).toContain("Forge Fleet");
    expect(mail.text).toContain(created.invite.url);
    expect(mail.text).toContain("Forge Fleet");
    expect(mail.html).toContain(created.invite.url);

    // The link in the email is the one that works.
    const token = decodeURIComponent(created.invite.url.split("/invite/")[1]!);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/invite/accept",
      remoteAddress: nextIp(),
      payload: { token, password: STRONG },
    });
    expect(accepted.statusCode).toBe(200);

    // Audited with the outcome; never with the link.
    const [audit] = await handle.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.targetLabel, "mailed@accounts.test"), eq(auditEvents.action, "user.invited")),
      );
    expect(audit!.metadata).toMatchObject({ send_invite: true, email_sent: true });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("sends nothing when the switch is off", async () => {
    const before = sent.length;
    const created = await invite("linkonly@accounts.test", false);
    expect(created.invite.email).toBeNull();
    expect(sent).toHaveLength(before);
  });
});

describe("the lockout counting window", () => {
  async function userRow(email: string): Promise<string> {
    const [row] = await handle.db
      .insert(users)
      .values({ email, name: "Window", status: "active", passwordHash: "x" })
      .returning({ id: users.id });
    return row!.id;
  }

  it("counts only failures inside window_minutes (injected clock)", async () => {
    const id = await userRow("window@accounts.test");
    let now = Date.parse("2026-03-01T12:00:00Z");
    const auth = new AuthService(handle.db, config, () => now);
    // Threshold 3, a 10-minute window, a 15-minute lock.
    const fail = () => auth.noteFailedLogin(id, 3, 15, 10);

    expect((await fail()).failures).toBe(1); // 12:00
    now += 6 * MINUTE;
    expect((await fail()).failures).toBe(2); // 12:06
    now += 6 * MINUTE;
    // 12:12 — the 12:00 failure has aged out, so this is two, not three.
    const third = await fail();
    expect(third).toEqual({ failures: 2, lockedUntil: null });

    now += 1 * MINUTE;
    // 12:13 — 12:06, 12:12 and 12:13 are all inside ten minutes.
    const locked = await fail();
    expect(locked.failures).toBe(3);
    expect(locked.lockedUntil?.getTime()).toBe(now + 15 * MINUTE);
  });

  it("does not lock on failures spread wider than the window", async () => {
    const id = await userRow("spread@accounts.test");
    let now = Date.parse("2026-03-01T12:00:00Z");
    const auth = new AuthService(handle.db, config, () => now);
    for (let i = 0; i < 10; i += 1) {
      const result = await auth.noteFailedLogin(id, 3, 15, 5);
      expect(result.lockedUntil).toBeNull();
      now += 3 * MINUTE;
    }
  });

  it("is what the sign-in route uses, from Settings", async () => {
    await as("PATCH", "/settings", {
      security: {
        failed_login_lockout: { enabled: true, threshold: 2, window_minutes: 5, lockout_minutes: 30 },
      },
    });
    await member("route-window@accounts.test");
    const start = Date.now();

    vi.spyOn(ctx.auth, "now").mockReturnValue(start);
    expect((await login("route-window@accounts.test", "wrong-wrong-wrong")).statusCode).toBe(401);
    vi.spyOn(ctx.auth, "now").mockReturnValue(start + 6 * MINUTE);
    expect((await login("route-window@accounts.test", "wrong-wrong-wrong")).statusCode).toBe(401);
    // Two failures, but six minutes apart in a five-minute window: not locked.
    expect((await login("route-window@accounts.test", STRONG)).statusCode).toBe(200);
  });
});

describe("unlocking a locked account", () => {
  it("lifts the lock, is audited, and the lockout message names it", async () => {
    await as("PATCH", "/settings", {
      security: {
        failed_login_lockout: { enabled: true, threshold: 2, window_minutes: 15, lockout_minutes: 30 },
      },
    });
    const id = await member("unlock@accounts.test");
    await login("unlock@accounts.test", "wrong-wrong-wrong");
    await login("unlock@accounts.test", "wrong-wrong-wrong");

    const locked = await login("unlock@accounts.test", STRONG);
    expect(locked.statusCode).toBe(429);
    expect(JSON.parse(locked.body).error.remediation.summary).toMatch(
      /An owner can lift it sooner with Unlock in Administration > Users\./,
    );

    // Listed as active and locked, which is what the panel keys Unlock on.
    const listed = JSON.parse((await as("GET", `/users/${id}`)).body).data;
    expect(listed.status).toBe("active");
    expect(Date.parse(listed.locked_until)).toBeGreaterThan(Date.now());

    const unlocked = await as("POST", `/users/${id}/unlock`);
    expect(unlocked.statusCode).toBe(200);
    expect(JSON.parse(unlocked.body).data).toMatchObject({ status: "active", locked_until: null });

    const audit = await handle.db.select().from(auditEvents).where(eq(auditEvents.action, "user.unlocked"));
    expect(audit.map((a) => a.targetId)).toContain(id);

    expect((await login("unlock@accounts.test", STRONG)).statusCode).toBe(200);
  });
});

describe("invited accounts", () => {
  it("cannot be set active over PATCH without a password, as Activate refuses", async () => {
    const created = await invite("patch@accounts.test");
    const viaPatch = await as("PATCH", `/users/${created.id}`, { status: "active" });
    const viaActivate = await as("POST", `/users/${created.id}/activate`);
    expect(viaPatch.statusCode).toBe(409);
    expect(viaActivate.statusCode).toBe(409);
    expect(JSON.parse(viaPatch.body).error.message).toBe(JSON.parse(viaActivate.body).error.message);
    const [row] = await handle.db.select().from(users).where(eq(users.id, created.id));
    expect(row!.status).toBe("invited");
  });

  it("gets the generic answer at sign-in while that would reveal the address", async () => {
    await invite("pending@accounts.test");
    const invited = await login("pending@accounts.test", "any-password-at-all");
    const unknown = await login("nobody@accounts.test", "any-password-at-all");
    expect(invited.statusCode).toBe(401);
    expect(JSON.parse(invited.body).error.message).toBe(JSON.parse(unknown.body).error.message);
  });

  it("is told the invitation is unaccepted once the right password proves it knows", async () => {
    const id = await member("moved-back@accounts.test");
    // An owner moved the account back to invited; its password still exists.
    expect((await as("PATCH", `/users/${id}`, { status: "invited" })).statusCode).toBe(200);
    const res = await login("moved-back@accounts.test", STRONG);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe("This invitation hasn't been accepted yet.");
    const wrong = await login("moved-back@accounts.test", "wrong-wrong-wrong");
    expect(JSON.parse(wrong.body).error.message).toBe(
      "That email and password do not match an account.",
    );
  });
});
