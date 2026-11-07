import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, type DbHandle } from "@kaname/db";
import { jobs, servers, users } from "@kaname/db/schema";
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

  it("still asks for the token once the installer's has expired", async () => {
    await ctx.db.execute("update setup_tokens set expires_at = now() - interval '1 minute'");
    try {
      // The form has to stay on screen: every step still demands the
      // token, and the remedy (a restart mints another) is shown next
      // to the field rather than hidden behind a health check.
      const state = body<SetupState>(await get("/api/v1/setup/state"));
      expect(state.token_required).toBe(true);
      expect(state.token_live).toBe(false);

      const res = await post("/api/v1/setup/token", { token: SETUP_TOKEN });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error.fields.token).toBe("expired");
    } finally {
      await ctx.db.execute("update setup_tokens set expires_at = now() + interval '1 day'");
    }
  });

  it("accepts the installer's token and authorises the flow", async () => {
    const res = await post("/api/v1/setup/token", { token: SETUP_TOKEN });
    expect(res.statusCode, res.body).toBe(200);
    expect(body<SetupState>(res).authorized).toBe(true);

    // The cookie lives as long as the token it stands in for, and
    // survives a closed browser: "finish after a coffee" is the promise.
    const cookie = res.cookies.find((c) => c.name === "kaname_setup");
    expect(cookie?.expires).toBeInstanceOf(Date);
    const hours = (cookie!.expires!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("acknowledges the install check and moves to the account step", async () => {
    const res = await post("/api/v1/setup/welcome");
    expect(res.statusCode, res.body).toBe(200);
    expect(body<SetupState>(res).step).toBe("owner");
    // Every authorised step re-issues the cookie, so its clock slides.
    expect(res.cookies.some((c) => c.name === "kaname_setup" && c.value)).toBe(true);
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

  it("creates the owner account exactly once, even when asked twice at the same moment", async () => {
    const payload = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: OWNER_PASSWORD,
      password_confirmation: OWNER_PASSWORD,
    };
    // Two tabs, one token, both submitted: the check and the insert are
    // one transaction under a lock, so the second answers 409 rather
    // than minting a second Owner or tripping over the email index.
    const [first, second] = await Promise.all([
      post("/api/v1/setup/owner", payload),
      post("/api/v1/setup/owner", payload),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body}\n${second.body}`).toEqual([200, 409]);

    const res = first.statusCode === 200 ? first : second;
    const state = body<SetupState>(res);
    expect(state.has_owner).toBe(true);
    expect(state.step).toBe("instance");

    expect((await ctx.db.select({ id: users.id }).from(users)).length).toBe(1);

    // The session cookie arrives with the account, so the remaining
    // steps run as that account rather than as the installer's token.
    const session = await get("/api/v1/auth/session");
    expect(session.statusCode).toBe(200);
    expect(JSON.parse(session.body).data.user.email).toBe("ada@example.com");
  });

  it("chooses the session cookie by how the request arrived", async () => {
    const login = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "ada@example.com", password: OWNER_PASSWORD },
        headers,
      });

    // Behind Caddy on the domain: HTTPS, so the __Host- cookie is legal.
    const https = await login({ "x-forwarded-proto": "https" });
    expect(https.statusCode, https.body).toBe(200);
    const secure = https.cookies.find((c) => c.name === "__Host-kaname_session");
    expect(secure?.secure).toBe(true);
    expect(https.cookies.some((c) => c.name === "kaname_session")).toBe(false);

    // On the IP over plain HTTP: a browser would refuse a Secure cookie,
    // so the plain one is the only one that can keep sign-in working.
    const http = await login({});
    expect(http.statusCode, http.body).toBe(200);
    const plain = http.cookies.find((c) => c.name === "kaname_session");
    expect(plain?.value).toBeTruthy();
    expect(plain?.secure).toBeFalsy();
    expect(http.cookies.some((c) => c.name.startsWith("__Host-"))).toBe(false);

    // Either cookie authenticates, whichever origin presents it.
    for (const cookie of [
      `__Host-kaname_session=${secure!.value}`,
      `kaname_session=${plain!.value}`,
    ]) {
      const session = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { cookie },
      });
      expect(session.statusCode, cookie).toBe(200);
      expect(JSON.parse(session.body).data.user.email).toBe("ada@example.com");
    }
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

  it("does not loop the step when the instance is named after the product", async () => {
    // "Kaname" is also the seeded default, which is why the step used to
    // infer "not yet named" from it and send the operator round again.
    const res = await post("/api/v1/setup/instance", { instance_name: "Kaname" });
    expect(res.statusCode, res.body).toBe(200);
    expect(body<SetupState>(res).step).toBe("server");
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

  it("lands on the first optional step once the server is confirmed", async () => {
    await post("/api/v1/setup/server", { name: "edge-01" });
    const confirmed = await post("/api/v1/setup/server/confirm");
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const state = body<SetupState>(confirmed);
    expect(state.step).toBe("address");
    expect(state.outcomes).toEqual({
      address: null,
      website: null,
      email: null,
      backups: null,
      notifications: null,
      team: null,
    });
    expect(state.email_deploy).toBeNull();
  });

  it("validates the panel domain on the address step and holds it for the end", async () => {
    const typo = await post("/api/v1/setup/address", { panel_domain: "not a domain" });
    // Refused now, on the field, rather than after the restart it costs.
    expect(typo.statusCode).toBe(422);
    expect(JSON.parse(typo.body).error.fields.panel_domain).toBeTruthy();

    const saved = await post("/api/v1/setup/address", {
      panel_domain: "Panel.Example.COM",
      acme_email: "ops@example.com",
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const state = body<SetupState>(saved);
    expect(state.step).toBe("website");
    expect(state.outcomes.address).toBe("done");
    // Held server-side until the last screen applies it, so a reload in
    // between does not quietly drop the domain the operator typed.
    expect(state.pending_domain).toBe("panel.example.com");
  });

  it("will not mark an optional step done when nothing was set up", async () => {
    const website = await post("/api/v1/setup/steps/website", { outcome: "done" });
    expect(website.statusCode).toBe(412);

    // The two steps with forms of their own are saved through them.
    const address = await post("/api/v1/setup/steps/notifications", { outcome: "done" });
    expect(address.statusCode).toBe(400);

    const unknown = await post("/api/v1/setup/steps/owner", { outcome: "skipped" });
    expect([400, 422]).toContain(unknown.statusCode);

    const state = body<SetupState>(await get("/api/v1/setup/state"));
    expect(state.step).toBe("website");
  });

  it("skips the website step and resumes on email", async () => {
    const res = await post("/api/v1/setup/steps/website", { outcome: "skipped" });
    expect(res.statusCode, res.body).toBe(200);
    expect(body<SetupState>(res).step).toBe("email");

    // A reload asks the server, and the server remembers.
    const state = body<SetupState>(await get("/api/v1/setup/state"));
    expect(state.step).toBe("email");
    expect(state.outcomes.website).toBe("skipped");
  });

  it("remembers a mail deploy started from the email step, and only a real one", async () => {
    const [server] = await ctx.db.select({ id: servers.id }).from(servers).limit(1);
    expect(server).toBeTruthy();

    const bogus = await post("/api/v1/setup/email/deploy", {
      job_id: "00000000-0000-4000-8000-000000000000",
      server_id: server!.id,
    });
    expect(bogus.statusCode).toBe(404);

    // Not a deploy: the right server, the wrong kind of job.
    const [other] = await ctx.db
      .insert(jobs)
      .values({ type: "system.sync", serverId: server!.id })
      .returning({ id: jobs.id });
    const wrongType = await post("/api/v1/setup/email/deploy", {
      job_id: other!.id,
      server_id: server!.id,
    });
    expect(wrongType.statusCode).toBe(404);

    const [deploy] = await ctx.db
      .insert(jobs)
      .values({ type: "mail.server.deploy", serverId: server!.id })
      .returning({ id: jobs.id });
    const tracked = await post("/api/v1/setup/email/deploy", {
      job_id: deploy!.id,
      server_id: server!.id,
    });
    expect(tracked.statusCode, tracked.body).toBe(200);
    const state = body<SetupState>(tracked);
    // Tracking is not answering: the step stays until the operator moves on.
    expect(state.step).toBe("email");
    expect(state.email_deploy).toEqual({ job_id: deploy!.id, server_id: server!.id });
  });

  it("walks the rest of the flow and closes the door behind it", async () => {
    // No mail server row exists, so "done" would be a claim without evidence.
    expect((await post("/api/v1/setup/steps/email", { outcome: "done" })).statusCode).toBe(412);
    const email = await post("/api/v1/setup/steps/email", { outcome: "skipped" });
    expect(body<SetupState>(email).step).toBe("backups");

    const backups = await post("/api/v1/setup/steps/backups", { outcome: "skipped" });
    expect(body<SetupState>(backups).step).toBe("notifications");

    const prefs = await post("/api/v1/setup/preferences", {
      update_tier: "notify",
      update_interval: "daily",
      notification: { kind: "none" },
    });
    expect(prefs.statusCode, prefs.body).toBe(200);
    expect(body<SetupState>(prefs).step).toBe("team");
    // The notifications step must not clear what the address step saved.
    expect(body<SetupState>(prefs).pending_domain).toBe("panel.example.com");

    expect((await post("/api/v1/setup/steps/team", { outcome: "done" })).statusCode).toBe(412);
    const roles = JSON.parse((await get("/api/v1/roles")).body).data as { id: string; slug: string }[];
    const role = roles.find((r) => r.slug !== "owner") ?? roles[0]!;
    const invited = await post("/api/v1/users", {
      email: "grace@example.com",
      name: "Grace",
      role_ids: [role.id],
      send_invite: false,
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const team = await post("/api/v1/setup/steps/team", { outcome: "done" });
    expect(team.statusCode, team.body).toBe(200);
    expect(body<SetupState>(team).step).toBe("done");
    expect(body<SetupState>(team).outcomes).toEqual({
      address: "done",
      website: "skipped",
      email: "skipped",
      backups: "skipped",
      notifications: "done",
      team: "done",
    });

    const done = await post("/api/v1/setup/complete");
    expect(done.statusCode, done.body).toBe(200);
    expect(body<SetupState>(done).needs_onboarding).toBe(false);
    expect(body<SetupState>(done).pending_domain).toBeNull();
  });

  it("refuses every setup mutation once it has completed", async () => {
    for (const url of [
      "/api/v1/setup/welcome",
      "/api/v1/setup/instance",
      "/api/v1/setup/server",
      "/api/v1/setup/preferences",
      "/api/v1/setup/address",
      "/api/v1/setup/steps/team",
      "/api/v1/setup/email/deploy",
      "/api/v1/setup/complete",
    ]) {
      const res = await post(url, {
        instance_name: "Renamed",
        name: "another",
        outcome: "skipped",
      });
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
