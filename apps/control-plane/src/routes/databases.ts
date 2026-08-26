import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, notInArray, or, sql, type SQL } from "@kaname/db";
import type { PgColumn } from "drizzle-orm/pg-core";
import { dbDatabases, dbGrants, dbInstances, dbUsers, secrets, servers } from "@kaname/db/schema";
import {
  applyGrantsInput,
  createDatabaseInput,
  createDbUserInput,
  databaseListQuery,
  dbInstanceListQuery,
  dbUserListQuery,
  dumpDatabaseInput,
  idParam,
  restoreDatabaseInput,
  updateDatabaseInput,
  updateDbUserInput,
  type Database as DatabaseResource,
  type DatabaseListQuery,
  type DbEngine,
  type DbGrant,
  type DbInstance,
  type DbUser,
  type DbUserListQuery,
  type GrantInput,
  type Job,
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
import { ApiException, badRequest, conflict, notFound } from "../lib/errors.js";
import { generateToken, seal } from "../lib/crypto.js";
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
 * Databases.
 *
 * A host runs many databases, each with its own credentials — never one
 * shared superuser connection. Passwords are generated here when the
 * operator does not bring their own, shown exactly once, and stored
 * envelope-encrypted in `secrets`.
 *
 * MySQL and MariaDB answer to `databases.mysql:*`; PostgreSQL has its
 * own `databases.postgres:*`, so a role can be given one engine without
 * the other.
 * ------------------------------------------------------------------ */

type DbAction = "read" | "write" | "delete";

const DB_PERMISSIONS: Record<DbEngine, Record<DbAction, Permission>> = {
  mysql: {
    read: "databases.mysql:read",
    write: "databases.mysql:write",
    delete: "databases.mysql:delete",
  },
  mariadb: {
    read: "databases.mysql:read",
    write: "databases.mysql:write",
    delete: "databases.mysql:delete",
  },
  postgres: {
    read: "databases.postgres:read",
    write: "databases.postgres:write",
    delete: "databases.postgres:delete",
  },
};

/** The engines each permission covers, for list queries that span both. */
const ENGINE_GROUPS: readonly {
  readonly engine: DbEngine;
  readonly covers: readonly DbEngine[];
}[] = [
  { engine: "mysql", covers: ["mysql", "mariadb"] },
  { engine: "postgres", covers: ["postgres"] },
];

function dbPermission(engine: DbEngine, action: DbAction): Permission {
  return DB_PERMISSIONS[engine][action];
}

/**
 * A list route spans both engines, so "may read" means "may read at
 * least one of them". The chosen permission still goes through
 * `authorize`, which is where MFA and the deny path live.
 */
function authorizeAnyEngine(req: FastifyRequest, action: DbAction): void {
  const h = helpers(req);
  const principal = h.requirePrincipal();
  const granted = ENGINE_GROUPS.map((g) => dbPermission(g.engine, action)).find(
    (permission) => req.ctx.auth.scope(principal, permission) !== null,
  );
  h.authorize(granted ?? dbPermission("mysql", action));
}

/** Per-engine server scope, so a Postgres-only role never sees MySQL rows. */
function engineScopeFilter(
  req: FastifyRequest,
  action: DbAction,
  serverColumn: PgColumn,
  engineColumn: PgColumn,
): SQL {
  const groups = ENGINE_GROUPS.map((group) => {
    const engines = inArray(engineColumn, [...group.covers]);
    // scopeFilter returns null for global scope and `false` for no grant.
    const scope = scopeFilter(req, dbPermission(group.engine, action), serverColumn);
    return scope ? and(engines, scope)! : engines;
  });
  return or(...groups)!;
}

const SORTABLE_INSTANCES = {
  engine: dbInstances.engine,
  version: dbInstances.version,
  port: dbInstances.port,
  status: dbInstances.status,
  server: servers.name,
  created_at: dbInstances.createdAt,
} as const;

const SORTABLE_DATABASES = {
  name: dbDatabases.name,
  engine: dbDatabases.engine,
  size_bytes: dbDatabases.sizeBytes,
  table_count: dbDatabases.tableCount,
  last_backup_at: dbDatabases.lastBackupAt,
  server: servers.name,
  created_at: dbDatabases.createdAt,
} as const;

const SORTABLE_USERS = {
  username: dbUsers.username,
  engine: dbUsers.engine,
  host_pattern: dbUsers.hostPattern,
  last_used_at: dbUsers.lastUsedAt,
  server: servers.name,
  created_at: dbUsers.createdAt,
} as const;

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- instances --------------------------- */

  app.get("/db-instances", async (req, reply) => {
    const q = parseQuery(req, dbInstanceListQuery);
    authorizeAnyEngine(req, "read");

    const term = searchTerm(q.q);
    const where = combine(
      engineScopeFilter(req, "read", dbInstances.serverId, dbInstances.engine),
      q.server_id ? eq(dbInstances.serverId, q.server_id) : null,
      q.engine ? eq(dbInstances.engine, q.engine) : null,
      q.status ? eq(dbInstances.status, q.status) : null,
      term
        ? sql`(lower(${dbInstances.engine}) like ${term} or lower(${dbInstances.version}) like ${term} or lower(${servers.name}) like ${term})`
        : null,
    );

    const column = sortColumn(SORTABLE_INSTANCES, q.sort, "engine");
    const rows = await req.ctx.db
      .select({ instance: dbInstances, serverName: servers.name })
      .from(dbInstances)
      .innerJoin(servers, eq(dbInstances.serverId, servers.id))
      .where(where)
      .orderBy(q.order === "asc" ? asc(column) : desc(column))
      .limit(q.per_page)
      .offset(offset(q.page, q.per_page));

    const [total] = await req.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(dbInstances)
      .innerJoin(servers, eq(dbInstances.serverId, servers.id))
      .where(where);

    const counts = await instanceCounts(
      req,
      rows.map((r) => r.instance.id),
    );
    return list(
      reply,
      rows.map((r) => toInstance(r.instance, r.serverName, counts.get(r.instance.id))),
      paginate(total?.n ?? 0, q.page, q.per_page),
    );
  });

  app.get("/db-instances/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { instance, server } = await loadInstance(req, id, "read");
    const counts = await instanceCounts(req, [instance.id]);
    return item(reply, toInstance(instance, server.name, counts.get(instance.id)));
  });

  app.get("/db-instances/:id/databases", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, databaseListQuery);
    await loadInstance(req, id, "read");
    const page = await queryDatabases(req, { ...q, instance_id: id });
    return list(reply, page.rows, paginate(page.total, q.page, q.per_page));
  });

  app.get("/db-instances/:id/users", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const q = parseQuery(req, dbUserListQuery);
    await loadInstance(req, id, "read");
    const page = await queryDbUsers(req, { ...q, instance_id: id });
    return list(reply, page.rows, paginate(page.total, q.page, q.per_page));
  });

  /**
   * Reconciles the cached instance, database and user rows against the
   * host. Every RPC involved is read-only, so it passes through
   * synchronously rather than becoming a job (KD-008): there is no side
   * effect on the host to lose if the request dies mid-flight.
   */
  app.post("/db-instances/:id/sync", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    authorizeAnyEngine(req, "read");

    const instance = await instanceRow(req, id);
    const server = await loadConnectedServer(
      req,
      instance.serverId,
      dbPermission(instance.engine, "read"),
    );
    const h = helpers(req);
    const now = new Date();

    const live = await req.ctx.hub.call(server.id, "db.instance.list", {}, { timeoutMs: 15_000 });
    const match = live.instances.find(
      (i) => i.engine === instance.engine && i.port === instance.port,
    );
    if (!match) {
      throw new ApiException(
        "not_found",
        `${instance.engine} is no longer listening on port ${instance.port} on ${server.name}.`,
        {
          remediation: {
            summary:
              "The engine was removed, renamed or moved to another port. Re-sync the server so Kaname re-detects its capabilities, then delete this instance if it is really gone.",
            actions: [
              { label: "Re-sync server", action: "servers.sync" },
              { label: "Server details", href: `/infrastructure/servers/${server.id}` },
            ],
          },
        },
      );
    }

    const [refreshed] = await req.ctx.db
      .update(dbInstances)
      .set({
        version: match.version,
        host: match.host,
        status: match.reachable ? "reachable" : "unreachable",
        uptimeSeconds: match.uptime_seconds,
        connections: match.connections,
        maxConnections: match.max_connections,
        dataSize: match.data_size,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(dbInstances.id, instance.id))
      .returning();

    const [live_databases, live_users] = await Promise.all([
      req.ctx.hub.call(
        server.id,
        "db.database.list",
        { engine: instance.engine },
        { timeoutMs: 20_000 },
      ),
      req.ctx.hub.call(
        server.id,
        "db.user.list",
        { engine: instance.engine },
        { timeoutMs: 20_000 },
      ),
    ]);

    for (const d of live_databases.databases) {
      await req.ctx.db
        .insert(dbDatabases)
        .values({
          instanceId: instance.id,
          serverId: server.id,
          engine: instance.engine,
          name: d.name,
          owner: d.owner,
          encoding: d.encoding,
          collation: d.collation,
          sizeBytes: d.size_bytes,
          tableCount: d.table_count,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [dbDatabases.instanceId, dbDatabases.name],
          set: {
            owner: d.owner,
            encoding: d.encoding,
            collation: d.collation,
            sizeBytes: d.size_bytes,
            tableCount: d.table_count,
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
    }

    for (const u of live_users.users) {
      await req.ctx.db
        .insert(dbUsers)
        .values({
          instanceId: instance.id,
          serverId: server.id,
          engine: instance.engine,
          username: u.username,
          hostPattern: u.host_pattern,
          authPlugin: u.auth_plugin,
          canLogin: u.can_login,
          isSuperuser: u.is_superuser,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [dbUsers.instanceId, dbUsers.username, dbUsers.hostPattern],
          set: {
            authPlugin: u.auth_plugin,
            canLogin: u.can_login,
            isSuperuser: u.is_superuser,
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
    }

    // Anything the host no longer reports was dropped outside the panel.
    const liveNames = live_databases.databases.map((d) => d.name);
    await req.ctx.db
      .delete(dbDatabases)
      .where(
        combine(
          eq(dbDatabases.instanceId, instance.id),
          liveNames.length > 0 ? notInArray(dbDatabases.name, liveNames) : null,
        ),
      );

    const liveUsernames = live_users.users.map((u) => u.username);
    await req.ctx.db
      .delete(dbUsers)
      .where(
        combine(
          eq(dbUsers.instanceId, instance.id),
          liveUsernames.length > 0 ? notInArray(dbUsers.username, liveUsernames) : null,
        ),
      );

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "db.instance.synced",
      targetType: "db_instance",
      targetId: instance.id,
      targetLabel: `${instance.engine} on ${server.name}`,
      serverId: server.id,
      metadata: { databases: liveNames.length, users: liveUsernames.length },
    });
    req.ctx.events.publish(
      "servers",
      "db.instance.synced",
      { instance_id: instance.id, server_id: server.id },
      server.id,
    );

    const counts = await instanceCounts(req, [instance.id]);
    return item(reply, toInstance(refreshed!, server.name, counts.get(instance.id)));
  });

  /* ---------------------------- databases --------------------------- */

  app.get("/databases", async (req, reply) => {
    const q = parseQuery(req, databaseListQuery);
    authorizeAnyEngine(req, "read");
    const page = await queryDatabases(req, q);
    return list(reply, page.rows, paginate(page.total, q.page, q.per_page));
  });

  app.get("/databases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { database, server } = await loadDatabase(req, id, "read");
    const instance = await instanceRow(req, database.instanceId);
    const users = await grantsByDatabase(req, [database.id]);
    return item(reply, toDatabase(database, server.name, instance, users.get(database.id) ?? []));
  });

  app.post("/databases", async (req, reply) => {
    const body = parseBody(req, createDatabaseBody);
    authorizeAnyEngine(req, "write");

    const instance = await instanceRow(req, body.instance_id);
    if (instance.engine !== body.engine) {
      throw badRequest(`Instance ${instance.id} runs ${instance.engine}, not ${body.engine}.`, {
        engine: `must be "${instance.engine}" for this instance`,
      });
    }
    const server = await loadServer(req, instance.serverId, dbPermission(instance.engine, "write"));
    const h = helpers(req);

    const clash = await req.ctx.db
      .select({ id: dbDatabases.id })
      .from(dbDatabases)
      .where(and(eq(dbDatabases.instanceId, instance.id), eq(dbDatabases.name, body.name)))
      .limit(1);
    if (clash[0]) {
      throw conflict(
        `${server.name} already has a ${instance.engine} database named "${body.name}".`,
        {
          summary: "Database names are unique within an instance.",
          actions: [
            { label: "Open it", href: `/databases/${enginePath(instance.engine)}/${clash[0].id}` },
          ],
        },
      );
    }

    const [database] = await req.ctx.db
      .insert(dbDatabases)
      .values({
        instanceId: instance.id,
        serverId: server.id,
        engine: instance.engine,
        name: body.name,
        owner: body.owner ?? body.create_user?.username ?? null,
        encoding: body.encoding ?? defaultEncoding(instance.engine),
        collation: body.collation ?? null,
        lastSyncedAt: new Date(),
      })
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "database.created",
      targetType: "database",
      targetId: database!.id,
      targetLabel: body.name,
      serverId: server.id,
      after: { name: body.name, engine: instance.engine, owner: database!.owner },
    });
    req.ctx.events.publish(
      "servers",
      "database.created",
      { database_id: database!.id, server_id: server.id },
      server.id,
    );

    /*
     * Database, user and grant are one operator action, so they share a
     * correlation id and the activity feed shows them as one row with
     * children rather than three unrelated jobs.
     */
    const correlationId = crypto.randomUUID();
    const jobs: Job[] = [];

    jobs.push(
      await enqueueServerJob(req, {
        type: "db.database.create",
        server,
        targetType: "database",
        targetId: database!.id,
        targetLabel: body.name,
        correlationId,
        params: {
          database_id: database!.id,
          engine: instance.engine,
          name: body.name,
          encoding: database!.encoding,
          ...(body.collation ? { collation: body.collation } : {}),
          ...(database!.owner ? { owner: database!.owner } : {}),
        },
      }),
    );

    let credentials: Credentials | null = null;
    if (body.create_user) {
      const password = body.create_user.password ?? generatePassword();
      const [user] = await req.ctx.db
        .insert(dbUsers)
        .values({
          instanceId: instance.id,
          serverId: server.id,
          engine: instance.engine,
          username: body.create_user.username,
          hostPattern: body.create_user.host_pattern,
          canLogin: true,
          lastSyncedAt: new Date(),
        })
        .returning();

      await storeSecret(req, `db_user:${user!.id}`, "db_user", user!.id, password);
      await req.ctx.db
        .update(dbUsers)
        .set({ secretRef: `db_user:${user!.id}` })
        .where(eq(dbUsers.id, user!.id));

      await req.ctx.db.insert(dbGrants).values({
        databaseId: database!.id,
        dbUserId: user!.id,
        privileges: body.create_user.privileges,
        grantOption: false,
      });

      jobs.push(
        await enqueueServerJob(req, {
          type: "db.user.create",
          server,
          targetType: "db_user",
          targetId: user!.id,
          targetLabel: body.create_user.username,
          correlationId,
          params: {
            db_user_id: user!.id,
            engine: instance.engine,
            username: body.create_user.username,
            password,
            host_pattern: body.create_user.host_pattern,
          },
        }),
        await enqueueServerJob(req, {
          type: "db.grant.apply",
          server,
          targetType: "db_user",
          targetId: user!.id,
          targetLabel: `${body.create_user.username} on ${body.name}`,
          correlationId,
          params: {
            engine: instance.engine,
            database: body.name,
            username: body.create_user.username,
            host_pattern: body.create_user.host_pattern,
            privileges: body.create_user.privileges,
          },
        }),
      );

      credentials = {
        username: body.create_user.username,
        password,
        host_pattern: body.create_user.host_pattern,
        connection_string: connectionString(
          instance,
          body.name,
          body.create_user.username,
          password,
        ),
      };
    }

    return acceptedWith(reply, jobs, {
      correlation_id: correlationId,
      database: toDatabase(database!, server.name, instance, []),
      credentials,
    });
  });

  /**
   * Ownership only. The agent has no "alter owner" verb, so this records
   * who Kaname attributes the database to; the next sync reads the host's
   * own answer back over it.
   */
  app.patch("/databases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateDatabaseInput);
    const { database, server } = await loadDatabase(req, id, "write");
    const h = helpers(req);

    const [row] = await req.ctx.db
      .update(dbDatabases)
      .set({
        ...(body.owner !== undefined ? { owner: body.owner } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dbDatabases.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "database.updated",
      targetType: "database",
      targetId: id,
      targetLabel: database.name,
      serverId: server.id,
      before: { owner: database.owner },
      after: body,
    });
    req.ctx.events.publish("servers", "database.updated", { database_id: id }, server.id);

    const instance = await instanceRow(req, database.instanceId);
    const users = await grantsByDatabase(req, [id]);
    return item(reply, toDatabase(row!, server.name, instance, users.get(id) ?? []));
  });

  app.delete("/databases/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { database, server } = await loadDatabase(req, id, "delete");

    const job = await enqueueServerJob(req, {
      type: "db.database.delete",
      server,
      targetType: "database",
      targetId: id,
      targetLabel: database.name,
      params: { database_id: id, engine: database.engine, name: database.name },
    });
    return accepted(reply, job);
  });

  /** Live size, straight from the engine. Read-only, so no job. */
  app.get("/databases/:id/size", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    authorizeAnyEngine(req, "read");

    const database = await databaseRow(req, id);
    const server = await loadConnectedServer(
      req,
      database.serverId,
      dbPermission(database.engine, "read"),
    );

    const size = await req.ctx.hub.call(
      server.id,
      "db.size",
      { engine: database.engine, name: database.name },
      { timeoutMs: 15_000 },
    );
    const sampledAt = new Date();
    await req.ctx.db
      .update(dbDatabases)
      .set({
        sizeBytes: size.size_bytes,
        tableCount: size.table_count,
        lastSyncedAt: sampledAt,
        updatedAt: sampledAt,
      })
      .where(eq(dbDatabases.id, id));

    return item(reply, {
      database_id: id,
      name: database.name,
      engine: database.engine,
      size_bytes: size.size_bytes,
      table_count: size.table_count,
      sampled_at: sampledAt.toISOString(),
    });
  });

  app.post("/databases/:id/dump", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, dumpDatabaseInput);
    const { database, server } = await loadDatabase(req, id, "read");

    const job = await enqueueServerJob(req, {
      type: "db.dump",
      server,
      targetType: "database",
      targetId: id,
      targetLabel: database.name,
      params: {
        engine: database.engine,
        name: database.name,
        destination: body.destination,
        compress: body.compress,
      },
    });
    return accepted(reply, job);
  });

  /**
   * Destructive: a restore writes over whatever is in the database now.
   * The contract binds confirm_name to database_name; this rechecks both
   * against the row, so a stale form cannot restore over the wrong one.
   */
  app.post("/databases/:id/restore", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, restoreDatabaseInput);
    const { database, server } = await loadDatabase(req, id, "write");

    if (body.database_name !== database.name) {
      throw new ApiException(
        "precondition_failed",
        `This restore targets "${database.name}", but the request names "${body.database_name}".`,
        {
          remediation: {
            summary: `Type ${database.name} into both database_name and confirm_name, or open the database you meant to restore.`,
            actions: [{ label: "Copy name", copy: database.name }],
          },
        },
      );
    }

    const job = await enqueueServerJob(req, {
      type: "db.restore",
      server,
      targetType: "database",
      targetId: id,
      targetLabel: database.name,
      params: {
        engine: database.engine,
        name: database.name,
        source: body.source,
        drop_existing: body.drop_existing,
      },
    });
    return accepted(reply, job);
  });

  /* ------------------------------ users ----------------------------- */

  app.get("/db-users", async (req, reply) => {
    const q = parseQuery(req, dbUserListQuery);
    authorizeAnyEngine(req, "read");
    const page = await queryDbUsers(req, q);
    return list(reply, page.rows, paginate(page.total, q.page, q.per_page));
  });

  app.get("/db-users/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { user, server } = await loadDbUser(req, id, "read");
    const grants = await grantsByUser(req, [user.id]);
    return item(reply, toDbUser(user, server.name, grants.get(user.id) ?? []));
  });

  app.post("/db-users", async (req, reply) => {
    const body = parseBody(req, createDbUserBody);
    authorizeAnyEngine(req, "write");

    const instance = await instanceRow(req, body.instance_id);
    const server = await loadServer(req, instance.serverId, dbPermission(instance.engine, "write"));
    const h = helpers(req);

    const clash = await req.ctx.db
      .select({ id: dbUsers.id })
      .from(dbUsers)
      .where(
        and(
          eq(dbUsers.instanceId, instance.id),
          eq(dbUsers.username, body.username),
          eq(dbUsers.hostPattern, body.host_pattern),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw conflict(
        `${body.username}@${body.host_pattern} already exists on this ${instance.engine} instance.`,
        {
          summary:
            "A username is unique per host pattern. Use a different pattern, or edit the existing user.",
          actions: [
            {
              label: "Open it",
              href: `/databases/${enginePath(instance.engine)}/users/${clash[0].id}`,
            },
          ],
        },
      );
    }

    const targets = await resolveGrantTargets(req, instance.id, body.grants);
    const password = body.password ?? generatePassword();

    const [user] = await req.ctx.db
      .insert(dbUsers)
      .values({
        instanceId: instance.id,
        serverId: server.id,
        engine: instance.engine,
        username: body.username,
        hostPattern: body.host_pattern,
        canLogin: body.can_login,
        lastSyncedAt: new Date(),
      })
      .returning();

    await storeSecret(req, `db_user:${user!.id}`, "db_user", user!.id, password);
    await req.ctx.db
      .update(dbUsers)
      .set({ secretRef: `db_user:${user!.id}` })
      .where(eq(dbUsers.id, user!.id));

    for (const target of targets) {
      await req.ctx.db.insert(dbGrants).values({
        databaseId: target.database.id,
        dbUserId: user!.id,
        privileges: target.privileges,
        grantOption: target.grantOption,
      });
    }

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "db_user.created",
      targetType: "db_user",
      targetId: user!.id,
      targetLabel: `${body.username}@${body.host_pattern}`,
      serverId: server.id,
      after: {
        username: body.username,
        host_pattern: body.host_pattern,
        can_login: body.can_login,
        grants: targets.map((t) => ({ database: t.database.name, privileges: t.privileges })),
      },
    });
    req.ctx.events.publish("servers", "db_user.created", { db_user_id: user!.id }, server.id);

    const correlationId = crypto.randomUUID();
    const jobs: Job[] = [
      await enqueueServerJob(req, {
        type: "db.user.create",
        server,
        targetType: "db_user",
        targetId: user!.id,
        targetLabel: body.username,
        correlationId,
        params: {
          db_user_id: user!.id,
          engine: instance.engine,
          username: body.username,
          password,
          host_pattern: body.host_pattern,
        },
      }),
    ];
    for (const target of targets) {
      jobs.push(
        await enqueueServerJob(req, {
          type: "db.grant.apply",
          server,
          targetType: "db_user",
          targetId: user!.id,
          targetLabel: `${body.username} on ${target.database.name}`,
          correlationId,
          params: {
            engine: instance.engine,
            database: target.database.name,
            username: body.username,
            host_pattern: body.host_pattern,
            privileges: target.privileges,
          },
        }),
      );
    }

    return acceptedWith(reply, jobs, {
      correlation_id: correlationId,
      db_user: toDbUser(user!, server.name, []),
      credentials: {
        username: body.username,
        password,
        host_pattern: body.host_pattern,
        connection_string: connectionString(
          instance,
          targets[0]?.database.name ?? "",
          body.username,
          password,
        ),
      } satisfies Credentials,
    });
  });

  app.patch("/db-users/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, updateDbUserInput);
    const { user, server } = await loadDbUser(req, id, "write");
    const h = helpers(req);

    if (body.host_pattern !== undefined && body.host_pattern !== user.hostPattern) {
      throw new ApiException(
        "precondition_failed",
        `The host pattern is part of this user's identity on ${user.engine}; it cannot be edited in place.`,
        {
          remediation: {
            summary: `Create ${user.username}@${body.host_pattern} with the grants you want, then delete ${user.username}@${user.hostPattern}.`,
            actions: [{ label: "New database user", href: "/databases/users/new" }],
          },
        },
      );
    }

    const password = body.password;
    if (password) {
      await storeSecret(req, `db_user:${user.id}`, "db_user", user.id, password);
    }

    const [row] = await req.ctx.db
      .update(dbUsers)
      .set({
        ...(body.can_login !== undefined ? { canLogin: body.can_login } : {}),
        ...(password ? { secretRef: `db_user:${user.id}` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(dbUsers.id, id))
      .returning();

    await req.ctx.audit.record({
      actor: h.actor(),
      action: "db_user.updated",
      targetType: "db_user",
      targetId: id,
      targetLabel: `${user.username}@${user.hostPattern}`,
      serverId: server.id,
      before: { can_login: user.canLogin },
      after: { can_login: row!.canLogin, password_rotated: Boolean(password) },
    });
    req.ctx.events.publish("servers", "db_user.updated", { db_user_id: id }, server.id);

    const correlationId = crypto.randomUUID();
    const jobs: Job[] = [
      await enqueueServerJob(req, {
        type: "db.user.update",
        server,
        targetType: "db_user",
        targetId: id,
        targetLabel: user.username,
        correlationId,
        params: {
          engine: user.engine,
          username: user.username,
          host_pattern: user.hostPattern,
          ...(password ? { password } : {}),
          ...(body.can_login !== undefined ? { can_login: body.can_login } : {}),
        },
      }),
    ];

    if (body.grants !== undefined) {
      const applied = await applyGrantSet(req, user, server, body.grants, correlationId);
      jobs.push(...applied.jobs);
    }

    return acceptedWith(reply, jobs, { correlation_id: correlationId });
  });

  app.delete("/db-users/:id", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { user, server } = await loadDbUser(req, id, "delete");

    const job = await enqueueServerJob(req, {
      type: "db.user.delete",
      server,
      targetType: "db_user",
      targetId: id,
      targetLabel: `${user.username}@${user.hostPattern}`,
      params: {
        db_user_id: id,
        engine: user.engine,
        username: user.username,
        host_pattern: user.hostPattern,
      },
    });
    return accepted(reply, job);
  });

  app.get("/db-users/:id/grants", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const { user } = await loadDbUser(req, id, "read");
    const grants = await grantsByUser(req, [user.id]);
    return item(reply, grants.get(user.id) ?? []);
  });

  app.put("/db-users/:id/grants", async (req, reply) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, applyGrantsInput);
    const { user, server } = await loadDbUser(req, id, "write");

    const correlationId = crypto.randomUUID();
    const applied = await applyGrantSet(req, user, server, body.grants, correlationId);
    return acceptedWith(reply, applied.jobs, {
      correlation_id: correlationId,
      revoked: applied.revoked,
    });
  });
}

