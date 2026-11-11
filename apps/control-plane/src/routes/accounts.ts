import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, inArray, isNull, sql, type Database } from "@kaname/db";
import {
  accountLimits,
  dbDatabases,
  dbInstances,
  domains,
  mailDomains,
  mailboxes,
  resellerBranding as brandingTable,
  resourceOwners,
  servers,
  sessions,
  sites,
  users,
} from "@kaname/db/schema";
import {
  QUOTA_FIELDS,
  RESOURCE_KIND_LABELS,
  assignResourceInput,
  createClientInput,
  createResellerInput,
  idParam,
  resellerBranding,
  resourceKind,
  resourceParam,
  updateClientInput,
  updateResellerInput,
  updateViewModeInput,
  type AccountContext,
  type AccountQuota,
  type Client,
  type InvitedClient,
  type InvitedReseller,
  type OwnedResource,
  type Placement,
  type Reseller,
  type ResellerBranding,
  type ResourceKind,
  type UserInvitation,
} from "@kaname/contract";
import { z } from "zod";
import { helpers, item, noContent, parseBody, parseParams, parseQuery } from "../http/plugin.js";
import { ApiException, conflict, notFound } from "../lib/errors.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import type { Principal } from "../services/auth.js";
import { isOwnedBy, quotaOf, usageFor } from "./_ownership.js";

/* ------------------------------------------------------------------ *
 * Accounts: view mode, resellers, clients (KD-039).
 *
 * Three groups of routes, three different authorities:
 *
 *   /me/*          self-scoped. Being the principal is the check.
 *   /resellers/*   an operator managing resellers. RBAC: admin.users:*.
 *   /reseller/*    a reseller managing its own clients. The check is
 *                  "is a reseller", and every row it touches is looked
 *                  up through `parent_id = me`, so one reseller can
 *                  never reach another's client by guessing an id.
 *
 * A client has no routes here beyond /me: what it may do to its
 * resources is the ordinary resource routes, scoped by ownership.
 * ------------------------------------------------------------------ */

const INVITE_TTL_MS = 7 * 86_400_000;

type UserRow = typeof users.$inferSelect;

