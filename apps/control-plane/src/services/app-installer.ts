import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { MANAGED_APPS_ROOT, type ManagedContainerSpec } from "@kaname/contract/agent";
import {
  appInstallSteps,
  type CompanionEngine,
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
            ...source.companions.map((c) => ({ role: c.role, image: c.image })),
            { role: "app", image: source.image },
          ]
        : [],
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
    default:
      // Image recipes are configured through their container environment.
      return [];
  }
}

/** The absolute paths handed to the web server's account, inside one release. */
export function writablePaths(recipe: AppRecipe, releasePath: string): string[] {
  const root = releasePath.replace(/\/+$/, "");
  return recipe.writable_paths.map((relative) => (relative ? `${root}/${relative}` : root));
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
  /** The companion SQL database's application user. */
  dbPassword: string | null;
  /** MySQL's root account, which the image insists on having. */
  dbRootPassword: string | null;
  /** n8n encrypts stored credentials with it; losing it loses them. */
  encryptionKey: string | null;
  /** Plausible: signs sessions; at least 64 bytes. */
  secretKeyBase: string | null;
  /** Plausible: encrypts TOTP secrets at rest; 32 bytes. */
  totpVaultKey: string | null;
}

export type ContainerSecretName = keyof ContainerSecrets;

export const NO_SECRETS: ContainerSecrets = {
  dbPassword: null,
  dbRootPassword: null,
  encryptionKey: null,
  secretKeyBase: null,
  totpVaultKey: null,
};

/** Which secrets a recipe needs. */
export function containerSecretNames(recipe: AppRecipe): ContainerSecretName[] {
  if (recipe.source.kind !== "image") return [];
  const engines = recipe.source.companions.map((c) => c.engine);
  const names: ContainerSecretName[] = [];
  if (engines.includes("mysql") || engines.includes("postgres")) names.push("dbPassword");
  if (engines.includes("mysql")) names.push("dbRootPassword");
  if (recipe.config === "n8n") names.push("encryptionKey");
  if (recipe.config === "plausible") names.push("secretKeyBase", "totpVaultKey");
  return names;
}

/** A fresh value for one secret, in the shape the app expects. */
export function generateSecret(name: ContainerSecretName): string {
  switch (name) {
    case "secretKeyBase":
      return randomBytes(64).toString("base64");
    case "totpVaultKey":
      return randomBytes(32).toString("base64");
    case "encryptionKey":
      return randomBytes(32).toString("base64url");
    case "dbPassword":
    case "dbRootPassword":
      // URL-safe, because Plausible reads it inside a connection URL.
      return generatePassword();
  }
}

/** Where a sealed install secret lives in `secrets`. */
export function containerSecretRef(installId: string, name: ContainerSecretName): string {
  const suffix: Record<ContainerSecretName, string> = {
    dbPassword: "db_password",
    dbRootPassword: "db_root_password",
    encryptionKey: "encryption_key",
    secretKeyBase: "secret_key_base",
    totpVaultKey: "totp_vault_key",
  };
  return `app_install:${installId}:${suffix[name]}`;
}