/**
 * Replaces a user's whole grant set. A database dropped from the list is
 * revoked on the host rather than quietly left behind, which is why the
 * removals become jobs too.
 */
async function applyGrantSet(
  req: FastifyRequest,
  user: DbUserRow,
  server: ServerRow,
  grants: GrantInput[],
  correlationId: string,
): Promise<{ jobs: Job[]; revoked: number }> {
  const h = helpers(req);
  const targets = await resolveGrantTargets(req, user.instanceId, grants);
  const before = await grantsByUser(req, [user.id]);
  const keptIds = targets.map((t) => t.database.id);
  const revoked = (before.get(user.id) ?? []).filter((g) => !keptIds.includes(g.database_id));

  await req.ctx.db.delete(dbGrants).where(eq(dbGrants.dbUserId, user.id));
  for (const target of targets) {
    await req.ctx.db.insert(dbGrants).values({
      databaseId: target.database.id,
      dbUserId: user.id,
      privileges: target.privileges,
      grantOption: target.grantOption,
    });
  }

  await req.ctx.audit.record({
    actor: h.actor(),
    action: "db_user.grants_applied",
    targetType: "db_user",
    targetId: user.id,
    targetLabel: `${user.username}@${user.hostPattern}`,
    serverId: server.id,
    before: { grants: before.get(user.id) ?? [] },
    after: {
      grants: targets.map((t) => ({ database: t.database.name, privileges: t.privileges })),
    },
  });
  req.ctx.events.publish("servers", "db_user.grants_applied", { db_user_id: user.id }, server.id);

  const jobs: Job[] = [];
  for (const target of targets) {
    jobs.push(
      await enqueueServerJob(req, {
        type: "db.grant.apply",
        server,
        targetType: "db_user",
        targetId: user.id,
        targetLabel: `${user.username} on ${target.database.name}`,
        correlationId,
        params: {
          engine: user.engine,
          database: target.database.name,
          username: user.username,
          host_pattern: user.hostPattern,
          privileges: target.privileges,
        },
      }),
    );
  }
  for (const gone of revoked) {
    jobs.push(
      await enqueueServerJob(req, {
        type: "db.grant.apply",
        server,
        targetType: "db_user",
        targetId: user.id,
        targetLabel: `revoke ${user.username} on ${gone.database_name}`,
        correlationId,
        params: {
          engine: user.engine,
          database: gone.database_name,
          username: user.username,
          host_pattern: user.hostPattern,
          privileges: [],
        },
      }),
    );
  }

  return { jobs, revoked: revoked.length };
}

