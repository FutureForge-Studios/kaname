import { apiUrl, ownerEmail, ownerPassword } from "./config.js";

/* ------------------------------------------------------------------ *
 * A tiny API client, used only to look identifiers up.
 *
 * A spec that hard-coded a server uuid would break on every reseed, and
 * one that clicked its way to a detail page to find one would be
 * testing navigation twice. Assertions stay in the browser; this just
 * answers "which row is forge-01".
 * ------------------------------------------------------------------ */

export interface FleetServer {
  id: string;
  name: string;
  hostname: string;
  connection: string;
  health: string;
  simulated: boolean;
  capabilities: string[];
}

export interface MailDomainSummary {
  id: string;
  domain_name: string;
}

export interface TerminalSessionSummary {
  id: string;
  server_name: string;
  user_name: string;
  recording_available: boolean;
}

let session: string | null = null;

async function cookie(): Promise<string> {
  if (session) return session;
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
  });
  if (!res.ok) throw new Error(`api sign-in failed (${res.status})`);
  const set = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!set) throw new Error("api sign-in returned no session cookie");
  session = set;
  return session;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUrl}/api/v1${path}`, { headers: { cookie: await cookie() } });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

export async function fleet(): Promise<FleetServer[]> {
  return apiGet<FleetServer[]>("/servers?per_page=100");
}

export async function serverNamed(name: string): Promise<FleetServer> {
  const found = (await fleet()).find((server) => server.name === name);
  if (!found) throw new Error(`no server named ${name} in the seeded fleet`);
  return found;
}

export async function mailDomains(): Promise<MailDomainSummary[]> {
  return apiGet<MailDomainSummary[]>("/mail-domains?per_page=100");
}

export async function terminalSessions(serverId: string): Promise<TerminalSessionSummary[]> {
  return apiGet<TerminalSessionSummary[]>(
    `/terminal/sessions?server_id=${serverId}&per_page=10&sort=started_at&order=desc`,
  );
}
