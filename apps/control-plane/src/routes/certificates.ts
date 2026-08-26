import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, sql, type Database } from "@kaname/db";
import { certificates, domains, servers, sites } from "@kaname/db/schema";
import {
  CERT_EXPIRY_SOON_DAYS,
  certificateListQuery,
  certificateUrgency,
  idParam,
  issueCertificateInput,
  renewCertificateInput,
  updateCertificateInput,
  type CertStatus,
  type Certificate,
  type Permission,
  type Remediation,
} from "@kaname/contract";
import { z } from "zod";
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
import { ApiException, conflict, notFound } from "../lib/errors.js";
import {
  combine,
  enqueueServerJob,
  loadServer,
  scopeFilter,
  searchTerm,
  sortColumn,
} from "./_shared.js";
import { loadDomainRow } from "./domains.js";

/* ------------------------------------------------------------------ *
 * Certificates.
 *
 * ACME runs on the host, so issuance, renewal and revocation are all
 * jobs (KD-008). What this module owns is the row, the renewal policy,
 * and — the part that matters when something breaks — turning a failed
 * challenge into the exact record or URL the operator has to fix.
 * ------------------------------------------------------------------ */

const SORTABLE = {
  subject: certificates.subject,
  status: certificates.status,
  issuer: certificates.issuer,
  expires_at: certificates.expiresAt,
  issued_at: certificates.issuedAt,
  created_at: certificates.createdAt,
} as const;

/** Defaulted so a revoke needs no request body when the reason is unspecified. */
const revokeCertificateInput = z
  .object({ reason: z.string().max(64).default("unspecified") })
  .default({});

const certificateSelection = {
  certificate: certificates,
  domain_name: domains.name,
  server_name: servers.name,
};

type CertificateApiRow = {
  certificate: typeof certificates.$inferSelect;
  domain_name: string | null;
  server_name: string;
};

