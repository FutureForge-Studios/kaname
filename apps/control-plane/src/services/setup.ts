import type { FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, sql, type Database } from "@kaname/db";
import { roles, servers, settings, setupTokens, userRoles, users } from "@kaname/db/schema";
import type { SetupHealth, SetupState, SetupStep } from "@kaname/contract";
import { constantTimeEquals, hashToken, hmac } from "../lib/crypto.js";
import { ApiException } from "../lib/errors.js";
import { readCookie, secureCookie } from "../http/plugin.js";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * First-run setup.
 *
 * Two things are true at once on a freshly installed box: nobody has an
 * account yet, and the panel is already answering on the network. Every
 * guard in here exists because of that gap — the setup token proves the
 * caller ran the installer, and the "an owner already exists" check
 * makes the whole flow a one-way door.
 * ------------------------------------------------------------------ */

/**
 * Long enough that an operator can install now and finish after a
 * coffee, short enough that a forgotten instance is not claimable a week
 * later. Once it expires while no owner exists, a restart mints another.
 */
export const SETUP_TOKEN_TTL_MINUTES = 24 * 60;

/**
 * How long the cookie minted by /setup/token stands in for the token.
 * The same as the token's own life: the cookie is worthless without a
 * live token row, so a shorter clock added no safety and signed people
 * out of setup mid-coffee.
 */
const SETUP_COOKIE_TTL_MS = SETUP_TOKEN_TTL_MINUTES * 60_000;
const SETUP_COOKIE_BASE = "kaname_setup";

/* ------------------------------------------------------------------ *
 * Progress
 *
 * Steps that leave no other trace are recorded here so closing the tab
 * resumes where it left off rather than restarting the wizard. The steps
 * that DO leave a trace — an owner row, an instance name, a paired
 * server — are derived from that trace instead, because a progress
 * record that disagreed with reality would send someone back to a screen
 * they had already completed.
 * ------------------------------------------------------------------ */

export interface SetupProgress {
  welcome_ack: boolean;
  /**
   * Recorded explicitly because the name itself cannot say: "Kaname" is
   * both the seeded default and a name somebody may genuinely pick.
   */
  instance_named: boolean;
  server_ack: boolean;
  preferences_done: boolean;
  /** A domain chosen on the preferences step, applied on the last one. */
  pending_domain: string | null;
  completed_at: string | null;
}

const EMPTY_PROGRESS: SetupProgress = {
  welcome_ack: false,
  instance_named: false,
  server_ack: false,
  preferences_done: false,
  pending_domain: null,
  completed_at: null,
};

export async function loadProgress(ctx: AppContext): Promise<SetupProgress> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, "setup")).limit(1);
  const stored = rows[0]?.value;
  if (!stored || typeof stored !== "object") return { ...EMPTY_PROGRESS };
  return { ...EMPTY_PROGRESS, ...(stored as Partial<SetupProgress>) };
}

