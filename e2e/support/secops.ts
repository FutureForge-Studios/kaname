import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  agentBinary,
  agentStateRoot,
  apiUrl,
  ownerEmail,
  ownerPassword,
  repoRoot,
  stackFile,
  webUrl,
} from "./config.js";
import { killTree, launch, waitUntil } from "./processes.js";

/* ------------------------------------------------------------------ *
 * Shared plumbing for the security and operations specs.
 *
 * Same rule as api.ts: this looks things up and sets the stage, it does
 * not assert the product's behaviour. Setting the stage here means a
 * real call through the public API — an invited user really accepts an
 * invitation, an agent is really killed — never a row written behind
 * the control plane's back.
 * ------------------------------------------------------------------ */

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    detail?: unknown;
  } | null;
}

/** An API client bound to one session cookie. */
export class Api {
  constructor(readonly cookie: string) {}

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await fetch(`${apiUrl}/api/v1${path}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as { data?: T; error?: ApiResult["error"] }) : {};
    return { status: res.status, data: parsed.data as T, error: parsed.error ?? null };
  }

  /** Like call, but fails the test on anything but 2xx. */
  async ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.call<T>(method, path, body);
    expect(
      result.status,
      `${method} ${path} → ${result.status} ${JSON.stringify(result.error)}`,
    ).toBeLessThan(300);
    return result.data;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.ok<T>("GET", path);
  }
}

/** The session cookie a successful sign-in answers with, "name=value". */
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in as ${email} failed (${res.status}): ${await res.text()}`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error(`sign-in as ${email} set no cookie`);
  return cookie;
}

let ownerApi: Api | null = null;

export async function owner(): Promise<Api> {
  ownerApi ??= new Api(await login(ownerEmail, ownerPassword));
  return ownerApi;
}

/* ------------------------------- servers ------------------------------ */

export interface ServerRow {
  id: string;
  name: string;
  hostname: string;
  connection: string;
}

export async function server(name: string): Promise<ServerRow> {
  const rows = await (await owner()).get<ServerRow[]>("/servers?per_page=100");
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`no server named ${name}`);
  return found;
}

/* -------------------------------- jobs -------------------------------- */

export interface JobRow {
  id: string;
  type: string;
  status: string;
  error: { code: string; message: string } | null;
  result: unknown;
  blocked_reason: string | null;
}

export const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out"];

/** Waits for a job to settle and returns it, whatever it settled as. */
export async function settled(jobId: string, timeout = 60_000): Promise<JobRow> {
  const api = await owner();
  let job: JobRow | null = null;
  await expect
    .poll(
      async () => {
        job = await api.get<JobRow>(`/jobs/${jobId}`);
        return job.status;
      },
      { timeout, intervals: [250, 500, 1000], message: `job ${jobId} never settled` },
    )
    .toMatch(new RegExp(`^(${TERMINAL.join("|")})$`));
  return job!;
}

/* ------------------------------ host files ----------------------------- */

/** Reads a file off a (simulated) host through the file manager API. */
export async function hostFile(serverId: string, path: string): Promise<string> {
  const read = await (await owner()).call<{ content: string }>(
    "GET",
    `/files/read?server_id=${serverId}&path=${encodeURIComponent(path)}`,
  );
  if (read.status >= 300) return `<unreadable: ${read.status} ${read.error?.message ?? ""}>`;
  return read.data.content;
}

/* -------------------------------- roles -------------------------------- */

export type RoleSlug = "operator" | "developer" | "auditor" | "viewer";

export const ROLE_PASSWORD = "e2e-role-passphrase-2026!";

const roleCookies = new Map<RoleSlug, string>();

export function roleEmail(slug: RoleSlug): string {
  return `e2e-${slug}@kaname.test`;
}

/**
 * A user holding exactly one system role, made the way an operator
 * makes one: invited by the owner, then the invitation accepted by the
 * invitee with a password only they know. Idempotent across spec files
 * in one run — a second call signs the existing account in.
 */
