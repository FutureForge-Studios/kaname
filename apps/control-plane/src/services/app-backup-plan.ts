import { eq, inArray, type Database } from "@kaname/db";
import { appInstalls } from "@kaname/db/schema";
import { MANAGED_APPS_ROOT } from "@kaname/contract/agent";
import { findApp, type AppBackupManifest, type AppRecipe } from "@kaname/contract";
import { badRequest } from "../lib/errors.js";
import { APP_SITES_ROOT, containerSecretNames, containerSecretRef } from "./app-installer.js";

/* ------------------------------------------------------------------ *
 * App backups: what an `app` scope means on the host.
 *
 * Pure planning, shared by "Run now", the scheduler and the restore job,
 * so they always agree on where an app's data and dumps live.
 *
 * Image recipes (KD-040) keep everything under
 * MANAGED_APPS_ROOT/<install>/: `data/` (the app's own files),
 * `<role>/data` per companion, and `kaname-backup/` where the agent's
 * `app.db_dump` writes each SQL companion's dump and Kaname writes the
 * manifest. The snapshot takes the whole install directory except the
 * SQL companions' raw data directories — the dump is the consistent copy
 * of those, a live data directory is not. ClickHouse has no dump tool in
 * the closed engine list, so its data directory is taken as files.
 *
 * Git recipes (WordPress, DokuWiki) reuse the files and databases
 * scopes: the site root, plus a `db.dump` written inside it (never under
 * the served `current/` tree), plus the manifest beside it.
 * ------------------------------------------------------------------ */

type InstallRow = typeof appInstalls.$inferSelect;

/** Engines `app.db_dump` has a fixed argv for. */
const DUMPABLE = new Set(["postgres", "mysql", "mariadb"]);

/**
 * Recipes whose app container is stopped for the snapshot: those that
 * keep live state in files a copy could catch half-written (SQLite, git
 * repositories, a ClickHouse beside the app). Kept here rather than in
 * the recipe so the catalog stays the installer's.
 */
export const STOP_DURING_BACKUP: Readonly<Record<string, boolean>> = {
  "uptime-kuma": true,
  gitea: true,
  nextcloud: true,
  plausible: true,
  // Its library database is SQLite.
  jellyfin: true,
  ghost: false,
  n8n: false,
};

export interface AppBackupPlanEntry {
  install_id: string;
  kind: "image" | "git";
  /** Stop the app container while the snapshot is taken. */
  stop: boolean;
  /** SQL companions dumped with app.db_dump before the snapshot. */
  companions: { role: string; engine: string }[];
  /** Git recipes: the install's database, dumped with db.dump into the site root. */
  database: { engine: string; name: string } | null;
  /** Where the manifest is written on the host. */
  manifest_path: string;
}

export interface AppScopePlan {
  paths: string[];
  exclude: string[];
  apps: AppBackupPlanEntry[];
}

export function installDir(installId: string): string {
  return `${MANAGED_APPS_ROOT}/${installId}`;
}

export function siteRoot(row: Pick<InstallRow, "domain" | "resources">): string {
  return row.resources.deploy_root ?? `${APP_SITES_ROOT}/${row.domain.toLowerCase()}`;
}

/** The directory, inside an install's tree, that holds its dumps and manifest. */
export function backupDirFor(row: Pick<InstallRow, "id" | "domain" | "resources">, recipe: AppRecipe): string {
  return recipe.source.kind === "image" ? `${installDir(row.id)}/kaname-backup` : `${siteRoot(row)}/.kaname-backup`;
}

/** Whether (and why not) an install can be backed up as an app. */
export function unsupportedReason(row: InstallRow | undefined, recipe: AppRecipe | undefined): string | null {
  if (!row) return "The install no longer exists.";
  if (!recipe) return `${row.appName} is no longer in the catalog, so Kaname cannot tell what to back up.`;
  if (row.status !== "active") return `${row.appName} on ${row.domain} is ${row.status}; only an active install can be backed up.`;
  return null;
}

