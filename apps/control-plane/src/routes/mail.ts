import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, gte, lte, ne, sql, type Database } from "@kaname/db";
import {
  domains,
  mailAliases,
  mailDomains,
  mailForwarders,
  mailLogEntries,
  mailboxes,
  servers,
} from "@kaname/db/schema";
import {
  bytes,
  createMailAliasInput,
  createMailDomainInput,
  createMailForwarderInput,
  createMailboxInput,
  idParam,
  mailAliasListQuery,
  mailAuthQuery,
  mailDomainListQuery,
  mailForwarderListQuery,
  mailLogListQuery,
  mailboxListQuery,
  resetMailboxPasswordInput,
  runMailAuthCheckInput,
  updateMailAliasInput,
  updateMailDomainInput,
  updateMailForwarderInput,
  updateMailboxInput,
  uuid,
  type CheckStatus,
  type Job,
  type MailAlias,
  type MailAuthSummary,
  type MailDomain,
  type MailForwarder,
  type MailLogEntry,
  type MailStatus,
  type Mailbox,
  type MethodResult,
  type Permission,
} from "@kaname/contract";
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
import { AgentOfflineError, AgentRpcError, type StreamHandle } from "../agent/hub.js";
import { agentUnsupported, conflict, notFound, type ApiException } from "../lib/errors.js";
import { MailAuthChecker } from "../services/mail-auth.js";
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

/* ------------------------------------------------------------------ *
 * Email: domains, mailboxes, aliases, forwarders, DNS authentication
 * and the transport log.
 *
 * Aliases and forwarders are maps, not rows, as far as the mail stack is
 * concerned: Postfix reads a whole table. So a create, an edit and a
 * delete all end the same way — the control-plane rows change, then the
 * complete map for that domain is applied wholesale. Anything else
 * leaves the host's copy and the panel's copy able to disagree.
 * ------------------------------------------------------------------ */

const TAIL_TIMEOUT_MS = 30 * 60_000;
const KEEPALIVE_MS = 20_000;

const MAIL_DOMAIN_SORTABLE = {
  domain: domains.name,
  status: mailDomains.status,
  checked_at: mailDomains.lastAuthCheckAt,
  created_at: mailDomains.createdAt,
} as const;

const MAILBOX_SORTABLE = {
  address: mailboxes.address,
  quota_bytes: mailboxes.quotaBytes,
  used_bytes: mailboxes.usedBytes,
  message_count: mailboxes.messageCount,
  status: mailboxes.status,
  last_login_at: mailboxes.lastLoginAt,
  created_at: mailboxes.createdAt,
} as const;

const ALIAS_SORTABLE = {
  address: mailAliases.address,
  enabled: mailAliases.enabled,
  created_at: mailAliases.createdAt,
} as const;

const FORWARDER_SORTABLE = {
  source: mailForwarders.source,
  destination: mailForwarders.destination,
  enabled: mailForwarders.enabled,
  created_at: mailForwarders.createdAt,
} as const;

const MAIL_LOG_SORTABLE = {
  ts: mailLogEntries.ts,
  status: mailLogEntries.status,
  from: mailLogEntries.fromAddress,
  queue_id: mailLogEntries.queueId,
  size_bytes: mailLogEntries.sizeBytes,
} as const;

const mailLogTailQuery = z.object({
  server_id: uuid,
  q: z.string().max(200).optional(),
  lines: z.coerce.number().int().min(1).max(5000).default(200),
});