export async function roleCookie(slug: RoleSlug): Promise<string> {
  const cached = roleCookies.get(slug);
  if (cached) return cached;

  const api = await owner();
  const roles = await api.get<{ id: string; slug: string }[]>("/roles?per_page=100");
  const role = roles.find((row) => row.slug === slug);
  if (!role) throw new Error(`no system role ${slug}`);

  const invited = await api.call<{ invite: { url: string } }>("POST", "/users", {
    email: roleEmail(slug),
    name: `E2E ${slug}`,
    role_ids: [role.id],
    send_invite: false,
  });

  let cookie: string;
  if (invited.status === 201) {
    const token = invited.data.invite.url.split("/invite/")[1]!;
    const res = await fetch(`${apiUrl}/api/v1/auth/invite/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: ROLE_PASSWORD }),
    });
    if (!res.ok) throw new Error(`accepting the ${slug} invite failed (${res.status})`);
    cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  } else if (invited.status === 409) {
    cookie = await login(roleEmail(slug), ROLE_PASSWORD);
  } else {
    throw new Error(`inviting ${slug} failed (${invited.status}) ${JSON.stringify(invited.error)}`);
  }
  roleCookies.set(slug, cookie);
  return cookie;
}

export async function roleApi(slug: RoleSlug): Promise<Api> {
  return new Api(await roleCookie(slug));
}

/** A browser context signed in as one role. */
export async function roleContext(browser: Browser, slug: RoleSlug): Promise<BrowserContext> {
  const [name, value] = (await roleCookie(slug)).split("=") as [string, string];
  return browser.newContext({
    baseURL: webUrl,
    storageState: {
      cookies: [
        {
          name,
          value,
          domain: new URL(webUrl).hostname,
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

/* ------------------------------- agents -------------------------------- */

function agentPids(name: string): number[] {
  const stateDir = join(agentStateRoot, name);
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (argv[0] === agentBinary && argv[1] === "run" && argv.includes(stateDir)) {
        pids.push(Number(entry));
      }
    } catch {
      /* exited while we looked */
    }
  }
  return pids;
}

async function connection(serverId: string): Promise<string> {
  const row = await (await owner()).get<ServerRow>(`/servers/${serverId}`);
  return row.connection;
}

/** Kills one simulated agent and waits until the control plane has noticed. */
export async function stopAgent(name: string): Promise<void> {
  const target = await server(name);
  const pids = agentPids(name);
  expect(pids, `no running agent process for ${name}`).not.toHaveLength(0);
  for (const pid of pids) killTree(pid);
  await waitUntil(
    `${name} to show as disconnected`,
    async () => (await connection(target.id)) !== "connected",
    { timeoutMs: 30_000 },
  );
}

/** Starts the agent again from its own state directory, as a reboot would. */
export async function startAgent(name: string): Promise<void> {
  const target = await server(name);
  if (agentPids(name).length === 0) {
    const managed = launch(
      `agent-${name}-restarted`,
      agentBinary,
      ["run", "--simulate", "--state-dir", join(agentStateRoot, name), "--log-level", "info"],
      { cwd: repoRoot, env: { KANAME_ENV: "development" } },
    );
    // Teardown kills what stack.json lists; a restarted agent belongs there too.
    const stack = existsSync(stackFile)
      ? (JSON.parse(readFileSync(stackFile, "utf8")) as { pids: number[] })
      : { pids: [] };
    stack.pids.push(managed.pid);
    writeFileSync(stackFile, JSON.stringify(stack, null, 2));
  }
  await waitUntil(
    `${name} to reconnect`,
    async () => (await connection(target.id)) === "connected",
    { timeoutMs: 60_000 },
  );
}

/* ---------------------------- local endpoints --------------------------- */

export interface Received {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface Endpoint {
  url: string;
  received: Received[];
  /** What the next requests are answered with. */
  respond: { status: number; body: string };
  close(): Promise<void>;
}

/** A throwaway HTTP endpoint on loopback that records what reaches it. */
export async function endpoint(): Promise<Endpoint> {
  const received: Received[] = [];
  const state = { status: 200, body: "ok" };
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ path: req.url ?? "/", headers: req.headers, body });
      res.writeHead(state.status, { "content-type": "text/plain" });
      res.end(state.body);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    respond: state,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

/** A loopback port that is guaranteed to have nothing listening on it. */
export async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/* -------------------------------- audit -------------------------------- */

export interface AuditRow {
  id: string;
  action: string;
  actor_name: string;
  target_label: string;
  server_id: string | null;
}

/** The newest audit rows whose action starts with `prefix`. */
export async function auditRows(prefix: string, perPage = 50): Promise<AuditRow[]> {
  return (await owner()).get<AuditRow[]>(
    `/audit?action=${encodeURIComponent(prefix)}&per_page=${perPage}&sort=seq&order=desc`,
  );
}