export async function certificateRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ list ------------------------------ */

  app.get("/certificates", async (req, reply) => {
    const q = parseQuery(req, certificateListQuery);
    helpers(req).authorize("websites.ssl:read");

    const term = searchTerm(q.q);
    const where = combine(
      scopeFilter(req, "websites.ssl:read", certificates.serverId),
      q.server_id ? eq(certificates.serverId, q.server_id) : null,
      q.domain_id ? eq(certificates.domainId, q.domain_id) : null,
      q.status ? eq(certificates.status, q.status) : null,
      q.auto_renew !== undefined ? eq(certificates.autoRenew, q.auto_renew) : null,
      q.expiring_within_days ? expiringWithin(q.expiring_within_days) : null,
      term
        ? sql`(lower(${certificates.subject}) like ${term}
               or exists (select 1 from unnest(${certificates.sans}) san where lower(san) like ${term}))`
        : null,
    );

    const column = sortColumn(SORTABLE, q.sort, "expires_at");
    const rows = await req.ctx.db
      .select(certificateSelection)
      .from(certificates)
      .innerJoin(servers, eq(certificates.serverId, servers.id))
      .leftJoin(domains, eq(certificates.domainId, domains.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(certificates)
      .where(where);

    return list(
      reply,
      rows.map(certificateToApi),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  /* ---------------------------- expiring ---------------------------- */

  app.get("/certificates/expiring", async (req, reply) => {
    const q = parseQuery(req, certificateListQuery);
    helpers(req).authorize("websites.ssl:read");

    const within = q.expiring_within_days ?? CERT_EXPIRY_SOON_DAYS;
    const where = combine(
      scopeFilter(req, "websites.ssl:read", certificates.serverId),
      q.server_id ? eq(certificates.serverId, q.server_id) : null,
      expiringWithin(within),
      // A revoked certificate is already dealt with; it is not an expiry.
      sql`${certificates.status} <> 'revoked'`,
    );

    const rows = await req.ctx.db
      .select(certificateSelection)
      .from(certificates)
      .innerJoin(servers, eq(certificates.serverId, servers.id))
      .leftJoin(domains, eq(certificates.domainId, domains.id))
      .where(where)
      // Soonest first: this list is a work queue, not a browse view.
      .orderBy(asc(certificates.expiresAt))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(certificates)
      .where(where);

    return list(
      reply,
      rows.map(certificateToApi),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  /* ----------------------------- detail ----------------------------- */

  app.get("/certificates/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    await loadCertificateRow(req, id, "websites.ssl:read");
    return item(reply, await certificateApi(req.ctx.db, id));
  });

  /* ----------------------------- issue ------------------------------ */

  app.post("/certificates", async (req, reply) => {
    const body = parseBody(req, issueCertificateInput);
    const server = await loadServer(req, body.server_id, "websites.ssl:write");
    const domain = await loadDomainRow(req, body.domain_id, "websites.ssl:write");
    const h = helpers(req);

    if (body.challenge === "dns-01" && domain.dnsProvider === "manual") {
      throw new ApiException(
        "precondition_failed",
        `${domain.name} uses manual DNS, so Kaname cannot publish the dns-01 challenge record for it.`,
        {
          remediation: {
            summary: `A dns-01 challenge needs Kaname to write _acme-challenge.${domain.name} and remove it again within the ACME timeout. Move the zone to an API-driven provider, or issue over http-01 instead.`,
            actions: [
              { label: "Domain settings", href: `/websites/domains/${domain.id}` },
              { label: "Use http-01", action: "certificates.issue_http" },
            ],
          },
        },
      );
    }

    const site = domain.siteId
      ? ((await req.ctx.db.select().from(sites).where(eq(sites.id, domain.siteId)).limit(1))[0] ??
        null)
      : null;

    if (body.challenge === "http-01") {
      if (!site) {
        throw new ApiException(
          "precondition_failed",
          `${domain.name} is not attached to a site, so there is no webroot to serve the http-01 challenge from.`,
          {
            remediation: {
              summary: `Let's Encrypt fetches http://${domain.name}/.well-known/acme-challenge/<token> over plain HTTP. Attach the domain to a site on ${server.name}, or issue over dns-01 instead.`,
              actions: [
                { label: "Attach to a site", href: `/websites/domains/${domain.id}` },
                { label: "Use dns-01", action: "certificates.issue_dns" },
              ],
            },
          },
        );
      }
      if (site.serverId !== server.id) {
        throw new ApiException(
          "precondition_failed",
          `${domain.name} is served by a different host than the one the certificate would be installed on.`,
          {
            detail: { site_server_id: site.serverId, certificate_server_id: server.id },
            remediation: {
              summary: `The http-01 challenge is answered by whichever host ${domain.name} resolves to, so it has to be the same host that runs certbot. Issue on the site's own server, or switch to dns-01.`,
              actions: [
                { label: "Open the site", href: `/websites/sites/${site.id}` },
                { label: "Use dns-01", action: "certificates.issue_dns" },
              ],
            },
          },
        );
      }
    }

    const subject = domain.name;
    const existing = await req.ctx.db
      .select({ id: certificates.id, status: certificates.status })
      .from(certificates)
      .where(and(eq(certificates.serverId, server.id), eq(certificates.subject, subject)))
      .limit(1);
    if (existing[0]) {
      throw conflict(`${server.name} already holds a certificate for ${subject}.`, {
        summary:
          "Renew it instead of issuing a second one — Let's Encrypt counts duplicates against a weekly limit of five, and two certificates for one name means one of them silently stops being served.",
        actions: [
          { label: "Open it", href: `/websites/ssl/${existing[0].id}` },
          { label: "Renew instead", action: "certificates.renew" },
        ],
      });
    }

    const [row] = await req.ctx.db
      .insert(certificates)
      .values({
        domainId: domain.id,
        serverId: server.id,
        subject,
        sans: body.sans,
        issuer: body.staging ? "Let's Encrypt (staging)" : "Let's Encrypt",
        challenge: body.challenge,
        keyType: body.key_type,
        status: "pending",
        autoRenew: body.auto_renew,
      })
      .returning();

    const job = await enqueueServerJob(req, {
      type: "cert.issue",
      server,
      targetType: "certificate",
      targetId: row!.id,
      targetLabel: subject,
      params: {
        certificate_id: row!.id,
        domains: [subject, ...body.sans],
        challenge: body.challenge,
        email: body.contact_email,
        ...(body.challenge === "http-01" && site ? { webroot: site.webroot } : {}),
        key_type: body.key_type,
        staging: body.staging,
      },
    });

    await req.ctx.db
      .update(certificates)
      .set({ lastRenewalJobId: job.id, updatedAt: new Date() })
      .where(eq(certificates.id, row!.id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "certificate.requested",
      targetType: "certificate",
      targetId: row!.id,
      targetLabel: subject,
      serverId: server.id,
      jobId: job.id,
      after: { subject, sans: body.sans, challenge: body.challenge, staging: body.staging },
    });
    req.ctx.events.publish(
      "certificates",
      "certificate.requested",
      { certificate_id: row!.id, subject, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ----------------------------- renew ------------------------------ */

  app.post("/certificates/:id/renew", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, renewCertificateInput.default({}));
    const cert = await loadCertificateRow(req, id, "websites.ssl:write");
    const server = await loadServer(req, cert.serverId, "websites.ssl:write");
    const h = helpers(req);

    if (cert.status === "revoked") {
      throw conflict(`${cert.subject} was revoked and cannot be renewed.`, {
        summary:
          "A revoked certificate is dead to every client that checks OCSP. Issue a new one for the same name.",
        actions: [{ label: "Issue a certificate", action: "certificates.issue" }],
      });
    }
    if (cert.status === "none" || !cert.issuedAt) {
      throw new ApiException(
        "precondition_failed",
        `${cert.subject} has never been issued, so there is nothing to renew.`,
        {
          remediation: {
            summary:
              "Run the first issuance instead; renewal reuses the account key and the existing certificate on disk.",
            actions: [{ label: "Issue now", action: "certificates.issue" }],
          },
        },
      );
    }

    const job = await enqueueServerJob(req, {
      type: "cert.renew",
      server,
      targetType: "certificate",
      targetId: id,
      targetLabel: cert.subject,
      params: { certificate_id: id, subject: cert.subject, force: body.force },
    });

    await req.ctx.db
      .update(certificates)
      .set({ status: "pending", lastRenewalJobId: job.id, updatedAt: new Date() })
      .where(eq(certificates.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "certificate.renew_requested",
      targetType: "certificate",
      targetId: id,
      targetLabel: cert.subject,
      serverId: server.id,
      jobId: job.id,
      metadata: { force: body.force, expires_at: cert.expiresAt?.toISOString() ?? null },
    });
    req.ctx.events.publish(
      "certificates",
      "certificate.renew_requested",
      { certificate_id: id, subject: cert.subject, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ----------------------------- revoke ----------------------------- */

  app.post("/certificates/:id/revoke", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, revokeCertificateInput);
    const cert = await loadCertificateRow(req, id, "websites.ssl:delete");
    const server = await loadServer(req, cert.serverId, "websites.ssl:delete");
    const h = helpers(req);

    if (cert.status === "revoked") {
      throw conflict(`${cert.subject} is already revoked.`, {
        summary:
          "Nothing further to do. Issue a replacement if the name still needs to serve HTTPS.",
        actions: [{ label: "Issue a certificate", action: "certificates.issue" }],
      });
    }

    const job = await enqueueServerJob(req, {
      type: "cert.revoke",
      server,
      targetType: "certificate",
      targetId: id,
      targetLabel: cert.subject,
      params: { certificate_id: id, subject: cert.subject, reason: body.reason },
    });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "certificate.revoke_requested",
      targetType: "certificate",
      targetId: id,
      targetLabel: cert.subject,
      serverId: server.id,
      jobId: job.id,
      metadata: { reason: body.reason },
    });
    req.ctx.events.publish(
      "certificates",
      "certificate.revoke_requested",
      { certificate_id: id, subject: cert.subject, job_id: job.id },
      server.id,
    );

    return accepted(reply, job);
  });

  /* ---------------------------- auto-renew --------------------------- */

  app.patch("/certificates/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateCertificateInput);
    const before = await loadCertificateRow(req, id, "websites.ssl:write");
    const h = helpers(req);

    if (body.auto_renew === undefined) {
      return item(reply, await certificateApi(req.ctx.db, id));
    }

    await req.ctx.db
      .update(certificates)
      .set({ autoRenew: body.auto_renew, updatedAt: new Date() })
      .where(eq(certificates.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "certificate.updated",
      targetType: "certificate",
      targetId: id,
      targetLabel: before.subject,
      serverId: before.serverId,
      before: { auto_renew: before.autoRenew },
      after: { auto_renew: body.auto_renew },
    });
    req.ctx.events.publish(
      "certificates",
      "certificate.updated",
      { certificate_id: id, auto_renew: body.auto_renew },
      before.serverId,
    );

    return item(reply, await certificateApi(req.ctx.db, id));
  });
}

/* ------------------------------------------------------------------ */

/** Loads a certificate and asserts the caller holds `permission` on its host. */
async function loadCertificateRow(
  req: FastifyRequest,
  certificateId: string,
  permission: Permission,
): Promise<typeof certificates.$inferSelect> {
  const rows = await req.ctx.db
    .select()
    .from(certificates)
    .where(eq(certificates.id, certificateId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Certificate", certificateId);
  helpers(req).authorize(permission, row.serverId);
  return row;
}

async function certificateApi(db: Database, certificateId: string): Promise<Certificate> {
  const rows = await db
    .select(certificateSelection)
    .from(certificates)
    .innerJoin(servers, eq(certificates.serverId, servers.id))
    .leftJoin(domains, eq(certificates.domainId, domains.id))
    .where(eq(certificates.id, certificateId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("Certificate", certificateId);
  return certificateToApi(row);
}

function certificateToApi(row: CertificateApiRow): Certificate {
  const c = row.certificate;
  const days = c.expiresAt ? Math.floor((c.expiresAt.getTime() - Date.now()) / 86_400_000) : null;

  return {
    id: c.id,
    // Nullable in the schema only for certificates installed out of band;
    // everything issued through Kaname carries a domain.
    domain_id: c.domainId as string,
    domain_name: row.domain_name ?? c.subject,
    server_id: c.serverId,
    server_name: row.server_name,
    subject: c.subject,
    sans: c.sans,
    issuer: c.issuer,
    challenge: c.challenge,
    key_type: c.keyType,
    status: presentedStatus(c.status, days),
    issued_at: c.issuedAt?.toISOString() ?? null,
    expires_at: c.expiresAt?.toISOString() ?? null,
    days_remaining: days,
    auto_renew: c.autoRenew,
    last_renewal_at: c.lastRenewalAt?.toISOString() ?? null,
    last_error: certificateError(row),
    installed_path: c.installedPath,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

/* ---------------------------- internals ---------------------------- */

function expiringWithin(days: number) {
  return sql`${certificates.expiresAt} is not null
    and ${certificates.expiresAt} < now() + ${sql.raw(`interval '${days} days'`)}`;
}

/**
 * "expiring" is derived, not stored: the renewal window is a single
 * threshold in the contract, and the dashboard, the SSL list and the
 * site page must never disagree about where it sits.
 */
function presentedStatus(stored: CertStatus, days: number | null): CertStatus {
  if (stored !== "active" || days === null) return stored;
  const urgency = certificateUrgency(days);
  if (urgency === "expired") return "expired";
  return urgency === "ok" ? "active" : "expiring";
}

/**
 * Turns whatever certbot printed into something the operator can act
 * on. A failed ACME challenge always has one concrete cause — a record
 * that is not published, or a URL that did not answer — so name it.
 */
function certificateError(row: CertificateApiRow): Certificate["last_error"] {
  const c = row.certificate;
  if (!c.lastError) return null;

  const message = c.lastError;
  const at = c.updatedAt.toISOString();

  if (/rate limit|too many certificates|duplicate certificate/i.test(message)) {
    return {
      code: "acme_rate_limited",
      message,
      at,
      remediation: {
        summary: `Let's Encrypt allows five certificates per week for the same set of names. Wait for the window to roll, or rehearse against the staging directory first — staging issuance does not count against it.`,
        actions: [
          { label: "Issue against staging", action: "certificates.issue_staging" },
          { label: "Open the domain", href: `/websites/domains/${c.domainId ?? ""}` },
        ],
      },
    };
  }

  if (!/challenge|authorization|acme|well-known|_acme-challenge/i.test(message)) {
    return { code: "issuance_failed", message, at, remediation: null };
  }

  if (c.challenge === "dns-01") {
    const record =
      message.match(/_acme-challenge\.[A-Za-z0-9._-]+/)?.[0] ?? `_acme-challenge.${c.subject}`;
    return {
      code: "acme_dns_challenge_failed",
      message,
      at,
      remediation: dnsChallengeRemediation(record, c.domainId),
    };
  }

  const url =
    message.match(/https?:\/\/[^\s"'<>]*\/\.well-known\/acme-challenge\/[^\s"'<>]+/)?.[0] ??
    `http://${c.subject}/.well-known/acme-challenge/`;
  return {
    code: "acme_http_challenge_failed",
    message,
    at,
    remediation: {
      summary:
        `Let's Encrypt could not fetch ${url}. ${c.subject} must resolve to ${row.server_name} over plain HTTP, reach it without redirecting to another host, and the site's webroot must serve /.well-known/acme-challenge.`.slice(
          0,
          500,
        ),
      actions: [
        { label: "Copy the URL", copy: url },
        { label: "Check DNS", href: `/websites/dns?domain_id=${c.domainId ?? ""}` },
        { label: "Retry", action: "certificates.renew" },
      ],
    },
  };
}

function dnsChallengeRemediation(record: string, domainId: string | null): Remediation {
  return {
    summary:
      `Let's Encrypt could not read the validation TXT record at ${record}. Kaname publishes it automatically once the domain uses an API-driven DNS provider; on manual DNS it has to be added, and removed again, by hand within the ACME timeout.`.slice(
        0,
        500,
      ),
    actions: [
      { label: "Copy the record name", copy: record },
      { label: "Open DNS", href: `/websites/dns?domain_id=${domainId ?? ""}` },
      { label: "Retry", action: "certificates.renew" },
    ],
  };
}