export function planEntry(row: InstallRow, recipe: AppRecipe): AppBackupPlanEntry {
  const source = recipe.source;
  if (source.kind === "image") {
    return {
      install_id: row.id,
      kind: "image",
      stop: STOP_DURING_BACKUP[recipe.id] ?? false,
      companions: source.companions
        .filter((c) => DUMPABLE.has(c.engine))
        .map((c) => ({ role: c.role, engine: c.engine })),
      database: null,
      manifest_path: `${backupDirFor(row, recipe)}/manifest.json`,
    };
  }
  return {
    install_id: row.id,
    kind: "git",
    stop: false,
    companions: [],
    database:
      row.resources.database && row.dbEngine ? { engine: row.dbEngine, name: row.resources.database } : null,
    manifest_path: `${backupDirFor(row, recipe)}/manifest.json`,
  };
}

/** The paths and excludes one install contributes to a snapshot. */
export function pathsFor(row: InstallRow, recipe: AppRecipe): { paths: string[]; exclude: string[] } {
  const source = recipe.source;
  if (source.kind === "image") {
    return {
      paths: [installDir(row.id)],
      exclude: source.companions
        .filter((c) => DUMPABLE.has(c.engine))
        .map((c) => `${installDir(row.id)}/${c.role}/data`),
    };
  }
  return { paths: [siteRoot(row)], exclude: [] };
}

/**
 * Resolves an `app` scope's selectors (install ids) for one server.
 * Every install must exist, be active and live on that server.
 */
export async function planAppScope(db: Database, serverId: string, selectors: string[]): Promise<AppScopePlan> {
  if (selectors.length === 0) {
    throw badRequest("An app scope names at least one app install.", {
      scope: "pick the installs to back up",
    });
  }
  const rows = await db.select().from(appInstalls).where(inArray(appInstalls.id, selectors));
  const plan: AppScopePlan = { paths: [], exclude: [], apps: [] };
  for (const id of selectors) {
    const row = rows.find((r) => r.id === id);
    const recipe = row ? findApp(row.appId) : undefined;
    const reason = unsupportedReason(row, recipe);
    if (reason) throw badRequest(reason, { scope: `app ${id} cannot be backed up` });
    if (row!.serverId !== serverId) {
      throw badRequest(`${row!.appName} on ${row!.domain} runs on another server than this schedule's.`, {
        scope: "an app scope only names installs on the schedule's own server",
      });
    }
    const { paths, exclude } = pathsFor(row!, recipe!);
    plan.paths.push(...paths);
    plan.exclude.push(...exclude);
    plan.apps.push(planEntry(row!, recipe!));
  }
  return plan;
}

/** The manifest written beside an app's data. Secrets appear by ref only. */
export function buildManifest(
  row: InstallRow,
  recipe: AppRecipe,
  entry: AppBackupPlanEntry,
  dumps: { role: string; engine: string; path: string }[],
  takenAt: Date,
  stopped: boolean,
): AppBackupManifest {
  const source = recipe.source;
  return {
    format: 1,
    install_id: row.id,
    app_id: recipe.id,
    app_name: recipe.name,
    app_version: row.appVersion,
    domain: row.domain,
    ssl: row.ssl,
    server_id: row.serverId,
    source: source.kind,
    images: source.kind === "image" ? [...new Set([source.image, ...source.companions.map((c) => c.image)])] : [],
    companions:
      source.kind === "image"
        ? source.companions.map((c) => ({
            role: c.role,
            engine: c.engine,
            image: c.image,
            dumped: dumps.some((d) => d.role === c.role),
          }))
        : [],
    settings: { ...row.inputs, db_engine: row.dbEngine, app_port: row.appPort ?? null },
    secret_refs: containerSecretNames(recipe).map((name) => containerSecretRef(row.id, name)),
    paths: {
      data: source.kind === "image" ? `${installDir(row.id)}/data` : null,
      dumps,
      site_root: source.kind === "git" ? siteRoot(row) : null,
      databases: entry.database ? [entry.database] : [],
    },
    stopped,
    taken_at: takenAt.toISOString(),
  };
}

export async function loadInstallRow(db: Database, id: string): Promise<InstallRow | undefined> {
  const rows = await db.select().from(appInstalls).where(eq(appInstalls.id, id)).limit(1);
  return rows[0];
}
