/*
 * The CLI entry point, deliberately in its own file.
 *
 * It used to be an `import.meta.url === argv[1]` guard at the bottom of
 * the module. That is correct until the module is bundled: tsup folds
 * the whole workspace into one file, `import.meta.url` becomes the
 * bundle's own URL, and `node dist/main.js` satisfies the guard — so the
 * control plane ran the migration a second time and then exited 0
 * before it ever listened. A separate file cannot be mistaken for the
 * bundle entry.
 */

import { createDb } from "./index.js";
import { loadWorkspaceEnv } from "./env.js";
import { seedDemo } from "./seed.js";

loadWorkspaceEnv();

const handle = await createDb();
try {
  await seedDemo(handle.db);
} finally {
  await handle.close();
}
process.exit(0);
