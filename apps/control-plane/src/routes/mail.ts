import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, sql, type Database } from "@kaname/db";
import {
  domains,
  mailAliases,
  mailDomains,
  mailServers,
  mailboxes,
  servers,
} from "@kaname/db/schema";
import {
  adoptMailServerInput,
  createMailAliasInput,
  createMailDomainInput,
  createMailboxInput,
  deployMailServerInput,
  idParam,
  mailAliasListQuery,
  mailDomainListQuery,
  mailLogTailQuery,
  mailServerListQuery,
  mailboxListQuery,
  type MailAlias,
  type MailDeploySecrets,
  type MailDnsReport,
  type MailDomain,
  type MailServer,
  type Mailbox,
  type MethodResult,
  type Permission,
} from "@kaname/contract";
import {
  accepted,
  helpers,
  item,
  list,
  noContent,
  offset,
  paginate,
  parseBody,
  parseParams,
  parseQuery,
} from "../http/plugin.js";
import { AgentOfflineError, AgentRpcError, type StreamHandle } from "../agent/hub.js";
import {
  ApiException,
  agentOffline,
  agentUnsupported,
  conflict,
  fromAgentError,
  notFound,
} from "../lib/errors.js";
import {
  DEPLOY_SECRETS_TTL_MS,
  RELAY_PASSWORD_TTL_MS,
  deploySecretsKey,
  relayPasswordKey,
} from "../services/mail-secrets.js";
import {
  combine,
  drained,
  enqueueServerJob,
  loadConnectedServer,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
  type ServerRow,
} from "./_shared.js";
import { recordDecoder } from "./logs.js";

/* ------------------------------------------------------------------ *
 * Email: Yunori Mail Server on a managed host (KD-023).
 *
 * Kaname deploys yunori-mail, reads what it says and sends it the
 * mutations an operator asks for. The host is authoritative; the rows
 * here are the fleet view's cache (KD-012) and a sync re-reads them.
 *
 * Two routes break the "mutations are jobs" rule (KD-008) on purpose:
 * creating a mailbox and resetting its password. The host generates the
 * credential and returns it once, and a job would have to persist it in
 * its result to hand it on. So those two run the RPC inline (KD-024):
 * the password crosses one HTTPS response and is never written anywhere
 * on the control plane, not in a row, not in a job, not in the audit
 * trail. Everything else here enqueues.
 * ------------------------------------------------------------------ */

const TAIL_TIMEOUT_MS = 30 * 60_000;
const KEEPALIVE_MS = 20_000;
/** Inline mailbox calls: the engine answers in seconds or has a problem worth reporting. */
const INLINE_CALL_TIMEOUT_MS = 60_000;

const MAIL_SERVER_SORTABLE = {
  server: servers.name,
  hostname: mailServers.hostname,
  status: mailServers.status,
  health: mailServers.health,
  synced_at: mailServers.lastSyncedAt,
  created_at: mailServers.createdAt,
} as const;

const MAIL_DOMAIN_SORTABLE = {
  domain: domains.name,
  status: mailDomains.status,
  dns_status: mailDomains.dnsStatus,
  checked_at: mailDomains.dnsCheckedAt,
  created_at: mailDomains.createdAt,
} as const;

const MAILBOX_SORTABLE = {
  address: mailboxes.address,
  quota_bytes: mailboxes.quotaBytes,
  status: mailboxes.status,
  created_at: mailboxes.createdAt,
} as const;

const ALIAS_SORTABLE = {
  address: mailAliases.address,
  mailbox: mailAliases.mailboxAddress,
  created_at: mailAliases.createdAt,
} as const;