/* ------------------------------------------------------------------ *
 * Input shapes
 *
 * The contract requires a password because a database user must end up
 * with one. The panel generates it when the operator does not bring
 * their own, so on the wire it is optional here and nowhere else.
 * ------------------------------------------------------------------ */

const createDatabaseBody = createDatabaseInput.extend({
  create_user: createDatabaseInput.shape.create_user
    .unwrap()
    .partial({ password: true })
    .optional(),
});

const createDbUserBody = createDbUserInput.partial({ password: true });

interface Credentials {
  username: string;
  password: string;
  host_pattern: string;
  connection_string: string;
}

/**
 * 202 with the job, plus the values that exist only in this response: a
 * generated password is shown once and is unreadable afterwards, so it
 * cannot wait for the job to finish.
 */
function acceptedWith(
  reply: FastifyReply,
  jobs: Job[],
  extra: Record<string, unknown>,
): FastifyReply {
  return reply.status(202).send({ data: { job: jobs[0] ?? null, jobs, ...extra } });
}

/* ------------------------------------------------------------------ *
 * Loaders
 *
 * Each one authorises before it reads, then re-authorises against the
 * row's own engine once that is known — a Postgres row is never handed
 * out on a MySQL grant.
 * ------------------------------------------------------------------ */

type InstanceRow = typeof dbInstances.$inferSelect;
type DatabaseRow = typeof dbDatabases.$inferSelect;
type DbUserRow = typeof dbUsers.$inferSelect;

