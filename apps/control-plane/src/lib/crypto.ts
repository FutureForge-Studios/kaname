import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/* ------------------------------------------------------------------ *
 * Envelope encryption.
 *
 * Each secret gets its own AES-256-GCM data key (DEK). The DEK is
 * wrapped with a key-encryption key derived from KANAME_MASTER_KEY.
 * Rotating the master key therefore rewraps DEKs without re-encrypting
 * a single ciphertext.
 * ------------------------------------------------------------------ */

export interface SealedSecret {
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
  keyVersion: number;
}

const KEY_VERSION = 1;

export function seal(plaintext: string, masterKey: Buffer): SealedSecret {
  const dek = randomBytes(32);
  const nonce = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", dek, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    wrappedKey: wrapKey(dek, masterKey),
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([body, tag]).toString("base64"),
    keyVersion: KEY_VERSION,
  };
}

export function open(sealed: SealedSecret, masterKey: Buffer): string {
  const dek = unwrapKey(sealed.wrappedKey, masterKey);
  const nonce = Buffer.from(sealed.nonce, "base64");
  const raw = Buffer.from(sealed.ciphertext, "base64");
  const body = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", dek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

function wrapKey(dek: Buffer, masterKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

function unwrapKey(wrapped: string, masterKey: Buffer): Buffer {
  const raw = Buffer.from(wrapped, "base64");
  const nonce = raw.subarray(0, 12);
  const body = raw.subarray(12, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

/** Opaque, URL-safe, 256 bits of entropy. */
export function generateToken(prefix?: string): string {
  const body = randomBytes(32).toString("base64url");
  return prefix ? `${prefix}_${body}` : body;
}

/** Tokens are stored hashed; SHA-256 is right here because the input is high-entropy. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmac(key: Buffer, ...parts: string[]): string {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p).update("\0");
  return h.digest("base64url");
}

/* ------------------------------------------------------------------ *
 * Audit hash chain (KD-009)
 * ------------------------------------------------------------------ */

export const AUDIT_GENESIS = "0".repeat(64);

/**
 * Canonical JSON: keys sorted, no whitespace. Without this the chain
 * would break whenever a field order changed, which would be
 * indistinguishable from tampering.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function auditHash(prevHash: string, payload: unknown): string {
  return createHash("sha256").update(prevHash).update(canonicalize(payload)).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|key|credential|dkim_private|private_key|authorization)/i;

/** Applied to every audit diff, so a secret can never reach the trail. */
export function redact<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v);
  }
  return out as T;
}
