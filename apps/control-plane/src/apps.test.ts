import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import {
  appInstalls,
  certificates,
  dbDatabases,
  dbInstances,
  dbUsers,
  domains,
  secrets,
  sites,
} from "@kaname/db/schema";
import {
  APP_CATALOG,
  FEATURED_SERVER_APPS,
  appInstallSteps,
  appRecipe,
  featuredServerApp,
  findApp,
  installAppInput,
  permission,
  type JobType,
} from "@kaname/contract";
import { MANAGED_APPS_ROOT, managedContainerSpec } from "@kaname/contract/agent";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { CONTAINER_TIMING, appJobHandlers } from "./jobs/apps.js";
import type { JobContext } from "./jobs/worker.js";
import {
  APP_PORT_RANGE,
  NO_SECRETS,
  allocatePort,
  containerSecretNames,
  containerSecretRef,
  containerSpecs,
  generateSecret,
  initTaskSpecs,
  buildPlan,
  chooseEngine,
  dbHostFor,
  installNames,
  phpString,
  renderConfig,
  writablePaths,
} from "./services/app-installer.js";

/* ------------------------------------------------------------------ *
 * The app installer: what it accepts, what it plans, and what it
 * leaves behind when a step fails. The agent is a stub that answers by
 * method, so every assertion about the host is an assertion about the
 * typed calls the job made — which is the whole of what it can do.
 * ------------------------------------------------------------------ */

const wordpress = findApp("wordpress")!;
const ghost = findApp("ghost")!;
const dokuwiki = findApp("dokuwiki")!;
const SERVER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "abcdef12-3456-4789-8abc-def012345678";

const baseInput = {
  app_id: "wordpress",
  server_id: SERVER,
  domain: "Blog.Example.com",
  admin_email: "ops@example.com",
};

describe("install input", () => {
  it("applies defaults and lowercases the domain", () => {
    const parsed = installAppInput.parse(baseInput);
    expect(parsed.domain).toBe("blog.example.com");
    expect(parsed.ssl).toBe(true);
    expect(parsed.system_user).toBe("www-data");
  });

  it.each([
    ["a domain with a path", { domain: "example.com/blog" }],
    ["a domain with a shell metacharacter", { domain: "example.com;reboot" }],
    ["a bare hostname", { domain: "localhost" }],
    ["a malformed email", { admin_email: "ops@" }],
    ["a system user that is not an identifier", { system_user: "www data; id" }],
    ["a PHP version that is not a version", { php_version: "latest" }],
    ["an engine that does not exist", { db_engine: "sqlite" }],
    ["a server id that is not a uuid", { server_id: "web-01" }],
  ])("refuses %s", (_label, patch) => {
    expect(installAppInput.safeParse({ ...baseInput, ...patch }).success).toBe(false);
  });
});

describe("catalog", () => {
  it("holds only well-formed recipes with unique ids, WordPress among them", () => {
    for (const recipe of APP_CATALOG) expect(() => appRecipe.parse(recipe)).not.toThrow();
    expect(new Set(APP_CATALOG.map((r) => r.id)).size).toBe(APP_CATALOG.length);
    expect(wordpress.availability).toBe("available");
  });

  it("offers only what existing agent verbs can provision, and says why not otherwise", () => {
    for (const recipe of APP_CATALOG) {
      if (recipe.availability !== "available") {
        expect(recipe.unavailable_reason).toBeTruthy();
        continue;
      }
      if (recipe.source.kind === "image") {
        // The managed-container verbs need the container capability and a
        // proxied site; the database is a companion, never the host's.
        expect(recipe.requirements.capabilities).toEqual(expect.arrayContaining(["docker", "nginx"]));
        expect(recipe.requirements.runtime).toBe("container");
        expect(recipe.requirements.database).toBeNull();
        expect(recipe.source.image).toMatch(/:[A-Za-z0-9._-]+$/);
      } else {
        expect(recipe.requirements.capabilities).not.toContain("docker");
      }
    }
  });

  it("makes every container app installable, Plausible included", () => {
    for (const id of ["ghost", "nextcloud", "uptime-kuma", "n8n", "gitea", "plausible"]) {
      expect(findApp(id)?.availability, id).toBe("available");
    }
    expect(findApp("plausible")!.category).toBe("analytics");
    expect(findApp("plausible")!.requirements.min_memory_mb).toBeGreaterThanOrEqual(2048);
  });

  it("keeps featured server apps out of the install path: they hand off to their own module", () => {
    expect(FEATURED_SERVER_APPS.map((a) => a.id)).toContain("yunori-mail");
    for (const app of FEATURED_SERVER_APPS) {
      expect(() => featuredServerApp.parse(app)).not.toThrow();
      expect(permission.safeParse(app.permission).success).toBe(true);
      // Not a recipe: the catalog API never serves it, and POST /apps/installs
      // resolves app_id through findApp, so it answers 404 for this id.
      expect(APP_CATALOG.some((recipe) => recipe.id === app.id)).toBe(false);
      expect(findApp(app.id)).toBeUndefined();
    }
  });
});

