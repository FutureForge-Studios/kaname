import { and, eq, notInArray, sql } from "@kaname/db";
import {
  backupRuns,
  backupSchedules,
  certificates,
  containers,
  dbDatabases,
  dbUsers,
  firewallState,
  restorePoints,
  servers,
  services,
  sites,
  sshConfigs,
  storageSamples,
  updateRuns,
} from "@kaname/db/schema";
import type {
  AgentMethod,
  CertStatus,
  JobType,
  MethodParams,
  MethodResult,
} from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { ftpJobHandlers } from "./ftp.js";
import { mailJobHandlers } from "./mail.js";
import { websiteJobHandlers } from "./websites.js";
import { appJobHandlers } from "./apps.js";
import { banHandler, unbanHandler } from "./threats.js";
import type { JobContext, JobHandler, JobWorker } from "./worker.js";

/* ------------------------------------------------------------------ *
 * Job handlers.
 *
 * Each one performs exactly one agent RPC and then writes back the
 * resulting state. No handler talks to a host any other way, and none
 * of them constructs a shell string — the RPC surface has no verb that
 * would accept one.
 * ------------------------------------------------------------------ */

function requireServer(ctx: JobContext): string {
  if (!ctx.job.serverId) throw new Error(`${ctx.job.type} requires a server`);
  return ctx.job.serverId;
}

function params<T>(ctx: JobContext): T {
  return ctx.job.params as T;
}

/**
 * Runs the vhost write for a site job. A site row is written as
 * "provisioning" (create) before the job is queued; if the host refuses
 * the vhost, nothing else ever moves it, so it sat in "provisioning" for
 * ever with the reason only in the job log. The row is marked "error"
 * with the reason instead. An offline agent is not a failure — the job
 * waits for it (KD-008) — so that one is left alone.
 */
async function siteWrite<T>(ctx: JobContext, siteId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof AgentOfflineError)) {
      await ctx.db
        .update(sites)
        .set({
          status: "error",
          lastError: err instanceof Error ? err.message : String(err),
          updatedAt: new Date(),
        })
        .where(eq(sites.id, siteId));
    }
    throw err;
  }
}

/** Where a top-level path's bytes are reported in the storage breakdown. */
const STORAGE_CATEGORIES: readonly { prefix: string; label: string; kind: string }[] = [
  { prefix: "/var/www", label: "Websites", kind: "sites" },
  { prefix: "/var/lib/postgresql", label: "Databases", kind: "databases" },
  { prefix: "/var/lib/mysql", label: "Databases", kind: "databases" },
  { prefix: "/var/vmail", label: "Mail", kind: "mail" },
  { prefix: "/var/mail", label: "Mail", kind: "mail" },
  { prefix: "/opt/stalwart", label: "Mail", kind: "mail" },
  { prefix: "/var/lib/docker", label: "Containers", kind: "containers" },
  { prefix: "/var/backups", label: "Backups", kind: "backups" },
  { prefix: "/srv/backups", label: "Backups", kind: "backups" },
  { prefix: "/var/log", label: "Logs", kind: "logs" },
  { prefix: "/home", label: "Home directories", kind: "home" },
];

/**
 * Turns one fs.usage walk into the cached breakdown GET /storage serves.
 * Capacity comes from the host's mounts (system.metrics) because a walk
 * of a subtree says nothing about the device it sits on; if the agent
 * cannot report them the walk's own total stands in, rather than failing
 * a sample that did succeed.
 */
