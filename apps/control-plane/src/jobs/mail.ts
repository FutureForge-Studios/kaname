import { eq } from "@kaname/db";
import {
  domains,
  mailAliases,
  mailDomains,
  mailServers,
  mailboxes,
  servers,
} from "@kaname/db/schema";
import type {
  JobType,
  MailCheck,
  MailCheckStatus,
  MailDnsRecord,
  MethodParams,
  MethodResult,
} from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { releaseArch } from "../services/mail-release.js";
import {
  DEPLOY_SECRETS_TTL_MS,
  deploySecretsKey,
  relayPasswordKey,
} from "../services/mail-secrets.js";
import type { JobContext, JobHandler } from "./worker.js";

/* ------------------------------------------------------------------ *
 * Mail job handlers: Yunori Mail Server on a managed host (KD-023).
 *
 * Every handler is one or more `mail.*` RPCs, each of which the agent
 * turns into a `yunori-mail` CLI invocation, followed by the write-back
 * that keeps the fleet view's rows honest (KD-012). The host is the
 * source of truth: a sync re-reads it and reconciles, and a row whose
 * object the host no longer lists is marked, with a log line, rather
 * than silently deleted.
 *
 * Two values are never written anywhere by these handlers: the relay
 * password a deploy carries to the installer, and what the installer
 * hands back (setup link, first mailbox password). Both go through the
 * in-memory once-only store; see services/mail-secrets.ts.
 * ------------------------------------------------------------------ */

type MailServerRow = typeof mailServers.$inferSelect;

interface DeployParams {
  mail_server_id: string;
  domain_id: string;
  domain: string;
  hostname: string;
  admin_email: string;
  first_mailbox: string;
  sending: "direct" | "relay";
  relay?: {
    provider: string;
    host?: string;
    region?: string;
    port?: number;
    username?: string;
    /** Redeemed from the once-only store; the password itself is never in params. */
    password_ref?: string;
  };
  version?: string;
  force: boolean;
  skip_ptr: boolean;
}

const RANK: Record<MailCheckStatus, number> = { pass: 0, info: 1, unknown: 2, warn: 3, fail: 4 };

/** The worst verdict in a list; an empty list says nothing, so "unknown". */
export function worstStatus(statuses: readonly MailCheckStatus[]): MailCheckStatus {
  let worst: MailCheckStatus | null = null;
  for (const status of statuses) {
    if (worst === null || RANK[status] > RANK[worst]) worst = status;
  }
  return worst ?? "unknown";
}

/** DNS health is judged on the records a working server needs, not the optional extras. */
export function dnsStatusOf(records: readonly MailDnsRecord[]): MailCheckStatus {
  const required = records.filter((r) => r.required);
  return worstStatus((required.length ? required : records).map((r) => r.status));
}

/**
 * Installer output that must not reach the job log: the one-time setup
 * link carries its token in the URL fragment, and the first mailbox's
 * password is printed once. The result object carries both to the
 * once-only store; the log only ever sees them masked.
 */
