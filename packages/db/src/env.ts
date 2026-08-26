import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Loads .env from the workspace root. The db CLI scripts run from
 * packages/db, so without this they would miss DATABASE_URL and quietly
 * operate on a different database than the control plane. Real
 * environment variables always win over the file.
 */
export function loadWorkspaceEnv(startDir = process.cwd()): string | null {
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(cursor, "pnpm-workspace.yaml"))) {
      const candidate = join(cursor, ".env");
      if (existsSync(candidate)) {
        process.loadEnvFile(candidate);
        return candidate;
      }
      return null;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}
