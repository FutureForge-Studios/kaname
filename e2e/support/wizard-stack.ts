import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentBinary,
  agentStateRoot,
  apiPort,
  apiUrl,
  artifactsDir,
  databaseUrl,
  host,
  logsDir,
  repoRoot,
  webUrl,
} from "./config.js";
import { launch, run, waitUntil, type Managed } from "./processes.js";
import { buildAgent, buildPanel, healthy, reachable, record, shutdown, startPanel } from "./stack.js";

/* ------------------------------------------------------------------ *
 * A fresh install, for the setup wizard.
 *
 * The default stack is an instance that has been running for weeks: a
 * seeded fleet and an owner bootstrapped from KANAME_BOOTSTRAP_*. The
 * wizard can only be tested on the opposite — an empty database, no
 * account, and the one-time setup token the control plane logs on boot
 * — so this boots that instead, beside (never instead of) the default.
 *
 * It is also an install.sh-shaped instance: KANAME_DEPLOYMENT=compose
 * and a data directory with the host helper's queue, so the address
 * step and Settings → Address can be exercised all the way to the
 * request a real host unit would pick up. Nothing consumes the queue;
 * the spec reads what was written to it.
 *
 * Run it with the wizard ports and database (see wizard.config.ts).
 * ------------------------------------------------------------------ */

const CONTROL_PLANE_TIMEOUT_MS = 90_000;
const PANEL_TIMEOUT_MS = 120_000;

/** Where the instance keeps its `.env` and the host helper's queue. */
export const wizardDataDir = join(artifactsDir, "data");
export const hostQueueFile = join(wizardDataDir, "updates", "queue", "request.json");
export const wizardEnvFile = join(wizardDataDir, ".env");
const tokenFile = join(artifactsDir, "setup-token.txt");

export async function bootFreshInstall(): Promise<void> {
  mkdirSync(artifactsDir, { recursive: true });
  shutdown();

  try {
    wipeDatabase();
    rmSync(wizardDataDir, { recursive: true, force: true });
    mkdirSync(join(wizardDataDir, "updates", "queue"), { recursive: true });
    writeFileSync(wizardEnvFile, `KANAME_PUBLIC_URL=${webUrl}\n`);
    rmSync(agentStateRoot, { recursive: true, force: true });

    await buildAgent();
    await buildPanel();

    const controlPlane = startFreshControlPlane();
    record(controlPlane.pid);
    await waitUntil(`the control plane on ${apiUrl}`, () => healthy(), {
      timeoutMs: CONTROL_PLANE_TIMEOUT_MS,
      detail: () => controlPlane.tail(),
    });

    const token = await waitForSetupToken();
    writeFileSync(tokenFile, token);

    const panel = startPanel();
    record(panel.pid);
    await waitUntil(`the panel on ${webUrl}`, () => reachable(`${webUrl}/login`), {
      timeoutMs: PANEL_TIMEOUT_MS,
      detail: () => panel.tail(),
    });
  } catch (err) {
    shutdown();
    throw err;
  }
}

/**
 * No seed: a real install has no demo fleet. Deleting the PGlite
 * directory is enough — the control plane migrates on boot. Resolved
 * against the workspace root, exactly as @kaname/db resolves it.
 */
function wipeDatabase(): void {
  if (!databaseUrl.startsWith("pglite://")) {
    throw new Error("the wizard stack only knows how to wipe a PGlite database");
  }
  const dir = databaseUrl.replace(/^pglite:\/\//, "");
  rmSync(join(repoRoot, dir), { recursive: true, force: true });
}

function startFreshControlPlane(): Managed {
  return launch("control-plane", process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(repoRoot, "apps", "control-plane"),
    env: {
      KANAME_ENV: "development",
      HOST: host,
      PORT: String(apiPort),
      DATABASE_URL: databaseUrl,
      KANAME_PUBLIC_URL: webUrl,
      // Explicitly empty, not absent: the workspace .env sets both for
      // `pnpm dev:fleet`, and process.loadEnvFile never overrides a
      // variable that is already set. Empty means "no bootstrap owner".
      KANAME_BOOTSTRAP_EMAIL: "",
      KANAME_BOOTSTRAP_PASSWORD: "",
      KANAME_DEPLOYMENT: "compose",
      KANAME_DATA_DIR: wizardDataDir,
      LOG_LEVEL: "info",
      LOG_PRETTY: "false",
    },
  });
}

/** The token is logged, never returned — read it the way an operator would. */
async function waitForSetupToken(): Promise<string> {
  const log = join(logsDir, "control-plane.log");
  let token: string | null = null;
  await waitUntil(
    "the setup token in the control-plane log",
    async () => {
      token = readSetupToken(log);
      return token !== null;
    },
    { timeoutMs: 30_000, detail: () => (existsSync(log) ? readFileSync(log, "utf8").slice(-2000) : "") },
  );
  return token!;
}

function readSetupToken(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  // JSON lines, or pino-pretty (development forces it): `setup_token: "…"`.
  const text = readFileSync(logPath, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
  const matches = [...text.matchAll(/"?setup_token"?\s*:\s*"(kn_setup[^"]+)"/g)];
  return matches.at(-1)?.[1] ?? null;
}

/** The token global setup read from the log, for the specs. */
export function setupToken(): string {
  return readFileSync(tokenFile, "utf8").trim();
}

/* --------------------------- pairing an agent --------------------------- */

/**
 * Enrolls and runs a simulated agent with a pairing token the wizard
 * handed over, exactly as the copied one-liner would on a real host.
 * Its pid is recorded so teardown takes it down with the stack.
 */
export async function pairSimulatedAgent(name: string, token: string): Promise<Managed> {
  const stateDir = join(agentStateRoot, name);
  mkdirSync(stateDir, { recursive: true });
  await run(
    `enroll-${name}`,
    agentBinary,
    ["enroll", "--url", apiUrl, "--token", token, "--state-dir", stateDir],
    { cwd: repoRoot },
  );
  const agent = launch(
    `agent-${name}`,
    agentBinary,
    ["run", "--simulate", "--state-dir", stateDir, "--log-level", "info"],
    { cwd: repoRoot, env: { KANAME_ENV: "development" } },
  );
  record(agent.pid);
  return agent;
}