const kindQuery = z.object({
  kind: resourceKind,
  q: z.string().max(200).optional(),
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /* ================================ me ============================== */

  app.get("/me", async (req, reply) => {
    const principal = userPrincipal(req);
    const user = await loadUserRow(req.ctx.db, principal.id);
    return item(reply, await accountContextFor(req.ctx.db, user, principal));
  });

  /*
   * A display preference, kept on the account so it follows the person
   * to the next browser. It decides which pages the shell lists and
   * nothing else: no route reads it.
   */
  app.put("/me/view-mode", async (req, reply) => {
    const principal = userPrincipal(req);
    const body = parseBody(req, updateViewModeInput);
    const [row] = await req.ctx.db
      .update(users)
      .set({ viewMode: body.view_mode, updatedAt: new Date() })
      .where(eq(users.id, principal.id))
      .returning();
    if (!row) throw notFound("User", principal.id);
    return item(reply, await accountContextFor(req.ctx.db, row, principal));
  });

  /** Where a reseller or client may put something new. */
  app.get("/me/placement", async (req, reply) => {
    const principal = userPrincipal(req);
    const account = principal.scoped;
    if (!account) {
      throw new ApiException("bad_request", "Placement is for reseller and client accounts.", {
        remediation: {
          summary: "An operator picks a server from the fleet instead.",
          actions: [{ label: "Servers", href: "/infrastructure/servers" }],
        },
      });
    }
    const empty: Placement = { servers: [], db_instances: [], mail_domains: [] };
    if (account.serverIds.length === 0) return item(reply, empty);
    const serverIds = [...account.serverIds];

    const [hosts, instances, mail] = await Promise.all([
      req.ctx.db
        .select({
          id: servers.id,
          name: servers.name,
          hostname: servers.hostname,
          address: servers.address,
        })
        .from(servers)
        .where(inArray(servers.id, serverIds))
        .orderBy(asc(servers.name)),
      req.ctx.db
        .select({
          id: dbInstances.id,
          engine: dbInstances.engine,
          version: dbInstances.version,
          server_id: dbInstances.serverId,
          server_name: servers.name,
        })
        .from(dbInstances)
        .innerJoin(servers, eq(dbInstances.serverId, servers.id))
        .where(inArray(dbInstances.serverId, serverIds))
        .orderBy(asc(servers.name)),
      // Only mail domains standing on a domain the caller owns: those are
      // the ones POST /mailboxes will accept from them.
      req.ctx.db
        .select({ id: mailDomains.id, name: domains.name, server_id: mailDomains.serverId })
        .from(mailDomains)
        .innerJoin(domains, eq(mailDomains.domainId, domains.id))
        .innerJoin(
          resourceOwners,
          and(eq(resourceOwners.kind, "domain"), eq(resourceOwners.resourceId, domains.id)),
        )
        .where(
          and(
            inArray(mailDomains.serverId, serverIds),
            inArray(resourceOwners.ownerId, [...account.ownerIds]),
          ),
        )
        .orderBy(asc(domains.name)),
    ]);

    const data: Placement = {
      servers: hosts.map((h) => ({ ...h, address: h.address ?? null })),
      db_instances: instances.map((i) => ({
        ...i,
        name: `${i.engine}${i.version ? ` ${i.version}` : ""} on ${i.server_name}`,
        version: i.version ?? null,
      })),
      mail_domains: mail,
    };
    return item(reply, data);
  });

  /* ============================ resellers =========================== */

  app.get("/resellers", async (req, reply) => {
    helpers(req).authorize("admin.users:read");
    const rows = await req.ctx.db
      .select()
      .from(users)
      .where(eq(users.audience, "reseller"))
      .orderBy(asc(users.name));
    return item(reply, await Promise.all(rows.map((row) => serializeReseller(req.ctx.db, row))));
  });

  app.post("/resellers", async (req, reply) => {
    const body = parseBody(req, createResellerInput);
    const h = helpers(req);
    h.authorize("admin.users:write");

    await assertServersExist(req.ctx.db, body.server_ids);
    const { row, invite } = await inviteAccount(req, {
      email: body.email,
      name: body.name,
      audience: "reseller",
      parentId: null,
      sendInvite: body.send_invite,
    });
    await writeLimits(req.ctx.db, row.id, { serverIds: body.server_ids, quota: body.quota });
    if (body.branding) await writeBranding(req.ctx.db, row.id, body.branding);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "reseller.created",
      targetType: "user",
      targetId: row.id,
      targetLabel: row.email,
      after: { email: row.email, name: row.name, server_ids: body.server_ids, quota: body.quota },
    });
    req.ctx.events.publish("audit", "reseller.created", { user_id: row.id });

    const created: InvitedReseller = { ...(await serializeReseller(req.ctx.db, row)), invite };
    return item(reply, created, 201);
  });

  app.get("/resellers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("admin.users:read");
    return item(reply, await serializeReseller(req.ctx.db, await loadReseller(req.ctx.db, id)));
  });

  app.patch("/resellers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateResellerInput);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const before = await loadReseller(req.ctx.db, id);
    if (body.server_ids) await assertServersExist(req.ctx.db, body.server_ids);
    assertCanActivate(before, body.status);

    const row = await updateAccount(req.ctx.db, before, body);
    await writeLimits(req.ctx.db, id, { serverIds: body.server_ids, quota: body.quota });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "reseller.updated",
      targetType: "user",
      targetId: id,
      targetLabel: row.email,
      before: { name: before.name, status: before.status },
      after: body,
    });
    req.ctx.events.publish("audit", "reseller.updated", { user_id: id });
    return item(reply, await serializeReseller(req.ctx.db, row));
  });

  app.put("/resellers/:id/branding", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, resellerBranding);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const row = await loadReseller(req.ctx.db, id);
    await writeBranding(req.ctx.db, id, body);
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "reseller.branding_set",
      targetType: "user",
      targetId: id,
      targetLabel: row.email,
      after: body,
    });
    return item(reply, await serializeReseller(req.ctx.db, row));
  });

  app.delete("/resellers/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("admin.users:delete");

    const row = await loadReseller(req.ctx.db, id);
    const clients = await clientRows(req.ctx.db, id);
    if (clients.length > 0) {
      throw conflict(
        `${row.name} still has ${clients.length} client${clients.length === 1 ? "" : "s"}.`,
        {
          summary:
            "Removing a reseller would leave its clients with nowhere to run. Remove or move the clients first, or suspend the reseller instead.",
          actions: [{ label: "Open the reseller", href: `/administration/resellers/${id}` }],
        },
      );
    }

    // Its ownership rows go with it (cascade): what it owned is the install's again.
    await req.ctx.db.delete(users).where(eq(users.id, id));
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "reseller.deleted",
      targetType: "user",
      targetId: id,
      targetLabel: row.email,
      before: { email: row.email, name: row.name },
    });
    req.ctx.events.publish("audit", "reseller.deleted", { user_id: id });
    return noContent(reply);
  });

  app.get("/resellers/:id/clients", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("admin.users:read");
    await loadReseller(req.ctx.db, id);
    const rows = await clientRows(req.ctx.db, id);
    return item(reply, await Promise.all(rows.map((row) => serializeClient(req.ctx.db, row))));
  });

  app.get("/resellers/:id/resources", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("admin.users:read");
    await loadReseller(req.ctx.db, id);
    return item(reply, await ownedResources(req.ctx.db, await poolOf(req.ctx.db, id)));
  });

  /** Resources nobody owns yet: what an operator can hand to a reseller. */
  app.get("/resources/unowned", async (req, reply) => {
    const q = parseQuery(req, kindQuery);
    helpers(req).authorize("admin.users:write");
    return item(reply, await unownedResources(req.ctx.db, q.kind, q.q));
  });

  /*
   * An operator hands an existing resource to a reseller. It has to be
   * on one of the reseller's servers (or the reseller could see it and
   * do nothing with it) and fit the reseller's allowance.
   */
  app.post("/resellers/:id/resources", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, assignResourceInput);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const row = await loadReseller(req.ctx.db, id);
    const resource = await describeResource(req.ctx.db, body.kind, body.resource_id);
    const limits = await limitsRow(req.ctx.db, id);
    if (resource.server_id && !limits.serverIds.includes(resource.server_id)) {
      throw conflict(`${resource.label} is on a server ${row.name} has not been given.`, {
        summary: "Add that server to the reseller first, then hand over the resource.",
        actions: [{ label: "Open the reseller", href: `/administration/resellers/${id}` }],
      });
    }
    const pool = await poolOf(req.ctx.db, id);
    if (!(await isOwnedBy(req.ctx.db, body.kind, body.resource_id, pool))) {
      await assertRoom(req.ctx.db, pool, await quotaOf(req.ctx.db, id), body.kind, row.name);
    }
    await setOwner(req.ctx.db, body.kind, body.resource_id, id, h.actor().id);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "resource.assigned",
      targetType: body.kind,
      targetId: body.resource_id,
      targetLabel: resource.label,
      metadata: { owner_id: id, owner: row.email },
    });
    return item(reply, await ownedResources(req.ctx.db, pool));
  });

  app.delete("/resellers/:id/resources/:kind/:resourceId", async (req, reply) => {
    const { id, kind, resourceId } = parseParams(req, resourceParam);
    const h = helpers(req);
    h.authorize("admin.users:write");

    await loadReseller(req.ctx.db, id);
    const pool = await poolOf(req.ctx.db, id);
    if (!(await isOwnedBy(req.ctx.db, kind, resourceId, pool))) {
      throw notFound(RESOURCE_KIND_LABELS[kind].one, resourceId);
    }
    await req.ctx.db
      .delete(resourceOwners)
      .where(and(eq(resourceOwners.kind, kind), eq(resourceOwners.resourceId, resourceId)));
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "resource.released",
      targetType: kind,
      targetId: resourceId,
      metadata: { from_reseller_id: id },
    });
    return noContent(reply);
  });

  /* ======================= a reseller's own area ==================== */

  app.get("/reseller/clients", async (req, reply) => {
    const me = resellerPrincipal(req);
    const rows = await clientRows(req.ctx.db, me.id);
    return item(reply, await Promise.all(rows.map((row) => serializeClient(req.ctx.db, row))));
  });

  app.post("/reseller/clients", async (req, reply) => {
    const me = resellerPrincipal(req);
    const body = parseBody(req, createClientInput);
    const h = helpers(req);

    const ceiling = await quotaOf(req.ctx.db, me.id);
    assertWithin(body.quota, ceiling);

    const { row, invite } = await inviteAccount(req, {
      email: body.email,
      name: body.name,
      audience: "client",
      parentId: me.id,
      sendInvite: body.send_invite,
    });
    await writeLimits(req.ctx.db, row.id, { quota: body.quota });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "client.created",
      targetType: "user",
      targetId: row.id,
      targetLabel: row.email,
      after: { email: row.email, name: row.name, quota: body.quota },
    });

    const created: InvitedClient = { ...(await serializeClient(req.ctx.db, row)), invite };
    return item(reply, created, 201);
  });

  app.get("/reseller/clients/:id", async (req, reply) => {
    const me = resellerPrincipal(req);
    const { id } = parseParams(req, idParam);
    return item(reply, await serializeClient(req.ctx.db, await loadClient(req.ctx.db, me.id, id)));
  });

  app.patch("/reseller/clients/:id", async (req, reply) => {
    const me = resellerPrincipal(req);
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateClientInput);
    const h = helpers(req);

    const before = await loadClient(req.ctx.db, me.id, id);
    if (body.quota) assertWithin(body.quota, await quotaOf(req.ctx.db, me.id));
    assertCanActivate(before, body.status);

    const row = await updateAccount(req.ctx.db, before, body);
    await writeLimits(req.ctx.db, id, { quota: body.quota });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "client.updated",
      targetType: "user",
      targetId: id,
      targetLabel: row.email,
      before: { name: before.name, status: before.status },
      after: body,
    });
    return item(reply, await serializeClient(req.ctx.db, row));
  });

  app.delete("/reseller/clients/:id", async (req, reply) => {
    const me = resellerPrincipal(req);
    const { id } = parseParams(req, idParam);
    const h = helpers(req);

    const row = await loadClient(req.ctx.db, me.id, id);
    // What the client held goes back to the reseller rather than to the
    // install: the reseller is still answerable for it.
    await req.ctx.db
      .update(resourceOwners)
      .set({ ownerId: me.id, assignedBy: me.id })
      .where(eq(resourceOwners.ownerId, id));
    await req.ctx.db.delete(users).where(eq(users.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "client.deleted",
      targetType: "user",
      targetId: id,
      targetLabel: row.email,
      before: { email: row.email, name: row.name },
    });
    return noContent(reply);
  });

  /** Everything the reseller answers for: its own resources and each client's. */
  app.get("/reseller/resources", async (req, reply) => {
    const me = resellerPrincipal(req);
    return item(reply, await ownedResources(req.ctx.db, me.scoped!.ownerIds));
  });

  app.get("/reseller/clients/:id/resources", async (req, reply) => {
    const me = resellerPrincipal(req);
    const { id } = parseParams(req, idParam);
    await loadClient(req.ctx.db, me.id, id);
    return item(reply, await ownedResources(req.ctx.db, [id]));
  });

  /*
   * Hands one of the reseller's resources to one of its clients. Both
   * ends are checked against the reseller: the client by parent, the
   * resource by owner. It has to fit the client's own allowance; the
   * reseller's total does not change, since it was already counted.
   */
  app.post("/reseller/clients/:id/resources", async (req, reply) => {
    const me = resellerPrincipal(req);
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, assignResourceInput);
    const h = helpers(req);

    const target = await loadClient(req.ctx.db, me.id, id);
    if (!(await isOwnedBy(req.ctx.db, body.kind, body.resource_id, me.scoped!.ownerIds))) {
      throw notFound(RESOURCE_KIND_LABELS[body.kind].one, body.resource_id);
    }
    const resource = await describeResource(req.ctx.db, body.kind, body.resource_id);
    if (!(await isOwnedBy(req.ctx.db, body.kind, body.resource_id, [id]))) {
      await assertRoom(req.ctx.db, [id], await quotaOf(req.ctx.db, id), body.kind, target.name);
    }
    await setOwner(req.ctx.db, body.kind, body.resource_id, id, me.id);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "resource.assigned",
      targetType: body.kind,
      targetId: body.resource_id,
      targetLabel: resource.label,
      metadata: { owner_id: id, owner: target.email },
    });
    return item(reply, await ownedResources(req.ctx.db, [id]));
  });

  /** Takes a resource back from a client. It returns to the reseller. */
  app.delete("/reseller/clients/:id/resources/:kind/:resourceId", async (req, reply) => {
    const me = resellerPrincipal(req);
    const { id, kind, resourceId } = parseParams(req, resourceParam);
    const h = helpers(req);

    await loadClient(req.ctx.db, me.id, id);
    if (!(await isOwnedBy(req.ctx.db, kind, resourceId, [id]))) {
      throw notFound(RESOURCE_KIND_LABELS[kind].one, resourceId);
    }
    await setOwner(req.ctx.db, kind, resourceId, me.id, me.id);
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "resource.released",
      targetType: kind,
      targetId: resourceId,
      metadata: { from_client_id: id },
    });
    return noContent(reply);
  });

  app.get("/reseller/branding", async (req, reply) => {
    const me = resellerPrincipal(req);
    return item(reply, await brandingOf(req.ctx.db, me.id));
  });

  app.put("/reseller/branding", async (req, reply) => {
    const me = resellerPrincipal(req);
    const body = parseBody(req, resellerBranding);
    await writeBranding(req.ctx.db, me.id, body);
    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "reseller.branding_set",
      targetType: "user",
      targetId: me.id,
      targetLabel: me.email ?? me.name,
      after: body,
    });
    return item(reply, await brandingOf(req.ctx.db, me.id));
  });
}

