import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, isNull, not, sql, type Database } from "@kaname/db";
import {
  apiKeys,
  roleGrants,
  roles,
  sessions,
  settings,
  userRoles,
  users,
} from "@kaname/db/schema";
import {
  apiKeyListQuery,
  can,
  createApiKeyInput,
  createRoleInput,
  createUserInput,
  idParam,
  listQuery,
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_GROUP_LABELS,
  roleListQuery,
  setAddressInput,
  smtpTestInput,
  SYSTEM_ROLE_SLUGS,
  updateRoleInput,
  updateSettingsInput,
  updateUserInput,
  userListQuery,
  uuid,
  type Permission,
  type Role,
  type RoleGrant,
  type SettingsDocument,
  type User,
} from "@kaname/contract";
import { z } from "zod";
import { applyAddress, readAddress } from "../services/address.js";
import {
  applyNotificationChannels,
  loadNotificationChannels,
  loadSmtpSettings,
  saveSmtpSettings,
} from "../services/notifications.js";
import {
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
import { ApiException, conflict, notFound } from "../lib/errors.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { combine, searchTerm, sortColumn } from "./_shared.js";
import type { AppContext } from "../context.js";
import type { Config } from "../config.js";

/* ------------------------------------------------------------------ *
 * Administration — users, roles, API keys, own sessions, settings.
 *
 * None of these resources belong to a managed host, so `scopeFilter` has
 * no column to restrict: the permission itself is the whole check. The
 * invariants that matter here are the ones that can brick an install —
 * losing the last owner, editing a role the release reconciles on every
 * boot, or minting an API key more powerful than the person holding it.
 * ------------------------------------------------------------------ */

const INVITE_TTL_MS = 7 * 86_400_000;

const SORTABLE_USERS = {
  name: users.name,
  email: users.email,
  status: users.status,
  last_login_at: users.lastLoginAt,
  created_at: users.createdAt,
} as const;

const SORTABLE_ROLES = {
  name: roles.name,
  slug: roles.slug,
  created_at: roles.createdAt,
} as const;

const SORTABLE_API_KEYS = {
  name: apiKeys.name,
  last_used_at: apiKeys.lastUsedAt,
  expires_at: apiKeys.expiresAt,
  created_at: apiKeys.createdAt,
} as const;

const SORTABLE_SESSIONS = {
  last_seen_at: sessions.lastSeenAt,
  expires_at: sessions.expiresAt,
  created_at: sessions.createdAt,
} as const;

const roleIdsInput = z.object({ role_ids: z.array(uuid).min(1) });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------ *
   * Users
   * ------------------------------------------------------------------ */

  app.get("/users", async (req, reply) => {
    const q = parseQuery(req, userListQuery);
    helpers(req).authorize("admin.users:read");

    const term = searchTerm(q.q);
    const where = combine(
      q.status ? eq(users.status, q.status) : null,
      q.totp_enabled !== undefined ? eq(users.totpEnabled, q.totp_enabled) : null,
      q.role
        ? sql`exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
              where ur.user_id = ${users.id} and r.slug = ${q.role})`
        : null,
      term ? sql`(lower(${users.name}) like ${term} or lower(${users.email}) like ${term})` : null,
    );

    const column = sortColumn(SORTABLE_USERS, q.sort, "name");
    const rows = await req.ctx.db
      .select()
      .from(users)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(users)
      .where(where);

    const data = await Promise.all(rows.map((row) => serializeUser(req.ctx.db, row)));
    return list(reply, data, paginate(counted[0]?.total ?? 0, q.page, q.per_page));
  });

  app.post("/users", async (req, reply) => {
    const body = parseBody(req, createUserInput);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const email = body.email.trim().toLowerCase();
    const existing = await req.ctx.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing[0]) {
      throw conflict(`${email} already has an account.`, {
        summary: "One account per address. Edit the existing one instead of inviting it again.",
        actions: [{ label: "Open it", href: `/administration/users/${existing[0].id}` }],
      });
    }

    const token = generateToken("kn_invite");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    // Invited, never created with a password: nobody — including the
    // inviter — ever knows another user's credential.
    const [row] = await req.ctx.db
      .insert(users)
      .values({
        email,
        name: body.name,
        status: "invited",
        inviteTokenHash: hashToken(token),
        inviteExpiresAt: expiresAt,
      })
      .returning();

    await setUserRoles(req.ctx.db, row!.id, body.role_ids);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "user.invited",
      targetType: "user",
      targetId: row!.id,
      targetLabel: email,
      metadata: { send_invite: body.send_invite },
      after: { email, name: body.name, role_ids: body.role_ids },
    });
    req.ctx.events.publish("audit", "user.invited", { user_id: row!.id });

    return item(
      reply,
      {
        ...(await serializeUser(req.ctx.db, row!)),
        invite: {
          url: `${req.ctx.config.KANAME_PUBLIC_URL}/invite/${token}`,
          expires_at: expiresAt.toISOString(),
        },
      },
      201,
    );
  });

  app.get("/users/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("admin.users:read");
    return item(reply, await serializeUser(req.ctx.db, await loadUser(req, id)));
  });

  app.patch("/users/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateUserInput);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const before = await loadUser(req, id);

    if (body.status && body.status !== "active" && before.status === "active") {
      await assertNotLastOwner(req.ctx.db, before, "suspended");
    }
    if (body.role_ids && !(await roleIdsInclude(req.ctx.db, body.role_ids, "owner"))) {
      await assertNotLastOwner(req.ctx.db, before, "stripped of the Owner role");
    }

    const [row] = await req.ctx.db
      .update(users)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();

    if (body.role_ids) await setUserRoles(req.ctx.db, id, body.role_ids);
    if (body.status && body.status !== "active") await revokeSessionsFor(req.ctx.db, id);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "user.updated",
      targetType: "user",
      targetId: id,
      targetLabel: row!.email,
      before: { name: before.name, status: before.status },
      after: body,
    });
    req.ctx.events.publish("audit", "user.updated", { user_id: id });

    return item(reply, await serializeUser(req.ctx.db, row!));
  });

  app.delete("/users/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    const principal = h.authorize("admin.users:delete");

    const user = await loadUser(req, id);
    if (principal.kind === "user" && principal.id === id) {
      throw conflict("You cannot delete your own account.", {
        summary:
          "Ask another owner to remove it, so an install is never left without an administrator by accident.",
        actions: [{ label: "Manage users", href: "/administration/users" }],
      });
    }
    await assertNotLastOwner(req.ctx.db, user, "deleted");

    // A key outliving its creator would keep that person's permissions
    // alive with nobody attached to them.
    const revoked = await req.ctx.db
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(apiKeys.createdBy, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });

    await req.ctx.db.delete(users).where(eq(users.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "user.deleted",
      targetType: "user",
      targetId: id,
      targetLabel: user.email,
      metadata: { api_keys_revoked: revoked.length },
      before: { email: user.email, name: user.name, status: user.status },
    });
    req.ctx.events.publish("audit", "user.deleted", { user_id: id });

    return noContent(reply);
  });

  app.post("/users/:id/roles", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, roleIdsInput);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const user = await loadUser(req, id);
    if (!(await roleIdsInclude(req.ctx.db, body.role_ids, "owner"))) {
      await assertNotLastOwner(req.ctx.db, user, "stripped of the Owner role");
    }

    const before = await roleRefsFor(req.ctx.db, id);
    await setUserRoles(req.ctx.db, id, body.role_ids);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "user.roles_set",
      targetType: "user",
      targetId: id,
      targetLabel: user.email,
      before: { role_ids: before.map((r) => r.id) },
      after: { role_ids: body.role_ids },
    });
    req.ctx.events.publish("audit", "user.roles_set", { user_id: id });

    return item(reply, await serializeUser(req.ctx.db, user));
  });

  app.post("/users/:id/suspend", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const user = await loadUser(req, id);
    await assertNotLastOwner(req.ctx.db, user, "suspended");

    const [row] = await req.ctx.db
      .update(users)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    // Suspension has to bite now, not at the next sign-in.
    const killed = await revokeSessionsFor(req.ctx.db, id);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "user.suspended",
      targetType: "user",
      targetId: id,
      targetLabel: user.email,
      metadata: { sessions_revoked: killed },
      before: { status: user.status },
      after: { status: "suspended" },
    });
    req.ctx.events.publish("audit", "user.suspended", { user_id: id });

    return item(reply, await serializeUser(req.ctx.db, row!));
  });

  app.post("/users/:id/activate", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("admin.users:write");

    const user = await loadUser(req, id);
    if (!user.passwordHash) {
      throw conflict(`${user.email} has never set a password.`, {
        summary:
          "Re-invite the account instead — activating it would leave an account nobody can sign in to.",
        actions: [{ label: "Manage users", href: "/administration/users" }],
      });
    }

    const [row] = await req.ctx.db
      .update(users)
      .set({ status: "active", failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "user.activated",
      targetType: "user",
      targetId: id,
      targetLabel: user.email,
      before: { status: user.status },
      after: { status: "active" },
    });
    req.ctx.events.publish("audit", "user.activated", { user_id: id });

    return item(reply, await serializeUser(req.ctx.db, row!));
  });

  /* ------------------------------------------------------------------ *
   * Roles
   * ------------------------------------------------------------------ */

  app.get("/roles", async (req, reply) => {
    const q = parseQuery(req, roleListQuery);
    helpers(req).authorize("admin.roles:read");

    const term = searchTerm(q.q);
    const where = combine(
      q.is_system !== undefined ? eq(roles.isSystem, q.is_system) : null,
      term ? sql`(lower(${roles.name}) like ${term} or lower(${roles.slug}) like ${term})` : null,
    );

    const column = sortColumn(SORTABLE_ROLES, q.sort, "name");
    const rows = await req.ctx.db
      .select()
      .from(roles)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(roles)
      .where(where);

    return list(
      reply,
      await serializeRoles(req.ctx.db, rows),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  app.post("/roles", async (req, reply) => {
    const body = parseBody(req, createRoleInput);
    const h = helpers(req);
    h.authorize("admin.roles:write");

    const slug = body.slug ?? slugify(body.name);
    if ((SYSTEM_ROLE_SLUGS as readonly string[]).includes(slug)) {
      throw conflict(`"${slug}" is reserved for a system role.`, {
        summary:
          "Pick another name, or set an explicit slug that does not collide with a built-in role.",
        actions: [],
      });
    }

    const existing = await req.ctx.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.slug, slug))
      .limit(1);
    if (existing[0]) {
      throw conflict(`A role with the slug "${slug}" already exists.`, {
        summary: "Role slugs are unique and permanent, because grants reference them.",
        actions: [{ label: "Open it", href: `/administration/roles/${existing[0].id}` }],
      });
    }

    const [row] = await req.ctx.db
      .insert(roles)
      .values({ name: body.name, slug, description: body.description, isSystem: false })
      .returning();

    await writeGrants(req.ctx.db, row!.id, body.grants);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "role.created",
      targetType: "role",
      targetId: row!.id,
      targetLabel: row!.name,
      after: { name: body.name, slug, grants: body.grants },
    });
    req.ctx.events.publish("audit", "role.created", { role_id: row!.id });

    return item(reply, (await serializeRoles(req.ctx.db, [row!]))[0], 201);
  });

  app.get("/roles/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    helpers(req).authorize("admin.roles:read");
    const role = await loadRole(req, id);
    return item(reply, (await serializeRoles(req.ctx.db, [role]))[0]);
  });

  app.patch("/roles/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateRoleInput);
    const h = helpers(req);
    h.authorize("admin.roles:write");

    const before = await loadRole(req, id);
    if (before.isSystem) throw systemRoleImmutable(before.slug, before.name);

    const [row] = await req.ctx.db
      .update(roles)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(roles.id, id))
      .returning();

    const beforeGrants = await grantsFor(req.ctx.db, id);
    if (body.grants) await writeGrants(req.ctx.db, id, body.grants);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "role.updated",
      targetType: "role",
      targetId: id,
      targetLabel: row!.name,
      before: { name: before.name, description: before.description, grants: beforeGrants },
      after: body,
    });
    req.ctx.events.publish("audit", "role.updated", { role_id: id });

    return item(reply, (await serializeRoles(req.ctx.db, [row!]))[0]);
  });

  app.delete("/roles/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("admin.roles:delete");

    const role = await loadRole(req, id);
    if (role.isSystem) {
      throw conflict(`${role.name} is a system role and cannot be deleted.`, {
        summary:
          "Kaname reconciles the built-in roles from the release on every start, so a deleted one would come straight back. Remove it from the users that hold it instead.",
        actions: [{ label: "Manage users", href: "/administration/users" }],
      });
    }

    const [holders] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(userRoles)
      .where(eq(userRoles.roleId, id));
    if ((holders?.n ?? 0) > 0) {
      throw conflict(`${role.name} is still assigned to ${holders!.n} user(s).`, {
        summary:
          "Move those users to another role first — deleting this one would silently drop their permissions.",
        actions: [
          { label: "Filter users by this role", href: `/administration/users?role=${role.slug}` },
        ],
      });
    }

    await req.ctx.db.delete(roles).where(eq(roles.id, id));

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "role.deleted",
      targetType: "role",
      targetId: id,
      targetLabel: role.name,
      before: { name: role.name, slug: role.slug },
    });
    req.ctx.events.publish("audit", "role.deleted", { role_id: id });

    return noContent(reply);
  });

  /* ---------------------------- catalogue ---------------------------- */

  app.get("/permissions", async (req, reply) => {
    helpers(req).authorize("admin.roles:read");

    const groups = new Map<
      string,
      {
        key: string;
        module: string;
        label: string;
        permissions: { permission: Permission; action: string; description: string | null }[];
      }
    >();

    for (const permission of PERMISSIONS) {
      const [key, action] = permission.split(":") as [string, string];
      const group = groups.get(key) ?? {
        key,
        module: key.split(".")[0]!,
        label: PERMISSION_GROUP_LABELS[key] ?? key,
        permissions: [],
      };
      group.permissions.push({
        permission,
        action,
        description: PERMISSION_DESCRIPTIONS[permission] ?? null,
      });
      groups.set(key, group);
    }

    return item(reply, { groups: [...groups.values()] });
  });

  /* ------------------------------------------------------------------ *
   * API keys
   * ------------------------------------------------------------------ */

  app.get("/api-keys", async (req, reply) => {
    const q = parseQuery(req, apiKeyListQuery);
    helpers(req).authorize("admin.api_keys:read");

    const term = searchTerm(q.q);
    const where = combine(
      q.created_by ? eq(apiKeys.createdBy, q.created_by) : null,
      q.revoked === true ? sql`${apiKeys.revokedAt} is not null` : null,
      q.revoked === false ? isNull(apiKeys.revokedAt) : null,
      term
        ? sql`(lower(${apiKeys.name}) like ${term} or lower(${apiKeys.prefix}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_API_KEYS, q.sort, "created_at");
    const rows = await req.ctx.db
      .select({ key: apiKeys, creator: users.name })
      .from(apiKeys)
      .leftJoin(users, eq(apiKeys.createdBy, users.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(where);

    return list(
      reply,
      rows.map((r) => serializeApiKey(r.key, r.creator)),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  app.post("/api-keys", async (req, reply) => {
    const body = parseBody(req, createApiKeyInput);
    const h = helpers(req);
    const principal = h.authorize("admin.api_keys:write");

    if (principal.kind !== "user") {
      throw new ApiException("forbidden", "An API key cannot create another API key.", {
        remediation: {
          summary:
            "Key creation is deliberately a human action, so every key traces back to a person who can be held to it.",
          actions: [{ label: "API keys", href: "/administration/api" }],
        },
      });
    }

    // A key is a delegation, never an escalation: everything it can do,
    // its creator can already do, on exactly the same servers.
    const beyond = body.scopes.filter((scope) =>
      body.scope_kind === "global"
        ? req.ctx.auth.scope(principal, scope) !== "global"
        : body.scope_server_ids.some((serverId) => !can(principal.grants, scope, serverId)),
    );
    if (beyond.length > 0) throw scopeExceedsCreator(beyond, body.scope_kind);

    const prefix = `kn_live_${randomBytes(4).toString("hex")}`;
    const secret = generateToken();
    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 86_400_000)
      : null;

    const [row] = await req.ctx.db
      .insert(apiKeys)
      .values({
        name: body.name,
        prefix,
        secretHash: hashToken(secret),
        scopes: body.scopes,
        scopeKind: body.scope_kind,
        scopeServerIds: body.scope_kind === "servers" ? body.scope_server_ids : [],
        expiresAt,
        createdBy: principal.id,
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "api_key.created",
      targetType: "api_key",
      targetId: row!.id,
      targetLabel: `${body.name} (${prefix})`,
      after: {
        name: body.name,
        prefix,
        scopes: body.scopes,
        scope_kind: body.scope_kind,
        scope_server_ids: row!.scopeServerIds,
        expires_at: expiresAt?.toISOString() ?? null,
      },
    });
    req.ctx.events.publish("audit", "api_key.created", { api_key_id: row!.id });

    // The only moment the full token exists outside the caller's hands.
    return item(
      reply,
      { key: serializeApiKey(row!, principal.name), token: `${prefix}_${secret}` },
      201,
    );
  });

  app.post("/api-keys/:id/revoke", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    h.authorize("admin.api_keys:delete");

    const rows = await req.ctx.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const key = rows[0];
    if (!key) throw notFound("API key", id);
    if (key.revokedAt) {
      throw conflict(`${key.name} was already revoked on ${key.revokedAt.toISOString()}.`, {
        summary: "A revoked key stays in the list so the audit trail keeps a name for it.",
        actions: [{ label: "API keys", href: "/administration/api" }],
      });
    }

    const [row] = await req.ctx.db
      .update(apiKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: id,
      targetLabel: `${key.name} (${key.prefix})`,
      before: { revoked_at: null },
      after: { revoked_at: row!.revokedAt?.toISOString() ?? null },
    });
    req.ctx.events.publish("audit", "api_key.revoked", { api_key_id: id });

    return item(reply, serializeApiKey(row!, null));
  });

  /* ------------------------------------------------------------------ *
   * Own sessions
   * ------------------------------------------------------------------ */

  app.get("/me/sessions", async (req, reply) => {
    const q = parseQuery(req, listQuery);
    // Self-scoped: no permission gates reading your own sessions, and one
    // that did could be revoked to hide a stolen session from its owner.
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user") throw sessionsAreUserOnly();

    const term = searchTerm(q.q);
    const where = combine(
      eq(sessions.userId, principal.id),
      isNull(sessions.revokedAt),
      term
        ? sql`(lower(coalesce(${sessions.userAgent}, '')) like ${term} or host(${sessions.ip}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_SESSIONS, q.sort, "last_seen_at");
    const rows = await req.ctx.db
      .select()
      .from(sessions)
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const counted = await req.ctx.db
      .select({ total: sql<number>`count(*)::int` })
      .from(sessions)
      .where(where);

    return list(
      reply,
      rows.map((row) => serializeSession(row, principal.sessionId)),
      paginate(counted[0]?.total ?? 0, q.page, q.per_page),
    );
  });

  app.delete("/me/sessions/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const h = helpers(req);
    const principal = h.requirePrincipal();
    if (principal.kind !== "user") throw sessionsAreUserOnly();

    const rows = await req.ctx.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, principal.id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("Session", id);

    await req.ctx.auth.revokeSession(id);

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "session.revoked",
      targetType: "session",
      targetId: id,
      targetLabel: row.userAgent ?? "unknown device",
      metadata: { self: id === principal.sessionId },
    });
    req.ctx.events.publish("audit", "session.revoked", { user_id: principal.id });

    return noContent(reply);
  });

  app.delete("/me/sessions", async (req, reply) => {
    const h = helpers(req);
    const principal = h.requirePrincipal();
    if (principal.kind !== "user" || !principal.sessionId) throw sessionsAreUserOnly();

    const revoked = await req.ctx.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, principal.id),
          isNull(sessions.revokedAt),
          not(eq(sessions.id, principal.sessionId)),
        ),
      )
      .returning({ id: sessions.id });

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "session.revoked_others",
      targetType: "user",
      targetId: principal.id,
      targetLabel: principal.email ?? principal.name,
      metadata: { sessions_revoked: revoked.length },
    });
    req.ctx.events.publish("audit", "session.revoked_others", { user_id: principal.id });

    return item(reply, { revoked: revoked.length });
  });

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  /* ----------------------------- address ---------------------------- */

  app.get("/settings/address", async (req, reply) => {
    helpers(req).authorize("admin.settings:read");
    return item(reply, await readAddress(req.ctx));
  });

  /*
   * 202, not 200: applying this recreates the control plane, so the
   * process answering the request is not the one that will finish it.
   * The panel keeps working on the IP throughout either way.
   */
  app.post("/settings/address", async (req, reply) => {
    const h = helpers(req);
    const principal = h.authorize("admin.settings:write");
    const body = parseBody(req, setAddressInput);

    const result = await applyAddress(req.ctx, body.domain, {
      id: principal.kind === "user" ? principal.id : null,
      name: principal.name,
      ip: req.ip ?? null,
    });

    return reply.status(202).send({ data: { ...result, applying: true } });
  });

  app.get("/settings", async (req, reply) => {
    helpers(req).authorize("admin.settings:read");
    return item(reply, await loadSettings(req.ctx));
  });

  /* ---------------------------- notifications --------------------------- */

  /**
   * Sends a real message through one channel and reports exactly what
   * happened. A channel that has never delivered anything is
   * indistinguishable from one that works, so this is how an operator
   * finds out before the night it matters.
   */
  app.post("/settings/notifications/:id/test", async (req, reply) => {
    helpers(req).authorize("admin.settings:write");
    const { id } = parseParams(req, idParam);
    return item(reply, await req.ctx.notifications.sendTest(id));
  });

  /** Tries the outgoing mail server, with unsaved draft values if given. */
  app.post("/settings/notifications/smtp/test", async (req, reply) => {
    helpers(req).authorize("admin.settings:write");
    const body = parseBody(req, smtpTestInput);
    return item(reply, await req.ctx.notifications.sendTestEmail(body.to, body.smtp));
  });

  app.patch("/settings", async (req, reply) => {
    const body = parseBody(req, updateSettingsInput);
    const h = helpers(req);
    const principal = h.authorize("admin.settings:write");

    const before = await loadSettings(req.ctx);
    const updatedBy = principal.kind === "user" ? principal.id : null;
    const changed: string[] = [];

    for (const key of SETTINGS_KEYS) {
      const patch = body[key];
      if (patch === undefined) continue;
      const value = deepMerge(before[key], patch);
      await req.ctx.db
        .insert(settings)
        .values({ key, value, updatedBy })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedBy, updatedAt: new Date() },
        });
      changed.push(key);
    }

    if (body.notifications?.channels) {
      await applyNotificationChannels(req.ctx, body.notifications.channels);
      changed.push("notifications");
    }

    if (body.notifications?.smtp) {
      await saveSmtpSettings(req.ctx, body.notifications.smtp, updatedBy);
      if (!changed.includes("notifications")) changed.push("notifications");
    }

    if (changed.length === 0) {
      throw new ApiException("bad_request", "No settings section was supplied.", {
        remediation: {
          summary: "Send at least one of panel, security, notifications, agents, backups or acme.",
          actions: [],
        },
      });
    }

    const recording = body.security?.terminal_recording;
    if (recording !== undefined && recording !== before.security.terminal_recording) {
      // KD-013: recording is the compensating control for the one place
      // shell strings are allowed, so turning it off is its own headline
      // audit entry rather than a line in a settings diff.
      await req.ctx.audit.record({
        actor: h.actor(),
        action: recording
          ? "settings.terminal_recording_enabled"
          : "settings.terminal_recording_disabled",
        targetType: "settings",
        targetId: "security.terminal_recording",
        targetLabel: "Terminal session recording",
        before: { terminal_recording: before.security.terminal_recording },
        after: { terminal_recording: recording },
      });
      req.ctx.events.publish("audit", "settings.terminal_recording_changed", {
        enabled: recording,
      });
    }

    const after = await loadSettings(req.ctx);
    await req.ctx.audit.record({
      actor: h.actor(),
      action: "settings.updated",
      targetType: "settings",
      targetId: changed.join(","),
      targetLabel: changed.join(", "),
      metadata: { sections: changed },
      before: pick(before, changed),
      after: pick(after, changed),
    });
    req.ctx.events.publish("audit", "settings.updated", { sections: changed });

    return item(reply, after);
  });
}

