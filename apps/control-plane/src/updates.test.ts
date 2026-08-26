import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, sql, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { auditEvents, servers, settings, updateRuns } from "@kaname/db/schema";
import {
  mayApplyUnattended,
  type Release,
  type UpdateOverview,
  type UpdateRun,
} from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import type { UpdateDispatcher, UpdateRequest } from "./services/updates.js";

/* ------------------------------------------------------------------ *
 * Updates.
 *
 * The rule this file exists to defend is 3.6: a release that can break
 * an install is never applied without a person saying so, whatever the
 * cadence is set to. Everything else here is about the half of the
 * sequence that happens after this process has been replaced — the
 * outcomes it can no longer observe for itself.
 * ------------------------------------------------------------------ */

const OWNER_PASSWORD = "kaname-updates-test-owner";
const SHA = "a".repeat(64);

function release(version: string, overrides: Partial<Release> = {}): Release {
  return {
    version,
    channel: "stable",
    released_at: "2026-01-01T00:00:00.000Z",
    breaking: false,
    security: false,
    summary: `Release ${version}`,
    min_upgrade_from: undefined,
    migrations: { destructive: false, adds_config: [] },
    artifacts: {
      control_plane: `ghcr.io/futureforge-studios/kaname-control-plane:${version}`,
      web: `ghcr.io/futureforge-studios/kaname-web:${version}`,
      agent: {
        "linux-amd64": { url: `https://example.com/kanamed-${version}-linux-amd64`, sha256: SHA },
      },
    },
    ...overrides,
  } as Release;
}

const MANIFEST = {
  schema: 1,
  releases: [
    release("0.3.0", { breaking: true, summary: "Renames the agent protocol." }),
    release("0.2.0", { migrations: { destructive: false, adds_config: ["KANAME_NEW_SECRET"] } }),
    release("0.1.5", { security: true }),
  ],
};

/** Stands in for the host-side updater install.sh puts on the box. */
class FakeDispatcher implements UpdateDispatcher {
  readonly requests: UpdateRequest[] = [];
  installed = true;

  available(): boolean {
    return this.installed;
  }

  dispatch(request: UpdateRequest): Promise<void> {
    this.requests.push(request);
    return Promise.resolve();
  }
}

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let dispatcher: FakeDispatcher;
let dataDir: string;
let cookie: string;

function as(url: string, payload?: Record<string, unknown>, method = "POST") {
  return app.inject({ method: method as "POST", url, headers: { cookie }, payload: payload ?? {} });
}

function body<T>(res: LightMyRequestResponse): T {
  return (JSON.parse(res.body) as { data: T }).data;
}

