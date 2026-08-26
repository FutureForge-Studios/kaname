#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Development fleet.
 *
 * Brings the seeded simulated servers to life by enrolling one
 * `kanamed --simulate` process per server, through the real enrollment
 * API. Nothing here is a shortcut: it logs in as a real user, requests
 * real enrollment tokens, and the agents speak the real protocol. That
 * is the point — the dev loop exercises the same path production does
 * (KD-010).
 *
 *   pnpm dev        # control plane + web
 *   pnpm dev:fleet  # the simulated agents, in a second terminal
 * ------------------------------------------------------------------ */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadDotEnv(join(root, ".env"));

const API = process.env.KANAME_CONTROL_PLANE_URL ?? "http://localhost:4000";
const EMAIL = process.env.KANAME_BOOTSTRAP_EMAIL ?? "owner@kaname.local";
const PASSWORD = process.env.KANAME_BOOTSTRAP_PASSWORD;

if (!PASSWORD) {
  console.error(
    "Set KANAME_BOOTSTRAP_PASSWORD in .env so the dev fleet can sign in.\n" +
      "It is the same password the control plane printed on first boot.",
  );
  process.exit(1);
}

const agentDir = join(root, "agent");
const stateRoot = join(root, ".data", "agents");
mkdirSync(stateRoot, { recursive: true });

const children = [];
let shuttingDown = false;

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

async function main() {
  await waitForControlPlane();

  const cookie = await login();
  const servers = await listSimulatedServers(cookie);

  if (servers.length === 0) {
    console.error("No simulated servers found. Run `pnpm db:seed` first.");
    process.exit(1);
  }

  console.log(`starting ${servers.length} simulated agents\n`);

  for (const server of servers) {
    const stateDir = join(stateRoot, server.name);
    mkdirSync(stateDir, { recursive: true });

    if (!existsSync(join(stateDir, "cert.pem"))) {
      const token = await issueEnrollmentToken(cookie, server.id);
      await run(["run", "./cmd/kanamed", "enroll", "--url", API, "--token", token, "--state-dir", stateDir], server.name);
    }

    const child = spawn(
      "go",
      ["run", "./cmd/kanamed", "run", "--simulate", "--state-dir", stateDir, "--log-level", "info"],
      { cwd: agentDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, KANAME_ENV: "development" } },
    );
    prefix(child, server.name);
    children.push(child);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log("\nstopping simulated agents");
      for (const child of children) child.kill();
      setTimeout(() => process.exit(0), 500);
    });
  }
}

/* ------------------------------------------------------------------ */

async function waitForControlPlane() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (attempt === 0) console.log(`waiting for the control plane at ${API}`);
    await sleep(1000);
  }
  throw new Error(`control plane never became reachable at ${API}. Is \`pnpm dev\` running?`);
}

async function login() {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`login failed for ${EMAIL} (${res.status}). Check KANAME_BOOTSTRAP_* in .env.`);
  }
  const cookie = res.headers.getSetCookie?.()?.[0]?.split(";")[0];
  if (!cookie) throw new Error("login succeeded but no session cookie was returned");
  return cookie;
}

async function listSimulatedServers(cookie) {
  const res = await fetch(`${API}/api/v1/servers?per_page=100`, { headers: { cookie } });
  if (!res.ok) throw new Error(`could not list servers (${res.status})`);
  const body = await res.json();
  return body.data.filter((s) => s.simulated);
}

async function issueEnrollmentToken(cookie, serverId) {
  const res = await fetch(`${API}/api/v1/servers/${serverId}/enroll-token`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`could not issue an enrollment token (${res.status})`);
  const body = await res.json();
  return body.data.token;
}

function run(args, label) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("go", args, { cwd: agentDir, stdio: ["ignore", "pipe", "pipe"] });
    prefix(child, label);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${label}: enrollment exited with ${code}`)),
    );
  });
}

const COLORS = ["\x1b[36m", "\x1b[35m", "\x1b[32m", "\x1b[33m", "\x1b[34m"];
const assigned = new Map();

function prefix(child, label) {
  if (!assigned.has(label)) assigned.set(label, COLORS[assigned.size % COLORS.length]);
  const color = assigned.get(label);
  const tag = `${color}${label.padEnd(10)}\x1b[0m │ `;
  const pipe = (stream, target) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) target.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
