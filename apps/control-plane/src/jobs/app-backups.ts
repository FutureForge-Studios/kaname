import { eq } from "@kaname/db";
import { appInstalls, restorePoints } from "@kaname/db/schema";
import { MANAGED_APPS_ROOT } from "@kaname/contract/agent";
import { findApp, type AppBackupManifest, type JobType, type MethodResult } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import {
  buildManifest,
  installDir,
  loadInstallRow,
  siteRoot,
  type AppBackupPlanEntry,
} from "../services/app-backup-plan.js";
import { provisionForJob, storedRefForJob } from "../services/backup-secrets.js";
import type { JobContext, JobHandler } from "./worker.js";

/* ------------------------------------------------------------------ *
 * App backup & restore — the job side (KD-043).
 *
 * Backup: `backup.run` calls `prepareAppBackups` before the snapshot and
 * `finishAppBackups` after it, whatever happened. Prepare stops the app
 * container when the recipe asks for it, has the agent dump each SQL
 * companion (`app.db_dump`, a fixed argv inside the labelled container)
 * or, for a git recipe, `db.dump` into the site root, and writes the
 * manifest. Finish starts what prepare stopped and removes a git
 * recipe's dump from the live site root.
 *
 * Restore (`app.restore`): one job, every step logged and evented.
 *
 *   1. stage      restic restores the app's tree into a staging directory
 *   2. safety     today's database is dumped (slot pre_restore) first
 *   3. stop       the app container stops
 *   4. swap       live data -> staging/previous, staged data -> live
 *   5. import     each companion re-imports its dump
 *   6. start      containers start again
 *   7. check      the app answers on its loopback port (or its entry file exists)
 *
 * A failure after the swap swaps back and re-imports the safety dump,
 * so the original is what is left running wherever that is possible;
 * the log says so, and names the staging directory if it is not.
 * ------------------------------------------------------------------ */

function requireServer(ctx: JobContext): string {
  if (!ctx.job.serverId) throw new Error(`${ctx.job.type} requires a server`);
  return ctx.job.serverId;
}

