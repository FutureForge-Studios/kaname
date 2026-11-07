import { and, eq, gt, isNull, lt, or, sql, type Database } from "@kaname/db";
import { apiKeys, roleGrants, roles, sessions, userRoles, users } from "@kaname/db/schema";
import {
  buildEffectiveGrants,
  can,
  scopeFor,
  type EffectiveGrants,
  type Permission,
  type RoleGrant,
} from "@kaname/contract";
import { constantTimeEquals, generateToken, hashToken, open, seal } from "../lib/crypto.js";
import { ApiException, forbidden, unauthenticated } from "../lib/errors.js";
import type { Config } from "../config.js";

/* ------------------------------------------------------------------ *
 * Authentication and authorisation.
 *
 * One resolver turns a request into a Principal carrying its effective
 * grants; one `authorize` call is the only place a permission decision
 * is made. The UI hides what you cannot do, but that is decoration —
 * this is the check that matters.
 * ------------------------------------------------------------------ */

export interface Principal {
  kind: "user" | "api_key";
  id: string;
  name: string;
  email?: string;
  sessionId?: string;
  apiKeyId?: string;
  grants: EffectiveGrants;
  /** True once TOTP has been satisfied, or when TOTP is not enabled. */
  mfaSatisfied: boolean;
}

/** How often a session or key gets its "last seen" stamp refreshed. */
const RECENCY_WRITE_MS = 60_000;

