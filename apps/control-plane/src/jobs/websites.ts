import { and, eq, inArray } from "@kaname/db";
import { certificates, deployments, domains, sites } from "@kaname/db/schema";
import type { JobType, MethodParams } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import { open, type SealedSecret } from "../lib/crypto.js";
import { applyZone, syncZone, type ZoneApplyInput } from "../services/dns-sync.js";
import type { JobContext, JobHandler } from "./worker.js";

/* ------------------------------------------------------------------ *
 * Websites job handlers: suspend and resume, installing a certificate
 * someone else issued, zone sync and apply, and deployments.
 *
 * Kept beside handlers.ts rather than in it, the way mail.ts is, so
 * the module that owns these rows owns their lifecycle in one place.
 * ------------------------------------------------------------------ */

/** Releases kept on a host per site. Older ones are pruned by the agent. */
export const RELEASES_KEPT = 5;

function requireServer(ctx: JobContext): string {
  if (!ctx.job.serverId) throw new Error(`${ctx.job.type} requires a server`);
  return ctx.job.serverId;
}

function params<T>(ctx: JobContext): T {
  return ctx.job.params as T;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Where a site's releases live. A webroot that already ends in
 * `/current` is served from the release symlink, so its parent is the
 * deploy root; any other webroot is the root itself, the layout the
 * seeded history records (`<webroot>/releases/<id>`).
 */
export function deployRoot(webroot: string): string {
  const trimmed = webroot.replace(/\/+$/, "");
  return trimmed.endsWith("/current") ? trimmed.slice(0, -"/current".length) || "/" : trimmed;
}

/** Sortable by time, so the agent's "keep the newest N" is a name sort. */
export function releaseName(deploymentId: string, at = new Date()): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${deploymentId.slice(0, 8)}`;
}

/* ------------------------------ suspend ----------------------------- */

/**
 * Suspend and resume are `site.update` with `enabled`, then a reload.
 * The agent disables the vhost (or, where the layout has no enable step,
 * renders a 503) and the row moves only once the host has done it. A
 * host that refuses leaves the row in "error" with the reason, the same
 * rule site.create follows; an offline agent is a wait, not a failure.
 */
function siteToggle(enabled: boolean): JobHandler {
  return async (ctx) => {
    const serverId = requireServer(ctx);
    const p = params<{ site_id: string; name: string }>(ctx);
    await ctx.log_("info", `${enabled ? "enabling" : "disabling"} the vhost for ${p.name}`);
    let result: { config_path: string };
    try {
      result = await ctx.hub.call(
        serverId,
        "site.update",
        { name: p.name, enabled },
        { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
      );
      await ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
    } catch (err) {
      if (!(err instanceof AgentOfflineError)) {
        await ctx.db
          .update(sites)
          .set({ status: "error", lastError: message(err), updatedAt: new Date() })
          .where(eq(sites.id, p.site_id));
      }
      throw err;
    }
    await ctx.db
      .update(sites)
      .set({
        status: enabled ? "active" : "suspended",
        configPath: result.config_path,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(sites.id, p.site_id));
    ctx.events.publish(
      "servers",
      enabled ? "site.resumed" : "site.suspended",
      { site_id: p.site_id, server_id: serverId },
      serverId,
    );
    return result;
  };
}

/* ---------------------------- certificates -------------------------- */

interface CertInstallJobParams {
  certificate_id: string;
  domain_id: string;
  subject: string;
  certificate_pem: string;
  /** Sealed with KANAME_MASTER_KEY by the route; redacted once the job ends. */
  key_sealed: SealedSecret;
}

/**
 * The private key reached this job sealed, and is opened only for the
 * one RPC that writes it to the host. It is never logged, and the
 * queue redacts `key_sealed` from the stored params when the job ends.
 */
const certInstall: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<CertInstallJobParams>(ctx);
  try {
    let key: string;
    try {
      key = open(p.key_sealed, ctx.config.masterKey);
    } catch {
      throw new Error(
        "The sealed private key could not be opened: KANAME_MASTER_KEY changed since the certificate was submitted. Submit it again.",
      );
    }
    await ctx.log_("info", `installing the certificate for ${p.subject}`);
    const installed = await ctx.hub.call(
      serverId,
      "cert.install",
      { subject: p.subject, certificate_pem: p.certificate_pem, key_pem: key },
      { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
    );
    await ctx.db
      .update(certificates)
      .set({
        status: "active",
        installedPath: installed.path,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(certificates.id, p.certificate_id));
    await ctx.log_("info", `written to ${installed.path}`);

    // The vhost picks its certificate up when it is rendered, so the site
    // the name answers on is re-rendered and reloaded. A failure here is
    // reported, not fatal: the certificate is installed either way.
    const site = await siteOnHost(ctx, p.domain_id, serverId);
    if (site) {
      try {
        await ctx.hub.call(serverId, "site.update", { name: site.name }, { signal: ctx.signal });
        await ctx.hub.call(serverId, "site.reload", {}, { signal: ctx.signal });
        await ctx.log_("info", `${site.name} re-rendered to serve it`);
      } catch (err) {
        if (err instanceof AgentOfflineError) throw err;
        await ctx.log_("warn", `${site.name} was not re-rendered: ${message(err)}`);
      }
    }
    ctx.events.publish(
      "certificates",
      "certificate.installed",
      { certificate_id: p.certificate_id },
      serverId,
    );
    return installed;
  } catch (err) {
    if (!(err instanceof AgentOfflineError)) {
      await ctx.db
        .update(certificates)
        .set({ status: "failed", lastError: message(err), updatedAt: new Date() })
        .where(eq(certificates.id, p.certificate_id));
    }
    throw err;
  }
};

async function siteOnHost(
  ctx: JobContext,
  domainId: string,
  serverId: string,
): Promise<{ name: string } | null> {
  const rows = await ctx.db
    .select({ name: sites.name })
    .from(domains)
    .innerJoin(sites, eq(domains.siteId, sites.id))
    .where(and(eq(domains.id, domainId), eq(sites.serverId, serverId)))
    .limit(1);
  return rows[0] ?? null;
}

/* -------------------------------- dns ------------------------------- */

async function loadDomain(ctx: JobContext, domainId: string) {
  const rows = await ctx.db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`domain ${domainId} no longer exists`);
  return row;
}

const dnsSync: JobHandler = async (ctx) => {
  const p = params<{ domain_id: string; adopt_unmanaged?: boolean }>(ctx);
  const domain = await loadDomain(ctx, p.domain_id);
  await ctx.log_("info", `reading the ${domain.dnsProvider} zone for ${domain.name}`);
  const summary = await syncZone(ctx, domain, { adoptUnmanaged: p.adopt_unmanaged ?? false });
  await ctx.log_(
    "info",
    `${summary.total} records: ${summary.created} new, ${summary.updated} updated, ${summary.drifted} drifted, ${summary.removed} removed`,
  );
  for (const skipped of summary.unsupported) {
    await ctx.log_("warn", `left untouched: ${skipped.type} ${skipped.name} (type not modelled)`);
  }
  await ctx.audit.record({
    actor: { type: "system", id: null, name: "dns.sync" },
    action: "dns.synced",
    targetType: "domain",
    targetId: domain.id,
    targetLabel: domain.name,
    serverId: domain.serverId,
    jobId: ctx.job.id,
    metadata: {
      provider: summary.provider,
      created: summary.created,
      updated: summary.updated,
      adopted: summary.adopted,
      drifted: summary.drifted,
      removed: summary.removed,
    },
  });
  ctx.events.publish(
    "servers",
    "dns.synced",
    {
      domain_id: domain.id,
      drifted: summary.drifted,
      created: summary.created,
      removed: summary.removed,
    },
    domain.serverId,
  );
  return summary;
};

const dnsApply: JobHandler = async (ctx) => {
  const p = params<{ domain_id: string } & ZoneApplyInput>(ctx);
  const domain = await loadDomain(ctx, p.domain_id);
  await ctx.log_("info", `pushing Kaname's records for ${domain.name} to ${domain.dnsProvider}`);
  const summary = await applyZone(
    ctx,
    domain,
    { records: p.records ?? [], delete_ids: p.delete_ids ?? [], fail_on_drift: p.fail_on_drift },
    (line) => ctx.log_("info", line),
  );
  await ctx.audit.record({
    actor: { type: "system", id: null, name: "dns.apply" },
    action: "dns.applied",
    targetType: "domain",
    targetId: domain.id,
    targetLabel: domain.name,
    serverId: domain.serverId,
    jobId: ctx.job.id,
    metadata: { ...summary },
  });
  ctx.events.publish(
    "servers",
    "dns.applied",
    { domain_id: domain.id, restored: summary.restored },
    domain.serverId,
  );
  return summary;
};

