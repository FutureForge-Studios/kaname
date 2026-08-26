import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentBinary,
  agentStateRoot,
  apiPort,
  apiUrl,
  artifactsDir,
  databaseUrl,
  fleetSize,
  host,
  ownerEmail,
  ownerPassword,
  repoRoot,
  stackFile,
  webPort,
  webUrl,
} from "./config.js";
import { killTree, launch, run, waitUntil, type Managed } from "./processes.js";

/* ------------------------------------------------------------------ *
 * The whole product, booted from source.
 *
 * The suite is only worth anything if it exercises the real path, so
 * nothing here is stubbed: the database is really reset and seeded, the
 * control plane is the real Fastify process with its real job worker,
 * and the four hosts are four `kanamed --simulate` processes that
 * enroll over the real enrollment API and dial back over the real RPC
 * socket (KD-010). The only thing faked anywhere in the stack is the
 * syscall layer inside the agent.
 *
 * Pids are written to `.artifacts/stack.json` as they are created
 * rather than at the end, so a boot that dies halfway — or a runner
 * that is killed — still leaves teardown something to work with.
 * ------------------------------------------------------------------ */

const CONTROL_PLANE_TIMEOUT_MS = 90_000;
const FLEET_TIMEOUT_MS = 120_000;
const PANEL_TIMEOUT_MS = 120_000;

interface StackFile {
  pids: number[];
}

function record(pid: number): void {
  const pids = readStack().pids;
  if (pids.includes(pid)) return;
  pids.push(pid);
  writeFileSync(stackFile, JSON.stringify({ pids } satisfies StackFile, null, 2));
}

function readStack(): StackFile {
  if (!existsSync(stackFile)) return { pids: [] };
  try {
    const parsed = JSON.parse(readFileSync(stackFile, "utf8")) as Partial<StackFile>;
    return { pids: Array.isArray(parsed.pids) ? parsed.pids : [] };
  } catch {
    return { pids: [] };
  }
}

/** Kills anything a previous run left behind and forgets it. */
export function shutdown(): void {
  for (const pid of readStack().pids) killTree(pid);
  rmSync(stackFile, { force: true });
}

export async function boot(): Promise<void> {
  mkdirSync(artifactsDir, { recursive: true });
  shutdown();

  const started: Managed[] = [];
  const keep = (managed: Managed): Managed => {
    record(managed.pid);
    started.push(managed);
    return managed;
  };

  try {
    await resetDatabase();
    await buildAgent();
    await buildPanel();

    const controlPlane = keep(startControlPlane());
    await waitUntil(`the control plane on ${apiUrl}`, () => healthy(), {
      timeoutMs: CONTROL_PLANE_TIMEOUT_MS,
      detail: () => controlPlane.tail(),
    });

    for (const agent of await startFleet()) keep(agent);
    await waitUntil(`${fleetSize} agents to connect`, () => healthy(fleetSize), {
      timeoutMs: FLEET_TIMEOUT_MS,
      detail: () => started.map((m) => `--- ${m.name} ---\n${m.tail()}`).join("\n"),
    });

    const panel = keep(startPanel());
    await waitUntil(`the panel on ${webUrl}`, () => reachable(`${webUrl}/login`), {
      timeoutMs: PANEL_TIMEOUT_MS,
      detail: () => panel.tail(),
    });
  } catch (err) {
    shutdown();
    throw err;
  }
}

/* --------------------------------- steps -------------------------------- */

/**
 * The same entry point `pnpm db:reset` runs, from the same working
 * directory pnpm gives it, so the suite starts from a genuinely empty
 * database on every run rather than on top of the last one's jobs,
 * restarted units and terminal recordings.
 */
function resetDatabase(): Promise<void> {
  return run("db-reset", process.execPath, ["--import", "tsx", "src/reset.ts"], {
    cwd: join(repoRoot, "packages", "db"),
    env: { DATABASE_URL: databaseUrl, KANAME_ENV: "development" },
  });
}

/**
 * Built once rather than run through `go run`, because `go run` wraps
 * the agent in a parent process that survives being killed and keeps
 * its socket open long after the suite thinks the fleet is gone.
 */
function buildAgent(): Promise<void> {
  return run("agent-build", "go", ["build", "-o", agentBinary, "./cmd/kanamed"], {
    cwd: join(repoRoot, "agent"),
  });
}

