import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import {
  appInstalls,
  dbDatabases,
  mailboxes,
  resourceOwners,
  roles,
  servers,
  sites,
} from "@kaname/db/schema";
import { recordOwnership } from "./services/app-ownership.js";
import { loadConfig, resetConfigForTests, type Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";

/* ------------------------------------------------------------------ *
 * Scoped accounts (KD-039): resellers, clients, ownership, quotas and
 * the view-mode preference.
 *
 * The claims under test are the ones a mistake would turn into a data
 * leak between two paying customers on one host:
 *
 *   - a client sees and touches only what it owns;
 *   - a reseller sees its own and its clients', never another's;
 *   - a create that would exceed a quota is refused, at either level;
 *   - everything that is not an ownership-scoped resource route stays
 *     operator-only, whatever roles somebody attaches;
 *   - none of this changes what an operator sees.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@scoped.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const STRONG = "Tidal-Basalt-Orchard-47";

let config: Config;
let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let ip = 10;

let owner = "";
let reseller = "";
let alice = "";
let bob = "";
let otherReseller = "";

let forgeId = "";
let dbServerId = "";
let resellerId = "";
let aliceId = "";
let bobId = "";
let carolId = "";
let seedSiteId = "";
let aliceSiteId = "";

function cookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.value);
  return cookie ? `${cookie.name}=${cookie.value}` : "";
}

const nextIp = () => `203.0.113.${(ip = (ip % 250) + 1)}`;

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const call = (cookie: string, method: Method, url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });

const data = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body).data as T;
const total = (res: LightMyRequestResponse): number => JSON.parse(res.body).meta.total as number;
const errorCode = (res: LightMyRequestResponse): string => JSON.parse(res.body).error.code;

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: nextIp(),
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

/** Accepts an invitation and signs in, the way the person would. */
async function activate(email: string, inviteUrl: string): Promise<string> {
  const token = decodeURIComponent(inviteUrl.split("/invite/")[1]!);
  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invite/accept",
    remoteAddress: nextIp(),
    payload: { token, password: STRONG },
  });
  expect(accepted.statusCode).toBe(200);
  return login(email, STRONG);
}

const siteBody = (name: string, extra: object = {}) => ({
  server_id: forgeId,
  name,
  webroot: "/etc",
  runtime: "static",
  primary_domain: `${name}.scoped.test`,
  ...extra,
});

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
  // The install's own fleet: sites, domains, mailboxes and databases
  // that belong to nobody, which no scoped account may ever see.
  await seedDemo(handle.db);
  app = await buildServer(ctx);
  await app.ready();

  owner = await login(OWNER_EMAIL, OWNER_PASSWORD);

  const [forge] = await handle.db.select().from(servers).where(eq(servers.name, "forge-01"));
  forgeId = forge!.id;
  const [dbHost] = await handle.db.select().from(servers).where(eq(servers.name, "db-01"));
  dbServerId = dbHost!.id;
  const [seedSite] = await handle.db.select().from(sites).where(eq(sites.serverId, forgeId));
  seedSiteId = seedSite!.id;

  // A reseller on forge-01, allowed two sites in total.
  const created = await call(owner, "POST", "/resellers", {
    email: "reseller@scoped.test",
    name: "Northwind Hosting",
    server_ids: [forgeId, dbServerId],
    quota: { max_sites: 2, max_domains: 10 },
    branding: {
      display_name: "Northwind",
      logo_text: "NW",
      support_email: "help@northwind.test",
      support_url: null,
    },
    send_invite: false,
  });
  expect(created.statusCode).toBe(201);
  resellerId = data(created).id;
  reseller = await activate("reseller@scoped.test", data(created).invite.url);

  // Two clients. Alice may have one site; Bob has no ceiling of his own.
  const a = await call(reseller, "POST", "/reseller/clients", {
    email: "alice@scoped.test",
    name: "Alice",
    quota: { max_sites: 1 },
    send_invite: false,
  });
  expect(a.statusCode).toBe(201);
  aliceId = data(a).id;
  alice = await activate("alice@scoped.test", data(a).invite.url);

  const b = await call(reseller, "POST", "/reseller/clients", {
    email: "bob@scoped.test",
    name: "Bob",
    send_invite: false,
  });
  expect(b.statusCode).toBe(201);
  bobId = data(b).id;
  bob = await activate("bob@scoped.test", data(b).invite.url);

  // A second reseller with a client of its own, to prove resellers are
  // walled off from each other.
  const other = await call(owner, "POST", "/resellers", {
    email: "other@scoped.test",
    name: "Contoso Hosting",
    server_ids: [forgeId],
    send_invite: false,
  });
  expect(other.statusCode).toBe(201);
  otherReseller = await activate("other@scoped.test", data(other).invite.url);
  const c = await call(otherReseller, "POST", "/reseller/clients", {
    email: "carol@scoped.test",
    name: "Carol",
    send_invite: false,
  });
  expect(c.statusCode).toBe(201);
  carolId = data(c).id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

