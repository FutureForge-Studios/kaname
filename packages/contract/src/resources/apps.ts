import { z } from "zod";
import { domainName, emailAddress, identifier, isoDate, listQuery, slug, uuid } from "../primitives.js";
import { dbEngine, siteRuntime } from "../enums.js";

/* ------------------------------------------------------------------ *
 * App catalog — the one-click installer.
 *
 * A recipe is DATA, not a script. It names what an app needs (a PHP
 * vhost, a database engine, a git source, which config file to render)
 * and the control plane turns that into a fixed sequence of the typed
 * agent verbs that already exist: db.database.create, db.user.create,
 * db.grant.apply, site.release.create, fs.write, fs.chown, site.create,
 * cert.issue. A recipe can never carry a command line, because nothing
 * downstream would know what to do with one (PLAN.md section 0).
 *
 * That is also why some well-known apps are listed as "coming soon":
 * they ship as container images, and the agent has verbs to start, stop
 * and remove a container but none to create one. They become available
 * the day that verb exists, without a change to this shape.
 * ------------------------------------------------------------------ */

export const appCategory = z.enum([
  "cms",
  "wiki",
  "automation",
  "monitoring",
  "storage",
  "developer",
]);
export type AppCategory = z.infer<typeof appCategory>;

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  cms: "Websites",
  wiki: "Knowledge",
  automation: "Automation",
  monitoring: "Monitoring",
  storage: "Files",
  developer: "Developer",
};

export const appAvailability = z.enum(["available", "coming_soon"]);
export type AppAvailability = z.infer<typeof appAvailability>;

/** Which renderer writes the app's configuration. One per app that has a config file. */
export const appConfigTemplate = z.enum(["none", "wordpress"]);
export type AppConfigTemplate = z.infer<typeof appConfigTemplate>;

/** A path inside a release: relative, no traversal, nothing a shell would read. */
const relativePath = z
  .string()
  .max(256)
  .regex(/^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/, "must be a relative path")
  .refine((p) => !p.split("/").includes(".."), { message: "path traversal is not allowed" });

export const appSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    /** Cloned by the agent's `site.release.create`, never by a shell. */
    repo_url: z.string().url().startsWith("https://"),
    branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
    /** Directory inside the checkout the vhost serves; "" for its top. */
    document_root: relativePath,
    /** A file that must exist under the document root once the app is in place. */
    probe: relativePath.refine((p) => p.length > 0, { message: "is required" }),
  }),
  z.object({
    kind: z.literal("image"),
    image: z.string().regex(/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/),
    /** The port the container listens on, which the vhost would proxy to. */
    port: z.number().int().min(1).max(65535),
  }),
]);
export type AppSource = z.infer<typeof appSource>;

export const appRequirements = z.object({
  runtime: siteRuntime,
  /** e.g. "8.3" for PHP. Null when the runtime has no version to pin. */
  runtime_version: z.string().max(32).nullable(),
  /** Agent capabilities the host must report (see hub.capabilities). */
  capabilities: z.array(z.string().max(32)),
  /** Null when the app keeps its data in files. */
  database: z
    .object({
      engines: z.array(dbEngine).min(1),
      /** Leads the generated database and user names, e.g. "wp". */
      prefix: z.string().regex(/^[a-z][a-z0-9]{0,7}$/),
    })
    .nullable(),
  min_memory_mb: z.number().int().positive(),
  min_disk_mb: z.number().int().positive(),
});
export type AppRequirements = z.infer<typeof appRequirements>;

export const appRecipe = z.object({
  id: slug,
  name: z.string().min(1).max(64),
  tagline: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
  category: appCategory,
  /** The upstream release line this recipe installs. */
  version: z.string().min(1).max(32),
  homepage: z.string().url(),
  license: z.string().max(48),
  availability: appAvailability,
  /** Why it cannot be installed yet. Null when it can. */
  unavailable_reason: z.string().max(300).nullable(),
  requirements: appRequirements,
  source: appSource,
  config: appConfigTemplate,
  /** Paths inside the release the app writes to at runtime. "" is the whole tree. */
  writable_paths: z.array(relativePath).max(16),
  /** What is left for a person to do once the job has finished, in one sentence. */
  finish: z.string().min(1).max(300),
});
export type AppRecipe = z.infer<typeof appRecipe>;

