import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { and, createDb, eq, inArray, ne, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import {
  auditEvents,
  backupRuns,
  backupSchedules,
  jobLogs,
  jobs,
  restorePoints,
  servers,
} from "@kaname/db/schema";
import type { BackupDestinationTarget } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { registerJobHandlers } from "./jobs/handlers.js";
import { JobWorker } from "./jobs/worker.js";
import { buildServer } from "./server.js";
import {
  AGENT_TOO_OLD,
  agentSecretRef,
  readSecret,
  resticEnvFor,
  scheduleIdFromRef,
} from "./services/backup-secrets.js";

/* ------------------------------------------------------------------ *
 * Backup credentials reach the host without anyone placing them there.
 *
 *   - the stored ref (`backup_schedule:<uuid>`) is mapped to the agent's
 *     form (`backup_schedule.<uuid>`) at the agent boundary only;
 *   - restic's environment is derived from the destination as its
 *     public config describes it;
 *   - every restic job puts the secret first, once, and names it by the
 *     agent ref in every verb after; a restore elsewhere takes it away;
 *   - schedule and destination changes queue provisioning jobs whose
 *     params, logs and audit entries never hold a secret value.
 * ------------------------------------------------------------------ */

const OWNER_EMAIL = "owner@backupsecrets.test";
const OWNER_PASSWORD = "owner-password-for-backup-secrets-1";
const SECRET_KEY = "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY";
const ROTATED_KEY = "rotated-secret-access-key-0123456789";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let cookie = "";
let forge = "";
let edge = "";
let s3Destination = "";
let localDestination = "";
let ip = 10;

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });
const data = <T = any>(res: LightMyRequestResponse): T => JSON.parse(res.body).data as T;

/* ----------------------------- fake hub ---------------------------- */

class FakeHub {
  connected = new Set<string>();
  calls: { serverId: string; method: string; params: Record<string, unknown> }[] = [];
  answers = new Map<string, (params: Record<string, unknown>) => unknown>();
  defaults: Record<string, (params: Record<string, unknown>) => unknown> = {
    "backup.secret_put": (p) => ({ ref: p.ref }),
    "backup.secret_delete": (p) => ({ ref: p.ref, removed: true }),
    "backup.run": () => ({
      id: crypto.randomUUID().replaceAll("-", ""),
      taken_at: new Date().toISOString(),
      bytes: 1024,
      file_count: 3,
      paths: ["/etc"],
      tags: [],
      verified: false,
    }),
    "backup.prune": () => ({ removed: 0, reclaimed_bytes: 0 }),
    "backup.list": () => ({ snapshots: [] }),
    "backup.restore": () => ({ restored_files: 3, bytes: 1024 }),
    "backup.verify": () => ({ ok: true, errors: [] }),
  };
  private answer(serverId: string, method: string, params: Record<string, unknown>): unknown {
    if (!this.connected.has(serverId)) throw new AgentOfflineError(serverId);
    this.calls.push({ serverId, method, params });
    const fn = this.answers.get(method) ?? this.defaults[method];
    if (!fn) throw new AgentRpcError({ code: "unknown_method", message: `unknown method ${method}` });
    return fn(params);
  }
  isConnected(id: string) {
    return this.connected.has(id);
  }
  connectedServerIds() {
    return [...this.connected];
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
    return this.calls.map((c) => c.method);
  }
  as() {
    return this as unknown as AgentHub;
  }
}

/** Runs one queued job through a real worker whose hub is the fake. */
async function execute(hub: FakeHub, jobId: string) {
  const worker = new JobWorker({
    db: ctx.db,
    hub: hub.as(),
    queue: ctx.queue,
    events: ctx.events,
    audit: ctx.audit,
    config: ctx.config,
    log: ctx.log,
    mailReleases: ctx.mailReleases,
    mailSecrets: ctx.mailSecrets,
  });
  registerJobHandlers(worker);
  const [row] = await handle.db
    .update(jobs)
    .set({ status: "running", attempt: 1, startedAt: new Date(), blockedReason: null })
    .where(eq(jobs.id, jobId))
    .returning();
  await (worker as unknown as { execute(job: typeof row): Promise<void> }).execute(row!);
  const [done] = await handle.db.select().from(jobs).where(eq(jobs.id, jobId));
  return done!;
}