beforeAll(async () => {
  resetConfigForTests();
  dataDir = mkdtempSync(join(tmpdir(), "kaname-update-"));
  writeFileSync(join(dataDir, ".env"), "KANAME_MASTER_KEY=existing\nPOSTGRES_PASSWORD=keep-me\n");

  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: OWNER_PASSWORD,
    KANAME_VERSION: "0.1.0",
    KANAME_DATA_DIR: dataDir,
    KANAME_DEPLOYMENT: "compose",
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);

  dispatcher = new FakeDispatcher();
  ctx = createContext(
    { config, log: pino({ level: "fatal" }), dbHandle: handle },
    {
      dispatcher,
      fetch: (async () =>
        new Response(JSON.stringify(MANIFEST), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch,
    },
  );
  await ctx.ca.load();
  await bootstrap(ctx);

  app = await buildServer(ctx);
  await app.ready();

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@kaname.test", password: OWNER_PASSWORD },
  });
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

describe("update policy", () => {
  it("never applies a breaking release unattended, at any tier", () => {
    const breaking = release("0.3.0", { breaking: true });
    const destructive = release("0.2.1", {
      migrations: { destructive: true, adds_config: [] },
    });

    for (const tier of ["off", "notify", "auto_minor", "auto_all"] as const) {
      expect(mayApplyUnattended(tier, "0.1.0", breaking), tier).toBe(false);
      expect(mayApplyUnattended(tier, "0.1.0", destructive), tier).toBe(false);
    }
  });

  it("applies a minor but not a major at auto_minor", () => {
    expect(mayApplyUnattended("auto_minor", "0.1.0", release("0.1.5"))).toBe(true);
    expect(mayApplyUnattended("auto_minor", "0.1.0", release("0.2.0"))).toBe(true);
    expect(mayApplyUnattended("auto_minor", "0.1.0", release("1.0.0"))).toBe(false);
    expect(mayApplyUnattended("auto_all", "0.1.0", release("1.0.0"))).toBe(true);
  });

  it("refuses auto_all without an explicit acknowledgement", async () => {
    const refused = await as("/api/v1/updates/policy", { tier: "auto_all" }, "PATCH");
    expect(refused.statusCode, refused.body).toBe(412);
    expect(JSON.parse(refused.body).error.fields.tier).toBeTruthy();

    const accepted = await as(
      "/api/v1/updates/policy",
      { tier: "auto_all", acknowledge_unattended_majors: true },
      "PATCH",
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(body<UpdateOverview>(accepted).settings.tier).toBe("auto_all");
  });
});

describe("checking", () => {
  it("reports the newest applicable release and that it has to be confirmed", async () => {
    const res = await as("/api/v1/updates/check");
    expect(res.statusCode, res.body).toBe(200);

    const overview = body<UpdateOverview>(res);
    expect(overview.control_plane.current_version).toBe("0.1.0");
    expect(overview.control_plane.latest_version).toBe("0.3.0");
    expect(overview.control_plane.requires_confirmation).toBe(true);
    expect(overview.settings.last_check_error).toBeNull();
  });
});

describe("applying to the control plane", () => {
  it("refuses a breaking release that was not confirmed, even at auto_all", async () => {
    const res = await as("/api/v1/updates/control-plane", {
      to_version: "0.3.0",
      confirm_breaking: false,
      skip_backup_check: true,
    });

    expect(res.statusCode, res.body).toBe(412);
    expect(JSON.parse(res.body).error.message).toContain("breaking");
  });

  it("blocks on a missing backup and audits the decision to skip it", async () => {
    const blocked = await as("/api/v1/updates/control-plane", { to_version: "0.2.0" });
    expect(blocked.statusCode, blocked.body).toBe(412);
    expect(JSON.parse(blocked.body).error.message).toContain("backup");

    const accepted = await as("/api/v1/updates/control-plane", {
      to_version: "0.2.0",
      skip_backup_check: true,
    });
    expect(accepted.statusCode, accepted.body).toBe(202);

    const audited = await ctx.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, "update.backup_check_skipped"));
    expect(audited.length).toBe(1);
  });

  it("merges only the declared keys, pins the images, and hands over to the host", async () => {
    await waitFor(() => dispatcher.requests.length > 0);

    const env = readFileSync(join(dataDir, ".env"), "utf8");
    // Values the operator set are never rewritten...
    expect(env).toContain("POSTGRES_PASSWORD=keep-me");
    // ...a key the release declares is added, with a real secret rather
    // than a placeholder...
    const added = /^KANAME_NEW_SECRET=(.+)$/m.exec(env);
    expect(added?.[1]?.length ?? 0).toBeGreaterThan(20);
    // ...and the three keys Kaname owns move to the new release.
    expect(env).toContain("KANAME_VERSION=0.2.0");
    expect(env).toMatch(/^KANAME_IMAGE_CONTROL_PLANE=.*:0\.2\.0$/m);

    const request = dispatcher.requests[0]!;
    expect(request.to_version).toBe("0.2.0");
    expect(request.snapshot_dir).toContain("rollback");
    expect(readFileSync(join(request.snapshot_dir, ".env"), "utf8")).toContain(
      "POSTGRES_PASSWORD=keep-me",
    );
  });

  it("refuses when the host-side updater is not installed", async () => {
    dispatcher.installed = false;
    try {
      const res = await as("/api/v1/updates/control-plane", {
        to_version: "0.1.5",
        skip_backup_check: true,
      });
      expect(res.statusCode, res.body).toBe(412);
      expect(JSON.parse(res.body).error.message).toContain("host-side updater");
    } finally {
      dispatcher.installed = true;
    }
  });
});

