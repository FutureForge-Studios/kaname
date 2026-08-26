import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "@kaname/db";
import { sessions, users } from "@kaname/db/schema";
import {
  changePasswordInput,
  loginInput,
  totpVerifyInput,
  updateUserPreferencesInput,
  userPreferences,
  type UserStatus,
} from "@kaname/contract";
import { z } from "zod";
import { helpers, item, noContent, parseBody } from "../http/plugin.js";
import { ApiException } from "../lib/errors.js";
import { constantTimeEquals, generateToken, hmac } from "../lib/crypto.js";
import type { AuthService } from "../services/auth.js";
import { loadSettings, serializeUser } from "./admin.js";

/* ------------------------------------------------------------------ *
 * Authentication.
 *
 * These are the only routes reachable without a principal, so they are
 * rate limited hard and every attempt — successful or not — lands in the
 * audit trail. A failed attempt is recorded as a `system` actor with the
 * attempted address in metadata, because there is no principal to blame
 * yet and "which addresses were tried" is exactly what an operator needs
 * after an incident.
 * ------------------------------------------------------------------ */

const LOGIN_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } } as const;

/** How long the second leg of a TOTP login stays valid. */
const CHALLENGE_TTL_MS = 5 * 60_000;

type UserRow = typeof users.$inferSelect;

/**
 * A recovery code is not six digits, so the login leg accepts a wider
 * string than `totpVerifyInput` does. Enabling TOTP still uses the strict
 * contract schema, because a recovery code cannot prove enrolment worked.
 */
const totpChallengeInput = z.object({
  challenge: z.string().min(1).max(1024),
  code: z.string().min(6).max(64),
});

