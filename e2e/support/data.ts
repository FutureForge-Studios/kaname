import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  agentBinary,
  agentStateRoot,
  apiUrl,
  logsDir,
  ownerEmail,
  ownerPassword,
  repoRoot,
  stackFile,
} from "./config.js";
import { jobStatusPill } from "./ui.js";

/* ------------------------------------------------------------------ *
 * Shared plumbing for the files and databases specs.
 *
 * Three things the browser cannot do for a test on its own:
 *
 * - read the host's state back independently of the page under test
 *   (an owner-session API client), so "the editor said saved" is checked
 *   against the bytes the agent actually holds;
 * - act as each system role. Invited users cannot set a password yet
 *   (there is no invite-acceptance route), so a role is exercised through
 *   an API key minted by the owner with exactly that role's grants — the
 *   control plane evaluates a key's scopes with the same `can()` it uses
 *   for a session, and the panel accepts a bearer key in place of a cookie;
 * - take one simulated agent off the network and bring it back.
 * ------------------------------------------------------------------ */

export interface ApiResult<T = unknown> {
  status: number;
  body: { data?: T; error?: ApiErrorBody } & Record<string, unknown>;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
  remediation?: { summary: string };
}

let ownerCookie: string | null = null;

async function signInOwner(): Promise<string> {
  if (ownerCookie) return ownerCookie;
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  if (!res.ok) throw new Error(`owner sign-in failed (${res.status})`);
  const set = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!set) throw new Error("owner sign-in returned no cookie");
  ownerCookie = set;
  return set;
}

