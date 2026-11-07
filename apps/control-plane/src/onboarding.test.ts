import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { domains, mailServers, servers, users } from "@kaname/db/schema";
import type { OnboardingStep } from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * Getting Started is answered from rows, not flags.
 *
 * Boots an empty, migrated control plane with only the owner, checks
 * the checklist reports nothing done, then writes the rows a real
 * operator's actions would leave behind and checks each step follows.
 * ------------------------------------------------------------------ */

const PASSWORD = "kaname-onboarding-test-password";

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

  app = await buildServer(ctx);
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@kaname.test", password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

async function steps(): Promise<Map<string, boolean>> {
  const res = await app.inject({ method: "GET", url: "/api/v1/dashboard", headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  const onboarding = JSON.parse(res.body).data.onboarding as OnboardingStep[];
  return new Map(onboarding.map((step) => [step.id, step.done]));
}

describe("Getting Started", () => {
  it("reports every area to the owner, and nothing done on an empty instance", async () => {
    const state = await steps();
    // "Every agent connected" waits for a first paired server (see below).
    expect([...state.keys()].sort()).toEqual(
      [
        "alert_rule_created",
        "backup_destination_added",
        "backup_succeeded",
        "certificate_issued",
        "database_created",
        "domain_added",
        "firewall_applied",
        "mail_server_installed",
        "mailbox_created",
        "notification_channel_added",
        "server_paired",
        "site_created",
        "ssh_key_added",
        "teammate_invited",
        "two_factor_enabled",
      ].sort(),
    );
    expect([...state.values()].every((done) => !done)).toBe(true);

    // A server row whose agent never enrolled is not paired yet either.
    await ctx.db.insert(servers).values({ name: "pending-01", hostname: "pending-01.example.test" });
    const pending = await steps();
    expect(pending.get("server_paired")).toBe(false);
    expect(pending.has("agents_connected")).toBe(false);
  });

  it("follows the rows: a paired server, a domain, an installed mail server, a teammate", async () => {
    const [server] = await ctx.db
      .insert(servers)
      .values({
        name: "web-01",
        hostname: "web-01.example.test",
        connection: "connected",
        enrolledAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning({ id: servers.id });
    await ctx.db.insert(domains).values({ name: "example.test" });
    // Deploying is not done; only an install that finished counts.
    await ctx.db.insert(mailServers).values({ serverId: server!.id, status: "deploying" });
    await ctx.db.insert(users).values({ email: "teammate@kaname.test", name: "Teammate" });

    let state = await steps();
    expect(state.get("server_paired")).toBe(true);
    // Shown once a server is paired, and not before.
    expect(state.get("agents_connected")).toBe(true);
    expect(state.get("domain_added")).toBe(true);
    expect(state.get("mail_server_installed")).toBe(false);
    expect(state.get("teammate_invited")).toBe(true);
    expect(state.get("site_created")).toBe(false);

    await ctx.db
      .update(mailServers)
      .set({ status: "installed" })
      .where(eq(mailServers.serverId, server!.id));
    await ctx.db
      .update(servers)
      .set({ connection: "disconnected" })
      .where(eq(servers.id, server!.id));

    state = await steps();
    expect(state.get("mail_server_installed")).toBe(true);
    // An agent that dropped is no longer "all connected", even though it was paired.
    expect(state.get("server_paired")).toBe(true);
    expect(state.get("agents_connected")).toBe(false);
  });
});
