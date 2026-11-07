import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  agentBinary,
  agentStateRoot,
  apiUrl,
  logsDir,
  ownerEmail,
  ownerPassword,
  repoRoot,
  stackFile,
  webUrl,
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
 * - act as each system role: a member is invited with the role and
 *   accepts the invitation with their own password, exactly as a person
 *   would, and the session that leaves behind is used for the API and the
 *   browser alike;
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

/** One API call, as the owner unless a member is given. Never throws on status. */
export async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  as?: Member,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  headers["cookie"] = as ? as.cookie : await signInOwner();
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
export async function jobSucceeds(
  page: Page,
  label: string,
  target: string | RegExp,
): Promise<void> {
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
export async function jobFails(
  page: Page,
  label: string,
  target: string | RegExp,
): Promise<Locator> {
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

/** A signed-in member: their session cookie, as `name=value`. */
export interface Member {
  email: string;
  cookie: string;
}

const PASSWORD = "E2e-Files-Strong-Passphrase-42!";

export async function systemRoles(): Promise<RoleRow[]> {
  return data<RoleRow[]>("GET", "/roles?per_page=100");
}

/**
 * Invites a member holding exactly these roles, accepts the invitation
 * the way the invitee would (choosing their own password), and returns
 * the session that acceptance signs them into.
 */
export async function inviteMember(tag: string, roleIds: string[]): Promise<Member> {
  const email = `${unique(`${tag}-`)}@e2e.kaname.local`;
  const invited = await data<{ invite: { url: string } }>("POST", "/users", {
    email,
    name: `E2E ${tag}`,
    role_ids: roleIds,
    send_invite: false,
  });
  const token = decodeURIComponent(invited.invite.url.split("/invite/")[1] ?? "");
  const res = await fetch(`${apiUrl}/api/v1/auth/invite/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password: PASSWORD }),
  });
  if (!res.ok)
    throw new Error(`invite accept for ${email} failed (${res.status}): ${await res.text()}`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error(`accepting ${email}'s invite set no session`);
  return { email, cookie };
}

/** A member holding one system role. */
export async function memberWithRole(slug: RoleSlug, tag: string): Promise<Member> {
  const role = (await systemRoles()).find((r) => r.slug === slug);
  if (!role) throw new Error(`no system role ${slug}`);
  return inviteMember(`${tag}-${slug}`, [role.id]);
}

/** A member holding a custom role made of exactly these permissions, globally. */
export async function memberWithPermissions(tag: string, permissions: string[]): Promise<Member> {
  const role = await data<{ id: string }>("POST", "/roles", {
    name: `E2E ${unique(tag)}`,
    grants: permissions.map((permission) => ({ permission, scope: { kind: "global" } })),
  });
  return inviteMember(tag, [role.id]);
}

/** A browser context signed in as the member. */
export async function contextFor(browser: Browser, member: Member): Promise<BrowserContext> {
  const [name, ...rest] = member.cookie.split("=");
  const url = new URL(webUrl);
  return browser.newContext({
    storageState: {
      cookies: [
        {
          name: name!,
          value: rest.join("="),
          domain: url.hostname,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  });
}

/* ------------------------------- agents ------------------------------ */

function stateDirOf(name: string): string {
  return join(agentStateRoot, name);
}

/** Pids of the `kanamed run` process serving this host in this stack, if any. */
export function agentPids(name: string): number[] {
  const out = spawnSync(
    "pgrep",
    ["-f", `${agentBinary} run --simulate --state-dir ${stateDirOf(name)} `],
    {
      encoding: "utf8",
    },
  );
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

/**
 * The value inside a CopyableCode block, found by the copy button its
 * label names ("Copy Password"). The block carries no ARIA label of its
 * own, but its button does, and the code is that button's sibling.
 */
export function codeBlock(scope: Locator, label: string): Locator {
  return scope
    .getByRole("button", { name: `Copy ${label}`, exact: true })
    .locator("xpath=ancestor::div[code][1]/code");
}

/** Uploads real bytes through POST /files/upload as the owner; returns the HTTP status. */
export async function uploadBytes(
  serverId: string,
  directory: string,
  name: string,
  bytes: Buffer,
): Promise<number> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch(
    `${apiUrl}/api/v1/files/upload?${qs({ server_id: serverId, path: directory, size: bytes.length })}`,
    { method: "POST", headers: { cookie: await signInOwner() }, body: form },
  );
  await res.arrayBuffer();
  return res.status;
}
