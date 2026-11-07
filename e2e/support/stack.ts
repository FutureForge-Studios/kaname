import { copyFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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
  nextDistDir,
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

export function record(pid: number): void {
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

    // The seeded fleet is an instance that has been running for weeks, so
    // its owner has long since finished onboarding. Without this the panel
    // (correctly) sends the owner back into the setup wizard on sign-in.
    await finishOnboarding();

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
  // reset.cli.ts, not reset.ts: the module only exports reset() since the
  // CLI entry moved to its own file, so running it reset nothing.
  return run("db-reset", process.execPath, ["--import", "tsx", "src/reset.cli.ts"], {
    cwd: join(repoRoot, "packages", "db"),
    env: { DATABASE_URL: databaseUrl, KANAME_ENV: "development" },
  });
}

/**
 * Built once rather than run through `cargo run`, because the runner
 * wraps the agent in a parent process that survives being killed and
 * keeps its socket open long after the suite thinks the fleet is gone.
 * `cargo build` leaves the binary in target/; it is copied to the
 * artifacts directory so the rest of the harness has one stable path.
 */
export async function buildAgent(): Promise<void> {
  const agentDir = join(repoRoot, "agent");
  await run("agent-build", "cargo", ["build", "--quiet"], { cwd: agentDir });
  const built = join(
    agentDir,
    "target",
    "debug",
    process.platform === "win32" ? "kanamed.exe" : "kanamed",
  );
  await copyFile(built, agentBinary);
}

export function startControlPlane(): Managed {
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
      // The yunori-mail release feed. The suite cannot reach yunori.email,
      // so the Email specs serve a local one and point the control plane
      // at it; forwarded explicitly so a stray value in .env cannot win.
      ...(process.env["KANAME_YUNORI_FEED"]
        ? { KANAME_YUNORI_FEED: process.env["KANAME_YUNORI_FEED"] }
        : {}),
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

/*
 * A panel build is the heaviest step of a boot, and parallel suites on a
 * small machine all start with one. Two may run at once machine-wide;
 * the rest wait for a slot rather than fight for memory. The slots are
 * directories in the OS temp dir, because mkdir is atomic everywhere.
 */
const PANEL_BUILD_SLOTS = 2;
const PANEL_BUILD_WAIT_MS = 45 * 60_000;

async function withPanelBuildSlot<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + PANEL_BUILD_WAIT_MS;
  for (;;) {
    for (let slot = 0; slot < PANEL_BUILD_SLOTS; slot++) {
      const lock = join(tmpdir(), `kaname-e2e-panel-build-${slot}`);
      try {
        mkdirSync(lock);
      } catch {
        // A slot left behind by a killed run is reclaimed after an hour.
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60 * 60_000)
            rmSync(lock, { recursive: true, force: true });
        } catch {
          /* raced with its owner releasing it */
        }
        continue;
      }
      try {
        return await work();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for a panel build slot");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

export function buildPanel(): Promise<void> {
  /*
   * Opt-in reuse for iterating on specs, which do not change the bundle.
   * Never set it after changing product code: the suite would test the
   * old build.
   */
  if (
    process.env["KANAME_E2E_REUSE_PANEL"] === "1" &&
    existsSync(join(repoRoot, "apps", "web", nextDistDir, "BUILD_ID"))
  ) {
    return Promise.resolve();
  }
  const [command, args] = nextCli("build");
  return withPanelBuildSlot(() =>
    run("panel-build", command, args, {
      cwd: join(repoRoot, "apps", "web"),
      env: {
        KANAME_CONTROL_PLANE_URL: apiUrl,
        KANAME_PUBLIC_URL: webUrl,
        KANAME_NEXT_DIST_DIR: nextDistDir,
        ...panelTsconfigEnv(),
      },
    }).finally(() => {
      normaliseNextEnv();
      tidyTsconfig();
    }),
  );
}

/*
 * A build into a per-stack distDir type-checks against its own gitignored
 * tsconfig, so the generated-types path Next adds lands there and never in
 * the tracked tsconfig.json. The default `.next` build needs nothing.
 */
function panelTsconfigEnv(): Record<string, string> {
  if (nextDistDir === ".next") return {};
  const name = `tsconfig.e2e-${nextDistDir.replace(/^\.next-?/, "").replace(/[^\w-]/g, "_") || "stack"}.json`;
  const config = {
    extends: "./tsconfig.json",
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", `${nextDistDir}/types/**/*.ts`],
    exclude: ["node_modules", ".next", ".next-*"],
  };
  writeFileSync(join(repoRoot, "apps", "web", name), `${JSON.stringify(config, null, 2)}\n`);
  return { KANAME_NEXT_TSCONFIG: name };
}

/*
 * Next also writes the distDir into next-env.d.ts, which is tracked. Put
 * the default path back; the file is otherwise Next's own boilerplate.
 */
function normaliseNextEnv(): void {
  const path = join(repoRoot, "apps", "web", "next-env.d.ts");
  try {
    const text = readFileSync(path, "utf8");
    const fixed = text.replace(/\.\/\.next-[^/]+\/types\//g, "./.next/types/");
    if (fixed !== text) writeFileSync(path, fixed);
  } catch {
    /* never fail a run over tidying a generated file */
  }
}

/*
 * `next build` adds `<distDir>/types/**\/*.ts` to tsconfig.json and
 * reformats it, so a build into a per-stack directory leaves a path to it
 * in a tracked file. Only those per-stack entries are removed; if what is
 * left matches the committed file, its exact text is restored so the
 * reformatting goes too. A plain save-and-restore would let two
 * overlapping builds put back each other's edits.
 */
export function tidyTsconfig(): void {
  const path = join(repoRoot, "apps", "web", "tsconfig.json");
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as { include?: string[] };
    current.include = (current.include ?? []).filter(
      (entry) => !/^\.next-[^/]+\/types\//.test(entry),
    );
    let committed: string | null = null;
    try {
      committed = execFileSync("git", ["show", "HEAD:apps/web/tsconfig.json"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
    } catch {
      /* not a git checkout: fall back to plain JSON below */
    }
    if (committed !== null && sameJson(JSON.parse(committed), current)) {
      writeFileSync(path, committed);
    } else {
      writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
    }
  } catch {
    /* never fail a run over tidying a config file */
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? [...v].map(norm).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, w]) => [k, norm(w)]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export function startPanel(): Managed {
  const [command, args] = nextCli("start", "--port", String(webPort));
  return launch("panel", command, args, {
    cwd: join(repoRoot, "apps", "web"),
    env: {
      KANAME_CONTROL_PLANE_URL: apiUrl,
      KANAME_PUBLIC_URL: webUrl,
      KANAME_NEXT_DIST_DIR: nextDistDir,
      ...panelTsconfigEnv(),
    },
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

/** Ends onboarding through the same call the wizard's last screen makes. */
async function finishOnboarding(): Promise<void> {
  const cookie = await signIn();
  const res = await fetch(`${apiUrl}/api/v1/setup/complete`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  // 409 means setup was already closed, which is the state we want.
  if (!res.ok && res.status !== 409) {
    throw new Error(`could not finish onboarding (${res.status}): ${await res.text()}`);
  }
}

/* -------------------------------- probes -------------------------------- */

interface HealthResponse {
  status: string;
  agents_connected: number;
}

export async function healthy(agents = 0): Promise<boolean> {
  const res = await fetch(`${apiUrl}/health`);
  if (!res.ok) return false;
  const body = (await res.json()) as HealthResponse;
  return body.status === "ok" && body.agents_connected >= agents;
}

export async function reachable(url: string): Promise<boolean> {
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
