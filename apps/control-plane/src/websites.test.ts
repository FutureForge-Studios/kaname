import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import {
  certificates,
  deployments,
  dnsRecords,
  domains,
  jobs,
  secrets,
  sites,
} from "@kaname/db/schema";
import type { JobType } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { registerJobHandlers } from "./jobs/handlers.js";
import { deployRoot, releaseName } from "./jobs/websites.js";
import type { JobContext, JobHandler, JobWorker } from "./jobs/worker.js";
import { seal } from "./lib/crypto.js";
import { ApiException } from "./lib/errors.js";
import { checkCertificatePair } from "./services/certificate-pem.js";
import {
  EXPIRED_CERT,
  EXPIRED_KEY,
  OTHER_CERT,
  OTHER_KEY,
  TEST_CA,
  WILDCARD_CERT,
  WILDCARD_KEY,
} from "./test-certs.js";

/* ------------------------------------------------------------------ *
 * Websites job handlers and the custom-certificate check, driven
 * directly against an in-memory database. The agent is a stub that
 * answers by method; Cloudflare is a stub HTTP server on loopback,
 * reached through KANAME_CLOUDFLARE_API_URL exactly as production
 * reaches the real API.
 * ------------------------------------------------------------------ */

class FakeHub {
  readonly connected = new Set<string>();
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly answers = new Map<string, (params: never) => unknown>();

  isConnected(serverId: string): boolean {
    return this.connected.has(serverId);
  }
  capabilities(): string[] {
    return ["nginx", "simulated"];
  }
  connectedServerIds(): string[] {
    return [...this.connected];
  }
  async call(serverId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected.has(serverId)) throw new AgentOfflineError(serverId);
    this.calls.push({ method, params });
    const answer = this.answers.get(method);
    if (!answer) throw new AgentRpcError({ code: "unsupported", message: `no ${method}` });
    return answer(params as never);
  }
  stream(): never {
    throw new Error("streams are not scripted here");
  }
  as(): AgentHub {
    return this as unknown as AgentHub;
  }
}

/** The handful of Cloudflare endpoints the provider uses, over one in-memory zone. */
interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}
const cf = {
  zone: { id: "zone-1", name: "", name_servers: ["ada.ns.cloudflare.com"] },
  records: [] as CfRecord[],
  seq: 0,
  writes: [] as string[],
};

function startCloudflare(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://cf");
      const reply = (result: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: status < 400,
            errors: [],
            result,
            result_info: { page: 1, total_pages: 1 },
          }),
        );
      };
      if (req.headers.authorization !== "Bearer cf-test-token-0123456789abcdef")
        return reply(null, 403);
      const path = url.pathname;
      if (path === "/zones") return reply([cf.zone]);
      if (path === `/zones/${cf.zone.id}`) return reply(cf.zone);
      if (path === `/zones/${cf.zone.id}/dns_records` && req.method === "GET")
        return reply(cf.records);
      const body = raw ? (JSON.parse(raw) as Omit<CfRecord, "id">) : null;
      if (path === `/zones/${cf.zone.id}/dns_records` && req.method === "POST" && body) {
        const rec = { ...body, id: `rec-${++cf.seq}` };
        cf.records.push(rec);
        cf.writes.push(`POST ${rec.name} ${rec.content}`);
        return reply(rec);
      }
      const id = path.split("/").pop()!;
      const at = cf.records.findIndex((r) => r.id === id);
      if (at < 0) return reply(null, 404);
      if (req.method === "DELETE") {
        cf.records.splice(at, 1);
        return reply({ id });
      }
      if (body) {
        cf.records[at] = { ...cf.records[at]!, ...body, id };
        cf.writes.push(`${req.method} ${body.name} ${body.content}`);
        return reply(cf.records[at]);
      }
      return reply(null, 400);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let handle: DbHandle;
let ctx: AppContext;
let hub: FakeHub;
let handlers: Map<JobType, JobHandler>;
let cfServer: Server;
let serverId: string;

