import { rm } from "node:fs/promises";
import { loadWorkspaceEnv } from "./env.js";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, resolveDataDir } from "./index.js";
import { runMigrations } from "./migrate.js";
import { seedDemo } from "./seed.js";

/* ------------------------------------------------------------------ *
 * Drops everything and rebuilds. Refuses to run against production,
 * because a reset command that can be pointed at a live install is a
 * loaded gun.
 * ------------------------------------------------------------------ */

export async function reset(url = process.env.DATABASE_URL): Promise<void> {
  if (process.env.KANAME_ENV === "production") {
    throw new Error("refusing to reset the database with KANAME_ENV=production");
  }

  const target = url ?? "pglite://./.data/kaname";

  if (target.startsWith("pglite://") || target.startsWith("file://")) {
    const dir = target.replace(/^(pglite|file):\/\//, "");
    /*
     * Deleting the directory is faster and more thorough than DROP SCHEMA,
     * but it has to be resolved exactly the way createDb resolves it —
     * against the workspace root, not against whichever package directory
     * pnpm launched this from. Resolving it against the cwd deletes a path
     * that was never the database, then reports "database reset" while the
     * old one is still there and the seed skips itself.
     */
    if (dir !== ":memory:" && dir !== "memory") {
      await rm(resolveDataDir(dir), { recursive: true, force: true });
    }
  } else {
    const handle = await createDb(target);
    try {
      await handle.db.execute(sql`drop schema public cascade; create schema public;`);
    } finally {
      await handle.close();
    }
  }

  await runMigrations(target);

  const handle = await createDb(target);
  try {
    await seedDemo(handle.db);
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadWorkspaceEnv();
  reset()
    .then(() => {
      console.log("database reset");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