export function redactInstallerLine(line: string): string {
  let out = line.replace(/#token=[^\s'"]+/gi, "#token=[redacted]");
  if (/password/i.test(out)) {
    out = out.replace(/(password[^:=\n]*[:=]\s*)\S+/i, "$1[redacted]");
  }
  return out;
}

function requireServer(ctx: JobContext): string {
  if (!ctx.job.serverId) throw new Error(`${ctx.job.type} requires a server`);
  return ctx.job.serverId;
}

function params<T>(ctx: JobContext): T {
  return ctx.job.params as T;
}

function agentSaid(err: unknown, code: string): boolean {
  return err instanceof AgentRpcError && err.agentError.code === code;
}

function describe(err: unknown): string {
  return err instanceof AgentRpcError
    ? err.agentError.message
    : err instanceof Error
      ? err.message
      : String(err);
}

async function loadMailServer(ctx: JobContext, id: string): Promise<MailServerRow> {
  const rows = await ctx.db.select().from(mailServers).where(eq(mailServers.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`mail server ${id} no longer exists`);
  return row;
}

async function setMailServerError(ctx: JobContext, id: string, message: string): Promise<void> {
  await ctx.db
    .update(mailServers)
    .set({ status: "error", lastError: message.slice(0, 2000), updatedAt: new Date() })
    .where(eq(mailServers.id, id));
}

/** Streams a response-streaming mail RPC into the job log, masked. */
function streamToLog<M extends "mail.deploy" | "mail.update" | "mail.certificate.renew">(
  ctx: JobContext,
  serverId: string,
  method: M,
  p: MethodParams<M>,
): Promise<MethodResult<M>> {
  const handle = ctx.hub.stream(
    serverId,
    method,
    p,
    (data) => {
      for (const line of data.split("\n")) {
        if (line.trim()) void ctx.log_("info", redactInstallerLine(line));
      }
    },
    { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
  );
  return handle.done;
}

/* ------------------------------------------------------------------ *
 * Sync: read the host, reconcile the rows
 * ------------------------------------------------------------------ */

export async function syncMailServer(ctx: JobContext, mailServerId: string): Promise<void> {
  const serverId = requireServer(ctx);
  const row = await loadMailServer(ctx, mailServerId);
  const now = new Date();

  // The one call that has to succeed: without it nothing below can be
  // trusted, and an unreachable host is a wait, not a verdict.
  const status = await ctx.hub.call(serverId, "mail.status", {}, { signal: ctx.signal });

  const optional = async <T>(label: string, call: () => Promise<T>): Promise<T | null> => {
    try {
      return await call();
    } catch (err) {
      if (err instanceof AgentOfflineError) throw err;
      await ctx.log_("warn", `${label} failed: ${describe(err)}`);
      return null;
    }
  };
  const doctor = status.installed
    ? await optional("doctor", () =>
        ctx.hub.call(serverId, "mail.doctor", {}, { signal: ctx.signal }),
      )
    : null;
  const certificate = status.installed
    ? await optional("certificate status", () =>
        ctx.hub.call(serverId, "mail.certificate.status", {}, { signal: ctx.signal }),
      )
    : null;
  const hostDomains = status.installed
    ? await optional("domain list", () =>
        ctx.hub.call(serverId, "mail.domain.list", {}, { signal: ctx.signal }),
      )
    : null;
  const hostMailboxes = status.installed
    ? await optional("mailbox list", () =>
        ctx.hub.call(serverId, "mail.mailbox.list", {}, { signal: ctx.signal }),
      )
    : null;
  const hostAliases = status.installed
    ? await optional("alias list", () =>
        ctx.hub.call(serverId, "mail.alias.list", {}, { signal: ctx.signal }),
      )
    : null;

  const checks: MailCheck[] = doctor?.checks ?? row.checks;
  const hostname = status.hostnames[0] ?? row.hostname;
  // A hand-installed server never told Kaname its primary domain; the
  // host's first domain is the best reading of it.
  const primaryDomain = row.primaryDomain ?? hostDomains?.domains[0]?.name ?? null;

  if (!status.installed && row.status === "installed") {
    await ctx.log_("warn", "yunori-mail is no longer installed on this host");
  }

  await ctx.db
    .update(mailServers)
    .set({
      status: status.installed ? "installed" : "not_installed",
      version: status.version,
      installComplete: status.install_complete,
      steps: status.steps,
      services: status.services,
      hostname,
      primaryDomain,
      consoleUrl: status.console_url ?? row.consoleUrl,
      checks,
      health: worstStatus(checks.map((c) => c.status)),
      certificate: certificate ?? row.certificate ?? null,
      lastError: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(mailServers.id, mailServerId));

  if (hostDomains)
    await reconcileDomains(ctx, row, serverId, primaryDomain, hostDomains.domains, now);
  if (hostMailboxes) await reconcileMailboxes(ctx, serverId, hostMailboxes.mailboxes, now);
  if (hostAliases) await reconcileAliases(ctx, serverId, hostAliases.aliases, now);

  await ctx.log_(
    "info",
    status.installed
      ? `yunori-mail ${status.version ?? "?"} on ${hostname ?? "the host"}: ${checks.length} checks, health ${worstStatus(checks.map((c) => c.status))}`
      : "yunori-mail is not installed on this host",
  );
  ctx.events.publish(
    "servers",
    "mail_server.synced",
    { mail_server_id: mailServerId, server_id: serverId, installed: status.installed },
    serverId,
  );
}

async function reconcileDomains(
  ctx: JobContext,
  row: MailServerRow,
  serverId: string,
  primaryDomain: string | null,
  hostList: MethodResult<"mail.domain.list">["domains"],
  now: Date,
): Promise<void> {
  const known = await ctx.db
    .select({ id: mailDomains.id, name: domains.name, status: mailDomains.status })
    .from(mailDomains)
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .where(eq(mailDomains.mailServerId, row.id));
  const byName = new Map(known.map((d) => [d.name, d]));

  for (const entry of hostList) {
    const name = entry.name.toLowerCase();
    const existing = byName.get(name);
    if (existing) {
      await ctx.db
        .update(mailDomains)
        .set({
          // A removal in flight stays a removal; everything else the host
          // lists is, by definition, active.
          status: existing.status === "removing" ? "removing" : "active",
          dnsStatus: entry.dns_status,
          isPrimary: name === primaryDomain,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(mailDomains.id, existing.id));
      byName.delete(name);
      continue;
    }

    // The host has a domain Kaname never heard of (added in the console
    // or on the terminal). Adopt it, creating the Kaname domain row if
    // there is none: unverified, since nobody here proved ownership.
    let domainId = (
      await ctx.db.select({ id: domains.id }).from(domains).where(eq(domains.name, name)).limit(1)
    )[0]?.id;
    if (!domainId) {
      const [inserted] = await ctx.db
        .insert(domains)
        .values({ name, serverId, status: "active", verified: false, hasMail: true })
        .returning({ id: domains.id });
      domainId = inserted!.id;
      await ctx.log_("info", `created domain ${name} for a mail domain the host already has`);
    }
    const taken = (
      await ctx.db
        .select({ id: mailDomains.id, mailServerId: mailDomains.mailServerId })
        .from(mailDomains)
        .where(eq(mailDomains.domainId, domainId))
        .limit(1)
    )[0];
    if (taken) {
      await ctx.log_(
        "warn",
        `${name} is listed on this host but Kaname has it on another mail server; left as is`,
      );
      continue;
    }
    await ctx.db.insert(mailDomains).values({
      domainId,
      serverId,
      mailServerId: row.id,
      isPrimary: name === primaryDomain,
      status: "active",
      dnsStatus: entry.dns_status,
      lastSyncedAt: now,
    });
    await ctx.db
      .update(domains)
      .set({ hasMail: true, updatedAt: now })
      .where(eq(domains.id, domainId));
    await ctx.log_("info", `adopted mail domain ${name} from the host`);
  }

  // Whatever is left was not in the host's list.
  for (const vanished of byName.values()) {
    if (vanished.status !== "active") continue;
    await ctx.db
      .update(mailDomains)
      .set({ status: "error", lastSyncedAt: now, updatedAt: now })
      .where(eq(mailDomains.id, vanished.id));
    await ctx.log_("warn", `${vanished.name} is no longer on the host; marked error, not deleted`);
  }
}

async function reconcileMailboxes(
  ctx: JobContext,
  serverId: string,
  hostList: MethodResult<"mail.mailbox.list">["mailboxes"],
  now: Date,
): Promise<void> {
  const known = await ctx.db
    .select({ id: mailboxes.id, address: mailboxes.address, status: mailboxes.status })
    .from(mailboxes)
    .where(eq(mailboxes.serverId, serverId));
  const byAddress = new Map(known.map((m) => [m.address, m]));
  const domainIds = await mailDomainIdsByName(ctx, serverId);

  for (const entry of hostList) {
    const address = entry.address.toLowerCase();
    const existing = byAddress.get(address);
    if (existing) {
      await ctx.db
        .update(mailboxes)
        .set({
          displayName: entry.display_name,
          status: existing.status === "removing" ? "removing" : "active",
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(mailboxes.id, existing.id));
      byAddress.delete(address);
      continue;
    }
    const [localPart, domainName] = splitAddress(address);
    const mailDomainId = domainIds.get(domainName);
    if (!mailDomainId) {
      await ctx.log_("warn", `${address} is on the host but its domain is not known here; skipped`);
      continue;
    }
    await ctx.db.insert(mailboxes).values({
      mailDomainId,
      serverId,
      address,
      localPart,
      displayName: entry.display_name,
      status: "active",
      lastSyncedAt: now,
    });
    await ctx.log_("info", `adopted mailbox ${address} from the host`);
  }

  for (const vanished of byAddress.values()) {
    if (vanished.status !== "active") continue;
    await ctx.db
      .update(mailboxes)
      .set({ status: "error", lastSyncedAt: now, updatedAt: now })
      .where(eq(mailboxes.id, vanished.id));
    await ctx.log_(
      "warn",
      `${vanished.address} is no longer on the host; marked error, not deleted`,
    );
  }
}

async function reconcileAliases(
  ctx: JobContext,
  serverId: string,
  hostList: MethodResult<"mail.alias.list">["aliases"],
  now: Date,
): Promise<void> {
  const known = await ctx.db
    .select({ id: mailAliases.id, address: mailAliases.address, status: mailAliases.status })
    .from(mailAliases)
    .where(eq(mailAliases.serverId, serverId));
  const byAddress = new Map(known.map((a) => [a.address, a]));
  const domainIds = await mailDomainIdsByName(ctx, serverId);
  const mailboxIds = new Map(
    (
      await ctx.db
        .select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .where(eq(mailboxes.serverId, serverId))
    ).map((m) => [m.address, m.id]),
  );

  for (const entry of hostList) {
    const address = entry.address.toLowerCase();
    const target = entry.mailbox.toLowerCase();
    const existing = byAddress.get(address);
    if (existing) {
      await ctx.db
        .update(mailAliases)
        .set({
          mailboxId: mailboxIds.get(target) ?? null,
          mailboxAddress: target,
          status: existing.status === "removing" ? "removing" : "active",
          updatedAt: now,
        })
        .where(eq(mailAliases.id, existing.id));
      byAddress.delete(address);
      continue;
    }
    const domainName = splitAddress(address)[1];
    const mailDomainId = domainIds.get(domainName);
    if (!mailDomainId) {
      await ctx.log_(
        "warn",
        `alias ${address} is on the host but its domain is not known here; skipped`,
      );
      continue;
    }
    await ctx.db.insert(mailAliases).values({
      mailDomainId,
      serverId,
      address,
      mailboxId: mailboxIds.get(target) ?? null,
      mailboxAddress: target,
      status: "active",
    });
    await ctx.log_("info", `adopted alias ${address} -> ${target} from the host`);
  }

  for (const vanished of byAddress.values()) {
    if (vanished.status !== "active") continue;
    await ctx.db
      .update(mailAliases)
      .set({ status: "error", updatedAt: now })
      .where(eq(mailAliases.id, vanished.id));
    await ctx.log_(
      "warn",
      `alias ${vanished.address} is no longer on the host; marked error, not deleted`,
    );
  }
}

async function mailDomainIdsByName(
  ctx: JobContext,
  serverId: string,
): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({ id: mailDomains.id, name: domains.name })
    .from(mailDomains)
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .where(eq(mailDomains.serverId, serverId));
  return new Map(rows.map((r) => [r.name, r.id]));
}

function splitAddress(address: string): [string, string] {
  const at = address.lastIndexOf("@");
  return at < 0 ? [address, ""] : [address.slice(0, at), address.slice(at + 1)];
}

/** Writes one `mail.domain.dns` answer onto the row. */
async function storeDns(
  ctx: JobContext,
  mailDomainId: string,
  report: MethodResult<"mail.domain.dns">,
): Promise<MailCheckStatus> {
  const now = new Date();
  const dnsStatus = dnsStatusOf(report.records);
  await ctx.db
    .update(mailDomains)
    .set({
      dnsRecords: report.records,
      zoneFile: report.zone_file,
      dnsStatus,
      dnsCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(mailDomains.id, mailDomainId));
  return dnsStatus;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

const deploy: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<DeployParams>(ctx);
  const row = await loadMailServer(ctx, p.mail_server_id);

  // Which archive: the agent reports its CPU on hello, and a wrong one
  // would fail the checksum at best and exec garbage at worst.
  const [server] = await ctx.db
    .select({ arch: servers.arch })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  const arch = releaseArch(server?.arch);
  if (!arch) {
    const message = `${server?.arch ?? "an unknown CPU"} is not an architecture yunori-mail ships for (x86-64 or ARM64)`;
    await setMailServerError(ctx, row.id, message);
    throw new Error(message);
  }

  let release;
  try {
    release = await ctx.mailReleases.resolve(p.version);
  } catch (err) {
    await setMailServerError(ctx, row.id, describe(err));
    throw err;
  }
  const asset = release.assets[arch];
  if (!asset) {
    const message = `yunori-mail ${release.version} has no ${arch} build`;
    await setMailServerError(ctx, row.id, message);
    throw new Error(message);
  }

  // The relay password waited in memory under the reference the route
  // put in params; it is redeemed here, once, and leaves in the RPC.
  let relay: MethodParams<"mail.deploy">["relay"];
  if (p.relay) {
    const { password_ref, ...rest } = p.relay;
    const password = password_ref
      ? ctx.mailSecrets.take<string>(relayPasswordKey(password_ref))
      : null;
    if (password_ref && !password) {
      const message =
        "the relay password is no longer available (the control plane restarted, or the job waited too long); start the deploy again";
      await setMailServerError(ctx, row.id, message);
      throw new Error(message);
    }
    relay = { ...rest, port: rest.port ?? 587, ...(password ? { password } : {}) };
  }

  await ctx.db
    .update(mailServers)
    .set({ status: "installing", lastError: null, updatedAt: new Date() })
    .where(eq(mailServers.id, row.id));
  await ctx.log_(
    "info",
    `installing yunori-mail ${release.version} (${arch}) on ${p.hostname} for ${p.domain}`,
  );

  let result: MethodResult<"mail.deploy">;
  try {
    result = await streamToLog(ctx, serverId, "mail.deploy", {
      version: release.version,
      url: asset.url,
      sha256: asset.sha256,
      domain: p.domain,
      hostname: p.hostname,
      admin_email: p.admin_email,
      first_mailbox: p.first_mailbox,
      sending: p.sending,
      ...(relay ? { relay } : {}),
      force: p.force,
      skip_ptr: p.skip_ptr,
    });
  } catch (err) {
    if (err instanceof AgentOfflineError) {
      // Not a verdict: the host went away mid-call. The job fails (a
      // deploy is not retried blindly) and the row says what to do.
      await setMailServerError(
        ctx,
        row.id,
        "the agent disconnected during the install; run `sudo yunori-mail install --resume` on the host or deploy again with force",
      );
      throw err;
    }
    await setMailServerError(ctx, row.id, describe(err));
    throw err;
  }

  const now = new Date();
  const failed = result.outcome === "failed";
  await ctx.db
    .update(mailServers)
    .set({
      status: failed ? "error" : "installed",
      version: result.version,
      installComplete: result.outcome === "ready",
      steps: result.steps,
      consoleUrl: result.console_url,
      hostname: p.hostname,
      lastError: failed
        ? `the installer failed${result.paused_at ? ` at "${result.paused_at}"` : ""}`
        : null,
      updatedAt: now,
    })
    .where(eq(mailServers.id, row.id));

  if (!failed) {
    // The primary domain and first mailbox exist on the host now; the
    // sync below would adopt them, but a row that exists before the first
    // sync is what makes the page right as soon as the job pill turns.
    const [mailDomain] = await ctx.db
      .insert(mailDomains)
      .values({
        domainId: p.domain_id,
        serverId,
        mailServerId: row.id,
        isPrimary: true,
        status: "active",
        lastSyncedAt: now,
      })
      .onConflictDoNothing({ target: mailDomains.domainId })
      .returning({ id: mailDomains.id });
    await ctx.db
      .update(domains)
      .set({ hasMail: true, updatedAt: now })
      .where(eq(domains.id, p.domain_id));
    if (mailDomain && result.first_mailbox) {
      await ctx.db
        .insert(mailboxes)
        .values({
          mailDomainId: mailDomain.id,
          serverId,
          address: result.first_mailbox.toLowerCase(),
          localPart: splitAddress(result.first_mailbox.toLowerCase())[0],
          status: "active",
          lastSyncedAt: now,
        })
        .onConflictDoNothing({ target: mailboxes.address });
    }
  }

  if (result.setup_url || result.first_mailbox_password) {
    ctx.mailSecrets.put(
      deploySecretsKey(row.id),
      {
        setup_url: result.setup_url,
        first_mailbox: result.first_mailbox,
        first_mailbox_password: result.first_mailbox_password,
      },
      DEPLOY_SECRETS_TTL_MS,
    );
    await ctx.log_(
      "info",
      "The console setup link and the first mailbox password are available once from the panel for 15 minutes",
    );
  }
  await ctx.log_(
    result.outcome === "ready" ? "info" : "warn",
    result.outcome === "ready"
      ? `yunori-mail ${result.version} is ready on ${p.hostname}`
      : result.outcome === "paused"
        ? `the installer is waiting at "${result.paused_at ?? "an operator step"}"; it re-checks every minute and moves on by itself`
        : `the installer failed${result.paused_at ? ` at "${result.paused_at}"` : ""}`,
  );
  ctx.events.publish(
    "servers",
    "mail_server.deployed",
    { mail_server_id: row.id, server_id: serverId, outcome: result.outcome },
    serverId,
  );

  // The agent re-announces itself right after a deploy so its new `yunori`
  // capability reaches the hub, and the reconciler syncs on that hello. A
  // read that lands before the reconnect is refused as unsupported, which
  // is expected rather than a problem worth a warning.
  try {
    await syncMailServer(ctx, row.id);
  } catch (err) {
    if (agentSaid(err, "unsupported")) {
      await ctx.log_(
        "info",
        "the host reconnects to announce Yunori Mail Server; the first check follows on its own",
      );
    } else {
      await ctx.log_("warn", `first sync after install failed: ${describe(err)}`);
    }
  }

  return {
    outcome: result.outcome,
    version: result.version,
    paused_at: result.paused_at,
    console_url: result.console_url,
    first_mailbox: result.first_mailbox,
  };
};

const sync: JobHandler = async (ctx) => {
  const { mail_server_id } = params<{ mail_server_id: string }>(ctx);
  await syncMailServer(ctx, mail_server_id);
  return { ok: true };
};

const update: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const { mail_server_id } = params<{ mail_server_id: string }>(ctx);
  const row = await loadMailServer(ctx, mail_server_id);
  try {
    await streamToLog(ctx, serverId, "mail.update", {});
  } catch (err) {
    if (!(err instanceof AgentOfflineError)) await setMailServerError(ctx, row.id, describe(err));
    throw err;
  }
  await syncMailServer(ctx, row.id);
  return { ok: true };
};

const certificateRenew: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const { mail_server_id } = params<{ mail_server_id: string }>(ctx);
  await loadMailServer(ctx, mail_server_id);
  const result = await streamToLog(ctx, serverId, "mail.certificate.renew", {});
  await ctx.log_("info", `certificate: ${result.outcome}`);
  try {
    const certificate = await ctx.hub.call(
      serverId,
      "mail.certificate.status",
      {},
      { signal: ctx.signal },
    );
    await ctx.db
      .update(mailServers)
      .set({ certificate, updatedAt: new Date() })
      .where(eq(mailServers.id, mail_server_id));
  } catch (err) {
    if (err instanceof AgentOfflineError) throw err;
    await ctx.log_("warn", `could not re-read the certificate: ${describe(err)}`);
  }
  ctx.events.publish(
    "servers",
    "mail_server.certificate_renewed",
    { mail_server_id, server_id: serverId, outcome: result.outcome },
    serverId,
  );
  return result;
};

const domainAdd: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{ mail_domain_id: string; name: string }>(ctx);
  try {
    await ctx.hub.call(serverId, "mail.domain.add", { name: p.name }, { signal: ctx.signal });
  } catch (err) {
    if (agentSaid(err, "conflict")) {
      await ctx.log_("warn", `${p.name} already existed on the host; adopted it`);
    } else {
      if (!(err instanceof AgentOfflineError)) {
        await ctx.db
          .update(mailDomains)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(mailDomains.id, p.mail_domain_id));
      }
      throw err;
    }
  }
  await ctx.db
    .update(mailDomains)
    .set({ status: "active", lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailDomains.id, p.mail_domain_id));

  // The records to publish are what the operator needs next; reading
  // them now saves a round trip, and failing to is not a failed add.
  let dnsStatus: MailCheckStatus = "unknown";
  try {
    const report = await ctx.hub.call(
      serverId,
      "mail.domain.dns",
      { name: p.name },
      { signal: ctx.signal },
    );
    dnsStatus = await storeDns(ctx, p.mail_domain_id, report);
    await ctx.log_(
      "info",
      `${report.records.length} DNS records expected for ${p.name}; status ${dnsStatus}`,
    );
  } catch (err) {
    if (err instanceof AgentOfflineError) throw err;
    await ctx.log_("warn", `could not read the DNS checklist for ${p.name}: ${describe(err)}`);
  }
  ctx.events.publish(
    "servers",
    "mail_domain.added",
    { mail_domain_id: p.mail_domain_id, server_id: serverId, name: p.name, dns_status: dnsStatus },
    serverId,
  );
  return { ok: true, dns_status: dnsStatus };
};

const domainRemove: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{ mail_domain_id: string; domain_id?: string; name: string }>(ctx);
  try {
    await ctx.hub.call(serverId, "mail.domain.remove", { name: p.name }, { signal: ctx.signal });
  } catch (err) {
    if (!agentSaid(err, "not_found")) {
      if (!(err instanceof AgentOfflineError)) {
        await ctx.db
          .update(mailDomains)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(mailDomains.id, p.mail_domain_id));
      }
      throw err;
    }
    await ctx.log_("warn", `${p.name} was not on the host; removed the record`);
  }
  const domainId =
    p.domain_id ??
    (
      await ctx.db
        .select({ domainId: mailDomains.domainId })
        .from(mailDomains)
        .where(eq(mailDomains.id, p.mail_domain_id))
        .limit(1)
    )[0]?.domainId;
  await ctx.db.delete(mailDomains).where(eq(mailDomains.id, p.mail_domain_id));
  if (domainId) {
    await ctx.db
      .update(domains)
      .set({ hasMail: false, updatedAt: new Date() })
      .where(eq(domains.id, domainId));
  }
  ctx.events.publish(
    "servers",
    "mail_domain.removed",
    { mail_domain_id: p.mail_domain_id, server_id: serverId, name: p.name },
    serverId,
  );
  return { ok: true };
};