describe("plan", () => {
  it("derives every name from the domain and the install id, the same way twice", () => {
    const names = installNames(wordpress, { domain: "blog.example.com", ssl: true }, INSTALL);
    expect(names).toEqual(installNames(wordpress, { domain: "blog.example.com", ssl: true }, INSTALL));
    expect(names).toMatchObject({
      siteName: "blog.example.com",
      deployRoot: "/var/www/blog.example.com",
      webroot: "/var/www/blog.example.com/current",
      release: "wordpress-6.8-abcdef12",
      database: "wp_blog_example_com_abcd",
      dbUser: "wp_abcdef12",
      url: "https://blog.example.com",
    });
    // Identifiers the agent's own validation will accept.
    expect(names.database).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/);
    expect(names.dbUser!.length).toBeLessThanOrEqual(32);
  });

  it("lists the steps an app needs, in order, and no others", () => {
    expect(appInstallSteps(wordpress, { ssl: true }).map((s) => s.id)).toEqual([
      "database",
      "files",
      "configure",
      "site",
      "certificate",
      "verify",
    ]);
    expect(appInstallSteps(dokuwiki, { ssl: false }).map((s) => s.id)).toEqual([
      "files",
      "configure",
      "site",
      "verify",
    ]);
  });

  it("describes what would be created", () => {
    const input = installAppInput.parse({ ...baseInput, ssl: false });
    const plan = buildPlan(wordpress, input, {
      installId: INSTALL,
      serverName: "web-01",
      engine: "mariadb",
    });
    expect(plan).toMatchObject({
      plan_id: INSTALL,
      url: "http://blog.example.com",
      db_engine: "mariadb",
      database: "wp_blog_example_com_abcd",
    });
    expect(plan.steps).toHaveLength(5);
  });

  it("picks an engine the recipe accepts and the server runs", () => {
    expect(chooseEngine(wordpress, undefined, ["postgres", "mysql"]).engine).toBe("mysql");
    expect(chooseEngine(wordpress, "mariadb", ["mariadb"]).engine).toBe("mariadb");
    expect(chooseEngine(wordpress, "postgres", ["postgres"]).problem).toMatch(/does not run on/);
    expect(chooseEngine(wordpress, "mysql", ["mariadb"]).problem).toMatch(/does not run mysql/);
    expect(chooseEngine(wordpress, undefined, ["postgres"]).problem).toMatch(/needs/);
    expect(chooseEngine(dokuwiki, undefined, [])).toEqual({ engine: null, problem: null });
  });

  it("escapes configuration values for PHP and refuses a line break", () => {
    expect(phpString("it's a \\ test")).toBe("'it\\'s a \\\\ test'");
    expect(() => phpString("a\nb")).toThrow();
    expect(dbHostFor("127.0.0.1", 3306, "mariadb")).toBe("localhost");
    expect(dbHostFor("10.0.0.5", 3307, "mysql")).toBe("10.0.0.5:3307");
  });

  it("renders wp-config.php with the credentials and eight distinct salts", () => {
    let n = 0;
    const [file] = renderConfig(
      wordpress,
      {
        database: "wp_x",
        dbUser: "wp_u",
        dbPassword: "pa'ss",
        dbHost: "127.0.0.1",
        dbPort: 3306,
        engine: "mariadb",
      },
      () => `salt-${(n += 1)}`,
    );
    expect(file!.path).toBe("wp-config.php");
    expect(file!.mode).toBe("0640");
    expect(file!.content).toContain("define( 'DB_PASSWORD', 'pa\\'ss' );");
    expect(file!.content).toContain("define( 'DB_HOST', 'localhost' );");
    expect(file!.content.match(/salt-\d/g)).toHaveLength(8);
    expect(renderConfig(dokuwiki, null)).toEqual([]);
    expect(writablePaths(dokuwiki, "/var/www/w/releases/r/")).toContain("/var/www/w/releases/r/data");
    expect(writablePaths(wordpress, "/var/www/w/releases/r")).toEqual(["/var/www/w/releases/r"]);
  });
});

/* ------------------------------------------------------------------ *
 * Image recipes: the plan, the specs the agent is sent, the ports
 * ------------------------------------------------------------------ */

const secretsFor = (recipeId: string) => {
  const out = { ...NO_SECRETS };
  for (const name of containerSecretNames(findApp(recipeId)!)) out[name] = `${name}-value`;
  return out;
};

const containerCtx = (recipeId: string, ssl = true) => ({
  installId: INSTALL,
  domain: "app.example.com",
  ssl,
  appPort: 20007,
  secrets: secretsFor(recipeId),
});

