import { readFile } from "node:fs/promises";
import { loadWorkspaceEnv } from "./env.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "drizzle");

/**
 * Runs generated migrations, then applies the idempotent hardening SQL.
 * Safe to run on every boot; the control plane calls it at startup so a
 * fresh install is usable without a separate step.
 */
export async function runMigrations(url?: string): Promise<void> {
  const handle = await createDb(url);
  try {
    await migrateHandle(handle);
  } finally {
    await handle.close();
  }
}

/** Migrates an already-open handle. Used by tests and by the control plane at boot. */
export async function migrateHandle(handle: DbHandle): Promise<void> {
  if (!existsSync(migrationsFolder)) {
    throw new Error(`No migrations found at ${migrationsFolder}. Run "pnpm db:generate" first.`);
  }

  if (handle.driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(handle.db as never, { migrationsFolder });
  }

  const hardening = await readFile(join(here, "hardening.sql"), "utf8");
  for (const statement of splitStatements(hardening)) {
    await handle.db.execute(sql.raw(statement));
  }
}

/** Naive splitter is fine here: hardening.sql contains no dollar-quoted bodies. */
function splitStatements(source: string): string[] {
  return source
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

// pathToFileURL, not string concatenation: on Windows argv[1] is a drive
// path and the naive form produces file://C:/... instead of file:///C:/...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadWorkspaceEnv();
  runMigrations()
    .then(() => {
      console.log("migrations applied");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