/** One API call, as the owner unless a bearer token is given. Never throws on status. */
export async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  else headers["cookie"] = await signInOwner();
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: ApiResult<T>["body"] = {};
  try {
    parsed = text ? (JSON.parse(text) as ApiResult<T>["body"]) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

export async function data<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call<T>(method, path, body);
  if (res.status >= 300) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body.error)}`);
  }
  return res.body.data as T;
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

/* ------------------------------- jobs -------------------------------- */

interface JobRow {
  id: string;
  status: string;
  error: { code: string; message: string } | null;
}

/** Waits for a job the API handed back to reach a terminal state, and returns it. */
export async function settle(jobId: string, timeoutMs = 60_000): Promise<JobRow> {
  let last: JobRow | null = null;
  await expect
    .poll(
      async () => {
        last = await data<JobRow>("GET", `/jobs/${jobId}`);
        return last.status;
      },
      { timeout: timeoutMs, message: `job ${jobId} never finished` },
    )
    .toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
  return last!;
}

/**
 * The drawer every job mutation opens, and the newest row in it matching
 * the job's label and target. Waits for that row's pill to say Succeeded,
 * then closes the drawer so the page underneath is usable again.
 */
export async function jobSucceeds(page: Page, label: string, target: string | RegExp): Promise<void> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const row = drawer
    .getByRole("listitem")
    .filter({ hasText: label })
    .filter({ hasText: target })
    .first();
  await expect(row).toBeVisible();
  await expect(jobStatusPill(row)).toHaveText(/Succeeded/, { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
}

/** Same, for a job that is meant to fail: returns the error line the drawer shows. */
export async function jobFails(page: Page, label: string, target: string | RegExp): Promise<Locator> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const row = drawer
    .getByRole("listitem")
    .filter({ hasText: label })
    .filter({ hasText: target })
    .first();
  await expect(jobStatusPill(row)).toHaveText(/Failed/, { timeout: 60_000 });
  return row;
}

/* ------------------------------- roles ------------------------------- */

export const ROLE_SLUGS = ["owner", "operator", "developer", "auditor", "viewer"] as const;
export type RoleSlug = (typeof ROLE_SLUGS)[number];

interface RoleRow {
  id: string;
  slug: string;
  grants: { permission: string }[];
}

const roleKeys = new Map<string, string>();

export async function systemRoles(): Promise<RoleRow[]> {
  return data<RoleRow[]>("GET", "/roles?per_page=100");
}

/**
 * Creates (invites) a user holding the role, the way an owner would, and
 * mints an API key carrying exactly that role's permissions. Returns the
 * key's bearer token.
 */
export async function actAs(slug: RoleSlug, tag: string): Promise<string> {
  const cached = roleKeys.get(`${slug}:${tag}`);
  if (cached) return cached;

  const role = (await systemRoles()).find((r) => r.slug === slug);
  if (!role) throw new Error(`no system role ${slug}`);

  const stamp = `${tag}-${slug}-${Date.now().toString(36)}`;
  await data("POST", "/users", {
    email: `${stamp}@e2e.kaname.local`,
    name: `E2E ${slug}`,
    role_ids: [role.id],
    send_invite: false,
  });

  const scopes = [...new Set(role.grants.map((g) => g.permission))];
  const key = await data<{ token: string }>("POST", "/api-keys", {
    name: `e2e ${stamp}`,
    scopes,
    scope_kind: "global",
  });
  roleKeys.set(`${slug}:${tag}`, key.token);
  return key.token;
}

/** A key with an arbitrary set of scopes, for the cases no system role covers. */
export async function keyWith(name: string, scopes: string[]): Promise<string> {
  const key = await data<{ token: string }>("POST", "/api-keys", {
    name: `e2e ${name} ${Date.now().toString(36)}`,
    scopes,
    scope_kind: "global",
  });
  return key.token;
}

/** A browser context with no session cookie that authenticates every request with the key. */
export async function contextFor(browser: Browser, token: string): Promise<BrowserContext> {
  return browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
}

/* ------------------------------- agents ------------------------------ */

function stateDirOf(name: string): string {
  return join(agentStateRoot, name);
}

/** Pids of the `kanamed run` process serving this host in this stack, if any. */
export function agentPids(name: string): number[] {
  const out = spawnSync("pgrep", ["-f", `${agentBinary} run --simulate --state-dir ${stateDirOf(name)} `], {
    encoding: "utf8",
  });
  return out.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function connectionOf(serverId: string): Promise<string> {
  const server = await data<{ connection: string }>("GET", `/servers/${serverId}`);
  return server.connection;
}

/** Takes one simulated host off the network and waits until the panel knows. */
export async function stopAgent(name: string, serverId: string): Promise<void> {
  const pids = agentPids(name);
  expect(pids.length, `no running agent for ${name}`).toBeGreaterThan(0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await expect
    .poll(() => connectionOf(serverId), { timeout: 60_000, message: `${name} never went offline` })
    .not.toBe("connected");
}

/**
 * Brings the host back with the identity it enrolled with. Spawned
 * detached with its output in a file, so it outlives this worker, and
 * recorded in the stack file so global teardown takes it down.
 */
export async function startAgent(name: string, serverId: string): Promise<void> {
  if (agentPids(name).length === 0) {
    mkdirSync(logsDir, { recursive: true });
    const log = openSync(join(logsDir, `agent-${name}-restarted.log`), "a");
    const child = spawn(
      agentBinary,
      ["run", "--simulate", "--state-dir", stateDirOf(name), "--log-level", "info"],
      {
        cwd: repoRoot,
        env: { ...process.env, KANAME_ENV: "development" },
        stdio: ["ignore", log, log],
        detached: true,
      },
    );
    child.unref();
    if (child.pid) {
      const stack = existsSync(stackFile)
        ? (JSON.parse(readFileSync(stackFile, "utf8")) as { pids: number[] })
        : { pids: [] };
      stack.pids.push(child.pid);
      writeFileSync(stackFile, JSON.stringify(stack, null, 2));
    }
  }
  await expect
    .poll(() => connectionOf(serverId), { timeout: 90_000, message: `${name} never came back` })
    .toBe("connected");
}

/* ------------------------------ helpers ------------------------------ */

export function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Bytes that are not valid UTF-8 anywhere, so they can only survive as binary. */
export function binaryBytes(size: number, seed = 7): Buffer {
  const out = Buffer.alloc(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  // Guarantee an invalid UTF-8 sequence near the start.
  if (size > 2) {
    out[0] = 0xff;
    out[1] = 0xfe;
  }
  return out;
}