describe("image recipe plans", () => {
  const IMAGE_APPS = ["ghost", "nextcloud", "uptime-kuma", "n8n", "gitea", "plausible"] as const;

  it.each(IMAGE_APPS)("%s: every spec passes the agent's own schema and its guards' shape", (id) => {
    const recipe = findApp(id)!;
    const specs = [...containerSpecs(recipe, containerCtx(id)), ...initTaskSpecs(recipe, containerCtx(id))];
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(() => managedContainerSpec.parse(spec)).not.toThrow();
      expect(spec.install_id).toBe(INSTALL);
      for (const mount of spec.mounts) expect(mount.source.startsWith(`${MANAGED_APPS_ROOT}/${INSTALL}/`)).toBe(true);
      for (const file of spec.files) expect(file.path).not.toMatch(/^\/|\.\./);
      // Nothing but the app is published, and only on its allocated port.
      if (spec.role === "app") {
        expect(spec.ports).toEqual([{ container_port: (recipe.source as { port: number }).port, host_port: 20007 }]);
      } else {
        expect(spec.ports).toEqual([]);
      }
    }
    const app = specs.find((s) => s.role === "app")!;
    expect(app.image).toBe((recipe.source as { image: string }).image);
    // Companions come first, in the recipe's order; the app last.
    const companions = (recipe.source as { companions: { role: string }[] }).companions;
    expect(containerSpecs(recipe, containerCtx(id)).map((s) => s.role)).toEqual([
      ...companions.map((c) => c.role),
      "app",
    ]);
  });

  it.each(IMAGE_APPS)("%s: the plan lists pull, network, containers, site, certificate and verify", (id) => {
    const recipe = findApp(id)!;
    const steps = appInstallSteps(recipe, { ssl: true }).map((s) => s.id);
    const source = recipe.source as { companions: unknown[]; init: unknown[] };
    expect(steps).toEqual([
      "pull",
      "network",
      ...(source.companions.length ? ["db_container"] : []),
      ...(source.init.length ? ["init"] : []),
      "app_container",
      "site",
      "certificate",
      "verify",
    ]);
    const plan = buildPlan(recipe, installAppInput.parse({ ...baseInput, app_id: id }), {
      installId: INSTALL,
      serverName: "web-01",
      engine: null,
      appPort: 20007,
    });
    expect(plan.app_port).toBe(20007);
    expect(plan.containers.at(-1)).toEqual({ role: "app", image: (recipe.source as { image: string }).image });
    expect(plan.webroot).toBe("/var/www/blog.example.com");
  });

  it("Ghost: url on the domain, MySQL 8 beside it with generated passwords", () => {
    const [db, app] = containerSpecs(ghost, containerCtx("ghost"));
    expect(db).toMatchObject({ role: "db", image: "mysql:8.0" });
    expect(db!.env).toMatchObject({
      MYSQL_DATABASE: "ghost",
      MYSQL_USER: "ghost",
      MYSQL_PASSWORD: "dbPassword-value",
      MYSQL_ROOT_PASSWORD: "dbRootPassword-value",
    });
    expect(app!.env).toMatchObject({
      url: "https://app.example.com",
      database__client: "mysql",
      database__connection__host: "db",
      database__connection__password: "dbPassword-value",
    });
    expect(containerSpecs(ghost, containerCtx("ghost", false))[1]!.env.url).toBe("http://app.example.com");
  });

  it("Nextcloud: trusted domain, https overwrite protocol, PostgreSQL", () => {
    const [db, app] = containerSpecs(findApp("nextcloud")!, containerCtx("nextcloud"));
    expect(db).toMatchObject({ role: "db", image: "postgres:16-alpine" });
    expect(app!.env).toMatchObject({
      POSTGRES_HOST: "db",
      NEXTCLOUD_TRUSTED_DOMAINS: "app.example.com",
      OVERWRITEPROTOCOL: "https",
      OVERWRITEHOST: "app.example.com",
    });
    expect(app!.mounts[0]!.target).toBe("/var/www/html");
  });

  it("Uptime Kuma: no database, SQLite in its data directory", () => {
    const specs = containerSpecs(findApp("uptime-kuma")!, containerCtx("uptime-kuma"));
    expect(specs.map((s) => s.role)).toEqual(["app"]);
    expect(specs[0]!.mounts[0]!.target).toBe("/app/data");
    expect(containerSecretNames(findApp("uptime-kuma")!)).toEqual([]);
  });

  it("n8n: host, https protocol, webhook URL and a sealed encryption key", () => {
    const [, app] = containerSpecs(findApp("n8n")!, containerCtx("n8n"));
    expect(app!.env).toMatchObject({
      N8N_HOST: "app.example.com",
      N8N_PROTOCOL: "https",
      WEBHOOK_URL: "https://app.example.com/",
      N8N_ENCRYPTION_KEY: "encryptionKey-value",
      DB_TYPE: "postgresdb",
      DB_POSTGRESDB_HOST: "db",
    });
    // The image runs as `node` (uid 1000) and does not take its directory over.
    expect(app!.mounts[0]).toMatchObject({ uid: 1000, gid: 1000, target: "/home/node/.n8n" });
    expect(containerSecretNames(findApp("n8n")!)).toContain("encryptionKey");
  });

  it("Gitea: ROOT_URL and DOMAIN on the domain, SSH off and never published", () => {
    const [, app] = containerSpecs(findApp("gitea")!, containerCtx("gitea"));
    expect(app!.env).toMatchObject({
      GITEA__server__DOMAIN: "app.example.com",
      GITEA__server__ROOT_URL: "https://app.example.com/",
      GITEA__server__DISABLE_SSH: "true",
      GITEA__server__START_SSH_SERVER: "false",
      GITEA__database__HOST: "db:5432",
    });
    expect(app!.ports.map((p) => p.container_port)).toEqual([3000]);
  });

  it("Plausible: PostgreSQL and ClickHouse companions, generated keys, migrations before start", () => {
    const plausible = findApp("plausible")!;
    const [db, events, app] = containerSpecs(plausible, containerCtx("plausible"));
    expect(db).toMatchObject({ role: "db", image: "postgres:16-alpine" });
    expect(events).toMatchObject({
      role: "events",
      image: "clickhouse/clickhouse-server:24.12-alpine",
      nofile: 262_144,
      env: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
    });
    expect(events!.files.map((f) => f.target)).toEqual([
      "/etc/clickhouse-server/config.d/logs.xml",
      "/etc/clickhouse-server/config.d/ipv4-only.xml",
      "/etc/clickhouse-server/config.d/low-resources.xml",
      "/etc/clickhouse-server/users.d/default-profile-low-resources-overrides.xml",
    ]);
    expect(events!.files.every((f) => f.path.startsWith("events/config/"))).toBe(true);
    expect(app).toMatchObject({ image: "ghcr.io/plausible/community-edition:v3.2.1", nofile: 65_535 });
    expect(app!.env).toMatchObject({
      BASE_URL: "https://app.example.com",
      SECRET_KEY_BASE: "secretKeyBase-value",
      TOTP_VAULT_KEY: "totpVaultKey-value",
      DATABASE_URL: "postgres://plausible:dbPassword-value@db:5432/plausible",
      CLICKHOUSE_DATABASE_URL: "http://events:8123/plausible_events",
      DISABLE_REGISTRATION: "invite_only",
    });
    expect(app!.mounts[0]).toMatchObject({ uid: 999, target: "/var/lib/plausible" });
    expect(initTaskSpecs(plausible, containerCtx("plausible")).map((t) => [t.role, t.args])).toEqual([
      ["init1", ["db", "createdb"]],
      ["init2", ["db", "migrate"]],
    ]);
    expect(Buffer.from(generateSecret("secretKeyBase"), "base64")).toHaveLength(64);
    expect(Buffer.from(generateSecret("totpVaultKey"), "base64")).toHaveLength(32);
    expect(plausible.finish).toMatch(/first account becomes the owner/);
  });

  it("allocates the lowest loopback port nobody holds, and says when none is left", () => {
    expect(allocatePort([])).toBe(APP_PORT_RANGE.min);
    expect(allocatePort([20000, 20001, null, 20003])).toBe(20002);
    expect(allocatePort([5, 6], { min: 5, max: 7 })).toBe(7);
    expect(allocatePort([5, 6, 7], { min: 5, max: 7 })).toBeNull();
    expect(APP_PORT_RANGE.max).toBeLessThan(32768);
  });
});

