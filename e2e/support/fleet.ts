import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  agentBinary,
  agentStateRoot,
  artifactsDir,
  authStatePath,
  repoRoot,
  stackFile,
  webUrl,
} from "./config.js";
import { launch, run, type Managed } from "./processes.js";

/* ------------------------------------------------------------------ *
 * Fleet-area helpers: the owner's API, users per role, the simulated
 * agents as processes, and the job a click produced.
 *
 * Every API call here goes through the panel origin with a real
 * session cookie, exactly as the browser's own calls do, so a test that
 * sets something up through the API is exercising the same rewrite,
 * the same cookie and the same permission check as the page it then
 * opens. Nothing here reaches into the database.
 * ------------------------------------------------------------------ */

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
  error?: { code: string; message: string; fields?: Record<string, string> };
}

let ownerContext: APIRequestContext | null = null;

/** The owner's session from the sign-in journey, as an API client. */
export async function ownerApi(): Promise<APIRequestContext> {
  ownerContext ??= await playwrightRequest.newContext({
    baseURL: webUrl,
    storageState: authStatePath,
  });
  return ownerContext;
}

export async function call<T = unknown>(
  ctx: APIRequestContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await ctx.fetch(`/api/v1${path}`, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as { data?: T; error?: ApiResult["error"] }) : {};
  return { status: response.status(), data: parsed.data as T, error: parsed.error };
}

/** Owner-scoped call that must succeed; anything else fails the test loudly. */
export async function ownerCall<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await call<T>(await ownerApi(), method, path, body);
  expect(
    result.status,
    `${method} ${path} -> ${result.status} ${JSON.stringify(result.error)}`,
  ).toBeLessThan(300);
  return result.data;
}

/* ------------------------------- fleet ------------------------------- */

export interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  connection: string;
  health: string;
  simulated: boolean;
}

export interface ServiceRow {
  id: string;
  server_id: string;
  server_name: string;
  unit: string;
  active_state: string;
  sub_state: string;
  enabled: boolean;
  main_pid: number | null;
}

export interface ContainerRow {
  id: string;
  server_id: string;
  server_name: string;
  /** The runtime's id; a container's hostname is its first 12 characters. */
  container_id: string;
  name: string;
  state: string;
  restart_count: number;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  label: string;
  attempt: number;
  max_attempts: number;
  blocked_reason: string | null;
  error: { code: string; message: string } | null;
  server_name: string | null;
}

export async function server(name: string): Promise<ServerRow> {
  const rows = await ownerCall<ServerRow[]>("GET", "/servers?per_page=100");
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`no server named ${name}`);
  return found;
}

export async function service(serverName: string, unit: string): Promise<ServiceRow> {
  const host = await server(serverName);
  const rows = await ownerCall<ServiceRow[]>(
    "GET",
    `/services?server_id=${host.id}&q=${encodeURIComponent(unit)}&per_page=50`,
  );
  const found = rows.find((row) => row.unit === unit);
  if (!found) throw new Error(`no ${unit} cached on ${serverName}`);
  return found;
}

export async function container(serverName: string, name: string): Promise<ContainerRow> {
  const host = await server(serverName);
  const rows = await ownerCall<ContainerRow[]>(
    "GET",
    `/containers?server_id=${host.id}&q=${encodeURIComponent(name)}&per_page=50`,
  );
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`no container ${name} cached on ${serverName}`);
  return found;
}

export async function job(id: string): Promise<JobRow> {
  return ownerCall<JobRow>("GET", `/jobs/${id}`);
}

/** Polls a job until it is terminal, and returns what it ended as. */
export async function settledJob(id: string, timeout = 60_000): Promise<JobRow> {
  let last: JobRow | null = null;
  await expect
    .poll(
      async () => {
        last = await job(id);
        return ["succeeded", "failed", "cancelled", "timed_out"].includes(last.status);
      },
      { message: `job ${id} never settled`, timeout },
    )
    .toBe(true);
  return last!;
}

/** Runs a service verb through the API and waits for its job to land. */
export async function serviceVerb(
  serverName: string,
  unit: string,
  action: string,
): Promise<JobRow> {
  const row = await service(serverName, unit);
  const { job: queued } = await ownerCall<{ job: JobRow }>(
    "POST",
    `/services/${row.id}/${action}`,
    {},
  );
  return settledJob(queued.id);
}

/* ------------------------------- users ------------------------------- */

interface RoleRow {
  id: string;
  slug: string;
}

export async function roleId(slug: string): Promise<string> {
  const roles = await ownerCall<RoleRow[]>("GET", "/roles?per_page=100");
  const found = roles.find((role) => role.slug === slug);
  if (!found) throw new Error(`no role ${slug}`);
  return found.id;
}

const PASSWORD = "e2e-fleet-passphrase-0001";

/**
 * A signed-in browser context for a fresh user holding `roleIds`.
 *
 * The user is invited exactly as the Users page does it and accepts the
 * invitation through the panel origin, so the cookie lands in this
 * context the way a real browser would get it. The storage state is
 * kept on disk per key and re-validated, because accepting is
 * rate-limited alongside sign-in and every spec file wants the same
 * five personas.
 */
