import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  MANAGED_APPS_ROOT,
  appInstallSteps,
  type ManagedContainerSpec,
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
  /** Image recipes: the install's directory under the managed apps root. Null otherwise. */
  dataDir: string | null;
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
  const image = recipe.source.kind === "image";

  return {
    siteName: domain,
    deployRoot,
    // An image recipe's vhost proxies everything but the ACME challenge,
    // which nginx answers from here; the app's own data never is.
    webroot: image ? deployRoot : docroot ? `${deployRoot}/current/${docroot}` : `${deployRoot}/current`,
    release: `${recipe.id}-${recipe.version}-${suffix}`.slice(0, 64),
    database: db ? `${db.prefix}_${domainSlug(domain)}_${suffix.slice(0, 4)}` : null,
    // MySQL caps a user name at 32 characters; this stays well inside it.
    dbUser: db ? `${db.prefix}_${suffix}` : null,
    dbHostPattern: "localhost",
    url: `${input.ssl ? "https" : "http"}://${domain}`,
    dataDir: image ? `${MANAGED_APPS_ROOT}/${installId}` : null,
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
  context: {
    installId: string;
    serverName: string;
    engine: DbEngine | null;
    notices?: string[];
    appPort?: number | null;
  },
): AppInstallPlan {
  const names = installNames(recipe, input, context.installId);
  const source = recipe.source;
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
    app_port: source.kind === "image" ? (context.appPort ?? null) : null,
    containers:
      source.kind === "image"
        ? [
            ...(source.database ? [{ role: "db", image: source.database.image }] : []),
            { role: "app", image: source.image },
          ]
        : [],
    notices: context.notices ?? [],
  };
}

/* ------------------------------------------------------------------ *
 * Image recipes (KD-040)
 *
 * The control plane's half of a container install: which loopback port
 * the app gets, and the closed specs handed to `container.create`. The
 * agent re-checks every spec (bind sources under the managed root,
 * loopback-only ports, a tagged image) and decides everything the spec
 * cannot say, so nothing here can widen what a container may reach.
 * ------------------------------------------------------------------ */

/**
 * Loopback ports handed to app containers. Below the kernel's default
 * ephemeral range (32768+) so an outgoing connection never holds one,
 * and clear of the usual development ports.
 */
export const APP_PORT_RANGE = { min: 20000, max: 29999 } as const;

/** The lowest port in the range nobody on the server holds. Null when the range is full. */
export function allocatePort(
  used: Iterable<number | null | undefined>,
  range: { min: number; max: number } = APP_PORT_RANGE,
): number | null {
  const taken = new Set<number>();
  for (const port of used) if (typeof port === "number") taken.add(port);
  for (let port = range.min; port <= range.max; port += 1) {
    if (!taken.has(port)) return port;
  }
  return null;
}

/** The secrets an image install generates once and keeps sealed. */
export interface ContainerSecrets {
  dbPassword: string | null;
  /** MySQL's root account, which the image insists on having. */
  dbRootPassword: string | null;
  /** n8n encrypts stored credentials with it; losing it loses them. */
  encryptionKey: string | null;
}

export type ContainerSecretName = keyof ContainerSecrets;

/** Which secrets a recipe needs. */
export function containerSecretNames(recipe: AppRecipe): ContainerSecretName[] {
  if (recipe.source.kind !== "image") return [];
  const names: ContainerSecretName[] = [];
  if (recipe.source.database) names.push("dbPassword");
  if (recipe.source.database?.engine === "mysql") names.push("dbRootPassword");
  if (recipe.config === "n8n") names.push("encryptionKey");
  return names;
}

/** Where a sealed install secret lives in `secrets`. */
export function containerSecretRef(installId: string, name: ContainerSecretName): string {
  const suffix = { dbPassword: "db_password", dbRootPassword: "db_root_password", encryptionKey: "encryption_key" }[
    name
  ];
  return `app_install:${installId}:${suffix}`;
}

/** The private-network host name the app reaches its database on. */
export const COMPANION_DB_HOST = "db";

/**
 * The database and user name inside the companion container. Fixed per
 * app: the server holds nothing else, so there is nothing to collide with.
 */
export function companionDbName(recipe: AppRecipe): string {
  return recipe.id.replace(/[^a-z0-9]/g, "");
}

export interface ContainerContext {
  installId: string;
  domain: string;
  ssl: boolean;
  appPort: number;
  secrets: ContainerSecrets;
}

function need(value: string | null, what: string): string {
  if (!value) throw new Error(`the install's ${what} is missing`);
  return value;
}