/* ------------------------------------------------------------------ */

describe("ownership filtering", () => {
  it("shows a new client nothing, while the operator still sees the whole fleet", async () => {
    const mine = await call(alice, "GET", "/sites");
    expect(mine.statusCode).toBe(200);
    expect(total(mine)).toBe(0);

    for (const url of ["/domains", "/mailboxes", "/databases"]) {
      const res = await call(alice, "GET", url);
      expect(res.statusCode, url).toBe(200);
      expect(total(res), url).toBe(0);
    }

    const fleet = await call(owner, "GET", "/sites");
    expect(total(fleet)).toBeGreaterThan(0);
  });

  it("records a site a client creates as theirs, in a folder the client did not choose", async () => {
    const res = await call(alice, "POST", "/sites", siteBody("alice-blog"));
    expect(res.statusCode).toBe(202);

    const list = await call(alice, "GET", "/sites");
    expect(total(list)).toBe(1);
    const site = data<any[]>(list)[0];
    aliceSiteId = site.id;
    // The body asked for /etc. A scoped account does not pick a webroot.
    expect(site.webroot).toBe(`/var/www/accounts/${aliceId}/alice-blog`);

    // The primary domain came with it, and is hers too.
    const names = await call(alice, "GET", "/domains");
    expect(data<any[]>(names).map((d) => d.name)).toEqual(["alice-blog.scoped.test"]);
  });

  it("lets the reseller see its client's site, and the operator see it among the rest", async () => {
    const theirs = await call(reseller, "GET", "/sites");
    expect(data<any[]>(theirs).map((s) => s.id)).toEqual([aliceSiteId]);

    const detail = await call(reseller, "GET", `/sites/${aliceSiteId}`);
    expect(detail.statusCode).toBe(200);

    const fleet = await call(owner, "GET", `/sites/${aliceSiteId}`);
    expect(fleet.statusCode).toBe(200);
  });

  it("never shows a scoped account something the install owns", async () => {
    for (const cookie of [alice, reseller]) {
      const res = await call(cookie, "GET", `/sites/${seedSiteId}`);
      expect(res.statusCode).toBe(404);
    }
    const [seedDb] = await handle.db
      .select()
      .from(dbDatabases)
      .where(eq(dbDatabases.serverId, dbServerId))
      .limit(1);
    expect((await call(alice, "GET", `/databases/${seedDb!.id}`)).statusCode).toBe(404);
    expect((await call(alice, "DELETE", `/databases/${seedDb!.id}`)).statusCode).toBe(404);
  });

  it("scopes mailboxes and databases by owner, not by server", async () => {
    const [box] = await handle.db.select().from(mailboxes).limit(1);
    const [database] = await handle.db
      .select()
      .from(dbDatabases)
      .where(eq(dbDatabases.serverId, dbServerId))
      .limit(1);
    await handle.db.insert(resourceOwners).values([
      { kind: "mailbox", resourceId: box!.id, ownerId: aliceId },
      { kind: "database", resourceId: database!.id, ownerId: aliceId },
    ]);

    // The mailbox is hers, but its mail server is not one her reseller
    // was given, so the server scope still refuses it: both must hold.
    expect(box!.serverId).not.toBe(forgeId);
    expect(total(await call(alice, "GET", "/mailboxes"))).toBe(0);
    expect((await call(alice, "GET", `/mailboxes/${box!.id}`)).statusCode).toBe(403);

    const dbs = await call(alice, "GET", "/databases");
    expect(data<any[]>(dbs).map((d) => d.id)).toEqual([database!.id]);
    expect((await call(alice, "GET", `/databases/${database!.id}`)).statusCode).toBe(200);

    expect(total(await call(bob, "GET", "/databases"))).toBe(0);
    expect((await call(bob, "GET", `/databases/${database!.id}`)).statusCode).toBe(404);

    await handle.db.delete(resourceOwners).where(eq(resourceOwners.ownerId, aliceId)).catch(() => {});
    // Put the site and its domain back: the delete above was by owner.
    await handle.db.insert(resourceOwners).values({
      kind: "site",
      resourceId: aliceSiteId,
      ownerId: aliceId,
    });
    const [domain] = data<any[]>(await call(owner, "GET", `/domains?site_id=${aliceSiteId}`));
    await handle.db
      .insert(resourceOwners)
      .values({ kind: "domain", resourceId: domain.id, ownerId: aliceId });
  });
});