beforeAll(async () => {
  cfServer = await startCloudflare();
  const port = (cfServer.address() as AddressInfo).port;
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-integration-test-password",
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
    KANAME_CLOUDFLARE_API_URL: `http://127.0.0.1:${port}`,
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await seedDemo(handle.db);

  hub = new FakeHub();
  handlers = new Map();
  registerJobHandlers({
    registerAll(map: Partial<Record<JobType, JobHandler>>) {
      for (const [type, handler] of Object.entries(map)) {
        if (handler) handlers.set(type as JobType, handler);
      }
    },
  } as unknown as JobWorker);

  const [site] = await handle.db.select().from(sites).where(eq(sites.name, "forgebase-docs"));
  serverId = site!.serverId;
  hub.connected.add(serverId);
}, 120_000);

afterAll(async () => {
  cfServer?.close();
  await handle?.close();
  resetConfigForTests();
});

async function run(type: JobType, params: Record<string, unknown>, onServer = true) {
  const queued = await ctx.queue.enqueue({ type, serverId: onServer ? serverId : null, params });
  const claimed = await ctx.queue.claim("test-worker", 60, [serverId]);
  if (!claimed || claimed.id !== queued.id) throw new Error("claimed the wrong job");
  const logs: string[] = [];
  const jobCtx: JobContext = {
    ...ctx,
    hub: hub.as(),
    job: claimed,
    signal: new AbortController().signal,
    log_: async (level, message) => {
      logs.push(`${level}: ${message}`);
    },
    progress: async () => undefined,
  };
  const handler = handlers.get(type);
  if (!handler) throw new Error(`no handler for ${type}`);
  return { result: handler(jobCtx), logs, jobId: claimed.id };
}

function apiError(fn: () => unknown): ApiException {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiException) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

/* --------------------------- custom certificates -------------------- */

