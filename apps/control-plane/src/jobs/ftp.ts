import { eq } from "@kaname/db";
import { ftpAccounts, secrets } from "@kaname/db/schema";
import type { JobType, MethodResult } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { open } from "../lib/crypto.js";
import type { JobContext, JobHandler } from "./worker.js";

/* ------------------------------------------------------------------ *
 * FTP / SFTP job handlers.
 *
 * Each job is one `ftp.account.*` RPC: the agent creates, re-points,
 * re-passwords or removes the POSIX user and the daemon config behind
 * it. These used to be panel-only — create made a directory and every
 * other job "succeeded" without touching the host.
 *
 * The password never rides in job params, which are persisted, backed
 * up and shown in the job drawer. A job carries only the `secrets` ref;
 * the handler unseals it at the moment of the call, hands it to the
 * agent (which gives it to chpasswd on stdin) and then deletes the
 * sealed copy, because once the host holds the credential the panel has
 * no further use for it. The job result is the agent's account summary,
 * which has no credential in it.
 * ------------------------------------------------------------------ */

type Protocol = "sftp" | "ftps";
type Status = "active" | "suspended" | "provisioning" | "error";

interface AccountShape {
  username: string;
  home_dir: string;
  protocol: Protocol;
  quota_bytes: number;
  ssh_public_key?: string;
}

interface CreateParams extends AccountShape {
  ftp_account_id: string;
  secret_ref: string;
}

interface UpdateParams extends AccountShape {
  ftp_account_id: string;
  status: Status;
  /** What the row said before the route applied the edit, for the rollback. */
  previous?: { protocol: Protocol; home_dir: string; quota_bytes: number; status: Status };
}

interface ResetParams {
  ftp_account_id: string;
  username: string;
  secret_ref: string;
}

interface DeleteParams {
  ftp_account_id: string;
  username: string;
}

function serverOf(ctx: JobContext): string {
  if (!ctx.job.serverId) throw new Error(`${ctx.job.type} requires a server`);
  return ctx.job.serverId;
}

function paramsOf<T>(ctx: JobContext): T {
  return ctx.job.params as T;
}

/** Unseals a transfer password. A missing ref is a job that cannot run. */
async function unseal(ctx: JobContext, ref: string): Promise<string> {
  const rows = await ctx.db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      "The password for this account is no longer held by the panel. Reset the password to set a new one.",
    );
  }
  return open(
    {
      wrappedKey: row.wrappedKey,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
    },
    ctx.config.masterKey,
  );
}

/** The host has it now; the sealed copy only widens what a leak would hold. */
async function forgetSecret(ctx: JobContext, accountId: string, ref: string): Promise<void> {
  await ctx.db.delete(secrets).where(eq(secrets.ref, ref));
  await ctx.db
    .update(ftpAccounts)
    .set({ secretRef: null, updatedAt: new Date() })
    .where(eq(ftpAccounts.id, accountId));
}

function shape(p: AccountShape): AccountShape {
  return {
    username: p.username,
    home_dir: p.home_dir,
    protocol: p.protocol,
    quota_bytes: p.quota_bytes,
    ...(p.ssh_public_key ? { ssh_public_key: p.ssh_public_key } : {}),
  };
}

const offline = (err: unknown) => err instanceof AgentOfflineError;

