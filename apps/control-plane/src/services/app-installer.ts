import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  appInstallSteps,
  type dbPrivilege,
  type AppInstallPlan,
  type AppInstallStepSpec,
  type AppRecipe,
  type DbEngine,
  type InstallAppInput,
} from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * App installer: planning.
 *
 * Everything here is pure. Given a recipe and what the person chose, it
 * works out the names an install will use, the steps it will run, and
 * the configuration file it will write — without a database or an
 * agent in reach. The route uses it to say what would happen before
 * anything does; the job uses the same functions to do it, so the two
 * cannot drift.
 *
 * Nothing in this file builds a command line. The only text produced
 * for a host is the *content* of a configuration file, handed to the
 * agent's `fs.write` as data, with every interpolated value escaped
 * for the language the file is in (PLAN.md section 0).
 * ------------------------------------------------------------------ */

type DbPrivilege = z.infer<typeof dbPrivilege>;

/** Where app sites live on a host. Same root the Sites module suggests. */
export const APP_SITES_ROOT = "/var/www";

/** Privileges an app's own database user gets on its own database, and nothing else. */
export const APP_DB_PRIVILEGES: readonly DbPrivilege[] = ["ALL"];

export interface InstallNames {
  /** The vhost name; the domain, as the Sites module does by convention. */
  siteName: string;
  /** Holds `releases/` and the `current` symlink. */
  deployRoot: string;
  /** What the vhost serves: `current`, or a directory inside it. */
  webroot: string;
  /** The release directory's name under `releases/`. */
  release: string;
  database: string | null;
  dbUser: string | null;
  dbHostPattern: string;
  url: string;
}