const CONTAINER_VERB_MISSING =
  "Ships as a container image. The agent can start, stop and remove containers but has no verb to create one yet, so Kaname cannot provision it without a shell — and it does not use one.";

/**
 * The catalog. Order is the order the gallery shows.
 *
 * To add an app: it must be installable with the verbs in
 * `agent/methods.ts` alone. If it needs a build step, a package
 * manager or a download the agent cannot perform, list it as
 * `coming_soon` and say which capability is missing.
 */
export const APP_CATALOG: readonly AppRecipe[] = [
  {
    id: "wordpress",
    name: "WordPress",
    tagline: "The publishing platform behind a large share of the web.",
    description:
      "A blog, a brochure site or a shop. Kaname creates the database and its own user, checks out the release, writes wp-config.php with fresh keys and salts, and puts the site behind HTTPS.",
    category: "cms",
    version: "6.8",
    homepage: "https://wordpress.org",
    license: "GPL-2.0",
    availability: "available",
    unavailable_reason: null,
    requirements: {
      runtime: "php",
      runtime_version: "8.3",
      capabilities: ["nginx"],
      database: { engines: ["mariadb", "mysql"], prefix: "wp" },
      min_memory_mb: 512,
      min_disk_mb: 1024,
    },
    source: {
      kind: "git",
      repo_url: "https://github.com/WordPress/WordPress.git",
      branch: "6.8-branch",
      document_root: "",
      probe: "wp-login.php",
    },
    config: "wordpress",
    writable_paths: [""],
    finish: "Open the site to choose its title and create the administrator account.",
  },
  {
    id: "dokuwiki",
    name: "DokuWiki",
    tagline: "A wiki that keeps its pages in plain text files.",
    description:
      "Documentation and notes with no database to run or back up separately. Kaname checks out the stable release, gives the web server its data directories, and puts the wiki behind HTTPS.",
    category: "wiki",
    version: "stable",
    homepage: "https://www.dokuwiki.org",
    license: "GPL-2.0",
    availability: "available",
    unavailable_reason: null,
    requirements: {
      runtime: "php",
      runtime_version: "8.3",
      capabilities: ["nginx"],
      database: null,
      min_memory_mb: 256,
      min_disk_mb: 256,
    },
    source: {
      kind: "git",
      repo_url: "https://github.com/dokuwiki/dokuwiki.git",
      branch: "stable",
      document_root: "",
      probe: "doku.php",
    },
    config: "none",
    writable_paths: ["data", "conf", "lib/plugins", "lib/tpl"],
    finish: "Open /install.php on the site to name the wiki and create the first user.",
  },
  {
    id: "ghost",
    name: "Ghost",
    tagline: "Publishing and newsletters for independent writers.",
    description: "A Node.js publishing platform with memberships and email built in.",
    category: "cms",
    version: "5",
    homepage: "https://ghost.org",
    license: "MIT",
    availability: "coming_soon",
    unavailable_reason: CONTAINER_VERB_MISSING,
    requirements: {
      runtime: "container",
      runtime_version: null,
      capabilities: ["nginx", "docker"],
      database: { engines: ["mysql"], prefix: "ghost" },
      min_memory_mb: 1024,
      min_disk_mb: 2048,
    },
    source: { kind: "image", image: "ghost:5", port: 2368 },
    config: "none",
    writable_paths: [],
    finish: "Open /ghost on the site to create the owner account.",
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    tagline: "Files, calendars and contacts on your own server.",
    description: "A self-hosted alternative to a cloud drive, with sync clients for every device.",
    category: "storage",
    version: "30",
    homepage: "https://nextcloud.com",
    license: "AGPL-3.0",
    availability: "coming_soon",
    unavailable_reason: CONTAINER_VERB_MISSING,
    requirements: {
      runtime: "container",
      runtime_version: null,
      capabilities: ["nginx", "docker"],
      database: { engines: ["postgres", "mariadb", "mysql"], prefix: "nc" },
      min_memory_mb: 2048,
      min_disk_mb: 10240,
    },
    source: { kind: "image", image: "nextcloud:30", port: 80 },
    config: "none",
    writable_paths: [],
    finish: "Open the site to create the administrator account.",
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    tagline: "A status page and uptime monitor you host yourself.",
    description: "Checks HTTP, TCP, DNS and more on a schedule and tells you when something stops.",
    category: "monitoring",
    version: "1",
    homepage: "https://uptime.kuma.pet",
    license: "MIT",
    availability: "coming_soon",
    unavailable_reason: CONTAINER_VERB_MISSING,
    requirements: {
      runtime: "container",
      runtime_version: null,
      capabilities: ["nginx", "docker"],
      database: null,
      min_memory_mb: 256,
      min_disk_mb: 512,
    },
    source: { kind: "image", image: "louislam/uptime-kuma:1", port: 3001 },
    config: "none",
    writable_paths: [],
    finish: "Open the site to create the administrator account.",
  },
  {
    id: "n8n",
    name: "n8n",
    tagline: "Workflow automation with a visual editor.",
    description: "Connects APIs, queues and schedules into workflows you can read and version.",
    category: "automation",
    version: "1",
    homepage: "https://n8n.io",
    license: "Sustainable Use",
    availability: "coming_soon",
    unavailable_reason: CONTAINER_VERB_MISSING,
    requirements: {
      runtime: "container",
      runtime_version: null,
      capabilities: ["nginx", "docker"],
      database: { engines: ["postgres"], prefix: "n8n" },
      min_memory_mb: 1024,
      min_disk_mb: 1024,
    },
    source: { kind: "image", image: "n8nio/n8n:1", port: 5678 },
    config: "none",
    writable_paths: [],
    finish: "Open the site to create the owner account.",
  },
  {
    id: "gitea",
    name: "Gitea",
    tagline: "A lightweight Git service with pull requests and CI.",
    description: "Repositories, issues, reviews and packages in one small binary.",
    category: "developer",
    version: "1.22",
    homepage: "https://about.gitea.com",
    license: "MIT",
    availability: "coming_soon",
    unavailable_reason: CONTAINER_VERB_MISSING,
    requirements: {
      runtime: "container",
      runtime_version: null,
      capabilities: ["nginx", "docker"],
      database: { engines: ["postgres", "mariadb", "mysql"], prefix: "gitea" },
      min_memory_mb: 512,
      min_disk_mb: 2048,
    },
    source: { kind: "image", image: "gitea/gitea:1.22", port: 3000 },
    config: "none",
    writable_paths: [],
    finish: "Open the site to finish the initial configuration.",
  },
];