const retention = { keep_last: 3, keep_daily: 7, keep_weekly: 0, keep_monthly: 0 };

async function createSchedule(name: string, overrides: Record<string, unknown> = {}) {
  const res = await call("POST", "/backups/schedules", {
    name,
    server_id: forge,
    scope: [{ kind: "files", selectors: ["/etc"] }],
    cron: "0 3 * * *",
    destination_id: s3Destination,
    retention,
    ...overrides,
  });
  expect(res.statusCode).toBe(201);
  return data<{ id: string; name: string }>(res);
}

async function jobsFor(scheduleId: string, type: string) {
  return handle.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.targetId, scheduleId),
        eq(jobs.type, type as "backup.provision"),
        ne(jobs.status, "cancelled"),
      ),
    );
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
    remoteAddress: `198.51.100.${ip++}`,
    payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const c = login.cookies.find((x) => x.value)!;
  cookie = `${c.name}=${c.value}`;

  const rows = await handle.db
    .insert(servers)
    .values([
      { name: "forge-01", hostname: "forge-01.example.com", enrolledAt: new Date() },
      { name: "edge-01", hostname: "edge-01.example.com", enrolledAt: new Date() },
    ])
    .returning({ id: servers.id });
  forge = rows[0]!.id;
  edge = rows[1]!.id;

  const s3 = await call("POST", "/backups/destinations", {
    name: "aws",
    target: {
      kind: "s3",
      provider: "aws",
      region: "eu-west-1",
      bucket: "kaname-backups",
      prefix: "hosts",
      access_key_id: "AKIAEXAMPLE1234",
      secret_access_key: SECRET_KEY,
    },
  });
  expect(s3.statusCode).toBe(201);
  s3Destination = data(s3).id;

  const local = await call("POST", "/backups/destinations", {
    name: "local",
    target: { kind: "local", server_id: forge, path: "/var/backups/kaname" },
  });
  expect(local.statusCode).toBe(201);
  localDestination = data(local).id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

beforeEach(async () => {
  // Each test sees only the jobs it queues.
  await handle.db
    .update(jobs)
    .set({ status: "cancelled" })
    .where(inArray(jobs.status, ["queued", "running"]));
});

/* ------------------------------ pure ------------------------------- */

describe("agent secret refs", () => {
  it("maps the stored ref to the agent's form and leaves agent-safe refs alone", () => {
    const id = "6f1c2a8e-0b7d-4c55-9a1e-2f3b4c5d6e7f";
    expect(agentSecretRef(`backup_schedule:${id}`)).toBe(`backup_schedule.${id}`);
    expect(agentSecretRef(`backup_schedule.${id}`)).toBe(`backup_schedule.${id}`);
    expect(agentSecretRef(`backup_schedule:${id}`)).not.toContain(":");
    expect(scheduleIdFromRef(`backup_schedule:${id}`)).toBe(id);
    expect(() => scheduleIdFromRef("ref")).toThrow(/does not name a schedule/);
    expect(() => scheduleIdFromRef(`backup_destination:${id}`)).toThrow();
  });
});

