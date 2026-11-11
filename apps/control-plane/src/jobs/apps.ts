import { and, eq } from "@kaname/db";
import {
  appInstalls,
  certificates,
  dbDatabases,
  dbGrants,
  dbInstances,
  dbUsers,
  deployments,
  domains,
  secrets,
  sites,
  type AppInstallResources,
  type AppInstallStepState,
} from "@kaname/db/schema";
import {
  appInstallSteps,
  findApp,
  type AppInstallResourceKind,
  type AppInstallStepId,
  type AppRecipe,
  type JobType,
} from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { open, seal, type SealedSecret } from "../lib/crypto.js";
import {
  APP_DB_PRIVILEGES,
  generatePassword,
  installNames,
  renderConfig,
  writablePaths,
  type InstallNames,
} from "../services/app-installer.js";
import { recordOwnership } from "../services/app-ownership.js";
import type { JobContext, JobHandler } from "./worker.js";

/* ------------------------------------------------------------------ *
 * App installer job handlers.
 *
 * One job provisions the whole bundle — database and user, the app's
 * files, its configuration, a vhost, a certificate — by calling, in a
 * fixed order, the typed agent verbs the Databases, Sites and SSL
 * modules already use. It adds no verb of its own and sends no command
 * line: the only free text that reaches a host is the content of a
 * configuration file, passed to `fs.write` as data.
 *
 * Three properties are worth the bookkeeping below.
 *
 *  Per-step state.  Every step is written to `app_installs.steps` as
 *    it starts and ends and announced on the event stream, so the
 *    panel shows a checklist that moves, not a spinner.
 *
 *  Resumable.  An agent that drops mid-install is a wait, not a failure
 *    (KD-008): the job is re-queued and runs again. Each step records
 *    what it is about to create *before* it asks the host, so the
 *    second run skips finished steps and treats "already exists" on
 *    the step it was in as its own work rather than a clash.
 *
 *  Undo.  A step that fails for real rolls back everything this install
 *    created, newest first — and only that. A database that was on the
 *    host before the install asked for it is never dropped: the flags
 *    in `resources` are what tells the two apart.
 * ------------------------------------------------------------------ */

type InstallRow = typeof appInstalls.$inferSelect;

const GIT_TIMEOUT_MS = 15 * 60_000;
const CERT_TIMEOUT_MS = 5 * 60_000;

