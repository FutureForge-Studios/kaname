import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  agentBinary,
  agentStateRoot,
  apiUrl,
  host,
  ownerEmail,
  ownerPassword,
  repoRoot,
  stackFile,
} from "./config.js";
import { launch, waitUntil } from "./processes.js";
import { jobStatusPill } from "./ui.js";

/* ------------------------------------------------------------------ *
 * Helpers for the Websites journeys.
 *
 * The API client here does what ./api.ts deliberately does not: it
 * writes. It is used for arrangement only — minting users for the
 * permission journeys, breaking a vhost for the config-test journey,
 * reading a job back to check what the page claimed — never as a
 * substitute for the click the journey is about.
 * ------------------------------------------------------------------ */

export interface ApiResult<T> {
  status: number;
  data: T;
  error: { code: string; message: string; fields?: Record<string, string> } | null;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  label: string;
  blocked_reason: string | null;
  error: { code: string; message: string } | null;
  target_id: string | null;
}

const sessions = new Map<string, string>();

async function signIn(email: string, password: string): Promise<string> {
  const known = sessions.get(email);
  if (known) return known;
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`api sign-in as ${email} failed (${res.status})`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error(`api sign-in as ${email} set no cookie`);
  sessions.set(email, cookie);
  return cookie;
}

/** One request as `cookie` (the owner's when omitted). Never throws on a 4xx. */
export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<ApiResult<T>> {
  const session = cookie ?? (await signIn(ownerEmail, ownerPassword));
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      cookie: session,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as { data?: T; error?: ApiResult<T>["error"] }) : {};
  return { status: res.status, data: json.data as T, error: json.error ?? null };
}

/** The owner's GET, failing loudly — for lookups a journey depends on. */
export async function get<T>(path: string): Promise<T> {
  const res = await api<T>("GET", path);
  if (res.status !== 200) throw new Error(`GET ${path} → ${res.status} ${res.error?.message}`);
  return res.data;
}

const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];

/** Polls a job until it is terminal and returns its final row. */
export async function settledJob(jobId: string, timeoutMs = 60_000): Promise<JobRow> {
  let last: JobRow | null = null;
  await expect
    .poll(
      async () => {
        last = await get<JobRow>(`/jobs/${jobId}`);
        return TERMINAL.includes(last.status);
      },
      { message: `job ${jobId} never settled`, timeout: timeoutMs },
    )
    .toBe(true);
  return last!;
}

/** A name no other run of this suite (or another test in it) will collide with. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
}

/* ------------------------------- people ------------------------------- */

export interface Person {
  email: string;
  password: string;
  cookie: string;
  id: string;
}

interface RoleRow {
  id: string;
  slug: string;
}

export async function roleId(slug: string): Promise<string> {
  const roles = await get<RoleRow[]>("/roles?per_page=200");
  const role = roles.find((r) => r.slug === slug);
  if (!role) throw new Error(`no role ${slug}; have ${roles.map((r) => r.slug).join(", ")}`);
  return role.id;
}

/**
 * Invites a user with `roleIds` and accepts the invitation, exactly as
 * an invitee would — the inviter never chooses another user's password.
 * Returns the session cookie the acceptance opened.
 */
export async function person(label: string, roleIds: string[]): Promise<Person> {
  const email = `${unique(label)}@e2e.kaname.local`;
  const password = "correct-horse-battery-staple-9";
  const invited = await api<{ id: string; invite: { url: string } }>("POST", "/users", {
    email,
    name: `E2E ${label}`,
    role_ids: roleIds,
    send_invite: false,
  });
  if (invited.status !== 201) throw new Error(`invite ${email}: ${invited.error?.message}`);
  const token = invited.data.invite.url.split("/invite/")[1];

  const res = await fetch(`${apiUrl}/api/v1/auth/invite/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password }),
  });
  if (!res.ok) throw new Error(`accept invite for ${email} failed (${res.status})`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error(`accepting ${email}'s invite set no cookie`);
  sessions.set(email, cookie);
  return { email, password, cookie, id: invited.data.id };
}

/** Puts `who`'s session into a fresh browser context, without a UI sign-in. */
export async function signInAs(context: BrowserContext, who: Person): Promise<void> {
  const at = who.cookie.indexOf("=");
  const name = who.cookie.slice(0, at);
  const value = who.cookie.slice(at + 1);
  await context.clearCookies();
  await context.addCookies([{ name, value, domain: host, path: "/", httpOnly: true }]);
}

/* ------------------------------- agents ------------------------------- */

/*
 * The fleet's agents are launched by globalSetup and recorded in
 * stack.json for teardown. Stopping one is what a host going dark looks
 * like to the control plane: the socket closes and nothing else
 * changes. Restarting it reuses the same enrolled identity, so the
 * server reconnects as itself — but its simulated world is rebuilt from
 * the seed, which is why the outage journey only uses edge-01.
 */

function agentPids(server: string): number[] {
  const stateDir = join(agentStateRoot, server);
  try {
    return execFileSync("pgrep", ["-f", `run --simulate --state-dir ${stateDir}( |$)`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

export async function stopAgent(server: string): Promise<void> {
  const pids = agentPids(server);
  if (pids.length === 0) throw new Error(`no running agent for ${server}`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await waitUntil(`the ${server} agent to exit`, async () => agentPids(server).length === 0, {
    timeoutMs: 15_000,
  });
}

export function startAgent(server: string): void {
  if (agentPids(server).length > 0) return;
  const stateDir = join(agentStateRoot, server);
  const agent = launch(
    `agent-${server}-restarted`,
    agentBinary,
    ["run", "--simulate", "--state-dir", stateDir, "--log-level", "info"],
    { cwd: repoRoot, env: { KANAME_ENV: "development" } },
  );
  // Teardown kills whatever stack.json lists; a restarted agent has to be in it.
  const stack = existsSync(stackFile)
    ? (JSON.parse(readFileSync(stackFile, "utf8")) as { pids: number[] })
    : { pids: [] };
  stack.pids.push(agent.pid);
  writeFileSync(stackFile, JSON.stringify(stack, null, 2));
}

export async function connection(serverId: string): Promise<string> {
  return (await get<{ connection: string }>(`/servers/${serverId}`)).connection;
}

/* --------------------------------- UI --------------------------------- */

/** The job drawer's entry for a job, by its label and what it acted on. */
export function drawerJob(page: Page, label: string, target: string): Locator {
  return page
    .getByRole("dialog", { name: "Job activity" })
    .getByRole("listitem")
    .filter({ hasText: label })
    .filter({ hasText: target })
    .first();
}

/** Waits for the pill inside `scope` to reach `status`, failing fast on another terminal one. */
export async function expectJobStatus(
  scope: Locator,
  status: "Succeeded" | "Failed",
  timeout = 60_000,
): Promise<void> {
  const pill = jobStatusPill(scope).first();
  await expect
    .poll(async () => (await pill.innerText().catch(() => "")).trim(), {
      message: `the job never reached ${status}`,
      timeout,
    })
    .toMatch(/^(Succeeded|Failed|Cancelled|Timed out)/);
  await expect(pill).toContainText(status);
}

/** Rows of a DataTable whose text includes `text`. */
export function rowWith(table: Locator, text: string): Locator {
  return table.locator("tbody tr").filter({ hasText: text });
}

/** Chooses an option in one of the panel's comboboxes by typing part of its label. */
export async function choose(page: Page, field: Locator, text: string): Promise<void> {
  await field.click();
  await field.fill(text);
  const option = page
    .getByRole("listbox")
    .getByRole("option", { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    .first();
  await expect(option).toBeVisible();
  await option.click();
}