describe("checkCertificatePair", () => {
  it("accepts a wildcard chain whose key matches, for a name it covers", () => {
    const ok = checkCertificatePair(`${WILDCARD_CERT}${TEST_CA}`, WILDCARD_KEY, "shop.e2e.test");
    expect(ok.sans).toEqual(["*.e2e.test", "e2e.test"]);
    expect(ok.keyType).toBe("ecdsa");
    expect(ok.issuer).toBe("Kaname E2E Test CA");
    expect(ok.notAfter.getUTCFullYear()).toBe(2126);
    expect(ok.chainPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
  });

  it("names the field and the reason for each way a pair is wrong", () => {
    const cases: [string, string, string, string, RegExp][] = [
      ["not pem", WILDCARD_KEY, "a.e2e.test", "certificate_pem", /No certificate found/],
      [WILDCARD_CERT, "garbage", "a.e2e.test", "key_pem", /Not a PEM private key/],
      [WILDCARD_CERT, OTHER_KEY, "a.e2e.test", "key_pem", /does not belong to the certificate/],
      [EXPIRED_CERT, EXPIRED_KEY, "a.e2e.test", "certificate_pem", /expired on 2021-01-01/],
      [
        WILDCARD_CERT,
        WILDCARD_KEY,
        "a.b.e2e.test",
        "certificate_pem",
        /does not cover a\.b\.e2e\.test; it is for \*\.e2e\.test, e2e\.test/,
      ],
      [OTHER_CERT, OTHER_KEY, "a.e2e.test", "certificate_pem", /it is for other\.example/],
      [
        `${TEST_CA}${WILDCARD_CERT}`,
        WILDCARD_KEY,
        "a.e2e.test",
        "certificate_pem",
        /out of order: it starts with a CA certificate/,
      ],
      [
        WILDCARD_CERT,
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA\n-----END ENCRYPTED PRIVATE KEY-----",
        "a.e2e.test",
        "key_pem",
        /passphrase/,
      ],
    ];
    for (const [cert, key, domain, field, reason] of cases) {
      const err = apiError(() => checkCertificatePair(cert, key, domain));
      expect(err.code).toBe("validation_failed");
      expect(err.message).toMatch(reason);
      expect(Object.keys(err.fields ?? {})).toEqual([field]);
    }
  });

  it("refuses a chain whose intermediates are out of order", () => {
    const err = apiError(() =>
      checkCertificatePair(`${WILDCARD_CERT}${OTHER_CERT}`, WILDCARD_KEY, "a.e2e.test"),
    );
    expect(err.message).toMatch(/out of order: certificate 2 did not issue certificate 1/);
  });
});

describe("cert.install", () => {
  it("opens the sealed key only for the RPC, and never keeps it in the job", async () => {
    const [domain] = await handle.db
      .select()
      .from(domains)
      .where(eq(domains.name, "docs.forgebase.dev"));
    const [cert] = await handle.db
      .insert(certificates)
      .values({ domainId: domain!.id, serverId, subject: "install.e2e.test", status: "pending" })
      .returning();
    hub.answers.set("cert.install", () => ({
      path: "/etc/ssl/kaname/install.e2e.test/fullchain.pem",
    }));
    hub.answers.set("site.update", () => ({ config_path: "/etc/nginx/sites-available/x" }));
    hub.answers.set("site.reload", () => ({ ok: true }));

    const { result, jobId } = await run("cert.install", {
      certificate_id: cert!.id,
      domain_id: domain!.id,
      subject: "install.e2e.test",
      certificate_pem: WILDCARD_CERT,
      key_sealed: seal(WILDCARD_KEY, ctx.config.masterKey),
    });
    await result;
    await ctx.queue.complete(jobId, await result);

    const sent = hub.calls.find((c) => c.method === "cert.install")!;
    expect(sent.params.key_pem).toBe(WILDCARD_KEY);
    const [row] = await handle.db.select().from(certificates).where(eq(certificates.id, cert!.id));
    expect(row!.status).toBe("active");
    expect(row!.installedPath).toBe("/etc/ssl/kaname/install.e2e.test/fullchain.pem");

    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(JSON.stringify(job!.params)).not.toContain("PRIVATE KEY");
    expect(job!.params.key_sealed).toBe("[redacted]");
  });
});

/* ------------------------------ suspend ----------------------------- */

describe("site.suspend and site.resume", () => {
  it("disables the vhost, then marks the row; a refusal is recorded, not left active", async () => {
    const [site] = await handle.db.select().from(sites).where(eq(sites.name, "legacy-shop"));
    hub.answers.set("site.update", () => ({
      config_path: "/etc/nginx/sites-available/legacy-shop",
    }));
    hub.answers.set("site.reload", () => ({ ok: true }));

    await (
      await run("site.suspend", { site_id: site!.id, name: site!.name })
    ).result;
    const update = hub.calls.filter((c) => c.method === "site.update").pop()!;
    expect(update.params).toEqual({ name: "legacy-shop", enabled: false });
    expect((await handle.db.select().from(sites).where(eq(sites.id, site!.id)))[0]!.status).toBe(
      "suspended",
    );

    await (
      await run("site.resume", { site_id: site!.id, name: site!.name })
    ).result;
    expect(hub.calls.filter((c) => c.method === "site.update").pop()!.params.enabled).toBe(true);
    expect((await handle.db.select().from(sites).where(eq(sites.id, site!.id)))[0]!.status).toBe(
      "active",
    );

    hub.answers.set("site.update", () => {
      throw new AgentRpcError({ code: "not_found", message: "site legacy-shop" });
    });
    await expect(
      (await run("site.suspend", { site_id: site!.id, name: site!.name })).result,
    ).rejects.toThrow();
    const [after] = await handle.db.select().from(sites).where(eq(sites.id, site!.id));
    expect(after!.status).toBe("error");
    expect(after!.lastError).toContain("legacy-shop");
  });
});

/* ---------------------------- deployments --------------------------- */

describe("deployments", () => {
  it("derive the deploy root and a time-sortable release name", () => {
    expect(deployRoot("/var/www/app/current")).toBe("/var/www/app");
    expect(deployRoot("/var/www/app/current/")).toBe("/var/www/app");
    expect(deployRoot("/var/www/docs")).toBe("/var/www/docs");
    const a = releaseName("aaaaaaaa-0000", new Date("2026-11-07T10:15:00.123Z"));
    expect(a).toBe("20261107T101500Z-aaaaaaaa");
    expect(releaseName("b", new Date("2026-11-08T00:00:00Z")) > a).toBe(true);
  });

  it("record the release the host wrote, forget pruned ones, and roll back onto it", async () => {
    const [site] = await handle.db.select().from(sites).where(eq(sites.name, "forgebase-docs"));
    const [pruned] = await handle.db
      .select()
      .from(deployments)
      .where(eq(deployments.siteId, site!.id))
      .limit(1);
    const [row] = await handle.db
      .insert(deployments)
      .values({ siteId: site!.id, source: "git", branch: "main", status: "queued" })
      .returning();

    hub.answers.set("site.release.create", (p: { root: string; release: string }) => ({
      release_path: `${p.root}/releases/${p.release}`,
      current_path: `${p.root}/current`,
      commit_sha: "a".repeat(40),
      pruned: [pruned!.releasePath],
      log: ["cloning", "checked out"],
    }));
    const { result, logs } = await run("deployment.run", {
      deployment_id: row!.id,
      site_id: site!.id,
      site_name: site!.name,
      source: "git",
      repo_url: "https://github.com/acme/docs.git",
      branch: "main",
      commit_sha: null,
      webroot: site!.webroot,
    });
    await result;
    const sent = hub.calls.filter((c) => c.method === "site.release.create").pop()!.params;
    expect(sent).toMatchObject({
      name: "forgebase-docs",
      root: site!.webroot,
      source: "git",
      keep: 5,
    });
    expect(logs).toContain("info: deployment started");

    const [done] = await handle.db.select().from(deployments).where(eq(deployments.id, row!.id));
    expect(done!.status).toBe("succeeded");
    expect(done!.releasePath).toBe(`${site!.webroot}/releases/${sent.release as string}`);
    expect(done!.commitSha).toBe("a".repeat(40));
    const [forgotten] = await handle.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, pruned!.id));
    expect(forgotten!.releasePath).toBeNull();

    // Rolling back onto the panel-made release switches the symlink.
    const [back] = await handle.db
      .insert(deployments)
      .values({ siteId: site!.id, source: "git", status: "queued", releasePath: done!.releasePath })
      .returning();
    hub.answers.set("site.release.activate", (p: { release_path: string; root: string }) => ({
      current_path: `${p.root}/current`,
      release_path: p.release_path,
      previous: null,
    }));
    await (
      await run("deployment.rollback", {
        deployment_id: back!.id,
        rollback_to_deployment_id: done!.id,
        release_path: done!.releasePath,
        webroot: site!.webroot,
        site_name: site!.name,
      })
    ).result;
    expect(hub.calls.filter((c) => c.method === "site.release.activate").pop()!.params).toEqual({
      name: "forgebase-docs",
      root: site!.webroot,
      release_path: done!.releasePath,
    });
    expect(
      (await handle.db.select().from(deployments).where(eq(deployments.id, back!.id)))[0]!.status,
    ).toBe("succeeded");
  });

  it("fail a rollback onto a release the host no longer has, and forget its path", async () => {
    const [site] = await handle.db.select().from(sites).where(eq(sites.name, "forgebase-docs"));
    const [target] = await handle.db
      .insert(deployments)
      .values({
        siteId: site!.id,
        status: "succeeded",
        releasePath: `${site!.webroot}/releases/gone`,
      })
      .returning();
    const [back] = await handle.db
      .insert(deployments)
      .values({ siteId: site!.id, status: "queued", releasePath: target!.releasePath })
      .returning();
    hub.answers.set("site.release.activate", () => {
      throw new AgentRpcError({
        code: "not_found",
        message: "release directory gone is not on this host",
      });
    });
    await expect(
      (
        await run("deployment.rollback", {
          deployment_id: back!.id,
          rollback_to_deployment_id: target!.id,
          release_path: target!.releasePath,
          webroot: site!.webroot,
          site_name: site!.name,
        })
      ).result,
    ).rejects.toThrow(/not on this host/);
    expect(
      (await handle.db.select().from(deployments).where(eq(deployments.id, back!.id)))[0]!.status,
    ).toBe("failed");
    expect(
      (await handle.db.select().from(deployments).where(eq(deployments.id, target!.id)))[0]!
        .releasePath,
    ).toBeNull();
  });
});