/** The app container's environment, per recipe. Every value is data; none is a command. */
export function appEnvironment(recipe: AppRecipe, ctx: ContainerContext): Record<string, string> {
  const url = `${ctx.ssl ? "https" : "http"}://${ctx.domain}`;
  const name = companionDbName(recipe);
  switch (recipe.config) {
    case "ghost":
      return {
        NODE_ENV: "production",
        url,
        database__client: "mysql",
        database__connection__host: COMPANION_DB_HOST,
        database__connection__port: "3306",
        database__connection__user: name,
        database__connection__password: need(ctx.secrets.dbPassword, "database password"),
        database__connection__database: name,
      };
    case "nextcloud":
      return {
        POSTGRES_HOST: COMPANION_DB_HOST,
        POSTGRES_DB: name,
        POSTGRES_USER: name,
        POSTGRES_PASSWORD: need(ctx.secrets.dbPassword, "database password"),
        NEXTCLOUD_TRUSTED_DOMAINS: ctx.domain,
        // Requests arrive from nginx on the host through the bridge's
        // gateway; these are the ranges Docker allocates bridges from.
        TRUSTED_PROXIES: "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16",
        OVERWRITEHOST: ctx.domain,
        OVERWRITEPROTOCOL: ctx.ssl ? "https" : "http",
        OVERWRITECLIURL: url,
      };
    case "uptime-kuma":
      // SQLite in /app/data; nothing to tell it.
      return {};
    case "n8n":
      return {
        DB_TYPE: "postgresdb",
        DB_POSTGRESDB_HOST: COMPANION_DB_HOST,
        DB_POSTGRESDB_PORT: "5432",
        DB_POSTGRESDB_DATABASE: name,
        DB_POSTGRESDB_USER: name,
        DB_POSTGRESDB_PASSWORD: need(ctx.secrets.dbPassword, "database password"),
        N8N_HOST: ctx.domain,
        N8N_PORT: "5678",
        N8N_PROTOCOL: ctx.ssl ? "https" : "http",
        N8N_EDITOR_BASE_URL: `${url}/`,
        WEBHOOK_URL: `${url}/`,
        N8N_ENCRYPTION_KEY: need(ctx.secrets.encryptionKey, "encryption key"),
        N8N_PROXY_HOPS: "1",
        N8N_SECURE_COOKIE: ctx.ssl ? "true" : "false",
      };
    case "gitea":
      return {
        USER_UID: "1000",
        USER_GID: "1000",
        GITEA__database__DB_TYPE: "postgres",
        GITEA__database__HOST: `${COMPANION_DB_HOST}:5432`,
        GITEA__database__NAME: name,
        GITEA__database__USER: name,
        GITEA__database__PASSWD: need(ctx.secrets.dbPassword, "database password"),
        GITEA__server__DOMAIN: ctx.domain,
        GITEA__server__ROOT_URL: `${url}/`,
        GITEA__server__HTTP_PORT: "3000",
        // HTTPS clone only: Gitea's SSH is switched off, and port 22 of
        // the container is never published anyway.
        GITEA__server__DISABLE_SSH: "true",
        GITEA__server__START_SSH_SERVER: "false",
      };
    case "none":
    case "wordpress":
      throw new Error(`${recipe.name} is not an image recipe`);
  }
}

/** The companion database's environment. */
export function databaseEnvironment(recipe: AppRecipe, ctx: ContainerContext): Record<string, string> {
  if (recipe.source.kind !== "image" || !recipe.source.database) return {};
  const name = companionDbName(recipe);
  const password = need(ctx.secrets.dbPassword, "database password");
  if (recipe.source.database.engine === "mysql") {
    return {
      MYSQL_ROOT_PASSWORD: need(ctx.secrets.dbRootPassword, "database root password"),
      MYSQL_DATABASE: name,
      MYSQL_USER: name,
      MYSQL_PASSWORD: password,
    };
  }
  return { POSTGRES_DB: name, POSTGRES_USER: name, POSTGRES_PASSWORD: password };
}

/**
 * The `container.create` specs an image install sends, companion
 * database first. Pure: the tests read exactly what the agent is sent.
 */
export function containerSpecs(recipe: AppRecipe, ctx: ContainerContext): ManagedContainerSpec[] {
  const source = recipe.source;
  if (source.kind !== "image") return [];
  const dataDir = `${MANAGED_APPS_ROOT}/${ctx.installId}`;
  const specs: ManagedContainerSpec[] = [];
  if (source.database) {
    specs.push({
      install_id: ctx.installId,
      role: "db",
      image: source.database.image,
      env: databaseEnvironment(recipe, ctx),
      mounts: [{ source: `${dataDir}/db`, target: source.database.data_path, read_only: false }],
      // Never published: only the app, on the private network, reaches it.
      ports: [],
      replace: true,
    });
  }
  specs.push({
    install_id: ctx.installId,
    role: "app",
    image: source.image,
    env: appEnvironment(recipe, ctx),
    mounts: [
      {
        source: `${dataDir}/data`,
        target: source.data_path,
        read_only: false,
        ...(source.data_uid ? { uid: source.data_uid, gid: source.data_uid } : {}),
      },
    ],
    ports: [{ container_port: source.port, host_port: ctx.appPort }],
    replace: true,
  });
  return specs;
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