/* ---------------------------- deployments --------------------------- */

interface DeploymentRunParams {
  deployment_id: string;
  site_id: string;
  site_name: string;
  source: "git" | "upload";
  repo_url: string | null;
  branch: string | null;
  commit_sha: string | null;
  webroot: string;
}

/**
 * Writes a real release on the host and switches `current` onto it, then
 * records the path — which is what a later rollback switches back to.
 * It used to mark the row succeeded without the host doing anything and
 * without a path, so only seeded deployments could ever be rolled back.
 */
const deploymentRun: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<DeploymentRunParams>(ctx);
  const started = Date.now();
  await ctx.db
    .update(deployments)
    .set({ status: "building", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(deployments.id, p.deployment_id));
  await ctx.log_("info", "deployment started");
  await ctx.progress(10);

  const root = deployRoot(p.webroot);
  const release = releaseName(p.deployment_id);
  const call: MethodParams<"site.release.create"> = {
    name: p.site_name,
    root,
    release,
    source: p.source,
    ...(p.repo_url ? { repo_url: p.repo_url } : {}),
    ...(p.branch ? { branch: p.branch } : {}),
    ...(p.commit_sha ? { commit_sha: p.commit_sha } : {}),
    // An upload deployment releases what was put in the webroot (or, for
    // a site served from `current`, the `upload` directory beside it).
    ...(p.source === "upload"
      ? { upload_path: root === p.webroot.replace(/\/+$/, "") ? root : `${root}/upload` }
      : {}),
    keep: RELEASES_KEPT,
  };

  let result;
  try {
    result = await ctx.hub.call(serverId, "site.release.create", call, {
      timeoutMs: ctx.job.timeoutMs,
      signal: ctx.signal,
    });
  } catch (err) {
    await finishFailed(ctx, p.deployment_id, started, err);
    throw err;
  }
  for (const line of result.log) await ctx.log_("info", line);
  await ctx.progress(90);

  await ctx.db
    .update(deployments)
    .set({
      status: "succeeded",
      releasePath: result.release_path,
      commitSha: result.commit_sha ?? p.commit_sha,
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      updatedAt: new Date(),
    })
    .where(eq(deployments.id, p.deployment_id));

  // A pruned release is gone from the host, so the rows that pointed at
  // it can no longer be rolled back to; forgetting the path is what makes
  // the rollback route say so instead of failing on the host.
  if (result.pruned.length > 0) {
    await ctx.db
      .update(deployments)
      .set({ releasePath: null, updatedAt: new Date() })
      .where(
        and(eq(deployments.siteId, p.site_id), inArray(deployments.releasePath, result.pruned)),
      );
  }
  if (!p.webroot.replace(/\/+$/, "").startsWith(result.current_path)) {
    await ctx.log_(
      "warn",
      `the vhost serves ${p.webroot}, not ${result.current_path}; point the site's webroot at ${result.current_path} to serve releases`,
    );
  }

  ctx.events.publish(
    "deployments",
    "deployment.finished",
    { deployment_id: p.deployment_id },
    ctx.job.serverId,
  );
  return {
    deployment_id: p.deployment_id,
    release_path: result.release_path,
    commit_sha: result.commit_sha,
  };
};