/* ------------------------------------------------------------------ *
 * Users — loading and serialisation
 * ------------------------------------------------------------------ */

type UserRow = typeof users.$inferSelect;

async function loadUser(req: FastifyRequest, id: string): Promise<UserRow> {
  const rows = await req.ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("User", id);
  return row;
}

/** Row to API shape, including the roles the user holds. */
export async function serializeUser(db: Database, row: UserRow): Promise<User> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    totp_enabled: row.totpEnabled,
    roles: await roleRefsFor(db, row.id),
    last_login_at: row.lastLoginAt?.toISOString() ?? null,
    last_login_ip: row.lastLoginIp,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function roleRefsFor(db: Database, userId: string): Promise<User["roles"]> {
  return db
    .select({ id: roles.id, name: roles.name, slug: roles.slug })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId))
    .orderBy(asc(roles.name));
}

async function setUserRoles(db: Database, userId: string, roleIds: string[]): Promise<void> {
  const ids = [...new Set(roleIds)];
  const found = await db.select({ id: roles.id }).from(roles).where(inArray(roles.id, ids));
  const missing = ids.filter((id) => !found.some((r) => r.id === id));
  if (missing.length > 0) {
    throw new ApiException("validation_failed", `No role exists with id ${missing.join(", ")}.`, {
      fields: { role_ids: "one or more of these roles no longer exist" },
      remediation: {
        summary: "Reload the role list — a role was deleted after this form was opened.",
        actions: [{ label: "Roles", href: "/administration/roles" }],
      },
    });
  }

  await db.delete(userRoles).where(eq(userRoles.userId, userId));
  await db.insert(userRoles).values(ids.map((roleId) => ({ userId, roleId })));
}