/* ------------------------------------------------------------------ *
 * Who is asking
 * ------------------------------------------------------------------ */

function userPrincipal(req: FastifyRequest): Principal {
  const principal = helpers(req).requirePrincipal();
  if (principal.kind !== "user") {
    throw new ApiException("bad_request", "An API key has no account of its own.", {
      remediation: {
        summary: "View mode and account details belong to a signed-in person.",
        actions: [{ label: "Sign in", href: "/login" }],
      },
    });
  }
  return principal;
}

/** The caller, if and only if they are a reseller with a satisfied session. */
function resellerPrincipal(req: FastifyRequest): Principal {
  const principal = userPrincipal(req);
  if (!principal.mfaSatisfied) {
    throw new ApiException("totp_required", "Two-factor authentication is required.");
  }
  if (principal.scoped?.audience !== "reseller") {
    throw new ApiException("forbidden", "This area is for reseller accounts.", {
      remediation: {
        summary:
          "Clients are managed by the reseller they belong to. An operator manages resellers under Administration.",
        actions: [{ label: "Resellers", href: "/administration/resellers" }],
      },
    });
  }
  return principal;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

async function loadUserRow(db: Database, id: string): Promise<UserRow> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!rows[0]) throw notFound("User", id);
  return rows[0];
}

async function loadReseller(db: Database, id: string): Promise<UserRow> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.audience, "reseller")))
    .limit(1);
  if (!rows[0]) throw notFound("Reseller", id);
  return rows[0];
}