/*
 * A rollback is itself a deployment row (the route inserts it as
 * "queued"). This handler used to return its params and leave that
 * row queued for ever — and a queued row counts as in flight, so
 * every later deploy or rollback of the site was refused with
 * "already in flight". It owns the row's lifecycle the same way
 * deployment.run does, and now actually switches the symlink.
 */
const deploymentRollback: JobHandler = async (ctx) => {
  const serverId = requireServer(ctx);
  const p = params<{
    deployment_id: string;
    rollback_to_deployment_id: string;
    release_path: string;
    webroot: string;
    site_name: string;
  }>(ctx);
  const started = Date.now();
  await ctx.db
    .update(deployments)
    .set({ status: "deploying", startedAt: new Date(), updatedAt: new Date() })
    .where(eq(deployments.id, p.deployment_id));
  await ctx.log_("info", `rolling back to release ${p.release_path}`);
  await ctx.progress(50);

  let result;
  try {
    result = await ctx.hub.call(
      serverId,
      "site.release.activate",
      { name: p.site_name, root: deployRoot(p.webroot), release_path: p.release_path },
      { timeoutMs: ctx.job.timeoutMs, signal: ctx.signal },
    );
  } catch (err) {
    // The host says the directory is gone, so the target's path is stale:
    // forget it, and the next attempt is told "no longer recorded".
    if (err instanceof AgentRpcError && err.agentError.code === "not_found") {
      await ctx.db
        .update(deployments)
        .set({ releasePath: null, updatedAt: new Date() })
        .where(eq(deployments.id, p.rollback_to_deployment_id));
    }
    await finishFailed(ctx, p.deployment_id, started, err);
    throw err;
  }
  await ctx.log_(
    "info",
    `${result.current_path} -> ${result.release_path}${result.previous ? ` (was ${result.previous})` : ""}`,
  );

  await ctx.db
    .update(deployments)
    .set({
      status: "succeeded",
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      updatedAt: new Date(),
    })
    .where(eq(deployments.id, p.deployment_id));
  ctx.events.publish(
    "deployments",
    "deployment.finished",
    { deployment_id: p.deployment_id },
    ctx.job.serverId,
  );
  return {
    deployment_id: p.deployment_id,
    rollback_to_deployment_id: p.rollback_to_deployment_id,
    release_path: result.release_path,
  };
};

/**
 * A run the host refused ends "failed" with its timing, rather than
 * sitting in building — which counts as in flight and would block every
 * later deploy. An offline agent is a wait: the job is re-queued.
 */
async function finishFailed(
  ctx: JobContext,
  deploymentId: string,
  started: number,
  err: unknown,
): Promise<void> {
  if (err instanceof AgentOfflineError) return;
  await ctx.log_("error", message(err));
  await ctx.db
    .update(deployments)
    .set({
      status: "failed",
      finishedAt: new Date(),
      durationMs: Date.now() - started,
      updatedAt: new Date(),
    })
    .where(eq(deployments.id, deploymentId));
  ctx.events.publish(
    "deployments",
    "deployment.finished",
    { deployment_id: deploymentId },
    ctx.job.serverId,
  );
}

export function websiteJobHandlers(): Partial<Record<JobType, JobHandler>> {
  return {
    "site.suspend": siteToggle(false),
    "site.resume": siteToggle(true),
    "cert.install": certInstall,
    "dns.sync": dnsSync,
    "dns.apply": dnsApply,
    "deployment.run": deploymentRun,
    "deployment.rollback": deploymentRollback,
  };
}