async function roleIdsInclude(db: Database, roleIds: string[], slug: string): Promise<boolean> {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(inArray(roles.id, [...new Set(roleIds)]), eq(roles.slug, slug)))
    .limit(1);
  return rows.length > 0;
}

async function revokeSessionsFor(db: Database, userId: string): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Owner is the only role that can grant Owner, so an install with no
 * active owner cannot be repaired from inside the panel.
 */
async function assertNotLastOwner(db: Database, user: UserRow, what: string): Promise<void> {
  if (user.status !== "active") return;

  const [self] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(userRoles.userId, user.id), eq(roles.slug, "owner")));
  if ((self?.n ?? 0) === 0) return;

  const [others] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(roles.slug, "owner"), eq(users.status, "active"), not(eq(users.id, user.id))));
  if ((others?.n ?? 0) > 0) return;

  throw conflict(`${user.email} is the only active owner, so it cannot be ${what}.`, {
    summary:
      "Give the Owner role to another active user first. With no owner left, nobody could grant it back and the install would need database access to recover.",
    actions: [{ label: "Manage users", href: "/administration/users" }],
  });
}

/* ------------------------------------------------------------------ *
 * Roles — loading and serialisation
 * ------------------------------------------------------------------ */

type RoleRow = typeof roles.$inferSelect;