export async function saveProgress(
  ctx: AppContext,
  patch: Partial<SetupProgress>,
): Promise<SetupProgress> {
  const next = { ...(await loadProgress(ctx)), ...patch };
  await ctx.db
    .insert(settings)
    .values({ key: "setup", value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export async function hasOwner(ctx: AppContext): Promise<boolean> {
  return anyUser(ctx.db);
}

async function anyUser(db: Database): Promise<boolean> {
  const counted = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return (counted[0]?.n ?? 0) > 0;
}

export async function readSetupState(
  ctx: AppContext,
  opts: { authorized: boolean },
): Promise<SetupState> {
  const [progress, owner, counts, instanceName, pendingToken] = await Promise.all([
    loadProgress(ctx),
    hasOwner(ctx),
    countServers(ctx),
    readInstanceName(ctx),
    hasUnusedToken(ctx),
  ]);

  return {
    needs_onboarding: progress.completed_at === null,
    step: deriveStep(progress, owner, instanceName, counts),
    completed_at: progress.completed_at,
    instance_name: instanceName,
    has_owner: owner,
    servers_registered: counts.registered,
    servers_connected: counts.connected,
    authorized: opts.authorized,
    // Required until an owner exists, whether or not one is currently
    // claimable: saying "no token needed" while every step still
    // demanded one hid the form and left nowhere to type it.
    token_required: !owner,
    token_live: !owner && pendingToken,
    pending_domain: progress.pending_domain,
  };
}

/** The first step that is not yet satisfied. */
function deriveStep(
  progress: SetupProgress,
  owner: boolean,
  instanceName: string | null,
  counts: { registered: number; connected: number },
): SetupStep {
  if (progress.completed_at) return "done";
  if (!progress.welcome_ack) return "welcome";
  if (!owner) return "owner";
  // The name alone still counts for instances set up before the flag
  // existed; the flag is what stops "Kaname" looping the step.
  if (!progress.instance_named && !instanceName) return "instance";
  if (!progress.server_ack || counts.registered === 0) return "server";
  if (!progress.preferences_done) return "preferences";
  return "done";
}

async function countServers(ctx: AppContext): Promise<{ registered: number; connected: number }> {
  const rows = await ctx.db.select({ id: servers.id }).from(servers);
  const connected = rows.filter((row) => ctx.hub.isConnected(row.id)).length;
  return { registered: rows.length, connected };
}

export async function readInstanceName(ctx: AppContext): Promise<string | null> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, "panel")).limit(1);
  const stored = rows[0]?.value as { name?: unknown } | undefined;
  const name = typeof stored?.name === "string" ? stored.name.trim() : "";
  // "Kaname" is the seeded default, which is not an answer to "name this
  // instance" — treating it as one would skip the step for everybody.
  return name && name !== "Kaname" ? name : null;
}

/* ------------------------------------------------------------------ *
 * Health
 *
 * Shared with the updater: "is this instance actually working" has to
 * mean the same thing when onboarding asks it and when a release is
 * verified after a restart (spec 3.3 step 7).
 * ------------------------------------------------------------------ */

export async function readSetupHealth(ctx: AppContext): Promise<SetupHealth> {
  const connectedIds = new Set(ctx.hub.connectedServerIds());
  const rows = await ctx.db.select().from(servers).orderBy(desc(servers.enrolledAt)).limit(20);

  const candidate = rows.find((row) => connectedIds.has(row.id)) ?? rows[0] ?? null;

  const controlPlane = {
    status: "healthy" as const,
    version: ctx.config.KANAME_VERSION,
    database: ctx.dbHandle.driver,
    detail:
      ctx.dbHandle.driver === "pglite"
        ? "Answering on this origin, storing to an embedded Postgres."
        : "Answering on this origin, connected to Postgres.",
  };

  if (!candidate) {
    const expected = ctx.config.KANAME_ALL_IN_ONE;
    return {
      control_plane: controlPlane,
      agent: {
        status: expected ? "unreachable" : "unknown",
        server_id: null,
        server_name: null,
        hostname: null,
        version: null,
        detail: expected
          ? "The installer paired an agent on this host, but it has never connected."
          : "No agent has enrolled yet.",
        remediation: expected
          ? "On this host: systemctl status kanamed, then journalctl -u kanamed -n 100."
          : null,
      },
      all_in_one: expected,
    };
  }

  const isConnected = connectedIds.has(candidate.id);
  return {
    control_plane: controlPlane,
    agent: {
      status: isConnected ? "healthy" : "unreachable",
      server_id: candidate.id,
      server_name: candidate.name,
      hostname: candidate.hostname,
      version: candidate.agentVersion,
      detail: isConnected
        ? `Connected from ${candidate.hostname}, serving ${candidate.capabilities.length} capabilities.`
        : `Enrolled, but not connected. Last seen ${candidate.lastSeenAt?.toISOString() ?? "never"}.`,
      remediation: isConnected
        ? null
        : `The agent dials out, so nothing needs opening inbound. On ${candidate.hostname}: systemctl status kanamed, then journalctl -u kanamed -n 100.`,
    },
    all_in_one: ctx.config.KANAME_ALL_IN_ONE,
  };
}

/* ------------------------------------------------------------------ *
 * The setup token
 * ------------------------------------------------------------------ */

export async function hasUnusedToken(ctx: AppContext): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: setupTokens.id })
    .from(setupTokens)
    .where(and(sql`${setupTokens.usedAt} is null`, sql`${setupTokens.expiresAt} > now()`))
    .limit(1);
  return rows.length > 0;
}