const domainDnsCheck: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{ mail_domain_id: string; name: string }>(ctx);
  const report = await ctx.hub.call(
    serverId,
    "mail.domain.dns",
    { name: p.name },
    { signal: ctx.signal },
  );
  const dnsStatus = await storeDns(ctx, p.mail_domain_id, report);
  for (const record of report.records) {
    const level = record.status === "fail" ? "error" : record.status === "warn" ? "warn" : "info";
    await ctx.log_(
      level,
      `${record.type} ${record.name}: ${record.status}${record.required ? "" : " (optional)"}`,
    );
  }
  ctx.events.publish(
    "servers",
    "mail.dns.checked",
    { mail_domain_id: p.mail_domain_id, server_id: serverId, name: p.name, overall: dnsStatus },
    serverId,
  );
  return { overall: dnsStatus, records: report.records.length };
};

const mailboxRemove: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{ mailbox_id: string; address: string }>(ctx);
  try {
    await ctx.hub.call(
      serverId,
      "mail.mailbox.remove",
      { address: p.address },
      { signal: ctx.signal },
    );
  } catch (err) {
    if (!agentSaid(err, "not_found")) {
      if (!(err instanceof AgentOfflineError)) {
        await ctx.db
          .update(mailboxes)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(mailboxes.id, p.mailbox_id));
      }
      throw err;
    }
    await ctx.log_("warn", `${p.address} is not present on the host; removed the record`);
  }
  await ctx.db.delete(mailboxes).where(eq(mailboxes.id, p.mailbox_id));
  ctx.events.publish(
    "servers",
    "mailbox.removed",
    { mailbox_id: p.mailbox_id, server_id: serverId, address: p.address },
    serverId,
  );
  return { ok: true };
};

