import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "@kaname/db";
import { settings } from "@kaname/db/schema";
import type { AddressSettings } from "@kaname/contract";
import { ApiException } from "../lib/errors.js";
import { setEnv } from "./updates.js";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * Where the panel answers.
 *
 * An install starts on its server's IP over plain HTTP. That is a
 * deliberate trade: asking someone to own a domain and point DNS at a
 * box before they have seen the product is a worse first run than
 * asking afterwards, and the installer has no way to verify a record it
 * cannot see yet.
 *
 * Setting a domain therefore ADDS a site rather than moving one. The
 * host helper regenerates the Caddyfile with both the `:80` IP block
 * and the domain, so the address an operator is currently looking at
 * keeps working while the certificate is provisioned. Nothing here can
 * strand somebody halfway through.
 * ------------------------------------------------------------------ */

export async function readAddress(ctx: AppContext): Promise<AddressSettings> {
  const domain = ctx.config.KANAME_DOMAIN?.trim() || null;

  return {
    domain,
    public_url: await currentPublicUrl(ctx),
    tls: Boolean(domain),
    managed: ctx.updates.hostHelperAvailable(),
  };
}

/**
 * Writes the new address and asks the host to apply it. Returns as soon
 * as the request is queued: applying it recreates the control plane, so
 * this process cannot be the one that reports the outcome.
 */
export async function applyAddress(
  ctx: AppContext,
  domain: string,
  actor: { id: string | null; name: string; ip: string | null },
): Promise<AddressSettings> {
  const next = domain.trim().toLowerCase();

  if (!ctx.updates.hostHelperAvailable()) throw notManaged(ctx.config.dataDir);

  const envFile = join(ctx.config.dataDir, ".env");
  if (!existsSync(envFile)) throw notManaged(ctx.config.dataDir);

  const before = await readAddress(ctx);
  // Remembered before it is overwritten: once a domain is set this
  // process boots with the https URL, so clearing the domain later has
  // nothing else to fall back to.
  const fallback = await rememberIpUrl(ctx, before);
  const publicUrl = next ? `https://${next}` : fallback;

  setEnv(envFile, {
    KANAME_DOMAIN: next,
    KANAME_PUBLIC_URL: publicUrl,
    // "auto" is settled per request: a request over the new name gets a
    // Secure `__Host-` cookie, one over the IP a plain cookie, so both
    // origins keep signing in while the certificate is provisioned. An
    // IP-only install says "false" outright, since nothing could ever
    // arrive over HTTPS.
    KANAME_SECURE_COOKIES: next ? "auto" : "false",
  });

  await writePanelUrl(ctx, publicUrl);

  await ctx.audit.record({
    actor: { type: "user", id: actor.id, name: actor.name, ip: actor.ip },
    action: "settings.address_changed",
    targetType: "settings",
    targetId: null,
    targetLabel: next || "ip",
    before: { domain: before.domain, public_url: before.public_url },
    after: { domain: next || null, public_url: publicUrl },
  });

  await ctx.updates.dispatchHostRequest({
    kind: "reconfigure",
    project: ctx.config.KANAME_COMPOSE_PROJECT,
    data_dir: ctx.config.dataDir,
    log_file: join(ctx.config.dataDir, "logs", "reconfigure.log"),
  });

  ctx.events.publish("updates", "address.changing", { domain: next || null, public_url: publicUrl });

  return { domain: next || null, public_url: publicUrl, tls: Boolean(next), managed: true };
}

/* ------------------------------------------------------------------ */

async function currentPublicUrl(ctx: AppContext): Promise<string> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, "panel")).limit(1);
  const stored = rows[0]?.value as { url?: unknown } | undefined;
  return typeof stored?.url === "string" && stored.url ? stored.url : ctx.config.KANAME_PUBLIC_URL;
}

async function writePanelUrl(ctx: AppContext, url: string): Promise<void> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, "panel")).limit(1);
  const panel = { ...((rows[0]?.value as Record<string, unknown>) ?? {}), url };
  await ctx.db
    .insert(settings)
    .values({ key: "panel", value: panel })
    .onConflictDoUpdate({ target: settings.key, set: { value: panel, updatedAt: new Date() } });
}

/**
 * The plain-HTTP address the installer set up, kept on the panel
 * settings row the first time a domain is configured so that clearing
 * one returns to the IP rather than to `http://<domain>`.
 */
async function rememberIpUrl(ctx: AppContext, current: AddressSettings): Promise<string> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, "panel")).limit(1);
  const panel = (rows[0]?.value as Record<string, unknown>) ?? {};

  const stored = typeof panel.ip_url === "string" ? panel.ip_url : null;
  if (stored) return stored;

  const candidate = current.domain ? ctx.config.KANAME_PUBLIC_URL : current.public_url;
  const ipUrl = candidate.startsWith("http://") ? candidate : candidate.replace(/^https:\/\//, "http://");

  await ctx.db
    .insert(settings)
    .values({ key: "panel", value: { ...panel, ip_url: ipUrl } })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: { ...panel, ip_url: ipUrl }, updatedAt: new Date() },
    });

  return ipUrl;
}

const notManaged = (dataDir: string) =>
  new ApiException("precondition_failed", "This instance does not manage its own address.", {
    remediation: {
      summary:
        `Changing the domain regenerates the reverse proxy's configuration on the host, which needs the helper install.sh puts there. This instance was deployed some other way, so point your proxy at the panel yourself. Expected ${dataDir}/updates/queue to exist.`,
      actions: [],
    },
  });
