import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { appInstalls, backupSchedules, jobs, restorePoints, servers } from "@kaname/db/schema";
import {
  S3_PROVIDER_PRESETS,
  appInstallSteps,
  backupDestinationTarget,
  findApp,
  isNewerVersion,
  s3BaseUrl,
  s3EndpointFor,
  s3SigningRegion,
  type AppBackupManifest,
  type S3Provider,
} from "@kaname/contract";
import { MANAGED_APPS_ROOT } from "@kaname/contract/agent";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig, resetConfigForTests, type Config } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { RESTORE_TIMING, appBackupJobHandlers, emptyPrepared, prepareAppBackups } from "./jobs/app-backups.js";
import type { JobContext } from "./jobs/worker.js";
import { buildServer } from "./server.js";
import { buildManifest, pathsFor, planEntry } from "./services/app-backup-plan.js";
import { classifyS3Failure, objectUrl, probeS3, signS3Request } from "./services/s3-probe.js";

/* ------------------------------------------------------------------ *
 * App backup & restore (KD-041) and first-class S3 destinations.
 *
 *   - presets map each provider to the endpoint and signing region its
 *     own documentation gives, and the target schema enforces the rules
 *     a flat object cannot;
 *   - "Test connection" really writes, reads and deletes, signs with
 *     SigV4 (pinned to AWS's published example) and names the failure;
 *   - an app scope plans the right paths, excludes and dumps;
 *   - the routes gate on ownership, typed confirmation and version;
 *   - the restore job stages, swaps, imports, starts and checks — and
 *     puts the original back when the import fails.
 * ------------------------------------------------------------------ */

const ghost = findApp("ghost")!;
const wordpress = findApp("wordpress")!;

/* ----------------------------- presets ----------------------------- */