/* ------------------------------------------------------------------ *
 * The job
 * ------------------------------------------------------------------ */

class FakeHub {
  readonly connected = new Set<string>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Per-method override; return a value or throw. */
  answers = new Map<string, (params: Record<string, unknown>) => unknown>();

  private defaults: Record<string, (params: Record<string, unknown>) => unknown> = {
    "db.database.create": (p) => ({ name: p.name, size_bytes: 0, table_count: 0 }),
    "db.user.create": (p) => ({ username: p.username }),
    "db.user.update": (p) => ({ username: p.username }),
    "db.grant.apply": () => ({ ok: true }),
    "db.database.delete": () => ({ ok: true }),
    "db.user.delete": () => ({ ok: true }),
    "site.release.create": (p) => ({
      release_path: `${p.root}/releases/${p.release}`,
      current_path: `${p.root}/current`,
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      pruned: [],
      log: ["cloned"],
    }),
    "site.release.activate": (p) => ({
      current_path: `${p.root}/current`,
      release_path: p.release_path,
      previous: null,
    }),
    "fs.write": (p) => ({ path: p.path }),
    "fs.chown": () => ({ ok: true }),
    "fs.stat": (p) => ({ path: p.path }),
    "fs.remove": () => ({ removed: 1 }),
    "site.create": (p) => ({ config_path: `/etc/nginx/sites-available/${p.name}` }),
    "site.update": (p) => ({ config_path: `/etc/nginx/sites-available/${p.name}` }),
    "site.remove": () => ({ ok: true }),
    "site.reload": () => ({ ok: true }),
    "site.test_config": () => ({ valid: true, output: "ok" }),
    "cert.issue": (p) => ({
      subject: (p.domains as string[])[0],
      sans: p.domains,
      not_after: "2027-02-01T00:00:00Z",
      path: "/etc/letsencrypt/live/x",
    }),
    "cert.revoke": () => ({ ok: true }),
    "container.image.pull": (p) => ({ image: p.image, id: `sha256:${"0".repeat(64)}` }),
    "container.network.create": (p) => ({ name: `kaname-${p.install_id}`, id: "net0", created: true }),
    "container.create": (p) => {
      this.running.add(p.role as string);
      return {
        id: `c-${p.role}`,
        name: `kaname-${p.install_id}-${p.role}`,
        state: "running",
        ports: ((p.ports as { container_port: number; host_port: number }[]) ?? []).map((port) => ({
          container_port: port.container_port,
          host_port: port.host_port,
          host_ip: "127.0.0.1",
          protocol: "tcp",
        })),
      };
    },
    "container.task.run": () => ({ exit_code: 0, output: "done" }),
    "container.app.status": () => ({
      containers: [...this.running].map((role) => ({ role, name: role, state: "running", status: "Up" })),
      endpoints: this.running.has("app")
        ? [{ role: "app", host_port: 20000, container_port: 80, reachable: true, http_status: 200 }]
        : [],
    }),
    "container.app.remove": () => {
      const containers = [...this.running];
      this.running.clear();
      return { containers, networks: ["net"], data_removed: true };
    },
  };
  /** Managed containers the fake host is running, by role. */
  running = new Set<string>();