function agentSaid(err: unknown, code: string): boolean {
  return err instanceof AgentRpcError && err.agentError.code === code;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

const appContainer = (installId: string, role = "app") => `kaname-${installId}-${role}`;

/* ------------------------------------------------------------------ *
 * Backup hooks
 * ------------------------------------------------------------------ */

export interface PreparedApps {
  /** Containers prepare stopped, which finish starts again. */
  stopped: string[];
  /** Files prepare wrote into a live tree and finish removes. */
  scratch: string[];
  manifests: Record<string, AppBackupManifest>;
}

export function emptyPrepared(): PreparedApps {
  return { stopped: [], scratch: [], manifests: {} };
}

export async function prepareAppBackups(
  ctx: JobContext,
  serverId: string,
  apps: readonly AppBackupPlanEntry[],
  /** Filled in as it goes, so a failure halfway still knows what to undo. */
  prepared: PreparedApps = emptyPrepared(),
): Promise<PreparedApps> {
  const call: JobContext["hub"]["call"] = (s, method, params, opts) =>
    ctx.hub.call(s, method, params, { signal: ctx.signal, ...opts });

  for (const entry of apps) {
    const row = await loadInstallRow(ctx.db, entry.install_id);
    const recipe = row ? findApp(row.appId) : undefined;
    if (!row || !recipe) throw new Error(`App install ${entry.install_id} no longer exists.`);
    const label = `${row.appName} on ${row.domain}`;
    const dumps: { role: string; engine: string; path: string }[] = [];
    const takenAt = new Date();

    if (entry.stop) {
      await ctx.log_("info", `${label}: stopping the app container for a consistent snapshot`);
      await call(serverId, "container.stop", { id: appContainer(row.id), timeout_seconds: 30 });
      prepared.stopped.push(appContainer(row.id));
    }

    for (const companion of entry.companions) {
      await ctx.log_("info", `${label}: dumping ${companion.engine} (${companion.role}) inside its container`);
      const dumped = await call(
        serverId,
        "app.db_dump",
        {
          install_id: row.id,
          role: companion.role,
          engine: companion.engine as "postgres" | "mysql" | "mariadb",
          slot: "backup",
        },
        { timeoutMs: 60 * 60 * 1000 },
      );
      await ctx.log_("info", `${label}: ${dumped.database} -> ${dumped.path} (${dumped.size_bytes} bytes)`);
      dumps.push({ role: companion.role, engine: companion.engine, path: dumped.path });
    }

    if (entry.database) {
      const dir = `${siteRoot(row)}/.kaname-backup`;
      await call(serverId, "fs.mkdir", { path: dir, parents: true, mode: "0700" });
      await ctx.log_("info", `${label}: dumping ${entry.database.engine} database ${entry.database.name}`);
      const handle = ctx.hub.stream(
        serverId,
        "db.dump",
        {
          engine: entry.database.engine as "mysql" | "mariadb" | "postgres",
          name: entry.database.name,
          destination: `${dir}/${entry.database.engine}-${entry.database.name}.sql`,
          compress: true,
        },
        () => undefined,
        { signal: ctx.signal, timeoutMs: 60 * 60 * 1000 },
      );
      const dumped = await handle.done;
      dumps.push({ role: "site", engine: entry.database.engine, path: dumped.path });
      prepared.scratch.push(dumped.path);
    }

    const manifest = buildManifest(row, recipe, entry, dumps, takenAt, entry.stop);
    await call(serverId, "fs.write", {
      path: entry.manifest_path,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      encoding: "utf8",
      mode: "0600",
      create_parents: true,
    });
    if (entry.kind === "git") prepared.scratch.push(entry.manifest_path);
    prepared.manifests[row.id] = manifest;
  }
  return prepared;
}

/** Undoes prepare's side effects on the live host. Never throws. */
export async function finishAppBackups(ctx: JobContext, serverId: string, prepared: PreparedApps): Promise<void> {
  for (const id of prepared.stopped) {
    try {
      await ctx.hub.call(serverId, "container.start", { id }, { signal: ctx.signal });
      await ctx.log_("info", `${id} started again`);
    } catch (err) {
      await ctx.log_("error", `${id} could not be started again: ${message(err)}. Start it from Containers.`);
    }
  }
  if (prepared.scratch.length > 0) {
    await ctx.hub
      .call(serverId, "fs.remove", { paths: prepared.scratch, recursive: false }, { signal: ctx.signal })
      .catch((err: unknown) => ctx.log_("warn", `could not remove ${prepared.scratch.join(", ")}: ${message(err)}`));
  }
}

/** Stores the manifests on the run's restore point. */
export async function recordManifests(
  ctx: JobContext,
  restorePointId: string | undefined,
  prepared: PreparedApps,
): Promise<void> {
  if (!restorePointId || Object.keys(prepared.manifests).length === 0) return;
  await ctx.db
    .update(restorePoints)
    .set({ manifest: { apps: prepared.manifests } })
    .where(eq(restorePoints.id, restorePointId));
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

export interface AppRestoreParams {
  /** The install written to: the same one, or the new one for "as new". */
  install_id: string;
  /** The install inside the snapshot. */
  source_install_id: string;
  restore_point_id: string;
  repository: string;
  password_ref: string;
  snapshot_id: string;
  mode: "in_place" | "as_new";
}

export const RESTORE_STEPS = ["wait", "stage", "safety", "stop", "swap", "import", "start", "check"] as const;
export type RestoreStep = (typeof RESTORE_STEPS)[number];

export const RESTORE_TIMING = { installPollMs: 3000, installWaitMs: 45 * 60 * 1000, checkAttempts: 20, checkIntervalMs: 3000 };

/**
 * The restic secret goes onto the job's host before anything else, and
 * comes off it again when that host is not the schedule's own (a restore
 * as new onto another server).
 */
const appRestore: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = ctx.job.params as unknown as AppRestoreParams;
  const [source] = p.password_ref
    ? []
    : await ctx.db
        .select({ scheduleId: restorePoints.scheduleId })
        .from(restorePoints)
        .where(eq(restorePoints.id, p.restore_point_id))
        .limit(1);
  const storedRef = await storedRefForJob(ctx, p.password_ref, source?.scheduleId);
  const secret = await provisionForJob(ctx, serverId, storedRef);
  try {
    return await restoreApp(ctx, serverId, { ...p, password_ref: secret.ref });
  } finally {
    await secret.cleanup();
  }
};

async function restoreApp(ctx: JobContext, serverId: string, p: AppRestoreParams) {
  const call: JobContext["hub"]["call"] = (s, method, params, opts) =>
    ctx.hub.call(s, method, params, { signal: ctx.signal, ...opts });

  const step = async <T>(name: RestoreStep, work: () => Promise<T>): Promise<T> => {
    await ctx.log_("info", `[${RESTORE_STEPS.indexOf(name) + 1}/${RESTORE_STEPS.length}] ${name}`);
    ctx.events.publish("backups", "app_restore.step", { install_id: p.install_id, step: name, status: "running" }, serverId);
    try {
      const out = await work();
      ctx.events.publish("backups", "app_restore.step", { install_id: p.install_id, step: name, status: "done" }, serverId);
      await ctx.progress(Math.round(((RESTORE_STEPS.indexOf(name) + 1) / RESTORE_STEPS.length) * 100));
      return out;
    } catch (err) {
      ctx.events.publish(
        "backups",
        "app_restore.step",
        { install_id: p.install_id, step: name, status: "failed", error: message(err) },
        serverId,
      );
      throw err;
    }
  };

  const [point] = await ctx.db.select().from(restorePoints).where(eq(restorePoints.id, p.restore_point_id)).limit(1);
  const manifest = point?.manifest?.apps?.[p.source_install_id];
  if (!manifest) throw new Error("The restore point carries no manifest for this app.");

  /* 1. wait — a restore as new waits for its fresh install to finish. */
  const row = await step("wait", async () => {
    const deadline = Date.now() + RESTORE_TIMING.installWaitMs;
    for (;;) {
      const current = await loadInstallRow(ctx.db, p.install_id);
      if (!current) throw new Error("The target install no longer exists.");
      if (current.status === "active") return current;
      if (current.status === "failed" || current.status === "removing") {
        throw new Error(`The new install of ${current.appName} on ${current.domain} ${current.status === "failed" ? "failed" : "is being removed"}; nothing was restored.`);
      }
      if (p.mode === "in_place" || Date.now() > deadline) {
        throw new Error(`${current.appName} on ${current.domain} is ${current.status}, not active.`);
      }
      await pause(RESTORE_TIMING.installPollMs, ctx.signal);
    }
  });
  const recipe = findApp(row.appId);
  if (!recipe) throw new Error(`${row.appName} is no longer in the catalog.`);
  const image = recipe.source.kind === "image";
  const label = `${row.appName} on ${row.domain}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const liveRoot = image ? installDir(row.id) : siteRoot(row);
  const sourceRoot = image ? installDir(manifest.install_id) : (manifest.paths.site_root ?? siteRoot(row));
  const staging = image
    ? `${MANAGED_APPS_ROOT}/.restore/${row.id}-${stamp}`
    : `${liveRoot.replace(/\/[^/]+$/, "")}/.kaname-restore/${row.id}-${stamp}`;
  const stagedRoot = `${staging}${sourceRoot}`;
  const companions = image && recipe.source.kind === "image" ? recipe.source.companions : [];
  const dumped = manifest.paths.dumps.filter((d) => d.role !== "site");
  /** Directories swapped: live relative path -> staged relative path. */
  const swapDirs = image
    ? ["data", ...companions.filter((c) => !dumped.some((d) => d.role === c.role)).map((c) => `${c.role}/data`)]
    : [];

  /* 2. stage */
  await step("stage", async () => {
    await call(serverId, "fs.mkdir", { path: staging, parents: true, mode: "0700" });
    const handle = ctx.hub.stream(
      serverId,
      "backup.restore",
      {
        repository: p.repository,
        password_ref: p.password_ref,
        snapshot_id: p.snapshot_id,
        target: staging,
        include: [sourceRoot],
        overwrite: false,
      },
      (chunk) => {
        for (const line of chunk.split("\n").filter(Boolean)) void ctx.log_("info", line.trim());
      },
      { signal: ctx.signal, timeoutMs: ctx.job.timeoutMs },
    );
    const restored = await handle.done;
    await ctx.log_("info", `staged ${restored.restored_files} file(s) under ${staging}`);
  });

  /* 3. safety */
  const safety: { role: string; engine: string }[] = [];
  await step("safety", async () => {
    for (const d of dumped) {
      await call(serverId, "app.db_dump", {
        install_id: row.id,
        role: d.role,
        engine: d.engine as "postgres" | "mysql" | "mariadb",
        slot: "pre_restore",
      }, { timeoutMs: 60 * 60 * 1000 });
      safety.push({ role: d.role, engine: d.engine });
      await ctx.log_("info", `${d.role}: current database saved as the pre-restore dump`);
    }
  });

  /* 4. stop */
  const stopped: string[] = [];
  await step("stop", async () => {
    if (!image) return;
    const ids = [
      appContainer(row.id),
      ...companions.filter((c) => !dumped.some((d) => d.role === c.role)).map((c) => appContainer(row.id, c.role)),
    ];
    for (const id of ids) {
      await call(serverId, "container.stop", { id, timeout_seconds: 30 });
      stopped.push(id);
      await ctx.log_("info", `${id} stopped`);
    }
  });

  /** What was swapped, so a failure can put each one back. */
  const swapped: { live: string; previous: string | null; failed: string }[] = [];
  let imported = false;
  const swapBack = async () => {
    for (const entry of [...swapped].reverse()) {
      await call(serverId, "fs.move", { from: entry.live, to: entry.failed, overwrite: true }).catch(() => undefined);
      if (entry.previous) {
        await call(serverId, "fs.move", { from: entry.previous, to: entry.live, overwrite: true });
        await ctx.log_("warn", `${entry.live}: original data moved back`);
      }
    }
  };
  /** Moves live aside (when there is anything there) and the staged copy in. */
  const swapIn = async (live: string, staged: string, rel: string) => {
    const previous = `${staging}/previous/${rel}`;
    const failed = `${staging}/failed/${rel}`;
    for (const dir of [previous, failed]) {
      await call(serverId, "fs.mkdir", { path: dir.slice(0, dir.lastIndexOf("/")), parents: true });
    }
    let had = true;
    try {
      await call(serverId, "fs.move", { from: live, to: previous, overwrite: false });
    } catch (err) {
      if (!agentSaid(err, "not_found")) throw err;
      had = false;
      await call(serverId, "fs.mkdir", { path: live.slice(0, live.lastIndexOf("/")), parents: true });
    }
    swapped.push({ live, previous: had ? previous : null, failed });
    await call(serverId, "fs.move", { from: staged, to: live, overwrite: false });
    await ctx.log_("info", `${live}: restored data swapped in`);
  };

  try {
    /* 5. swap */
    await step("swap", async () => {
      if (image) {
        for (const rel of swapDirs) {
          await swapIn(`${liveRoot}/${rel}`, `${stagedRoot}/${rel}`, rel);
        }
        // The dumps travel to the target install's own backup directory,
        // where app.db_restore looks for them.
        await call(serverId, "fs.mkdir", { path: `${liveRoot}/kaname-backup`, parents: true, mode: "0700" });
        for (const d of dumped) {
          await call(serverId, "fs.move", {
            from: `${stagedRoot}/kaname-backup/${d.role}.dump`,
            to: `${liveRoot}/kaname-backup/${d.role}.dump`,
            overwrite: true,
          });
        }
      } else {
        // A git recipe's whole site root is swapped; the vhost follows it.
        await swapIn(liveRoot, stagedRoot, "site");
      }
    });

    /* 6. import */
    await step("import", async () => {
      imported = true;
      for (const d of dumped) {
        await call(serverId, "app.db_restore", {
          install_id: row.id,
          role: d.role,
          engine: d.engine as "postgres" | "mysql" | "mariadb",
          slot: "backup",
        }, { timeoutMs: 60 * 60 * 1000 });
        await ctx.log_("info", `${d.role}: database re-imported`);
      }
      const site = manifest.paths.dumps.find((d) => d.role === "site");
      const database = manifest.paths.databases[0];
      if (site && database && row.resources.database) {
        const staged = site.path.replace(sourceRoot, liveRoot);
        const handle = ctx.hub.stream(
          serverId,
          "db.restore",
          {
            engine: database.engine as "mysql" | "mariadb" | "postgres",
            name: row.resources.database,
            source: staged,
            drop_existing: true,
          },
          () => undefined,
          { signal: ctx.signal, timeoutMs: 60 * 60 * 1000 },
        );
        await handle.done;
        await ctx.log_("info", `${row.resources.database}: database re-imported`);
        await call(serverId, "fs.remove", { paths: [staged], recursive: false }).catch(() => undefined);
      }
    });
  } catch (err) {
    if (err instanceof AgentOfflineError) throw err;
    await ctx.log_("error", `restore failed: ${message(err)} — putting the original back`);
    try {
      await swapBack();
      if (imported) {
        for (const s of safety) {
          await call(serverId, "app.db_restore", {
            install_id: row.id,
            role: s.role,
            engine: s.engine as "postgres" | "mysql" | "mariadb",
            slot: "pre_restore",
          });
          await ctx.log_("warn", `${s.role}: pre-restore database re-imported`);
        }
      }
    } catch (rollbackErr) {
      await ctx.log_(
        "error",
        `could not put everything back (${message(rollbackErr)}). The original data is under ${staging}/previous.`,
      );
    }
    for (const id of stopped) await call(serverId, "container.start", { id }).catch(() => undefined);
    throw err;
  }

  /* 7. start */
  await step("start", async () => {
    for (const id of [...stopped].reverse()) {
      await call(serverId, "container.start", { id });
      await ctx.log_("info", `${id} started`);
    }
  });

  /* 8. check */
  await step("check", async () => {
    if (image) {
      for (let attempt = 1; ; attempt += 1) {
        const status: MethodResult<"container.app.status"> = await call(serverId, "container.app.status", {
          install_id: row.id,
        });
        const app = status.endpoints.find((e) => e.role === "app");
        if (status.containers.every((c) => c.state === "running") && app?.reachable && (app.http_status ?? 500) < 500) {
          await ctx.log_("info", `${label} answers on 127.0.0.1:${app.host_port} (HTTP ${app.http_status})`);
          return;
        }
        if (attempt >= RESTORE_TIMING.checkAttempts) {
          throw new Error(`${label} was restored but does not answer yet. Check its logs under Containers; the previous data is kept under ${staging}/previous.`);
        }
        await pause(RESTORE_TIMING.checkIntervalMs, ctx.signal);
      }
    }
    if (recipe.source.kind === "git") {
      await call(serverId, "fs.stat", { path: `${liveRoot}/current/${recipe.source.document_root ? `${recipe.source.document_root}/` : ""}${recipe.source.probe}` });
      await ctx.log_("info", `${label}: ${recipe.source.probe} is in place`);
    }
  });

  // The previous data stays until the restore has proved itself; once
  // it has, staging is removed so a restore does not double the disk.
  await call(serverId, "fs.remove", { paths: [staging], recursive: true }).catch((err: unknown) =>
    ctx.log_("warn", `could not remove ${staging}: ${message(err)}`),
  );
  await ctx.db
    .update(appInstalls)
    .set({ updatedAt: new Date() })
    .where(eq(appInstalls.id, row.id));
  ctx.events.publish("backups", "app_restore.succeeded", { install_id: row.id, restore_point_id: p.restore_point_id }, serverId);
  return { install_id: row.id, restored_from: point!.label, app_version: manifest.app_version, mode: p.mode };
}

export function appBackupJobHandlers(): Partial<Record<JobType, JobHandler>> {
  return { "app.restore": appRestore };
}