describe("S3 provider presets", () => {
  const cases: [S3Provider, string, string | null, string, string][] = [
    ["aws", "eu-central-1", null, "s3.eu-central-1.amazonaws.com", "eu-central-1"],
    ["r2", "auto", "0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com", "auto"],
    ["b2", "us-west-004", null, "s3.us-west-004.backblazeb2.com", "us-west-004"],
    ["wasabi", "eu-central-2", null, "s3.eu-central-2.wasabisys.com", "eu-central-2"],
    ["spaces", "fra1", null, "fra1.digitaloceanspaces.com", "us-east-1"],
    ["hetzner", "nbg1", null, "nbg1.your-objectstorage.com", "nbg1"],
  ];

  it.each(cases)("%s in %s maps to its documented endpoint and signing region", (provider, region, account, host, signing) => {
    expect(s3EndpointFor(provider, region, account)).toBe(host);
    expect(s3SigningRegion(provider, region)).toBe(signing);
    expect(s3BaseUrl({ provider, region, account_id: account })).toBe(`https://${host}`);
  });

  it("needs a typed endpoint for MinIO, keeps an http scheme, and lets an endpoint override a preset", () => {
    expect(s3EndpointFor("minio", "us-east-1")).toBeNull();
    expect(s3BaseUrl({ provider: "minio", region: "us-east-1", endpoint: "http://10.0.0.5:9000" })).toBe(
      "http://10.0.0.5:9000",
    );
    expect(s3BaseUrl({ provider: "aws", region: "us-east-1", endpoint: "s3.custom.example" })).toBe(
      "https://s3.custom.example",
    );
    for (const preset of Object.values(S3_PROVIDER_PRESETS)) {
      expect(preset.docs_url).toMatch(/^https:\/\//);
      if (preset.regions.length > 0) {
        expect(preset.regions.map((r) => r.value)).toContain(preset.default_region);
      }
    }
  });

  const base = { kind: "s3", bucket: "kaname-backups", access_key_id: "AKIA1234", secret_access_key: "secret" };

  it("validates the target: provider rules, bucket names and prefixes", () => {
    expect(backupDestinationTarget.safeParse({ ...base, provider: "aws", region: "eu-west-1" }).success).toBe(true);
    const refused: [string, object][] = [
      ["R2 without an account id", { provider: "r2", region: "auto" }],
      ["MinIO without an endpoint", { provider: "minio" }],
      ["a region the provider does not have", { provider: "hetzner", region: "eu-central-1" }],
      ["an uppercase bucket", { provider: "aws", bucket: "Backups" }],
      ["a bucket that looks like an IP", { provider: "aws", bucket: "10.0.0.1" }],
      ["a prefix with traversal", { provider: "aws", prefix: "a/../b" }],
      ["a prefix with a leading slash", { provider: "aws", prefix: "/abs" }],
      ["an endpoint with a path", { provider: "minio", endpoint: "https://minio.local/bucket" }],
      ["an R2 account id that is not one", { provider: "r2", region: "auto", account_id: "nope" }],
    ];
    for (const [label, patch] of refused) {
      expect(backupDestinationTarget.safeParse({ ...base, ...patch }).success, label).toBe(false);
    }
    expect(
      backupDestinationTarget.safeParse({ ...base, provider: "b2", region: "eu-central-003", prefix: "kaname/" }).success,
    ).toBe(true);
  });
});

/* ------------------------------ SigV4 ------------------------------ */

describe("S3 probe", () => {
  it("signs exactly as AWS's published GET Object example does", () => {
    const signed = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
      extraHeaders: { range: "bytes=0-9" },
    });
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  const target = {
    kind: "s3" as const,
    provider: "aws" as const,
    region: "eu-west-1",
    bucket: "kaname-backups",
    prefix: "kaname",
    access_key_id: "AKIA1234",
    secret_access_key: "secret",
  };

  it("addresses buckets virtual-hosted by default and path-style when asked", () => {
    expect(objectUrl(target, "k")).toBe("https://kaname-backups.s3.eu-west-1.amazonaws.com/k");
    expect(objectUrl({ ...target, path_style: true }, "k")).toBe("https://s3.eu-west-1.amazonaws.com/kaname-backups/k");
    expect(objectUrl({ ...target, provider: "minio", endpoint: "http://minio:9000" }, "k")).toBe(
      "http://minio:9000/kaname-backups/k",
    );
  });

  it("writes, reads back and deletes one object", async () => {
    const store = new Map<string, string>();
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      if (init.method === "PUT") store.set(url, String(init.body));
      if (init.method === "GET") return new Response(store.get(url) ?? "", { status: 200 });
      if (init.method === "DELETE") store.delete(url);
      return new Response(null, { status: init.method === "DELETE" ? 204 : 200 });
    }) as unknown as typeof fetch;

    const result = await probeS3(target, { fetch: fakeFetch, nonce: "abc" });
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => `${c.step}:${c.ok}`)).toEqual(["write:true", "read:true", "delete:true"]);
    expect(seen[0]).toBe("PUT https://kaname-backups.s3.eu-west-1.amazonaws.com/kaname/.kaname-probe-abc");
    expect(store.size).toBe(0);
  });

  const s3Error = (code: string, message: string, status: number) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status });

  it.each([
    ["InvalidAccessKeyId", 403, "auth"],
    ["SignatureDoesNotMatch", 403, "auth"],
    ["NoSuchBucket", 404, "bucket_missing"],
    ["AuthorizationHeaderMalformed", 400, "region_mismatch"],
    ["PermanentRedirect", 301, "region_mismatch"],
    ["RequestTimeTooSkewed", 403, "clock_skew"],
    ["AccessDenied", 403, "permission"],
  ])("names %s as %s", async (code, status, failure) => {
    const fakeFetch = (async () => s3Error(code, "the service said no", status)) as unknown as typeof fetch;
    const result = await probeS3(target, { fetch: fakeFetch });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe(failure);
    expect(result.checks).toEqual([expect.objectContaining({ step: "write", ok: false })]);
    expect(result.hint).toBeTruthy();
  });

  it("reports the right region and the clock offset when the service says so", () => {
    const region = classifyS3Failure(
      400,
      "<Error><Code>AuthorizationHeaderMalformed</Code><Message>the region 'eu-west-1' is wrong; expecting 'eu-central-1'</Message></Error>",
      { target, serverDate: null, now: new Date() },
    );
    expect(region.hint).toContain("eu-central-1");
    const skew = classifyS3Failure(403, "<Error><Code>RequestTimeTooSkewed</Code></Error>", {
      target,
      serverDate: "Wed, 11 Nov 2026 10:00:00 GMT",
      now: new Date("2026-11-11T10:20:00Z"),
    });
    expect(skew.hint).toContain("1200 s ahead");
  });

  it("says network when nothing answers, and cleans up after a failed read", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
    }) as unknown as typeof fetch;
    const unreachable = await probeS3(target, { fetch: down });
    expect(unreachable.failure).toBe("network");
    expect(unreachable.error).toContain("ENOTFOUND");

    const methods: string[] = [];
    const denyRead = (async (_url: string, init: RequestInit) => {
      methods.push(init.method!);
      if (init.method === "GET") return s3Error("AccessDenied", "no read", 403);
      return new Response(null, { status: init.method === "DELETE" ? 204 : 200 });
    }) as unknown as typeof fetch;
    const writeOnly = await probeS3(target, { fetch: denyRead });
    expect(writeOnly).toMatchObject({ ok: false, writable: true, failure: "permission" });
    expect(methods).toEqual(["PUT", "GET", "DELETE"]);
  });
});