import { assertOwned, ownership } from "./_ownership.js";

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  /* ============================== servers =========================== */

  app.get("/mail-servers", async (req, reply) => {
    const q = parseQuery(req, mailServerListQuery);
    helpers(req).authorize("email.servers:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.servers:read", mailServers.serverId),
      q.status ? eq(mailServers.status, q.status) : null,
      q.health ? eq(mailServers.health, q.health) : null,
      term
        ? sql`(lower(${servers.name}) like ${term} or lower(coalesce(${mailServers.hostname}, '')) like ${term} or lower(coalesce(${mailServers.primaryDomain}, '')) like ${term})`
        : null,
    );

    const column = sortColumn(MAIL_SERVER_SORTABLE, q.sort, "server");
    const rows = await req.ctx.db
      .select({ mailServer: mailServers, server: servers })
      .from(mailServers)
      .innerJoin(servers, eq(mailServers.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailServers)
      .innerJoin(servers, eq(mailServers.serverId, servers.id))
      .where(where);

    const data = await Promise.all(rows.map((row) => toMailServerApi(req.ctx.db, row)));
    return list(reply, data, paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  app.get("/mail-servers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:read");
    return item(reply, await toMailServerApi(req.ctx.db, row));
  });

  app.post("/mail-servers", async (req, reply) => {
    const body = parseBody(req, deployMailServerInput);
    const server = await loadConnectedServer(req, body.server_id, "email.servers:write");
    // The installer is driven through systemd units and the agent's
    // verified download; a host without systemd cannot run it.
    if (!req.ctx.hub.capabilities(server.id).includes("systemd")) {
      throw agentUnsupported(server.name, "systemd");
    }
    await assertNoMailServer(req, server);

    const domain = await loadDomainRow(req, body.domain_id);
    await assertDomainHostsNoMail(req, domain);
    const hostname = body.hostname ?? `mail.${domain.name}`;

    const [row] = await req.ctx.db
      .insert(mailServers)
      .values({
        serverId: server.id,
        status: "deploying",
        hostname,
        primaryDomain: domain.name,
        adminEmail: body.admin_email,
        sendingMode: body.sending,
        relayProvider: body.relay?.provider ?? null,
      })
      .returning();

    // The relay password must reach the installer and must not reach the
    // jobs table (params are persisted, backed up and shown in the
    // drawer). It waits in memory under a reference the handler redeems;
    // only the reference travels with the job.
    let relay: Record<string, unknown> | undefined;
    if (body.relay) {
      const { password, ...rest } = body.relay;
      relay = { ...rest };
      if (password) {
        const ref = randomUUID();
        req.ctx.mailSecrets.put(relayPasswordKey(ref), password, RELAY_PASSWORD_TTL_MS);
        relay.password_ref = ref;
      }
    }

    const job = await enqueueServerJob(req, {
      type: "mail.server.deploy",
      server,
      targetType: "mail_server",
      targetId: row!.id,
      targetLabel: hostname,
      params: {
        mail_server_id: row!.id,
        domain_id: domain.id,
        domain: domain.name,
        hostname,
        admin_email: body.admin_email,
        first_mailbox: body.first_mailbox,
        sending: body.sending,
        ...(relay ? { relay } : {}),
        ...(body.version ? { version: body.version } : {}),
        force: body.force,
        skip_ptr: body.skip_ptr,
      },
    });

    req.ctx.events.publish(
      "servers",
      "mail_server.deploying",
      { mail_server_id: row!.id, server_id: server.id, hostname },
      server.id,
    );
    return accepted(reply, job);
  });

  app.post("/mail-servers/adopt", async (req, reply) => {
    const body = parseBody(req, adoptMailServerInput);
    const server = await loadConnectedServer(req, body.server_id, "email.servers:write");
    if (!req.ctx.hub.capabilities(server.id).includes("yunori")) {
      throw agentUnsupported(server.name, "Yunori Mail Server");
    }
    await assertNoMailServer(req, server);

    const [row] = await req.ctx.db
      .insert(mailServers)
      .values({
        serverId: server.id,
        status: "installed",
        installComplete: false,
        hostname: body.hostname ?? null,
        adminEmail: body.admin_email ?? null,
      })
      .returning();

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "mail_server.adopted",
      targetType: "mail_server",
      targetId: row!.id,
      targetLabel: body.hostname ?? server.name,
      serverId: server.id,
      after: body,
    });

    const job = await enqueueServerJob(req, {
      type: "mail.server.sync",
      server,
      targetType: "mail_server",
      targetId: row!.id,
      targetLabel: body.hostname ?? server.name,
      params: { mail_server_id: row!.id },
    });
    return accepted(reply, job);
  });

  app.post("/mail-servers/:id/sync", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:read");
    const job = await enqueueServerJob(req, {
      type: "mail.server.sync",
      server: row.server,
      targetType: "mail_server",
      targetId: row.mailServer.id,
      targetLabel: row.mailServer.hostname ?? row.server.name,
      params: { mail_server_id: row.mailServer.id },
    });
    return accepted(reply, job);
  });

  app.post("/mail-servers/:id/update", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:exec");
    if (row.mailServer.status !== "installed") {
      throw conflict(
        `${row.mailServer.hostname ?? row.server.name} is ${row.mailServer.status}; only an installed mail server can be updated.`,
      );
    }
    const job = await enqueueServerJob(req, {
      type: "mail.server.update",
      server: row.server,
      targetType: "mail_server",
      targetId: row.mailServer.id,
      targetLabel: row.mailServer.hostname ?? row.server.name,
      params: { mail_server_id: row.mailServer.id },
    });
    return accepted(reply, job);
  });

  app.post("/mail-servers/:id/certificate/renew", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:exec");
    const job = await enqueueServerJob(req, {
      type: "mail.certificate.renew",
      server: row.server,
      targetType: "mail_server",
      targetId: row.mailServer.id,
      targetLabel: row.mailServer.hostname ?? row.server.name,
      params: { mail_server_id: row.mailServer.id },
    });
    return accepted(reply, job);
  });

  // Read-only and side-effect free on the host, so it passes through
  // (KD-008 allows exactly this), and it has to be live: the point of a
  // preflight is what the host sees right now.
  app.get("/mail-servers/:id/preflight", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:read");
    const server = await loadConnectedServer(req, row.server.id, "email.servers:read");
    requireYunori(req, server);
    const result = await callAgent(server, () =>
      req.ctx.hub.call(
        server.id,
        "mail.preflight",
        row.mailServer.hostname ? { hostname: row.mailServer.hostname } : {},
        { timeoutMs: INLINE_CALL_TIMEOUT_MS },
      ),
    );
    return item(reply, { checks: result.checks });
  });

  // What `mail.deploy` handed back: the one-time console setup link and
  // the first mailbox's password. Held in memory for a quarter of an hour
  // and handed out once; a second request, or one after a control-plane
  // restart, gets the 404 below with the way to mint a new link.
  app.get("/mail-servers/:id/deploy-secrets", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:write");
    const secrets = req.ctx.mailSecrets.take<MailDeploySecrets>(deploySecretsKey(id));
    if (!secrets) {
      throw new ApiException(
        "not_found",
        "The deploy secrets are not available (shown once, or expired).",
        {
          remediation: {
            summary:
              "Run `sudo yunori-mail setup-token` on the host for a new console setup link, and reset the first mailbox's password from its page here.",
            actions: [{ label: "Mailboxes", href: "/email/mailboxes" }],
          },
        },
      );
    }
    // The values themselves never enter the audit trail; that they were
    // read, by whom, does.
    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "mail_server.deploy_secrets_viewed",
      targetType: "mail_server",
      targetId: id,
      targetLabel: row.mailServer.hostname ?? row.server.name,
      serverId: row.server.id,
      metadata: { first_mailbox: secrets.first_mailbox },
    });
    return item(reply, secrets);
  });

  // Forgets Kaname's record only. Nothing is uninstalled: the host keeps
  // its mail server and its mail, and the record comes back on the next
  // hello from an agent that advertises `yunori`.
  app.delete("/mail-servers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailServer(req, id, "email.servers:write");

    // Only the domains an operator added block this. The primary domain
    // cannot be removed on its own ("it goes with the server", see
    // DELETE /mail-domains/:id), so counting it here made every installed
    // server impossible to forget: each refusal pointed at the other. It
    // and its mailbox and alias rows go with the record (FK cascade);
    // nothing on the host is touched, and a sync after re-adopting reads
    // them back.
    const [counts] = await req.ctx.db
      .select({ domains: sql<number>`count(*)::int` })
      .from(mailDomains)
      .where(and(eq(mailDomains.mailServerId, id), eq(mailDomains.isPrimary, false)));
    if ((counts?.domains ?? 0) > 0) {
      throw conflict(
        `${row.mailServer.hostname ?? row.server.name} still hosts ${counts!.domains} mail domain(s) besides its primary one.`,
        {
          summary:
            "Remove its mail domains first. Forgetting the record never uninstalls anything on the host.",
          actions: [{ label: "Mail domains", href: `/email/domains?server_id=${row.server.id}` }],
        },
      );
    }

    // The Kaname domain stays; it just no longer hosts mail here.
    await req.ctx.db
      .update(domains)
      .set({ hasMail: false, updatedAt: new Date() })
      .where(
        sql`${domains.id} in (select domain_id from mail_domains where mail_server_id = ${id})`,
      );
    await req.ctx.db.delete(mailServers).where(eq(mailServers.id, id));
    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "mail_server.forgotten",
      targetType: "mail_server",
      targetId: id,
      targetLabel: row.mailServer.hostname ?? row.server.name,
      serverId: row.server.id,
      before: {
        hostname: row.mailServer.hostname,
        primary_domain: row.mailServer.primaryDomain,
        version: row.mailServer.version,
      },
    });
    req.ctx.events.publish(
      "servers",
      "mail_server.forgotten",
      { mail_server_id: id, server_id: row.server.id },
      row.server.id,
    );
    return noContent(reply);
  });

  /* ============================== releases ========================== */

  app.get("/mail-releases/latest", async (req, reply) => {
    helpers(req).authorize("email.servers:read");
    try {
      return item(reply, await req.ctx.mailReleases.latest());
    } catch (err) {
      throw new ApiException(
        "upstream_error",
        err instanceof Error ? err.message : "The yunori-mail release feed could not be read.",
        {
          remediation: {
            summary:
              "Kaname reads yunori.email/server for the newest release and its checksum. Check this control plane's outbound HTTPS, or pin KANAME_YUNORI_VERSION.",
            actions: [{ label: "Release feed", href: "https://yunori.email/server" }],
          },
        },
      );
    }
  });

  /* =============================== domains ========================== */

  app.get("/mail-domains", async (req, reply) => {
    const q = parseQuery(req, mailDomainListQuery);
    helpers(req).authorize("email.mailboxes:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.mailboxes:read", mailDomains.serverId),
      q.server_id ? eq(mailDomains.serverId, q.server_id) : null,
      q.status ? eq(mailDomains.status, q.status) : null,
      q.dns_status ? eq(mailDomains.dnsStatus, q.dns_status) : null,
      term ? sql`lower(${domains.name}) like ${term}` : null,
    );

    const column = sortColumn(MAIL_DOMAIN_SORTABLE, q.sort, "domain");
    const rows = await req.ctx.db
      .select({ mailDomain: mailDomains, domainName: domains.name, server: servers })
      .from(mailDomains)
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailDomains)
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where);

    const data = await Promise.all(rows.map((row) => toMailDomainApi(req.ctx.db, row)));
    return list(reply, data, paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  app.get("/mail-domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailDomain(req, id, "email.mailboxes:read");
    return item(reply, await toMailDomainApi(req.ctx.db, row));
  });

  app.post("/mail-domains", async (req, reply) => {
    const body = parseBody(req, createMailDomainInput);
    const server = await loadServer(req, body.server_id, "email.mailboxes:write");
    const mailServer = await installedMailServerFor(req, server);
    const domain = await loadDomainRow(req, body.domain_id);

    await assertDomainHostsNoMail(req, domain);

    const [row] = await req.ctx.db
      .insert(mailDomains)
      .values({
        domainId: domain.id,
        serverId: server.id,
        mailServerId: mailServer.id,
        isPrimary: false,
        status: "provisioning",
      })
      .returning();
    await req.ctx.db
      .update(domains)
      .set({ hasMail: true, updatedAt: new Date() })
      .where(eq(domains.id, domain.id));

    const job = await enqueueServerJob(req, {
      type: "mail.domain.add",
      server,
      targetType: "mail_domain",
      targetId: row!.id,
      targetLabel: domain.name,
      params: { mail_domain_id: row!.id, name: domain.name },
    });
    return accepted(reply, job);
  });

  app.delete("/mail-domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailDomain(req, id, "email.mailboxes:delete");

    if (row.mailDomain.isPrimary) {
      throw conflict(`${row.domainName} is the domain this mail server was installed with.`, {
        summary:
          "The primary domain goes with the server. Forget or uninstall the mail server instead.",
        actions: [{ label: "Mail server", href: `/email/health?server_id=${row.server.id}` }],
      });
    }

    const [counts] = await req.ctx.db
      .select({
        mailboxes: sql<number>`(select count(*) from mailboxes where mail_domain_id = ${id})::int`,
        aliases: sql<number>`(select count(*) from mail_aliases where mail_domain_id = ${id})::int`,
      })
      .from(sql`(select 1) as one`);
    if ((counts?.mailboxes ?? 0) > 0 || (counts?.aliases ?? 0) > 0) {
      throw conflict(
        `${row.domainName} still has ${counts!.mailboxes} mailbox(es) and ${counts!.aliases} alias(es).`,
        {
          summary: "Delete the mailboxes and aliases first; their mail goes with them.",
          // The Mailboxes page filters on mail_domain_id; `?domain=` is not a filter it reads.
          actions: [{ label: "Mailboxes", href: `/email/mailboxes?mail_domain_id=${id}` }],
        },
      );
    }

    await req.ctx.db
      .update(mailDomains)
      .set({ status: "removing", updatedAt: new Date() })
      .where(eq(mailDomains.id, id));

    const job = await enqueueServerJob(req, {
      type: "mail.domain.remove",
      server: row.server,
      targetType: "mail_domain",
      targetId: id,
      targetLabel: row.domainName,
      params: { mail_domain_id: id, domain_id: row.mailDomain.domainId, name: row.domainName },
    });
    return accepted(reply, job);
  });

  app.get("/mail-domains/:id/dns", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailDomain(req, id, "email.mailboxes:read");
    const report: MailDnsReport = {
      mail_domain_id: id,
      domain_name: row.domainName,
      overall: row.mailDomain.dnsStatus,
      records: row.mailDomain.dnsRecords,
      zone_file: row.mailDomain.zoneFile,
      checked_at: row.mailDomain.dnsCheckedAt?.toISOString() ?? null,
    };
    return item(reply, report);
  });

  app.post("/mail-domains/:id/dns/check", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailDomain(req, id, "email.servers:exec");
    const job = await enqueueServerJob(req, {
      type: "mail.domain.dns_check",
      server: row.server,
      targetType: "mail_domain",
      targetId: id,
      targetLabel: row.domainName,
      params: { mail_domain_id: id, name: row.domainName },
    });
    return accepted(reply, job);
  });

  /* ============================== mailboxes ========================= */

  app.get("/mailboxes", async (req, reply) => {
    const q = parseQuery(req, mailboxListQuery);
    const own = ownership(req);
    helpers(req).authorize("email.mailboxes:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.mailboxes:read", mailboxes.serverId),
      own.filter("mailbox", mailboxes.id),
      q.mail_domain_id ? eq(mailboxes.mailDomainId, q.mail_domain_id) : null,
      q.domain ? eq(domains.name, q.domain.toLowerCase()) : null,
      q.server_id ? eq(mailboxes.serverId, q.server_id) : null,
      q.status ? eq(mailboxes.status, q.status) : null,
      term
        ? sql`(lower(${mailboxes.address}) like ${term} or lower(coalesce(${mailboxes.displayName}, '')) like ${term})`
        : null,
    );

    const column = sortColumn(MAILBOX_SORTABLE, q.sort, "address");
    const rows = await req.ctx.db
      .select({
        mailbox: mailboxes,
        domainName: domains.name,
        server: servers,
        aliases: aliasesOf(mailboxes.id),
      })
      .from(mailboxes)
      .innerJoin(mailDomains, eq(mailboxes.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailboxes.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailboxes)
      .innerJoin(mailDomains, eq(mailboxes.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailboxes.serverId, servers.id))
      .where(where);

    return list(
      reply,
      rows.map(toMailboxApi),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  app.get("/mailboxes/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const row = await loadMailbox(req, id, "email.mailboxes:read");
    return item(reply, toMailboxApi(row));
  });

  // Synchronous on purpose (KD-024, see the module comment): the host
  // generates the password and returns it once, and this response is the
  // only place it ever exists on this side.
  app.post("/mailboxes", async (req, reply) => {
    const body = parseBody(req, createMailboxInput);
    const own = ownership(req);
    const domain = await loadMailDomain(req, body.mail_domain_id, "email.mailboxes:write");
    // A mailbox goes on a mail domain only when the domain under it is
    // the caller's, and it must fit the allowance before the host is asked.
    await own.assertOwns("domain", domain.mailDomain.domainId, "Mail domain");
    if (own.restricted && body.quota_mb === 0) {
      // "Unlimited" would be a mailbox no disk allowance could ever count.
      throw new ApiException("validation_failed", "Give this mailbox a size.", {
        fields: { quota_mb: "required for this account" },
      });
    }
    await own.reserve("mailbox", 1, body.quota_mb);
    const server = await loadConnectedServer(req, domain.server.id, "email.mailboxes:write");
    requireYunori(req, server);
    if (domain.mailDomain.status !== "active") {
      throw conflict(
        `${domain.domainName} is ${domain.mailDomain.status}; mailboxes can be added once it is active.`,
      );
    }

    const address = `${body.local_part}@${domain.domainName}`;
    await assertAddressFree(req, address);

    const result = await callAgent(server, () =>
      req.ctx.hub.call(
        server.id,
        "mail.mailbox.add",
        {
          address,
          ...(body.display_name ? { display_name: body.display_name } : {}),
          ...(body.quota_mb > 0 ? { quota_mb: body.quota_mb } : {}),
        },
        { timeoutMs: INLINE_CALL_TIMEOUT_MS },
      ),
    );

    const [row] = await req.ctx.db
      .insert(mailboxes)
      .values({
        mailDomainId: domain.mailDomain.id,
        serverId: server.id,
        address,
        localPart: body.local_part,
        displayName: body.display_name ?? null,
        quotaBytes: body.quota_mb * 1024 * 1024,
        status: "active",
        lastSyncedAt: new Date(),
      })
      .returning();
    await own.claim("mailbox", row!.id);

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "mailbox.created",
      targetType: "mailbox",
      targetId: row!.id,
      targetLabel: address,
      serverId: server.id,
      after: { address, display_name: body.display_name ?? null, quota_mb: body.quota_mb },
    });
    req.ctx.events.publish(
      "servers",
      "mailbox.created",
      { mailbox_id: row!.id, address, server_id: server.id },
      server.id,
    );

    const mailbox = toMailboxApi({
      mailbox: row!,
      domainName: domain.domainName,
      server,
      aliases: [],
    });
    return item(reply, { mailbox, password: result.password }, 201);
  });

  app.post("/mailboxes/:id/reset-password", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const row = await loadMailbox(req, id, "email.mailboxes:write");
    const server = await loadConnectedServer(req, row.server.id, "email.mailboxes:write");
    requireYunori(req, server);

    const result = await callAgent(server, () =>
      req.ctx.hub.call(
        server.id,
        "mail.mailbox.passwd",
        { address: row.mailbox.address },
        { timeoutMs: INLINE_CALL_TIMEOUT_MS },
      ),
    );

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "mailbox.password_reset",
      targetType: "mailbox",
      targetId: id,
      targetLabel: row.mailbox.address,
      serverId: server.id,
    });
    return item(reply, { address: row.mailbox.address, password: result.password });
  });

  app.delete("/mailboxes/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    ownership(req);
    const row = await loadMailbox(req, id, "email.mailboxes:delete");

    await req.ctx.db
      .update(mailboxes)
      .set({ status: "removing", updatedAt: new Date() })
      .where(eq(mailboxes.id, id));

    const job = await enqueueServerJob(req, {
      type: "mail.mailbox.remove",
      server: row.server,
      targetType: "mailbox",
      targetId: id,
      targetLabel: row.mailbox.address,
      params: { mailbox_id: id, address: row.mailbox.address },
    });
    return accepted(reply, job);
  });

  /* =============================== aliases ========================== */

  app.get("/mail-aliases", async (req, reply) => {
    const q = parseQuery(req, mailAliasListQuery);
    helpers(req).authorize("email.routing:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.routing:read", mailAliases.serverId),
      q.mail_domain_id ? eq(mailAliases.mailDomainId, q.mail_domain_id) : null,
      q.domain ? eq(domains.name, q.domain.toLowerCase()) : null,
      q.server_id ? eq(mailAliases.serverId, q.server_id) : null,
      q.mailbox_id ? eq(mailAliases.mailboxId, q.mailbox_id) : null,
      term
        ? sql`(lower(${mailAliases.address}) like ${term} or lower(${mailAliases.mailboxAddress}) like ${term})`
        : null,
    );

    const column = sortColumn(ALIAS_SORTABLE, q.sort, "address");
    const rows = await req.ctx.db
      .select({ alias: mailAliases, domainName: domains.name, server: servers })
      .from(mailAliases)
      .innerJoin(mailDomains, eq(mailAliases.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailAliases.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailAliases)
      .innerJoin(mailDomains, eq(mailAliases.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailAliases.serverId, servers.id))
      .where(where);

    return list(reply, rows.map(toAliasApi), paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  app.get("/mail-aliases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadAlias(req, id, "email.routing:read");
    return item(reply, toAliasApi(row));
  });

  app.post("/mail-aliases", async (req, reply) => {
    const body = parseBody(req, createMailAliasInput);
    const domain = await loadMailDomain(req, body.mail_domain_id, "email.routing:write");

    const target = (
      await req.ctx.db
        .select({ id: mailboxes.id, address: mailboxes.address, serverId: mailboxes.serverId })
        .from(mailboxes)
        .where(eq(mailboxes.id, body.mailbox_id))
        .limit(1)
    )[0];
    if (!target) throw notFound("Mailbox", body.mailbox_id);
    // yunori-mail delivers an alias to a mailbox it hosts; one on another
    // host is a forward, which this product does not do.
    if (target.serverId !== domain.server.id) {
      throw conflict(`${target.address} is not hosted on ${domain.server.name}.`, {
        summary: "An alias delivers to a mailbox on the same mail server.",
        actions: [
          { label: "Mailboxes", href: `/email/mailboxes?mail_domain_id=${domain.mailDomain.id}` },
        ],
      });
    }

    const address = `${body.local_part}@${domain.domainName}`;
    await assertAddressFree(req, address);

    const [row] = await req.ctx.db
      .insert(mailAliases)
      .values({
        mailDomainId: domain.mailDomain.id,
        serverId: domain.server.id,
        address,
        mailboxId: target.id,
        mailboxAddress: target.address,
        status: "active",
      })
      .returning();

    const job = await enqueueServerJob(req, {
      type: "mail.alias.add",
      server: domain.server,
      targetType: "mail_alias",
      targetId: row!.id,
      targetLabel: address,
      params: { alias_id: row!.id, alias: address, mailbox: target.address },
    });
    return accepted(reply, job);
  });

  app.delete("/mail-aliases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadAlias(req, id, "email.routing:delete");

    await req.ctx.db
      .update(mailAliases)
      .set({ status: "removing", updatedAt: new Date() })
      .where(eq(mailAliases.id, id));

    const job = await enqueueServerJob(req, {
      type: "mail.alias.remove",
      server: row.server,
      targetType: "mail_alias",
      targetId: id,
      targetLabel: row.alias.address,
      params: { alias_id: id, alias: row.alias.address },
    });
    return accepted(reply, job);
  });

  /* ================================ logs ============================ */

  app.get("/mail-logs/tail", async (req, reply) => {
    const q = parseQuery(req, mailLogTailQuery);
    const server = await loadConnectedServer(req, q.server_id, "email.logs:read");
    // Decided before the headers go out: once the response is an event
    // stream a refusal can only be a frame, not the JSON error with a
    // remediation that the rest of the API answers with.
    requireYunori(req, server);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers SSE by default and makes a live tail look frozen.
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`retry: 3000\n\n`);

    const errorFrame = (err: unknown) => {
      const code =
        err instanceof AgentOfflineError
          ? "agent_offline"
          : err instanceof AgentRpcError && err.agentError.code === "unsupported"
            ? "agent_unsupported"
            : "agent_error";
      const message = err instanceof Error ? err.message : String(err);
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`);
    };

    let handle: StreamHandle<MethodResult<"mail.logs">>;
    try {
      handle = req.ctx.hub.stream(
        server.id,
        "mail.logs",
        { lines: q.lines, follow: true, ...(q.q ? { query: q.q } : {}) },
        // Both providers stream one JSON LogRecord per line (the journal
        // entry, already parsed on the host). Forwarding the raw line put
        // the whole record — braces, cursor and all — in front of the
        // operator as the "message", and split a record that straddled two
        // chunks. The shared decoder carries partial lines over and keeps
        // a plain-text line as it is.
        recordDecoder("mail", async (record) => {
          if (reply.raw.writableEnded || reply.raw.destroyed) return;
          const payload = {
            server_id: server.id,
            server_name: server.name,
            ts: record.ts,
            line: record.message,
          };
          // A browser that is behind holds the next line, and the agent with it.
          if (!reply.raw.write(`event: mail.log\ndata: ${JSON.stringify(payload)}\n\n`)) {
            await drained(reply.raw);
          }
        }),
        { timeoutMs: TAIL_TIMEOUT_MS },
      );
    } catch (err) {
      // The agent left between the connectivity check and this call.
      // Fastify's error handler cannot speak on a response whose
      // headers are out, so the client is told in its own dialect.
      errorFrame(err);
      reply.raw.end();
      return reply;
    }

    const keepalive = setInterval(() => reply.raw.write(`: keepalive\n\n`), KEEPALIVE_MS);
    keepalive.unref?.();

    const close = () => {
      clearInterval(keepalive);
      handle.cancel("client disconnected");
    };
    req.raw.on("close", close);
    req.raw.on("error", close);

    void handle.done
      .catch((err: unknown) => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        // The per-call deadline is a cap on one follow, not a fault on
        // the host: the client opens a fresh one and carries on.
        if (err instanceof AgentRpcError && err.agentError.code === "timeout") {
          reply.raw.write(`event: rotate\ndata: {}\n\n`);
          return;
        }
        errorFrame(err);
      })
      .finally(() => {
        clearInterval(keepalive);
        reply.raw.end();
      });

    // The reply belongs to the stream until the client leaves.
    return reply;
  });
}

/* ------------------------------------------------------------------ *
 * Loaders
 *
 * Each of these authorises twice on purpose: once to prove the caller
 * holds the permission at all, before any row is read, and again once
 * the row names the server it belongs to.
 * ------------------------------------------------------------------ */

interface MailServerRow {
  mailServer: typeof mailServers.$inferSelect;
  server: ServerRow;
}

async function loadMailServer(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<MailServerRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({ mailServer: mailServers, server: servers })
    .from(mailServers)
    .innerJoin(servers, eq(mailServers.serverId, servers.id))
    .where(eq(mailServers.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Mail server", id);
  h.authorize(permission, row.server.id);
  return row;
}

interface MailDomainRow {
  mailDomain: typeof mailDomains.$inferSelect;
  domainName: string;
  server: ServerRow;
}

async function loadMailDomain(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<MailDomainRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({ mailDomain: mailDomains, domainName: domains.name, server: servers })
    .from(mailDomains)
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .innerJoin(servers, eq(mailDomains.serverId, servers.id))
    .where(eq(mailDomains.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Mail domain", id);
  h.authorize(permission, row.server.id);
  return row;
}

interface MailboxRow {
  mailbox: typeof mailboxes.$inferSelect;
  domainName: string;
  server: ServerRow;
  aliases: string[];
}

async function loadMailbox(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<MailboxRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({
      mailbox: mailboxes,
      domainName: domains.name,
      server: servers,
      aliases: aliasesOf(mailboxes.id),
    })
    .from(mailboxes)
    .innerJoin(mailDomains, eq(mailboxes.mailDomainId, mailDomains.id))
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .innerJoin(servers, eq(mailboxes.serverId, servers.id))
    .where(eq(mailboxes.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Mailbox", id);
  h.authorize(permission, row.server.id);
  await assertOwned(req, "mailbox", id, "Mailbox");
  return row;
}

interface AliasRow {
  alias: typeof mailAliases.$inferSelect;
  domainName: string;
  server: ServerRow;
}

async function loadAlias(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<AliasRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({ alias: mailAliases, domainName: domains.name, server: servers })
    .from(mailAliases)
    .innerJoin(mailDomains, eq(mailAliases.mailDomainId, mailDomains.id))
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .innerJoin(servers, eq(mailAliases.serverId, servers.id))
    .where(eq(mailAliases.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Alias", id);
  h.authorize(permission, row.server.id);
  return row;
}

async function loadDomainRow(req: FastifyRequest, domainId: string) {
  const rows = await req.ctx.db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
  const domain = rows[0];
  if (!domain) throw notFound("Domain", domainId);
  return domain;
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

function requireYunori(req: FastifyRequest, server: ServerRow): void {
  if (!req.ctx.hub.capabilities(server.id).includes("yunori")) {
    throw agentUnsupported(server.name, "Yunori Mail Server");
  }
}

/** One mail server per host: a second deploy would fight the first for ports 25 to 993. */
async function assertNoMailServer(req: FastifyRequest, server: ServerRow): Promise<void> {
  const existing = await req.ctx.db
    .select({ id: mailServers.id, status: mailServers.status })
    .from(mailServers)
    .where(eq(mailServers.serverId, server.id))
    .limit(1);
  if (existing[0]) {
    throw conflict(`${server.name} already has a mail server (${existing[0].status}).`, {
      summary:
        "A host runs one Yunori Mail Server. Sync the existing record, or forget it first if it is stale.",
      actions: [{ label: "Mail server", href: `/email/health?server_id=${server.id}` }],
    });
  }
}

async function installedMailServerFor(
  req: FastifyRequest,
  server: ServerRow,
): Promise<typeof mailServers.$inferSelect> {
  const rows = await req.ctx.db
    .select()
    .from(mailServers)
    .where(eq(mailServers.serverId, server.id))
    .limit(1);
  const mailServer = rows[0];
  if (!mailServer) {
    throw conflict(`${server.name} has no mail server.`, {
      summary: "Deploy Yunori Mail Server on this host first, or adopt one installed by hand.",
      actions: [{ label: "Deploy mail server", href: "/email/health" }],
    });
  }
  if (mailServer.status !== "installed") {
    throw conflict(`The mail server on ${server.name} is ${mailServer.status}.`, {
      summary: "Domains can be added once the install has finished.",
      actions: [{ label: "Mail server", href: `/email/health?server_id=${server.id}` }],
    });
  }
  return mailServer;
}

/** A domain receives mail on one server; a second would split its MX. */
async function assertDomainHostsNoMail(
  req: FastifyRequest,
  domain: { id: string; name: string },
): Promise<void> {
  const existing = await req.ctx.db
    .select({ id: mailDomains.id })
    .from(mailDomains)
    .where(eq(mailDomains.domainId, domain.id))
    .limit(1);
  if (existing[0]) {
    throw conflict(`${domain.name} already hosts mail.`, {
      summary: "A domain receives mail on one server. Open the existing mail domain instead.",
      // The Domains page has no `?id=` deep link; its search box is in the URL.
      actions: [
        { label: "Open mail domain", href: `/email/domains?q=${encodeURIComponent(domain.name)}` },
      ],
    });
  }
}

/** A mailbox and an alias share one address space on the host. */
async function assertAddressFree(req: FastifyRequest, address: string): Promise<void> {
  const [mailbox] = await req.ctx.db
    .select({ id: mailboxes.id, status: mailboxes.status })
    .from(mailboxes)
    .where(eq(mailboxes.address, address))
    .limit(1);
  if (mailbox) {
    throw conflict(`${address} is already a mailbox.`, {
      summary:
        mailbox.status === "removing"
          ? "It is being removed; wait for that job to finish."
          : "Pick another local part, or open the existing mailbox.",
      actions: [
        { label: "Open mailbox", href: `/email/mailboxes?q=${encodeURIComponent(address)}` },
      ],
    });
  }
  const [alias] = await req.ctx.db
    .select({ id: mailAliases.id })
    .from(mailAliases)
    .where(eq(mailAliases.address, address))
    .limit(1);
  if (alias) {
    throw conflict(`${address} is already an alias.`, {
      summary: "Remove the alias first if this address should become a mailbox.",
      actions: [{ label: "Aliases", href: `/email/aliases?q=${encodeURIComponent(address)}` }],
    });
  }
}

/**
 * Runs one inline agent call and turns its failure into the API's
 * vocabulary. The connectivity check already happened, so an offline
 * error here is a race the client should simply retry.
 */
async function callAgent<T>(server: ServerRow, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AgentRpcError) throw fromAgentError(server.name, err.agentError);
    if (err instanceof AgentOfflineError) {
      // The shared builder, so this error carries the same remediation
      // (and the same link to this host) as every other agent_offline.
      throw agentOffline(server, `The agent on ${server.name} disconnected.`);
    }
    throw err;
  }
}

/** Postgres unique_violation, wherever the driver put the SQLSTATE. */
export function isUniqueViolation(err: unknown): boolean {
  for (let cursor = err, depth = 0; cursor && depth < 5; depth += 1) {
    if (typeof cursor === "object" && (cursor as { code?: unknown }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Mapping
 * ------------------------------------------------------------------ */

/** The alias addresses delivering to a mailbox, as one array column. */
function aliasesOf(mailboxId: typeof mailboxes.id) {
  return sql<
    string[]
  >`coalesce((select array_agg(a.address order by a.address) from mail_aliases a where a.mailbox_id = ${mailboxId}), '{}'::text[])`;
}

async function toMailServerApi(db: Database, row: MailServerRow): Promise<MailServer> {
  const id = row.mailServer.id;
  const [counts] = await db
    .select({
      domains: sql<number>`(select count(*) from mail_domains where mail_server_id = ${id})::int`,
      mailboxes: sql<number>`(select count(*) from mailboxes where server_id = ${row.server.id})::int`,
    })
    .from(sql`(select 1) as one`);
  const ms = row.mailServer;
  return {
    id,
    server_id: ms.serverId,
    server_name: row.server.name,
    status: ms.status,
    version: ms.version,
    install_complete: ms.installComplete,
    hostname: ms.hostname,
    primary_domain: ms.primaryDomain,
    admin_email: ms.adminEmail,
    sending_mode: ms.sendingMode,
    relay_provider: ms.relayProvider,
    console_url: ms.consoleUrl,
    steps: ms.steps,
    services: ms.services,
    checks: ms.checks,
    health: ms.health,
    certificate: ms.certificate ?? null,
    domain_count: counts?.domains ?? 0,
    mailbox_count: counts?.mailboxes ?? 0,
    last_error: ms.lastError,
    last_synced_at: ms.lastSyncedAt?.toISOString() ?? null,
    created_at: ms.createdAt.toISOString(),
    updated_at: ms.updatedAt.toISOString(),
  };
}

async function toMailDomainApi(db: Database, row: MailDomainRow): Promise<MailDomain> {
  const id = row.mailDomain.id;
  const [counts] = await db
    .select({
      mailboxes: sql<number>`(select count(*) from mailboxes where mail_domain_id = ${id})::int`,
      aliases: sql<number>`(select count(*) from mail_aliases where mail_domain_id = ${id})::int`,
    })
    .from(sql`(select 1) as one`);
  const md = row.mailDomain;
  return {
    id,
    domain_id: md.domainId,
    domain_name: row.domainName,
    server_id: md.serverId,
    server_name: row.server.name,
    mail_server_id: md.mailServerId,
    is_primary: md.isPrimary,
    status: md.status,
    dns_status: md.dnsStatus,
    dns_checked_at: md.dnsCheckedAt?.toISOString() ?? null,
    mailbox_count: counts?.mailboxes ?? 0,
    alias_count: counts?.aliases ?? 0,
    last_synced_at: md.lastSyncedAt?.toISOString() ?? null,
    created_at: md.createdAt.toISOString(),
    updated_at: md.updatedAt.toISOString(),
  };
}

function toMailboxApi(row: MailboxRow): Mailbox {
  const mb = row.mailbox;
  return {
    id: mb.id,
    mail_domain_id: mb.mailDomainId,
    domain_name: row.domainName,
    server_id: mb.serverId,
    server_name: row.server.name,
    address: mb.address,
    local_part: mb.localPart,
    display_name: mb.displayName,
    quota_bytes: mb.quotaBytes,
    status: mb.status,
    aliases: Array.isArray(row.aliases) ? row.aliases : parsePgArray(row.aliases),
    last_synced_at: mb.lastSyncedAt?.toISOString() ?? null,
    created_at: mb.createdAt.toISOString(),
    updated_at: mb.updatedAt.toISOString(),
  };
}

function toAliasApi(row: AliasRow): MailAlias {
  const a = row.alias;
  return {
    id: a.id,
    mail_domain_id: a.mailDomainId,
    domain_name: row.domainName,
    server_id: a.serverId,
    server_name: row.server.name,
    address: a.address,
    mailbox_id: a.mailboxId,
    mailbox_address: a.mailboxAddress,
    status: a.status,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  };
}

/** A driver that hands a text[] back as its wire form ("{a,b}") rather than an array. */
function parsePgArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const inner = value.replace(/^\{|\}$/g, "");
  if (!inner) return [];
  return inner.split(",").map((part) => part.replace(/^"|"$/g, ""));
}