/** A client of this reseller, or a 404: never "exists, but is someone else's". */
async function loadClient(db: Database, resellerId: string, id: string): Promise<UserRow> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.audience, "client"), eq(users.parentId, resellerId)))
    .limit(1);
  if (!rows[0]) throw notFound("Client", id);
  return rows[0];
}

function clientRows(db: Database, resellerId: string): Promise<UserRow[]> {
  return db
    .select()
    .from(users)
    .where(and(eq(users.parentId, resellerId), eq(users.audience, "client")))
    .orderBy(asc(users.name));
}

/** A reseller and all of its clients: everyone whose usage counts against it. */
async function poolOf(db: Database, resellerId: string): Promise<string[]> {
  const clients = await clientRows(db, resellerId);
  return [resellerId, ...clients.map((c) => c.id)];
}

async function limitsRow(db: Database, userId: string) {
  const rows = await db
    .select()
    .from(accountLimits)
    .where(eq(accountLimits.userId, userId))
    .limit(1);
  return rows[0] ?? { serverIds: [] as string[] };
}

async function brandingOf(db: Database, userId: string): Promise<ResellerBranding | null> {
  const rows = await db
    .select()
    .from(brandingTable)
    .where(eq(brandingTable.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    display_name: row.displayName,
    logo_text: row.logoText,
    support_email: row.supportEmail,
    support_url: row.supportUrl,
  };
}

/* ------------------------------------------------------------------ *
 * Serialising
 * ------------------------------------------------------------------ */

async function accountContextFor(
  db: Database,
  user: UserRow,
  principal: Principal,
): Promise<AccountContext> {
  const account = principal.scoped;
  if (!account) {
    return {
      user_id: user.id,
      audience: "operator",
      view_mode: user.viewMode,
      reseller_id: null,
      branding: null,
      quota: null,
      usage: null,
      servers: [],
    };
  }

  const brandOwner = account.audience === "reseller" ? user.id : account.resellerId;
  const [branding, quota, usage, hosts] = await Promise.all([
    brandOwner ? brandingOf(db, brandOwner) : Promise.resolve(null),
    quotaOf(db, user.id),
    usageFor(db, account.ownerIds),
    account.serverIds.length > 0
      ? db
          .select({ id: servers.id, name: servers.name })
          .from(servers)
          .where(inArray(servers.id, [...account.serverIds]))
          .orderBy(asc(servers.name))
      : Promise.resolve([]),
  ]);

  return {
    user_id: user.id,
    audience: account.audience,
    view_mode: user.viewMode,
    reseller_id: account.resellerId,
    branding,
    quota,
    usage,
    servers: hosts,
  };
}

async function serializeReseller(db: Database, row: UserRow): Promise<Reseller> {
  const pool = await poolOf(db, row.id);
  const limits = await limitsRow(db, row.id);
  const [quota, usage, branding, hosts] = await Promise.all([
    quotaOf(db, row.id),
    usageFor(db, pool),
    brandingOf(db, row.id),
    limits.serverIds.length > 0
      ? db
          .select({ id: servers.id, name: servers.name })
          .from(servers)
          .where(inArray(servers.id, limits.serverIds))
          .orderBy(asc(servers.name))
      : Promise.resolve([]),
  ]);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    servers: hosts,
    quota,
    usage,
    branding,
    client_count: pool.length - 1,
    last_login_at: row.lastLoginAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

async function serializeClient(db: Database, row: UserRow): Promise<Client> {
  const [quota, usage] = await Promise.all([quotaOf(db, row.id), usageFor(db, [row.id])]);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    reseller_id: row.parentId,
    quota,
    usage,
    last_login_at: row.lastLoginAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Invited, like every other account: nobody, including whoever creates
 * a reseller or client, ever knows its password. The account holds no
 * role; its audience is its authority.
 */
async function inviteAccount(
  req: FastifyRequest,
  input: {
    email: string;
    name: string;
    audience: "reseller" | "client";
    parentId: string | null;
    sendInvite: boolean;
  },
): Promise<{ row: UserRow; invite: UserInvitation }> {
  const email = input.email.trim().toLowerCase();
  const existing = await req.ctx.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing[0]) {
    // Deliberately no link: a reseller must not learn whose account it is.
    throw conflict(`${email} already has an account.`, {
      summary: "One account per address. Use a different address for this account.",
      actions: [],
    });
  }

  const token = generateToken("kn_invite");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await req.ctx.db
    .insert(users)
    .values({
      email,
      name: input.name,
      status: "invited",
      inviteTokenHash: hashToken(token),
      inviteExpiresAt: expiresAt,
      audience: input.audience,
      parentId: input.parentId,
      // A client's panel is the simple one; a reseller starts there too
      // and can switch.
      viewMode: "simplified",
    })
    .returning();

  const url = `${req.ctx.config.KANAME_PUBLIC_URL}/invite/${token}`;
  const emailed = input.sendInvite
    ? await req.ctx.notifications.sendInvitation({
        to: email,
        inviteeName: input.name,
        inviterName: helpers(req).actor().name,
        url,
        expiresAt,
      })
    : null;

  return { row: row!, invite: { url, expires_at: expiresAt.toISOString(), email: emailed } };
}

async function updateAccount(
  db: Database,
  before: UserRow,
  body: { name?: string; status?: "active" | "suspended" },
): Promise<UserRow> {
  const [row] = await db
    .update(users)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, before.id))
    .returning();
  if (body.status === "suspended") {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, before.id), isNull(sessions.revokedAt)));
  }
  return row!;
}