describe("cross-client denial", () => {
  it("answers 404, not 403, for another client's site on every verb", async () => {
    expect(total(await call(bob, "GET", "/sites"))).toBe(0);

    const attempts: [Method, string, object?][] = [
      ["GET", `/sites/${aliceSiteId}`],
      ["PATCH", `/sites/${aliceSiteId}`, { force_https: false }],
      ["DELETE", `/sites/${aliceSiteId}`],
      ["POST", `/sites/${aliceSiteId}/suspend`],
      ["POST", `/sites/${aliceSiteId}/resume`],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call(bob, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }

    // Still there, untouched.
    const [row] = await handle.db.select().from(sites).where(eq(sites.id, aliceSiteId));
    expect(row!.forceHttps).toBe(true);
  });

  it("refuses to attach another account's domain to a new site", async () => {
    const res = await call(
      bob,
      "POST",
      "/sites",
      siteBody("bob-grab", { domains: ["alice-blog.scoped.test"] }),
    );
    // Either the name is already answering on her site (409) or it is not
    // his to attach (404); what matters is that nothing was created.
    expect([404, 409]).toContain(res.statusCode);
    expect(total(await call(bob, "GET", "/sites"))).toBe(0);
  });

  it("refuses to point a client's domain at another client's site", async () => {
    const created = await call(bob, "POST", "/domains", { name: "bob-only.scoped.test" });
    expect(created.statusCode).toBe(201);
    const moved = await call(bob, "PATCH", `/domains/${data(created).id}`, {
      site_id: aliceSiteId,
    });
    expect(moved.statusCode).toBe(404);
  });

  it("walls one reseller off from another's clients and resources", async () => {
    expect((await call(reseller, "GET", `/reseller/clients/${carolId}`)).statusCode).toBe(404);
    expect(
      (await call(reseller, "PATCH", `/reseller/clients/${carolId}`, { name: "Mine now" }))
        .statusCode,
    ).toBe(404);
    expect((await call(reseller, "DELETE", `/reseller/clients/${carolId}`)).statusCode).toBe(404);

    expect(total(await call(otherReseller, "GET", "/sites"))).toBe(0);
    expect((await call(otherReseller, "GET", `/sites/${aliceSiteId}`)).statusCode).toBe(404);
    // Handing somebody else's site to its own client is not possible either.
    const grab = await call(otherReseller, "POST", `/reseller/clients/${carolId}/resources`, {
      kind: "site",
      resource_id: aliceSiteId,
    });
    expect(grab.statusCode).toBe(404);
  });

  it("does not let a client use the reseller area at all", async () => {
    for (const url of ["/reseller/clients", "/reseller/resources", "/reseller/branding"]) {
      expect((await call(alice, "GET", url)).statusCode, url).toBe(403);
    }
  });
});

describe("operator-only routes stay operator-only", () => {
  const closed = [
    "/servers",
    "/users",
    "/roles",
    "/api-keys",
    "/settings",
    "/resellers",
    "/resources/unowned?kind=site",
    "/db-instances",
    "/db-users",
    "/mail-servers",
    "/mail-domains",
    "/dns",
    "/certificates",
    "/deployments",
    "/ftp-accounts",
    "/backups/schedules",
    "/audit",
    "/jobs",
    "/dashboard",
  ];

  it("refuses clients and resellers on every route that does not filter by owner", async () => {
    for (const cookie of [alice, reseller]) {
      for (const url of closed) {
        const res = await call(cookie, "GET", url);
        expect([403, 404], `${url} answered ${res.statusCode}`).toContain(res.statusCode);
        if (res.statusCode === 404) expect(errorCode(res)).toBe("not_found");
      }
    }
    // And those routes do exist: the operator gets through.
    for (const url of ["/servers", "/users", "/resellers", "/db-instances", "/jobs"]) {
      expect((await call(owner, "GET", url)).statusCode, url).toBe(200);
    }
  });

  it("refuses verbs on an owned resource that reach past it into the host", async () => {
    // Reloading the web server touches every site on the host.
    expect((await call(alice, "POST", `/sites/${aliceSiteId}/reload`)).statusCode).toBe(403);
    expect((await call(alice, "GET", `/sites/${aliceSiteId}/deployments`)).statusCode).toBe(403);
  });

  it("refuses the choices that would let a shared host be reached through a site", async () => {
    const proxy = await call(
      bob,
      "POST",
      "/sites",
      siteBody("bob-proxy", { runtime: "proxy", upstream: "http://127.0.0.1:4000" }),
    );
    expect(proxy.statusCode).toBe(403);

    const asRoot = await call(bob, "POST", "/sites", siteBody("bob-root", { owner: "root" }));
    expect(asRoot.statusCode).toBe(403);

    const escape = await call(bob, "POST", "/sites", siteBody("../../etc"));
    expect(escape.statusCode).toBe(422);

    const provider = await call(bob, "POST", "/domains", {
      name: "bob-cf.scoped.test",
      dns_provider: "cloudflare",
    });
    expect(provider.statusCode).toBe(403);

    const moved = await call(alice, "PATCH", `/sites/${aliceSiteId}`, { webroot: "/etc" });
    expect(moved.statusCode).toBe(403);
  });

  it("ignores a role attached to a scoped account", async () => {
    const [ownerRole] = await handle.db.select().from(roles).where(eq(roles.slug, "owner"));
    const attached = await call(owner, "POST", `/users/${aliceId}/roles`, {
      role_ids: [ownerRole!.id],
    });
    expect(attached.statusCode).toBe(200);

    expect((await call(alice, "GET", "/users")).statusCode).toBe(403);
    expect((await call(alice, "GET", "/servers")).statusCode).toBe(403);
    expect(total(await call(alice, "GET", "/sites"))).toBe(1);
  });

  it("reports the scoped permission list, not role grants, in the session", async () => {
    const session = data(await call(alice, "GET", "/auth/session"));
    const held = session.permissions.map((p: any) => p.permission);
    expect(held).toContain("websites.sites:write");
    expect(held).not.toContain("infra.servers:read");
    expect(held).not.toContain("admin.users:read");
    for (const p of session.permissions) {
      expect(p.scope.kind).toBe("servers");
      expect([...p.scope.server_ids].sort()).toEqual([forgeId, dbServerId].sort());
    }
    expect(session.user.audience).toBe("client");
  });
});

describe("quotas", () => {
  it("refuses a create over the client's own limit", async () => {
    const res = await call(alice, "POST", "/sites", siteBody("alice-second"));
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe("quota_exceeded");
    expect(total(await call(alice, "GET", "/sites"))).toBe(1);
    // Nothing half-made was left behind for the operator to find.
    const rows = await handle.db.select().from(sites).where(eq(sites.name, "alice-second"));
    expect(rows).toHaveLength(0);
  });

  it("holds a client with no limit of its own inside the reseller's", async () => {
    // Reseller: two sites in total. Alice has one; Bob takes the second.
    const first = await call(bob, "POST", "/sites", siteBody("bob-one"));
    expect(first.statusCode).toBe(202);

    const second = await call(bob, "POST", "/sites", siteBody("bob-two"));
    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe("quota_exceeded");
    expect(JSON.parse(second.body).error.message).toMatch(/provider/i);

    // The reseller itself is out of room too.
    const own = await call(reseller, "POST", "/sites", siteBody("reseller-own"));
    expect(own.statusCode).toBe(409);
  });

  it("reports usage against the quota on /me, and the reseller's branding to its client", async () => {
    const me = data(await call(alice, "GET", "/me"));
    expect(me.audience).toBe("client");
    expect(me.quota.max_sites).toBe(1);
    expect(me.usage.sites).toBe(1);
    expect(me.branding).toMatchObject({ display_name: "Northwind", logo_text: "NW" });
    expect(me.servers.map((s: any) => s.name)).toEqual(["db-01", "forge-01"]);

    const pool = data(await call(reseller, "GET", "/me"));
    expect(pool.audience).toBe("reseller");
    expect(pool.usage.sites).toBe(2);
    expect(pool.quota.max_sites).toBe(2);

    const operator = data(await call(owner, "GET", "/me"));
    expect(operator).toMatchObject({ audience: "operator", quota: null, usage: null });
  });

  it("does not let a reseller give a client more than it has", async () => {
    const res = await call(reseller, "PATCH", `/reseller/clients/${bobId}`, {
      quota: { max_sites: 3 },
    });
    expect(res.statusCode).toBe(422);
    const ok = await call(reseller, "PATCH", `/reseller/clients/${bobId}`, {
      quota: { max_sites: 2 },
    });
    expect(ok.statusCode).toBe(200);
    expect(data(ok).quota.max_sites).toBe(2);
  });

  it("applies the quota to a hand-over as well as to a create", async () => {
    // The operator cannot push a third site into a reseller allowed two.
    const full = await call(owner, "POST", `/resellers/${resellerId}/resources`, {
      kind: "site",
      resource_id: seedSiteId,
    });
    expect(full.statusCode).toBe(409);
    expect(errorCode(full)).toBe("quota_exceeded");

    const raised = await call(owner, "PATCH", `/resellers/${resellerId}`, {
      quota: { max_sites: 3 },
    });
    expect(raised.statusCode).toBe(200);

    const handed = await call(owner, "POST", `/resellers/${resellerId}/resources`, {
      kind: "site",
      resource_id: seedSiteId,
    });
    expect(handed.statusCode).toBe(200);
    expect((await call(reseller, "GET", `/sites/${seedSiteId}`)).statusCode).toBe(200);
    expect((await call(bob, "GET", `/sites/${seedSiteId}`)).statusCode).toBe(404);

    // Alice is full, so the reseller cannot hand it to her...
    const toAlice = await call(reseller, "POST", `/reseller/clients/${aliceId}/resources`, {
      kind: "site",
      resource_id: seedSiteId,
    });
    expect(toAlice.statusCode).toBe(409);

    // ...but can to Bob, who then sees it, until it is taken back.
    const toBob = await call(reseller, "POST", `/reseller/clients/${bobId}/resources`, {
      kind: "site",
      resource_id: seedSiteId,
    });
    expect(toBob.statusCode).toBe(200);
    expect((await call(bob, "GET", `/sites/${seedSiteId}`)).statusCode).toBe(200);
    expect((await call(alice, "GET", `/sites/${seedSiteId}`)).statusCode).toBe(404);

    const back = await call(
      reseller,
      "DELETE",
      `/reseller/clients/${bobId}/resources/site/${seedSiteId}`,
    );
    expect(back.statusCode).toBe(204);
    expect((await call(bob, "GET", `/sites/${seedSiteId}`)).statusCode).toBe(404);
    expect((await call(reseller, "GET", `/sites/${seedSiteId}`)).statusCode).toBe(200);
  });
});

describe("view mode preference", () => {
  it("defaults an operator to advanced and a new client to simplified", async () => {
    expect(data(await call(owner, "GET", "/me")).view_mode).toBe("advanced");
    expect(data(await call(alice, "GET", "/me")).view_mode).toBe("simplified");
  });

  it("persists across sessions, per user", async () => {
    const set = await call(owner, "PUT", "/me/view-mode", { view_mode: "simplified" });
    expect(set.statusCode).toBe(200);
    expect(data(set).view_mode).toBe("simplified");

    // A new session, as on another machine.
    const again = await login(OWNER_EMAIL, OWNER_PASSWORD);
    expect(data(await call(again, "GET", "/me")).view_mode).toBe("simplified");
    // Somebody else's is untouched.
    expect(data(await call(reseller, "GET", "/me")).view_mode).toBe("simplified");
    await call(reseller, "PUT", "/me/view-mode", { view_mode: "advanced" });
    expect(data(await call(again, "GET", "/me")).view_mode).toBe("simplified");
    expect(data(await call(reseller, "GET", "/me")).view_mode).toBe("advanced");

    await call(owner, "PUT", "/me/view-mode", { view_mode: "advanced" });
  });

  it("rejects a mode that does not exist, and an anonymous caller", async () => {
    const bad = await call(owner, "PUT", "/me/view-mode", { view_mode: "expert" });
    expect(bad.statusCode).toBe(422);
    const anon = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("changes nothing about what the API allows", async () => {
    await call(owner, "PUT", "/me/view-mode", { view_mode: "simplified" });
    expect((await call(owner, "GET", "/audit")).statusCode).toBe(200);
    await call(owner, "PUT", "/me/view-mode", { view_mode: "advanced" });
  });
});

describe("app installs", () => {
  let bobSiteId = "";
  const installRow = (domain: string, createdBy: string | null, siteId: string | null = null) => ({
    appId: "wordpress",
    appName: "WordPress",
    appVersion: "6.8",
    serverId: forgeId,
    domain,
    status: "active" as const,
    inputs: { admin_email: "ops@scoped.test", system_user: "www-data", php_version: null },
    siteId,
    createdBy,
  });

  it("records what a scoped account's install creates as theirs, and nothing for an operator", async () => {
    const owned = await handle.db.select({ id: resourceOwners.resourceId }).from(resourceOwners);
    const ownedIds = new Set(owned.map((o) => o.id));
    const free = (await handle.db.select().from(sites).where(eq(sites.serverId, forgeId))).filter(
      (s) => !ownedIds.has(s.id),
    );
    expect(free.length).toBeGreaterThanOrEqual(2);
    bobSiteId = free[0]!.id;
    const ownerUserId = data(await call(owner, "GET", "/me")).user_id as string;
    const before = data(await call(bob, "GET", "/me")).usage.sites as number;
    const record = { serverId: forgeId, installId: crypto.randomUUID() };

    await recordOwnership(handle.db, { ...record, userId: bobId, kind: "site", resourceId: bobSiteId });
    // Kinds the ownership table does not model, and an operator's install, record nothing.
    await recordOwnership(handle.db, { ...record, userId: bobId, kind: "certificate", resourceId: crypto.randomUUID() });
    await recordOwnership(handle.db, { ...record, userId: ownerUserId, kind: "site", resourceId: free[1]!.id });

    expect(data(await call(bob, "GET", "/me")).usage.sites).toBe(before + 1);
    expect((await call(bob, "GET", `/sites/${bobSiteId}`)).statusCode).toBe(200);
    const rows = await handle.db.select().from(resourceOwners).where(eq(resourceOwners.resourceId, free[1]!.id));
    expect(rows).toHaveLength(0);
  });

  it("shows a scoped account only the installs it started or whose site it owns", async () => {
    const ownerUserId = data(await call(owner, "GET", "/me")).user_id as string;
    const [mine, ops, viaSite] = await handle.db
      .insert(appInstalls)
      .values([
        installRow("bob-blog.scoped.test", bobId),
        installRow("ops-blog.scoped.test", ownerUserId),
        installRow("handed-over.scoped.test", ownerUserId, bobSiteId),
      ])
      .returning();

    const ids = async (cookie: string) =>
      (data<{ id: string }[]>(await call(cookie, "GET", "/apps/installs?per_page=100")) ?? []).map((r) => r.id);

    const bobSees = await ids(bob);
    expect(bobSees).toEqual(expect.arrayContaining([mine!.id, viaSite!.id]));
    expect(bobSees).not.toContain(ops!.id);
    // The reseller answers for its clients' installs; a sibling client does not see them.
    expect(await ids(reseller)).toEqual(expect.arrayContaining([mine!.id, viaSite!.id]));
    expect(await ids(alice)).not.toContain(mine!.id);
    expect(await ids(owner)).toEqual(expect.arrayContaining([mine!.id, ops!.id, viaSite!.id]));

    expect((await call(bob, "GET", `/apps/installs/${mine!.id}`)).statusCode).toBe(200);
    expect((await call(bob, "GET", `/apps/installs/${ops!.id}`)).statusCode).toBe(404);
    expect((await call(bob, "DELETE", `/apps/installs/${ops!.id}`)).statusCode).toBe(404);
    expect((await call(alice, "GET", `/apps/installs/${mine!.id}`)).statusCode).toBe(404);
    expect((await call(bob, "GET", "/apps/catalog")).statusCode).toBe(200);
  });
});

describe("a reseller's standing", () => {
  it("takes the servers away from its clients the moment it is suspended", async () => {
    const suspended = await call(owner, "PATCH", `/resellers/${resellerId}`, {
      status: "suspended",
    });
    expect(suspended.statusCode).toBe(200);

    // The reseller is signed out; its client can sign in but reach nothing.
    expect((await call(reseller, "GET", "/me")).statusCode).toBe(401);
    expect((await call(alice, "GET", "/sites")).statusCode).toBe(403);
    expect(data(await call(alice, "GET", "/me")).servers).toEqual([]);

    const restored = await call(owner, "PATCH", `/resellers/${resellerId}`, { status: "active" });
    expect(restored.statusCode).toBe(200);
    expect(total(await call(alice, "GET", "/sites"))).toBe(1);
  });

  it("cannot be removed while it still has clients", async () => {
    const res = await call(owner, "DELETE", `/resellers/${resellerId}`);
    expect(res.statusCode).toBe(409);
  });

  it("returns a removed client's resources to the reseller", async () => {
    reseller = await login("reseller@scoped.test", STRONG);
    const removed = await call(reseller, "DELETE", `/reseller/clients/${aliceId}`);
    expect(removed.statusCode).toBe(204);
    expect((await call(alice, "GET", "/me")).statusCode).toBe(401);

    const owned = data<any[]>(await call(reseller, "GET", "/reseller/resources"));
    const site = owned.find((r) => r.kind === "site" && r.id === aliceSiteId);
    expect(site).toMatchObject({ owner_id: resellerId });
  });
});