const aliasAdd: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{ alias_id: string; alias: string; mailbox: string }>(ctx);
  try {
    await ctx.hub.call(
      serverId,
      "mail.alias.add",
      { alias: p.alias, mailbox: p.mailbox },
      { signal: ctx.signal },
    );
  } catch (err) {
    if (agentSaid(err, "conflict")) {
      await ctx.log_("warn", `${p.alias} already existed on the host; adopted it`);
    } else {
      if (!(err instanceof AgentOfflineError)) {
        await ctx.db
          .update(mailAliases)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(mailAliases.id, p.alias_id));
      }
      throw err;
    }
  }
  await ctx.db
    .update(mailAliases)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(mailAliases.id, p.alias_id));
  return { ok: true };
};

const aliasRemove: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{ alias_id: string; alias: string }>(ctx);
  try {
    await ctx.hub.call(serverId, "mail.alias.remove", { alias: p.alias }, { signal: ctx.signal });
  } catch (err) {
    if (!agentSaid(err, "not_found")) {
      if (!(err instanceof AgentOfflineError)) {
        await ctx.db
          .update(mailAliases)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(mailAliases.id, p.alias_id));
      }
      throw err;
    }
    await ctx.log_("warn", `${p.alias} is not present on the host; removed the record`);
  }
  await ctx.db.delete(mailAliases).where(eq(mailAliases.id, p.alias_id));
  return { ok: true };
};

export function mailJobHandlers(): Partial<Record<JobType, JobHandler>> {
  return {
    "mail.server.deploy": deploy,
    "mail.server.sync": sync,
    "mail.server.update": update,
    "mail.certificate.renew": certificateRenew,
    "mail.domain.add": domainAdd,
    "mail.domain.remove": domainRemove,
    "mail.domain.dns_check": domainDnsCheck,
    "mail.mailbox.remove": mailboxRemove,
    "mail.alias.add": aliasAdd,
    "mail.alias.remove": aliasRemove,
  };
}