function requireServer(ctx: JobContext): string {
  if (!ctx.job.serverId) throw new Error(`${ctx.job.type} requires a server`);
  return ctx.job.serverId;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function agentSaid(err: unknown, code: string): boolean {
  return err instanceof AgentRpcError && err.agentError.code === code;
}

function errorOf(err: unknown): { code: string; message: string } {
  return err instanceof AgentRpcError
    ? { code: err.agentError.code, message: err.agentError.message }
    : { code: "internal_error", message: message(err) };
}

/** Thrown inside a step to end it as a warning: the install carries on. */
class StepWarning extends Error {}

/* ------------------------------------------------------------------ *
 * The run: one install, its row, and the host it is going onto.
 * ------------------------------------------------------------------ */

class InstallRun {
  readonly names: InstallNames;

  constructor(
    readonly ctx: JobContext,
    public row: InstallRow,
    readonly recipe: AppRecipe,
    readonly serverId: string,
  ) {
    this.names = installNames(recipe, { domain: row.domain, ssl: row.ssl }, row.id);
  }

  get res(): AppInstallResources {
    return this.row.resources;
  }

  /** Writes a patch to the row and keeps the in-memory copy in step with it. */
  async save(patch: Partial<InstallRow>): Promise<void> {
    const [next] = await this.ctx.db
      .update(appInstalls)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(appInstalls.id, this.row.id))
      .returning();
    if (!next) throw new Error(`app install ${this.row.id} no longer exists`);
    this.row = next;
  }

  /** Merges bookkeeping into `resources`. Written before the next host call, never after. */
  async remember(patch: AppInstallResources): Promise<void> {
    await this.save({ resources: { ...this.row.resources, ...patch } });
  }

  async setStep(id: AppInstallStepId, patch: Partial<AppInstallStepState>): Promise<void> {
    const steps = this.row.steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
    await this.save({ steps });
    this.announce(id);
  }

  step(id: AppInstallStepId): AppInstallStepState | undefined {
    return this.row.steps.find((step) => step.id === id);
  }

  /** Tells any open install screen that something moved. */
  announce(step?: AppInstallStepId): void {
    this.ctx.events.publish(
      "jobs",
      "app_install.updated",
      {
        job_id: this.ctx.job.id,
        job_type: this.ctx.job.type,
        server_id: this.serverId,
        install_id: this.row.id,
        status: this.row.status,
        step: step ?? null,
        step_status: step ? (this.step(step)?.status ?? null) : null,
      },
      this.serverId,
    );
  }

  /** The single hook through which created resources reach the ownership model. */
  async own(kind: AppInstallResourceKind, resourceId: string): Promise<void> {
    await recordOwnership(this.ctx.db, {
      userId: this.row.createdBy,
      kind,
      resourceId,
      serverId: this.serverId,
      installId: this.row.id,
    });
  }

  call: JobContext["hub"]["call"] = (serverId, method, params, opts) =>
    this.ctx.hub.call(serverId, method, params, { signal: this.ctx.signal, ...opts });

  /**
   * Asks the host to create something this install will own.
   *
   * `flag` is set before the call and `done` after it. If the host
   * answers "conflict" on a run that had already asked once, the thing
   * is ours from the earlier attempt and the step carries on. A
   * conflict on the first ask means it was there before us: the flag is
   * cleared again so rollback leaves it alone, and the step fails.
   */
  async create<T>(
    flag: keyof AppInstallResources & `${string}_attempted`,
    done: keyof AppInstallResources,
    work: () => Promise<T>,
    onExisting: () => Promise<T>,
  ): Promise<T> {
    const resumed = this.res[flag] === true;
    if (this.res[done] === true) return onExisting();
    if (!resumed) await this.remember({ [flag]: true } as AppInstallResources);
    try {
      const result = await work();
      await this.remember({ [done]: true } as AppInstallResources);
      return result;
    } catch (err) {
      if (agentSaid(err, "conflict")) {
        if (resumed) {
          await this.remember({ [done]: true } as AppInstallResources);
          return onExisting();
        }
        await this.remember({ [flag]: false } as AppInstallResources);
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Secrets — stored the way the Databases module stores them: sealed
 * with the master key in `secrets`, referenced from the user row.
 * ------------------------------------------------------------------ */

async function storeSecret(
  ctx: JobContext,
  ref: string,
  ownerType: string,
  ownerId: string,
  plaintext: string,
): Promise<void> {
  const sealed = seal(plaintext, ctx.config.masterKey);
  await ctx.db
    .insert(secrets)
    .values({ ref, ownerType, ownerId, ...sealed })
    .onConflictDoUpdate({ target: secrets.ref, set: { ...sealed, updatedAt: new Date() } });
}

async function readSecret(ctx: JobContext, ref: string): Promise<string | null> {
  const rows = await ctx.db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const sealed: SealedSecret = {
    wrappedKey: row.wrappedKey,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    keyVersion: row.keyVersion,
  };
  return open(sealed, ctx.config.masterKey);
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

type StepFn = (run: InstallRun) => Promise<void>;

async function instanceFor(run: InstallRun) {
  const engine = run.row.dbEngine;
  if (!engine) throw new Error(`${run.recipe.name} needs a database engine and none was chosen`);
  const rows = await run.ctx.db
    .select()
    .from(dbInstances)
    .where(and(eq(dbInstances.serverId, run.serverId), eq(dbInstances.engine, engine)))
    .limit(1);
  const instance = rows[0];
  if (!instance) throw new Error(`this server no longer has a ${engine} instance`);
  return instance;
}

/** Database, its user, and the grant that ties one to the other. */
const databaseStep: StepFn = async (run) => {
  const { ctx, names } = run;
  const instance = await instanceFor(run);
  const database = names.database!;
  const username = names.dbUser!;
  const hostPattern = names.dbHostPattern;
  const encoding = instance.engine === "postgres" ? "UTF8" : "utf8mb4";

  await run.remember({ database, db_user: username, db_host_pattern: hostPattern });

  // Rows first, so the Databases pages show the database the moment it
  // is asked for, and so a resume finds what the first run recorded.
  if (!run.row.databaseId) {
    const [row] = await ctx.db
      .insert(dbDatabases)
      .values({
        instanceId: instance.id,
        serverId: run.serverId,
        engine: instance.engine,
        name: database,
        owner: username,
        encoding,
        lastSyncedAt: new Date(),
      })
      .returning({ id: dbDatabases.id });
    await run.save({ databaseId: row!.id });
    await run.own("database", row!.id);
  }
  if (!run.row.dbUserId) {
    const [row] = await ctx.db
      .insert(dbUsers)
      .values({
        instanceId: instance.id,
        serverId: run.serverId,
        engine: instance.engine,
        username,
        hostPattern,
        canLogin: true,
        lastSyncedAt: new Date(),
      })
      .returning({ id: dbUsers.id });
    const ref = `db_user:${row!.id}`;
    await storeSecret(ctx, ref, "db_user", row!.id, generatePassword());
    await ctx.db.update(dbUsers).set({ secretRef: ref }).where(eq(dbUsers.id, row!.id));
    await ctx.db
      .insert(dbGrants)
      .values({
        databaseId: run.row.databaseId!,
        dbUserId: row!.id,
        privileges: [...APP_DB_PRIVILEGES],
        grantOption: false,
      })
      .onConflictDoNothing();
    await run.save({ dbUserId: row!.id });
    await run.own("db_user", row!.id);
  }

  const password = await readSecret(ctx, `db_user:${run.row.dbUserId}`);
  if (!password) throw new Error("the database user's stored credential is missing");

  await ctx.log_("info", `creating user ${username}@${hostPattern}`);
  await run.create(
    "db_user_attempted",
    "db_user_created",
    () =>
      run.call(run.serverId, "db.user.create", {
        engine: instance.engine,
        username,
        password,
        host_pattern: hostPattern,
      }),
    // Ours from an earlier attempt: make sure it holds the password we kept.
    () =>
      run.call(run.serverId, "db.user.update", {
        engine: instance.engine,
        username,
        host_pattern: hostPattern,
        password,
      }),
  );

  await ctx.log_("info", `creating ${instance.engine} database ${database}`);
  const info = await run.create(
    "database_attempted",
    "database_created",
    () =>
      run.call(run.serverId, "db.database.create", {
        engine: instance.engine,
        name: database,
        encoding,
        // PostgreSQL sets the owner at create time, which is why the user
        // is made first. MySQL has no owner; the grant below is the link.
        ...(instance.engine === "postgres" ? { owner: username } : {}),
      }),
    async () => null,
  );
  if (info) {
    await ctx.db
      .update(dbDatabases)
      .set({ sizeBytes: info.size_bytes, tableCount: info.table_count, updatedAt: new Date() })
      .where(eq(dbDatabases.id, run.row.databaseId!));
  }

  // Replaces the user's grants on this one database, so it is safe to repeat.
  await run.call(run.serverId, "db.grant.apply", {
    engine: instance.engine,
    database,
    username,
    host_pattern: hostPattern,
    privileges: [...APP_DB_PRIVILEGES],
  });
  await ctx.log_("info", `${username} granted ${APP_DB_PRIVILEGES.join(", ")} on ${database}`);
};

/** The app's files, as a release the vhost will serve through `current`. */
const filesStep: StepFn = async (run) => {
  const { ctx, names, recipe } = run;
  const source = recipe.source;
  if (source.kind !== "git") {
    throw new Error(`${recipe.name} ships as a container image, which Kaname cannot provision yet`);
  }
  await run.remember({
    site_name: names.siteName,
    deploy_root: names.deployRoot,
    webroot: names.webroot,
    release: names.release,
  });

  await ctx.log_("info", `checking out ${source.repo_url} (${source.branch})`);
  const releasePath = `${names.deployRoot}/releases/${names.release}`;
  const result = await run.create(
    "files_attempted",
    "files_created",
    () =>
      run.call(
        run.serverId,
        "site.release.create",
        {
          name: names.siteName,
          root: names.deployRoot,
          release: names.release,
          source: "git",
          repo_url: source.repo_url,
          branch: source.branch,
          keep: 5,
        },
        { timeoutMs: GIT_TIMEOUT_MS },
      ),
    // The release is on disk from an earlier attempt that never heard the
    // answer. Pointing `current` at it is the same swap, and repeatable.
    async () => {
      const activated = await run.call(run.serverId, "site.release.activate", {
        name: names.siteName,
        root: names.deployRoot,
        release_path: releasePath,
      });
      return {
        release_path: activated.release_path,
        current_path: activated.current_path,
        commit_sha: run.res.commit_sha ?? null,
        pruned: [],
        log: [`${activated.current_path} -> ${activated.release_path}`],
      };
    },
  );
  for (const line of result.log) await ctx.log_("info", line);
  await run.remember({ release_path: result.release_path, commit_sha: result.commit_sha });
};

/** Configuration written as file content, then the tree handed to the web server's account. */
const configureStep: StepFn = async (run) => {
  const { ctx, recipe } = run;
  const releasePath = run.res.release_path;
  if (!releasePath) throw new Error("the release path was not recorded");

  let config = null;
  if (recipe.requirements.database) {
    const instance = await instanceFor(run);
    const password = await readSecret(ctx, `db_user:${run.row.dbUserId}`);
    if (!password) throw new Error("the database user's stored credential is missing");
    config = {
      database: run.names.database!,
      dbUser: run.names.dbUser!,
      dbPassword: password,
      dbHost: instance.host,
      dbPort: instance.port,
      engine: instance.engine,
    };
  }

  for (const file of renderConfig(recipe, config)) {
    // The content carries the database password, so it is never logged.
    await run.call(run.serverId, "fs.write", {
      path: `${releasePath}/${file.path}`,
      content: file.content,
      encoding: "utf8",
      mode: file.mode,
      create_parents: false,
    });
    await ctx.log_("info", `wrote ${file.path}`);
  }

  const paths = writablePaths(recipe, releasePath);
  if (paths.length > 0) {
    const owner = run.row.inputs.system_user;
    try {
      await run.call(run.serverId, "fs.chown", { paths, owner, group: owner, recursive: true });
    } catch (err) {
      if (agentSaid(err, "not_found")) {
        throw new Error(
          `This server has no "${owner}" account to give the app's files to. Install again and set the web server user to the account PHP runs as on this host.`,
        );
      }
      throw err;
    }
    await ctx.log_("info", `${paths.length === 1 ? "files" : `${paths.length} directories`} handed to ${owner}`);
  }
};

/** The site row, its domain, and the vhost on the host. */
const siteStep: StepFn = async (run) => {
  const { ctx, names, recipe } = run;
  const inputs = run.row.inputs;
  const runtimeVersion = inputs.php_version ?? recipe.requirements.runtime_version;
  const source = recipe.source;

  if (!run.row.siteId) {
    const [site] = await ctx.db
      .insert(sites)
      .values({
        serverId: run.serverId,
        name: names.siteName,
        webroot: names.webroot,
        runtime: recipe.requirements.runtime,
        runtimeVersion,
        forceHttps: run.row.ssl,
        owner: inputs.system_user,
        status: "provisioning",
        config: {
          primary_domain: run.row.domain,
          app: { id: recipe.id, version: recipe.version, install_id: run.row.id },
        },
        ...(source.kind === "git" ? { repoUrl: source.repo_url, branch: source.branch } : {}),
      })
      .returning({ id: sites.id });
    await run.save({ siteId: site!.id });
    await run.own("site", site!.id);
  }
  const siteId = run.row.siteId!;

  if (!run.row.domainId) {
    const existing = await ctx.db
      .select()
      .from(domains)
      .where(eq(domains.name, run.row.domain))
      .limit(1);
    const found = existing[0];
    if (found?.siteId && found.siteId !== siteId) {
      throw new Error(`${run.row.domain} was attached to another site while this install was queued`);
    }
    if (found) {
      await ctx.db
        .update(domains)
        .set({ siteId, serverId: run.serverId, updatedAt: new Date() })
        .where(eq(domains.id, found.id));
      await run.remember({ domain_preexisting: true });
      await run.save({ domainId: found.id });
    } else {
      const [created] = await ctx.db
        .insert(domains)
        .values({ name: run.row.domain, siteId, serverId: run.serverId, status: "pending" })
        .returning({ id: domains.id });
      await run.remember({ domain_preexisting: false });
      await run.save({ domainId: created!.id });
      await run.own("domain", created!.id);
    }
    await ctx.db
      .update(sites)
      .set({ primaryDomainId: run.row.domainId, updatedAt: new Date() })
      .where(eq(sites.id, siteId));
  }

  await ctx.log_("info", `creating the vhost for ${run.row.domain}`);
  let written: { config_path: string };
  try {
    written = await run.create(
      "site_attempted",
      "site_created",
      () =>
        run.call(run.serverId, "site.create", {
          name: names.siteName,
          server_names: [run.row.domain],
          webroot: names.webroot,
          runtime: recipe.requirements.runtime,
          ...(runtimeVersion ? { runtime_version: runtimeVersion } : {}),
          force_https: run.row.ssl,
        }),
      // Ours already: re-render it so it matches what this run would write.
      () => run.call(run.serverId, "site.update", { name: names.siteName }),
    );
    await run.call(run.serverId, "site.reload", {});
  } catch (err) {
    if (!(err instanceof AgentOfflineError)) {
      await ctx.db
        .update(sites)
        .set({ status: "error", lastError: message(err), updatedAt: new Date() })
        .where(eq(sites.id, siteId));
    }
    throw err;
  }

  await ctx.db
    .update(sites)
    .set({ status: "active", configPath: written.config_path, lastError: null, updatedAt: new Date() })
    .where(eq(sites.id, siteId));

  // The release this install checked out is the site's first deployment,
  // so the Deployments page shows it and can roll back to it later.
  if (run.res.release_path) {
    const already = await ctx.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.siteId, siteId), eq(deployments.releasePath, run.res.release_path)))
      .limit(1);
    if (!already[0]) {
      await ctx.db.insert(deployments).values({
        siteId,
        source: "git",
        repoUrl: source.kind === "git" ? source.repo_url : null,
        branch: source.kind === "git" ? source.branch : null,
        commitSha: run.res.commit_sha ?? null,
        commitMessage: `${recipe.name} ${recipe.version} (app installer)`,
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
        triggeredBy: run.row.createdBy,
        triggeredByName: run.row.createdByName,
        jobId: ctx.job.id,
        releasePath: run.res.release_path,
      });
    }
  }
  ctx.events.publish(
    "servers",
    "site.created",
    { site_id: siteId, server_id: run.serverId, job_id: ctx.job.id },
    run.serverId,
  );
};

/**
 * HTTPS. The one step that may end in a warning: a certificate cannot
 * be issued until the domain's DNS reaches this server, which is the
 * usual state of a domain someone is installing onto for the first
 * time. The app is in place either way, the certificate row keeps the
 * reason, and SSL / TLS can retry it — undoing a working install over
 * a DNS record would be the wrong trade.
 */
const certificateStep: StepFn = async (run) => {
  const { ctx } = run;
  const subject = run.row.domain;

  if (!run.row.certificateId) {
    const existing = await ctx.db
      .select({ id: certificates.id, status: certificates.status })
      .from(certificates)
      .where(and(eq(certificates.serverId, run.serverId), eq(certificates.subject, subject)))
      .limit(1);
    if (existing[0]) {
      // Someone already holds one for this name on this host: use it.
      await ctx.log_("info", `${subject} already has a certificate on this server; using it`);
      await run.call(run.serverId, "site.update", { name: run.names.siteName });
      await run.call(run.serverId, "site.reload", {});
      return;
    }
    const [row] = await ctx.db
      .insert(certificates)
      .values({
        domainId: run.row.domainId,
        serverId: run.serverId,
        subject,
        sans: [],
        issuer: "Let's Encrypt",
        challenge: "http-01",
        keyType: "ecdsa",
        status: "pending",
        autoRenew: true,
        lastRenewalJobId: ctx.job.id,
      })
      .returning({ id: certificates.id });
    await run.save({ certificateId: row!.id });
    await run.own("certificate", row!.id);
  }
  const certificateId = run.row.certificateId!;

  await run.remember({ certificate_attempted: true });
  await ctx.log_("info", `requesting a certificate for ${subject}`);
  try {
    const handle = ctx.hub.stream(
      run.serverId,
      "cert.issue",
      {
        domains: [subject],
        challenge: "http-01",
        email: run.row.inputs.admin_email,
        webroot: run.names.webroot,
        key_type: "ecdsa",
        staging: false,
      },
      (chunk) => {
        for (const line of chunk.split("\n").filter(Boolean)) void ctx.log_("info", line.trim());
      },
      { timeoutMs: CERT_TIMEOUT_MS, signal: ctx.signal },
    );
    const result = await handle.done;
    await ctx.db
      .update(certificates)
      .set({
        status: "active",
        sans: result.sans,
        issuedAt: new Date(),
        expiresAt: new Date(result.not_after),
        installedPath: result.path,
        lastRenewalAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(certificates.id, certificateId));
    await run.remember({ certificate_issued: true });
  } catch (err) {
    if (err instanceof AgentOfflineError || ctx.signal.aborted) throw err;
    await ctx.db
      .update(certificates)
      .set({ status: "failed", lastError: message(err), updatedAt: new Date() })
      .where(eq(certificates.id, certificateId));
    ctx.events.publish("certificates", "certificate.failed", { certificate_id: certificateId }, run.serverId);
    throw new StepWarning(
      `No certificate yet: ${message(err)} Point ${subject} at this server, then retry it from SSL / TLS.`,
    );
  }

  // The vhost picks its certificate up when it is rendered.
  await run.call(run.serverId, "site.update", { name: run.names.siteName });
  await run.call(run.serverId, "site.reload", {});
  ctx.events.publish("certificates", "certificate.issued", { certificate_id: certificateId }, run.serverId);
};

/** The health check: nginx accepts its configuration, and the app's entry file is where the vhost looks. */
const verifyStep: StepFn = async (run) => {
  const { ctx, recipe } = run;
  const test = await run.call(run.serverId, "site.test_config", {});
  if (!test.valid) {
    await ctx.log_("error", test.output);
    throw new Error(`The web server configuration is invalid: ${test.output.slice(0, 400)}`);
  }
  if (recipe.source.kind === "git") {
    const probe = `${run.names.webroot}/${recipe.source.probe}`;
    try {
      await run.call(run.serverId, "fs.stat", { path: probe });
    } catch (err) {
      if (agentSaid(err, "not_found")) {
        throw new Error(`${recipe.name} is not where the site serves from: ${probe} is missing.`);
      }
      throw err;
    }
    await ctx.log_("info", `${probe} is in place`);
  }
};

const STEPS: Record<AppInstallStepId, StepFn> = {
  database: databaseStep,
  files: filesStep,
  configure: configureStep,
  site: siteStep,
  certificate: certificateStep,
  verify: verifyStep,
};

/* ------------------------------------------------------------------ *
 * Teardown — shared by a failed install's rollback and by uninstall.
 * ------------------------------------------------------------------ */

/**
 * Removes what an install created, newest first. Each removal stands
 * alone: one that fails is logged and reported, and the rest still run,
 * so a host that refuses to drop a database does not strand a vhost.
 * An offline agent is not a failure here either — it is rethrown, the
 * job waits, and teardown resumes where the flags say it stopped.
 *
 * Returns what could not be removed. Empty means the host is clean.
 */
export async function teardown(run: InstallRun): Promise<string[]> {
  const { ctx } = run;
  const leftovers: string[] = [];

  const attempt = async (what: string, work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (err) {
      if (err instanceof AgentOfflineError) throw err;
      // Already gone is the outcome that was wanted.
      if (agentSaid(err, "not_found")) return true;
      leftovers.push(`${what}: ${message(err)}`);
      await ctx.log_("warn", `could not remove ${what}: ${message(err)}`);
      return false;
    }
  };

  /* certificate */
  if (run.row.certificateId) {
    const certificateId = run.row.certificateId;
    let ok = true;
    if (run.res.certificate_issued) {
      ok = await attempt(`the certificate for ${run.row.domain}`, async () => {
        await run.call(run.serverId, "cert.revoke", {
          subject: run.row.domain,
          reason: "cessationofoperation",
        });
      });
    }
    if (ok) {
      await ctx.db.delete(certificates).where(eq(certificates.id, certificateId));
      await run.remember({ certificate_issued: false, certificate_attempted: false });
      await run.save({ certificateId: null });
      await ctx.log_("info", "certificate removed");
    }
  }

  /* site, then its files */
  const siteName = run.res.site_name ?? run.names.siteName;
  if (run.res.site_created || run.res.site_attempted) {
    const ok = await attempt(`the vhost ${siteName}`, async () => {
      // `current` is a symlink, so the vhost's webroot is not what holds
      // the files; the deploy root is removed on its own below.
      await run.call(run.serverId, "site.remove", { name: siteName, delete_webroot: false });
    });
    if (ok) {
      await run.remember({ site_created: false, site_attempted: false });
      await ctx.log_("info", `vhost ${siteName} removed`);
    }
  }
  if (!run.res.site_created && !run.res.site_attempted) {
    if (run.row.domainId) {
      if (run.res.domain_preexisting) {
        // Detach only if it still points at this install's site.
        await ctx.db
          .update(domains)
          .set({ siteId: null, updatedAt: new Date() })
          .where(
            run.row.siteId
              ? and(eq(domains.id, run.row.domainId), eq(domains.siteId, run.row.siteId))
              : eq(domains.id, run.row.domainId),
          );
      } else {
        await ctx.db.delete(domains).where(eq(domains.id, run.row.domainId));
      }
      await run.save({ domainId: null });
    }
    if (run.row.siteId) {
      await ctx.db.delete(sites).where(eq(sites.id, run.row.siteId));
      await run.save({ siteId: null });
    }
  }

  const deployRoot = run.res.deploy_root;
  if (deployRoot && (run.res.files_created || run.res.files_attempted)) {
    const ok = await attempt(`the files in ${deployRoot}`, async () => {
      await run.call(run.serverId, "fs.remove", { paths: [deployRoot], recursive: true });
    });
    if (ok) {
      await run.remember({ files_created: false, files_attempted: false });
      await ctx.log_("info", `${deployRoot} removed`);
    }
  }

  /* the database, then its user (PostgreSQL will not drop a role that owns one) */
  const engine = run.row.dbEngine;
  if (engine) {
    const database = run.res.database;
    if (database && (run.res.database_created || run.res.database_attempted)) {
      const ok = await attempt(`the database ${database}`, async () => {
        await run.call(run.serverId, "db.database.delete", { engine, name: database });
      });
      if (ok) await run.remember({ database_created: false, database_attempted: false });
    }
    if (run.row.databaseId && !run.res.database_created && !run.res.database_attempted) {
      await ctx.db.delete(dbDatabases).where(eq(dbDatabases.id, run.row.databaseId));
      await run.save({ databaseId: null });
      await ctx.log_("info", `database ${database ?? ""} removed`.replace("  ", " "));
    }

    const username = run.res.db_user;
    if (username && (run.res.db_user_created || run.res.db_user_attempted)) {
      const ok = await attempt(`the database user ${username}`, async () => {
        await run.call(run.serverId, "db.user.delete", {
          engine,
          username,
          host_pattern: run.res.db_host_pattern ?? "localhost",
        });
      });
      if (ok) await run.remember({ db_user_created: false, db_user_attempted: false });
    }
    if (run.row.dbUserId && !run.res.db_user_created && !run.res.db_user_attempted) {
      await ctx.db.delete(secrets).where(eq(secrets.ref, `db_user:${run.row.dbUserId}`));
      await ctx.db.delete(dbUsers).where(eq(dbUsers.id, run.row.dbUserId));
      await run.save({ dbUserId: null });
      await ctx.log_("info", `database user ${username ?? ""} removed`.replace("  ", " "));
    }
  }

  return leftovers;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function loadRun(ctx: JobContext): Promise<InstallRun> {
  const serverId = requireServer(ctx);
  const { install_id } = ctx.job.params as { install_id: string };
  const rows = await ctx.db.select().from(appInstalls).where(eq(appInstalls.id, install_id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`app install ${install_id} no longer exists`);
  const recipe = findApp(row.appId);
  if (!recipe) throw new Error(`${row.appId} is no longer in the catalog`);
  return new InstallRun(ctx, row, recipe, serverId);
}

/** Marks finished steps as undone once their work has been removed. */
async function markRolledBack(run: InstallRun): Promise<void> {
  const steps = run.row.steps.map((step) =>
    step.status === "done" || step.status === "warn"
      ? { ...step, status: "rolled_back" as const }
      : step,
  );
  await run.save({ steps });
}

async function rollBack(run: InstallRun, cause: { code: string; message: string }): Promise<void> {
  const { ctx } = run;
  await ctx.log_("warn", "rolling back what this install created");
  const leftovers = await teardown(run);
  await markRolledBack(run);
  await run.save({
    status: "failed",
    error:
      leftovers.length > 0
        ? {
            code: cause.code,
            message: `${cause.message} Some of what was created could not be removed: ${leftovers.join("; ")}`,
          }
        : cause,
  });
  run.announce();
  await ctx.log_(
    leftovers.length > 0 ? "warn" : "info",
    leftovers.length > 0
      ? `rollback finished with ${leftovers.length} leftover${leftovers.length === 1 ? "" : "s"}`
      : "rollback complete: nothing this install created is left on the server",
  );
}

const appInstall: JobHandler = async (ctx) => {
  const run = await loadRun(ctx);
  const summary = () => ({
    install_id: run.row.id,
    app_id: run.row.appId,
    url: run.names.url,
    site_id: run.row.siteId,
    database_id: run.row.databaseId,
    db_user_id: run.row.dbUserId,
    certificate_id: run.row.certificateId,
    domain_id: run.row.domainId,
  });

  // Finished on a run whose completion the queue never recorded.
  if (run.row.status === "active") return summary();

  // A rollback that was waiting for the agent to come back.
  if (run.row.status === "rolling_back" || run.row.status === "failed") {
    const cause = run.row.error ?? { code: "internal_error", message: "The install failed." };
    if (run.row.status === "rolling_back") await rollBack(run, cause);
    throw new Error(cause.message);
  }

  await run.save({ status: "installing", jobId: ctx.job.id, error: null });
  run.announce();

  const planned = appInstallSteps(run.recipe, { ssl: run.row.ssl });
  let index = 0;
  for (const spec of planned) {
    index += 1;
    const state = run.step(spec.id);
    if (state?.status === "done" || state?.status === "warn") continue;

    await run.setStep(spec.id, {
      status: "running",
      message: null,
      started_at: state?.started_at ?? new Date().toISOString(),
      finished_at: null,
    });
    await ctx.log_("info", `step ${index}/${planned.length}: ${spec.title}`);

    try {
      await STEPS[spec.id](run);
      await run.setStep(spec.id, { status: "done", finished_at: new Date().toISOString() });
    } catch (err) {
      if (err instanceof StepWarning) {
        await ctx.log_("warn", err.message);
        await run.setStep(spec.id, {
          status: "warn",
          message: err.message,
          finished_at: new Date().toISOString(),
        });
      } else {
        // The agent dropped, or the control plane is shutting down: the
        // step stays "running" and the next run of this job resumes it.
        if (err instanceof AgentOfflineError || ctx.signal.aborted) throw err;

        const cause = errorOf(err);
        await run.setStep(spec.id, {
          status: "failed",
          message: cause.message,
          finished_at: new Date().toISOString(),
        });
        await run.save({ status: "rolling_back", error: cause });
        run.announce();
        await rollBack(run, cause);
        throw err;
      }
    }
    await ctx.progress(Math.round((index / planned.length) * 100));
  }

  await run.save({ status: "active", error: null });
  await run.own("app_install", run.row.id);
  run.announce();
  await ctx.log_("info", `${run.recipe.name} is installed at ${run.names.url}. ${run.recipe.finish}`);
  return summary();
};

const appUninstall: JobHandler = async (ctx) => {
  const run = await loadRun(ctx);
  await run.save({ status: "removing", jobId: ctx.job.id });
  run.announce();
  await ctx.log_("info", `removing ${run.row.appName} from ${run.row.domain}`);

  const leftovers = await teardown(run);
  if (leftovers.length > 0) {
    const error = {
      code: "cleanup_incomplete",
      message: `Not everything could be removed: ${leftovers.join("; ")}`,
    };
    await run.save({ status: "failed", error });
    run.announce();
    throw new Error(error.message);
  }

  await ctx.db.delete(appInstalls).where(eq(appInstalls.id, run.row.id));
  ctx.events.publish(
    "jobs",
    "app_install.removed",
    { job_id: ctx.job.id, job_type: ctx.job.type, server_id: run.serverId, install_id: run.row.id },
    run.serverId,
  );
  await ctx.log_("info", "uninstalled");
  return { install_id: run.row.id, removed: true };
};

export function appJobHandlers(): Partial<Record<JobType, JobHandler>> {
  return {
    "app.install": appInstall,
    "app.uninstall": appUninstall,
  };
}