const totpDisableInput = z.object({ password: z.string().min(1).max(256) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ login ----------------------------- */

  app.post("/auth/login", LOGIN_RATE_LIMIT, async (req, reply) => {
    const body = parseBody(req, loginInput);
    const email = body.email.trim().toLowerCase();
    const lockout = (await loadSettings(req.ctx)).security.failed_login_lockout;

    const rows = await req.ctx.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    const user = rows[0];

    // Always spend exactly one argon2 verification, so an unknown address
    // and a wrong password cost the same and cannot be told apart.
    const stored = user?.passwordHash ?? (await decoyHash(req.ctx.auth));
    const correct = await req.ctx.auth.verifyPassword(stored, body.password);

    if (!user || !user.passwordHash || !correct) {
      await recordFailure(req, email, user?.id ?? null, user ? "bad_password" : "unknown_email");
      if (user && lockout.enabled) await req.ctx.auth.noteFailedLogin(user.id, lockout.threshold);
      throw invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await recordFailure(req, email, user.id, "locked");
      throw accountLocked(user.lockedUntil);
    }

    if (user.status !== "active") {
      await recordFailure(req, email, user.id, `status_${user.status}`);
      throw accountNotActive(user.status);
    }

    if (user.totpEnabled && !body.totp_code) {
      await req.ctx.audit.record({
        actor: actorFor(req, user),
        action: "auth.totp_challenged",
        targetType: "user",
        targetId: user.id,
        targetLabel: user.email,
      });
      return item(reply, {
        status: "totp_required",
        challenge: issueChallenge(req, user.id, body.remember),
      });
    }

    if (user.totpEnabled && body.totp_code) {
      if (!(await req.ctx.auth.verifyTotp(user.id, body.totp_code))) {
        await recordFailure(req, email, user.id, "bad_totp");
        if (lockout.enabled) await req.ctx.auth.noteFailedLogin(user.id, lockout.threshold);
        throw invalidTotp();
      }
    }

    return completeLogin(req, reply, user, body.remember);
  });

  /* ------------------- login, second leg (TOTP) --------------------- */

  app.post("/auth/totp", LOGIN_RATE_LIMIT, async (req, reply) => {
    const body = parseBody(req, totpChallengeInput);
    const { userId, remember } = readChallenge(req, body.challenge);

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    // A challenge that no longer matches a TOTP-enabled active account is
    // indistinguishable from a forged one, and is treated as one.
    if (!user || !user.totpEnabled) throw expiredChallenge();
    if (user.status !== "active") throw accountNotActive(user.status);
    if (user.lockedUntil && user.lockedUntil > new Date()) throw accountLocked(user.lockedUntil);

    const lockout = (await loadSettings(req.ctx)).security.failed_login_lockout;
    if (!(await req.ctx.auth.verifyTotp(user.id, body.code))) {
      await recordFailure(req, user.email, user.id, "bad_totp");
      if (lockout.enabled) await req.ctx.auth.noteFailedLogin(user.id, lockout.threshold);
      throw invalidTotp();
    }

    return completeLogin(req, reply, user, remember);
  });

  /* ----------------------------- logout ----------------------------- */

  app.post("/auth/logout", async (req, reply) => {
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user" || !principal.sessionId) throw apiKeyHasNoSession();

    await req.ctx.auth.revokeSession(principal.sessionId);
    clearSessionCookie(req, reply);

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "auth.logout",
      targetType: "session",
      targetId: principal.sessionId,
      targetLabel: principal.email ?? principal.name,
    });
    req.ctx.events.publish("audit", "auth.logout", { user_id: principal.id });

    return noContent(reply);
  });

  /* ---------------------------- session ----------------------------- */

  app.get("/auth/session", async (req, reply) => {
    // Self-scoped: being the principal *is* the authorisation. There is no
    // permission that grants "read my own identity" and inventing one would
    // let a role revoke a user's ability to discover it has no permissions.
    const principal = helpers(req).requirePrincipal();
    const settings = await loadSettings(req.ctx);

    const permissions = [...principal.grants.map.entries()].map(([permission, scope]) => ({
      permission,
      scope:
        scope === "global"
          ? { kind: "global" as const }
          : { kind: "servers" as const, server_ids: [...scope] },
    }));

    if (principal.kind === "api_key") {
      return item(reply, {
        user: null,
        api_key: { id: principal.id, name: principal.name },
        permissions,
        totp_required: false,
      });
    }

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    const user = rows[0];
    if (!user) throw sessionOrphaned();

    return item(reply, {
      user: await serializeUser(req.ctx.db, user),
      api_key: null,
      permissions,
      /** The UI forces enrolment when the install requires TOTP and this user has none. */
      totp_required: settings.security.require_totp && !user.totpEnabled,
      preferences: userPreferences.parse(user.preferences ?? {}),
    });
  });

  /* ------------------------- own preferences ------------------------ */

  /*
   * Self-scoped like the session probe above. These are display
   * choices, not authorisation: a dismissed hint follows the account
   * rather than the browser, so it does not come back on the next
   * machine.
   */
  app.patch("/auth/preferences", async (req, reply) => {
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user") throw apiKeyHasNoSession();
    const body = parseBody(req, updateUserPreferencesInput);

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    const user = rows[0];
    if (!user) throw sessionOrphaned();

    const next = userPreferences.parse({ ...(user.preferences ?? {}), ...body });
    await req.ctx.db
      .update(users)
      .set({ preferences: next, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return item(reply, next);
  });

  /* -------------------------- own password -------------------------- */

  app.post("/auth/password", async (req, reply) => {
    const body = parseBody(req, changePasswordInput);
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user") throw apiKeyHasNoSession();

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    const user = rows[0];
    if (!user || !user.passwordHash) throw sessionOrphaned();

    if (!(await req.ctx.auth.verifyPassword(user.passwordHash, body.current_password))) {
      await recordFailure(req, user.email, user.id, "bad_password_on_change");
      throw wrongCurrentPassword();
    }

    await req.ctx.db
      .update(users)
      .set({
        passwordHash: await req.ctx.auth.hashPassword(body.new_password),
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    // Every session dies, including this one, and the caller is handed a
    // fresh cookie: a copy of the old token taken before the change is now
    // useless, which "revoke all but mine" would not achieve.
    await req.ctx.auth.revokeAllSessions(user.id);
    const created = await req.ctx.auth.createSession(user.id, {
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      mfaSatisfied: true,
    });
    setSessionCookie(req, reply, created.token, created.expiresAt, true);

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "auth.password_changed",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.email,
      metadata: { sessions_revoked: true },
    });
    req.ctx.events.publish("audit", "auth.password_changed", { user_id: user.id });

    return item(reply, { status: "ok", session_expires_at: created.expiresAt.toISOString() });
  });

  /* ------------------------------ TOTP ------------------------------ */

  app.post("/auth/totp/setup", async (req, reply) => {
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user") throw apiKeyHasNoSession();

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    const user = rows[0];
    if (!user) throw sessionOrphaned();
    if (user.totpEnabled) throw totpAlreadyEnabled();

    const settings = await loadSettings(req.ctx);
    const setup = await req.ctx.auth.setupTotp(user.id, user.email, settings.panel.name);

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "auth.totp_setup_started",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.email,
    });

    return item(reply, {
      secret: setup.secret,
      otpauth_url: setup.otpauthUrl,
      recovery_codes: setup.recoveryCodes,
    });
  });

  app.post("/auth/totp/verify", async (req, reply) => {
    const body = parseBody(req, totpVerifyInput);
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user" || !principal.sessionId) throw apiKeyHasNoSession();

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    const user = rows[0];
    if (!user) throw sessionOrphaned();
    if (!user.totpSecretEnc) throw totpNotStarted();

    if (!(await req.ctx.auth.verifyTotp(user.id, body.code))) {
      await recordFailure(req, user.email, user.id, "bad_totp_on_enable");
      throw invalidTotp();
    }

    await req.ctx.auth.enableTotp(user.id);
    // The session that enabled TOTP has satisfied it by definition;
    // without this the caller's next request would demand a code it has
    // no way to supply short of signing in again.
    await req.ctx.db
      .update(sessions)
      .set({ mfaSatisfiedAt: new Date() })
      .where(eq(sessions.id, principal.sessionId));

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "auth.totp_enabled",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.email,
    });
    req.ctx.events.publish("audit", "auth.totp_enabled", { user_id: user.id });

    return item(reply, await serializeUser(req.ctx.db, { ...user, totpEnabled: true }));
  });

  app.post("/auth/totp/disable", async (req, reply) => {
    const body = parseBody(req, totpDisableInput);
    const principal = helpers(req).requirePrincipal();
    if (principal.kind !== "user") throw apiKeyHasNoSession();

    const rows = await req.ctx.db.select().from(users).where(eq(users.id, principal.id)).limit(1);
    const user = rows[0];
    if (!user || !user.passwordHash) throw sessionOrphaned();

    if (!(await req.ctx.auth.verifyPassword(user.passwordHash, body.password))) {
      await recordFailure(req, user.email, user.id, "bad_password_on_totp_disable");
      throw wrongCurrentPassword();
    }

    const settings = await loadSettings(req.ctx);
    if (settings.security.require_totp) throw totpRequiredByPolicy();

    await req.ctx.auth.disableTotp(user.id);

    await req.ctx.audit.record({
      actor: helpers(req).actor(),
      action: "auth.totp_disabled",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.email,
    });
    req.ctx.events.publish("audit", "auth.totp_disabled", { user_id: user.id });

    return item(reply, await serializeUser(req.ctx.db, { ...user, totpEnabled: false }));
  });
}