export function findApp(id: string): AppRecipe | undefined {
  return APP_CATALOG.find((app) => app.id === id);
}

/* ------------------------------------------------------------------ *
 * Provisioning steps
 * ------------------------------------------------------------------ */

export const APP_INSTALL_STEP_IDS = [
  "database",
  "files",
  "configure",
  "site",
  "certificate",
  "verify",
] as const;
export const appInstallStepId = z.enum(APP_INSTALL_STEP_IDS);
export type AppInstallStepId = z.infer<typeof appInstallStepId>;

export interface AppInstallStepSpec {
  id: AppInstallStepId;
  title: string;
  description: string;
}

/**
 * The steps one install runs, in order. Pure, so the review screen, the
 * job and the tests all read the same list: a step that is not here is
 * not performed.
 */
export function appInstallSteps(
  recipe: AppRecipe,
  options: { ssl: boolean },
): AppInstallStepSpec[] {
  const steps: AppInstallStepSpec[] = [];
  if (recipe.requirements.database) {
    steps.push({
      id: "database",
      title: "Create the database",
      description: "A database and a user of its own, with a generated password kept encrypted.",
    });
  }
  steps.push({
    id: "files",
    title: `Download ${recipe.name}`,
    description:
      recipe.source.kind === "git"
        ? `Release ${recipe.version}, checked out from the project's repository.`
        : `Image ${recipe.source.image}.`,
  });
  steps.push({
    id: "configure",
    title: "Configure it",
    description:
      recipe.config === "none"
        ? "Hand the directories it writes to over to the web server."
        : "Write its configuration with fresh keys, and hand its files to the web server.",
  });
  steps.push({
    id: "site",
    title: "Create the website",
    description: "A virtual host for the domain, pointed at the release.",
  });
  if (options.ssl) {
    steps.push({
      id: "certificate",
      title: "Secure it with HTTPS",
      description: "A Let's Encrypt certificate for the domain, renewed automatically.",
    });
  }
  steps.push({
    id: "verify",
    title: "Check it answers",
    description: "The web server configuration is valid and the app's files are in place.",
  });
  return steps;
}

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export const installAppInput = z.object({
  app_id: slug,
  server_id: uuid,
  domain: domainName.transform((name) => name.toLowerCase()),
  /** Registered with Let's Encrypt for expiry notices. */
  admin_email: emailAddress,
  ssl: z.boolean().default(true),
  /** Only for apps that accept more than one engine; defaults to the first the server runs. */
  db_engine: dbEngine.optional(),
  /** The account the web server's PHP workers run as; it is given the app's files. */
  system_user: identifier.default("www-data"),
  php_version: z
    .string()
    .regex(/^\d\.\d$/, "must look like 8.3")
    .optional(),
  /**
   * The id a dry run handed back. Sending it makes the install use the
   * names that plan showed, since they are derived from it.
   */
  plan_id: uuid.optional(),
});
export type InstallAppInput = z.infer<typeof installAppInput>;

