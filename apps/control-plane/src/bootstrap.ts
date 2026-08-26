import { and, eq, sql } from "@kaname/db";
import { roleGrants, roles, settings, setupTokens, userRoles, users } from "@kaname/db/schema";
import { SYSTEM_ROLES, SYSTEM_ROLE_SLUGS } from "@kaname/contract";
import { generateToken, hashToken } from "./lib/crypto.js";
import { SETUP_TOKEN_TTL_MINUTES } from "./services/setup.js";
import type { AppContext } from "./context.js";

/* ------------------------------------------------------------------ *
 * First-boot bootstrap.
 *
 * Idempotent: reconciles the system roles on every start so a Kaname
 * upgrade that adds a permission grants it to Owner without a manual
 * step.
 *
 * It deliberately does NOT create an owner account on its own. A real
 * install lands in onboarding, where a person chooses the address and
 * the password; an environment file that quietly creates an account
 * with a generated password is a credential nobody rotates. The seeded
 * path exists only when both bootstrap variables are set explicitly,
 * which is how `pnpm dev:fleet` and the test suite skip the wizard.
 * ------------------------------------------------------------------ */

export async function bootstrap(ctx: AppContext): Promise<void> {
  const { db, log, config } = ctx;

  await syncSystemRoles(ctx);
  await seedDefaultSettings(ctx);

  const counted = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  if ((counted[0]?.n ?? 0) > 0) return;

  const email = config.KANAME_BOOTSTRAP_EMAIL;
  const password = config.KANAME_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    await ensureSetupToken(ctx);
    return;
  }

  const [owner] = await db
    .insert(users)
    .values({
      email,
      name: "Owner",
      passwordHash: await ctx.auth.hashPassword(password),
      status: "active",
    })
    .returning({ id: users.id });

  const ownerRole = await db.select().from(roles).where(eq(roles.slug, "owner")).limit(1);
  if (ownerRole[0] && owner) {
    await db.insert(userRoles).values({ userId: owner.id, roleId: ownerRole[0].id });
  }

  await ctx.audit.record({
    actor: { type: "system", id: null, name: "kaname" },
    action: "install.bootstrapped",
    targetType: "user",
    targetId: owner?.id ?? null,
    targetLabel: email,
    metadata: { email },
  });

  log.info({ email }, "seeded the first owner account from KANAME_BOOTSTRAP_*");
}

/* ------------------------------------------------------------------ *
 * The setup token
 *
 * A freshly installed panel is reachable on the network before anyone
 * has an account on it. Without this, whoever finds the port first owns
 * the fleet, so onboarding is gated on a secret that only the person who
 * ran the installer can see: it is printed by install.sh and logged once
 * here. The installer passes its own value through KANAME_SETUP_TOKEN so
 * the two agree; otherwise one is generated.
 * ------------------------------------------------------------------ */

export async function ensureSetupToken(ctx: AppContext): Promise<void> {
  const { db, log, config } = ctx;

  const live = await db
    .select({ id: setupTokens.id })
    .from(setupTokens)
    .where(and(sql`${setupTokens.usedAt} is null`, sql`${setupTokens.expiresAt} > now()`))
    .limit(1);

  if (live.length > 0 && !config.KANAME_SETUP_TOKEN) return;

  const token = config.KANAME_SETUP_TOKEN ?? generateToken("kn_setup");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MINUTES * 60_000);

  await db
    .insert(setupTokens)
    .values({ tokenHash, expiresAt })
    .onConflictDoUpdate({
      target: setupTokens.tokenHash,
      set: { expiresAt, usedAt: null, usedIp: null },
    });

  // Logged, not just returned: on an all-in-one install the operator is
  // reading this journal, and `docker compose logs control-plane` has to
  // be enough to recover the token if the installer output scrolled away.
  log.warn(
    { setup_token: token, expires_at: expiresAt.toISOString() },
    "no owner account exists — open the panel and enter this one-time setup token to begin",
  );
}

async function syncSystemRoles(ctx: AppContext): Promise<void> {
  const { db } = ctx;

  for (const slug of SYSTEM_ROLE_SLUGS) {
    const spec = SYSTEM_ROLES[slug];

    const [role] = await db
      .insert(roles)
      .values({ slug, name: spec.name, description: spec.description, isSystem: true })
      .onConflictDoUpdate({
        target: roles.slug,
        set: {
          name: spec.name,
          description: spec.description,
          isSystem: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: roles.id });

    if (!role) continue;

    // System roles are fully declarative: replace, never merge, so a
    // removed permission actually disappears on upgrade.
    await db.delete(roleGrants).where(eq(roleGrants.roleId, role.id));
    if (spec.permissions.length > 0) {
      await db.insert(roleGrants).values(
        spec.permissions.map((permission) => ({
          roleId: role.id,
          permission,
          scope: { kind: "global" as const },
        })),
      );
    }
  }
}

async function seedDefaultSettings(ctx: AppContext): Promise<void> {
  const defaults: Record<string, unknown> = {
    panel: {
      name: "Kaname",
      url: ctx.config.KANAME_PUBLIC_URL,
      timezone: "UTC",
      date_format: "iso",
    },
    security: {
      session_ttl_hours: ctx.config.SESSION_TTL_HOURS,
      require_totp: false,
      terminal_recording: true,
      failed_login_lockout: 8,
    },
    agents: {
      heartbeat_seconds: ctx.config.AGENT_HEARTBEAT_SECONDS,
      offline_after_seconds: ctx.config.AGENT_OFFLINE_AFTER_SECONDS,
      metrics_retention_days: ctx.config.METRICS_RETENTION_DAYS,
    },
    acme: {
      email: ctx.config.ACME_EMAIL ?? null,
      directory_url: ctx.config.ACME_DIRECTORY_URL,
      staging: false,
    },
    backups: { default_destination_id: null },
  };

  for (const [key, value] of Object.entries(defaults)) {
    await ctx.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoNothing({ target: settings.key });
  }
}
