import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  agentBinary,
  agentStateRoot,
  apiUrl,
  artifactsDir,
  databaseUrl,
  fleetSize,
  logsDir,
  ownerEmail,
  ownerPassword,
  repoRoot,
  stackFile,
} from "./config.js";
import { killTree, launch, waitUntil } from "./processes.js";
import { record, startControlPlane } from "./stack.js";
import { jobStatusPill } from "./ui.js";

/* ------------------------------------------------------------------ *
 * What the Email specs need beyond the shared harness.
 *
 * 1. A yunori-mail release feed. The sandbox cannot reach yunori.email,
 *    so the specs serve one from disk in the exact shape
 *    services/mail-release.ts reads (latest.json plus a SHA-256 next to
 *    each archive), and can take it down again to show what an
 *    unreachable feed looks like.
 * 2. An API client per signed-in principal, so a spec can ask "what did
 *    the control plane actually do" instead of trusting a toast.
 * 3. Process control over this stack only: stop one simulated agent, or
 *    stop the control plane long enough to read its database. Pids come
 *    from this stack's own stack.json, so another suite's processes on
 *    the same machine are never touched.
 * ------------------------------------------------------------------ */

/* ------------------------------- release feed ------------------------------ */

export const FEED_VERSION = "0.1.0";

function feedUrl(): URL {
  const raw = process.env["KANAME_YUNORI_FEED"];
  if (!raw) {
    throw new Error(
      "KANAME_YUNORI_FEED is not set: the Email specs serve a local yunori-mail feed and the control plane must be pointed at it (e.g. http://127.0.0.1:8912).",
    );
  }
  const url = new URL(raw);
  if (url.hostname !== "127.0.0.1") throw new Error(`KANAME_YUNORI_FEED must be local, not ${raw}`);
  return url;
}

/** Where the feed lives on disk; overridable so it can sit in a scratch dir. */
const feedDir = resolve(process.env["KANAME_E2E_YUNORI_FEED_DIR"] ?? join(artifactsDir, "yunori-feed"));

/** Writes latest.json and both archives with their checksums. Returns the digests by asset. */
export function writeFeed(): Record<string, string> {
  const release = join(feedDir, `v${FEED_VERSION}`);
  mkdirSync(release, { recursive: true });
  const digests: Record<string, string> = {};
  for (const asset of ["yunori-mail-x86_64-linux.tar.gz", "yunori-mail-aarch64-linux.tar.gz"]) {
    // Not a real tarball of a real binary: the simulated host verifies
    // nothing it downloads. It is still a gzip with a true checksum, so
    // a real agent pointed here would fail the right way.
    const bytes = gzipSync(Buffer.from(`yunori-mail ${FEED_VERSION} ${asset} (e2e fixture)\n`));
    writeFileSync(join(release, asset), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(release, `${asset}.sha256`), `${sha}  ${asset}\n`);
    digests[asset] = sha;
  }
  writeFileSync(
    join(feedDir, "latest.json"),
    JSON.stringify({
      version: FEED_VERSION,
      tag: `v${FEED_VERSION}`,
      publishedAt: "2026-10-01T00:00:00Z",
      notesUrl: `https://github.com/FutureForge-Studios/yunori-mail/releases/tag/v${FEED_VERSION}`,
    }),
  );
  return digests;
}

let feedProcess: ChildProcess | null = null;

export async function startFeed(): Promise<void> {
  const url = feedUrl();
  writeFeed();
  if (feedProcess) return;
  if (await fetch(`${url.origin}/latest.json`).then((r) => r.ok).catch(() => false)) return;
  feedProcess = spawn(
    "python3",
    ["-m", "http.server", url.port || "80", "--bind", "127.0.0.1", "--directory", feedDir],
    { stdio: "ignore", detached: true },
  );
  feedProcess.unref();
  if (feedProcess.pid) record(feedProcess.pid);
  await waitUntil(`the release feed on ${url.origin}`, async () => {
    const res = await fetch(`${url.origin}/latest.json`);
    return res.ok;
  }, { timeoutMs: 15_000 });
}

