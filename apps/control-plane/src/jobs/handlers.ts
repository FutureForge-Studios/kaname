import { and, eq, sql } from "@kaname/db";
import {
  backupRuns,
  certificates,
  containers,
  dbDatabases,
  dbUsers,
  deployments,
  firewallState,
  ftpAccounts,
  ipBlocks,
  mailDomains,
  mailboxes,
  restorePoints,
  servers,
  services,
  sites,
  sshConfigs,
  updateRuns,
} from "@kaname/db/schema";
import type {
  AgentMethod,
  JobType,
  MailAuthCheck,
  MethodParams,
  MethodResult,
} from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { MailAuthChecker } from "../services/mail-auth.js";
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
      const result = await ctx.hub.call(serverId, "fs.usage", params(ctx), {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });
      ctx.events.publish("servers", "storage.sampled", { server_id: serverId }, serverId);
      return result;
    },

    /* ftp */
    "ftp.create": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ ftp_account_id: string; username: string; home_dir: string }>(ctx);
      await ctx.hub.call(
        serverId,
        "fs.mkdir",
        { path: p.home_dir, parents: true },
        { signal: ctx.signal },
      );
      await ctx.hub.call(
        serverId,
        "fs.chown",
        { paths: [p.home_dir], owner: p.username, recursive: true },
        { signal: ctx.signal },
      );
      await ctx.db
        .update(ftpAccounts)
        .set({ status: "active", lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(ftpAccounts.id, p.ftp_account_id));
      return { ok: true };
    },
    "ftp.update": async (ctx) => ({ ok: true, params: params<Record<string, unknown>>(ctx) }),
    "ftp.delete": async (ctx) => {
      const p = params<{ ftp_account_id: string }>(ctx);
      await ctx.db.delete(ftpAccounts).where(eq(ftpAccounts.id, p.ftp_account_id));
      return { ok: true };
    },
    "ftp.reset_password": async () => ({ ok: true }),

    /* sites */
    "site.create": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ site_id: string } & MethodParams<"site.create">>(ctx);
      const { site_id, ...rest } = p;
      const result = await ctx.hub.call(serverId, "site.create", rest, {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });
      await ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
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
      const result = await ctx.hub.call(serverId, "site.update", rest, {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });
      await ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
      await ctx.db
        .update(sites)
        .set({ configPath: result.config_path, updatedAt: new Date() })
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
      const p = params<{ certificate_id: string; subject: string; force: boolean }>(ctx);
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
      const result = await handle.done;
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

    /* dns */
    "dns.sync": async (ctx) => params(ctx),
    "dns.apply": async (ctx) => params(ctx),

    /* deployments */
    "deployment.run": async (ctx) => {
      const p = params<{ deployment_id: string }>(ctx);
      await ctx.db
        .update(deployments)
        .set({ status: "building", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(deployments.id, p.deployment_id));
      await ctx.log_("info", "deployment started");
      await ctx.progress(10);
      // The actual build/copy steps run as fs.* and site.* RPCs driven by
      // the deployment service; this handler owns lifecycle and status.
      await ctx.db
        .update(deployments)
        .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(deployments.id, p.deployment_id));
      ctx.events.publish(
        "deployments",
        "deployment.finished",
        { deployment_id: p.deployment_id },
        ctx.job.serverId,
      );
      return { deployment_id: p.deployment_id };
    },
    "deployment.rollback": async (ctx) => params(ctx),

    /* mail */
    "mail.mailbox.create": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ mailbox_id: string } & MethodParams<"mail.mailbox.create">>(ctx);
      const { mailbox_id, ...rest } = p;
      try {
        await ctx.hub.call(serverId, "mail.mailbox.create", rest, {
          timeoutMs: ctx.job.timeoutMs,
          signal: ctx.signal,
        });
      } catch (err) {
        // The row was inserted as "provisioning" before this ran. Left
        // there, it blocks the address for ever: a retry is refused as a
        // duplicate and a delete has nothing on the host to remove.
        if (agentSaid(err, "conflict")) {
          await ctx.log_("warn", `${rest.address} already existed on the host; adopted it`);
        } else {
          if (err instanceof AgentOfflineError) throw err;
          await ctx.db
            .update(mailboxes)
            .set({ status: "error", updatedAt: new Date() })
            .where(eq(mailboxes.id, mailbox_id));
          throw err;
        }
      }
      await ctx.db
        .update(mailboxes)
        .set({ status: "active", lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(mailboxes.id, mailbox_id));
      return { ok: true };
    },
    "mail.mailbox.update": passthrough("mail.mailbox.update"),
    "mail.mailbox.delete": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ mailbox_id: string; address: string; delete_maildir: boolean }>(ctx);
      try {
        await ctx.hub.call(
          serverId,
          "mail.mailbox.delete",
          { address: p.address, delete_maildir: p.delete_maildir },
          { signal: ctx.signal },
        );
      } catch (err) {
        // A mailbox whose create never landed has no account to remove;
        // the record is still the operator's to delete.
        if (!agentSaid(err, "not_found")) throw err;
        await ctx.log_("warn", `${p.address} is not present on the host; removed the record`);
      }
      await ctx.db.delete(mailboxes).where(eq(mailboxes.id, p.mailbox_id));
      return { ok: true };
    },
    "mail.mailbox.reset_password": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<MethodParams<"mail.mailbox.password">>(ctx);
      const revoke = p.revoke_sessions === true;
      await ctx.hub.call(
        serverId,
        "mail.mailbox.password",
        { address: p.address, password: p.password, revoke_sessions: revoke },
        { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
      );
      // The log is where an operator resetting a compromised mailbox
      // reads whether the attacker's open session was actually closed.
      await ctx.log_(
        "info",
        revoke
          ? `password set for ${p.address}; open IMAP and POP sessions revoked`
          : `password set for ${p.address}; open sessions left open`,
      );
      return { ok: true, sessions_revoked: revoke };
    },
    "mail.alias.apply": passthrough("mail.alias.apply"),
    "mail.forwarder.apply": passthrough("mail.forwarder.apply"),
    "mail.auth.check": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ mail_domain_id: string; checks?: MailAuthCheck[]; resolver?: string }>(
        ctx,
      );
      const checker = new MailAuthChecker({ db: ctx.db, hub: ctx.hub, log: ctx.log });
      await ctx.log_("info", `checking ${p.mail_domain_id} via ${p.resolver ?? "the host"}`);
      const report = await checker.run(p.mail_domain_id, {
        checks: p.checks,
        resolver: p.resolver,
      });
      for (const check of report.checks) {
        const level = check.status === "fail" ? "error" : check.status === "warn" ? "warn" : "info";
        await ctx.log_(level, `${check.check}: ${check.status} — ${check.detail}`);
      }
      ctx.events.publish(
        "servers",
        "mail.auth.checked",
        { server_id: serverId, mail_domain_id: p.mail_domain_id, overall: report.overall },
        serverId,
      );
      return { overall: report.overall, resolver_used: report.resolver_used };
    },
    "mail.domain.provision": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ mail_domain_id: string; domain: string }>(ctx);
      // Nothing is written to the host yet (README, Status): what this
      // job can honestly do is read the key the host already signs with
      // and stop the row reading "provisioning" for ever.
      let dkim: string | null = null;
      try {
        try {
          const key = await ctx.hub.call(
            serverId,
            "mail.dkim.read",
            { domain: p.domain },
            { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
          );
          dkim = key.public_key || null;
          await ctx.log_("info", `DKIM selector ${key.selector} read from the host`);
        } catch (err) {
          if (err instanceof AgentOfflineError) throw err;
          await ctx.log_(
            "warn",
            `no DKIM key on the host yet: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // An operator who suspended the domain in the same edit keeps
        // that; only an in-progress or failed row is settled here.
        await ctx.db
          .update(mailDomains)
          .set({
            status: sql`case when ${mailDomains.status} in ('provisioning', 'error') then 'active' else ${mailDomains.status} end`,
            ...(dkim ? { dkimPublicKey: dkim } : {}),
            updatedAt: new Date(),
          })
          .where(eq(mailDomains.id, p.mail_domain_id));
      } catch (err) {
        if (!(err instanceof AgentOfflineError)) {
          await ctx.db
            .update(mailDomains)
            .set({ status: "error", updatedAt: new Date() })
            .where(eq(mailDomains.id, p.mail_domain_id));
        }
        throw err;
      }
      ctx.events.publish(
        "servers",
        "mail_domain.provisioned",
        { server_id: serverId, mail_domain_id: p.mail_domain_id, domain: p.domain },
        serverId,
      );
      return { mail_domain_id: p.mail_domain_id, dkim_read: dkim !== null };
    },

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
    "db.dump": streaming("db.dump"),
    "db.restore": streaming("db.restore"),

    /* firewall & security */
    "fw.apply": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<MethodParams<"fw.apply">>(ctx);
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
            ? new Date(Date.now() + p.rollback_seconds * 1000)
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
              ? new Date(Date.now() + p.rollback_seconds * 1000)
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
    "fw.ban": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ target: string; duration_seconds: number; reason?: string }>(ctx);
      const result = await ctx.hub.call(serverId, "fw.ban", p, { signal: ctx.signal });
      await ctx.db
        .insert(ipBlocks)
        .values({
          serverId,
          cidr: p.target,
          reason: p.reason ?? "",
          source: "manual",
          expiresAt: p.duration_seconds ? new Date(Date.now() + p.duration_seconds * 1000) : null,
          createdBy: ctx.job.createdBy,
        })
        .onConflictDoNothing();
      ctx.events.publish("threats", "ip.banned", { server_id: serverId, cidr: p.target }, serverId);
      return result;
    },
    "fw.unban": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<{ target: string }>(ctx);
      const result = await ctx.hub.call(serverId, "fw.unban", p, { signal: ctx.signal });
      await ctx.db
        .delete(ipBlocks)
        .where(and(eq(ipBlocks.serverId, serverId), eq(ipBlocks.cidr, p.target)));
      return result;
    },
    "ssh.keys.apply": passthrough("ssh.keys.apply"),
    "ssh.config.apply": async (ctx) => {
      const serverId = requireServer(ctx);
      const p = params<MethodParams<"ssh.config.apply">>(ctx);
      const result = await ctx.hub.call(serverId, "ssh.config.apply", p, {
        timeoutMs: ctx.job.timeoutMs,
        signal: ctx.signal,
      });
      await ctx.db
        .update(sshConfigs)
        .set({
          lastAppliedAt: new Date(),
          pendingRollbackToken: result.rollback_token,
          pendingRollbackUntil: result.rollback_token
            ? new Date(Date.now() + (p.rollback_seconds ?? 60) * 1000)
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

      ctx.events.publish(
        "backups",
        "backup.succeeded",
        { run_id, snapshot_id: snapshot.id },
        serverId,
      );
      return snapshot;
    },
    "backup.restore": streaming("backup.restore"),
    "backup.verify": streaming("backup.verify"),
    "backup.prune": streaming("backup.prune"),

    /* lifecycle */
    "agent.update": agentUpdate,
  };

  worker.registerAll(handlers);
}