/** Resolves a presented token to its stored hash, or throws. */
export async function claimSetupToken(
  ctx: AppContext,
  token: string,
  ip: string | null,
): Promise<string> {
  const tokenHash = hashToken(token);
  const rows = await ctx.db
    .select()
    .from(setupTokens)
    .where(eq(setupTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row || row.usedAt) throw badSetupToken();
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) throw expiredSetupToken();

  // Not burned here. The token stands in for "I am the person who ran
  // the installer" until an owner exists, and retiring it on the first
  // screen would strand anyone whose browser reloads before then.
  await ctx.db
    .update(setupTokens)
    .set({ usedIp: ip ?? undefined })
    .where(eq(setupTokens.id, row.id));

  return tokenHash;
}

/** Called once the owner account exists: the token has done its job. */
export async function retireSetupTokens(db: Database, ip: string | null): Promise<void> {
  await db
    .update(setupTokens)
    .set({ usedAt: new Date(), usedIp: ip ?? undefined })
    .where(sql`${setupTokens.usedAt} is null`);
}

/* ------------------------------------------------------------------ *
 * The owner account
 * ------------------------------------------------------------------ */

/** Arbitrary and fixed: every control plane on this database takes the same lock. */
const OWNER_LOCK_KEY = 7_248_017;

/**
 * The one-way door itself. The "nobody exists yet" check and the insert
 * happen under one lock in one transaction, because two tabs submitting
 * together — or two people who both saw the token — would otherwise
 * both pass the check and both get an Owner. The password is hashed by
 * the caller first; holding the lock across argon2 would be a way to
 * stall every other request for nothing.
 */