/** An account that never accepted its invitation has no password to sign in with. */
function assertCanActivate(before: UserRow, status: "active" | "suspended" | undefined): void {
  if (status === "active" && before.status !== "active" && !before.passwordHash) {
    throw conflict(`${before.email} has not accepted the invitation yet.`, {
      summary: "The account becomes active when its owner sets a password from the invitation.",
      actions: [],
    });
  }
}

async function writeLimits(
  db: Database,
  userId: string,
  input: { serverIds?: string[]; quota?: Partial<AccountQuota> },
): Promise<void> {
  const q = input.quota ?? {};
  const set = {
    ...(input.serverIds !== undefined ? { serverIds: [...new Set(input.serverIds)] } : {}),
    ...(q.max_sites !== undefined ? { maxSites: q.max_sites } : {}),
    ...(q.max_domains !== undefined ? { maxDomains: q.max_domains } : {}),
    ...(q.max_mailboxes !== undefined ? { maxMailboxes: q.max_mailboxes } : {}),
    ...(q.max_databases !== undefined ? { maxDatabases: q.max_databases } : {}),
    ...(q.max_disk_mb !== undefined ? { maxDiskMb: q.max_disk_mb } : {}),
  };
  await db
    .insert(accountLimits)
    .values({ userId, ...set })
    .onConflictDoUpdate({
      target: accountLimits.userId,
      set: { ...set, updatedAt: new Date() },
    });
}

