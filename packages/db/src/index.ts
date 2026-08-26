import { createRequire } from "node:module";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import * as schema from "./schema/index.js";

export * as schema from "./schema/index.js";
export * from "./schema/index.js";
export {
  sql,
  eq,
  ne,
  and,
  or,
  not,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  desc,
  asc,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  notLike,
  between,
  exists,
  count,
  countDistinct,
  sum,
  avg,
  max,
  min,
  getTableColumns,
} from "drizzle-orm";
export type { SQL, SQLWrapper, InferSelectModel, InferInsertModel } from "drizzle-orm";
export type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type Schema = typeof schema;

/**
 * The common Drizzle base both drivers extend. Typing the handle as a
 * union of NodePgDatabase and PgliteDatabase looks natural but breaks
 * every builder call, because TypeScript intersects the two sets of
 * overloads. The shared base class gives one coherent surface.
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export interface DbHandle {
  db: Database;
  /** "pglite" in development, "postgres" in production (KD-004). */
  driver: "pglite" | "postgres";
  /** Underlying client, for LISTEN/NOTIFY and shutdown. */
  client: unknown;
  close(): Promise<void>;
}

let handle: DbHandle | null = null;

/**
 * PGlite is single-connection by design, so in development the API and
 * the job worker share one client. That is fine at dev concurrency and
 * is explicitly not the production path.
 */
export async function createDb(url = process.env.DATABASE_URL): Promise<DbHandle> {
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Use pglite://./.data/kaname for local development, " +
        "or a postgres:// URL in production.",
    );
  }

  if (url.startsWith("pglite://") || url.startsWith("file://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { mkdirSync } = await import("node:fs");
    const target = url.replace(/^(pglite|file):\/\//, "");
    let client: InstanceType<typeof PGlite>;
    if (target === ":memory:" || target === "memory") {
      // Used by the integration tests: a real Postgres, thrown away after.
      client = new PGlite();
    } else {
      const dir = resolveDataDir(target);
      // PGlite mkdirs only one level, so a nested .data/kaname path fails.
      mkdirSync(dir, { recursive: true });
      client = new PGlite(dir);
    }
    await client.waitReady;
    return {
      db: drizzlePglite(client, { schema }) as unknown as Database,
      driver: "pglite",
      client,
      close: () => client.close(),
    };
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Fail loudly at boot rather than on the first query.
  await pool.query("select 1");
  return {
    db: drizzlePg(pool, { schema }) as unknown as Database,
    driver: "postgres",
    client: pool,
    close: () => pool.end(),
  };
}

/** Process-wide singleton, so the API and the worker share one pool. */
export async function getDb(): Promise<DbHandle> {
  handle ??= await createDb();
  return handle;
}

export async function closeDb(): Promise<void> {
  if (!handle) return;
  await handle.close();
  handle = null;
}

/**
 * Resolves a relative PGlite path against the workspace root rather than
 * the process's cwd, so the control plane, the CLI scripts and the dev
 * fleet all open the same development database no matter which package
 * directory they were launched from.
 */
export function resolveDataDir(dir: string): string {
  if (isAbsolutePath(dir)) return dir;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync } = requireSync("node:fs") as typeof import("node:fs");
  const path = requireSync("node:path") as typeof import("node:path");

  let cursor = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(cursor, "pnpm-workspace.yaml"))) {
      return path.resolve(cursor, dir);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.resolve(process.cwd(), dir);
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\/]/.test(p);
}

let _require: NodeRequire | null = null;
function requireSync(id: string): unknown {
  _require ??= createRequire(import.meta.url);
  return _require(id);
}
