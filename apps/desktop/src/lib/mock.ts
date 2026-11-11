/* ------------------------------------------------------------------ *
 * In-memory stand-in for the Rust backend, used when the page is not
 * running inside Tauri (plain `pnpm dev` in a browser, Playwright).
 *
 * It answers the same commands as INTERFACE.md with the same shapes:
 * connections live in memory, every connection serves the same small
 * fake fleet, mutations return 202 + a job that walks queued → running
 * → succeeded (or failed), and terminals are a tiny echo shell.
 *
 * Knobs (query string):
 *   ?seed      start with one signed-in demo connection
 *   ?latency=N add N ms to every call (default 120)
 *
 * connection_test: a URL containing "unreachable" fails with network,
 * "selfsigned" with tls (unless accepted), "notkaname" with not_found,
 * "fresh" reports setup_required. API keys must start with kn_.
 *
 * Sign-in: any email/password works (an email without "@" returns
 * validation_failed with `fields`). A password of "totp" asks for a
 * TOTP code next (any 6 digits but 000000). A password of "wrong" is
 * refused with `invalid_credentials`.
 * ------------------------------------------------------------------ */

import type {
  ApiResponse,
  Connection,
  ConnectionInput,
  DesktopError,
  LoginResult,
  TerminalEvent,
  TerminalOpened,
} from "./ipc";
import { base64ToText, textToBase64 } from "./base64";

type Args = Record<string, unknown>;

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const LATENCY = Number(params.get("latency") ?? 120);

