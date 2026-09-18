import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createDb, eq, sql, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { auditEvents, jobs, servers, settings, updateRuns } from "@kaname/db/schema";
import {
  mayApplyUnattended,
  type AddressSettings,
  type Release,
  type UpdateOverview,
  type UpdateRun,
} from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import {
  UpdateService,
  checkDue,
  type UpdateDispatcher,
  type UpdateRequest,
} from "./services/updates.js";

/* ------------------------------------------------------------------ *
 * Updates.
 *
 * The rule this file exists to defend is 3.6: a release that can break
 * an install is never applied without a person saying so, whatever the
 * cadence is set to. Everything else here is about the half of the
 * sequence that happens after this process has been replaced — the
 * outcomes it can no longer observe for itself — and the half where it
 * is still alive but the host is the one doing the work.
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

/** What the fake manifest server answers; tests swap it to stage a scenario. */
let manifestBody: unknown = MANIFEST;
let manifestUnreachable = false;

/** Stands in for the host-side updater install.sh puts on the box. */
class FakeDispatcher implements UpdateDispatcher {
  readonly requests: UpdateRequest[] = [];
  installed = true;
  /** Thrown by the next dispatch, once — the queue directory going read-only. */
  failNext: Error | null = null;
  withdrawn = 0;

  available(): boolean {
    return this.installed;
  }