export async function createOwner(
  ctx: AppContext,
  input: { email: string; name: string; passwordHash: string },
  ip: string | null,
): Promise<{ id: string; name: string; email: string }> {
  try {
    return await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(OWNER_LOCK_KEY))})`);
      if (await anyUser(tx)) throw setupAlreadyClaimed();

      const [owner] = await tx
        .insert(users)
        .values({ ...input, status: "active" })
        .returning({ id: users.id, name: users.name, email: users.email });
      if (!owner) throw new Error("failed to create the owner account");

      const ownerRole = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.slug, "owner"))
        .limit(1);
      if (!ownerRole[0]) throw new Error("the owner role is missing; bootstrap did not run");
      await tx.insert(userRoles).values({ userId: owner.id, roleId: ownerRole[0].id });

      // The token existed to prove the caller ran the installer. There
      // is now an account, so it is spent whether or not it was used
      // again — and spent in the same transaction, so a rolled-back
      // account does not leave a dead token behind.
      await retireSetupTokens(tx, ip);
      return owner;
    });
  } catch (err) {
    // An insert that reached the unique index anyway is the same story
    // as a failed re-check: somebody else got there first.
    if (isUniqueViolation(err)) throw setupAlreadyClaimed();
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  for (let cursor = err; cursor && typeof cursor === "object"; cursor = (cursor as Error).cause) {
    if ((cursor as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

async function tokenHashIsLive(ctx: AppContext, tokenHash: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: setupTokens.id })
    .from(setupTokens)
    .where(
      and(
        eq(setupTokens.tokenHash, tokenHash),
        sql`${setupTokens.usedAt} is null`,
        sql`${setupTokens.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * The setup cookie
 *
 * Signed with the master key and carrying only the token's hash, so it
 * is worth nothing without a row in setup_tokens that is still live. It
 * exists so screens two and three do not have to keep the raw token in
 * the browser's memory.
 * ------------------------------------------------------------------ */

/** Per request, like the session cookie: `__Host-` is only legal over HTTPS. */
export function setupCookieName(req: FastifyRequest): string {
  return secureCookie(req) ? `__Host-${SETUP_COOKIE_BASE}` : SETUP_COOKIE_BASE;
}

export function issueSetupCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  tokenHash: string,
): void {
  const expiresAt = Date.now() + SETUP_COOKIE_TTL_MS;
  const body = Buffer.from(`${tokenHash}.${expiresAt}`, "utf8").toString("base64url");
  reply.setCookie(setupCookieName(req), `${body}.${hmac(req.ctx.config.masterKey, body)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
    // Persisted, not a session cookie: "finish after a coffee" includes
    // closing the browser in between.
    expires: new Date(expiresAt),
  });
}

export function clearSetupCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(setupCookieName(req), {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/",
  });
}

/** The token hash the cookie carries, if its signature and expiry hold. */
export function readSetupCookie(req: FastifyRequest): string | null {
  const raw = readCookie(req, SETUP_COOKIE_BASE);
  if (!raw) return null;

  const [body, signature] = raw.split(".");
  if (!body || !signature) return null;
  if (!constantTimeEquals(signature, hmac(req.ctx.config.masterKey, body))) return null;

  const [tokenHash, expiresAt] = Buffer.from(body, "base64url").toString("utf8").split(".");
  if (!tokenHash || !expiresAt || Number(expiresAt) < Date.now()) return null;
  return tokenHash;
}

/* ------------------------------------------------------------------ *
 * Authorisation
 * ------------------------------------------------------------------ */

/**
 * True when this request may act on setup at all. Before an owner
 * exists that means a live setup token; afterwards it means a signed-in
 * user, because the remaining steps are ordinary authenticated work.
 */
export async function isSetupAuthorized(req: FastifyRequest): Promise<boolean> {
  return (await setupAuthorization(req)) !== null;
}

type SetupAuthorization =
  { via: "session" } | { via: "header" } | { via: "cookie"; tokenHash: string };

/** How this request is allowed to act on setup, or null. */
async function setupAuthorization(req: FastifyRequest): Promise<SetupAuthorization | null> {
  if (req.principal) return { via: "session" };

  // The installer is not a browser and has no cookie jar, so it presents
  // the token it generated on every call instead.
  const header = req.headers["x-kaname-setup-token"];
  if (typeof header === "string" && header.length > 0) {
    return (await tokenHashIsLive(req.ctx, hashToken(header.trim()))) ? { via: "header" } : null;
  }

  const tokenHash = readSetupCookie(req);
  if (!tokenHash) return null;
  return (await tokenHashIsLive(req.ctx, tokenHash)) ? { via: "cookie", tokenHash } : null;
}

/**
 * Guards every /setup mutation. Order matters: "already finished" is
 * answered before authorisation, so a completed instance says the same
 * thing to everyone and a stale token learns nothing from asking.
 */
export async function requireSetupOpen(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const progress = await loadProgress(req.ctx);
  if (progress.completed_at) throw setupAlreadyComplete();

  const authorization = await setupAuthorization(req);
  if (!authorization) throw setupTokenRequired();
  // The cookie's clock restarts on every use, so a tab left open on one
  // screen is not signed out of setup while the token behind it lives.
  if (authorization.via === "cookie") issueSetupCookie(req, reply, authorization.tokenHash);
}

/** Additionally forbids the step once an owner exists. */
export async function requireNoOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireSetupOpen(req, reply);
  if (await hasOwner(req.ctx)) throw setupAlreadyClaimed();
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

const badSetupToken = () =>
  new ApiException("unauthenticated", "That setup token is not valid.", {
    fields: { token: "does not match" },
    remediation: {
      summary:
        "The installer printed it at the end of its run. It is also in the control plane's own log: docker compose -p kaname logs control-plane | grep setup_token",
      actions: [],
    },
  });

const expiredSetupToken = () =>
  new ApiException("unauthenticated", "That setup token has expired.", {
    fields: { token: "expired" },
    remediation: {
      summary:
        "Restart the control plane to mint a new one — it is printed on every boot while no account exists: docker compose -p kaname restart control-plane",
      actions: [],
    },
  });

const setupTokenRequired = () =>
  new ApiException("unauthenticated", "Setup needs the one-time token from the installer.", {
    remediation: {
      summary:
        "This panel answers on the network before anyone has an account on it, so the first screen asks for the token the installer printed. Without it, the first stranger to find the port would own the fleet.",
      actions: [],
    },
  });

const setupAlreadyComplete = () =>
  new ApiException("conflict", "This instance has already been set up.", {
    remediation: {
      summary: "Sign in instead. Onboarding runs exactly once.",
      actions: [{ label: "Sign in", href: "/login" }],
    },
  });

const setupAlreadyClaimed = () =>
  new ApiException("conflict", "An account already exists on this instance.", {
    remediation: {
      summary:
        "The first account was created earlier. Sign in with it, or reinstall if you have lost access to it.",
      actions: [{ label: "Sign in", href: "/login" }],
    },
  });