async function recordStorageSample(
  ctx: JobContext,
  serverId: string,
  usage: MethodResult<"fs.usage">,
  durationMs: number,
): Promise<void> {
  const disks = await ctx.hub
    .call(serverId, "system.metrics", {}, { signal: ctx.signal })
    .then((sample) => sample.disks)
    .catch(() => []);

  const total = disks.length > 0 ? disks.reduce((sum, d) => sum + d.total, 0) : usage.total;
  const used = disks.length > 0 ? disks.reduce((sum, d) => sum + d.used, 0) : usage.total;
  const sampledAt = new Date();

  const categories = new Map<
    string,
    { label: string; path: string; bytes: number; kind: string }
  >();
  for (const category of STORAGE_CATEGORIES) {
    const entry = usage.entries.find((e) => e.path === category.prefix);
    if (!entry) continue;
    const existing = categories.get(category.label);
    if (existing) existing.bytes += entry.bytes;
    else
      categories.set(category.label, {
        label: category.label,
        path: category.prefix,
        bytes: entry.bytes,
        kind: category.kind,
      });
  }

  const largest = usage.entries
    .filter((e) => e.kind !== "category")
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 100)
    .map((e) => ({
      path: e.path,
      bytes: e.bytes,
      kind: "directory",
      modified_at: sampledAt.toISOString(),
    }));

  await ctx.db.insert(storageSamples).values({
    serverId,
    sampledAt,
    total,
    used,
    available: Math.max(0, total - used),
    mounts: disks,
    categories: [...categories.values()],
    largest,
    inodesTotal: disks.reduce((sum, d) => sum + (d.inodes_total ?? 0), 0) || null,
    inodesUsed: disks.reduce((sum, d) => sum + (d.inodes_used ?? 0), 0) || null,
    durationMs,
  });
}

/** The agent answered with this error code, as opposed to being unreachable. */
function agentSaid(err: unknown, code: string): boolean {
  return err instanceof AgentRpcError && err.agentError.code === code;
}

/** The common shape: call one method with the job's params, return the result. */
function passthrough<M extends AgentMethod>(method: M): JobHandler {
  return async (ctx) => {
    const serverId = requireServer(ctx);
    await ctx.log_("info", `${method} on ${serverId}`);
    return ctx.hub.call(serverId, method, params<MethodParams<M>>(ctx), {
      timeoutMs: ctx.job.timeoutMs,
      signal: ctx.signal,
    });
  };
}