/* -------------------------------- dns ------------------------------- */

describe("dns.sync and dns.apply against Cloudflare", () => {
  it("pulls the zone, keeps what Kaname wanted as drift, and pushes it back", async () => {
    const [domain] = await handle.db
      .insert(domains)
      .values({ name: "zone.e2e.test", dnsProvider: "cloudflare", serverId })
      .returning();
    cf.zone.name = "zone.e2e.test";
    const sealed = seal("cf-test-token-0123456789abcdef", ctx.config.masterKey);
    await handle.db
      .insert(secrets)
      .values({
        ref: `dns.cloudflare:${domain!.id}`,
        ownerType: "domain",
        ownerId: domain!.id,
        ...sealed,
      });
    cf.records = [
      {
        id: "r1",
        type: "A",
        name: "zone.e2e.test",
        content: "203.0.113.10",
        ttl: 300,
        proxied: false,
      },
      { id: "r2", type: "TXT", name: "zone.e2e.test", content: "hello", ttl: 300, proxied: false },
    ];

    const first = await (
      await run("dns.sync", { domain_id: domain!.id, adopt_unmanaged: true }, false)
    ).result;
    expect(first).toMatchObject({ created: 2, adopted: 2, drifted: 0, zone_id: "zone-1" });

    // Changed at the provider, behind Kaname's back — twice: the drift
    // must keep Kaname's value, not the previous provider value.
    cf.records[0]!.content = "198.51.100.1";
    await (
      await run("dns.sync", { domain_id: domain!.id }, false)
    ).result;
    cf.records[0]!.content = "198.51.100.2";
    cf.records.splice(1, 1);
    const second = (await (
      await run("dns.sync", { domain_id: domain!.id }, false)
    ).result) as {
      drifted: number;
    };
    expect(second.drifted).toBe(2);
    const drifted = await handle.db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain!.id));
    const a = drifted.find((r) => r.type === "A")!;
    expect(a.content).toBe("198.51.100.2");
    expect(a.drift).toMatchObject({ expected: "203.0.113.10", actual: "198.51.100.2" });
    expect(drifted.find((r) => r.type === "TXT")!.drift).toMatchObject({
      expected: "hello",
      actual: null,
    });

    cf.writes = [];
    const applied = await (
      await run(
        "dns.apply",
        { domain_id: domain!.id, records: [], delete_ids: [], fail_on_drift: true },
        false,
      )
    ).result;
    expect(applied).toMatchObject({ restored: 2 });
    expect(cf.writes.sort()).toEqual(
      ["PUT zone.e2e.test 203.0.113.10", "POST zone.e2e.test hello"].sort(),
    );
    const after = await handle.db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain!.id));
    expect(after.every((r) => r.drift === null)).toBe(true);
    expect(after.find((r) => r.type === "A")!.content).toBe("203.0.113.10");
  });

  it("refuses a manual zone with the message the route has always given", async () => {
    const [manual] = await handle.db
      .insert(domains)
      .values({ name: "manual.e2e.test" })
      .returning();
    await expect((await run("dns.sync", { domain_id: manual!.id }, false)).result).rejects.toThrow(
      "manual.e2e.test has no API-driven DNS provider, so there is no authoritative zone to pull.",
    );
  });
});