async function writeBranding(db: Database, userId: string, body: ResellerBranding): Promise<void> {
  const set = {
    displayName: body.display_name,
    logoText: body.logo_text,
    supportEmail: body.support_email,
    supportUrl: body.support_url,
  };
  await db
    .insert(brandingTable)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: brandingTable.userId, set: { ...set, updatedAt: new Date() } });
}

async function setOwner(
  db: Database,
  kind: ResourceKind,
  resourceId: string,
  ownerId: string,
  assignedBy: string,
): Promise<void> {
  await db
    .insert(resourceOwners)
    .values({ kind, resourceId, ownerId, assignedBy })
    .onConflictDoUpdate({
      target: [resourceOwners.kind, resourceOwners.resourceId],
      set: { ownerId, assignedBy },
    });
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

async function assertServersExist(db: Database, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await db.select({ id: servers.id }).from(servers).where(inArray(servers.id, unique));
  const missing = unique.filter((id) => !found.some((s) => s.id === id));
  if (missing.length > 0) {
    throw new ApiException("validation_failed", `No server exists with id ${missing.join(", ")}.`, {
      fields: { server_ids: "one or more of these servers no longer exist" },
    });
  }
}

/** A client's ceiling may not exceed its reseller's, field by field. */
function assertWithin(quota: Partial<AccountQuota>, ceiling: AccountQuota): void {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(ceiling) as (keyof AccountQuota)[]) {
    const wanted = quota[key];
    const max = ceiling[key];
    if (max !== null && wanted !== undefined && wanted !== null && wanted > max) {
      fields[`quota.${key}`] = `at most ${max}, which is your own limit`;
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiException(
      "validation_failed",
      "A client cannot be given more than your own account has.",
      { fields },
    );
  }
}

/** Refuses a hand-over that would put the receiving account over its allowance. */
async function assertRoom(
  db: Database,
  ownerIds: readonly string[],
  quota: AccountQuota,
  kind: ResourceKind,
  who: string,
): Promise<void> {
  const field = QUOTA_FIELDS[kind];
  const limit = quota[field.limit];
  if (limit === null) return;
  const usage = await usageFor(db, ownerIds);
  if (usage[field.usage] + 1 > limit) {
    throw new ApiException(
      "quota_exceeded",
      `${who} is limited to ${limit} ${RESOURCE_KIND_LABELS[kind].many.toLowerCase()}, and ${usage[field.usage]} ${usage[field.usage] === 1 ? "is" : "are"} in use.`,
      {
        detail: { kind, limit, used: usage[field.usage] },
        remediation: { summary: "Raise the limit, or take something back first.", actions: [] },
      },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Resources, by kind
 * ------------------------------------------------------------------ */

interface ResourceRow {
  id: string;
  label: string;
  server_id: string | null;
  server_name: string | null;
}

/** The live table behind each kind, reduced to what a list needs. */
function resourceQuery(db: Database, kind: ResourceKind) {
  switch (kind) {
    case "site":
      return db
        .select({
          id: sites.id,
          label: sites.name,
          server_id: sites.serverId,
          server_name: servers.name,
        })
        .from(sites)
        .leftJoin(servers, eq(sites.serverId, servers.id))
        .$dynamic();
    case "domain":
      return db
        .select({
          id: domains.id,
          label: domains.name,
          server_id: domains.serverId,
          server_name: servers.name,
        })
        .from(domains)
        .leftJoin(servers, eq(domains.serverId, servers.id))
        .$dynamic();
    case "mailbox":
      return db
        .select({
          id: mailboxes.id,
          label: mailboxes.address,
          server_id: mailboxes.serverId,
          server_name: servers.name,
        })
        .from(mailboxes)
        .leftJoin(servers, eq(mailboxes.serverId, servers.id))
        .$dynamic();
    case "database":
      return db
        .select({
          id: dbDatabases.id,
          label: dbDatabases.name,
          server_id: dbDatabases.serverId,
          server_name: servers.name,
        })
        .from(dbDatabases)
        .leftJoin(servers, eq(dbDatabases.serverId, servers.id))
        .$dynamic();
  }
}

const ID_COLUMN = {
  site: sites.id,
  domain: domains.id,
  mailbox: mailboxes.id,
  database: dbDatabases.id,
} as const;

const LABEL_COLUMN = {
  site: sites.name,
  domain: domains.name,
  mailbox: mailboxes.address,
  database: dbDatabases.name,
} as const;

async function describeResource(
  db: Database,
  kind: ResourceKind,
  id: string,
): Promise<ResourceRow> {
  const rows: ResourceRow[] = await resourceQuery(db, kind).where(eq(ID_COLUMN[kind], id)).limit(1);
  if (!rows[0]) throw notFound(RESOURCE_KIND_LABELS[kind].one, id);
  return rows[0];
}

async function ownedResources(db: Database, ownerIds: readonly string[]): Promise<OwnedResource[]> {
  if (ownerIds.length === 0) return [];
  const owned = await db
    .select({
      kind: resourceOwners.kind,
      resourceId: resourceOwners.resourceId,
      ownerId: resourceOwners.ownerId,
      ownerName: users.name,
    })
    .from(resourceOwners)
    .innerJoin(users, eq(resourceOwners.ownerId, users.id))
    .where(inArray(resourceOwners.ownerId, [...ownerIds]));

  const out: OwnedResource[] = [];
  for (const kind of resourceKind.options) {
    const mine = owned.filter((o) => o.kind === kind);
    if (mine.length === 0) continue;
    const rows: ResourceRow[] = await resourceQuery(db, kind).where(
      inArray(
        ID_COLUMN[kind],
        mine.map((o) => o.resourceId),
      ),
    );
    for (const row of rows) {
      const owner = mine.find((o) => o.resourceId === row.id)!;
      out.push({ kind, ...row, owner_id: owner.ownerId, owner_name: owner.ownerName });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

async function unownedResources(
  db: Database,
  kind: ResourceKind,
  q: string | undefined,
): Promise<OwnedResource[]> {
  const term = q?.trim().toLowerCase();
  const rows: ResourceRow[] = await resourceQuery(db, kind)
    .where(
      and(
        sql`not exists (select 1 from ${resourceOwners}
          where ${resourceOwners.kind} = ${kind} and ${resourceOwners.resourceId} = ${ID_COLUMN[kind]})`,
        term ? sql`lower(${LABEL_COLUMN[kind]}) like ${`%${term}%`}` : undefined,
      ),
    )
    .orderBy(asc(LABEL_COLUMN[kind]))
    .limit(200);
  return rows.map((row) => ({ kind, ...row, owner_id: null, owner_name: null }));
}