/* --------------------------- versions ----------------------------- */

describe("app versions", () => {
  it("refuses only a strictly newer or unknown line", () => {
    expect(isNewerVersion("5", "5")).toBe(false);
    expect(isNewerVersion("1.21", "1.22")).toBe(false);
    expect(isNewerVersion("1.23", "1.22")).toBe(true);
    expect(isNewerVersion("3.2.1", "3.2")).toBe(true);
    expect(isNewerVersion("v3.2.0", "3.2")).toBe(false);
    expect(isNewerVersion("stable", "stable")).toBe(false);
    expect(isNewerVersion("nightly", "stable")).toBe(true);
  });
});

/* ------------------------- integration --------------------------- */

const OWNER_EMAIL = "owner@appbackups.test";
const OWNER_PASSWORD = "owner-password-for-tests-1";
const STRONG = "Tidal-Basalt-Orchard-47";

let config: Config;
let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let owner = "";
let client = "";
let clientId = "";
let serverId = "";
let destinationId = "";
let ip = 10;
let port = 23000;

const nextIp = () => `198.51.100.${(ip = (ip % 250) + 1)}`;
const call = (cookie: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });
const data = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body).data as T;
const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.value);
  return c ? `${c.name}=${c.value}` : "";
};

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: nextIp(), payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

async function activate(email: string, inviteUrl: string): Promise<string> {
  const token = decodeURIComponent(inviteUrl.split("/invite/")[1]!);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/invite/accept",
    remoteAddress: nextIp(),
    payload: { token, password: STRONG },
  });
  expect(res.statusCode).toBe(200);
  return login(email, STRONG);
}

async function newInstall(appId: string, createdBy: string | null) {
  const recipe = findApp(appId)!;
  port += 1;
  const [row] = await handle.db
    .insert(appInstalls)
    .values({
      appId,
      appName: recipe.name,
      appVersion: recipe.version,
      serverId,
      domain: `${appId}-${port}.appbackups.test`,
      status: "active",
      ssl: true,
      dbEngine: recipe.requirements.database ? "mariadb" : null,
      inputs: { admin_email: "ops@appbackups.test", system_user: "www-data", php_version: null },
      resources: recipe.source.kind === "git" ? { database: `wp_${port}`, deploy_root: `/var/www/wp-${port}.test` } : {},
      appPort: recipe.source.kind === "image" ? port : null,
      steps: appInstallSteps(recipe, { ssl: true }).map((s) => ({
        id: s.id,
        status: "done" as const,
        message: null,
        started_at: null,
        finished_at: null,
      })),
      createdBy,
    })
    .returning();
  return row!;
}