export async function signedInContext(
  browser: Browser,
  key: string,
  roleIds: () => Promise<string[]>,
): Promise<BrowserContext> {
  const dir = join(artifactsDir, "personas");
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, `${key}.json`);

  if (existsSync(statePath)) {
    const context = await browser.newContext({ storageState: statePath, baseURL: webUrl });
    const probe = await context.request.get("/api/v1/auth/session");
    if (probe.ok()) return context;
    await context.close();
  }

  const email = `${key}-${Date.now().toString(36)}@e2e.kaname.test`;
  const invited = await ownerCall<{ invite: { url: string } }>("POST", "/users", {
    email,
    name: `E2E ${key}`,
    role_ids: await roleIds(),
    send_invite: false,
  });
  const token = invited.invite.url.split("/invite/")[1];
  if (!token) throw new Error(`invite url carried no token: ${invited.invite.url}`);

  const context = await browser.newContext({ baseURL: webUrl });
  const accepted = await context.request.post("/api/v1/auth/invite/accept", {
    data: { token, password: PASSWORD },
  });
  expect(accepted.status(), await accepted.text()).toBeLessThan(300);
  await context.storageState({ path: statePath });
  return context;
}

/** The system roles of packages/contract/src/rbac.ts. */
export type SystemRole = "owner" | "operator" | "developer" | "auditor" | "viewer";

export function signedInAs(browser: Browser, role: SystemRole): Promise<BrowserContext> {
  return signedInContext(browser, `role-${role}`, async () => [await roleId(role)]);
}

/* ------------------------------- agents ------------------------------ */

function stateDir(name: string): string {
  return join(agentStateRoot, name);
}

/** Pids of every `kanamed run` serving this state directory. */
export function agentPids(name: string): number[] {
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", `${agentBinary} run --simulate --state-dir ${stateDir(name)}( |$)`],
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Kills a simulated host's agent the way a crash or an OOM kill would. */
export function killAgent(name: string, signal: NodeJS.Signals = "SIGKILL"): void {
  const pids = agentPids(name);
  expect(pids.length, `no agent process is running for ${name}`).toBeGreaterThan(0);
  for (const pid of pids) process.kill(pid, signal);
}

/** Global teardown kills what stack.json lists, so a restarted agent is added to it. */
function recordPid(pid: number): void {
  let pids: number[] = [];
  try {
    pids = (JSON.parse(readFileSync(stackFile, "utf8")) as { pids?: number[] }).pids ?? [];
  } catch {
    /* no stack file: nothing else to preserve */
  }
  if (!pids.includes(pid)) pids.push(pid);
  writeFileSync(stackFile, JSON.stringify({ pids }, null, 2));
}

/**
 * Starts (or restarts) the simulated agent for a state directory. `extra`
 * goes after the arguments `agentPids` matches on, e.g. a heartbeat delay.
 */
export function startAgent(name: string, extra: string[] = []): Managed {
  const managed = launch(
    `agent-${name}-${Date.now().toString(36)}`,
    agentBinary,
    ["run", "--simulate", "--state-dir", stateDir(name), "--log-level", "info", ...extra],
    { cwd: repoRoot, env: { KANAME_ENV: "development" } },
  );
  recordPid(managed.pid);
  return managed;
}

/** `kanamed enroll` with a token the panel printed. Rejects with the agent's output on failure. */
export function enrollAgent(name: string, url: string, token: string): Promise<void> {
  mkdirSync(stateDir(name), { recursive: true });
  return run(
    `enroll-${name}-${Date.now().toString(36)}`,
    agentBinary,
    ["enroll", "--url", url, "--token", token, "--state-dir", stateDir(name)],
    { cwd: repoRoot },
  );
}

export async function waitForConnection(
  serverName: string,
  connection: string,
  timeout = 60_000,
): Promise<void> {
  await expect
    .poll(async () => (await server(serverName)).connection, {
      message: `${serverName} never became ${connection}`,
      timeout,
    })
    .toBe(connection);
}

/* --------------------------------- ui -------------------------------- */

/** The agent-state word an AgentConnectionIndicator shows. */
export const CONNECTION_WORD = /^(Connected|Degraded|Disconnected|Never enrolled|Revoked)$/;

export function connectionLabel(scope: Locator | Page): Locator {
  return scope.getByText(CONNECTION_WORD);
}

export function tableRow(table: Locator, text: string): Locator {
  return table.locator("tbody tr").filter({ hasText: text });
}

/** Opens a DataTable row's action menu and returns the menu items. */
export async function openRowActions(page: Page, row: Locator): Promise<Locator> {
  await row.getByRole("button", { name: "Row actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** The job drawer entry for a job label, once a click has opened the drawer. */
export function drawerJob(page: Page, label: string | RegExp): Locator {
  return page
    .getByRole("dialog", { name: "Job activity" })
    .getByRole("listitem")
    .filter({ hasText: label })
    .first();
}

export interface TerminalSessionRow {
  id: string;
  server_id: string;
  started_at: string | null;
  ended_at: string | null;
  /** Set for a container's Exec session; null for a host shell. */
  container_name: string | null;
  recording_available: boolean;
}

export async function terminalSessionsFor(serverId: string): Promise<TerminalSessionRow[]> {
  return ownerCall<TerminalSessionRow[]>(
    "GET",
    `/terminal/sessions?server_id=${serverId}&per_page=50&sort=started_at&order=desc`,
  );
}
