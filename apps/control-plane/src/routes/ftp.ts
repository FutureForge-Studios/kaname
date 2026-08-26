import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "@kaname/db";
import { ftpAccounts, secrets, servers, sshKeys } from "@kaname/db/schema";
import {
  createFtpAccountInput,
  ftpAccountListQuery,
  idParam,
  listQuery,
  resetFtpPasswordInput,
  updateFtpAccountInput,
  type FtpAccount,
  type FtpSession,
  type Permission,
} from "@kaname/contract";
import type { MethodResult } from "@kaname/contract/agent";
import {
  accepted,
  helpers,
  item,
  list,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import {
  ApiException,
  agentOffline,
  badRequest,
  conflict,
  fromAgentError,
  notFound,
} from "../lib/errors.js";
import { seal } from "../lib/crypto.js";
import {
  combine,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  type ServerRow,
} from "./_shared.js";

/* ------------------------------------------------------------------ *
 * FTP / SFTP accounts.
 *
 * The account row is control-plane state, but a transfer account only
 * exists once the host has the POSIX user, the home directory and the
 * credential — so every write here lands as a job. The password itself
 * never sits in a column: it is envelope-encrypted into `secrets` and
 * the job carries only the ref.
 * ------------------------------------------------------------------ */

const LIVE_TIMEOUT_MS = 15_000;

const SORTABLE = {
  username: ftpAccounts.username,
  home_dir: ftpAccounts.homeDir,
  protocol: ftpAccounts.protocol,
  status: ftpAccounts.status,
  quota_bytes: ftpAccounts.quotaBytes,
  used_bytes: ftpAccounts.usedBytes,
  last_login_at: ftpAccounts.lastLoginAt,
  created_at: ftpAccounts.createdAt,
} as const;

const SSH_KEY_TYPES = new Set([
  "ssh-rsa",
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);

export async function ftpRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/ftp-accounts", async (req, reply) => {
    const q = parseQuery(req, ftpAccountListQuery);
    helpers(req).authorize("files.ftp:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "files.ftp:read", ftpAccounts.serverId),
      q.server_id ? eq(ftpAccounts.serverId, q.server_id) : null,
      q.protocol ? eq(ftpAccounts.protocol, q.protocol) : null,
      q.status ? eq(ftpAccounts.status, q.status) : null,
      q.over_quota
        ? sql`${ftpAccounts.quotaBytes} > 0 and ${ftpAccounts.usedBytes} >= ${ftpAccounts.quotaBytes}`
        : null,
      term
        ? sql`(lower(${ftpAccounts.username}) like ${term} or lower(${ftpAccounts.homeDir}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "username");
    const rows = await req.ctx.db
      .select({ account: ftpAccounts, server: servers, fingerprint: sshKeys.fingerprint })
      .from(ftpAccounts)
      .innerJoin(servers, eq(ftpAccounts.serverId, servers.id))
      .leftJoin(sshKeys, eq(ftpAccounts.sshKeyId, sshKeys.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(ftpAccounts)
      .where(where);

    return list(reply, rows.map(toApi), paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/ftp-accounts/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadAccount(req, id, "files.ftp:read");
    return item(reply, toApi(row));
  });

  /* ----------------------------- create ----------------------------- */

  app.post("/ftp-accounts", async (req, reply) => {
    const body = parseBody(req, createFtpAccountInput);
    const server = await loadServer(req, body.server_id, "files.ftp:write");

    const existing = await req.ctx.db
      .select({ id: ftpAccounts.id })
      .from(ftpAccounts)
      .where(and(eq(ftpAccounts.serverId, server.id), eq(ftpAccounts.username, body.username)))
      .limit(1);
    if (existing[0]) {
      throw conflict(`${server.name} already has an account named "${body.username}".`, {
        summary:
          "A transfer username maps to a POSIX user on the host, so it has to be unique per server. Reset the existing account's password instead of creating a second one.",
        actions: [{ label: "Open account", href: `/files/ftp/${existing[0].id}` }],
      });
    }

    const key = body.ssh_public_key
      ? await linkSshKey(req, server, body.username, body.ssh_public_key)
      : null;

    const [account] = await req.ctx.db
      .insert(ftpAccounts)
      .values({
        serverId: server.id,
        username: body.username,
        protocol: body.protocol,
        homeDir: body.home_dir,
        quotaBytes: body.quota_bytes,
        sshKeyId: key?.id ?? null,
        status: "provisioning",
      })
      .returning();

    const secretRef = `ftp/${account!.id}`;
    await storeSecret(req, secretRef, "ftp_account", account!.id, body.password);
    await req.ctx.db
      .update(ftpAccounts)
      .set({ secretRef, updatedAt: new Date() })
      .where(eq(ftpAccounts.id, account!.id));

    const job = await enqueueServerJob(req, {
      type: "ftp.create",
      server,
      targetType: "ftp_account",
      targetId: account!.id,
      targetLabel: body.username,
      params: {
        ftp_account_id: account!.id,
        username: body.username,
        home_dir: body.home_dir,
        protocol: body.protocol,
        quota_bytes: body.quota_bytes,
        secret_ref: secretRef,
        ...(body.ssh_public_key ? { ssh_public_key: body.ssh_public_key } : {}),
      },
    });

    req.ctx.events.publish(
      "servers",
      "ftp_account.created",
      {
        server_id: server.id,
        ftp_account_id: account!.id,
        username: body.username,
        fingerprint: key?.fingerprint ?? null,
      },
      server.id,
    );
    return accepted(reply, job);
  });

  /* ----------------------------- update ----------------------------- */

  app.patch("/ftp-accounts/:id", async (req, reply) => {
    const body = parseBody(req, updateFtpAccountInput);
    const { id } = parseParams(req, idParam);
    const before = await loadAccount(req, id, "files.ftp:write");
    const h = helpers(req);

    let sshKeyId = before.account.sshKeyId;
    if (body.ssh_public_key) {
      const key = await linkSshKey(
        req,
        before.server,
        before.account.username,
        body.ssh_public_key,
      );
      sshKeyId = key.id;
    }

    const [account] = await req.ctx.db
      .update(ftpAccounts)
      .set({
        ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
        ...(body.home_dir !== undefined ? { homeDir: body.home_dir } : {}),
        ...(body.quota_bytes !== undefined ? { quotaBytes: body.quota_bytes } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        sshKeyId,
        updatedAt: new Date(),
      })
      .where(eq(ftpAccounts.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "ftp.updated",
      targetType: "ftp_account",
      targetId: id,
      targetLabel: before.account.username,
      serverId: before.server.id,
      before: {
        protocol: before.account.protocol,
        home_dir: before.account.homeDir,
        quota_bytes: before.account.quotaBytes,
        status: before.account.status,
      },
      after: body,
    });

    const job = await enqueueServerJob(req, {
      type: "ftp.update",
      server: before.server,
      targetType: "ftp_account",
      targetId: id,
      targetLabel: before.account.username,
      params: {
        ftp_account_id: id,
        username: account!.username,
        home_dir: account!.homeDir,
        protocol: account!.protocol,
        quota_bytes: account!.quotaBytes,
        status: account!.status,
        ...(body.ssh_public_key ? { ssh_public_key: body.ssh_public_key } : {}),
      },
    });
    return accepted(reply, job);
  });

  /* ----------------------------- delete ----------------------------- */

  app.delete("/ftp-accounts/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadAccount(req, id, "files.ftp:delete");

    // The credential dies with the operator's decision, not with the
    // job: removing the POSIX user needs the username, never the
    // password. The account row itself is deleted by the job handler so
    // it stays visible, in `provisioning`, until the host agrees.
    if (row.account.secretRef) {
      await req.ctx.db.delete(secrets).where(eq(secrets.ref, row.account.secretRef));
    }

    const job = await enqueueServerJob(req, {
      type: "ftp.delete",
      server: row.server,
      targetType: "ftp_account",
      targetId: id,
      targetLabel: row.account.username,
      params: {
        ftp_account_id: id,
        username: row.account.username,
        home_dir: row.account.homeDir,
      },
    });

    req.ctx.events.publish(
      "servers",
      "ftp_account.deleting",
      { server_id: row.server.id, ftp_account_id: id, username: row.account.username },
      row.server.id,
    );
    return accepted(reply, job);
  });

  /* ------------------------- reset password ------------------------- */

  app.post("/ftp-accounts/:id/reset-password", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, resetFtpPasswordInput);
    const row = await loadAccount(req, id, "files.ftp:write");

    const secretRef = row.account.secretRef ?? `ftp/${id}`;
    await storeSecret(req, secretRef, "ftp_account", id, body.password);
    if (!row.account.secretRef) {
      await req.ctx.db
        .update(ftpAccounts)
        .set({ secretRef, updatedAt: new Date() })
        .where(eq(ftpAccounts.id, id));
    }

    const job = await enqueueServerJob(req, {
      type: "ftp.reset_password",
      server: row.server,
      targetType: "ftp_account",
      targetId: id,
      targetLabel: row.account.username,
      params: { ftp_account_id: id, username: row.account.username, secret_ref: secretRef },
    });
    return accepted(reply, job);
  });

  /* ---------------------------- sessions ---------------------------- */

  app.get("/ftp-accounts/:id/sessions", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, listQuery);
    const row = await loadAccount(req, id, "files.ftp:read");
    const server = await loadConnectedServer(req, row.account.serverId, "files.ftp:read");

    if (row.account.protocol !== "sftp") {
      throw new ApiException(
        "agent_unsupported",
        `Kaname cannot enumerate live FTPS sessions on ${server.name}.`,
        {
          remediation: {
            summary:
              "An SFTP session is an sshd session, which the host reports; an FTPS daemon keeps its own session table that the agent has no verb for. Read the transfer log instead, or move the account to SFTP.",
            actions: [
              { label: "Open logs", href: `/logs?server_id=${server.id}` },
              { label: "Switch to SFTP", action: "ftp.switch_protocol" },
            ],
          },
        },
      );
    }

    let liveSessions: MethodResult<"ssh.sessions.list">;
    try {
      liveSessions = await req.ctx.hub.call(
        server.id,
        "ssh.sessions.list",
        {},
        {
          timeoutMs: LIVE_TIMEOUT_MS,
        },
      );
    } catch (err) {
      if (err instanceof AgentOfflineError) throw agentOffline(server.name, server.lastSeenAt);
      if (err instanceof AgentRpcError) throw fromAgentError(server.name, err.agentError);
      throw err;
    }

    const sessions: FtpSession[] = liveSessions.sessions
      .filter((s) => s.user === row.account.username)
      .map((s) => ({
        server_id: server.id,
        username: row.account.username,
        from_ip: s.from_ip,
        protocol: row.account.protocol,
        started_at: new Date(s.started_at).toISOString(),
        // sshd keeps no per-session transfer counter and no cwd, so
        // these are reported as unknown rather than invented.
        bytes_transferred: 0,
        current_path: null,
      }));

    const start = offset(q.page, q.per_page);
    return list(
      reply,
      sessions.slice(start, start + q.per_page),
      paginate(sessions.length, q.page, q.per_page),
    );
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface AccountRow {
  account: typeof ftpAccounts.$inferSelect;
  server: ServerRow;
  fingerprint: string | null;
}

/**
 * Two authorisation calls, not one: the first proves the caller holds
 * the permission at all, so an unauthorised probe cannot use response
 * timing to learn which account ids exist; the second scopes it to the
 * server the account actually lives on.
 */
async function loadAccount(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<AccountRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({ account: ftpAccounts, server: servers, fingerprint: sshKeys.fingerprint })
    .from(ftpAccounts)
    .innerJoin(servers, eq(ftpAccounts.serverId, servers.id))
    .leftJoin(sshKeys, eq(ftpAccounts.sshKeyId, sshKeys.id))
    .where(eq(ftpAccounts.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("FTP account", id);
  h.authorize(permission, row.server.id);
  return row;
}

function toApi(row: AccountRow): FtpAccount {
  return {
    id: row.account.id,
    server_id: row.account.serverId,
    server_name: row.server.name,
    username: row.account.username,
    protocol: row.account.protocol,
    home_dir: row.account.homeDir,
    quota_bytes: row.account.quotaBytes,
    used_bytes: row.account.usedBytes,
    status: row.account.status,
    ssh_key_fingerprint: row.fingerprint,
    last_login_at: row.account.lastLoginAt?.toISOString() ?? null,
    created_at: row.account.createdAt.toISOString(),
    updated_at: row.account.updatedAt.toISOString(),
  };
}

/** Envelope-encrypted, keyed by ref so a reset replaces rather than accumulates. */
async function storeSecret(
  req: FastifyRequest,
  ref: string,
  ownerType: string,
  ownerId: string,
  plaintext: string,
): Promise<void> {
  const sealed = seal(plaintext, req.ctx.config.masterKey);
  await req.ctx.db
    .insert(secrets)
    .values({
      ref,
      ownerType,
      ownerId,
      wrappedKey: sealed.wrappedKey,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    })
    .onConflictDoUpdate({
      target: secrets.ref,
      set: {
        wrappedKey: sealed.wrappedKey,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        updatedAt: new Date(),
      },
    });
}

/**
 * An SFTP key is an authorized key, so it is registered in `ssh_keys`
 * rather than hidden inside the transfer module — the Security > SSH
 * page must be able to show every key that can reach a host.
 */
async function linkSshKey(
  req: FastifyRequest,
  server: ServerRow,
  posixUser: string,
  publicKey: string,
): Promise<{ id: string; fingerprint: string }> {
  const parsed = parsePublicKey(publicKey);

  const inserted = await req.ctx.db
    .insert(sshKeys)
    .values({
      name: `${posixUser}@${server.name}`,
      publicKey: publicKey.trim(),
      fingerprint: parsed.fingerprint,
      type: parsed.type,
      comment: parsed.comment,
      posixUser,
      serverIds: [server.id],
    })
    .onConflictDoNothing({ target: sshKeys.fingerprint })
    .returning({ id: sshKeys.id });

  if (inserted[0]) return { id: inserted[0].id, fingerprint: parsed.fingerprint };

  const existing = await req.ctx.db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.fingerprint, parsed.fingerprint))
    .limit(1);
  const key = existing[0];
  if (!key) throw notFound("SSH key", parsed.fingerprint);

  if (!key.serverIds.includes(server.id)) {
    await req.ctx.db
      .update(sshKeys)
      .set({ serverIds: [...key.serverIds, server.id], updatedAt: new Date() })
      .where(eq(sshKeys.id, key.id));
  }
  return { id: key.id, fingerprint: parsed.fingerprint };
}

function parsePublicKey(publicKey: string): { type: string; fingerprint: string; comment: string } {
  const [type, body, ...rest] = publicKey.trim().split(/\s+/);
  if (!type || !body) {
    throw badRequest("An SSH public key looks like `ssh-ed25519 AAAA... comment`.", {
      ssh_public_key: "expected `<type> <base64> [comment]`",
    });
  }
  if (!SSH_KEY_TYPES.has(type)) {
    throw badRequest(`${type} is not a key type Kaname accepts.`, {
      ssh_public_key: `expected one of ${[...SSH_KEY_TYPES].join(", ")}`,
    });
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw badRequest("The key body is not valid base64.", { ssh_public_key: "malformed key body" });
  }

  // OpenSSH's own fingerprint: unpadded base64 of the SHA-256 of the raw blob.
  const digest = createHash("sha256").update(Buffer.from(body, "base64")).digest("base64");
  return { type, fingerprint: `SHA256:${digest.replace(/=+$/, "")}`, comment: rest.join(" ") };
}