export class AuthService {
  /**
   * `now` is the clock every expiry and lockout decision here reads.
   * Injectable so tests can walk an API key past its expiry, or a
   * failure out of the lockout window, without waiting for it.
   */
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    readonly now: () => number = Date.now,
  ) {}

  /* --------------------------- passwords --------------------------- */

  async hashPassword(password: string): Promise<string> {
    const { hash } = await import("@node-rs/argon2");
    // OWASP-recommended argon2id parameters for an interactive login.
    return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  }

  async verifyPassword(hashed: string, password: string): Promise<boolean> {
    const { verify } = await import("@node-rs/argon2");
    try {
      return await verify(hashed, password);
    } catch {
      return false;
    }
  }

  /* ---------------------------- sessions --------------------------- */

  async createSession(
    userId: string,
    meta: { ip?: string | null; userAgent?: string | null; mfaSatisfied: boolean },
  ): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
    const token = generateToken("kns");
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3600_000);
    const [row] = await this.db
      .insert(sessions)
      .values({
        userId,
        tokenHash: hashToken(token),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        mfaSatisfiedAt: meta.mfaSatisfied ? new Date() : null,
        expiresAt,
      })
      .returning({ id: sessions.id });
    return { token, expiresAt, sessionId: row!.id };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.filter((r) => r.id !== exceptSessionId).length;
  }

  /* --------------------------- resolution -------------------------- */

  async principalFromSessionToken(token: string): Promise<Principal | null> {
    const rows = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row || row.user.status !== "active") return null;

    // Best-effort recency tracking; a failure here must not block a
    // request, and a page load is dozens of requests, so it is written
    // at most once a minute per session.
    if (Date.now() - row.session.lastSeenAt.getTime() > RECENCY_WRITE_MS) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(sessions.id, row.session.id))
        .catch(() => {
          /* recency is decoration; the request already succeeded */
        });
    }

    return {
      kind: "user",
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      sessionId: row.session.id,
      grants: await this.grantsForUser(row.user.id),
      mfaSatisfied: !row.user.totpEnabled || row.session.mfaSatisfiedAt !== null,
    };
  }

  async principalFromApiKey(bearer: string): Promise<Principal | null> {
    // Format: kn_live_<prefix>_<secret>. The prefix is the lookup key.
    const parts = bearer.split("_");
    if (parts.length < 4) return null;
    const prefix = parts.slice(0, 3).join("_");
    const secret = parts.slice(3).join("_");

    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
      .limit(1);

    const key = rows[0];
    if (!key) return null;
    // Expired at the instant itself, not a millisecond after.
    if (key.expiresAt && key.expiresAt.getTime() <= this.now()) return null;
    if (!constantTimeEquals(key.secretHash, hashToken(secret))) return null;

    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > RECENCY_WRITE_MS) {
      this.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, key.id))
        .catch(() => {
          /* see above */
        });
    }

    /*
     * A key is a delegation of its creator, so it lives and narrows with
     * them. Without this a suspended account's keys kept working (only
     * deletion revoked them), and a creator demoted to Viewer kept every
     * permission they had delegated while they were an Owner — the key
     * became an escalation past the person it traces back to.
     */
    if (!key.createdBy) return null;
    const creator = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, key.createdBy))
      .limit(1);
    if (creator[0]?.status !== "active") return null;
    const held = await this.grantsForUser(key.createdBy);

    // An API key can never carry more than the grants it was issued, nor
    // more than its creator holds today.
    const grants: RoleGrant[] = [];
    for (const permission of key.scopes) {
      const issued: "global" | readonly string[] =
        key.scopeKind === "global" ? "global" : key.scopeServerIds;
      const current = scopeFor(held, permission);
      if (!current) continue;
      const effective =
        issued === "global"
          ? current
          : current === "global"
            ? issued
            : issued.filter((id) => current.includes(id));
      if (effective === "global") {
        grants.push({ permission, scope: { kind: "global" } });
      } else if (effective.length > 0) {
        grants.push({ permission, scope: { kind: "servers", server_ids: [...effective] } });
      }
    }

    return {
      kind: "api_key",
      id: key.id,
      name: key.name,
      apiKeyId: key.id,
      grants: buildEffectiveGrants(grants),
      mfaSatisfied: true,
    };
  }

  async grantsForUser(userId: string): Promise<EffectiveGrants> {
    const rows = await this.db
      .select({ permission: roleGrants.permission, scope: roleGrants.scope })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .innerJoin(roleGrants, eq(roleGrants.roleId, roles.id))
      .where(eq(userRoles.userId, userId));

    return buildEffectiveGrants(rows.map((r) => ({ permission: r.permission, scope: r.scope })));
  }

  /* -------------------------- authorisation ------------------------ */

  /** The single decision point. Throws rather than returning false. */
  authorize(principal: Principal | null, permission: Permission, serverId?: string | null): void {
    if (!principal) throw unauthenticated();
    if (!principal.mfaSatisfied) {
      throw new ApiException("totp_required", "Two-factor authentication is required.");
    }
    if (!can(principal.grants, permission, serverId)) {
      throw forbidden(permission);
    }
  }

  /** Server ids this principal may exercise `permission` on. */
  scope(principal: Principal, permission: Permission): "global" | readonly string[] | null {
    return scopeFor(principal.grants, permission);
  }

  /* ------------------------------ TOTP ----------------------------- */

  async setupTotp(userId: string, email: string, panelName: string) {
    const { Secret, TOTP } = await import("otpauth");
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({ issuer: panelName, label: email, secret, digits: 6, period: 30 });

    const recoveryCodes = Array.from({ length: 10 }, () =>
      generateToken().slice(0, 10).toUpperCase(),
    );
    const sealed = seal(
      JSON.stringify({ secret: secret.base32, recovery: recoveryCodes }),
      this.config.masterKey,
    );

    // Stored but not enabled until a code is verified, so a failed setup
    // cannot lock the operator out.
    await this.db
      .update(users)
      .set({ totpSecretEnc: JSON.stringify(sealed), totpEnabled: false, totpLastStep: null })
      .where(eq(users.id, userId));

    return { secret: secret.base32, otpauthUrl: totp.toString(), recoveryCodes };
  }

  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const rows = await this.db
      .select({ enc: users.totpSecretEnc })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const enc = rows[0]?.enc;
    if (!enc) return false;

    const { secret, recovery } = JSON.parse(open(JSON.parse(enc), this.config.masterKey)) as {
      secret: string;
      recovery: string[];
    };

    const normalized = code.replace(/\s/g, "").toUpperCase();
    if (recovery.includes(normalized)) {
      const remaining = recovery.filter((c) => c !== normalized);
      const resealed = seal(JSON.stringify({ secret, recovery: remaining }), this.config.masterKey);
      await this.db
        .update(users)
        .set({ totpSecretEnc: JSON.stringify(resealed) })
        .where(eq(users.id, userId));
      return true;
    }

    const { Secret, TOTP } = await import("otpauth");
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    // One step of clock skew in each direction.
    const delta = totp.validate({ token: normalized, window: 1 });
    if (delta === null) return false;

    /*
     * A code is good for its whole 30-second step (and one either side),
     * so a code seen over a shoulder or in a log could be replayed. Each
     * step is accepted once: the claim succeeds only if it is newer than
     * the last accepted one, which also settles two concurrent uses.
     */
    const step = Math.floor(Date.now() / 1000 / 30) + delta;
    const claimed = await this.db
      .update(users)
      .set({ totpLastStep: step })
      .where(
        and(
          eq(users.id, userId),
          or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
        ),
      )
      .returning({ id: users.id });
    return claimed.length > 0;
  }

  async enableTotp(userId: string): Promise<void> {
    await this.db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId));
  }

  async disableTotp(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ totpEnabled: false, totpSecretEnc: null })
      .where(eq(users.id, userId));
  }

  /* ----------------------- brute-force guard ----------------------- */

  /*
   * `lockoutMinutes` is Settings > Security > Lockout duration. It used to
   * be a hard-coded 15 minutes, so the setting the panel offers (and saves)
   * changed nothing: an owner who chose two minutes still locked people
   * out for fifteen.
   *
   * `windowMinutes` is the counting window, and it was ignored the same
   * way: failures only ever reset on a successful sign-in, so eight typos
   * spread across a month locked an account as surely as eight guesses
   * in a minute. Each failure's time is now kept, and only those inside
   * the window count. It is a sliding window — the oldest failure ages
   * out on its own — and the list is capped at the threshold, which is
   * all a decision ever needs.
   *
   * One UPDATE, so two concurrent failures cannot both read the old list
   * and lose a count between them.
   */
  async noteFailedLogin(
    userId: string,
    lockoutThreshold: number,
    lockoutMinutes = 15,
    windowMinutes = 15,
  ): Promise<{ failures: number; lockedUntil: Date | null }> {
    const now = new Date(this.now());
    const cutoff = new Date(now.getTime() - windowMinutes * 60_000);
    const lockUntil = new Date(now.getTime() + lockoutMinutes * 60_000);
    const keep = Math.max(1, lockoutThreshold);
    const recent = sql`(array(
      select t from unnest(${users.failedLoginAt} || ${now.toISOString()}::timestamptz) as t
      where t > ${cutoff.toISOString()}::timestamptz order by t desc limit ${keep}))`;

    const [row] = await this.db
      .update(users)
      .set({
        failedLoginAt: recent,
        failedLoginCount: sql`cardinality(${recent})`,
        lockedUntil: sql`case when cardinality(${recent}) >= ${lockoutThreshold}
          then ${lockUntil.toISOString()}::timestamptz else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, userId))
      .returning({ failures: users.failedLoginCount, lockedUntil: users.lockedUntil });
    return { failures: row?.failures ?? 0, lockedUntil: row?.lockedUntil ?? null };
  }

  async clearFailedLogins(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        failedLoginCount: 0,
        failedLoginAt: [],
        lockedUntil: null,
        lastLoginAt: new Date(this.now()),
      })
      .where(eq(users.id, userId));
  }
}