describe("finishing an update the previous process could not", () => {
  it("marks it succeeded when the new version is what came back", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 0 });
    // The service reads its own version from config; standing in for
    // "0.2.0 booted" means telling it that is what it is running.
    await withVersion("0.2.0", () => ctx.updates.reconcile());

    const after = await readRun(run);
    expect(after.status).toBe("succeeded");
    expect(after.log).toContain("is up and answering");
  });

  it("records a rollback when the old version came back untouched", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 0 });
    await ctx.updates.reconcile();

    const after = await readRun(run);
    expect(after.status).toBe("rolled_back");
    expect(after.error).toContain("health check");
  });

  it("needs attention when a migration ran and the old version came back", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 1 });
    await ctx.updates.reconcile();

    const after = await readRun(run);
    expect(after.status).toBe("needs_attention");
    expect(after.log).toContain("migrated database");
  });

  it("flags a run that was interrupted with no record of where it got to", async () => {
    const run = await ctx.updates.createRun({
      kind: "control_plane",
      serverId: null,
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      trigger: "manual",
      breaking: false,
      actor: null,
    });
    await ctx.updates.reconcile();

    expect((await readRun(run.id)).status).toBe("needs_attention");
  });
});

describe("the agent fleet", () => {
  it("fans out one job and one tracked run per host", async () => {
    const [host] = await ctx.db
      .insert(servers)
      .values({ name: "fleet-01", hostname: "fleet-01.example.com", arch: "amd64" })
      .returning({ id: servers.id });

    const res = await as("/api/v1/updates/agents", {
      to_version: "0.2.0",
      server_ids: [host!.id],
    });
    expect(res.statusCode, res.body).toBe(202);

    const { jobs } = body<{ jobs: { id: string; type: string }[] }>(res);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe("agent.update");

    const runs = await ctx.db.select().from(updateRuns).where(eq(updateRuns.serverId, host!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.jobId).toBe(jobs[0]!.id);
    expect(runs[0]!.status).toBe("queued");
  });

  it("refuses to pretend it updated a simulated host", async () => {
    const [sim] = await ctx.db
      .insert(servers)
      .values({ name: "sim-01", hostname: "sim-01.local", arch: "amd64", simulated: true })
      .returning({ id: servers.id });

    const res = await as("/api/v1/updates/agents", {
      to_version: "0.2.0",
      server_ids: [sim!.id],
    });
    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).error.message).toContain("simulated");
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the update sequence");
}

async function countMigrations(): Promise<number> {
  const result = await ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  const rows = (result as unknown as { rows?: { n: number }[] }).rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

/** Writes exactly what `executeControlPlane` leaves behind before it dies. */
async function seedPendingRun(
  toVersion: string,
  opts: { migrationsBehind: number },
): Promise<string> {
  const run = await ctx.updates.createRun({
    kind: "control_plane",
    serverId: null,
    fromVersion: "0.1.0",
    toVersion,
    trigger: "manual",
    breaking: false,
    actor: null,
  });

  const pending = {
    run_id: run.id,
    from_version: "0.1.0",
    to_version: toVersion,
    snapshot_dir: join(dataDir, "rollback", run.id),
    log_file: join(dataDir, "updates", `${run.id}.log`),
    migrations_before: (await countMigrations()) - opts.migrationsBehind,
    breaking: false,
    started_at: new Date().toISOString(),
  };

  await ctx.db
    .insert(settings)
    .values({ key: "updates.pending", value: pending })
    .onConflictDoUpdate({ target: settings.key, set: { value: pending } });

  return run.id;
}

async function readRun(id: string): Promise<UpdateRun> {
  const res = await as(`/api/v1/updates/runs/${id}`, undefined, "GET");
  return body<UpdateRun>(res);
}

/** Runs a callback as if this process were a different build. */
async function withVersion(version: string, fn: () => Promise<void>): Promise<void> {
  const real = ctx.config.KANAME_VERSION;
  (ctx.config as { KANAME_VERSION: string }).KANAME_VERSION = version;
  try {
    await fn();
  } finally {
    (ctx.config as { KANAME_VERSION: string }).KANAME_VERSION = real;
  }
}