function fail(code: string, message: string, status: number | null = null, remediation: DesktopError["remediation"] = null): never {
  const error: DesktopError = { code, message, status, remediation };
  throw error;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
const nowIso = () => new Date().toISOString();

/* --------------------------- connections -------------------------- */

const connections = new Map<string, Connection>();
const signedIn = new Set<string>();
const apiKeys = new Map<string, string>();
const challenges = new Map<string, string>();

if (params.has("seed")) {
  const id = uuid();
  connections.set(id, {
    id,
    name: "Demo panel",
    base_url: "https://panel.example.com",
    auth_kind: "session",
    email: "ops@example.com",
    color: "#5B76F7",
    accept_invalid_certs: false,
    created_at: nowIso(),
    last_connected_at: nowIso(),
    has_credential: true,
  });
  signedIn.add(id);
}

function getConnection(id: unknown): Connection {
  const c = typeof id === "string" ? connections.get(id) : undefined;
  if (!c) fail("not_found", "That connection no longer exists.");
  return c;
}

function sessionBody(c: Connection) {
  return {
    user: { id: "u-1", email: c.email ?? "ops@example.com", name: "Demo Operator" },
    principal: { kind: c.auth_kind === "api_key" ? "api_key" : "user" },
  };
}

function requireAuth(c: Connection) {
  if (c.auth_kind === "api_key") {
    if (!apiKeys.has(c.id)) fail("not_signed_in", "No API key is stored for this connection.");
    return;
  }
  if (!signedIn.has(c.id)) fail("not_signed_in", "Sign in to this panel to continue.");
}

/* ------------------------------ fleet ----------------------------- */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface MockServer {
  id: string;
  name: string;
  hostname: string;
  address: string | null;
  os: string;
  os_family: string;
  arch: string;
  kernel: string;
  cpu_model: string;
  cpu_cores: number;
  memory_total: number;
  agent_version: string;
  connection: string;
  health: string;
  health_reasons: string[];
  last_seen_at: string | null;
  uptime_seconds: number | null;
  provider: string | null;
  labels: Record<string, string>;
  capabilities: string[];
  latest: Record<string, unknown> | null;
}

const GiB = 1024 ** 3;

function makeServer(
  name: string,
  address: string,
  os: string,
  connection: string,
  health: string,
  cpu: number,
  memUsed: number,
  memTotal: number,
  extra: Partial<MockServer> = {},
): MockServer {
  return {
    id: uuid(),
    name,
    hostname: `${name}.internal`,
    address,
    os,
    os_family: os.split(" ")[0]!.toLowerCase(),
    arch: "x86_64",
    kernel: "6.8.0-45-generic",
    cpu_model: "AMD EPYC 7B13",
    cpu_cores: 4,
    memory_total: memTotal * GiB,
    agent_version: "0.2.0",
    connection,
    health,
    health_reasons: [],
    last_seen_at: connection === "connected" ? minutesAgo(0) : minutesAgo(47),
    uptime_seconds: connection === "connected" ? 86400 * 12 + 3600 * 5 : null,
    provider: "hetzner",
    labels: { env: "prod" },
    capabilities: ["systemd", "docker"],
    latest:
      connection === "disconnected"
        ? null
        : {
            cpu_percent: cpu,
            memory_used: memUsed * GiB,
            memory_total: memTotal * GiB,
            swap_used: 0,
            load1: (cpu / 100) * 4,
            disks: [{ mount: "/", used: 38 * GiB, total: 80 * GiB }],
            net_rx_rate: 182_000,
            net_tx_rate: 96_000,
            sampled_at: minutesAgo(0),
          },
    ...extra,
  };
}

const servers: MockServer[] = [
  makeServer("web-01", "10.0.1.11", "Ubuntu 24.04", "connected", "healthy", 23, 2.1, 8),
  makeServer("web-02", "10.0.1.12", "Ubuntu 24.04", "connected", "warning", 71, 6.6, 8, {
    health_reasons: ["Memory above 80% for 10 minutes"],
  }),
  makeServer("db-01", "10.0.2.21", "Debian 12", "connected", "healthy", 12, 11.2, 32, {
    capabilities: ["systemd"],
  }),
  makeServer("mail-01", "10.0.3.31", "Debian 12", "degraded", "critical", 4, 1.2, 4, {
    health_reasons: ["postfix.service failed"],
  }),
  makeServer("edge-ams", "203.0.113.40", "Alpine 3.20", "disconnected", "unknown", 0, 0, 2),
];

interface MockService {
  id: string;
  server_id: string;
  server_name: string;
  unit: string;
  description: string;
  load_state: string;
  active_state: string;
  sub_state: string;
  enabled: boolean;
  main_pid: number | null;
  memory_current: number | null;
  restart_count: number;
  last_synced_at: string;
}

interface MockContainer {
  id: string;
  server_id: string;
  server_name: string;
  container_id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  runtime: string;
  restart_count: number;
  cpu_percent: number | null;
  memory_usage: number | null;
  last_synced_at: string;
}

const services: MockService[] = [];
const containers: MockContainer[] = [];

const UNITS: [string, string, string][] = [
  ["nginx.service", "A high performance web server", "active"],
  ["php8.3-fpm.service", "The PHP 8.3 FastCGI Process Manager", "active"],
  ["postgresql.service", "PostgreSQL RDBMS", "active"],
  ["docker.service", "Docker Application Container Engine", "active"],
  ["postfix.service", "Postfix Mail Transport Agent", "failed"],
  ["cron.service", "Regular background program processing daemon", "active"],
  ["fail2ban.service", "Fail2Ban Service", "inactive"],
];

for (const s of servers) {
  UNITS.forEach(([unit, description, state], i) => {
    if (unit === "postfix.service" && s.name !== "mail-01") return;
    services.push({
      id: uuid(),
      server_id: s.id,
      server_name: s.name,
      unit,
      description,
      load_state: "loaded",
      active_state: state,
      sub_state: state === "active" ? "running" : state === "failed" ? "failed" : "dead",
      enabled: state !== "inactive",
      main_pid: state === "active" ? 800 + i * 37 : null,
      memory_current: state === "active" ? (20 + i * 13) * 1024 * 1024 : null,
      restart_count: state === "failed" ? 3 : 0,
      last_synced_at: minutesAgo(1),
    });
  });
  if (s.capabilities.includes("docker")) {
    const defs: [string, string, string][] = [
      ["app", "ghcr.io/acme/app:2.4.1", "running"],
      ["redis", "redis:7-alpine", "running"],
      ["worker", "ghcr.io/acme/app:2.4.1", "exited"],
    ];
    for (const [name, image, state] of defs) {
      containers.push({
        id: uuid(),
        server_id: s.id,
        server_name: s.name,
        container_id: Math.random().toString(16).slice(2, 14),
        name,
        image,
        state,
        status: state === "running" ? "Up 3 days" : "Exited (1) 2 hours ago",
        runtime: "docker",
        restart_count: state === "running" ? 0 : 4,
        cpu_percent: state === "running" ? 2.4 : null,
        memory_usage: state === "running" ? 180 * 1024 * 1024 : null,
        last_synced_at: minutesAgo(1),
      });
    }
  }
}

function findServer(id: string): MockServer {
  const s = servers.find((x) => x.id === id);
  if (!s) fail("not_found", "Server not found.", 404);
  return s;
}

function requireConnected(s: MockServer) {
  if (s.connection === "disconnected") {
    fail("agent_offline", `${s.name}'s agent is not connected.`, 409, {
      summary: "Live reads and actions need the agent online. Check kanamed on the host.",
      actions: [{ label: "Open server in the panel", href: `/infrastructure/servers/${s.id}` }],
    });
  }
}

/* ------------------------------ jobs ------------------------------ */

interface MockJob {
  id: string;
  type: string;
  label: string;
  status: string;
  server_id: string;
  server_name: string;
  target_label: string;
  progress: number | null;
  error: { code: string; message: string } | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  willFail: boolean;
  t0: number;
  apply: () => void;
}

const jobs = new Map<string, MockJob>();

function startJob(type: string, label: string, server: MockServer, target: string, willFail: boolean, apply: () => void) {
  const job: MockJob = {
    id: uuid(),
    type,
    label,
    status: "queued",
    server_id: server.id,
    server_name: server.name,
    target_label: `${target} on ${server.name}`,
    progress: null,
    error: null,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    willFail,
    t0: Date.now(),
    apply,
  };
  jobs.set(job.id, job);
  return job;
}

function advance(job: MockJob) {
  const age = Date.now() - job.t0;
  if (job.finished_at) return;
  if (age > 900 && job.status === "queued") {
    job.status = "running";
    job.started_at = nowIso();
  }
  if (age > 2600) {
    job.finished_at = nowIso();
    if (job.willFail) {
      job.status = "failed";
      job.error = { code: "unit_failed", message: "Job for the unit failed. See journalctl -xeu for details." };
    } else {
      job.status = "succeeded";
      job.apply();
    }
  }
}

function jobView(job: MockJob) {
  const { willFail: _w, t0: _t, apply: _a, ...rest } = job;
  return { ...rest, duration_ms: job.finished_at ? Date.now() - job.t0 : null };
}

/* ------------------------------- api ------------------------------ */

function ok<T>(data: T, status = 200, meta: unknown = null): ApiResponse<T> {
  return { status, data, meta };
}

function listMeta(n: number) {
  return { page: 1, per_page: 100, total: n, has_more: false };
}

function apiRequest(c: Connection, method: string, path: string, query: Record<string, unknown>): ApiResponse<unknown> {
  requireAuth(c);
  const seg = path.split("/").filter(Boolean);

  if (method === "GET" && path === "/auth/session") return ok(sessionBody(c));

  if (seg[0] === "servers") {
    if (method === "GET" && seg.length === 1) {
      const q = String(query.q ?? "").toLowerCase();
      const rows = servers.filter((s) => !q || s.name.includes(q) || s.hostname.includes(q));
      return ok(rows, 200, listMeta(rows.length));
    }
    const s = findServer(seg[1]!);
    if (method === "GET" && seg.length === 2) return ok(s);
    if (method === "GET" && seg[2] === "metrics") {
      const samples = Array.from({ length: 60 }, (_, i) => {
        const base = (s.latest?.cpu_percent as number | undefined) ?? 0;
        return {
          ts: minutesAgo(60 - i),
          cpu_percent: s.latest ? Math.max(0, Math.min(100, base + Math.sin(i / 4) * 9 + (i % 7) - 3)) : null,
          memory_used: (s.latest?.memory_used as number | undefined) ?? null,
          memory_total: s.memory_total,
          load1: s.latest ? ((base / 100) * 4 * (1 + Math.sin(i / 5) / 4)) : null,
        };
      });
      return ok({ server_id: s.id, range: "1h", samples: s.latest ? samples : [] });
    }
  }

  if (seg[0] === "services") {
    if (method === "GET" && seg.length === 1) {
      const rows = services.filter((x) => !query.server_id || x.server_id === query.server_id);
      return ok(rows, 200, listMeta(rows.length));
    }
    if (method === "POST" && seg.length === 3) {
      const svc = services.find((x) => x.id === seg[1]);
      if (!svc) fail("not_found", "Service not found.", 404);
      const server = findServer(svc.server_id);
      requireConnected(server);
      const action = seg[2]!;
      const willFail = svc.unit === "postfix.service" && action !== "stop";
      const job = startJob(`service.${action}`, `${cap(action)} ${svc.unit}`, server, svc.unit, willFail, () => {
        const active = action !== "stop";
        svc.active_state = active ? "active" : "inactive";
        svc.sub_state = active ? "running" : "dead";
        svc.main_pid = active ? 1000 + Math.floor(Math.random() * 9000) : null;
        svc.last_synced_at = nowIso();
      });
      return ok({ job: jobView(job) }, 202);
    }
  }

  if (seg[0] === "containers") {
    if (method === "GET" && seg.length === 1) {
      const rows = containers.filter((x) => !query.server_id || x.server_id === query.server_id);
      return ok(rows, 200, listMeta(rows.length));
    }
    if (method === "POST" && seg.length === 3) {
      const ct = containers.find((x) => x.id === seg[1]);
      if (!ct) fail("not_found", "Container not found.", 404);
      const server = findServer(ct.server_id);
      requireConnected(server);
      const action = seg[2]!;
      const job = startJob(`container.${action}`, `${cap(action)} ${ct.name}`, server, ct.name, false, () => {
        const running = action !== "stop";
        ct.state = running ? "running" : "exited";
        ct.status = running ? "Up 1 second" : "Exited (0) 1 second ago";
        ct.cpu_percent = running ? 0.4 : null;
        ct.last_synced_at = nowIso();
      });
      return ok({ job: jobView(job) }, 202);
    }
  }

  if (seg[0] === "processes" && method === "GET") {
    const server = findServer(String(query.server_id ?? ""));
    requireConnected(server);
    const cmds = ["systemd", "nginx", "php-fpm", "postgres", "dockerd", "containerd", "sshd", "cron", "kanamed", "node", "redis-server"];
    const rows = cmds.map((command, i) => ({
      server_id: server.id,
      pid: i === 0 ? 1 : 300 + i * 113,
      ppid: i === 0 ? 0 : 1,
      user: ["nginx", "php-fpm"].includes(command) ? "www-data" : command === "postgres" ? "postgres" : "root",
      command,
      cmdline: `/usr/sbin/${command}${command === "nginx" ? " -g daemon on; master_process on;" : ""}`,
      state: i % 4 === 0 ? "running" : "sleeping",
      cpu_percent: Math.max(0, 12 - i * 1.3),
      memory_rss: (200 - i * 15) * 1024 * 1024,
      memory_percent: Math.max(0.1, 6 - i * 0.5),
      threads: 1 + (i % 5) * 3,
      nice: 0,
      started_at: minutesAgo(60 * 24 * 3),
    }));
    return ok(rows, 200, listMeta(rows.length));
  }

  if (seg[0] === "jobs" && seg[1]) {
    const job = jobs.get(seg[1]);
    if (!job) fail("not_found", "Job not found.", 404);
    if (method === "GET") {
      advance(job);
      return ok(jobView(job));
    }
    if (method === "POST" && seg[2] === "cancel") {
      if (!job.finished_at) {
        job.status = "cancelled";
        job.finished_at = nowIso();
      }
      return ok(jobView(job));
    }
  }

  if (seg[0] === "monitoring" && seg[1] === "overview") {
    return ok({
      fleet: {
        servers_total: servers.length,
        servers_connected: servers.filter((s) => s.connection === "connected").length,
      },
      servers: [],
    });
  }

  fail("not_found", `The mock backend has no route for ${method} ${path}.`, 404);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------------------------- terminal ---------------------------- */

interface Sink {
  onmessage: (event: TerminalEvent) => void;
}

interface MockTerminal {
  sink: Sink;
  line: string;
  prompt: string;
  closed: boolean;
}

const terminals = new Map<string, MockTerminal>();

function emit(t: MockTerminal, text: string) {
  if (t.closed) return;
  t.sink.onmessage({ kind: "data", b64: textToBase64(text) });
}

function runCommand(id: string, t: MockTerminal, cmd: string) {
  const [name] = cmd.trim().split(/\s+/);
  switch (name) {
    case undefined:
    case "":
      break;
    case "help":
      emit(t, "This is the Kaname Desktop mock shell. Try: uname -a, ls, whoami, date, clear, exit\r\n");
      break;
    case "uname":
      emit(t, "Linux mock 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\r\n");
      break;
    case "ls":
      emit(t, "\x1b[1;34mapps\x1b[0m  \x1b[1;34mbackups\x1b[0m  docker-compose.yml  README.md\r\n");
      break;
    case "whoami":
      emit(t, "ops\r\n");
      break;
    case "date":
      emit(t, `${new Date().toString()}\r\n`);
      break;
    case "clear":
      emit(t, "\x1b[2J\x1b[H");
      break;
    case "exit":
      emit(t, "logout\r\n");
      setTimeout(() => {
        t.sink.onmessage({ kind: "closed", code: 1000, reason: "session ended" });
        t.closed = true;
        terminals.delete(id);
      }, 50);
      return;
    default:
      emit(t, `${name}: command not found\r\n`);
  }
  emit(t, t.prompt);
}

function terminalOpen(c: Connection, args: Args): TerminalOpened {
  requireAuth(c);
  if (c.auth_kind === "api_key") {
    fail("terminal_needs_user", "Terminals need a signed-in user; API keys cannot open a shell.", null, {
      summary: "Add this panel again with “Email & password” sign-in to open terminals.",
      actions: [],
    });
  }
  const server = findServer(String(args.serverId));
  requireConnected(server);
  const container = args.containerId ? containers.find((x) => x.id === args.containerId) : undefined;
  const sink = args.onEvent as Sink;
  const id = uuid();
  const host = container ? `${container.name}@${server.name}` : server.name;
  const t: MockTerminal = {
    sink,
    line: "",
    prompt: container ? `\x1b[33mroot@${container.container_id.slice(0, 12)}\x1b[0m:/# ` : `\x1b[32mops@${server.name}\x1b[0m:\x1b[34m~\x1b[0m$ `,
    closed: false,
  };
  terminals.set(id, t);
  setTimeout(() => {
    emit(t, `\x1b[2mKaname mock terminal — ${host} (${args.cols}x${args.rows})\x1b[0m\r\n`);
    emit(t, "Type \x1b[1mhelp\x1b[0m for the few commands this echo shell knows.\r\n\r\n");
    emit(t, t.prompt);
  }, 80);
  return {
    terminal_id: id,
    server_id: server.id,
    server_name: server.name,
    container_name: container?.name ?? null,
    recorded: server.name.startsWith("db"),
  };
}

function terminalWrite(args: Args) {
  const t = terminals.get(String(args.terminalId));
  if (!t) fail("not_found", "That terminal is closed.");
  const text = base64ToText(String(args.b64));
  for (const ch of text) {
    if (ch === "\r") {
      emit(t, "\r\n");
      const cmd = t.line;
      t.line = "";
      runCommand(String(args.terminalId), t, cmd);
    } else if (ch === "\x7f") {
      if (t.line.length > 0) {
        t.line = t.line.slice(0, -1);
        emit(t, "\b \b");
      }
    } else if (ch === "\x03") {
      t.line = "";
      emit(t, `^C\r\n${t.prompt}`);
    } else if (ch >= " ") {
      t.line += ch;
      emit(t, ch);
    }
  }
  return null;
}

/* ----------------------------- router ----------------------------- */

export async function mockInvoke(command: string, args: Args): Promise<unknown> {
  if (LATENCY > 0 && command !== "terminal_write") await sleep(LATENCY);

  switch (command) {
    case "connections_list":
      return [...connections.values()].map((c) => ({ ...c }));

    case "connection_save": {
      const input = args.input as ConnectionInput;
      if (!input?.name?.trim()) fail("invalid_input", "Give the connection a name.");
      if (input.auth_kind === "api_key" && input.api_key && !input.api_key.startsWith("kn_")) {
        const error: DesktopError = {
          code: "invalid_input",
          message: "Some fields need attention.",
          status: null,
          remediation: null,
          fields: { api_key: "Kaname API keys start with kn_." },
        };
        throw error;
      }
      if (!/^https?:\/\//.test(input.base_url ?? "")) fail("invalid_input", "The URL must start with http:// or https://.");
      const existing = input.id ? getConnection(input.id) : undefined;
      const id = existing?.id ?? uuid();
      if (input.auth_kind === "api_key" && input.api_key) apiKeys.set(id, input.api_key);
      if (input.auth_kind !== "api_key") apiKeys.delete(id);
      if (existing && (existing.auth_kind !== input.auth_kind || existing.base_url !== input.base_url)) {
        signedIn.delete(id);
        if (existing.base_url !== input.base_url && !input.api_key) apiKeys.delete(id);
      }
      const saved: Connection = {
        id,
        name: input.name.trim(),
        base_url: input.base_url,
        auth_kind: input.auth_kind,
        email: input.email ?? existing?.email ?? null,
        color: input.color ?? null,
        accept_invalid_certs: input.accept_invalid_certs ?? false,
        created_at: existing?.created_at ?? nowIso(),
        last_connected_at: existing?.last_connected_at ?? null,
        has_credential: input.auth_kind === "api_key" ? apiKeys.has(id) : signedIn.has(id),
      };
      connections.set(id, saved);
      return { ...saved };
    }

    case "connection_delete": {
      const c = getConnection(args.id);
      connections.delete(c.id);
      signedIn.delete(c.id);
      apiKeys.delete(c.id);
      return null;
    }

    case "connection_test": {
      const url = String(args.baseUrl ?? "");
      if (url.includes("unreachable")) fail("network", `Could not reach ${url}.`, null, {
        summary: "Check the address and that the panel is running.",
        actions: [],
      });
      if (url.includes("notkaname")) fail("not_found", "That address is not a Kaname panel.", 404);
      if (url.includes("selfsigned") && !args.acceptInvalidCerts) fail("tls", "The panel's certificate is not trusted.", null, {
        summary: "Turn on “Accept self-signed certificate” if you reach this panel by IP.",
        actions: [],
      });
      return { reachable: true, version: "0.2.0", setup_required: url.includes("fresh") };
    }

    case "auth_login": {
      const c = getConnection(args.id);
      if (args.password === "wrong") {
        fail("invalid_credentials", "Email or password is incorrect.", 401);
      }
      if (!String(args.email).includes("@")) {
        const error: DesktopError = {
          code: "validation_failed",
          message: "Some fields need attention.",
          status: 422,
          remediation: null,
          fields: { email: "Enter a valid email address." },
        };
        throw error;
      }
      c.email = String(args.email);
      if (args.password === "totp") {
        const challenge = uuid();
        challenges.set(challenge, c.id);
        return { status: "totp_required", challenge } satisfies LoginResult;
      }
      signedIn.add(c.id);
      c.has_credential = true;
      c.last_connected_at = nowIso();
      return { status: "ok", session: sessionBody(c) } satisfies LoginResult;
    }

    case "auth_totp": {
      const c = getConnection(args.id);
      if (challenges.get(String(args.challenge)) !== c.id) fail("invalid_challenge", "That sign-in attempt expired. Start again.", 400);
      if (!/^\d{6}$/.test(String(args.code)) || args.code === "000000") fail("invalid_totp", "That code is not valid.", 400);
      challenges.delete(String(args.challenge));
      signedIn.add(c.id);
      c.has_credential = true;
      c.last_connected_at = nowIso();
      return { status: "ok", session: sessionBody(c) } satisfies LoginResult;
    }

    case "auth_session": {
      const c = getConnection(args.id);
      requireAuth(c);
      c.last_connected_at = nowIso();
      return sessionBody(c);
    }

    case "auth_logout": {
      const c = getConnection(args.id);
      signedIn.delete(c.id);
      if (c.auth_kind === "session") c.has_credential = false;
      return null;
    }

    case "api_request": {
      const c = getConnection(args.id);
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("..")) fail("invalid_input", "Invalid API path.");
      return apiRequest(c, String(args.method ?? "GET"), path, (args.query as Record<string, unknown>) ?? {});
    }

    case "terminal_open":
      return terminalOpen(getConnection(args.id), args);

    case "terminal_write":
      return terminalWrite(args);

    case "terminal_resize":
      if (!terminals.has(String(args.terminalId))) fail("not_found", "That terminal is closed.");
      return null;

    case "terminal_close": {
      const t = terminals.get(String(args.terminalId));
      if (t) {
        t.closed = true;
        terminals.delete(String(args.terminalId));
      }
      return null;
    }

    default:
      fail("not_found", `Unknown command ${command}.`);
  }
}