/** Streams the agent's output into the job log as it happens. */
function streaming<M extends AgentMethod>(method: M): JobHandler {
  return async (ctx) => {
    const serverId = requireServer(ctx);
    const handle = ctx.hub.stream(
      serverId,
      method,
      params<MethodParams<M>>(ctx),
      (data) => {
        for (const line of data.split("\n").filter(Boolean)) {
          void ctx.log_("info", line);
        }
      },
      { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
    );
    return handle.done;
  };
}

/* ------------------------------- services --------------------------- */

function serviceAction(method: Extract<AgentMethod, `service.${string}`>): JobHandler {
  return async (ctx) => {
    const serverId = requireServer(ctx);
    const { unit } = params<{ unit: string }>(ctx);
    await ctx.log_("info", `${method} ${unit}`);

    const info = await ctx.hub.call(
      serverId,
      method as "service.restart",
      { unit },
      {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      },
    );

    await ctx.db
      .update(services)
      .set({
        activeState: info.active_state,
        subState: info.sub_state,
        enabled: info.enabled,
        mainPid: info.main_pid,
        activeSince: info.active_since ? new Date(info.active_since) : null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(services.serverId, serverId), eq(services.unit, unit)));

    ctx.events.publish(
      "services",
      "service.changed",
      { server_id: serverId, unit, state: info.active_state },
      serverId,
    );
    return info;
  };
}

/* ------------------------------ containers -------------------------- */

function containerAction(method: Extract<AgentMethod, `container.${string}`>): JobHandler {
  return async (ctx) => {
    const serverId = requireServer(ctx);
    const p = params<{ id: string }>(ctx);
    const result = await ctx.hub.call(serverId, method as "container.start", p as never, {
      timeoutMs: ctx.job.timeoutMs,
      signal: ctx.signal,
    });

    if (method === "container.remove") {
      await ctx.db
        .delete(containers)
        .where(and(eq(containers.serverId, serverId), eq(containers.containerId, p.id)));
    } else if (result && typeof result === "object" && "state" in result) {
      const info = result as { state: string; status: string };
      await ctx.db
        .update(containers)
        .set({
          state: info.state as never,
          status: info.status,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(containers.serverId, serverId), eq(containers.containerId, p.id)));
    }

    ctx.events.publish(
      "containers",
      "container.changed",
      { server_id: serverId, container_id: p.id },
      serverId,
    );
    return result;
  };
}

/* ------------------------------- agents ------------------------------ *
 *
 * Updating an agent is an ordinary job, not a special case: it queues
 * behind the same lease, shows up in the same drawer, and fails the same
 * way. What it adds is the reconnection check — the process that answers
 * `system.self_update` is the one about to be replaced, so it can only
 * honestly report "restarting". Coming back at the new version is what
 * counts as success, and an agent that does not come back is left in a
 * state an operator has to acknowledge rather than a silent failure.
 * -------------------------------------------------------------------- */

interface AgentUpdateParams {
  version: string;
  url: string;
  sha256: string;
  run_id: string;
}

/** How long a host gets to download, swap and dial back in. */
const RECONNECT_TIMEOUT_MS = 5 * 60_000;
const RECONNECT_POLL_MS = 2_000;

async function appendRunLog(ctx: JobContext, runId: string, text: string): Promise<void> {
  const line = text.endsWith("\n") ? text : `${text}\n`;
  await ctx.db
    .update(updateRuns)
    .set({ log: sql`${updateRuns.log} || ${line}`, updatedAt: new Date() })
    .where(eq(updateRuns.id, runId));
  ctx.events.publish("updates", "update.log", { run_id: runId, line: line.trimEnd() });
}

async function settleRun(
  ctx: JobContext,
  runId: string,
  status: "running" | "succeeded" | "failed" | "needs_attention",
  error: string | null,
): Promise<void> {
  const rows = await ctx.db.select().from(updateRuns).where(eq(updateRuns.id, runId)).limit(1);
  const started = rows[0]?.startedAt ?? rows[0]?.createdAt ?? new Date();
  const terminal = status !== "running";
  const now = new Date();

  await ctx.db
    .update(updateRuns)
    .set({
      status,
      error,
      ...(terminal ? { finishedAt: now, durationMs: now.getTime() - started.getTime() } : {}),
      updatedAt: now,
    })
    .where(eq(updateRuns.id, runId));

  ctx.events.publish("updates", "update.status", { run_id: runId, status });
}

async function waitForReconnect(
  ctx: JobContext,
  serverId: string,
  version: string,
): Promise<boolean> {
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;

  while (Date.now() < deadline && !ctx.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_POLL_MS));
    if (!ctx.hub.isConnected(serverId)) continue;

    const rows = await ctx.db
      .select({ version: servers.agentVersion })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    // The hello frame carries the version, so a reconnect at the new one
    // is proof the swap took rather than proof the socket came back.
    if (rows[0]?.version === version) return true;
  }
  return false;
}