describe("restic environment", () => {
  const s3 = {
    kind: "s3",
    provider: "aws",
    region: "eu-west-1",
    bucket: "b",
    prefix: "",
    access_key_id: "AKIA1",
    secret_access_key: "s3cret",
  } as const;

  it("uses virtual-hosted addressing for AWS", () => {
    expect(resticEnvFor(s3 as BackupDestinationTarget)).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA1",
      AWS_SECRET_ACCESS_KEY: "s3cret",
      AWS_DEFAULT_REGION: "eu-west-1",
      KANAME_S3_BUCKET_LOOKUP: "dns",
    });
  });

  it("uses path-style for MinIO and R2 by default, and honours an explicit choice", () => {
    const minio = { ...s3, provider: "minio", region: "us-east-1", endpoint: "http://10.0.0.5:9000" };
    expect(resticEnvFor(minio as BackupDestinationTarget).KANAME_S3_BUCKET_LOOKUP).toBe("path");
    expect(
      resticEnvFor({ ...minio, path_style: false } as BackupDestinationTarget).KANAME_S3_BUCKET_LOOKUP,
    ).toBe("dns");
    expect(resticEnvFor({ ...s3, path_style: true } as BackupDestinationTarget).KANAME_S3_BUCKET_LOOKUP).toBe(
      "path",
    );
  });

  it("names B2's own variables, needs nothing for a local directory, and refuses SFTP", () => {
    expect(
      resticEnvFor({ kind: "b2", bucket: "b", prefix: "", access_key_id: "k1", secret_access_key: "k2" }),
    ).toEqual({ B2_ACCOUNT_ID: "k1", B2_ACCOUNT_KEY: "k2" });
    expect(resticEnvFor({ kind: "local", server_id: forge || crypto.randomUUID(), path: "/srv" })).toEqual({});
    expect(() =>
      resticEnvFor({
        kind: "sftp",
        host: "backup.example.com",
        port: 22,
        username: "u",
        path: "/b",
        auth: { method: "password", password: "pw" },
      }),
    ).toThrow(/SFTP destinations need an SSH key/);
  });
});

/* ------------------------------ jobs ------------------------------- */