const setQuotaInput = z.object({ quota_bytes: bytes });
const deleteMailboxInput = z.object({ delete_maildir: z.boolean().default(false) });

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  /* =============================== domains ========================== */

  app.get("/mail-domains", async (req, reply) => {
    const q = parseQuery(req, mailDomainListQuery);
    helpers(req).authorize("email.mailboxes:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.mailboxes:read", mailDomains.serverId),
      q.server_id ? eq(mailDomains.serverId, q.server_id) : null,
      q.status ? eq(mailDomains.status, toDbStatus(q.status)) : null,
      q.auth_status ? authStatusFilter(q.auth_status) : null,
      term
        ? sql`(lower(${domains.name}) like ${term} or lower(${mailDomains.mailHostname}) like ${term})`
        : null,
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

    const counted1 = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailDomains)
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where);
    const total = counted1[0]?.total ?? 0;

    const data = await Promise.all(rows.map((row) => toMailDomainApi(req.ctx.db, row)));
    return list(reply, data, paginate(total, q.page, q.per_page));
  });

  app.get("/mail-domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const ctx = await loadMailDomain(req, id, "email.mailboxes:read");
    return item(reply, await toMailDomainApi(req.ctx.db, ctx));
  });

  app.post("/mail-domains", async (req, reply) => {
    const body = parseBody(req, createMailDomainInput);
    const server = await loadServer(req, body.server_id, "email.mailboxes:write");

    if (
      req.ctx.hub.isConnected(server.id) &&
      !req.ctx.hub.capabilities(server.id).includes("mail")
    ) {
      throw agentUnsupported(server.name, "a mail stack");
    }

    const domainRows = await req.ctx.db
      .select()
      .from(domains)
      .where(eq(domains.id, body.domain_id))
      .limit(1);
    const domain = domainRows[0];
    if (!domain) throw notFound("Domain", body.domain_id);

    const existing = await req.ctx.db
      .select({ id: mailDomains.id })
      .from(mailDomains)
      .where(eq(mailDomains.domainId, body.domain_id))
      .limit(1);
    if (existing[0]) {
      throw conflict(`${domain.name} is already hosting mail.`, {
        summary:
          "A domain's mail lives on exactly one host; moving it is a migration, not an edit.",
        actions: [
          { label: "Open mail domain", href: `/email/mailboxes?mail_domain_id=${existing[0].id}` },
        ],
      });
    }

    // The HELO/MX name is deliberately not the apex: it needs its own A
    // record and its own SPF, and it must stay DNS-only when the apex is
    // proxied. `mail.<domain>` is the convention the checks assume.
    const mailHostname = `mail.${domain.name}`;

    const [row] = await req.ctx.db
      .insert(mailDomains)
      .values({
        domainId: body.domain_id,
        serverId: server.id,
        mailHostname,
        dkimSelector: body.dkim_selector,
        catchallTarget: body.catchall_target ?? null,
        status: "provisioning",
      })
      .returning();

    await req.ctx.db
      .update(domains)
      .set({ hasMail: true, updatedAt: new Date() })
      .where(eq(domains.id, body.domain_id));

    const job = await enqueueServerJob(req, {
      type: "mail.domain.provision",
      server,
      targetType: "mail_domain",
      targetId: row!.id,
      targetLabel: domain.name,
      params: {
        mail_domain_id: row!.id,
        domain: domain.name,
        mail_hostname: mailHostname,
        dkim_selector: body.dkim_selector,
        catchall_target: body.catchall_target ?? null,
      },
    });

    req.ctx.events.publish(
      "servers",
      "mail_domain.created",
      { server_id: server.id, mail_domain_id: row!.id, domain: domain.name },
      server.id,
    );
    return accepted(reply, job);
  });

  app.patch("/mail-domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateMailDomainInput);
    const ctx = await loadMailDomain(req, id, "email.mailboxes:write");
    const h = helpers(req);

    const [row] = await req.ctx.db
      .update(mailDomains)
      .set({
        ...(body.dkim_selector !== undefined ? { dkimSelector: body.dkim_selector } : {}),
        ...(body.catchall_target !== undefined ? { catchallTarget: body.catchall_target } : {}),
        ...(body.status !== undefined ? { status: toDbStatus(body.status) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(mailDomains.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "mail.domain.updated",
      targetType: "mail_domain",
      targetId: id,
      targetLabel: ctx.domainName,
      serverId: ctx.server.id,
      before: {
        dkim_selector: ctx.mailDomain.dkimSelector,
        catchall_target: ctx.mailDomain.catchallTarget,
        status: ctx.mailDomain.status,
      },
      after: body,
    });

    const job = await enqueueServerJob(req, {
      type: "mail.domain.provision",
      server: ctx.server,
      targetType: "mail_domain",
      targetId: id,
      targetLabel: ctx.domainName,
      params: {
        mail_domain_id: id,
        domain: ctx.domainName,
        mail_hostname: row!.mailHostname,
        dkim_selector: row!.dkimSelector,
        catchall_target: row!.catchallTarget,
      },
    });
    return accepted(reply, job);
  });

  app.delete("/mail-domains/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const ctx = await loadMailDomain(req, id, "email.mailboxes:delete");
    const h = helpers(req);

    const [counts] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(mailboxes)
      .where(eq(mailboxes.mailDomainId, id));
    if ((counts?.n ?? 0) > 0) {
      throw conflict(`${ctx.domainName} still has ${counts!.n} mailbox(es).`, {
        summary:
          "Removing the domain would leave those mailboxes on the host with nothing in Kaname pointing at them, and their mail undeliverable rather than deleted. Delete or move them first.",
        actions: [{ label: "Open mailboxes", href: `/email/mailboxes?mail_domain_id=${id}` }],
      });
    }

    // Two jobs under one correlation id: the maps are separate files on
    // the host, and clearing them is what actually stops routing.
    const correlationId = crypto.randomUUID();
    const aliasJob = await enqueueServerJob(req, {
      type: "mail.alias.apply",
      server: ctx.server,
      targetType: "mail_domain",
      targetId: id,
      targetLabel: ctx.domainName,
      params: { domain: ctx.domainName, aliases: [] },
      correlationId,
    });
    await enqueueServerJob(req, {
      type: "mail.forwarder.apply",
      server: ctx.server,
      targetType: "mail_domain",
      targetId: id,
      targetLabel: ctx.domainName,
      params: { domain: ctx.domainName, forwarders: [] },
      correlationId,
    });

    await req.ctx.db.delete(mailDomains).where(eq(mailDomains.id, id));
    await req.ctx.db
      .update(domains)
      .set({ hasMail: false, updatedAt: new Date() })
      .where(eq(domains.id, ctx.mailDomain.domainId));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "mail.domain.deleted",
      targetType: "mail_domain",
      targetId: id,
      targetLabel: ctx.domainName,
      serverId: ctx.server.id,
      before: { domain: ctx.domainName, mail_hostname: ctx.mailDomain.mailHostname },
    });
    req.ctx.events.publish(
      "servers",
      "mail_domain.deleted",
      { server_id: ctx.server.id, mail_domain_id: id, domain: ctx.domainName },
      ctx.server.id,
    );

    return accepted(reply, aliasJob);
  });

  /* ============================== mailboxes ========================= */

  app.get("/mailboxes", async (req, reply) => {
    const q = parseQuery(req, mailboxListQuery);
    helpers(req).authorize("email.mailboxes:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.mailboxes:read", mailboxes.serverId),
      q.mail_domain_id ? eq(mailboxes.mailDomainId, q.mail_domain_id) : null,
      q.domain ? eq(domains.name, q.domain) : null,
      q.server_id ? eq(mailboxes.serverId, q.server_id) : null,
      q.status ? eq(mailboxes.status, q.status) : null,
      q.over_quota
        ? sql`${mailboxes.quotaBytes} > 0 and ${mailboxes.usedBytes} >= ${mailboxes.quotaBytes}`
        : null,
      term
        ? sql`(lower(${mailboxes.address}) like ${term} or lower(coalesce(${mailboxes.displayName}, '')) like ${term})`
        : null,
    );

    const column = sortColumn(MAILBOX_SORTABLE, q.sort, "address");
    const rows = await req.ctx.db
      .select({ mailbox: mailboxes, domainName: domains.name, server: servers })
      .from(mailboxes)
      .innerJoin(mailDomains, eq(mailboxes.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailboxes.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted2 = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailboxes)
      .innerJoin(mailDomains, eq(mailboxes.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailboxes.serverId, servers.id))
      .where(where);
    const total = counted2[0]?.total ?? 0;

    return list(reply, rows.map(toMailboxApi), paginate(total, q.page, q.per_page));
  });

  app.get("/mailboxes/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadMailbox(req, id, "email.mailboxes:read");
    return item(reply, toMailboxApi(row));
  });

  app.post("/mailboxes", async (req, reply) => {
    const body = parseBody(req, createMailboxInput);
    const ctx = await loadMailDomain(req, body.mail_domain_id, "email.mailboxes:write");

    // local_part is lower-cased by the contract; the domain name is
    // compared case-insensitively too because the host does.
    const address = `${body.local_part}@${ctx.domainName.toLowerCase()}`;
    const existing = await req.ctx.db
      .select({ id: mailboxes.id, status: mailboxes.status })
      .from(mailboxes)
      .where(sql`lower(${mailboxes.address}) = ${address}`)
      .limit(1);
    if (existing[0]) {
      throw conflict(`${address} already exists.`, {
        summary:
          existing[0].status === "active"
            ? "Reset its password instead of creating a second mailbox at the same address."
            : "This mailbox never finished provisioning on the host. Delete it, then create it again.",
        actions: [{ label: "Open mailbox", href: `/email/mailboxes/${existing[0].id}` }],
      });
    }

    if (ctx.mailDomain.quotaTotal > 0 && body.quota_bytes > 0) {
      const [allocated] = await req.ctx.db
        .select({ total: sql<number>`coalesce(sum(${mailboxes.quotaBytes}), 0)::bigint` })
        .from(mailboxes)
        .where(eq(mailboxes.mailDomainId, ctx.mailDomain.id));
      const used = Number(allocated?.total ?? 0);
      if (used + body.quota_bytes > ctx.mailDomain.quotaTotal) {
        throw conflict(
          `${ctx.domainName} has ${formatBytes(ctx.mailDomain.quotaTotal - used)} of quota left, and this mailbox asks for ${formatBytes(body.quota_bytes)}.`,
          {
            summary:
              "Lower this mailbox's quota, raise the domain's, or reclaim quota from a mailbox that is not using it.",
            actions: [
              {
                label: "Open mail domain",
                href: `/email/mailboxes?mail_domain_id=${ctx.mailDomain.id}`,
              },
            ],
          },
        );
      }
    }

    const [row] = await req.ctx.db
      .insert(mailboxes)
      .values({
        mailDomainId: ctx.mailDomain.id,
        serverId: ctx.server.id,
        address,
        localPart: body.local_part,
        displayName: body.display_name ?? null,
        quotaBytes: body.quota_bytes,
        status: "provisioning",
      })
      .returning();

    const job = await enqueueServerJob(req, {
      type: "mail.mailbox.create",
      server: ctx.server,
      targetType: "mailbox",
      targetId: row!.id,
      targetLabel: address,
      params: {
        mailbox_id: row!.id,
        address,
        password: body.password,
        quota_bytes: body.quota_bytes,
        ...(body.display_name ? { display_name: body.display_name } : {}),
      },
    });

    req.ctx.events.publish(
      "servers",
      "mailbox.created",
      { server_id: ctx.server.id, mailbox_id: row!.id, address },
      ctx.server.id,
    );
    return accepted(reply, job);
  });

  app.patch("/mailboxes/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateMailboxInput);
    const before = await loadMailbox(req, id, "email.mailboxes:write");
    const h = helpers(req);

    const [row] = await req.ctx.db
      .update(mailboxes)
      .set({
        ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
        ...(body.quota_bytes !== undefined ? { quotaBytes: body.quota_bytes } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(mailboxes.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "mail.mailbox.updated",
      targetType: "mailbox",
      targetId: id,
      targetLabel: before.mailbox.address,
      serverId: before.server.id,
      before: {
        display_name: before.mailbox.displayName,
        quota_bytes: before.mailbox.quotaBytes,
        status: before.mailbox.status,
      },
      after: body,
    });

    const job = await enqueueServerJob(req, {
      type: "mail.mailbox.update",
      server: before.server,
      targetType: "mailbox",
      targetId: id,
      targetLabel: before.mailbox.address,
      params: {
        address: before.mailbox.address,
        quota_bytes: row!.quotaBytes,
        active: row!.status === "active",
        ...(row!.displayName ? { display_name: row!.displayName } : {}),
      },
    });
    return accepted(reply, job);
  });

  app.delete("/mailboxes/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, deleteMailboxInput);
    const row = await loadMailbox(req, id, "email.mailboxes:delete");

    // A row whose create never landed has no account on the host, so
    // with the agent away there is nothing to queue against: waiting for
    // it to come back would only be a wait to delete a record. Once the
    // agent is present the job runs and tolerates "not found" itself.
    const neverProvisioned =
      row.mailbox.status === "provisioning" || row.mailbox.status === "error";
    if (neverProvisioned && !req.ctx.hub.isConnected(row.server.id)) {
      await req.ctx.db.delete(mailboxes).where(eq(mailboxes.id, id));
      await req.ctx.audit.record({
        actor: helpers(req).actor(),
        action: "mail.mailbox.deleted",
        targetType: "mailbox",
        targetId: id,
        targetLabel: row.mailbox.address,
        serverId: row.server.id,
        before: { address: row.mailbox.address, status: row.mailbox.status },
        metadata: { reason: "never provisioned; removed without a job" },
      });
      req.ctx.events.publish(
        "servers",
        "mailbox.deleted",
        { server_id: row.server.id, mailbox_id: id, address: row.mailbox.address },
        row.server.id,
      );
      return item(reply, { job: null, removed: true });
    }

    const job = await enqueueServerJob(req, {
      type: "mail.mailbox.delete",
      server: row.server,
      targetType: "mailbox",
      targetId: id,
      targetLabel: row.mailbox.address,
      params: {
        mailbox_id: id,
        address: row.mailbox.address,
        delete_maildir: body.delete_maildir,
      },
    });
    return accepted(reply, job);
  });

  app.post("/mailboxes/:id/reset-password", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, resetMailboxPasswordInput);
    const row = await loadMailbox(req, id, "email.mailboxes:write");

    const job = await enqueueServerJob(req, {
      type: "mail.mailbox.reset_password",
      server: row.server,
      targetType: "mailbox",
      targetId: id,
      targetLabel: row.mailbox.address,
      // revoke_sessions rides along with the operator's intent even
      // though the mail RPC only needs the credential: a password change
      // on its own does not close an IMAP session that is already open.
      params: {
        address: row.mailbox.address,
        password: body.password,
        revoke_sessions: body.revoke_sessions,
      },
    });
    return accepted(reply, job);
  });

  app.post("/mailboxes/:id/quota", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, setQuotaInput);
    const row = await loadMailbox(req, id, "email.mailboxes:write");
    const h = helpers(req);

    if (body.quota_bytes > 0 && body.quota_bytes < row.mailbox.usedBytes) {
      throw conflict(
        `${row.mailbox.address} already stores ${formatBytes(row.mailbox.usedBytes)}, which is more than the ${formatBytes(body.quota_bytes)} quota you asked for.`,
        {
          summary:
            "The mailbox would be over quota the moment the change lands, so it would stop accepting mail immediately. Set a quota above current usage, or have the user clear space first.",
          actions: [{ label: "Open mailbox", href: `/email/mailboxes/${id}` }],
        },
      );
    }

    await req.ctx.db
      .update(mailboxes)
      .set({ quotaBytes: body.quota_bytes, updatedAt: new Date() })
      .where(eq(mailboxes.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "mail.mailbox.quota_changed",
      targetType: "mailbox",
      targetId: id,
      targetLabel: row.mailbox.address,
      serverId: row.server.id,
      before: { quota_bytes: row.mailbox.quotaBytes },
      after: { quota_bytes: body.quota_bytes },
    });

    const job = await enqueueServerJob(req, {
      type: "mail.mailbox.update",
      server: row.server,
      targetType: "mailbox",
      targetId: id,
      targetLabel: row.mailbox.address,
      params: { address: row.mailbox.address, quota_bytes: body.quota_bytes },
    });
    return accepted(reply, job);
  });

  /* =============================== aliases ========================== */

  app.get("/mail-aliases", async (req, reply) => {
    const q = parseQuery(req, mailAliasListQuery);
    helpers(req).authorize("email.routing:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.routing:read", mailDomains.serverId),
      q.mail_domain_id ? eq(mailAliases.mailDomainId, q.mail_domain_id) : null,
      q.domain ? eq(domains.name, q.domain) : null,
      q.server_id ? eq(mailDomains.serverId, q.server_id) : null,
      q.enabled !== undefined ? eq(mailAliases.enabled, q.enabled) : null,
      term
        ? sql`(lower(${mailAliases.address}) like ${term} or exists (select 1 from unnest(${mailAliases.destinations}) d where lower(d) like ${term}))`
        : null,
    );

    const column = sortColumn(ALIAS_SORTABLE, q.sort, "address");
    const rows = await req.ctx.db
      .select({ alias: mailAliases, domainName: domains.name, server: servers })
      .from(mailAliases)
      .innerJoin(mailDomains, eq(mailAliases.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted3 = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailAliases)
      .innerJoin(mailDomains, eq(mailAliases.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where);
    const total = counted3[0]?.total ?? 0;

    return list(reply, rows.map(toAliasApi), paginate(total, q.page, q.per_page));
  });

  app.get("/mail-aliases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadAlias(req, id, "email.routing:read");
    return item(reply, toAliasApi(row));
  });

  app.post("/mail-aliases", async (req, reply) => {
    const body = parseBody(req, createMailAliasInput);
    const ctx = await loadMailDomain(req, body.mail_domain_id, "email.routing:write");
    await assertAliasAddress(req, ctx, body.address);

    const [row] = await guardUnique(
      () =>
        req.ctx.db
          .insert(mailAliases)
          .values({
            mailDomainId: ctx.mailDomain.id,
            address: body.address,
            destinations: body.destinations,
            enabled: body.enabled,
          })
          .returning(),
      () => aliasTaken(body.address),
    );

    await recordRoutingChange(req, ctx, "mail.alias.created", row!.id, body.address, null, body);
    return accepted(reply, await applyAliases(req, ctx));
  });

  app.patch("/mail-aliases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateMailAliasInput);
    const before = await loadAlias(req, id, "email.routing:write");
    const ctx = await loadMailDomain(req, before.alias.mailDomainId, "email.routing:write");

    // The same rules as a create, on what the row will say afterwards:
    // an edit is how an alias would otherwise leave its domain.
    await assertAliasAddress(req, ctx, body.address ?? before.alias.address, id);

    await guardUnique(
      () =>
        req.ctx.db
          .update(mailAliases)
          .set({
            ...(body.address !== undefined ? { address: body.address } : {}),
            ...(body.destinations !== undefined ? { destinations: body.destinations } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            updatedAt: new Date(),
          })
          .where(eq(mailAliases.id, id)),
      () => aliasTaken(body.address ?? before.alias.address),
    );

    await recordRoutingChange(
      req,
      ctx,
      "mail.alias.updated",
      id,
      before.alias.address,
      {
        address: before.alias.address,
        destinations: before.alias.destinations,
        enabled: before.alias.enabled,
      },
      body,
    );
    return accepted(reply, await applyAliases(req, ctx));
  });

  app.delete("/mail-aliases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const before = await loadAlias(req, id, "email.routing:delete");
    const ctx = await loadMailDomain(req, before.alias.mailDomainId, "email.routing:delete");

    await req.ctx.db.delete(mailAliases).where(eq(mailAliases.id, id));
    await recordRoutingChange(
      req,
      ctx,
      "mail.alias.deleted",
      id,
      before.alias.address,
      { address: before.alias.address, destinations: before.alias.destinations },
      null,
    );
    return accepted(reply, await applyAliases(req, ctx));
  });

  /* ============================= forwarders ========================= */

  app.get("/mail-forwarders", async (req, reply) => {
    const q = parseQuery(req, mailForwarderListQuery);
    helpers(req).authorize("email.routing:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "email.routing:read", mailDomains.serverId),
      q.mail_domain_id ? eq(mailForwarders.mailDomainId, q.mail_domain_id) : null,
      q.domain ? eq(domains.name, q.domain) : null,
      q.server_id ? eq(mailDomains.serverId, q.server_id) : null,
      q.enabled !== undefined ? eq(mailForwarders.enabled, q.enabled) : null,
      term
        ? sql`(lower(${mailForwarders.source}) like ${term} or lower(${mailForwarders.destination}) like ${term})`
        : null,
    );

    const column = sortColumn(FORWARDER_SORTABLE, q.sort, "source");
    const rows = await req.ctx.db
      .select({ forwarder: mailForwarders, domainName: domains.name, server: servers })
      .from(mailForwarders)
      .innerJoin(mailDomains, eq(mailForwarders.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted4 = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailForwarders)
      .innerJoin(mailDomains, eq(mailForwarders.mailDomainId, mailDomains.id))
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(where);
    const total = counted4[0]?.total ?? 0;

    return list(reply, rows.map(toForwarderApi), paginate(total, q.page, q.per_page));
  });

  app.get("/mail-forwarders/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const row = await loadForwarder(req, id, "email.routing:read");
    return item(reply, toForwarderApi(row));
  });

  app.post("/mail-forwarders", async (req, reply) => {
    const body = parseBody(req, createMailForwarderInput);
    const ctx = await loadMailDomain(req, body.mail_domain_id, "email.routing:write");
    await assertForwarder(req, ctx, body.source, body.destination);

    const [row] = await guardUnique(
      () =>
        req.ctx.db
          .insert(mailForwarders)
          .values({
            mailDomainId: ctx.mailDomain.id,
            source: body.source,
            destination: body.destination,
            keepCopy: body.keep_copy,
            enabled: body.enabled,
          })
          .returning(),
      () => forwarderTaken(body.source, body.destination),
    );

    await recordRoutingChange(req, ctx, "mail.forwarder.created", row!.id, body.source, null, body);
    return accepted(reply, await applyForwarders(req, ctx));
  });

  app.patch("/mail-forwarders/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateMailForwarderInput);
    const before = await loadForwarder(req, id, "email.routing:write");
    const ctx = await loadMailDomain(req, before.forwarder.mailDomainId, "email.routing:write");

    const source = body.source ?? before.forwarder.source;
    const destination = body.destination ?? before.forwarder.destination;
    await assertForwarder(req, ctx, source, destination, id);

    await guardUnique(
      () =>
        req.ctx.db
          .update(mailForwarders)
          .set({
            ...(body.source !== undefined ? { source: body.source } : {}),
            ...(body.destination !== undefined ? { destination: body.destination } : {}),
            ...(body.keep_copy !== undefined ? { keepCopy: body.keep_copy } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            updatedAt: new Date(),
          })
          .where(eq(mailForwarders.id, id)),
      () => forwarderTaken(source, destination),
    );

    await recordRoutingChange(
      req,
      ctx,
      "mail.forwarder.updated",
      id,
      before.forwarder.source,
      {
        source: before.forwarder.source,
        destination: before.forwarder.destination,
        keep_copy: before.forwarder.keepCopy,
        enabled: before.forwarder.enabled,
      },
      body,
    );
    return accepted(reply, await applyForwarders(req, ctx));
  });

  app.delete("/mail-forwarders/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const before = await loadForwarder(req, id, "email.routing:delete");
    const ctx = await loadMailDomain(req, before.forwarder.mailDomainId, "email.routing:delete");

    await req.ctx.db.delete(mailForwarders).where(eq(mailForwarders.id, id));
    await recordRoutingChange(
      req,
      ctx,
      "mail.forwarder.deleted",
      id,
      before.forwarder.source,
      { source: before.forwarder.source, destination: before.forwarder.destination },
      null,
    );
    return accepted(reply, await applyForwarders(req, ctx));
  });

  /* ========================= DNS authentication ===================== */

  app.get("/mail-auth", async (req, reply) => {
    const q = parseQuery(req, mailAuthQuery);
    const ctx = await loadMailDomain(req, q.mail_domain_id, "email.auth:read");
    const h = helpers(req);
    const checker = new MailAuthChecker({ db: req.ctx.db, hub: req.ctx.hub, log: req.ctx.log });

    if (!q.refresh) {
      return item(reply, await checker.report(ctx.mailDomain.id));
    }

    // Every check is a DNS query or a read-only agent call, so a refresh
    // can answer inline instead of becoming a job (KD-008 permits
    // read-only pass-through). The queued form still exists at
    // POST /mail-auth/check for scheduled and background runs.
    h.authorize("email.auth:exec", ctx.server.id);
    const report = await checker.run(ctx.mailDomain.id);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "mail.auth.checked",
      targetType: "mail_domain",
      targetId: ctx.mailDomain.id,
      targetLabel: ctx.domainName,
      serverId: ctx.server.id,
      metadata: { overall: report.overall, resolver: report.resolver_used },
    });
    req.ctx.events.publish(
      "servers",
      "mail.auth.checked",
      { server_id: ctx.server.id, mail_domain_id: ctx.mailDomain.id, overall: report.overall },
      ctx.server.id,
    );

    return item(reply, report);
  });

  app.post("/mail-auth/check", async (req, reply) => {
    const body = parseBody(req, runMailAuthCheckInput);
    const ctx = await loadMailDomain(req, body.mail_domain_id, "email.auth:exec");

    const job = await enqueueServerJob(req, {
      type: "mail.auth.check",
      server: ctx.server,
      targetType: "mail_domain",
      targetId: ctx.mailDomain.id,
      targetLabel: ctx.domainName,
      params: {
        mail_domain_id: ctx.mailDomain.id,
        ...(body.checks ? { checks: body.checks } : {}),
        ...(body.resolver ? { resolver: body.resolver } : {}),
      },
    });
    return accepted(reply, job);
  });

  /* ============================== mail logs ========================= */

  app.get("/mail-logs", async (req, reply) => {
    const q = parseQuery(req, mailLogListQuery);
    helpers(req).authorize("email.logs:read");

    const term = searchTerm(q.q);
    const address = q.address?.trim().toLowerCase();
    const where = combine(
      scopeFilter(req, "email.logs:read", mailLogEntries.serverId),
      q.server_id ? eq(mailLogEntries.serverId, q.server_id) : null,
      q.direction ? eq(mailLogEntries.direction, q.direction) : null,
      q.status ? eq(mailLogEntries.status, q.status) : null,
      q.queue_id ? eq(mailLogEntries.queueId, q.queue_id) : null,
      q.since ? gte(mailLogEntries.ts, new Date(q.since)) : null,
      q.until ? lte(mailLogEntries.ts, new Date(q.until)) : null,
      q.mail_domain_id ? domainAddressFilter(q.mail_domain_id) : null,
      address
        ? sql`(lower(${mailLogEntries.fromAddress}) = ${address} or exists (select 1 from unnest(${mailLogEntries.toAddresses}) t where lower(t) = ${address}))`
        : null,
      term
        ? sql`(lower(${mailLogEntries.message}) like ${term} or lower(coalesce(${mailLogEntries.subject}, '')) like ${term} or lower(${mailLogEntries.fromAddress}) like ${term})`
        : null,
    );

    const column = sortColumn(MAIL_LOG_SORTABLE, q.sort, "ts");
    const rows = await req.ctx.db
      .select({ entry: mailLogEntries, server: servers })
      .from(mailLogEntries)
      .innerJoin(servers, eq(mailLogEntries.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted5 = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mailLogEntries)
      .where(where);
    const total = counted5[0]?.total ?? 0;

    return list(reply, rows.map(toMailLogApi), paginate(total, q.page, q.per_page));
  });

  app.get("/mail-logs/tail", async (req, reply) => {
    const q = parseQuery(req, mailLogTailQuery);
    const server = await loadConnectedServer(req, q.server_id, "email.logs:read");
    // Decided before the headers go out: once the response is an event
    // stream a refusal can only be a frame, not the JSON error with a
    // remediation that the rest of the API answers with.
    if (!req.ctx.hub.capabilities(server.id).includes("mail")) {
      throw agentUnsupported(server.name, "a mail stack");
    }

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
        async (data) => {
          for (const line of data.split("\n")) {
            if (!line.trim()) continue;
            if (reply.raw.writableEnded || reply.raw.destroyed) return;
            const payload = {
              server_id: server.id,
              server_name: server.name,
              ts: new Date().toISOString(),
              line,
            };
            // A browser that is behind holds the next line, and the agent with it.
            if (!reply.raw.write(`event: mail.log\ndata: ${JSON.stringify(payload)}\n\n`)) {
              await drained(reply.raw);
            }
          }
        },
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

interface MailDomainContext {
  mailDomain: typeof mailDomains.$inferSelect;
  domainName: string;
  server: ServerRow;
}

async function loadMailDomain(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<MailDomainContext> {
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
}

async function loadMailbox(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<MailboxRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({ mailbox: mailboxes, domainName: domains.name, server: servers })
    .from(mailboxes)
    .innerJoin(mailDomains, eq(mailboxes.mailDomainId, mailDomains.id))
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .innerJoin(servers, eq(mailboxes.serverId, servers.id))
    .where(eq(mailboxes.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Mailbox", id);
  h.authorize(permission, row.server.id);
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
    .innerJoin(servers, eq(mailDomains.serverId, servers.id))
    .where(eq(mailAliases.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Alias", id);
  h.authorize(permission, row.server.id);
  return row;
}

interface ForwarderRow {
  forwarder: typeof mailForwarders.$inferSelect;
  domainName: string;
  server: ServerRow;
}

async function loadForwarder(
  req: FastifyRequest,
  id: string,
  permission: Permission,
): Promise<ForwarderRow> {
  const h = helpers(req);
  h.authorize(permission);

  const rows = await req.ctx.db
    .select({ forwarder: mailForwarders, domainName: domains.name, server: servers })
    .from(mailForwarders)
    .innerJoin(mailDomains, eq(mailForwarders.mailDomainId, mailDomains.id))
    .innerJoin(domains, eq(mailDomains.domainId, domains.id))
    .innerJoin(servers, eq(mailDomains.serverId, servers.id))
    .where(eq(mailForwarders.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("Forwarder", id);
  h.authorize(permission, row.server.id);
  return row;
}

/* ------------------------------------------------------------------ *
 * Routing rules
 *
 * One set of checks for a create and an edit alike, applied to what the
 * row will say afterwards. Postfix matches map keys case-insensitively,
 * so duplicates are judged the same way even though the unique indexes
 * are not (the contract lower-cases new addresses; older rows may not be).
 * ------------------------------------------------------------------ */

function aliasTaken(address: string, id?: string): ApiException {
  return conflict(`${address} is already aliased.`, {
    summary: "Edit the existing alias to add another destination — one address maps once.",
    actions: id ? [{ label: "Open alias", href: `/email/aliases/${id}` }] : [],
  });
}

function forwarderTaken(source: string, destination: string, id?: string): ApiException {
  return conflict(`${source} already forwards to ${destination}.`, {
    summary: "Add a second forwarder with a different destination, or edit the existing one.",
    actions: id ? [{ label: "Open forwarder", href: `/email/forwarders/${id}` }] : [],
  });
}

function assertInDomain(ctx: MailDomainContext, address: string): void {
  if (address.toLowerCase().endsWith(`@${ctx.domainName.toLowerCase()}`)) return;
  throw conflict(`${address} is not an address in ${ctx.domainName}.`, {
    summary:
      "A rule rewrites an address this domain receives, so its left-hand side has to belong to the domain. To route mail for another domain, add the rule on that domain instead.",
    actions: [],
  });
}

async function assertAliasAddress(
  req: FastifyRequest,
  ctx: MailDomainContext,
  address: string,
  excludeId?: string,
): Promise<void> {
  assertInDomain(ctx, address);
  const existing = await req.ctx.db
    .select({ id: mailAliases.id })
    .from(mailAliases)
    .where(
      and(
        sql`lower(${mailAliases.address}) = ${address.toLowerCase()}`,
        excludeId ? ne(mailAliases.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  if (existing[0]) throw aliasTaken(address, existing[0].id);
}

async function assertForwarder(
  req: FastifyRequest,
  ctx: MailDomainContext,
  source: string,
  destination: string,
  excludeId?: string,
): Promise<void> {
  assertInDomain(ctx, source);
  if (source.toLowerCase() === destination.toLowerCase()) {
    throw conflict(`${source} forwards to itself.`, {
      summary:
        "That is a delivery loop: the mail stack would bounce the message with a maximum-hop error.",
      actions: [],
    });
  }
  const existing = await req.ctx.db
    .select({ id: mailForwarders.id })
    .from(mailForwarders)
    .where(
      and(
        sql`lower(${mailForwarders.source}) = ${source.toLowerCase()}`,
        sql`lower(${mailForwarders.destination}) = ${destination.toLowerCase()}`,
        excludeId ? ne(mailForwarders.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  if (existing[0]) throw forwarderTaken(source, destination, existing[0].id);
}

/** Postgres unique_violation, wherever the driver put the SQLSTATE. */
export function isUniqueViolation(err: unknown): boolean {
  for (let cursor = err, depth = 0; cursor && depth < 5; depth += 1) {
    if (typeof cursor === "object" && (cursor as { code?: unknown }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The checks above run before the write, so two operators racing on the
 * same address is the only way the unique index still fires; it should
 * answer like the check did rather than as an unexplained 500.
 */
async function guardUnique<T>(write: () => Promise<T>, onTaken: () => ApiException): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err)) throw onTaken();
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Wholesale map application
 * ------------------------------------------------------------------ */

/**
 * Disabled entries are simply absent from the map: the host has no
 * concept of a disabled alias, so "enabled" is the panel's word for
 * "present in what we apply".
 */
async function applyAliases(req: FastifyRequest, ctx: MailDomainContext): Promise<Job> {
  const rows = await req.ctx.db
    .select({ address: mailAliases.address, destinations: mailAliases.destinations })
    .from(mailAliases)
    .where(and(eq(mailAliases.mailDomainId, ctx.mailDomain.id), eq(mailAliases.enabled, true)));

  return enqueueServerJob(req, {
    type: "mail.alias.apply",
    server: ctx.server,
    targetType: "mail_domain",
    targetId: ctx.mailDomain.id,
    targetLabel: ctx.domainName,
    params: {
      domain: ctx.domainName,
      aliases: rows.map((r) => ({ address: r.address, destinations: r.destinations })),
    },
  });
}

async function applyForwarders(req: FastifyRequest, ctx: MailDomainContext): Promise<Job> {
  const rows = await req.ctx.db
    .select({
      source: mailForwarders.source,
      destination: mailForwarders.destination,
      keepCopy: mailForwarders.keepCopy,
    })
    .from(mailForwarders)
    .where(
      and(eq(mailForwarders.mailDomainId, ctx.mailDomain.id), eq(mailForwarders.enabled, true)),
    );

  return enqueueServerJob(req, {
    type: "mail.forwarder.apply",
    server: ctx.server,
    targetType: "mail_domain",
    targetId: ctx.mailDomain.id,
    targetLabel: ctx.domainName,
    params: {
      domain: ctx.domainName,
      forwarders: rows.map((r) => ({
        source: r.source,
        destination: r.destination,
        keep_copy: r.keepCopy,
      })),
    },
  });
}

/** The apply job audits the map; this records which row the operator touched. */
async function recordRoutingChange(
  req: FastifyRequest,
  ctx: MailDomainContext,
  action: string,
  targetId: string,
  targetLabel: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await req.ctx.audit.record({
    actor: helpers(req).actor(),
    action,
    targetType: action.startsWith("mail.alias") ? "mail_alias" : "mail_forwarder",
    targetId,
    targetLabel,
    serverId: ctx.server.id,
    ...(before !== null ? { before } : {}),
    ...(after !== null ? { after } : {}),
  });
  req.ctx.events.publish(
    "servers",
    action,
    { server_id: ctx.server.id, mail_domain_id: ctx.mailDomain.id, target_id: targetId },
    ctx.server.id,
  );
}

/* ------------------------------------------------------------------ *
 * Row to API
 * ------------------------------------------------------------------ */

async function toMailDomainApi(db: Database, row: MailDomainContext): Promise<MailDomain> {
  const id = row.mailDomain.id;
  const [counts] = await db
    .select({
      mailboxes: sql<number>`(select count(*) from mailboxes where mail_domain_id = ${id})::int`,
      aliases: sql<number>`(select count(*) from mail_aliases where mail_domain_id = ${id})::int`,
      forwarders: sql<number>`(select count(*) from mail_forwarders where mail_domain_id = ${id})::int`,
      quotaUsed: sql<number>`(select coalesce(sum(used_bytes), 0) from mailboxes where mail_domain_id = ${id})::bigint`,
      pass: sql<number>`(select count(*) from mail_auth_checks where mail_domain_id = ${id} and status = 'pass')::int`,
      warn: sql<number>`(select count(*) from mail_auth_checks where mail_domain_id = ${id} and status = 'warn')::int`,
      fail: sql<number>`(select count(*) from mail_auth_checks where mail_domain_id = ${id} and status = 'fail')::int`,
      unknown: sql<number>`(select count(*) from mail_auth_checks where mail_domain_id = ${id} and status = 'unknown')::int`,
    })
    .from(sql`(select 1) as one`);

  const summary: MailAuthSummary = {
    pass: counts?.pass ?? 0,
    warn: counts?.warn ?? 0,
    fail: counts?.fail ?? 0,
    unknown: counts?.unknown ?? 0,
    worst: worstStatus(counts),
    checked_at: row.mailDomain.lastAuthCheckAt?.toISOString() ?? null,
  };

  return {
    id,
    domain_id: row.mailDomain.domainId,
    domain_name: row.domainName,
    server_id: row.mailDomain.serverId,
    server_name: row.server.name,
    status: toApiStatus(row.mailDomain.status),
    dkim_selector: row.mailDomain.dkimSelector,
    dkim_public_key: row.mailDomain.dkimPublicKey,
    catchall_target: row.mailDomain.catchallTarget,
    mailbox_count: counts?.mailboxes ?? 0,
    alias_count: counts?.aliases ?? 0,
    forwarder_count: counts?.forwarders ?? 0,
    quota_used: Number(counts?.quotaUsed ?? 0),
    quota_total: row.mailDomain.quotaTotal,
    auth_summary: summary,
    created_at: row.mailDomain.createdAt.toISOString(),
    updated_at: row.mailDomain.updatedAt.toISOString(),
  };
}

function toMailboxApi(row: MailboxRow): Mailbox {
  const quota = row.mailbox.quotaBytes;
  return {
    id: row.mailbox.id,
    mail_domain_id: row.mailbox.mailDomainId,
    domain_name: row.domainName,
    server_id: row.mailbox.serverId,
    server_name: row.server.name,
    address: row.mailbox.address,
    local_part: row.mailbox.localPart,
    display_name: row.mailbox.displayName,
    quota_bytes: quota,
    used_bytes: row.mailbox.usedBytes,
    used_percent: quota > 0 ? Math.min(100, (row.mailbox.usedBytes / quota) * 100) : 0,
    status: row.mailbox.status,
    message_count: row.mailbox.messageCount,
    last_login_at: row.mailbox.lastLoginAt?.toISOString() ?? null,
    last_synced_at: (row.mailbox.lastSyncedAt ?? row.mailbox.updatedAt).toISOString(),
    created_at: row.mailbox.createdAt.toISOString(),
    updated_at: row.mailbox.updatedAt.toISOString(),
  };
}

function toAliasApi(row: AliasRow): MailAlias {
  return {
    id: row.alias.id,
    mail_domain_id: row.alias.mailDomainId,
    domain_name: row.domainName,
    server_id: row.server.id,
    server_name: row.server.name,
    address: row.alias.address,
    destinations: row.alias.destinations,
    enabled: row.alias.enabled,
    created_at: row.alias.createdAt.toISOString(),
    updated_at: row.alias.updatedAt.toISOString(),
  };
}

function toForwarderApi(row: ForwarderRow): MailForwarder {
  return {
    id: row.forwarder.id,
    mail_domain_id: row.forwarder.mailDomainId,
    domain_name: row.domainName,
    server_id: row.server.id,
    server_name: row.server.name,
    source: row.forwarder.source,
    destination: row.forwarder.destination,
    keep_copy: row.forwarder.keepCopy,
    enabled: row.forwarder.enabled,
    created_at: row.forwarder.createdAt.toISOString(),
    updated_at: row.forwarder.updatedAt.toISOString(),
  };
}

function toMailLogApi(row: {
  entry: typeof mailLogEntries.$inferSelect;
  server: ServerRow;
}): MailLogEntry {
  return {
    id: row.entry.id,
    server_id: row.entry.serverId,
    server_name: row.server.name,
    ts: row.entry.ts.toISOString(),
    queue_id: row.entry.queueId ?? "",
    direction: row.entry.direction,
    from: row.entry.fromAddress,
    to: row.entry.toAddresses,
    subject: row.entry.subject,
    status: row.entry.status as MailLogEntry["status"],
    relay: row.entry.relay,
    delay_seconds: row.entry.delaySeconds ?? 0,
    size_bytes: row.entry.sizeBytes ?? 0,
    dsn: row.entry.dsn,
    message: row.entry.message,
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/**
 * The table stores "disabled" where the API says "suspended". One place
 * to translate, rather than a cast at every call site.
 */
type DbMailDomainStatus = "active" | "provisioning" | "error" | "disabled";

function toApiStatus(value: DbMailDomainStatus): MailStatus {
  return value === "disabled" ? "suspended" : value;
}

function toDbStatus(value: MailStatus): DbMailDomainStatus {
  return value === "suspended" ? "disabled" : value;
}

/** Filters on the worst check, not on "has one of these", so "pass" means pass. */
function authStatusFilter(status: CheckStatus) {
  const has = (value: CheckStatus) =>
    sql`exists (select 1 from mail_auth_checks c where c.mail_domain_id = ${mailDomains.id} and c.status = ${value})`;

  if (status === "fail") return has("fail");
  if (status === "warn") return sql`${has("warn")} and not ${has("fail")}`;
  if (status === "unknown") {
    return sql`${has("unknown")} and not ${has("fail")} and not ${has("warn")}`;
  }
  return sql`${has("pass")} and not ${has("fail")} and not ${has("warn")} and not ${has("unknown")}`;
}

/** A log line belongs to a mail domain when either envelope end does. */
function domainAddressFilter(mailDomainId: string) {
  return sql`exists (
    select 1 from mail_domains md
    join domains d on d.id = md.domain_id
    where md.id = ${mailDomainId}
      and (
        lower(${mailLogEntries.fromAddress}) like '%@' || lower(d.name)
        or exists (select 1 from unnest(${mailLogEntries.toAddresses}) t where lower(t) like '%@' || lower(d.name))
      )
  )`;
}

function worstStatus(
  counts: { pass: number; warn: number; fail: number; unknown: number } | undefined,
): CheckStatus {
  if (!counts) return "unknown";
  if (counts.fail > 0) return "fail";
  if (counts.warn > 0) return "warn";
  if (counts.unknown > 0 || counts.pass === 0) return "unknown";
  return "pass";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

function formatBytes(value: number): string {
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
