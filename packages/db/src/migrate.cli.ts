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

import { loadWorkspaceEnv } from "./env.js";
import { runMigrations } from "./migrate.js";

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