export function ftpJobHandlers(): Partial<Record<JobType, JobHandler>> {
  return {
    "ftp.create": async (ctx) => {
      const serverId = serverOf(ctx);
      const p = paramsOf<CreateParams>(ctx);
      let info: MethodResult<"ftp.account.create">;
      try {
        const password = await unseal(ctx, p.secret_ref);
        info = await ctx.hub.call(
          serverId,
          "ftp.account.create",
          { ...shape(p), password },
          { signal: ctx.signal },
        );
      } catch (err) {
        // The row was written as "provisioning" before the job ran and
        // nothing else ever moves it, so a refusal must say "error" or the
        // account sits provisioning for ever. An offline agent is a wait,
        // not a failure (KD-008).
        if (!offline(err)) {
          await ctx.db
            .update(ftpAccounts)
            .set({ status: "error", updatedAt: new Date() })
            .where(eq(ftpAccounts.id, p.ftp_account_id));
        }
        throw err;
      }
      await ctx.db
        .update(ftpAccounts)
        .set({ status: "active", lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(ftpAccounts.id, p.ftp_account_id));
      await forgetSecret(ctx, p.ftp_account_id, p.secret_ref);
      await ctx.log_(
        "info",
        `${info.username} (uid ${info.uid}) created for ${info.protocol.toUpperCase()}, quota ${describeQuota(info)}`,
      );
      return info;
    },

    "ftp.update": async (ctx) => {
      const serverId = serverOf(ctx);
      const p = paramsOf<UpdateParams>(ctx);
      try {
        const info = await ctx.hub.call(
          serverId,
          "ftp.account.update",
          { ...shape(p), suspended: p.status === "suspended" },
          { signal: ctx.signal },
        );
        await ctx.db
          .update(ftpAccounts)
          .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
          .where(eq(ftpAccounts.id, p.ftp_account_id));
        await ctx.log_(
          "info",
          `${info.username} now ${info.protocol.toUpperCase()}${info.suspended ? ", suspended" : ""}, quota ${describeQuota(info)}`,
        );
        return info;
      } catch (err) {
        // The route writes the edit to the row before the job runs. When
        // the host refuses it (a quota on a filesystem without user
        // quotas, FTPS on a host without vsftpd) the row would otherwise
        // claim a protocol or a limit the host never applied.
        if (!offline(err) && err instanceof AgentRpcError && p.previous) {
          await ctx.db
            .update(ftpAccounts)
            .set({
              protocol: p.previous.protocol,
              homeDir: p.previous.home_dir,
              quotaBytes: p.previous.quota_bytes,
              status: p.previous.status,
              updatedAt: new Date(),
            })
            .where(eq(ftpAccounts.id, p.ftp_account_id));
        }
        throw err;
      }
    },

    "ftp.reset_password": async (ctx) => {
      const serverId = serverOf(ctx);
      const p = paramsOf<ResetParams>(ctx);
      const password = await unseal(ctx, p.secret_ref);
      await ctx.hub.call(
        serverId,
        "ftp.account.passwd",
        { username: p.username, password },
        { signal: ctx.signal },
      );
      await forgetSecret(ctx, p.ftp_account_id, p.secret_ref);
      await ctx.db
        .update(ftpAccounts)
        .set({ lastSyncedAt: new Date() })
        .where(eq(ftpAccounts.id, p.ftp_account_id));
      return { ok: true, username: p.username };
    },

    "ftp.delete": async (ctx) => {
      const serverId = serverOf(ctx);
      const p = paramsOf<DeleteParams>(ctx);
      try {
        await ctx.hub.call(
          serverId,
          "ftp.account.delete",
          { username: p.username },
          { signal: ctx.signal },
        );
      } catch (err) {
        // "No such user" is the state a delete is after. It is what an
        // account created before transfer accounts were real looks like,
        // and refusing to forget its row would strand it in the list.
        // "conflict" is the agent declining to touch a user Kaname did not
        // create (a row whose create was refused for exactly that reason):
        // that user is not the panel's to remove, but the row is.
        const code = err instanceof AgentRpcError ? err.agentError.code : null;
        if (code !== "not_found" && code !== "conflict") throw err;
        await ctx.log_(
          "warn",
          code === "not_found"
            ? `${p.username} was not on the host; removing the panel record only`
            : `${p.username} on the host is not a Kaname transfer account and was left alone; removing the panel record only`,
        );
      }
      await ctx.db.delete(ftpAccounts).where(eq(ftpAccounts.id, p.ftp_account_id));
      return { ok: true, username: p.username };
    },
  };
}

function describeQuota(info: MethodResult<"ftp.account.create">): string {
  if (info.quota !== "applied") return "unlimited";
  const gib = info.quota_bytes / 1024 ** 3;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(2)} GiB on ${info.quota_mount ?? "its mount"}`;
}