/** A restore point as a finished app backup leaves it. */
async function newPoint(install: typeof appInstalls.$inferSelect, scheduleId: string, version = install.appVersion) {
  const recipe = findApp(install.appId)!;
  const entry = planEntry(install, recipe);
  const dumps = entry.companions.map((c) => ({
    role: c.role,
    engine: c.engine,
    path: `${MANAGED_APPS_ROOT}/${install.id}/kaname-backup/${c.role}.dump`,
  }));
  const manifest: AppBackupManifest = { ...buildManifest(install, recipe, entry, dumps, new Date(), false), app_version: version };
  const { backupRuns } = await import("@kaname/db/schema");
  const [run] = await handle.db
    .insert(backupRuns)
    .values({ scheduleId, serverId, status: "succeeded", trigger: "manual" })
    .returning();
  const [point] = await handle.db
    .insert(restorePoints)
    .values({
      runId: run!.id,
      scheduleId,
      serverId,
      label: `p${port}${Math.floor(Math.random() * 1e6)}`.slice(0, 8),
      snapshotId: `${port}abcdef${Math.floor(Math.random() * 1e9)}`,
      takenAt: new Date(),
      scope: [{ kind: "app", selectors: [install.id] }],
      manifest: { apps: { [install.id]: manifest } },
    })
    .returning();
  return point!;
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
  await seedDemo(handle.db);
  app = await buildServer(ctx);
  await app.ready();
  owner = await login(OWNER_EMAIL, OWNER_PASSWORD);

  const [forge] = await handle.db.select().from(servers).where(eq(servers.name, "forge-01"));
  serverId = forge!.id;

  const dest = await call(owner, "POST", "/backups/destinations", {
    name: "app-backups-local",
    target: { kind: "local", server_id: serverId, path: "/var/backups/kaname" },
  });
  expect(dest.statusCode).toBe(201);
  destinationId = data(dest).id;

  const reseller = await call(owner, "POST", "/resellers", {
    email: "reseller@appbackups.test",
    name: "Northwind",
    server_ids: [serverId],
    send_invite: false,
  });
  expect(reseller.statusCode).toBe(201);
  const resellerCookie = await activate("reseller@appbackups.test", data(reseller).invite.url);
  const c = await call(resellerCookie, "POST", "/reseller/clients", {
    email: "client@appbackups.test",
    name: "Client",
    send_invite: false,
  });
  expect(c.statusCode).toBe(201);
  clientId = data(c).id;
  client = await activate("client@appbackups.test", data(c).invite.url);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

describe("planning an app scope", () => {
  it("takes an image app's directory minus its SQL data, dumping each companion instead", async () => {
    const install = await newInstall("ghost", null);
    const { paths, exclude } = pathsFor(install, ghost);
    expect(paths).toEqual([`${MANAGED_APPS_ROOT}/${install.id}`]);
    expect(exclude).toEqual([`${MANAGED_APPS_ROOT}/${install.id}/db/data`]);
    expect(planEntry(install, ghost)).toMatchObject({ kind: "image", companions: [{ role: "db", engine: "mysql" }] });

    const plausible = await newInstall("plausible", null);
    const entry = planEntry(plausible, findApp("plausible")!);
    // ClickHouse has no fixed dump argv: its directory is taken as files, with the app stopped.
    expect(entry.companions).toEqual([{ role: "db", engine: "postgres" }]);
    expect(entry.stop).toBe(true);
  });

  it("reuses the site root and a database dump for a git recipe", async () => {
    const install = await newInstall("wordpress", null);
    expect(pathsFor(install, wordpress).paths).toEqual([install.resources.deploy_root]);
    expect(planEntry(install, wordpress).database).toEqual({ engine: "mariadb", name: install.resources.database });
  });

  it("keeps secrets out of the manifest: refs only", async () => {
    const install = await newInstall("n8n", null);
    const recipe = findApp("n8n")!;
    const manifest = buildManifest(install, recipe, planEntry(install, recipe), [], new Date(), false);
    expect(manifest.secret_refs).toEqual(
      expect.arrayContaining([`app_install:${install.id}:db_password`, `app_install:${install.id}:encryption_key`]),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/password"\s*:\s*"[^a]/);
  });
});

describe("/backups/apps routes", () => {
  it("backs up an app: the first time it asks where, then creates the app's own schedule", async () => {
    const install = await newInstall("ghost", null);
    const first = await call(owner, "POST", `/backups/apps/${install.id}/run`, {});
    expect(first.statusCode).toBe(422);

    const ran = await call(owner, "POST", `/backups/apps/${install.id}/run`, { destination_id: destinationId });
    expect(ran.statusCode).toBe(202);
    const job = data(ran);
    const [row] = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.type).toBe("backup.run");
    const params = row!.params as { paths: string[]; exclude: string[]; apps: { install_id: string }[] };
    expect(params.paths).toEqual([`${MANAGED_APPS_ROOT}/${install.id}`]);
    expect(params.exclude).toEqual([`${MANAGED_APPS_ROOT}/${install.id}/db/data`]);
    expect(params.apps[0]!.install_id).toBe(install.id);

    const overview = data(await call(owner, "GET", `/backups/apps/${install.id}`));
    expect(overview.schedule).toMatchObject({ destination_id: destinationId, enabled: true });
    expect(overview.last_run).toMatchObject({ status: "queued" });
    // A second "Back up now" reuses the schedule, needing no destination.
    expect((await call(owner, "POST", `/backups/apps/${install.id}/run`, {})).statusCode).toBe(202);
  });

  it("restores in place only with the domain retyped, and never onto an older recipe", async () => {
    const install = await newInstall("ghost", null);
    await call(owner, "POST", `/backups/apps/${install.id}/run`, { destination_id: destinationId });
    const [schedule] = await handle.db.select().from(backupSchedules).where(eq(backupSchedules.name, `app ${install.domain}`));
    const point = await newPoint(install, schedule!.id);

    const typo = await call(owner, "POST", `/backups/apps/${install.id}/restore`, {
      restore_point_id: point.id,
      confirm_domain: "not-the-domain.test",
    });
    expect(typo.statusCode).toBe(422);
    expect(JSON.parse(typo.body).error.fields.confirm_domain).toContain(install.domain);

    const ok = await call(owner, "POST", `/backups/apps/${install.id}/restore`, {
      restore_point_id: point.id,
      confirm_domain: install.domain.toUpperCase(),
    });
    expect(ok.statusCode).toBe(202);
    expect(data(ok).job.type).toBe("app.restore");

    const again = await call(owner, "POST", `/backups/apps/${install.id}/restore`, {
      restore_point_id: point.id,
      confirm_domain: install.domain,
    });
    expect(again.statusCode).toBe(409);

    const newer = await newPoint(install, schedule!.id, "99");
    const refused = await call(owner, "POST", `/backups/apps/${(await newInstall("ghost", null)).id}/restore`, {
      restore_point_id: newer.id,
      confirm_domain: "x",
    });
    expect(refused.statusCode).toBe(422); // the confirmation is checked first
    await handle.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.targetId, install.id));
    const tooNew = await call(owner, "POST", `/backups/apps/${install.id}/restore`, {
      restore_point_id: newer.id,
      confirm_domain: install.domain,
    });
    expect(tooNew.statusCode).toBe(409);
    expect(tooNew.body).toContain("newer than");

    const overview = data(await call(owner, "GET", `/backups/apps/${install.id}`));
    const listed = overview.restore_points.find((p: { id: string }) => p.id === newer.id);
    expect(listed).toMatchObject({ app_version: "99", newer_than_recipe: true });
  });

  it("lets a client back up and restore only the apps it owns", async () => {
    const mine = await newInstall("uptime-kuma", clientId);
    const operators = await newInstall("uptime-kuma", null);

    expect((await call(client, "GET", `/backups/apps/${mine.id}`)).statusCode).toBe(200);
    expect((await call(client, "GET", `/backups/apps/${operators.id}`)).statusCode).toBe(404);
    expect(
      (await call(client, "POST", `/backups/apps/${operators.id}/run`, { destination_id: destinationId })).statusCode,
    ).toBe(404);
    expect(
      (await call(client, "POST", `/backups/apps/${operators.id}/restore`, {
        restore_point_id: crypto.randomUUID(),
        confirm_domain: operators.domain,
      })).statusCode,
    ).toBe(404);
    expect(
      (await call(client, "POST", `/backups/apps/${mine.id}/run`, { destination_id: destinationId })).statusCode,
    ).toBe(202);
    // The grants open the app routes only; the operator's backup pages stay closed.
    expect((await call(client, "GET", "/backups/schedules")).statusCode).toBe(403);
    expect((await call(client, "GET", "/backups/destinations")).statusCode).toBe(403);
  });

  it("refuses restore-as-new for a recipe that keeps its address in its own data", async () => {
    const install = await newInstall("wordpress", null);
    const [schedule] = await handle.db.select().from(backupSchedules).limit(1);
    const point = await newPoint(install, schedule!.id);
    const res = await call(owner, "POST", `/backups/apps/${install.id}/restore-as-new`, {
      restore_point_id: point.id,
      target_server_id: serverId,
      domain: "copy.appbackups.test",
      confirm_domain: install.domain,
    });
    expect(res.statusCode).toBe(412);
  });
});