async function loadRole(req: FastifyRequest, id: string): Promise<RoleRow> {
  const rows = await req.ctx.db.select().from(roles).where(eq(roles.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("Role", id);
  return row;
}

async function serializeRoles(db: Database, rows: RoleRow[]): Promise<Role[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const grantRows = await db
    .select({
      roleId: roleGrants.roleId,
      permission: roleGrants.permission,
      scope: roleGrants.scope,
    })
    .from(roleGrants)
    .where(inArray(roleGrants.roleId, ids));

  const countRows = await db
    .select({ roleId: userRoles.roleId, n: sql<number>`count(*)::int` })
    .from(userRoles)
    .where(inArray(userRoles.roleId, ids))
    .groupBy(userRoles.roleId);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    is_system: row.isSystem,
    user_count: countRows.find((c) => c.roleId === row.id)?.n ?? 0,
    grants: grantRows
      .filter((g) => g.roleId === row.id)
      .map((g) => ({ permission: g.permission, scope: g.scope })),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }));
}

async function grantsFor(db: Database, roleId: string): Promise<RoleGrant[]> {
  const rows = await db
    .select({ permission: roleGrants.permission, scope: roleGrants.scope })
    .from(roleGrants)
    .where(eq(roleGrants.roleId, roleId));
  return rows.map((r) => ({ permission: r.permission, scope: r.scope }));
}