const agentUpdate: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<AgentUpdateParams>(ctx);

  await settleRun(ctx, p.run_id, "running", null);
  await appendRunLog(ctx, p.run_id, `==> updating the agent to ${p.version}`);
  await ctx.log_("info", `updating agent to ${p.version}`);

  const handle = ctx.hub.stream(
    serverId,
    "system.self_update",
    { version: p.version, url: p.url, sha256: p.sha256 },
    (data) => {
      for (const line of data.split("\n").filter(Boolean)) {
        void ctx.log_("info", line);
        void appendRunLog(ctx, p.run_id, line);
      }
    },
    { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
  );

  let result: unknown;
  try {
    result = await handle.done;
  } catch (err) {
    // The socket dropping mid-swap is exactly the case an operator has
    // to look at: the binary may or may not have been replaced, and
    // this process cannot tell which. Leaving the run at `running` for
    // ever would hide it.
    const message = err instanceof Error ? err.message : String(err);
    await appendRunLog(ctx, p.run_id, `!! lost contact during the update: ${message}`);
    await settleRun(ctx, p.run_id, "needs_attention", message);
    throw err;
  }

  await appendRunLog(ctx, p.run_id, "--> binary replaced; waiting for the agent to dial back in");

  if (await waitForReconnect(ctx, serverId, p.version)) {
    await appendRunLog(ctx, p.run_id, `==> reconnected running ${p.version}`);
    await settleRun(ctx, p.run_id, "succeeded", null);
    ctx.events.publish("servers", "server.changed", { server_id: serverId }, serverId);
    return result;
  }

  const message =
    `The agent did not reconnect within ${RECONNECT_TIMEOUT_MS / 60_000} minutes. ` +
    `The previous binary is still on the host at ${(result as { previous_binary_path?: string }).previous_binary_path ?? "the agent state directory"}.`;
  await appendRunLog(ctx, p.run_id, `!! ${message}`);
  await settleRun(ctx, p.run_id, "needs_attention", message);
  throw new Error(message);
};

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export function registerJobHandlers(worker: JobWorker): void {
  const handlers: Partial<Record<JobType, JobHandler>> = {
    /* system */
    "system.reboot": passthrough("system.reboot"),
    "system.packages.upgrade": streaming("system.packages.upgrade"),
    "system.sync": async (ctx) => {
      const serverId = requireServer(ctx);
      const info = await ctx.hub.call(serverId, "system.info", {}, { signal: ctx.signal });
      ctx.events.publish("servers", "server.synced", { server_id: serverId }, serverId);
      return info;
    },

    /* services */
    "service.start": serviceAction("service.start"),
    "service.stop": serviceAction("service.stop"),
    "service.restart": serviceAction("service.restart"),
    "service.reload": serviceAction("service.reload"),
    "service.enable": serviceAction("service.enable"),
    "service.disable": serviceAction("service.disable"),

    /* processes */
    "process.signal": passthrough("process.signal"),

    /* containers */
    "container.start": containerAction("container.start"),
    "container.stop": containerAction("container.stop"),
    "container.restart": containerAction("container.restart"),
    "container.remove": containerAction("container.remove"),
    "container.prune": passthrough("container.prune"),

    /* files */
    "fs.write": passthrough("fs.write"),
    "fs.mkdir": passthrough("fs.mkdir"),
    "fs.move": passthrough("fs.move"),
    "fs.copy": passthrough("fs.copy"),
    "fs.remove": passthrough("fs.remove"),
    "fs.chmod": passthrough("fs.chmod"),
    "fs.chown": passthrough("fs.chown"),
    "fs.archive": streaming("fs.archive"),
    "fs.extract": streaming("fs.extract"),
    "fs.usage": async (ctx) => {
      const serverId = requireServer(ctx);
      const started = Date.now();
      const result = await ctx.hub.call(serverId, "fs.usage", params(ctx), {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });
      // GET /storage reads only storage_samples, and nothing used to
      // write one: "Take a sample" succeeded and the page kept showing
      // the old breakdown for ever. The walk is persisted here, beside
      // the mounts the host reports right now.
      await recordStorageSample(ctx, serverId, result, Date.now() - started);
      ctx.events.publish("servers", "storage.sampled", { server_id: serverId }, serverId);
      return result;
    },

    /* ftp: real POSIX users and daemon config on the host (jobs/ftp.ts) */
    ...ftpJobHandlers(),

    /* sites */
    "site.create": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ site_id: string } & MethodParams<"site.create">>(ctx);
      const { site_id, ...rest } = p;
      const result = await siteWrite(ctx, site_id, async () => {
        const written = await ctx.hub.call(serverId, "site.create", rest, {
          timeoutMs: ctx.job.timeoutMs,
          signal: ctx.signal,
        });
        await ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
        return written;
      });
      await ctx.db
        .update(sites)
        .set({
          status: "active",
          configPath: result.config_path,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, site_id));
      return result;
    },
    "site.update": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ site_id: string } & MethodParams<"site.update">>(ctx);
      const { site_id, ...rest } = p;
      const result = await siteWrite(ctx, site_id, async () => {
        const written = await ctx.hub.call(serverId, "site.update", rest, {
          timeoutMs: ctx.job.timeoutMs,
          signal: ctx.signal,
        });
        await ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
        return written;
      });
      await ctx.db
        .update(sites)
        .set({
          // Editing a suspended site keeps it suspended: the route sends
          // `enabled: false` for one, and the row must say what the host does.
          status: rest.enabled === false ? "suspended" : "active",
          configPath: result.config_path,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, site_id));
      return result;
    },
    "site.remove": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ site_id: string; name: string; delete_webroot: boolean }>(ctx);
      const result = await ctx.hub.call(
        serverId,
        "site.remove",
        { name: p.name, delete_webroot: p.delete_webroot },
        { signal: ctx.signal },
      );
      await ctx.db.delete(sites).where(eq(sites.id, p.site_id));
      return result;
    },
    "site.reload": async (ctx) => {
      const serverId = requireServer(ctx);
      const test = await ctx.hub.call(serverId, "site.test_config", {}, { signal: ctx.signal });
      if (!test.valid) {
        await ctx.log_("error", test.output);
        throw new Error(`Web server configuration is invalid: ${test.output.slice(0, 400)}`);
      }
      return ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
    },

    /* certificates */
    "cert.issue": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ certificate_id: string } & MethodParams<"cert.issue">>(ctx);
      const { certificate_id, ...rest } = p;
      try {
        const handle = ctx.hub.stream(
          serverId,
          "cert.issue",
          rest,
          (d) => void ctx.log_("info", d.trim()),
          {
            timeoutMs: ctx.job.timeoutMs,
            signal: ctx.signal,
          },
        );
        const result = await handle.done;
        await ctx.db
          .update(certificates)
          .set({
            status: "active",
            sans: result.sans,
            issuedAt: new Date(),
            expiresAt: new Date(result.not_after),
            installedPath: result.path,
            lastRenewalAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(certificates.id, certificate_id));
        await ctx.hub
          .call(serverId, "site.reload", {}, { signal: ctx.signal })
          .catch(() => undefined);
        ctx.events.publish("certificates", "certificate.issued", { certificate_id }, serverId);
        return result;
      } catch (err) {
        await ctx.db
          .update(certificates)
          .set({
            status: "failed",
            lastError: err instanceof Error ? err.message : String(err),
            updatedAt: new Date(),
          })
          .where(eq(certificates.id, certificate_id));
        throw err;
      }
    },
    "cert.renew": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{
        certificate_id: string;
        subject: string;
        force: boolean;
        previous_status?: CertStatus;
      }>(ctx);
      let result: MethodResult<"cert.renew">;
      try {
        const handle = ctx.hub.stream(
          serverId,
          "cert.renew",
          { subject: p.subject, force: p.force },
          (d) => void ctx.log_("info", d.trim()),
          {
            timeoutMs: ctx.job.timeoutMs,
            signal: ctx.signal,
          },
        );
        result = await handle.done;
      } catch (err) {
        // The route marks the row "pending" when it queues the renewal.
        // A renewal that failed leaves the old certificate on disk and
        // still serving, so the row goes back to what it was and keeps
        // the reason — otherwise it reads "pending" forever and the
        // failure never reaches the SSL page or the Command Center. An
        // offline agent is a wait, not a failure (KD-008): the job is
        // re-queued and the row stays pending until it runs.
        if (!(err instanceof AgentOfflineError)) {
          await ctx.db
            .update(certificates)
            .set({
              status: p.previous_status ?? "active",
              lastError: err instanceof Error ? err.message : String(err),
              updatedAt: new Date(),
            })
            .where(eq(certificates.id, p.certificate_id));
        }
        throw err;
      }
      await ctx.db
        .update(certificates)
        .set({
          status: "active",
          expiresAt: new Date(result.not_after),
          lastRenewalAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(certificates.id, p.certificate_id));
      ctx.events.publish(
        "certificates",
        "certificate.renewed",
        { certificate_id: p.certificate_id },
        serverId,
      );
      return result;
    },
    "cert.revoke": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ certificate_id: string; subject: string; reason: string }>(ctx);
      const result = await ctx.hub.call(
        serverId,
        "cert.revoke",
        { subject: p.subject, reason: p.reason },
        { signal: ctx.signal },
      );
      await ctx.db
        .update(certificates)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(eq(certificates.id, p.certificate_id));
      return result;
    },

    /* suspend/resume, cert.install, dns and deployments: see ./websites.ts */
    ...websiteJobHandlers(),

    /* the one-click app installer: see ./apps.ts */
    ...appJobHandlers(),

    /* mail (Yunori Mail Server): see ./mail.ts */
    ...mailJobHandlers(),

    /* databases */
    "db.database.create": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ database_id: string } & MethodParams<"db.database.create">>(ctx);
      const { database_id, ...rest } = p;
      const info = await ctx.hub.call(serverId, "db.database.create", rest, { signal: ctx.signal });
      await ctx.db
        .update(dbDatabases)
        .set({
          sizeBytes: info.size_bytes,
          tableCount: info.table_count,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(dbDatabases.id, database_id));
      return info;
    },
    "db.database.delete": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{
        database_id: string;
        engine: "mysql" | "mariadb" | "postgres";
        name: string;
      }>(ctx);
      const result = await ctx.hub.call(
        serverId,
        "db.database.delete",
        { engine: p.engine, name: p.name },
        { signal: ctx.signal },
      );
      await ctx.db.delete(dbDatabases).where(eq(dbDatabases.id, p.database_id));
      return result;
    },
    "db.user.create": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ db_user_id: string } & MethodParams<"db.user.create">>(ctx);
      const { db_user_id, ...rest } = p;
      const info = await ctx.hub.call(serverId, "db.user.create", rest, { signal: ctx.signal });
      await ctx.db
        .update(dbUsers)
        .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(dbUsers.id, db_user_id));
      return info;
    },
    "db.user.update": passthrough("db.user.update"),
    "db.user.delete": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{
        db_user_id: string;
        engine: "mysql" | "mariadb" | "postgres";
        username: string;
        host_pattern: string;
      }>(ctx);
      const result = await ctx.hub.call(
        serverId,
        "db.user.delete",
        { engine: p.engine, username: p.username, host_pattern: p.host_pattern },
        { signal: ctx.signal },
      );
      await ctx.db.delete(dbUsers).where(eq(dbUsers.id, p.db_user_id));
      return result;
    },
    "db.grant.apply": passthrough("db.grant.apply"),
    "db.dump": async (ctx) => {
      const result = await streaming("db.dump")(ctx);
      // A dump is a backup of that database. Nothing ever wrote
      // last_backup_at, so a database dumped a minute ago still read
      // "never backed up". Only set once the agent says the dump is done.
      if (ctx.job.targetType === "database" && ctx.job.targetId) {
        await ctx.db
          .update(dbDatabases)
          .set({ lastBackupAt: new Date(), updatedAt: new Date() })
          .where(eq(dbDatabases.id, ctx.job.targetId));
        ctx.events.publish(
          "servers",
          "database.updated",
          { database_id: ctx.job.targetId },
          ctx.job.serverId,
        );
      }
      return result;
    },
    "db.restore": streaming("db.restore"),

    /* firewall & security */
    "fw.apply": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<MethodParams<"fw.apply">>(ctx);
      // The host arms its revert timer somewhere inside this call, so the
      // window is dated from before it: the panel then never shows more
      // time than the host will actually wait.
      const calledAt = Date.now();
      const result = await ctx.hub.call(serverId, "fw.apply", p, {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });

      await ctx.db
        .insert(firewallState)
        .values({
          serverId,
          enabled: true,
          defaultInbound: p.default_inbound,
          defaultOutbound: p.default_outbound,
          lastAppliedAt: new Date(),
          pendingRollbackToken: result.rollback_token,
          pendingRollbackUntil: result.rollback_token
            ? new Date(calledAt + p.rollback_seconds * 1000)
            : null,
        })
        .onConflictDoUpdate({
          target: firewallState.serverId,
          set: {
            enabled: true,
            defaultInbound: p.default_inbound,
            defaultOutbound: p.default_outbound,
            lastAppliedAt: new Date(),
            pendingRollbackToken: result.rollback_token,
            pendingRollbackUntil: result.rollback_token
              ? new Date(calledAt + p.rollback_seconds * 1000)
              : null,
            updatedAt: new Date(),
          },
        });

      if (result.rollback_token) {
        await ctx.log_(
          "warn",
          `Rules applied with a ${p.rollback_seconds}s rollback window. Confirm from the panel or they revert automatically.`,
        );
      }
      return result;
    },
    // The disposition of the threat rows a ban touches follows the job's
    // outcome, so these two live with that bookkeeping in ./threats.ts.
    "fw.ban": banHandler,
    "fw.unban": unbanHandler,
    "ssh.keys.apply": passthrough("ssh.keys.apply"),
    "ssh.config.apply": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<MethodParams<"ssh.config.apply">>(ctx);
      // Dated from before the call, as for fw.apply.
      const calledAt = Date.now();
      const result = await ctx.hub.call(serverId, "ssh.config.apply", p, {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });
      // The cache is what the panel shows as "applied state"; leaving it on
      // the old values made a successful apply look like it did nothing.
      await ctx.db
        .update(sshConfigs)
        .set({
          ...(p.port !== undefined ? { port: p.port } : {}),
          ...(p.permit_root_login !== undefined ? { permitRootLogin: p.permit_root_login } : {}),
          ...(p.password_authentication !== undefined
            ? { passwordAuthentication: p.password_authentication }
            : {}),
          ...(p.pubkey_authentication !== undefined
            ? { pubkeyAuthentication: p.pubkey_authentication }
            : {}),
          ...(p.max_auth_tries !== undefined ? { maxAuthTries: p.max_auth_tries } : {}),
          // An empty list is "clear the directive" on the host now, so the
          // cache follows it; only an omitted list leaves the value alone.
          ...(p.allow_users !== undefined ? { allowUsers: p.allow_users } : {}),
          ...(p.allow_groups !== undefined ? { allowGroups: p.allow_groups } : {}),
          ...(p.x11_forwarding !== undefined ? { x11Forwarding: p.x11_forwarding } : {}),
          lastAppliedAt: new Date(),
          pendingRollbackToken: result.rollback_token,
          pendingRollbackUntil: result.rollback_token
            ? new Date(calledAt + (p.rollback_seconds ?? 60) * 1000)
            : null,
          updatedAt: new Date(),
        })
        .where(eq(sshConfigs.serverId, serverId));
      return result;
    },

    /* backups */
    "backup.run": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ run_id: string } & MethodParams<"backup.run">>(ctx);
      const { run_id, ...rest } = p;

      await ctx.db
        .update(backupRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(backupRuns.id, run_id));

      // The schedule's own last-run status is what the Schedules tab and
      // its filter read. It was set to "queued" by the route and never
      // touched again, so every manual run looked queued forever.
      const [runRow] = await ctx.db
        .select({ scheduleId: backupRuns.scheduleId })
        .from(backupRuns)
        .where(eq(backupRuns.id, run_id))
        .limit(1);
      const scheduleId = runRow?.scheduleId ?? null;
      const [schedule] = scheduleId
        ? await ctx.db
            .select()
            .from(backupSchedules)
            .where(eq(backupSchedules.id, scheduleId))
            .limit(1)
        : [];
      const settleSchedule = async (status: "queued" | "running" | "succeeded" | "failed") => {
        if (!scheduleId) return;
        await ctx.db
          .update(backupSchedules)
          .set({ lastRunStatus: status, updatedAt: new Date() })
          .where(eq(backupSchedules.id, scheduleId));
      };
      await settleSchedule("running");

      let snapshot: MethodResult<"backup.run">;
      try {
        const handle = ctx.hub.stream(
          serverId,
          "backup.run",
          rest,
          (d) => void ctx.log_("info", d.trim()),
          {
            timeoutMs: ctx.job.timeoutMs,
            signal: ctx.signal,
          },
        );
        snapshot = await handle.done;
      } catch (err) {
        // The run row mirrors the job: an unreachable host is a wait, so
        // the run goes back to queued with the job; anything else is a
        // failure the backups page and the notifier both need to see —
        // left as "running" it would sit there forever.
        if (err instanceof AgentOfflineError) {
          await ctx.db
            .update(backupRuns)
            .set({ status: "queued", startedAt: null })
            .where(eq(backupRuns.id, run_id));
          await settleSchedule("queued");
          throw err;
        }
        const message =
          err instanceof AgentRpcError
            ? err.agentError.message
            : err instanceof Error
              ? err.message
              : String(err);
        await ctx.db
          .update(backupRuns)
          .set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() })
          .where(eq(backupRuns.id, run_id));
        await settleSchedule("failed");
        ctx.events.publish(
          "backups",
          "backup.failed",
          { run_id, server_id: serverId, error: message },
          serverId,
        );
        throw err;
      }

      const [point] = await ctx.db
        .insert(restorePoints)
        .values({
          runId: run_id,
          // Without the schedule a restore point cannot be read back: the
          // repository and its password live on the schedule, so restore
          // and verify refused every snapshot a run had ever produced.
          scheduleId,
          scope: (schedule?.scope ?? []) as { kind: string; selectors: string[] }[],
          serverId,
          label: snapshot.id.slice(0, 8),
          snapshotId: snapshot.id,
          takenAt: new Date(snapshot.taken_at),
          bytes: snapshot.bytes,
          fileCount: snapshot.file_count,
        })
        .returning({ id: restorePoints.id });

      await ctx.db
        .update(backupRuns)
        .set({
          status: "succeeded",
          bytes: snapshot.bytes,
          files: snapshot.file_count,
          finishedAt: new Date(),
          restorePointId: point?.id ?? null,
        })
        .where(eq(backupRuns.id, run_id));

      await settleSchedule("succeeded");

      // A database dumped into this snapshot is as backed up as one dumped
      // by hand; without this a nightly-backed-up database read "never".
      for (const database of rest.databases ?? []) {
        await ctx.db
          .update(dbDatabases)
          .set({ lastBackupAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(dbDatabases.serverId, serverId),
              eq(dbDatabases.engine, database.engine as "mysql" | "mariadb" | "postgres"),
              eq(dbDatabases.name, database.name),
            ),
          );
      }

      ctx.events.publish(
        "backups",
        "backup.succeeded",
        { run_id, snapshot_id: snapshot.id },
        serverId,
      );

      // Retention was stored on every schedule and shown on every form,
      // but nothing ever applied it: the repository only grew. It is
      // applied after each successful run, as `restic forget --prune`
      // would be, and the restore points whose snapshots the repository
      // no longer holds are removed so the panel never offers one.
      if (schedule) {
        const retention = schedule.retention as {
          keep_last: number;
          keep_daily: number;
          keep_weekly: number;
          keep_monthly: number;
        };
        const prune = ctx.hub.stream(
          serverId,
          "backup.prune",
          {
            repository: rest.repository,
            password_ref: rest.password_ref,
            keep_last: retention.keep_last,
            keep_daily: retention.keep_daily,
            keep_weekly: retention.keep_weekly,
            keep_monthly: retention.keep_monthly,
          },
          (d) => void ctx.log_("info", d.trim()),
          { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
        );
        const pruned = await prune.done;
        const listed = await ctx.hub.call(
          serverId,
          "backup.list",
          { repository: rest.repository, password_ref: rest.password_ref },
          { signal: ctx.signal },
        );
        const kept = listed.snapshots.map((entry) => entry.id);
        const gone = await ctx.db
          .delete(restorePoints)
          .where(
            and(
              eq(restorePoints.scheduleId, schedule.id),
              eq(restorePoints.serverId, serverId),
              kept.length > 0 ? notInArray(restorePoints.snapshotId, kept) : undefined,
            ),
          )
          .returning({ id: restorePoints.id });
        await ctx.log_(
          "info",
          `retention removed ${pruned.removed} snapshot(s) from the repository and ${gone.length} restore point(s) from Kaname`,
        );
      }
      return snapshot;
    },
    "backup.restore": streaming("backup.restore"),
    "backup.verify": async (ctx) => {
      const result = (await streaming("backup.verify")(ctx)) as MethodResult<"backup.verify">;
      // A verify that found damage answers ok: false rather than an RPC
      // error. Filed as a success it read as a clean bill of health; and a
      // clean one was never written down, so every point stayed unverified.
      if (!result.ok) {
        throw new Error(
          `Snapshot verification found problems: ${result.errors.join("; ") || "unspecified"}`,
        );
      }
      if (ctx.job.targetId) {
        await ctx.db
          .update(restorePoints)
          .set({ verifiedAt: new Date(), updatedAt: new Date() })
          .where(eq(restorePoints.id, ctx.job.targetId));
      }
      return result;
    },
    "backup.prune": streaming("backup.prune"),

    /* lifecycle */
    "agent.update": agentUpdate,
  };

  worker.registerAll(handlers);
}