/**
 * The database and user name inside a companion container. Fixed per
 * app: the companion holds nothing else, so there is nothing to collide with.
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

/** The private-network host a companion of this engine answers on. */
function companionHost(recipe: AppRecipe, engine: CompanionEngine): string {
  if (recipe.source.kind !== "image") throw new Error(`${recipe.name} is not an image recipe`);
  const companion = recipe.source.companions.find((c) => c.engine === engine);
  if (!companion) throw new Error(`${recipe.name} has no ${engine} companion`);
  return companion.role;
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
        database__connection__host: companionHost(recipe, "mysql"),
        database__connection__port: "3306",
        database__connection__user: name,
        database__connection__password: need(ctx.secrets.dbPassword, "database password"),
        database__connection__database: name,
      };
    case "nextcloud":
      return {
        POSTGRES_HOST: companionHost(recipe, "postgres"),
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
    case "jellyfin":
      // Everything under the one managed mount; the web client stays
      // where the image ships it.
      return {
        JELLYFIN_DATA_DIR: "/jellyfin/data",
        JELLYFIN_CONFIG_DIR: "/jellyfin/config",
        JELLYFIN_CACHE_DIR: "/jellyfin/cache",
        JELLYFIN_LOG_DIR: "/jellyfin/log",
      };
    case "n8n":
      return {
        DB_TYPE: "postgresdb",
        DB_POSTGRESDB_HOST: companionHost(recipe, "postgres"),
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
        GITEA__database__HOST: `${companionHost(recipe, "postgres")}:5432`,
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
    case "plausible": {
      const password = encodeURIComponent(need(ctx.secrets.dbPassword, "database password"));
      return {
        BASE_URL: url,
        SECRET_KEY_BASE: need(ctx.secrets.secretKeyBase, "secret key base"),
        TOTP_VAULT_KEY: need(ctx.secrets.totpVaultKey, "TOTP vault key"),
        DATABASE_URL: `postgres://${name}:${password}@${companionHost(recipe, "postgres")}:5432/${name}`,
        CLICKHOUSE_DATABASE_URL: `http://${companionHost(recipe, "clickhouse")}:8123/${name}_events`,
        HTTP_PORT: "8000",
        TMPDIR: "/var/lib/plausible/tmp",
        // Plausible's default, written down: the first account registers
        // freely and becomes the owner; everyone after needs an invitation.
        DISABLE_REGISTRATION: "invite_only",
      };
    }
    case "none":
    case "wordpress":
      throw new Error(`${recipe.name} is not an image recipe`);
  }
}

/**
 * ClickHouse's small-server settings, verbatim from Plausible's Community
 * Edition setup: quieter logs, IPv4-only listening (Docker bridges have no
 * IPv6 by default) and a smaller memory footprint.
 */
export const CLICKHOUSE_CONFIG_FILES: readonly { name: string; dir: "config.d" | "users.d"; content: string }[] = [
  {
    name: "logs.xml",
    dir: "config.d",
    content: `<clickhouse>
    <logger>
        <level>warning</level>
        <console>true</console>
    </logger>

    <query_log replace="1">
        <database>system</database>
        <table>query_log</table>
        <flush_interval_milliseconds>7500</flush_interval_milliseconds>
        <engine>
            ENGINE = MergeTree
            PARTITION BY event_date
            ORDER BY (event_time)
            TTL event_date + interval 30 day
            SETTINGS ttl_only_drop_parts=1
        </engine>
    </query_log>

    <metric_log remove="remove" />
    <asynchronous_metric_log remove="remove" />
    <query_thread_log remove="remove" />
    <text_log remove="remove" />
    <trace_log remove="remove" />
    <session_log remove="remove" />
    <part_log remove="remove" />
</clickhouse>
`,
  },
  {
    name: "ipv4-only.xml",
    dir: "config.d",
    content: `<clickhouse>
    <listen_host>0.0.0.0</listen_host>
</clickhouse>
`,
  },
  {
    name: "low-resources.xml",
    dir: "config.d",
    content: `<clickhouse>
    <mark_cache_size>524288000</mark_cache_size>
</clickhouse>
`,
  },
  {
    name: "default-profile-low-resources-overrides.xml",
    dir: "users.d",
    content: `<clickhouse>
    <profiles>
        <default>
            <max_threads>1</max_threads>
            <max_block_size>8192</max_block_size>
            <max_download_threads>1</max_download_threads>
            <input_format_parallel_parsing>0</input_format_parallel_parsing>
            <output_format_parallel_formatting>0</output_format_parallel_formatting>
        </default>
    </profiles>
</clickhouse>
`,
  },
];

/** The raised open-files limit ClickHouse needs, and the one Plausible itself runs with. */
export const CLICKHOUSE_NOFILE = 262_144;
export const PLAUSIBLE_NOFILE = 65_535;