/* ------------------------------------------------------------------ *
 * Login completion
 * ------------------------------------------------------------------ */

async function completeLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  remember: boolean,
): Promise<FastifyReply> {
  const created = await req.ctx.auth.createSession(user.id, {
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    mfaSatisfied: true,
  });

  await req.ctx.auth.clearFailedLogins(user.id);
  await req.ctx.db
    .update(users)
    .set({ lastLoginIp: req.ip ?? null })
    .where(eq(users.id, user.id));

  setSessionCookie(req, reply, created.token, created.expiresAt, remember);

  await req.ctx.audit.record({
    actor: actorFor(req, user),
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.email,
    metadata: { mfa: user.totpEnabled, remember },
  });
  req.ctx.events.publish("audit", "auth.login", { user_id: user.id });

  const fresh: UserRow = { ...user, lastLoginAt: new Date(), lastLoginIp: req.ip ?? null };
  return item(reply, { status: "ok", user: await serializeUser(req.ctx.db, fresh) });
}

/* ------------------------------------------------------------------ *
 * Cookie
 * ------------------------------------------------------------------ */

export function setSessionCookie(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  remember: boolean,
): void {
  reply.setCookie(req.ctx.config.cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.ctx.config.secureCookies,
    path: "/",
    // Without `remember` the cookie dies with the browser session, while
    // the server-side session keeps its own shorter-lived expiry.
    ...(remember ? { expires: expiresAt } : {}),
  });
}

function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(req.ctx.config.cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.ctx.config.secureCookies,
    path: "/",
  });
}

/* ------------------------------------------------------------------ *
 * TOTP challenge
 *
 * Stateless and signed with the master key, so the half-finished login
 * needs no session row and no cleanup job. It is bound to the client IP
 * and expires in five minutes.
 * ------------------------------------------------------------------ */

function issueChallenge(req: FastifyRequest, userId: string, remember: boolean): string {
  const payload = `${userId}.${Date.now() + CHALLENGE_TTL_MS}.${remember ? 1 : 0}.${generateToken()}`;
  const body = Buffer.from(payload, "utf8").toString("base64url");
  return `${body}.${hmac(req.ctx.config.masterKey, body, req.ip ?? "")}`;
}