describe("restic jobs", () => {
  it("puts the secret once, first, then names it by the agent ref in run, prune and list", async () => {
    const schedule = await createSchedule("etc nightly");
    const ran = await call("POST", `/backups/schedules/${schedule.id}/run`);
    expect(ran.statusCode).toBe(202);
    const jobId = data(ran).job.id as string;

    const hub = new FakeHub();
    hub.connected.add(forge);
    const done = await execute(hub, jobId);
    expect(done.status).toBe("succeeded");

    const storedRef = `backup_schedule:${schedule.id}`;
    const agentRef = `backup_schedule.${schedule.id}`;
    const password = await readSecret(handle.db, ctx.config.masterKey, storedRef);
    expect(password).toBeTruthy();

    expect(hub.methods()).toEqual(["backup.secret_put", "backup.run", "backup.prune", "backup.list"]);
    expect(hub.calls[0]).toEqual({
      serverId: forge,
      method: "backup.secret_put",
      params: {
        ref: agentRef,
        password,
        env: {
          AWS_ACCESS_KEY_ID: "AKIAEXAMPLE1234",
          AWS_SECRET_ACCESS_KEY: SECRET_KEY,
          AWS_DEFAULT_REGION: "eu-west-1",
          KANAME_S3_BUCKET_LOOKUP: "dns",
        },
      },
    });
    for (const c of hub.calls.slice(1)) expect(c.params.password_ref).toBe(agentRef);
  });

  it("keeps the password and the secret key out of job rows, job logs and audit entries", async () => {
    const seen: unknown[] = [];
    const listen = (event: unknown) => seen.push(event);
    ctx.events.on("jobs", listen);
    ctx.events.on("backups", listen);
    try {
      const schedule = await createSchedule("secrets stay put");
      const ran = await call("POST", `/backups/schedules/${schedule.id}/run`);
      const hub = new FakeHub();
      hub.connected.add(forge);
      const provision = (await jobsFor(schedule.id, "backup.provision"))[0]!;
      await execute(hub, provision.id);
      await execute(hub, data(ran).job.id);
      expect(hub.methods().filter((m) => m === "backup.secret_put")).toHaveLength(2);

      const password = (await readSecret(handle.db, ctx.config.masterKey, `backup_schedule:${schedule.id}`))!;
      const jobRows = await handle.db.select().from(jobs);
      const logRows = await handle.db.select().from(jobLogs);
      const auditRows = await handle.db.select().from(auditEvents);
      const dump = JSON.stringify({ jobRows, logRows, auditRows, seen, ran: ran.body });
      expect(dump).not.toContain(password);
      expect(dump).not.toContain(SECRET_KEY);
      expect(logRows.some((l) => l.message.includes("backup credentials handed to the host"))).toBe(true);
    } finally {
      ctx.events.off("jobs", listen);
      ctx.events.off("backups", listen);
    }
  });

  it("gives an unencrypted schedule a password when it first runs, and provisions it", async () => {
    const schedule = await createSchedule("plain nightly", { encryption: false, destination_id: localDestination });
    const ran = await call("POST", `/backups/schedules/${schedule.id}/run`);
    expect(ran.statusCode).toBe(202);
    const [row] = await handle.db.select().from(jobs).where(eq(jobs.id, data(ran).job.id));
    expect((row!.params as { password_ref: string }).password_ref).toBe(`backup_schedule:${schedule.id}`);
    const [saved] = await handle.db.select().from(backupSchedules).where(eq(backupSchedules.id, schedule.id));
    expect(saved!.passwordRef).toBe(`backup_schedule:${schedule.id}`);

    const hub = new FakeHub();
    hub.connected.add(forge);
    const done = await execute(hub, row!.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("succeeded");
    const put = hub.calls.find((c) => c.method === "backup.secret_put")!;
    expect(put.params.ref).toBe(`backup_schedule.${schedule.id}`);
    expect(String(put.params.password).length).toBeGreaterThan(20);
    expect(put.params.env).toEqual({});
  });

  async function pointFor(scheduleId: string) {
    const [run] = await handle.db
      .insert(backupRuns)
      .values({ scheduleId, serverId: forge, status: "succeeded", trigger: "manual" })
      .returning();
    const [point] = await handle.db
      .insert(restorePoints)
      .values({
        runId: run!.id,
        scheduleId,
        serverId: forge,
        label: `p${Math.floor(Math.random() * 1e6)}`,
        snapshotId: `snap${Math.floor(Math.random() * 1e9)}`,
        takenAt: new Date(),
        scope: [{ kind: "files", selectors: ["/etc"] }],
      })
      .returning();
    return point!;
  }

  it("provisions a restore onto another host and removes the secret there afterwards", async () => {
    const schedule = await createSchedule("restore elsewhere");
    const point = await pointFor(schedule.id);
    const res = await call("POST", "/backups/restore", {
      restore_point_id: point.id,
      target_server_id: edge,
      target_path: "/srv/restore",
      confirm_label: point.label,
    });
    expect(res.statusCode).toBe(202);

    const hub = new FakeHub();
    hub.connected.add(edge);
    const done = await execute(hub, data(res).job.id);
    expect(done.status).toBe("succeeded");
    expect(hub.calls.map((c) => `${c.method}@${c.serverId === edge ? "edge" : "forge"}`)).toEqual([
      "backup.secret_put@edge",
      "backup.restore@edge",
      "backup.secret_delete@edge",
    ]);
    const agentRef = `backup_schedule.${schedule.id}`;
    expect(hub.calls.map((c) => c.params.ref ?? c.params.password_ref)).toEqual([agentRef, agentRef, agentRef]);
  });

  it("removes the secret from the other host even when the restore fails, and keeps it at home", async () => {
    const schedule = await createSchedule("restore fails elsewhere");
    const point = await pointFor(schedule.id);
    const restore = (target: string) =>
      call("POST", "/backups/restore", {
        restore_point_id: point.id,
        target_server_id: target,
        target_path: "/srv/restore",
        confirm_label: point.label,
      });

    const failing = new FakeHub();
    failing.connected.add(edge);
    failing.answers.set("backup.restore", () => {
      throw new AgentRpcError({ code: "exec_failed", message: "restic: wrong password" });
    });
    const failed = await execute(failing, data(await restore(edge)).job.id);
    expect(failed.status).toBe("failed");
    expect(failing.methods()).toEqual(["backup.secret_put", "backup.restore", "backup.secret_delete"]);

    const home = new FakeHub();
    home.connected.add(forge);
    const done = await execute(home, data(await restore(forge)).job.id);
    expect(done.status).toBe("succeeded");
    expect(home.methods()).toEqual(["backup.secret_put", "backup.restore"]);

    const verified = await call("POST", `/backups/restore-points/${point.id}/verify`);
    expect(verified.statusCode).toBe(202);
    const verify = new FakeHub();
    verify.connected.add(forge);
    expect((await execute(verify, data(verified).job.id)).status).toBe("succeeded");
    expect(verify.methods()).toEqual(["backup.secret_put", "backup.verify"]);
  });

  it("tells the operator to upgrade an agent that does not know the secret verbs", async () => {
    const schedule = await createSchedule("old agent");
    const provision = (await jobsFor(schedule.id, "backup.provision"))[0]!;
    const hub = new FakeHub();
    hub.connected.add(forge);
    hub.answers.set("backup.secret_put", () => {
      throw new AgentRpcError({ code: "unknown_method", message: "unknown method backup.secret_put" });
    });
    const done = await execute(hub, provision.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatchObject({ code: "precondition_failed", message: AGENT_TOO_OLD });

    const ran = await call("POST", `/backups/schedules/${schedule.id}/run`);
    const run = await execute(hub, data(ran).job.id);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toBe(AGENT_TOO_OLD);
    // Nothing was backed up with credentials that never arrived.
    expect(hub.methods()).not.toContain("backup.run");
  });

  it("generates a password for a ref with no stored secret, and provisions a destination missing credentials", async () => {
    // As the demo seed leaves its schedules: a ref, no secret row, and a
    // destination whose credentials were never stored.
    const schedule = await createSchedule("seeded style");
    const { backupDestinations, secrets } = await import("@kaname/db/schema");
    const ref = `backup_schedule:${schedule.id}`;
    await handle.db.delete(secrets).where(eq(secrets.ref, ref));
    const [bare] = await handle.db
      .insert(backupDestinations)
      .values({ name: "b2 without credentials", kind: "b2", config: { bucket: "b", prefix: "p" } })
      .returning();
    await handle.db
      .update(backupSchedules)
      .set({ destinationId: bare!.id })
      .where(eq(backupSchedules.id, schedule.id));

    const ran = await call("POST", `/backups/schedules/${schedule.id}/run`);
    const hub = new FakeHub();
    hub.connected.add(forge);
    const done = await execute(hub, data(ran).job.id);
    expect(done.error).toBeNull();
    expect(hub.methods()).toEqual(["backup.secret_put", "backup.run", "backup.prune", "backup.list"]);
    const password = await readSecret(handle.db, ctx.config.masterKey, ref);
    expect(password).toBeTruthy();
    expect(hub.calls[0]!.params).toEqual({ ref: `backup_schedule.${schedule.id}`, password, env: {} });

    // A second run keeps the same password: the repository must still open.
    const again = await call("POST", `/backups/schedules/${schedule.id}/run`);
    await execute(hub, data(again).job.id);
    expect(await readSecret(handle.db, ctx.config.masterKey, ref)).toBe(password);
    const logs = await handle.db.select().from(jobLogs).where(eq(jobLogs.jobId, data(ran).job.id));
    expect(logs.some((l) => l.level === "warn" && l.message.includes("has no stored credentials"))).toBe(true);
  });
});

/* ----------------------------- routes ------------------------------ */

describe("provisioning outside runs", () => {
  it("queues a provision when a schedule is created, with no secret in its params", async () => {
    const schedule = await createSchedule("created and provisioned");
    const queued = await jobsFor(schedule.id, "backup.provision");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ serverId: forge, status: "queued", blockedReason: "agent_offline" });
    expect(queued[0]!.params).toEqual({ schedule_id: schedule.id });

    const hub = new FakeHub();
    hub.connected.add(forge);
    const done = await execute(hub, queued[0]!.id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ ref: `backup_schedule.${schedule.id}`, provisioned: true });
  });

  it("queues a provision when a schedule's destination, encryption or name changes — not its cron", async () => {
    const schedule = await createSchedule("patched");
    await handle.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.targetId, schedule.id));

    expect((await call("PATCH", `/backups/schedules/${schedule.id}`, { cron: "0 4 * * *" })).statusCode).toBe(200);
    expect(await jobsFor(schedule.id, "backup.provision")).toHaveLength(0);

    expect((await call("PATCH", `/backups/schedules/${schedule.id}`, { encryption: false })).statusCode).toBe(200);
    expect(await jobsFor(schedule.id, "backup.provision")).toHaveLength(1);
    // One waiting provision covers the next change: it reads the secrets when it runs.
    expect((await call("PATCH", `/backups/schedules/${schedule.id}`, { name: "patched again" })).statusCode).toBe(200);
    expect(await jobsFor(schedule.id, "backup.provision")).toHaveLength(1);
  });

  it("queues one provision per schedule when a destination's credentials rotate", async () => {
    const a = await createSchedule("rotation a");
    const b = await createSchedule("rotation b");
    await handle.db.update(jobs).set({ status: "cancelled" }).where(inArray(jobs.targetId, [a.id, b.id]));

    expect((await call("PATCH", `/backups/destinations/${s3Destination}`, { name: "aws renamed" })).statusCode).toBe(
      200,
    );
    expect(await jobsFor(a.id, "backup.provision")).toHaveLength(0);

    const rotated = await call("PATCH", `/backups/destinations/${s3Destination}`, {
      target: {
        kind: "s3",
        provider: "aws",
        region: "eu-west-1",
        bucket: "kaname-backups",
        prefix: "hosts",
        access_key_id: "AKIAROTATED5678",
        secret_access_key: ROTATED_KEY,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain(ROTATED_KEY);
    const forA = await jobsFor(a.id, "backup.provision");
    const forB = await jobsFor(b.id, "backup.provision");
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);

    const hub = new FakeHub();
    hub.connected.add(forge);
    await execute(hub, forA[0]!.id);
    expect(hub.calls[0]!.params.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIAROTATED5678",
      AWS_SECRET_ACCESS_KEY: ROTATED_KEY,
    });
    const audit = JSON.stringify(await handle.db.select().from(auditEvents));
    expect(audit).not.toContain(ROTATED_KEY);
  });

  it("queues an unprovision on the schedule's server when the schedule is deleted", async () => {
    const schedule = await createSchedule("deleted");
    expect((await call("DELETE", `/backups/schedules/${schedule.id}`)).statusCode).toBe(204);
    const queued = await jobsFor(schedule.id, "backup.unprovision");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ serverId: forge, params: { ref: `backup_schedule:${schedule.id}` } });

    const hub = new FakeHub();
    hub.connected.add(forge);
    // The provision queued at creation finds nothing left to hand over.
    const provision = (await jobsFor(schedule.id, "backup.provision"))[0]!;
    await handle.db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, provision.id));
    expect((await execute(hub, provision.id)).result).toEqual({ provisioned: false });
    expect(hub.calls).toEqual([]);

    const done = await execute(hub, queued[0]!.id);
    expect(done.status).toBe("succeeded");
    expect(hub.calls).toEqual([
      { serverId: forge, method: "backup.secret_delete", params: { ref: `backup_schedule.${schedule.id}` } },
    ]);
  });
});