async function instanceRow(req: FastifyRequest, id: string): Promise<InstanceRow> {
  const rows = await req.ctx.db.select().from(dbInstances).where(eq(dbInstances.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("Database instance", id);
  return row;
}

async function databaseRow(req: FastifyRequest, id: string): Promise<DatabaseRow> {
  const rows = await req.ctx.db.select().from(dbDatabases).where(eq(dbDatabases.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("Database", id);
  return row;
}

async function loadInstance(
  req: FastifyRequest,
  id: string,
  action: DbAction,
): Promise<{ instance: InstanceRow; server: ServerRow }> {
  authorizeAnyEngine(req, action);
  const instance = await instanceRow(req, id);
  const server = await loadServer(req, instance.serverId, dbPermission(instance.engine, action));
  return { instance, server };
}

async function loadDatabase(
  req: FastifyRequest,
  id: string,
  action: DbAction,
): Promise<{ database: DatabaseRow; server: ServerRow }> {
  authorizeAnyEngine(req, action);
  const database = await databaseRow(req, id);
  const server = await loadServer(req, database.serverId, dbPermission(database.engine, action));
  return { database, server };
}

async function loadDbUser(
  req: FastifyRequest,
  id: string,
  action: DbAction,
): Promise<{ user: DbUserRow; server: ServerRow }> {
  authorizeAnyEngine(req, action);
  const rows = await req.ctx.db.select().from(dbUsers).where(eq(dbUsers.id, id)).limit(1);
  const user = rows[0];
  if (!user) throw notFound("Database user", id);
  const server = await loadServer(req, user.serverId, dbPermission(user.engine, action));
  return { user, server };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

async function queryDatabases(
  req: FastifyRequest,
  q: DatabaseListQuery,
): Promise<{ rows: DatabaseResource[]; total: number }> {
  const term = searchTerm(q.q);
  const where = combine(
    engineScopeFilter(req, "read", dbDatabases.serverId, dbDatabases.engine),
    q.server_id ? eq(dbDatabases.serverId, q.server_id) : null,
    q.instance_id ? eq(dbDatabases.instanceId, q.instance_id) : null,
    q.engine ? eq(dbDatabases.engine, q.engine) : null,
    term
      ? sql`(lower(${dbDatabases.name}) like ${term} or lower(${servers.name}) like ${term})`
      : null,
  );

  const column = sortColumn(SORTABLE_DATABASES, q.sort, "name");
  const rows = await req.ctx.db
    .select({ database: dbDatabases, serverName: servers.name, instance: dbInstances })
    .from(dbDatabases)
    .innerJoin(servers, eq(dbDatabases.serverId, servers.id))
    .innerJoin(dbInstances, eq(dbDatabases.instanceId, dbInstances.id))
    .where(where)
    .orderBy(q.order === "asc" ? asc(column) : desc(column))
    .limit(q.per_page)
    .offset(offset(q.page, q.per_page));

  const [total] = await req.ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(dbDatabases)
    .innerJoin(servers, eq(dbDatabases.serverId, servers.id))
    .where(where);

  const users = await grantsByDatabase(
    req,
    rows.map((r) => r.database.id),
  );
  return {
    rows: rows.map((r) =>
      toDatabase(r.database, r.serverName, r.instance, users.get(r.database.id) ?? []),
    ),
    total: total?.n ?? 0,
  };
}

async function queryDbUsers(
  req: FastifyRequest,
  q: DbUserListQuery,
): Promise<{ rows: DbUser[]; total: number }> {
  const term = searchTerm(q.q);
  const where = combine(
    engineScopeFilter(req, "read", dbUsers.serverId, dbUsers.engine),
    q.server_id ? eq(dbUsers.serverId, q.server_id) : null,
    q.instance_id ? eq(dbUsers.instanceId, q.instance_id) : null,
    q.engine ? eq(dbUsers.engine, q.engine) : null,
    q.can_login !== undefined ? eq(dbUsers.canLogin, q.can_login) : null,
    q.database_id
      ? sql`exists (select 1 from db_grants g where g.db_user_id = ${dbUsers.id} and g.database_id = ${q.database_id})`
      : null,
    term
      ? sql`(lower(${dbUsers.username}) like ${term} or lower(${servers.name}) like ${term})`
      : null,
  );

  const column = sortColumn(SORTABLE_USERS, q.sort, "username");
  const rows = await req.ctx.db
    .select({ user: dbUsers, serverName: servers.name })
    .from(dbUsers)
    .innerJoin(servers, eq(dbUsers.serverId, servers.id))
    .where(where)
    .orderBy(q.order === "asc" ? asc(column) : desc(column))
    .limit(q.per_page)
    .offset(offset(q.page, q.per_page));

  const [total] = await req.ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(dbUsers)
    .innerJoin(servers, eq(dbUsers.serverId, servers.id))
    .where(where);

  const grants = await grantsByUser(
    req,
    rows.map((r) => r.user.id),
  );
  return {
    rows: rows.map((r) => toDbUser(r.user, r.serverName, grants.get(r.user.id) ?? [])),
    total: total?.n ?? 0,
  };
}

async function instanceCounts(
  req: FastifyRequest,
  ids: string[],
): Promise<Map<string, { databases: number; users: number }>> {
  const out = new Map<string, { databases: number; users: number }>();
  if (ids.length === 0) return out;

  const databases = await req.ctx.db
    .select({ id: dbDatabases.instanceId, n: sql<number>`count(*)::int` })
    .from(dbDatabases)
    .where(inArray(dbDatabases.instanceId, ids))
    .groupBy(dbDatabases.instanceId);
  const users = await req.ctx.db
    .select({ id: dbUsers.instanceId, n: sql<number>`count(*)::int` })
    .from(dbUsers)
    .where(inArray(dbUsers.instanceId, ids))
    .groupBy(dbUsers.instanceId);

  for (const id of ids) out.set(id, { databases: 0, users: 0 });
  for (const row of databases) out.get(row.id)!.databases = row.n;
  for (const row of users) out.get(row.id)!.users = row.n;
  return out;
}

/** Users (with privileges) per database id. */
async function grantsByDatabase(
  req: FastifyRequest,
  databaseIds: string[],
): Promise<Map<string, DatabaseResource["users"]>> {
  const out = new Map<string, DatabaseResource["users"]>();
  if (databaseIds.length === 0) return out;

  const rows = await req.ctx.db
    .select({ grant: dbGrants, user: dbUsers })
    .from(dbGrants)
    .innerJoin(dbUsers, eq(dbGrants.dbUserId, dbUsers.id))
    .where(inArray(dbGrants.databaseId, databaseIds));

  for (const id of databaseIds) out.set(id, []);
  for (const row of rows) {
    out.get(row.grant.databaseId)?.push({
      id: row.user.id,
      username: row.user.username,
      privileges: row.grant.privileges as DbGrant["privileges"],
    });
  }
  return out;
}

/** Grants (with database names) per user id. */
async function grantsByUser(
  req: FastifyRequest,
  userIds: string[],
): Promise<Map<string, DbGrant[]>> {
  const out = new Map<string, DbGrant[]>();
  if (userIds.length === 0) return out;

  const rows = await req.ctx.db
    .select({ grant: dbGrants, databaseName: dbDatabases.name })
    .from(dbGrants)
    .innerJoin(dbDatabases, eq(dbGrants.databaseId, dbDatabases.id))
    .where(inArray(dbGrants.dbUserId, userIds));

  for (const id of userIds) out.set(id, []);
  for (const row of rows) {
    out.get(row.grant.dbUserId)?.push({
      database_id: row.grant.databaseId,
      database_name: row.databaseName,
      privileges: row.grant.privileges as DbGrant["privileges"],
      grant_option: row.grant.grantOption,
    });
  }
  return out;
}

/** Grants name databases by id; this proves they live on the same instance. */
async function resolveGrantTargets(
  req: FastifyRequest,
  instanceId: string,
  grants: { database_id: string; privileges: DbGrant["privileges"]; grant_option: boolean }[],
): Promise<{ database: DatabaseRow; privileges: DbGrant["privileges"]; grantOption: boolean }[]> {
  const out: { database: DatabaseRow; privileges: DbGrant["privileges"]; grantOption: boolean }[] =
    [];
  for (const grant of grants) {
    const database = await databaseRow(req, grant.database_id);
    if (database.instanceId !== instanceId) {
      throw badRequest(
        `Database "${database.name}" belongs to another instance, so this user cannot be granted on it.`,
        { grants: `database_id ${grant.database_id} is not on instance ${instanceId}` },
      );
    }
    out.push({ database, privileges: grant.privileges, grantOption: grant.grant_option });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Secrets and credentials
 * ------------------------------------------------------------------ */

/** 32 URL-safe characters: comfortably past the contract's 16 minimum. */
function generatePassword(): string {
  return generateToken().slice(0, 32);
}

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

function scheme(engine: DbEngine): string {
  return engine === "postgres" ? "postgresql" : "mysql";
}

function defaultEncoding(engine: DbEngine): string {
  return engine === "postgres" ? "UTF8" : "utf8mb4";
}

function enginePath(engine: DbEngine): string {
  return engine === "postgres" ? "postgres" : "mysql";
}

/** Placeholders only — the real password is never denormalised onto a row. */
function connectionTemplate(instance: InstanceRow, name: string): string {
  return `${scheme(instance.engine)}://{user}:{password}@${instance.host}:${instance.port}/${name}`;
}

function connectionString(
  instance: InstanceRow,
  name: string,
  username: string,
  password: string,
): string {
  return `${scheme(instance.engine)}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${instance.host}:${instance.port}/${name}`;
}

/* ------------------------------------------------------------------ *
 * Row to API shape
 * ------------------------------------------------------------------ */

function toInstance(
  row: InstanceRow,
  serverName: string,
  counts: { databases: number; users: number } | undefined,
): DbInstance {
  return {
    id: row.id,
    server_id: row.serverId,
    server_name: serverName,
    engine: row.engine,
    version: row.version,
    host: row.host,
    port: row.port,
    status: row.status,
    uptime_seconds: row.uptimeSeconds,
    connections: row.connections,
    max_connections: row.maxConnections,
    data_size: row.dataSize,
    database_count: counts?.databases ?? 0,
    user_count: counts?.users ?? 0,
    last_synced_at: (row.lastSyncedAt ?? row.updatedAt).toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toDatabase(
  row: DatabaseRow,
  serverName: string,
  instance: InstanceRow,
  users: DatabaseResource["users"],
): DatabaseResource {
  return {
    id: row.id,
    instance_id: row.instanceId,
    server_id: row.serverId,
    server_name: serverName,
    engine: row.engine,
    name: row.name,
    owner: row.owner,
    encoding: row.encoding,
    collation: row.collation,
    size_bytes: row.sizeBytes,
    table_count: row.tableCount,
    connection_string_template: connectionTemplate(instance, row.name),
    users,
    last_backup_at: row.lastBackupAt?.toISOString() ?? null,
    last_synced_at: (row.lastSyncedAt ?? row.updatedAt).toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function toDbUser(row: DbUserRow, serverName: string, grants: DbGrant[]): DbUser {
  return {
    id: row.id,
    instance_id: row.instanceId,
    server_id: row.serverId,
    server_name: serverName,
    engine: row.engine,
    username: row.username,
    host_pattern: row.hostPattern,
    auth_plugin: row.authPlugin,
    can_login: row.canLogin,
    is_superuser: row.isSuperuser,
    grants,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    last_synced_at: (row.lastSyncedAt ?? row.updatedAt).toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
