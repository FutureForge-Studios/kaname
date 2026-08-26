import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ *
 * Where the suite runs.
 *
 * Deliberately a different port pair and a different database from
 * `pnpm dev`, because the first rule of an e2e suite on a developer's
 * own machine is that running it must not cost them their dev fleet.
 * Nothing here writes to `.data/kaname` or binds 3000/4000.
 *
 * The workspace .env is loaded for the bootstrap credentials only; the
 * suite passes them explicitly to the control plane it starts, so the
 * two can never disagree about who the owner is.
 * ------------------------------------------------------------------ */

export const e2eDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(e2eDir, "..");

export const artifactsDir = join(e2eDir, ".artifacts");
export const logsDir = join(artifactsDir, "logs");
export const agentStateRoot = join(artifactsDir, "agents");
export const stackFile = join(artifactsDir, "stack.json");
export const authStatePath = join(artifactsDir, "auth.json");
export const agentBinary = join(
  artifactsDir,
  process.platform === "win32" ? "kanamed.exe" : "kanamed",
);

const envFile = join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const apiPort = Number(process.env["KANAME_E2E_API_PORT"] ?? 4100);
export const webPort = Number(process.env["KANAME_E2E_WEB_PORT"] ?? 3100);

/* One host spelling everywhere: the panel origin the browser sees is
 * also the origin the control plane mints terminal socket URLs against,
 * so a ticket is never redeemed cross-origin. */
export const host = "127.0.0.1";
export const apiUrl = `http://${host}:${apiPort}`;
export const webUrl = `http://${host}:${webPort}`;

/** Relative, so @kaname/db resolves it against the workspace root. */
export const databaseUrl = process.env["KANAME_E2E_DATABASE_URL"] ?? "pglite://./.data/e2e";

export const ownerEmail = process.env["KANAME_BOOTSTRAP_EMAIL"] ?? "owner@kaname.local";
export const ownerPassword = process.env["KANAME_BOOTSTRAP_PASSWORD"] ?? "kaname-development-only";

/** The seed's demo fleet, every host of which gets a simulated agent. */
export const fleetSize = 4;

/** A uuid shaped like a real one that no row will ever have. */
export const missingId = "00000000-0000-4000-8000-000000000000";