  isConnected(id: string): boolean {
    return this.connected.has(id);
  }
  capabilities(): string[] {
    return ["nginx", "systemd"];
  }
  connectedServerIds(): string[] {
    return [...this.connected];
  }

  private answer(serverId: string, method: string, params: Record<string, unknown>): unknown {
    if (!this.connected.has(serverId)) throw new AgentOfflineError(serverId);
    this.calls.push({ method, params });
    const fn = this.answers.get(method) ?? this.defaults[method];
    if (!fn) throw new AgentRpcError({ code: "unsupported", message: `no ${method}` });
    return fn(params);
  }

  async call(serverId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.answer(serverId, method, params);
  }

  stream(serverId: string, method: string, params: Record<string, unknown>) {
    const done = (async () => this.answer(serverId, method, params))();
    done.catch(() => undefined);
    return { id: "stream", done, cancel: () => undefined };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  as(): AgentHub {
    return this as unknown as AgentHub;
  }
}

const fail = (code: string, text: string) => () => {
  throw new AgentRpcError({ code: code as never, message: text });
};

let handle: DbHandle;
let ctx: AppContext;
let hub: FakeHub;
let serverId: string;
const handlers = appJobHandlers();
let counter = 0;

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-integration-test-password",
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await seedDemo(handle.db);
  const [instance] = await handle.db
    .select({ serverId: dbInstances.serverId })
    .from(dbInstances)
    .where(eq(dbInstances.engine, "mariadb"))
    .limit(1);
  serverId = instance!.serverId;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

beforeEach(() => {
  hub = new FakeHub();
  hub.connected.add(serverId);
});

let nextPort = 21000;

async function newInstall(appId = "wordpress", ssl = true) {
  counter += 1;
  const recipe = findApp(appId)!;
  const domain = `app${counter}.example.test`;
  const [row] = await handle.db
    .insert(appInstalls)
    .values({
      appPort: recipe.source.kind === "image" ? (nextPort += 1) : null,
      appId,
      appName: recipe.name,
      appVersion: recipe.version,
      serverId,
      domain,
      ssl,
      dbEngine: recipe.requirements.database ? "mariadb" : null,
      inputs: { admin_email: "ops@example.test", system_user: "www-data", php_version: null },
      steps: appInstallSteps(recipe, { ssl }).map((s) => ({
        id: s.id,
        status: "pending" as const,
        message: null,
        started_at: null,
        finished_at: null,
      })),
    })
    .returning();
  return row!;
}

async function run(type: JobType, installId: string) {
  const queued = await ctx.queue.enqueue({ type, serverId, params: { install_id: installId } });
  const claimed = await ctx.queue.claim("test-worker", 60, [serverId]);
  if (!claimed || claimed.id !== queued.id) throw new Error("claimed the wrong job");
  const logs: string[] = [];
  const jobCtx: JobContext = {
    ...ctx,
    hub: hub.as(),
    job: claimed,
    signal: new AbortController().signal,
    log_: async (level, message) => {
      logs.push(`${level}: ${message}`);
    },
    progress: async () => undefined,
  };
  let error: unknown = null;
  let result: unknown = null;
  try {
    result = await handlers[type]!(jobCtx);
  } catch (err) {
    error = err;
  }
  await ctx.queue.complete(claimed.id, null);
  return { result, error, logs };
}

async function installRow(id: string) {
  const rows = await handle.db.select().from(appInstalls).where(eq(appInstalls.id, id));
  return rows[0];
}

async function count(table: typeof sites | typeof dbDatabases | typeof dbUsers, id: string | null) {
  if (!id) return 0;
  return (await handle.db.select({ id: table.id }).from(table).where(eq(table.id, id))).length;
}

describe("app.install", () => {
  it("provisions database, files, config, vhost and certificate in order, with typed calls only", async () => {
    const install = await newInstall();
    const { error, logs } = await run("app.install", install.id);
    expect(error).toBeNull();

    expect(hub.methods()).toEqual([
      "db.user.create",
      "db.database.create",
      "db.grant.apply",
      "site.release.create",
      "fs.write",
      "fs.chown",
      "site.create",
      "site.reload",
      "cert.issue",
      "site.update",
      "site.reload",
      "site.test_config",
      "fs.stat",
    ]);

    const row = (await installRow(install.id))!;
    expect(row.status).toBe("active");
    expect(row.steps.map((s) => s.status)).toEqual(Array(6).fill("done"));
    expect(row.siteId && row.databaseId && row.dbUserId && row.certificateId && row.domainId).toBeTruthy();

    const [site] = await handle.db.select().from(sites).where(eq(sites.id, row.siteId!));
    expect(site).toMatchObject({ status: "active", runtime: "php", name: install.domain });
    const [cert] = await handle.db.select().from(certificates).where(eq(certificates.id, row.certificateId!));
    expect(cert!.status).toBe("active");

    // The password is sealed in `secrets`, reaches the host only inside
    // the two calls that need it, and is in no log line.
    const [secret] = await handle.db.select().from(secrets).where(eq(secrets.ref, `db_user:${row.dbUserId}`));
    expect(secret).toBeTruthy();
    const password = hub.calls.find((c) => c.method === "db.user.create")!.params.password as string;
    expect(password).toHaveLength(32);
    expect(JSON.stringify(row)).not.toContain(password);
    expect(logs.join("\n")).not.toContain(password);
    const write = hub.calls.find((c) => c.method === "fs.write")!.params;
    expect(write.path).toBe(`/var/www/${install.domain}/releases/${row.resources.release}/wp-config.php`);
    expect(write.content).toContain(password);
  });

  it("skips the database for an app that has none", async () => {
    const install = await newInstall("dokuwiki", false);
    const { error } = await run("app.install", install.id);
    expect(error).toBeNull();
    expect(hub.methods()).toEqual([
      "site.release.create",
      "fs.chown",
      "site.create",
      "site.reload",
      "site.test_config",
      "fs.stat",
    ]);
    expect((await installRow(install.id))!.databaseId).toBeNull();
  });

  it("rolls back everything it created, newest first, when a step fails", async () => {
    const install = await newInstall();
    hub.answers.set("site.create", fail("exec_failed", "nginx refused the vhost"));
    const { error } = await run("app.install", install.id);
    expect(error).toBeInstanceOf(AgentRpcError);

    const cleanup = hub.methods().slice(hub.methods().indexOf("site.create") + 1);
    expect(cleanup).toEqual(["site.remove", "fs.remove", "db.database.delete", "db.user.delete"]);
    expect(hub.calls.find((c) => c.method === "fs.remove")!.params).toEqual({
      paths: [`/var/www/${install.domain}`],
      recursive: true,
    });

    const row = (await installRow(install.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatchObject({ code: "exec_failed", message: "nginx refused the vhost" });
    expect(row.steps.map((s) => s.status)).toEqual([
      "rolled_back",
      "rolled_back",
      "rolled_back",
      "failed",
      "pending",
      "pending",
    ]);
    expect([row.siteId, row.databaseId, row.dbUserId, row.domainId, row.certificateId]).toEqual(
      Array(5).fill(null),
    );
    const names = await handle.db.select().from(domains).where(eq(domains.name, install.domain));
    expect(names).toHaveLength(0);
    const left = await handle.db.select().from(dbDatabases).where(eq(dbDatabases.name, row.resources.database!));
    expect(left).toHaveLength(0);
  });

  it("never drops a database that was on the host before the install asked for it", async () => {
    const install = await newInstall();
    hub.answers.set("db.database.create", fail("conflict", "database already exists"));
    const { error } = await run("app.install", install.id);
    expect(error).toBeInstanceOf(AgentRpcError);
    expect(hub.methods()).not.toContain("db.database.delete");
    // The user was this install's, so that one is removed.
    expect(hub.methods()).toContain("db.user.delete");
    expect((await installRow(install.id))!.status).toBe("failed");
  });

  it("waits for an agent that drops, then resumes without repeating finished steps", async () => {
    const install = await newInstall();
    hub.answers.set("site.release.create", () => {
      throw new AgentOfflineError(serverId);
    });
    const first = await run("app.install", install.id);
    expect(first.error).toBeInstanceOf(AgentOfflineError);
    let row = (await installRow(install.id))!;
    expect(row.status).toBe("installing");
    expect(row.steps.map((s) => s.status).slice(0, 2)).toEqual(["done", "running"]);
    expect(hub.methods()).not.toContain("db.database.delete");

    // The clone did finish on the host; the answer was simply never heard.
    hub.calls = [];
    hub.answers.set("site.release.create", fail("conflict", "release already exists"));
    const second = await run("app.install", install.id);
    expect(second.error).toBeNull();
    expect(hub.methods()).not.toContain("db.database.create");
    expect(hub.methods().slice(0, 2)).toEqual(["site.release.create", "site.release.activate"]);
    row = (await installRow(install.id))!;
    expect(row.status).toBe("active");
  });

  it("keeps the app when only the certificate could not be issued", async () => {
    const install = await newInstall();
    hub.answers.set("cert.issue", fail("exec_failed", "DNS problem: NXDOMAIN."));
    const { error } = await run("app.install", install.id);
    expect(error).toBeNull();
    const row = (await installRow(install.id))!;
    expect(row.status).toBe("active");
    const step = row.steps.find((s) => s.id === "certificate")!;
    expect(step.status).toBe("warn");
    expect(step.message).toMatch(/NXDOMAIN/);
    const [cert] = await handle.db.select().from(certificates).where(eq(certificates.id, row.certificateId!));
    expect(cert!.status).toBe("failed");
    expect(hub.methods()).not.toContain("site.remove");
  });
});

describe("app.uninstall", () => {
  it("removes what the install created and then the record itself", async () => {
    const install = await newInstall();
    await run("app.install", install.id);
    const before = (await installRow(install.id))!;
    hub.calls = [];

    const { error } = await run("app.uninstall", install.id);
    expect(error).toBeNull();
    expect(hub.methods()).toEqual([
      "cert.revoke",
      "site.remove",
      "fs.remove",
      "db.database.delete",
      "db.user.delete",
    ]);
    expect(await installRow(install.id)).toBeUndefined();
    expect(await count(sites, before.siteId)).toBe(0);
    expect(await count(dbDatabases, before.databaseId)).toBe(0);
    expect(await count(dbUsers, before.dbUserId)).toBe(0);
  });

  it("keeps the record, and says what is left, when the host refuses a removal", async () => {
    const install = await newInstall();
    await run("app.install", install.id);
    hub.answers.set("db.database.delete", fail("exec_failed", "database is in use"));
    const { error } = await run("app.uninstall", install.id);
    expect(error).toBeInstanceOf(Error);
    const row = (await installRow(install.id))!;
    expect(row.status).toBe("failed");
    expect(row.error!.message).toMatch(/database is in use/);
    expect(row.databaseId).not.toBeNull();
    expect(row.siteId).toBeNull();
  });
});

describe("app.install from an image", () => {
  beforeAll(() => {
    CONTAINER_TIMING.initAttempts = 2;
    CONTAINER_TIMING.initRetryMs = 0;
    CONTAINER_TIMING.verifyAttempts = 2;
    CONTAINER_TIMING.verifyIntervalMs = 0;
  });

  const calls = (method: string) => hub.calls.filter((c) => c.method === method).map((c) => c.params);

  it("Ghost: pulls, networks, starts MySQL then Ghost, proxies the site to the loopback port", async () => {
    const install = await newInstall("ghost");
    const { error, logs } = await run("app.install", install.id);
    expect(error).toBeNull();
    expect(hub.methods()).toEqual([
      "container.image.pull",
      "container.image.pull",
      "container.network.create",
      "container.create",
      "container.create",
      "site.create",
      "site.reload",
      "cert.issue",
      "site.update",
      "site.reload",
      "site.test_config",
      "container.app.status",
    ]);
    expect(calls("container.image.pull").map((p) => p.image)).toEqual(["mysql:8.0", "ghost:5"]);
    const [db, app] = calls("container.create");
    expect(db).toMatchObject({ role: "db", ports: [], install_id: install.id });
    expect(app).toMatchObject({
      role: "app",
      ports: [{ container_port: 2368, host_port: install.appPort }],
    });
    expect((app!.env as Record<string, string>).url).toBe(`https://${install.domain}`);
    expect(calls("site.create")[0]).toMatchObject({
      runtime: "container",
      upstream: `127.0.0.1:${install.appPort}`,
      webroot: `/var/www/${install.domain}`,
    });

    const row = (await installRow(install.id))!;
    expect(row.status).toBe("active");
    expect(row.steps.every((s) => s.status === "done")).toBe(true);
    expect(row.databaseId).toBeNull();
    const [site] = await handle.db.select().from(sites).where(eq(sites.id, row.siteId!));
    expect(site).toMatchObject({ runtime: "container", status: "active" });

    // Passwords are sealed per install, reach the host only inside the
    // create specs, and are never logged or kept on the row.
    const password = (db!.env as Record<string, string>).MYSQL_PASSWORD!;
    const [sealed] = await handle.db
      .select()
      .from(secrets)
      .where(eq(secrets.ref, containerSecretRef(install.id, "dbPassword")));
    expect(sealed).toMatchObject({ ownerType: "app_install", ownerId: install.id });
    expect(logs.join("\n")).not.toContain(password);
    expect(JSON.stringify(row)).not.toContain(password);
  });

  it("Plausible: both companions, then its migrations, then the app", async () => {
    const install = await newInstall("plausible");
    const { error } = await run("app.install", install.id);
    expect(error).toBeNull();
    expect(calls("container.create").map((p) => p.role)).toEqual(["db", "events", "app"]);
    expect(calls("container.task.run").map((p) => (p.spec as { args: string[] }).args)).toEqual([
      ["db", "createdb"],
      ["db", "migrate"],
    ]);
    const methods = hub.methods();
    expect(methods.indexOf("container.task.run")).toBeGreaterThan(methods.indexOf("container.create"));
    expect(methods.lastIndexOf("container.task.run")).toBeLessThan(methods.lastIndexOf("container.create"));
    const refs = (await handle.db.select().from(secrets).where(eq(secrets.ownerId, install.id))).map((r) => r.ref);
    expect(refs.sort()).toEqual(
      ["dbPassword", "secretKeyBase", "totpVaultKey"].map((n) => containerSecretRef(install.id, n as never)).sort(),
    );
  });

  it.each(["uptime-kuma", "n8n", "gitea", "nextcloud"])("%s installs on the same machinery", async (id) => {
    const install = await newInstall(id);
    const { error } = await run("app.install", install.id);
    expect(error).toBeNull();
    expect((await installRow(install.id))!.status).toBe("active");
    const roles = calls("container.create").map((p) => p.role);
    expect(roles.at(-1)).toBe("app");
    expect(roles.length).toBe(id === "uptime-kuma" ? 1 : 2);
  });

  it("removes the containers, network, data, vhost and secrets when the site cannot be created", async () => {
    const install = await newInstall("ghost");
    hub.answers.set("site.create", fail("exec_failed", "nginx refused the vhost"));
    const { error } = await run("app.install", install.id);
    expect(error).toBeInstanceOf(AgentRpcError);
    const cleanup = hub.methods().slice(hub.methods().indexOf("site.create") + 1);
    expect(cleanup).toEqual(["site.remove", "fs.remove", "container.app.remove"]);
    expect(calls("container.app.remove")[0]).toEqual({ install_id: install.id, remove_data: true });
    expect(calls("fs.remove")[0]).toEqual({ paths: [`/var/www/${install.domain}`], recursive: true });

    const row = (await installRow(install.id))!;
    expect(row.status).toBe("failed");
    expect(row.steps.map((s) => s.status)).toEqual([
      "rolled_back",
      "rolled_back",
      "rolled_back",
      "rolled_back",
      "failed",
      "pending",
      "pending",
    ]);
    expect(await handle.db.select().from(secrets).where(eq(secrets.ownerId, install.id))).toHaveLength(0);
    expect([row.siteId, row.domainId]).toEqual([null, null]);
    expect(hub.running.size).toBe(0);
  });

  it("gives up on a migration that keeps failing, and cleans up what it started", async () => {
    const install = await newInstall("plausible");
    hub.answers.set("container.task.run", () => ({ exit_code: 1, output: "connection refused" }));
    const { error, logs } = await run("app.install", install.id);
    expect(error).toBeInstanceOf(Error);
    expect(calls("container.task.run")).toHaveLength(CONTAINER_TIMING.initAttempts);
    expect(hub.methods()).not.toContain("site.create");
    expect(hub.methods().at(-1)).toBe("container.app.remove");
    expect(logs.join("\n")).toContain("connection refused");
    const row = (await installRow(install.id))!;
    expect(row.status).toBe("failed");
    expect(row.steps.find((s) => s.id === "init")!.status).toBe("failed");
  });

  it("fails the health check when a container has exited, and rolls back", async () => {
    const install = await newInstall("gitea");
    hub.answers.set("container.app.status", () => ({
      containers: [
        { role: "app", name: "app", state: "exited", status: "Exited (1)" },
        { role: "db", name: "db", state: "running", status: "Up" },
      ],
      endpoints: [],
    }));
    const { error } = await run("app.install", install.id);
    expect(error).toBeInstanceOf(Error);
    expect(hub.methods()).toContain("container.app.remove");
    expect((await installRow(install.id))!.status).toBe("failed");
  });

  it("keeps an app that is running but still starting, with a warning", async () => {
    const install = await newInstall("uptime-kuma");
    hub.answers.set("container.app.status", () => ({
      containers: [{ role: "app", name: "app", state: "running", status: "Up" }],
      endpoints: [{ role: "app", host_port: 1, container_port: 3001, reachable: false, http_status: null }],
    }));
    const { error } = await run("app.install", install.id);
    expect(error).toBeNull();
    const row = (await installRow(install.id))!;
    expect(row.status).toBe("active");
    expect(row.steps.find((s) => s.id === "verify")!.status).toBe("warn");
  });

  it("resumes after the agent drops without pulling or creating twice", async () => {
    const install = await newInstall("ghost");
    hub.answers.set("container.network.create", () => {
      throw new AgentOfflineError(serverId);
    });
    const first = await run("app.install", install.id);
    expect(first.error).toBeInstanceOf(AgentOfflineError);
    hub.calls = [];
    hub.answers.delete("container.network.create");
    const second = await run("app.install", install.id);
    expect(second.error).toBeNull();
    expect(hub.methods()[0]).toBe("container.network.create");
    expect(hub.methods()).not.toContain("container.image.pull");
    // Every create replaces, so a resumed step is the same request again.
    expect(calls("container.create").every((p) => p.replace === true)).toBe(true);
  });

  it("uninstall removes the certificate, vhost, webroot, containers, data and secrets", async () => {
    const install = await newInstall("n8n");
    await run("app.install", install.id);
    const before = (await installRow(install.id))!;
    hub.calls = [];
    const { error } = await run("app.uninstall", install.id);
    expect(error).toBeNull();
    expect(hub.methods()).toEqual(["cert.revoke", "site.remove", "fs.remove", "container.app.remove"]);
    expect(calls("container.app.remove")[0]).toEqual({ install_id: install.id, remove_data: true });
    expect(await installRow(install.id)).toBeUndefined();
    expect(await count(sites, before.siteId)).toBe(0);
    expect(await handle.db.select().from(secrets).where(eq(secrets.ownerId, install.id))).toHaveLength(0);
  });

  it("refuses to give two installs on one server the same loopback port", async () => {
    const a = await newInstall("ghost");
    await expect(
      handle.db.insert(appInstalls).values({
        appId: "ghost",
        appName: "Ghost",
        appVersion: "5",
        serverId,
        domain: "clash.example.test",
        appPort: a.appPort,
        inputs: { admin_email: "ops@example.test", system_user: "www-data", php_version: null },
      }),
    ).rejects.toThrow();
  });
});