function startControlPlane(): Managed {
  return launch("control-plane", process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(repoRoot, "apps", "control-plane"),
    env: {
      KANAME_ENV: "development",
      HOST: host,
      PORT: String(apiPort),
      DATABASE_URL: databaseUrl,
      // Terminal socket URLs are minted against this, so it has to be
      // the origin the browser is actually on.
      KANAME_PUBLIC_URL: webUrl,
      KANAME_BOOTSTRAP_EMAIL: ownerEmail,
      KANAME_BOOTSTRAP_PASSWORD: ownerPassword,
      LOG_LEVEL: "info",
      LOG_PRETTY: "false",
    },
  });
}

/**
 * The panel is built and served, not run through `next dev`. An e2e
 * suite should exercise the bundle that ships, and the development
 * server differs from it in ways that matter here: routes compile on
 * first request, and StrictMode mounts every effect twice — which a
 * single-use terminal ticket (KD-013) cannot survive by design.
 */
function nextCli(...args: string[]): [string, string[]] {
  return [
    process.execPath,
    [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), ...args],
  ];
}

function buildPanel(): Promise<void> {
  const [command, args] = nextCli("build");
  return run("panel-build", command, args, {
    cwd: join(repoRoot, "apps", "web"),
    env: { KANAME_CONTROL_PLANE_URL: apiUrl, KANAME_PUBLIC_URL: webUrl },
  });
}

function startPanel(): Managed {
  const [command, args] = nextCli("start", "--port", String(webPort));
  return launch("panel", command, args, {
    cwd: join(repoRoot, "apps", "web"),
    env: { KANAME_CONTROL_PLANE_URL: apiUrl, KANAME_PUBLIC_URL: webUrl },
  });
}

/**
 * Enrollment goes through the API exactly as an operator's copy-pasted
 * one-liner does: sign in, mint a single-use token bound to the server
 * row, hand it to `kanamed enroll`, and let the agent generate its own
 * keypair. Nothing is inserted into the database behind the panel's back.
 */
async function startFleet(): Promise<Managed[]> {
  // Last run's certificates were signed by a CA that has just been
  // deleted with the database, so the identities have to go too.
  rmSync(agentStateRoot, { recursive: true, force: true });
  mkdirSync(agentStateRoot, { recursive: true });

  const cookie = await signIn();
  const servers = await simulatedServers(cookie);
  if (servers.length !== fleetSize) {
    throw new Error(`expected ${fleetSize} simulated servers in the seed, found ${servers.length}`);
  }

  const agents: Managed[] = [];
  for (const server of servers) {
    const stateDir = join(agentStateRoot, server.name);
    mkdirSync(stateDir, { recursive: true });

    const token = await enrollmentToken(cookie, server.id);
    await run(
      `enroll-${server.name}`,
      agentBinary,
      ["enroll", "--url", apiUrl, "--token", token, "--state-dir", stateDir],
      { cwd: repoRoot },
    );

    agents.push(
      launch(
        `agent-${server.name}`,
        agentBinary,
        ["run", "--simulate", "--state-dir", stateDir, "--log-level", "info"],
        { cwd: repoRoot, env: { KANAME_ENV: "development" } },
      ),
    );
  }
  return agents;
}

/* -------------------------------- probes -------------------------------- */

interface HealthResponse {
  status: string;
  agents_connected: number;
}

async function healthy(agents = 0): Promise<boolean> {
  const res = await fetch(`${apiUrl}/health`);
  if (!res.ok) return false;
  const body = (await res.json()) as HealthResponse;
  return body.status === "ok" && body.agents_connected >= agents;
}

async function reachable(url: string): Promise<boolean> {
  const res = await fetch(url, { redirect: "manual" });
  return res.status < 500;
}

/* ------------------------------ enrollment ------------------------------ */

interface SeedServer {
  id: string;
  name: string;
  simulated: boolean;
}

async function signIn(): Promise<string> {
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  if (!res.ok) {
    throw new Error(
      `could not sign in as ${ownerEmail} (${res.status}). ` +
        "Check KANAME_BOOTSTRAP_EMAIL and KANAME_BOOTSTRAP_PASSWORD in .env.",
    );
  }
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("the control plane accepted the password but set no session cookie");
  return cookie;
}

async function simulatedServers(cookie: string): Promise<SeedServer[]> {
  const res = await fetch(`${apiUrl}/api/v1/servers?per_page=100`, { headers: { cookie } });
  if (!res.ok) throw new Error(`could not list servers (${res.status})`);
  const body = (await res.json()) as { data: SeedServer[] };
  return body.data.filter((server) => server.simulated);
}

async function enrollmentToken(cookie: string, serverId: string): Promise<string> {
  const res = await fetch(`${apiUrl}/api/v1/servers/${serverId}/enroll-token`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`could not mint an enrollment token (${res.status})`);
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}
