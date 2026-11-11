/* ------------------------------------------------------------------ *
 * Typed helpers over `api_request` for the panel endpoints the desktop
 * uses. Shapes follow packages/contract/src/resources/fleet.ts and
 * src/jobs.ts, but every field past the id is optional here: the
 * desktop may talk to an older or newer panel than it was built with.
 * ------------------------------------------------------------------ */

import { apiRequest, type QueryValue } from "./ipc";
import { jobFromAccepted, parseJob, type Job } from "./jobs";

export type AgentConnection = "connected" | "degraded" | "disconnected" | "never_enrolled" | string;
export type HealthState = "healthy" | "warning" | "critical" | "unknown" | string;

export interface Server {
  id: string;
  name: string;
  hostname?: string;
  address?: string | null;
  provider?: string | null;
  os?: string | null;
  os_family?: string | null;
  os_version?: string | null;
  arch?: string | null;
  kernel?: string | null;
  cpu_model?: string | null;
  cpu_cores?: number | null;
  memory_total?: number | null;
  agent_version?: string | null;
  capabilities?: string[];
  connection?: AgentConnection;
  health?: HealthState;
  health_reasons?: string[];
  last_seen_at?: string | null;
  uptime_seconds?: number | null;
  labels?: Record<string, string>;
  latest?: {
    cpu_percent?: number;
    memory_used?: number;
    memory_total?: number;
    load1?: number;
    disks?: { mount?: string; used?: number; total?: number }[];
    net_rx_rate?: number;
    net_tx_rate?: number;
    sampled_at?: string;
  } | null;
  counts?: { containers?: number; services_failed?: number; open_alerts?: number };
}

export interface Service {
  id: string;
  server_id?: string;
  unit: string;
  description?: string;
  active_state?: string;
  sub_state?: string;
  enabled?: boolean;
  main_pid?: number | null;
  memory_current?: number | null;
  restart_count?: number;
  last_synced_at?: string;
}

export interface Container {
  id: string;
  server_id?: string;
  container_id?: string;
  name: string;
  image?: string;
  state?: string;
  status?: string;
  runtime?: string;
  restart_count?: number;
  cpu_percent?: number | null;
  memory_usage?: number | null;
  last_synced_at?: string;
}

export interface ProcessRow {
  pid: number;
  ppid?: number;
  user?: string;
  command?: string;
  cmdline?: string;
  state?: string;
  cpu_percent?: number;
  memory_rss?: number;
  memory_percent?: number;
  threads?: number;
}

export interface MetricSample {
  ts: string;
  cpu_percent?: number | null;
  memory_used?: number | null;
  memory_total?: number | null;
  load1?: number | null;
}

export interface ServerMetrics {
  server_id?: string;
  range?: string;
  samples: MetricSample[];
}

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export async function listServers(id: string, q?: string): Promise<Server[]> {
  const query: Record<string, QueryValue> = { per_page: 100 };
  if (q) query.q = q;
  const res = await apiRequest<Server[]>({ id, method: "GET", path: "/servers", query });
  return asArray<Server>(res.data);
}

export async function getServer(id: string, serverId: string): Promise<Server | null> {
  const res = await apiRequest<Server>({
    id,
    method: "GET",
    path: `/servers/${encodeURIComponent(serverId)}`,
  });
  return res.data;
}

export async function getServerMetrics(id: string, serverId: string): Promise<ServerMetrics> {
  const res = await apiRequest<ServerMetrics>({
    id,
    method: "GET",
    path: `/servers/${encodeURIComponent(serverId)}/metrics`,
    query: { range: "1h" },
  });
  return { samples: asArray<MetricSample>(res.data?.samples), ...(res.data ?? {}) };
}

export async function listServices(id: string, serverId: string): Promise<Service[]> {
  const res = await apiRequest<Service[]>({
    id,
    method: "GET",
    path: "/services",
    query: { server_id: serverId, per_page: 100 },
  });
  return asArray<Service>(res.data);
}

export async function listContainers(id: string, serverId: string): Promise<Container[]> {
  const res = await apiRequest<Container[]>({
    id,
    method: "GET",
    path: "/containers",
    query: { server_id: serverId, per_page: 100 },
  });
  return asArray<Container>(res.data);
}

export async function listProcesses(id: string, serverId: string): Promise<ProcessRow[]> {
  const res = await apiRequest<ProcessRow[]>({
    id,
    method: "GET",
    path: "/processes",
    query: { server_id: serverId, sort: "cpu", limit: 200 },
  });
  return asArray<ProcessRow>(res.data);
}

export type ServiceAction = "start" | "stop" | "restart" | "reload";
export type ContainerAction = "start" | "stop" | "restart";

async function mutation(id: string, path: string): Promise<Job | null> {
  const res = await apiRequest({ id, method: "POST", path });
  return jobFromAccepted(res.data);
}

export const serviceAction = (id: string, serviceId: string, action: ServiceAction) =>
  mutation(id, `/services/${encodeURIComponent(serviceId)}/${action}`);

export const containerAction = (id: string, containerId: string, action: ContainerAction) =>
  mutation(id, `/containers/${encodeURIComponent(containerId)}/${action}`);

export async function getJob(id: string, jobId: string): Promise<Job | null> {
  const res = await apiRequest({ id, method: "GET", path: `/jobs/${encodeURIComponent(jobId)}` });
  return parseJob(res.data);
}

export async function cancelJob(id: string, jobId: string): Promise<void> {
  await apiRequest({ id, method: "POST", path: `/jobs/${encodeURIComponent(jobId)}/cancel` });
}

/* ------------------------ display helpers ------------------------- */

export function serverAddress(server: Server): string {
  return server.address || server.hostname || "—";
}

export function serverOs(server: Server): string {
  if (server.os) return server.os;
  const parts = [server.os_family, server.os_version].filter(Boolean);
  return parts.length ? parts.join(" ") : "—";
}

export function isReachable(server: Server): boolean {
  return server.connection === "connected" || server.connection === "degraded";
}