function readChallenge(
  req: FastifyRequest,
  challenge: string,
): { userId: string; remember: boolean } {
  const [body, signature] = challenge.split(".");
  if (!body || !signature) throw expiredChallenge();
  if (!constantTimeEquals(signature, hmac(req.ctx.config.masterKey, body, req.ip ?? ""))) {
    throw expiredChallenge();
  }

  const [userId, expiresAt, remember] = Buffer.from(body, "base64url").toString("utf8").split(".");
  if (!userId || !expiresAt || Number(expiresAt) < Date.now()) throw expiredChallenge();
  return { userId, remember: remember === "1" };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

let decoy: Promise<string> | null = null;

/** A real argon2id hash to verify against when the address is unknown. */
function decoyHash(auth: AuthService): Promise<string> {
  decoy ??= auth.hashPassword(generateToken());
  return decoy;
}

function actorFor(req: FastifyRequest, user: UserRow) {
  return {
    type: "user" as const,
    id: user.id,
    name: user.name,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  };
}

async function recordFailure(
  req: FastifyRequest,
  email: string,
  userId: string | null,
  reason: string,
): Promise<void> {
  await req.ctx.audit.record({
    actor: {
      type: "system",
      id: null,
      name: "anonymous",
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    action: "auth.login_failed",
    targetType: "user",
    targetId: userId,
    targetLabel: email,
    metadata: { email, reason },
  });
  req.ctx.events.publish("audit", "auth.login_failed", { reason });
}

/* ------------------------------------------------------------------ *
 * Errors
 *
 * Deliberately vague where being specific would enumerate accounts, and
 * specific everywhere else.
 * ------------------------------------------------------------------ */

const invalidCredentials = () =>
  new ApiException("unauthenticated", "That email and password do not match an account.", {
    remediation: {
      summary:
        "Check the address and try again. Repeated failures lock the account for a while, so slow down rather than retrying in a loop.",
      actions: [],
    },
  });

const invalidTotp = () =>
  new ApiException("unauthenticated", "That authentication code is not valid.", {
    remediation: {
      summary:
        "Codes last 30 seconds — wait for the next one. If your device clock has drifted, resync it, or use one of the recovery codes saved when you enabled two-factor.",
      actions: [],
    },
  });

const expiredChallenge = () =>
  new ApiException("unauthenticated", "This sign-in attempt has expired.", {
    remediation: {
      summary: `A two-factor challenge lasts ${CHALLENGE_TTL_MS / 60_000} minutes and is tied to the network address that started it.`,
      actions: [{ label: "Sign in again", href: "/login" }],
    },
  });

const accountLocked = (until: Date) =>
  new ApiException("rate_limited", "This account is locked after too many failed sign-ins.", {
    detail: { locked_until: until.toISOString() },
    remediation: {
      summary: `The lock lifts at ${until.toISOString()}. An owner can clear it sooner by reactivating the account in Administration.`,
      actions: [{ label: "Administration", href: "/administration/users" }],
    },
  });

const accountNotActive = (status: UserStatus) =>
  status === "invited"
    ? new ApiException("forbidden", "This invitation has not been accepted yet.", {
        remediation: {
          summary:
            "Open the invitation link to set a password, or ask an owner to reissue the invite.",
          actions: [],
        },
      })
    : new ApiException("forbidden", "This account is suspended.", {
        remediation: {
          summary: "An owner can reactivate it from Administration > Users.",
          actions: [{ label: "Administration", href: "/administration/users" }],
        },
      });

const wrongCurrentPassword = () =>
  new ApiException("unauthenticated", "Your current password is not correct.", {
    fields: { current_password: "does not match" },
    remediation: { summary: "Re-enter the password you use to sign in today.", actions: [] },
  });

const totpAlreadyEnabled = () =>
  new ApiException("conflict", "Two-factor authentication is already enabled on this account.", {
    remediation: {
      summary: "Disable it first if you want to enrol a new device — that requires your password.",
      actions: [],
    },
  });

const totpNotStarted = () =>
  new ApiException("precondition_failed", "There is no two-factor enrolment to confirm.", {
    remediation: {
      summary: "Start enrolment first so a secret and recovery codes are generated.",
      actions: [{ label: "Set up two-factor", action: "auth.totp.setup" }],
    },
  });

const totpRequiredByPolicy = () =>
  new ApiException("forbidden", "This install requires two-factor authentication.", {
    remediation: {
      summary:
        "An owner must turn off Security > Require two-factor in Settings before any account can disable it.",
      actions: [{ label: "Settings", href: "/administration/settings" }],
    },
  });

const apiKeyHasNoSession = () =>
  new ApiException("bad_request", "API keys do not hold a browser session.", {
    remediation: {
      summary: "Revoke the key in Administration > API instead of signing it out.",
      actions: [{ label: "API keys", href: "/administration/api" }],
    },
  });

const sessionOrphaned = () =>
  new ApiException("unauthenticated", "The account behind this session no longer exists.", {
    remediation: { summary: "Sign in again.", actions: [{ label: "Sign in", href: "/login" }] },
  });