/** A domain as the middle of a database identifier: letters, digits, underscores. */
function domainSlug(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * Every name an install uses, derived from the recipe, the domain and
 * the install's own id. Deterministic on purpose: a resumed run asks
 * for the same database it asked for the first time, which is what
 * lets "already exists" on a resume mean "mine".
 */
export function installNames(
  recipe: AppRecipe,
  input: Pick<InstallAppInput, "domain" | "ssl">,
  installId: string,
): InstallNames {
  const domain = input.domain.toLowerCase();
  const suffix = installId.replace(/-/g, "").slice(0, 8);
  const deployRoot = `${APP_SITES_ROOT}/${domain}`;
  const docroot = recipe.source.kind === "git" ? recipe.source.document_root : "";
  const db = recipe.requirements.database;

  return {
    siteName: domain,
    deployRoot,
    webroot: docroot ? `${deployRoot}/current/${docroot}` : `${deployRoot}/current`,
    release: `${recipe.id}-${recipe.version}-${suffix}`.slice(0, 64),
    database: db ? `${db.prefix}_${domainSlug(domain)}_${suffix.slice(0, 4)}` : null,
    // MySQL caps a user name at 32 characters; this stays well inside it.
    dbUser: db ? `${db.prefix}_${suffix}` : null,
    dbHostPattern: "localhost",
    url: `${input.ssl ? "https" : "http"}://${domain}`,
  };
}

/**
 * The engine an install will use: the one asked for if the recipe
 * accepts it and the server runs it, otherwise the recipe's first
 * preference that the server runs. Null when the app needs no database.
 */
export function chooseEngine(
  recipe: AppRecipe,
  requested: DbEngine | undefined,
  available: readonly DbEngine[],
): { engine: DbEngine | null; problem: string | null } {
  const db = recipe.requirements.database;
  if (!db) return { engine: null, problem: null };

  if (requested) {
    if (!db.engines.includes(requested)) {
      return {
        engine: null,
        problem: `${recipe.name} does not run on ${requested}. It supports ${db.engines.join(", ")}.`,
      };
    }
    if (!available.includes(requested)) {
      return { engine: null, problem: `This server does not run ${requested}.` };
    }
    return { engine: requested, problem: null };
  }

  const engine = db.engines.find((candidate) => available.includes(candidate)) ?? null;
  return {
    engine,
    problem: engine
      ? null
      : `${recipe.name} needs ${db.engines.join(" or ")}, and this server runs neither.`,
  };
}

export function planSteps(recipe: AppRecipe, ssl: boolean): AppInstallStepSpec[] {
  return appInstallSteps(recipe, { ssl });
}

/** The dry-run answer: what an install would create, and in what order. */
export function buildPlan(
  recipe: AppRecipe,
  input: InstallAppInput,
  context: { installId: string; serverName: string; engine: DbEngine | null; notices?: string[] },
): AppInstallPlan {
  const names = installNames(recipe, input, context.installId);
  return {
    plan_id: context.installId,
    app_id: recipe.id,
    app_name: recipe.name,
    app_version: recipe.version,
    server_id: input.server_id,
    server_name: context.serverName,
    url: names.url,
    site_name: names.siteName,
    deploy_root: names.deployRoot,
    webroot: names.webroot,
    db_engine: context.engine,
    database: context.engine ? names.database : null,
    db_user: context.engine ? names.dbUser : null,
    steps: planSteps(recipe, input.ssl),
    notices: context.notices ?? [],
  };
}

/* ------------------------------------------------------------------ *
 * Configuration files
 * ------------------------------------------------------------------ */

export interface ConfigFile {
  /** Relative to the release directory. */
  path: string;
  content: string;
  mode: string;
}

export interface ConfigContext {
  database: string;
  dbUser: string;
  dbPassword: string;
  dbHost: string;
  dbPort: number;
  engine: DbEngine;
}

/** 32 URL-safe characters, the same shape the Databases module generates. */
export function generatePassword(): string {
  return randomBytes(32).toString("base64url").slice(0, 32);
}

/**
 * A PHP single-quoted string literal. Inside single quotes PHP reads
 * only `\\` and `\'` as escapes, so those two are the whole job — and a
 * NUL or a line break has no business in a credential, so it is
 * refused rather than written.
 */
export function phpString(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("a configuration value may not contain a line break or NUL");
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * How the app should reach its database. A loopback instance is
 * addressed as `localhost`, which MySQL clients take to mean the local
 * socket — the connection the user's `localhost` host pattern matches
 * whether or not the server resolves names.
 */
export function dbHostFor(host: string, port: number, engine: DbEngine): string {
  const defaultPort = engine === "postgres" ? 5432 : 3306;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const name = loopback ? "localhost" : host;
  return port === defaultPort ? name : `${name}:${port}`;
}

const WORDPRESS_SALTS = [
  "AUTH_KEY",
  "SECURE_AUTH_KEY",
  "LOGGED_IN_KEY",
  "NONCE_KEY",
  "AUTH_SALT",
  "SECURE_AUTH_SALT",
  "LOGGED_IN_SALT",
  "NONCE_SALT",
] as const;

function wordpressConfig(ctx: ConfigContext, salt: () => string): string {
  const lines = [
    "<?php",
    "/**",
    " * Written by Kaname's app installer. Edit it like any wp-config.php;",
    " * Kaname does not rewrite it.",
    " */",
    "",
    `define( 'DB_NAME', ${phpString(ctx.database)} );`,
    `define( 'DB_USER', ${phpString(ctx.dbUser)} );`,
    `define( 'DB_PASSWORD', ${phpString(ctx.dbPassword)} );`,
    `define( 'DB_HOST', ${phpString(dbHostFor(ctx.dbHost, ctx.dbPort, ctx.engine))} );`,
    "define( 'DB_CHARSET', 'utf8mb4' );",
    "define( 'DB_COLLATE', '' );",
    "",
    ...WORDPRESS_SALTS.map((name) => `define( '${name}', ${phpString(salt())} );`),
    "",
    "$table_prefix = 'wp_';",
    "",
    "define( 'WP_DEBUG', false );",
    "",
    "if ( ! defined( 'ABSPATH' ) ) {",
    "\tdefine( 'ABSPATH', __DIR__ . '/' );",
    "}",
    "",
    "require_once ABSPATH . 'wp-settings.php';",
    "",
  ];
  return lines.join("\n");
}

/**
 * The files a recipe's `config` template writes. `salt` is injectable
 * so a test can pin the output; in production it is 48 random bytes.
 */
export function renderConfig(
  recipe: AppRecipe,
  ctx: ConfigContext | null,
  salt: () => string = () => randomBytes(48).toString("base64url"),
): ConfigFile[] {
  switch (recipe.config) {
    case "none":
      return [];
    case "wordpress":
      if (!ctx) throw new Error(`${recipe.name} needs a database to be configured`);
      // 0640: the web server's account reads it, nobody else on the host does.
      return [{ path: "wp-config.php", content: wordpressConfig(ctx, salt), mode: "0640" }];
  }
}

/** The absolute paths handed to the web server's account, inside one release. */
export function writablePaths(recipe: AppRecipe, releasePath: string): string[] {
  const root = releasePath.replace(/\/+$/, "");
  return recipe.writable_paths.map((relative) => (relative ? `${root}/${relative}` : root));
}
