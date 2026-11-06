/* ------------------------------------------------------------------ *
 * Once-only secrets for the mail module.
 *
 * Two things in the mail flow are credentials Kaname must carry for a
 * moment but never keep: the relay password an operator types into the
 * deploy form, which has to reach the installer on the host, and what
 * `mail.deploy` hands back (the console setup link and the first
 * mailbox's password), which has to reach the operator. Neither may go
 * through the jobs table: params and results are persisted, backed up
 * and shown in the drawer, and the queue's redaction only runs once a
 * job can no longer be retried.
 *
 * So both live here, in process memory, keyed by what will come asking
 * for them, and each is handed out once. A control-plane restart loses
 * them; that is the point. The deploy log says where to look and how
 * long the window is, and `yunori-mail setup-token` on the host mints a
 * new setup link if the window is missed.
 * ------------------------------------------------------------------ */

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MailSecretStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Stores `value` under `key` until `ttlMs` from now; a second put replaces the first. */
  put(key: string, value: unknown, ttlMs: number): void {
    this.purge();
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  /** Returns and forgets the value, or null when there is none or it expired. */
  take<T>(key: string): T | null {
    this.purge();
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return entry.value as T;
  }

  /** Whether a value is waiting, without spending it. */
  has(key: string): boolean {
    this.purge();
    return this.entries.has(key);
  }

  private purge(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/** How long the deploy hand-off (setup link, first password) waits to be read. */
export const DEPLOY_SECRETS_TTL_MS = 15 * 60_000;
/** How long a relay password waits for the deploy job to claim it. */
export const RELAY_PASSWORD_TTL_MS = 60 * 60_000;

export const deploySecretsKey = (mailServerId: string) => `deploy:${mailServerId}`;
export const relayPasswordKey = (ref: string) => `relay:${ref}`;