export async function stopFeed(): Promise<void> {
  const url = feedUrl();
  // The handle is per worker; a server started by an earlier worker is
  // found by its command line in this stack's pid list.
  for (const pid of stackPids()) {
    const line = cmdline(pid);
    if (line.includes("http.server") && line.includes(` ${url.port} `)) killTree(pid);
  }
  if (feedProcess?.pid) killTree(feedProcess.pid);
  feedProcess = null;
  await waitUntil(`the release feed on ${url.origin} to go away`, async () => {
    try {
      await fetch(`${url.origin}/latest.json`, { signal: AbortSignal.timeout(1000) });
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 15_000 });
}

/* ---------------------------------- api ---------------------------------- */

export interface ApiResponse<T = unknown> {
  status: number;
  body: { data?: T; error?: ApiErrorBody } & Record<string, unknown>;
  text: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
  detail?: unknown;
  remediation?: { summary: string };
}

/** One signed-in principal talking to the control plane directly. */
export class Api {
  private constructor(readonly cookie: string) {}

  static async signIn(email = ownerEmail, password = ownerPassword): Promise<Api> {
    const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`sign-in as ${email} failed (${res.status}): ${await res.text()}`);
    const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
    if (!cookie) throw new Error("sign-in returned no cookie");
    return new Api(cookie);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const res = await fetch(`${apiUrl}/api/v1${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: ApiResponse<T>["body"] = {};
    try {
      parsed = text ? (JSON.parse(text) as ApiResponse<T>["body"]) : {};
    } catch {
      /* an event stream or empty body */
    }
    return { status: res.status, body: parsed, text };
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = unknown>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
  del<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }

  /** GET that must succeed; returns `data`. */
  async data<T>(path: string): Promise<T> {
    const res = await this.get<T>(path);
    expect(res.status, `GET ${path}: ${res.text}`).toBe(200);
    return res.body.data as T;
  }

  /** Polls a job until it is terminal and returns it. */
  async job(id: string, timeoutMs = 60_000): Promise<JobRow> {
    let last: JobRow | null = null;
    await expect
      .poll(
        async () => {
          last = await this.data<JobRow>(`/jobs/${id}`);
          return TERMINAL.has(last.status);
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000], message: `job ${id} never finished` },
      )
      .toBe(true);
    return last!;
  }

  async jobLog(id: string): Promise<string> {
    const lines = await this.data<{ message: string; level: string }[]>(
      `/jobs/${id}/logs?per_page=1000`,
    );
    return lines.map((l) => `${l.level} ${l.message}`).join("\n");
  }

  /** The whole audit trail as text, for "this value appears nowhere" checks. */
  async auditTrail(): Promise<string> {
    const res = await fetch(`${apiUrl}/api/v1/audit/export`, { headers: { cookie: this.cookie } });
    expect(res.status).toBe(200);
    return res.text();
  }
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export interface JobRow {
  id: string;
  type: string;
  status: string;
  label: string;
  params: Record<string, unknown>;
  result: unknown;
  error: { code: string; message: string } | null;
  server_id: string | null;
  target_id: string | null;
}

let ownerApi: Api | null = null;
export async function owner(): Promise<Api> {
  ownerApi ??= await Api.signIn();
  return ownerApi;
}

/** After a control-plane restart sessions survive (they are rows), but be safe. */
export function forgetOwnerSession(): void {
  ownerApi = null;
}

/* ------------------------------ seeded shapes ------------------------------ */

export interface MailServerRow {
  id: string;
  server_id: string;
  server_name: string;
  status: string;
  hostname: string | null;
  primary_domain: string | null;
  install_complete: boolean;
  health: string;
  checks: { id: string; status: string; label: string }[];
  certificate: { state: string; days_left: number | null; covers: string[] } | null;
  domain_count: number;
  mailbox_count: number;
  sending_mode: string | null;
  relay_provider: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  version: string | null;
}

export interface MailDomainRow {
  id: string;
  domain_id: string;
  domain_name: string;
  server_id: string;
  server_name: string;
  mail_server_id: string;
  is_primary: boolean;
  status: string;
  dns_status: string;
  dns_checked_at: string | null;
  mailbox_count: number;
  alias_count: number;
}

export interface MailboxRow {
  id: string;
  address: string;
  status: string;
  mail_domain_id: string;
  server_id: string;
  aliases: string[];
  display_name: string | null;
  quota_bytes: number;
}

export interface AliasRow {
  id: string;
  address: string;
  mailbox_address: string;
  mailbox_id: string | null;
  status: string;
}

export interface FleetRow {
  id: string;
  name: string;
  connection: string;
  capabilities: string[];
}

export async function mailServerOn(api: Api, serverName: string): Promise<MailServerRow | undefined> {
  const rows = await api.data<MailServerRow[]>("/mail-servers?per_page=100");
  return rows.find((row) => row.server_name === serverName);
}

export async function mailDomainNamed(api: Api, name: string): Promise<MailDomainRow | undefined> {
  const rows = await api.data<MailDomainRow[]>(`/mail-domains?per_page=200&q=${encodeURIComponent(name)}`);
  return rows.find((row) => row.domain_name === name);
}

export async function mailboxAt(api: Api, address: string): Promise<MailboxRow | undefined> {
  const rows = await api.data<MailboxRow[]>(`/mailboxes?per_page=200&q=${encodeURIComponent(address)}`);
  return rows.find((row) => row.address === address);
}

export async function aliasAt(api: Api, address: string): Promise<AliasRow | undefined> {
  const rows = await api.data<AliasRow[]>(`/mail-aliases?per_page=200&q=${encodeURIComponent(address)}`);
  return rows.find((row) => row.address === address);
}

export async function fleetServer(api: Api, name: string): Promise<FleetRow> {
  const rows = await api.data<FleetRow[]>("/servers?per_page=100");
  const row = rows.find((server) => server.name === name);
  if (!row) throw new Error(`no server named ${name}`);
  return row;
}

export async function kanameDomain(api: Api, name: string): Promise<{ id: string; name: string; has_mail: boolean }> {
  const rows = await api.data<{ id: string; name: string; has_mail: boolean }[]>(
    `/domains?per_page=200&q=${encodeURIComponent(name)}`,
  );
  const row = rows.find((domain) => domain.name === name);
  if (!row) throw new Error(`no Kaname domain named ${name}`);
  return row;
}

/** Runs a sync job for a server's mail record and waits for it. */
export async function syncMail(api: Api, serverName: string): Promise<JobRow> {
  const row = await mailServerOn(api, serverName);
  if (!row) throw new Error(`no mail server on ${serverName}`);
  const res = await api.post<{ job: JobRow }>(`/mail-servers/${row.id}/sync`);
  expect(res.status, res.text).toBe(202);
  const job = await api.job(res.body.data!.job.id);
  expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
  return job;
}

/* ------------------------------ process control ---------------------------- */

function stackPids(): number[] {
  if (!existsSync(stackFile)) return [];
  return (JSON.parse(readFileSync(stackFile, "utf8")) as { pids: number[] }).pids;
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function agentPid(name: string): number | undefined {
  const stateDir = join(agentStateRoot, name);
  return stackPids().find((pid) => {
    const line = cmdline(pid);
    return line.includes("--simulate") && line.includes(`${stateDir} `);
  });
}

function controlPlanePid(): number | undefined {
  return stackPids().find((pid) => cmdline(pid).includes("src/main.ts"));
}

async function connection(name: string): Promise<string> {
  const api = await owner();
  return (await fleetServer(api, name)).connection;
}

/** Kills the simulated agent of one host and waits until the control plane notices. */
export async function stopAgent(name: string): Promise<void> {
  const pid = agentPid(name);
  if (!pid) throw new Error(`no running agent for ${name} in ${stackFile}`);
  killTree(pid);
  await waitUntil(`${name}'s agent to exit`, async () => !alive(pid), { timeoutMs: 15_000 });
  await waitUntil(`${name} to read as disconnected`, async () => (await connection(name)) !== "connected", {
    timeoutMs: 30_000,
  });
}

/**
 * Starts the agent again from the same state dir. Its simulated world is
 * rebuilt from scratch, exactly as a real host's would not be: anything a
 * spec deployed there is gone. Callers that need it back resync.
 */
export async function startAgent(name: string): Promise<void> {
  if (agentPid(name) && alive(agentPid(name)!)) return;
  keepLog(`agent-${name}`);
  const agent = launch(
    `agent-${name}`,
    agentBinary,
    ["run", "--simulate", "--state-dir", join(agentStateRoot, name), "--log-level", "info"],
    { cwd: repoRoot, env: { KANAME_ENV: "development" }, detachOutput: true },
  );
  record(agent.pid);
  await waitUntil(`${name} to reconnect`, async () => (await connection(name)) === "connected", {
    timeoutMs: 60_000,
    detail: () => agent.tail(),
  });
}

async function healthy(agents: number): Promise<boolean> {
  const res = await fetch(`${apiUrl}/health`);
  if (!res.ok) return false;
  const body = (await res.json()) as { status: string; agents_connected: number };
  return body.status === "ok" && body.agents_connected >= agents;
}

/**
 * Stops the control plane, runs `whileDown` (which may open the database,
 * since PGlite is single-process), and starts it again with the same
 * environment, waiting for the whole fleet to dial back in.
 */
export async function withControlPlaneStopped<T>(whileDown: () => Promise<T>): Promise<T> {
  const pid = controlPlanePid();
  if (!pid) throw new Error(`no control plane in ${stackFile}`);
  killTree(pid);
  await waitUntil("the control plane to exit", async () => !alive(pid), { timeoutMs: 30_000 });
  let result: T;
  try {
    result = await whileDown();
  } finally {
    keepLog("control-plane");
    const cp = startControlPlane({ detachOutput: true });
    record(cp.pid);
    await waitUntil(`the control plane and ${fleetSize} agents`, () => healthy(fleetSize), {
      timeoutMs: 150_000,
      detail: () => cp.tail(),
    });
    forgetOwnerSession();
  }
  return result!;
}

/** The PGlite directory the control plane uses, resolved the way @kaname/db does. */
export function databaseDir(): string {
  const dir = databaseUrl.replace(/^(pglite|file):\/\//, "");
  return resolve(repoRoot, dir);
}

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  close(): Promise<void>;
}

/** Opens the stack's database. Only call inside withControlPlaneStopped. */
export async function openDatabase(): Promise<Db> {
  const { PGlite } = (await import("@electric-sql/pglite")) as unknown as {
    PGlite: new (dir: string) => Db & { waitReady: Promise<void> };
  };
  const db = new PGlite(databaseDir());
  await db.waitReady;
  return db;
}

export async function argon2Hash(password: string): Promise<string> {
  const { hash } = (await import("@node-rs/argon2")) as unknown as {
    hash: (pw: string, opts: Record<string, number>) => Promise<string>;
  };
  return hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

/**
 * A relaunched process reopens its log with "w", so the previous run's
 * output is moved aside first; processLog reads every generation.
 */
function keepLog(name: string): void {
  const path = join(logsDir, `${name}.log`);
  if (existsSync(path)) renameSync(path, join(logsDir, `${name}.${Date.now()}.previous.log`));
}

/** Everything a process in this stack has printed so far, across restarts. */
export function processLog(name: string): string {
  if (!existsSync(logsDir)) return "";
  return readdirSync(logsDir)
    .filter((file) => file === `${name}.log` || (file.startsWith(`${name}.`) && file.endsWith(".previous.log")))
    .map((file) => readFileSync(join(logsDir, file), "utf8"))
    .join("\n");
}

/* ----------------------------------- ui ----------------------------------- */

/** Waits for the job drawer entry with this label to reach Succeeded (or a failure). */
export async function expectJobInDrawer(page: Page, label: string | RegExp, outcome = "Succeeded"): Promise<Locator> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const job = drawer.getByRole("listitem").filter({ hasText: label }).first();
  await expect(job).toBeVisible();
  await expect(jobStatusPill(job)).toContainText(outcome, { timeout: 60_000 });
  return job;
}

export async function closeJobDrawer(page: Page): Promise<void> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  if (await drawer.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }
}

/** The DataTable row for a value in its locked first column. */
export function tableRow(page: Page, table: string, text: string): Locator {
  return page
    .getByRole("table", { name: table })
    .locator("tbody tr")
    .filter({ has: page.getByText(text, { exact: true }) });
}

export async function rowAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

/** Picks an option in one of the kit's Comboboxes by its exact label. */
export async function pickOption(scope: Page | Locator, combobox: string, label: string): Promise<void> {
  const page = "page" in scope ? scope.page() : scope;
  const input = scope.getByRole("combobox", { name: combobox, exact: true });
  await input.click();
  await input.fill(label);
  const option = page
    .getByRole("listbox", { name: combobox, exact: true })
    .getByRole("option")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  await option.click();
}

/** The value a CopyableCode shows, found through its labelled copy button. */
export function copyableValue(scope: Page | Locator, label: string): Locator {
  return scope
    .getByRole("button", { name: `Copy ${label}`, exact: true })
    .locator("xpath=ancestor::div[1]")
    .locator("code");
}

/** A short random suffix so reruns on a reused stack never collide. */
export function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

/* --------------------------- secrets ledger -------------------------------- */

/*
 * Every credential a spec is shown (a mailbox password, a setup link, a
 * relay password it typed) is noted here, so the secrecy spec can look
 * for all of them in the jobs, the audit trail, the logs and the
 * database, whichever spec produced them. They are simulated-host values
 * and the file lives in this stack's artifacts directory.
 */
const ledgerPath = join(artifactsDir, "email-secrets-seen.json");

export function noteSecret(kind: string, value: string): void {
  const ledger = readSecrets();
  ledger.push({ kind, value });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

export function readSecrets(): { kind: string; value: string }[] {
  if (!existsSync(ledgerPath)) return [];
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as { kind: string; value: string }[];
}

/** One mail server card on /email, by the host it runs on. */
export function serverCard(page: Page, serverName: string): Locator {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({
      has: page
        .getByRole("heading", { level: 2 })
        .filter({ has: page.getByRole("link", { name: serverName, exact: true }) }),
    });
}

/** A definition in a <dl>, by its term. */
export function definition(scope: Locator, term: string): Locator {
  return scope.getByRole("term").filter({ hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}