/* ------------------------------ jobs ------------------------------ */

class FakeHub {
  connected = new Set<string>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  defaults: Record<string, (params: Record<string, unknown>) => unknown> = {
    "fs.mkdir": () => ({}),
    "fs.move": () => ({}),
    "fs.remove": () => ({ removed: 1 }),
    "fs.write": () => ({}),
    "fs.stat": () => ({ kind: "file" }),
    "container.stop": () => ({}),
    "container.start": () => ({}),
    "backup.restore": () => ({ restored_files: 12, bytes: 4096 }),
    "app.db_dump": (p) => ({ path: `/x/${String(p.role)}.dump`, size_bytes: 10, engine: p.engine, database: "ghost" }),
    "app.db_restore": () => ({ ok: true, database: "ghost" }),
    "container.app.status": () => ({
      containers: [{ role: "app", name: "app", state: "running", status: "Up" }],
      endpoints: [{ role: "app", host_port: 20000, container_port: 2368, reachable: true, http_status: 200 }],
    }),
  };
  private answer(serverId: string, method: string, params: Record<string, unknown>): unknown {
    if (!this.connected.has(serverId)) throw new AgentOfflineError(serverId);
    this.calls.push({ method, params });
    const fn = this.answers.get(method) ?? this.defaults[method];
    if (!fn) throw new AgentRpcError({ code: "unsupported", message: `no ${method}` });
    return fn(params);
  }
  isConnected(id: string) {
    return this.connected.has(id);
  }
  async call(serverId: string, method: string, params: Record<string, unknown>) {
    return this.answer(serverId, method, params);
  }
  stream(serverId: string, method: string, params: Record<string, unknown>) {
    const done = (async () => this.answer(serverId, method, params))();
    done.catch(() => undefined);
    return { id: "s", done, cancel: () => undefined };
  }
  methods() {
    return this.calls.map((c) => `${c.method}${c.method.startsWith("container.") && c.params.id ? ` ${String(c.params.id).split("-").pop()}` : ""}`);
  }
  as() {
    return this as unknown as AgentHub;
  }
}