/** What an install would create, before anything is created. */
export const appInstallPlan = z.object({
  /** Pass back as `plan_id` to install exactly what this plan describes. */
  plan_id: uuid,
  app_id: slug,
  app_name: z.string(),
  app_version: z.string(),
  server_id: uuid,
  server_name: z.string(),
  url: z.string(),
  site_name: z.string(),
  deploy_root: z.string(),
  webroot: z.string(),
  db_engine: dbEngine.nullable(),
  database: z.string().nullable(),
  db_user: z.string().nullable(),
  steps: z.array(z.object({ id: appInstallStepId, title: z.string(), description: z.string() })),
  /** Things worth knowing that do not stop the install. */
  notices: z.array(z.string()),
});
export type AppInstallPlan = z.infer<typeof appInstallPlan>;

/* ------------------------------------------------------------------ *
 * Installs
 * ------------------------------------------------------------------ */

export const appInstallStatus = z.enum([
  "queued",
  "installing",
  "active",
  "failed",
  "rolling_back",
  "removing",
]);
export type AppInstallStatus = z.infer<typeof appInstallStatus>;

export const appInstallStepStatus = z.enum([
  "pending",
  "running",
  "done",
  /** Finished without what it set out to do, and the install went on (a certificate). */
  "warn",
  "failed",
  /** Completed, then undone because a later step failed. */
  "rolled_back",
]);
export type AppInstallStepStatus = z.infer<typeof appInstallStepStatus>;

export const appInstallStep = z.object({
  id: appInstallStepId,
  title: z.string(),
  description: z.string(),
  status: appInstallStepStatus,
  /** What happened, when it is worth a sentence: a warning, a failure reason. */
  message: z.string().nullable(),
  started_at: isoDate.nullable(),
  finished_at: isoDate.nullable(),
});
export type AppInstallStep = z.infer<typeof appInstallStep>;

/** The resource kinds an install creates, as the ownership model names them. */
export const APP_INSTALL_RESOURCE_KINDS = [
  "app_install",
  "site",
  "domain",
  "database",
  "db_user",
  "certificate",
] as const;
export type AppInstallResourceKind = (typeof APP_INSTALL_RESOURCE_KINDS)[number];

export const appInstall = z.object({
  id: uuid,
  app_id: z.string(),
  app_name: z.string(),
  app_version: z.string(),
  category: appCategory.nullable(),
  server_id: uuid,
  server_name: z.string(),
  domain: z.string(),
  url: z.string(),
  status: appInstallStatus,
  ssl: z.boolean(),
  db_engine: dbEngine.nullable(),
  /** Everything this install created, by kind. Null until the step that creates it. */
  site_id: uuid.nullable(),
  domain_id: uuid.nullable(),
  database_id: uuid.nullable(),
  db_user_id: uuid.nullable(),
  certificate_id: uuid.nullable(),
  steps: z.array(appInstallStep),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** The job that is installing or removing it, for the live log. */
  job_id: uuid.nullable(),
  /** What is left for a person to do. */
  finish: z.string(),
  created_by: uuid.nullable(),
  created_by_name: z.string().nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type AppInstall = z.infer<typeof appInstall>;

export const appInstallListQuery = listQuery.extend({
  server_id: uuid.optional(),
  app_id: slug.optional(),
  status: appInstallStatus.optional(),
});
export type AppInstallListQuery = z.infer<typeof appInstallListQuery>;