  dispatch(request: UpdateRequest): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      return Promise.reject(err);
    }
    this.requests.push(request);
    return Promise.resolve();
  }

  withdraw(): void {
    this.withdrawn += 1;
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

const fakeFetch = (async () => {
  if (manifestUnreachable) throw new Error("connect ECONNREFUSED");
  return new Response(JSON.stringify(manifestBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof globalThis.fetch;

beforeAll(async () => {
  resetConfigForTests();
  dataDir = mkdtempSync(join(tmpdir(), "kaname-update-"));
  writeFileSync(
    join(dataDir, ".env"),
    "KANAME_VERSION=0.1.0\nKANAME_MASTER_KEY=existing\nPOSTGRES_PASSWORD=keep-me\n",
  );

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
    { dispatcher, fetch: fakeFetch },
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
  ctx?.updates.stop();
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

  it("still knows about the release after a restart, without fetching", async () => {
    // A fresh service on the same database is what the process that
    // comes back after a restart — or a rollback — is.
    const unreachable = (async () => {
      throw new Error("no network");
    }) as typeof globalThis.fetch;
    const restarted = new UpdateService(ctx, { dispatcher, fetch: unreachable });

    const overview = await restarted.overview();
    expect(overview.control_plane.update_available).toBe(true);
    expect(overview.control_plane.latest_version).toBe("0.3.0");
    expect(await restarted.releaseFor("0.2.0")).toMatchObject({ version: "0.2.0" });
  });

  it("retries a failed check soon instead of after a whole interval", async () => {
    const before = await ctx.updates.loadPolicy();
    manifestUnreachable = true;
    try {
      const { policy } = await ctx.updates.checkNow();
      expect(policy.last_check_error).toContain("ECONNREFUSED");
      // The failure was not a check; the last real one still stands.
      expect(policy.last_checked_at).toBe(before.last_checked_at);
      expect(policy.retry_after).not.toBeNull();
      const retryIn = Date.parse(policy.retry_after!) - Date.now();
      expect(retryIn).toBeGreaterThan(0);
      expect(retryIn).toBeLessThanOrEqual(15 * 60_000);

      expect(checkDue(policy, Date.now())).toBe(false);
      expect(checkDue(policy, Date.now() + 16 * 60_000)).toBe(true);

      const overview = await ctx.updates.overview();
      expect(overview.settings.next_check_at).toBe(policy.retry_after);
      // The release found earlier is not forgotten because a fetch failed.
      expect(overview.control_plane.update_available).toBe(true);
    } finally {
      manifestUnreachable = false;
    }

    const { policy: recovered } = await ctx.updates.checkNow();
    expect(recovered.retry_after).toBeNull();
    expect(recovered.check_failures).toBe(0);
    expect(recovered.last_check_error).toBeNull();
  });

  it("writes down why an unattended apply was refused, and forgets it when the release moves on", async () => {
    await ctx.updates.savePolicy({ tier: "auto_minor" });
    manifestBody = { schema: 1, releases: [release("0.2.0"), release("0.1.5")] };
    try {
      const { policy } = await ctx.updates.checkNow({ auto: true });
      expect(policy.last_apply_error).toBeNull();

      const after = await ctx.updates.loadPolicy();
      expect(after.last_apply_error?.version).toBe("0.2.0");
      expect(after.last_apply_error?.message).toContain("backup");

      const overview = await ctx.updates.overview();
      expect(overview.settings.last_apply_error?.message).toContain("backup");

      const audited = await ctx.db
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.action, "update.unattended_refused"));
      expect(audited.length).toBe(1);
      // Nothing was started.
      expect(await ctx.db.select().from(updateRuns)).toHaveLength(0);
    } finally {
      manifestBody = MANIFEST;
      await ctx.updates.savePolicy({ tier: "notify" });
    }

    await ctx.updates.checkNow();
    expect((await ctx.updates.loadPolicy()).last_apply_error).toBeNull();
  });
});

describe("applying to the control plane", () => {
  let appliedRunId: string;

  it("refuses a breaking release that was not confirmed, even at auto_all", async () => {
    const res = await as("/api/v1/updates/control-plane", {
      to_version: "0.3.0",
      confirm_breaking: false,
      skip_backup_check: true,
    });

    expect(res.statusCode, res.body).toBe(412);
    expect(JSON.parse(res.body).error.message).toContain("breaking");
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

  it("puts the configuration back when the handover itself fails", async () => {
    dispatcher.failNext = new Error("the queue directory is read-only");
    const res = await as("/api/v1/updates/control-plane", {
      to_version: "0.1.5",
      skip_backup_check: true,
    });
    expect(res.statusCode, res.body).toBe(202);
    const run = body<UpdateRun>(res);

    await waitUntil(async () => (await readRun(run.id)).status === "failed");
    const after = await readRun(run.id);
    expect(after.error).toContain("read-only");
    expect(after.error).toContain("restored");

    // .env is exactly what it was: the next `compose up`, whatever
    // triggers it, must not quietly apply the release.
    const env = readFileSync(join(dataDir, ".env"), "utf8");
    expect(env).toContain("KANAME_VERSION=0.1.0");
    expect(env).not.toContain("0.1.5");
    expect(await pendingRecord()).toBeNull();
    expect(dispatcher.withdrawn).toBe(1);
  });

  it("blocks on a missing backup and audits the decision to skip it", async () => {
    const skipsBefore = await skipAudits();
    const blocked = await as("/api/v1/updates/control-plane", { to_version: "0.2.0" });
    expect(blocked.statusCode, blocked.body).toBe(412);
    expect(JSON.parse(blocked.body).error.message).toContain("backup");

    const accepted = await as("/api/v1/updates/control-plane", {
      to_version: "0.2.0",
      skip_backup_check: true,
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    appliedRunId = body<UpdateRun>(accepted).id;

    expect(await skipAudits()).toBe(skipsBefore + 1);
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
    // The record the next boot judges by was written before the handover.
    expect((await pendingRecord())?.run_id).toBe(appliedRunId);
  });

  it("refuses a second update while one is in flight", async () => {
    const res = await as("/api/v1/updates/control-plane", {
      to_version: "0.1.5",
      skip_backup_check: true,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(JSON.parse(res.body).error.message).toContain("already in progress");
  });

  it("follows the host's log and ends the run here when the pull fails", async () => {
    const request = dispatcher.requests[0]!;
    // What kaname-host.sh leaves behind when `compose pull` fails: the
    // reason, the verdict, and a log. It restored nothing was stopped,
    // and this process was never replaced.
    writeFileSync(
      request.log_file,
      "12:00:00 ==> applying 0.2.0 over 0.1.0\n12:00:01 --> pulling images\n12:00:02 !! could not pull the images for 0.2.0; nothing was stopped\n",
    );
    writeFileSync(resultFileFor(appliedRunId), "picked_up\npull_failed\nrolled_back\n");

    await ctx.updates.pollHost();

    const run = await readRun(appliedRunId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("could not be pulled");
    // The host's own lines reached the run while it was being watched.
    expect(run.log).toContain("--> pulling images");
    expect(run.log).toContain("configuration restored");

    const env = readFileSync(join(dataDir, ".env"), "utf8");
    expect(env).toContain("KANAME_VERSION=0.1.0");
    expect(env).not.toContain("KANAME_NEW_SECRET");
    expect(await pendingRecord()).toBeNull();
    // Verdict in, log spliced: the files have nothing left to say.
    expect(existsSync(request.log_file)).toBe(false);
    expect(existsSync(resultFileFor(appliedRunId))).toBe(false);
  });

  it("lets exactly one of two simultaneous clicks through", async () => {
    const before = (await controlPlaneRuns()).length;
    const payload = { to_version: "0.2.0", skip_backup_check: true };
    const [first, second] = await Promise.all([
      as("/api/v1/updates/control-plane", payload),
      as("/api/v1/updates/control-plane", payload),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const runs = await controlPlaneRuns();
    expect(runs.length).toBe(before + 1);
    appliedRunId = runs.find((row) => row.status === "running")!.id;
  });

  it("gives up when the host never picks the request up", async () => {
    await waitUntil(async () => (await pendingRecord())?.run_id === appliedRunId);

    // Two minutes of silence from the path unit.
    await ctx.updates.pollHost(Date.now() + 3 * 60_000);

    const run = await readRun(appliedRunId);
    expect(run.status).toBe("needs_attention");
    expect(run.error).toContain("never picked up");
    expect(run.error).toContain("kaname-update.path");
    expect(readFileSync(join(dataDir, ".env"), "utf8")).toContain("KANAME_VERSION=0.1.0");
    expect(await pendingRecord()).toBeNull();
    // The request is taken back so a unit that wakes up later does not
    // apply an update nobody is waiting on.
    expect(dispatcher.withdrawn).toBe(2);
  });
});

describe("finishing an update the previous process could not", () => {
  it("does not call it succeeded until the new build is answering", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 0 });
    writeFileSync(join(dataDir, "updates", `${run}.log`), "12:00:01 --> pulling images\n");

    // The service reads its own version from config; standing in for
    // "0.2.0 booted" means telling it that is what it is running.
    await withVersion("0.2.0", () => ctx.updates.reconcile());

    const booted = await readRun(run);
    expect(booted.status).toBe("running");
    expect(booted.log).toContain("--> pulling images");
    expect((await pendingRecord())?.run_id).toBe(run);

    // Not this build's to confirm.
    await ctx.updates.confirmBooted();
    expect((await readRun(run)).status).toBe("running");

    await withVersion("0.2.0", () => ctx.updates.confirmBooted());
    const after = await readRun(run);
    expect(after.status).toBe("succeeded");
    expect(after.log).toContain("is up and answering");
    expect(await pendingRecord()).toBeNull();
  });

  it("records a rollback when the old version came back untouched", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 0 });
    await ctx.updates.reconcile();

    const after = await readRun(run);
    expect(after.status).toBe("rolled_back");
    expect(after.error).toContain("health check");
  });

  it("says why, in the host's words, and picks up the lines it missed", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 0 });
    const logFile = join(dataDir, "updates", `${run}.log`);
    // At the moment the old build boots the helper is still inside its
    // `compose up`: the reason is written, the verdict is not.
    writeFileSync(logFile, "12:00:05 !! no answer from /health after 120s\n");
    writeFileSync(resultFileFor(run), "picked_up\nhealth_failed\n");

    await ctx.updates.reconcile();
    const after = await readRun(run);
    expect(after.status).toBe("rolled_back");
    expect(after.error).toContain("/health");
    expect(after.log).toContain("no answer from /health");

    // ...and then it returns and finishes writing.
    writeFileSync(logFile, `${readFileSync(logFile, "utf8")}12:01:30 !! rolled back to 0.1.0\n`);
    writeFileSync(resultFileFor(run), "picked_up\nhealth_failed\nrolled_back\n");
    await ctx.updates.pollHost();

    expect((await readRun(run)).log).toContain("rolled back to 0.1.0");
    expect(existsSync(logFile)).toBe(false);
    expect(existsSync(resultFileFor(run))).toBe(false);
  });

  it("files a pull that failed before anything stopped as failed, not rolled back", async () => {
    const run = await seedPendingRun("0.2.0", { migrationsBehind: 0 });
    writeFileSync(resultFileFor(run), "picked_up\npull_failed\nrolled_back\n");

    await ctx.updates.reconcile();
    const after = await readRun(run);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("could not be pulled");
    await ctx.updates.pollHost();
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
  let queuedRunId: string;

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
    queuedRunId = runs[0]!.id;
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

  it("settles a run whose job died with the control plane", async () => {
    const stuck = await orphanedAgentRun("fleet-02", "0.1.0");
    const swapped = await orphanedAgentRun("fleet-03", "0.2.0");

    await ctx.updates.settleOrphanAgentRuns();

    const gone = await readRun(stuck);
    expect(gone.status).toBe("needs_attention");
    expect(gone.error).toContain("restarted");
    expect(gone.error).toContain("0.1.0");

    // The hello frame carried the new version: the swap took, whatever
    // happened to the handler that was waiting for it.
    const confirmed = await readRun(swapped);
    expect(confirmed.status).toBe("succeeded");
    expect(confirmed.log).toContain("0.2.0");

    // A job that is merely waiting for its host is not an orphan.
    expect((await readRun(queuedRunId)).status).toBe("queued");
  });
});

describe("the panel's own address", () => {
  it("starts on the IP, with no domain and no TLS", async () => {
    const res = await as("/api/v1/settings/address", undefined, "GET");
    expect(res.statusCode, res.body).toBe(200);

    const address = body<AddressSettings>(res);
    expect(address.domain).toBeNull();
    expect(address.tls).toBe(false);
    expect(address.managed).toBe(true);
  });

  it("refuses something that is not a hostname", async () => {
    const res = await as("/api/v1/settings/address", { domain: "not a domain" });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.fields.domain).toContain("panel.example.com");
  });

  it("adds a domain without taking the IP away", async () => {
    const before = dispatcher.requests.length;
    const res = await as("/api/v1/settings/address", { domain: "Panel.Example.COM" });
    expect(res.statusCode, res.body).toBe(202);

    const address = body<AddressSettings & { applying: boolean }>(res);
    expect(address.domain).toBe("panel.example.com");
    expect(address.public_url).toBe("https://panel.example.com");
    expect(address.tls).toBe(true);
    expect(address.applying).toBe(true);

    const env = readFileSync(join(dataDir, ".env"), "utf8");
    expect(env).toContain("KANAME_DOMAIN=panel.example.com");
    expect(env).toContain("KANAME_PUBLIC_URL=https://panel.example.com");
    // A secure cookie is only possible once there is TLS to carry it.
    expect(env).toContain("KANAME_SECURE_COOKIES=auto");

    const request = dispatcher.requests[dispatcher.requests.length - 1]!;
    expect(dispatcher.requests.length).toBe(before + 1);
    expect(request.kind).toBe("reconfigure");
  });

  it("goes back to plain HTTP when the domain is cleared", async () => {
    const res = await as("/api/v1/settings/address", { domain: "" });
    expect(res.statusCode, res.body).toBe(202);
    // Back to the address the installer set up, not http://<domain>.
    expect(body<AddressSettings>(res).public_url).toBe("http://localhost:3000");
    expect(body<AddressSettings>(res).domain).toBeNull();

    const env = readFileSync(join(dataDir, ".env"), "utf8");
    expect(env).toContain("KANAME_SECURE_COOKIES=false");
    expect(env).toContain("KANAME_DOMAIN=");
  });

  it("says so rather than pretending when there is no host helper", async () => {
    dispatcher.installed = false;
    try {
      expect(
        body<AddressSettings>(await as("/api/v1/settings/address", undefined, "GET")).managed,
      ).toBe(false);

      const res = await as("/api/v1/settings/address", { domain: "panel.example.com" });
      expect(res.statusCode).toBe(412);
      expect(JSON.parse(res.body).error.message).toContain("does not manage its own address");
    } finally {
      dispatcher.installed = true;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => Promise.resolve(predicate()), timeoutMs);
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
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

/** Where kaname-host.sh writes its verdict for a run. */
function resultFileFor(runId: string): string {
  return join(dataDir, "updates", `${runId}.result`);
}

async function pendingRecord(): Promise<{ run_id: string } | null> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, "updates.pending"));
  return (rows[0]?.value as { run_id: string } | undefined) ?? null;
}

async function controlPlaneRuns() {
  return ctx.db.select().from(updateRuns).where(eq(updateRuns.kind, "control_plane"));
}

async function skipAudits(): Promise<number> {
  const rows = await ctx.db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.action, "update.backup_check_skipped"));
  return rows.length;
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
  mkdirSync(join(dataDir, "updates"), { recursive: true });

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

/**
 * An agent rollout whose handler is gone: the job the worker was running
 * has already been reaped as failed, and the run is still `running`.
 */
async function orphanedAgentRun(name: string, reportsVersion: string): Promise<string> {
  const [host] = await ctx.db
    .insert(servers)
    .values({
      name,
      hostname: `${name}.example.com`,
      arch: "amd64",
      agentVersion: reportsVersion,
    })
    .returning({ id: servers.id });
  const [job] = await ctx.db
    .insert(jobs)
    .values({
      type: "agent.update",
      status: "failed",
      serverId: host!.id,
      error: { code: "lease_expired", message: "the worker that held this job is gone" },
      finishedAt: new Date(),
    })
    .returning({ id: jobs.id });
  const run = await ctx.updates.createRun({
    kind: "agent",
    serverId: host!.id,
    fromVersion: "0.1.0",
    toVersion: "0.2.0",
    trigger: "manual",
    breaking: false,
    actor: null,
    jobId: job!.id,
  });
  await ctx.updates.setStatus(run.id, "running");
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