function jobContext(hub: FakeHub, claimed: Awaited<ReturnType<AppContext["queue"]["claim"]>>, logs: string[]): JobContext {
  return {
    ...ctx,
    hub: hub.as(),
    job: claimed!,
    signal: new AbortController().signal,
    log_: async (level, message) => {
      logs.push(`${level}: ${message}`);
    },
    progress: async () => undefined,
  };
}

async function runRestore(hub: FakeHub, install: typeof appInstalls.$inferSelect, pointId: string) {
  const queued = await ctx.queue.enqueue({
    type: "app.restore",
    serverId,
    params: {
      install_id: install.id,
      source_install_id: install.id,
      restore_point_id: pointId,
      repository: "/var/backups/kaname/x",
      password_ref: "ref",
      snapshot_id: "abc",
      mode: "in_place",
    },
  });
  const claimed = await ctx.queue.claim("test", 60, [serverId]);
  expect(claimed?.id).toBe(queued.id);
  const logs: string[] = [];
  let error: unknown = null;
  try {
    await appBackupJobHandlers()["app.restore"]!(jobContext(hub, claimed, logs));
  } catch (err) {
    error = err;
  }
  await ctx.queue.complete(claimed!.id, null);
  return { error, logs };
}

describe("app.restore", () => {
  RESTORE_TIMING.checkIntervalMs = 1;

  it("stages, saves today's database, stops, swaps, imports, starts and checks — in that order", async () => {
    const install = await newInstall("ghost", null);
    const [schedule] = await handle.db.select().from(backupSchedules).limit(1);
    const point = await newPoint(install, schedule!.id);
    const hub = new FakeHub();
    hub.connected.add(serverId);

    const { error, logs } = await runRestore(hub, install, point.id);
    expect(error).toBeNull();
    const order = hub.methods().filter((m) => !m.startsWith("fs.mkdir"));
    expect(order).toEqual([
      "backup.restore",
      "app.db_dump",
      "container.stop app",
      "fs.move",
      "fs.move",
      "fs.move",
      "app.db_restore",
      "container.start app",
      "container.app.status",
      "fs.remove",
    ]);
    const safety = hub.calls.find((c) => c.method === "app.db_dump")!;
    expect(safety.params).toMatchObject({ slot: "pre_restore", role: "db", engine: "mysql" });
    const staged = hub.calls.find((c) => c.method === "backup.restore")!.params;
    expect(String(staged.target)).toMatch(new RegExp(`^${MANAGED_APPS_ROOT}/\\.restore/${install.id}-`));
    expect(staged.include).toEqual([`${MANAGED_APPS_ROOT}/${install.id}`]);
    expect(logs.some((l) => l.includes("[8/8] check"))).toBe(true);
  });

  it("puts the original back when the import fails, and starts the app again", async () => {
    const install = await newInstall("ghost", null);
    const [schedule] = await handle.db.select().from(backupSchedules).limit(1);
    const point = await newPoint(install, schedule!.id);
    const hub = new FakeHub();
    hub.connected.add(serverId);
    let restores = 0;
    hub.answers.set("app.db_restore", (p) => {
      restores += 1;
      if (p.slot === "backup") throw new AgentRpcError({ code: "exec_failed", message: "pg_restore: error" });
      return { ok: true, database: "ghost" };
    });

    const { error, logs } = await runRestore(hub, install, point.id);
    expect(String(error)).toContain("pg_restore");
    const moves = hub.calls.filter((c) => c.method === "fs.move").map((c) => [c.params.from, c.params.to]);
    const live = `${MANAGED_APPS_ROOT}/${install.id}/data`;
    // live -> previous, staged -> live, then back: live -> failed, previous -> live.
    expect(moves[0]![0]).toBe(live);
    expect(moves.at(-1)![1]).toBe(live);
    expect(String(moves.at(-1)![0])).toContain("/previous/data");
    expect(restores).toBe(2);
    expect(hub.calls.filter((c) => c.method === "app.db_restore").at(-1)!.params.slot).toBe("pre_restore");
    expect(hub.methods()).toContain("container.start app");
    expect(logs.some((l) => l.includes("putting the original back"))).toBe(true);
  });

  it("prepares a backup by stopping, dumping and writing a manifest — and records what to undo", async () => {
    const install = await newInstall("uptime-kuma", null);
    const hub = new FakeHub();
    hub.connected.add(serverId);
    const queued = await ctx.queue.enqueue({ type: "backup.run", serverId, params: {} });
    const claimed = await ctx.queue.claim("test", 60, [serverId]);
    expect(claimed?.id).toBe(queued.id);
    const prepared = emptyPrepared();
    hub.answers.set("fs.write", () => {
      throw new AgentRpcError({ code: "io_error", message: "disk full" });
    });
    await expect(
      prepareAppBackups(jobContext(hub, claimed, []), serverId, [planEntry(install, findApp("uptime-kuma")!)], prepared),
    ).rejects.toThrow("disk full");
    // Halfway is still remembered: the stopped container is started again by finish.
    expect(prepared.stopped).toEqual([`kaname-${install.id}-app`]);
    await ctx.queue.complete(claimed!.id, null);
  });
});