/** Grants are declarative: the supplied set replaces whatever was there. */
async function writeGrants(db: Database, roleId: string, grants: RoleGrant[]): Promise<void> {
  await db.delete(roleGrants).where(eq(roleGrants.roleId, roleId));
  if (grants.length === 0) return;

  const byPermission = new Map<Permission, RoleGrant>();
  for (const grant of grants) byPermission.set(grant.permission, grant);

  await db.insert(roleGrants).values(
    [...byPermission.values()].map((grant) => ({
      roleId,
      permission: grant.permission,
      scope: grant.scope,
    })),
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const systemRoleImmutable = (slug: string, name: string) =>
  conflict(
    slug === "owner"
      ? "The Owner role cannot be edited."
      : `${name} is a system role and cannot be edited.`,
    {
      summary:
        "Kaname reconciles the built-in roles from the release on every start, so any change here would be reverted at the next restart. Create a custom role with the grants you want instead.",
      actions: [{ label: "Create a role", href: "/administration/roles/new" }],
    },
  );

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

function serializeApiKey(row: typeof apiKeys.$inferSelect, creatorName: string | null) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    scope_kind: row.scopeKind,
    scope_server_ids: row.scopeServerIds,
    expires_at: row.expiresAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    last_used_ip: row.lastUsedIp,
    created_by: row.createdBy,
    created_by_name: creatorName ?? "deleted user",
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const scopeExceedsCreator = (scopes: Permission[], scopeKind: "global" | "servers") =>
  new ApiException(
    "forbidden",
    `You cannot grant ${scopes.join(", ")} to an API key because you do not hold ${scopes.length === 1 ? "it" : "them"}${scopeKind === "global" ? " across the whole fleet" : " on every selected server"}.`,
    {
      detail: { scopes },
      fields: { scopes: "exceeds your own permissions" },
      remediation: {
        summary:
          "An API key is a delegation of the permissions of whoever created it, never more. Remove those scopes, narrow the key to servers you do hold them on, or ask an owner to create the key.",
        actions: [{ label: "View roles", href: "/administration/roles" }],
      },
    },
  );

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

function serializeSession(row: typeof sessions.$inferSelect, currentId: string | undefined) {
  return {
    id: row.id,
    ip: row.ip ?? "0.0.0.0",
    user_agent: row.userAgent ?? "",
    created_at: row.createdAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    current: row.id === currentId,
  };
}

const sessionsAreUserOnly = () =>
  new ApiException("bad_request", "API keys do not have sessions.", {
    remediation: {
      summary: "Revoke the key in Administration > API to cut off its access.",
      actions: [{ label: "API keys", href: "/administration/api" }],
    },
  });

/* ------------------------------------------------------------------ *
 * Settings
 *
 * Stored one row per section, so a release that adds a field picks up
 * its default without a data migration.
 * ------------------------------------------------------------------ */

const SETTINGS_KEYS = ["panel", "security", "agents", "backups", "acme"] as const;

export async function loadSettings(ctx: AppContext): Promise<SettingsDocument> {
  const rows = await ctx.db.select().from(settings);
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const base = settingsDefaults(ctx.config);

  return {
    panel: deepMerge(base.panel, stored.get("panel")),
    security: deepMerge(base.security, normalizeStored("security", stored.get("security"))),
    agents: deepMerge(base.agents, stored.get("agents")),
    backups: deepMerge(base.backups, stored.get("backups")),
    acme: deepMerge(base.acme, normalizeStored("acme", stored.get("acme"))),
    notifications: {
      channels: await loadNotificationChannels(ctx.db),
      smtp: await loadSmtpSettings(ctx),
    },
  };
}

function settingsDefaults(config: Config): SettingsDocument {
  return {
    panel: {
      name: "Kaname",
      url: config.KANAME_PUBLIC_URL,
      timezone: "UTC",
      date_format: "iso",
    },
    security: {
      session_ttl_hours: config.SESSION_TTL_HOURS,
      require_totp: false,
      terminal_recording: true,
      failed_login_lockout: {
        enabled: true,
        threshold: 8,
        window_minutes: 15,
        lockout_minutes: 15,
      },
    },
    notifications: {
      channels: [],
      smtp: {
        host: "",
        port: 587,
        security: "starttls",
        username: "",
        from_address: "",
        from_name: "Kaname",
        password_set: false,
      },
    },
    agents: {
      heartbeat_seconds: config.AGENT_HEARTBEAT_SECONDS,
      offline_after_seconds: config.AGENT_OFFLINE_AFTER_SECONDS,
      metrics_retention_days: config.METRICS_RETENTION_DAYS,
    },
    backups: { default_destination_id: null },
    acme: {
      email: config.ACME_EMAIL ?? "",
      directory_url: config.ACME_DIRECTORY_URL,
      staging: false,
    },
  };
}

/**
 * First boot seeds two of these sections in looser shapes than the
 * contract describes; widen them on read instead of rewriting rows that
 * the bootstrap owns.
 */
function normalizeStored(key: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (key === "security" && typeof value.failed_login_lockout === "number") {
    return { ...value, failed_login_lockout: { threshold: value.failed_login_lockout } };
  }
  if (key === "acme" && !value.email) return { ...value, email: undefined };
  return value;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  if (!isRecord(base)) return patch as T;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(doc: SettingsDocument, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = (doc as unknown as Record<string, unknown>)[key];
  return out;
}