/** One companion container's spec. */
function companionSpec(
  recipe: AppRecipe,
  companion: { role: string; engine: CompanionEngine; image: string },
  ctx: ContainerContext,
): ManagedContainerSpec {
  const dir = `${MANAGED_APPS_ROOT}/${ctx.installId}/${companion.role}`;
  const name = companionDbName(recipe);
  const base = {
    install_id: ctx.installId,
    role: companion.role,
    image: companion.image,
    // Never published: only the app, on the private network, reaches it.
    ports: [],
    args: [],
    files: [],
    replace: true,
  };
  switch (companion.engine) {
    case "mysql":
      return {
        ...base,
        env: {
          MYSQL_ROOT_PASSWORD: need(ctx.secrets.dbRootPassword, "database root password"),
          MYSQL_DATABASE: name,
          MYSQL_USER: name,
          MYSQL_PASSWORD: need(ctx.secrets.dbPassword, "database password"),
        },
        mounts: [{ source: `${dir}/data`, target: "/var/lib/mysql", read_only: false }],
      };
    case "postgres":
      return {
        ...base,
        env: {
          POSTGRES_DB: name,
          POSTGRES_USER: name,
          POSTGRES_PASSWORD: need(ctx.secrets.dbPassword, "database password"),
        },
        mounts: [{ source: `${dir}/data`, target: "/var/lib/postgresql/data", read_only: false }],
      };
    case "clickhouse":
      return {
        ...base,
        // No user setup: the default user has no password and is reachable
        // only on the install's private network.
        env: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
        mounts: [
          { source: `${dir}/data`, target: "/var/lib/clickhouse", read_only: false },
          { source: `${dir}/logs`, target: "/var/log/clickhouse-server", read_only: false },
        ],
        files: CLICKHOUSE_CONFIG_FILES.map((file) => ({
          path: `${companion.role}/config/${file.dir}/${file.name}`,
          content: file.content,
          target: `/etc/clickhouse-server/${file.dir}/${file.name}`,
        })),
        nofile: CLICKHOUSE_NOFILE,
      };
  }
}

/** The app container's spec, without its published port when `task` is set. */
function appSpec(recipe: AppRecipe, ctx: ContainerContext, task: { role: string; args: string[] } | null): ManagedContainerSpec {
  const source = recipe.source;
  if (source.kind !== "image") throw new Error(`${recipe.name} is not an image recipe`);
  return {
    install_id: ctx.installId,
    role: task?.role ?? "app",
    image: source.image,
    env: appEnvironment(recipe, ctx),
    mounts: [
      {
        source: `${MANAGED_APPS_ROOT}/${ctx.installId}/data`,
        target: source.data_path,
        read_only: false,
        ...(source.data_uid ? { uid: source.data_uid, gid: source.data_uid } : {}),
      },
    ],
    ports: task ? [] : [{ container_port: source.port, host_port: ctx.appPort }],
    args: task?.args ?? [],
    files: [],
    ...(recipe.config === "plausible" ? { nofile: PLAUSIBLE_NOFILE } : {}),
    replace: true,
  };
}

/**
 * The `container.create` specs an image install sends: companions in the
 * recipe's order, then the app. Pure: the tests read exactly what the
 * agent is sent.
 */
export function containerSpecs(recipe: AppRecipe, ctx: ContainerContext): ManagedContainerSpec[] {
  const source = recipe.source;
  if (source.kind !== "image") return [];
  return [...source.companions.map((c) => companionSpec(recipe, c, ctx)), appSpec(recipe, ctx, null)];
}

/** The one-shot `container.task.run` specs that prepare the database before the app starts. */
export function initTaskSpecs(recipe: AppRecipe, ctx: ContainerContext): ManagedContainerSpec[] {
  const source = recipe.source;
  if (source.kind !== "image") return [];
  return source.init.map((args, index) => appSpec(recipe, ctx, { role: `init${index + 1}`, args }));
}
