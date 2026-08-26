import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Configuration.
 *
 * Parsed once at boot and never read from process.env again. The
 * process refuses to start in production without a master key, because
 * silently generating one would make every stored secret unrecoverable
 * after the next restart.
 * ------------------------------------------------------------------ */

/**
 * Loads .env from the workspace root before parsing, so the process
 * behaves the same whether it was started from the repo root, from
 * apps/control-plane, or by turbo. Real environment variables always
 * win over the file.
 */
export function loadEnvFile(startDir = process.cwd()): string | null {
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(cursor, ".env");
    if (existsSync(candidate) && existsSync(join(cursor, "pnpm-workspace.yaml"))) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

const schema = z.object({
  KANAME_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().default("pglite://./.data/kaname"),
  DATABASE_POOL_MAX: z.coerce.number().int().default(10),

  /** 32 bytes, base64. Wraps every per-row data key. */
  KANAME_MASTER_KEY: z.string().optional(),

  /** Public origin of the panel, used in enrollment commands and cookies. */
  KANAME_PUBLIC_URL: z.string().default("http://localhost:3000"),
  /**
   * Empty while the panel is reachable only by IP. Setting it adds an
   * HTTPS site without taking the IP one away.
   */
  KANAME_DOMAIN: z.string().optional(),
  /** Where agents dial. Usually the same origin behind the reverse proxy. */
  KANAME_AGENT_URL: z.string().optional(),
  /** Where a browser reaches this control plane for WebSockets. */
  KANAME_CLIENT_API_URL: z.string().optional(),

  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .default(24 * 14),
  SESSION_COOKIE_NAME: z.string().default("kaname_session"),
  /** __Host- prefix requires HTTPS; disabled automatically in development. */
  SECURE_COOKIES: z.enum(["true", "false", "auto"]).default("auto"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),

  /** Agent hub tuning. */
  AGENT_HEARTBEAT_SECONDS: z.coerce.number().int().default(15),
  AGENT_OFFLINE_AFTER_SECONDS: z.coerce.number().int().default(60),
  AGENT_CERT_DAYS: z.coerce.number().int().default(90),
  ENROLLMENT_TOKEN_TTL_MINUTES: z.coerce.number().int().default(15),

  /** Job worker. */
  JOB_WORKER_ENABLED: z.coerce.boolean().default(true),
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().default(4),
  JOB_LEASE_SECONDS: z.coerce.number().int().default(60),
  JOB_POLL_MS: z.coerce.number().int().default(750),

  METRICS_RETENTION_DAYS: z.coerce.number().int().default(90),
  RAW_METRICS_RETENTION_HOURS: z.coerce.number().int().default(48),

  ACME_DIRECTORY_URL: z.string().default("https://acme-v02.api.letsencrypt.org/directory"),
  ACME_EMAIL: z.string().optional(),

  /**
   * Seed an owner account on first boot. BOTH must be set: a fresh
   * install with neither lands in onboarding instead, which is where an
   * operator — rather than an environment file — creates the first
   * account. `pnpm dev:fleet` and the test suite set both.
   */
  KANAME_BOOTSTRAP_EMAIL: z.string().optional(),
  KANAME_BOOTSTRAP_PASSWORD: z.string().optional(),

  /** Version of this build. Set by the image; the manifest compares against it. */
  KANAME_VERSION: z.string().default("0.1.0"),

  /**
   * Written by install.sh so the very first request to a freshly
   * installed panel has to present something only the person who ran the
   * installer can see. Generated on boot when absent.
   */
  KANAME_SETUP_TOKEN: z.string().optional(),
  /** True when install.sh also paired an agent on this same host. */
  KANAME_ALL_IN_ONE: z.coerce.boolean().default(false),

  /** Root of the install: secrets, rollback snapshots, logs. */
  KANAME_DATA_DIR: z.string().optional(),
  /**
   * How this instance was deployed. `compose` means install.sh owns the
   * project and self-update can drive it; `unmanaged` means the updater
   * refuses to touch anything and says so.
   */
  KANAME_DEPLOYMENT: z.enum(["compose", "unmanaged"]).optional(),
  KANAME_COMPOSE_PROJECT: z.string().default("kaname"),

  KANAME_UPDATE_MANIFEST_URL: z.string().optional(),
});

/** Where releases are published. One constant, mirrored in install.sh. */
export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/FutureForge-Studios/kaname/main/versions.json";

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  isProduction: boolean;
  isDevelopment: boolean;
  masterKey: Buffer;
  agentUrl: string;
  dataDir: string;
  deployment: "compose" | "unmanaged";
  manifestUrl: string;
  /** Where a BROWSER can reach this control plane. See below. */
  clientApiUrl: string;
  secureCookies: boolean;
  cookieName: string;
}

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const raw = parsed.data;
  const isProduction = raw.KANAME_ENV === "production";

  let masterKey: Buffer;
  if (raw.KANAME_MASTER_KEY) {
    masterKey = Buffer.from(raw.KANAME_MASTER_KEY, "base64");
    if (masterKey.length !== 32) {
      throw new Error("KANAME_MASTER_KEY must decode to exactly 32 bytes of base64.");
    }
  } else if (isProduction) {
    throw new Error(
      "KANAME_MASTER_KEY is required in production. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  } else {
    // Development only: deterministic per-process so a restart does not
    // orphan secrets written earlier in the same session.
    masterKey = deriveDevKey();
  }

  const secureCookies =
    raw.SECURE_COOKIES === "auto" ? isProduction : raw.SECURE_COOKIES === "true";

  cached = {
    ...raw,
    isProduction,
    isDevelopment: raw.KANAME_ENV === "development",
    masterKey,
    // In production agents dial the same origin the panel is served from,
    // because the reverse proxy fronts both. In development the web app
    // may not be running at all, so they talk to the control plane
    // directly rather than through a proxy that is not there.
    agentUrl:
      raw.KANAME_AGENT_URL ??
      (isProduction ? raw.KANAME_PUBLIC_URL : `http://localhost:${raw.PORT}`),
    // The terminal is a WebSocket, and Next's `rewrites` proxy HTTP but
    // NOT upgrade requests — so in development the browser has to dial
    // the control plane directly. In production the reverse proxy fronts
    // both and does forward upgrades, so it is the panel's own origin
    // and KD-011's one-origin story still holds.
    clientApiUrl:
      raw.KANAME_CLIENT_API_URL ??
      (isProduction ? raw.KANAME_PUBLIC_URL : `http://localhost:${raw.PORT}`),
    secureCookies,
    dataDir: raw.KANAME_DATA_DIR ?? (isProduction ? "/etc/kaname" : resolve(".data")),
    deployment: raw.KANAME_DEPLOYMENT ?? (isProduction ? "compose" : "unmanaged"),
    manifestUrl: raw.KANAME_UPDATE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
    // The __Host- prefix is only legal over HTTPS on the root path.
    cookieName: secureCookies ? `__Host-${raw.SESSION_COOKIE_NAME}` : raw.SESSION_COOKIE_NAME,
  };
  return cached;
}

let devKey: Buffer | null = null;
function deriveDevKey(): Buffer {
  devKey ??= Buffer.from(
    "kaname-development-master-key-do-not-use-in-prod".padEnd(32, "!").slice(0, 32),
    "utf8",
  );
  return devKey;
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function resetConfigForTests(): void {
  cached = null;
}
