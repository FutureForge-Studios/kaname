import { z } from "zod";
import {
  bytes,
  hostname as hostnameSchema,
  identifier,
  ipAddress,
  isoDate,
  listQuery,
  percent,
  uuid,
} from "../primitives.js";
import {
  agentConnection,
  alertComparator,
  alertSeverity,
  alertState,
  containerState,
  cpuArch,
  healthState,
  metricName,
  osFamily,
  processState,
  serverCapability,
  serviceActiveState,
  signalName,
  timeRange,
} from "../enums.js";
import { containerPort, diskUsage } from "../agent/payloads.js";

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

export const server = z.object({
  id: uuid,
  name: z.string(),
  hostname: z.string(),
  address: z.string().nullable(),
  provider: z.string().nullable(),
  os: z.string().nullable(),
  os_family: osFamily.nullable(),
  os_version: z.string().nullable(),
  arch: cpuArch.nullable(),
  kernel: z.string().nullable(),
  cpu_model: z.string().nullable(),
  cpu_cores: z.number().int().nullable(),
  memory_total: bytes.nullable(),
  timezone: z.string().nullable(),

  agent_version: z.string().nullable(),
  capabilities: z.array(serverCapability),
  /** "Can we reach the box." Independent of `health`. */
  connection: agentConnection,
  /** "Is the box OK." Independent of `connection`. */
  health: healthState,
  health_reasons: z.array(z.string()).default([]),
  simulated: z.boolean().default(false),

  last_seen_at: isoDate.nullable(),
  enrolled_at: isoDate.nullable(),
  cert_expires_at: isoDate.nullable(),
  boot_time: isoDate.nullable(),
  uptime_seconds: z.number().int().nullable(),

  labels: z.record(z.string(), z.string()).default({}),
  notes: z.string().nullable(),

  /** Latest sample, denormalised so fleet lists render in one query. */
  latest: z
    .object({
      cpu_percent: percent,
      memory_used: bytes,
      memory_total: bytes,
      swap_used: bytes,
      load1: z.number(),
      disks: z.array(diskUsage),
      net_rx_rate: z.number(),
      net_tx_rate: z.number(),
      sampled_at: isoDate,
    })
    .nullable(),

  counts: z
    .object({
      sites: z.number().int(),
      containers: z.number().int(),
      services_failed: z.number().int(),
      mailboxes: z.number().int(),
      databases: z.number().int(),
      open_alerts: z.number().int(),
    })
    .optional(),

  created_at: isoDate,
  updated_at: isoDate,
});
export type Server = z.infer<typeof server>;

export const createServerInput = z.object({
  name: z.string().min(1).max(64),
  hostname: hostnameSchema,
  address: z.string().max(255).optional(),
  provider: z.string().max(64).optional(),
  labels: z.record(z.string(), z.string()).default({}),
  notes: z.string().max(2000).optional(),
});
export type CreateServerInput = z.infer<typeof createServerInput>;

export const updateServerInput = createServerInput.partial();

export const serverListQuery = listQuery.extend({
  connection: agentConnection.optional(),
  health: healthState.optional(),
  capability: serverCapability.optional(),
  label: z.string().max(128).optional(),
});

export const enrollmentInstructions = z.object({
  server_id: uuid,
  token: z.string(),
  expires_at: isoDate,
  /** Ready-to-paste install command. */
  command: z.string(),
  control_plane_url: z.string(),
  fingerprint: z.string(),
});
export type EnrollmentInstructions = z.infer<typeof enrollmentInstructions>;

/* ------------------------------------------------------------------ *
 * Services
 * ------------------------------------------------------------------ */

export const service = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  unit: z.string(),
  description: z.string(),
  load_state: z.string(),
  active_state: serviceActiveState,
  sub_state: z.string(),
  enabled: z.boolean(),
  main_pid: z.number().int().nullable(),
  memory_current: bytes.nullable(),
  active_since: isoDate.nullable(),
  restart_count: z.number().int(),
  /** How stale this row is. Surfaced in the UI, never hidden (KD-012). */
  last_synced_at: isoDate,
});
export type Service = z.infer<typeof service>;

export const serviceListQuery = listQuery.extend({
  server_id: uuid.optional(),
  active_state: serviceActiveState.optional(),
  enabled: z.coerce.boolean().optional(),
});

export const serviceAction = z.enum(["start", "stop", "restart", "reload", "enable", "disable"]);
export type ServiceAction = z.infer<typeof serviceAction>;

/* ------------------------------------------------------------------ *
 * Processes  (never cached — always a live pass-through read)
 * ------------------------------------------------------------------ */

export const processRow = z.object({
  server_id: uuid,
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  command: z.string(),
  cmdline: z.string(),
  state: processState,
  cpu_percent: percent,
  memory_rss: bytes,
  memory_percent: percent,
  threads: z.number().int(),
  nice: z.number().int(),
  started_at: isoDate,
  depth: z.number().int().optional(),
});
export type ProcessRow = z.infer<typeof processRow>;

export const processListQuery = z.object({
  server_id: uuid,
  q: z.string().max(200).optional(),
  user: identifier.optional(),
  sort: z.enum(["cpu", "memory", "pid", "name"]).default("cpu"),
  view: z.enum(["flat", "tree"]).default("flat"),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

export const signalProcessInput = z.object({
  pid: z.number().int().positive(),
  signal: signalName.default("SIGTERM"),
});

/* ------------------------------------------------------------------ *
 * Containers
 * ------------------------------------------------------------------ */

export const container = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  container_id: z.string(),
  name: z.string(),
  image: z.string(),
  image_id: z.string(),
  state: containerState,
  status: z.string(),
  runtime: z.enum(["docker", "podman"]),
  ports: z.array(containerPort),
  labels: z.record(z.string(), z.string()),
  networks: z.array(z.string()),
  restart_count: z.number().int(),
  cpu_percent: percent.nullable(),
  memory_usage: bytes.nullable(),
  memory_limit: bytes.nullable(),
  created_at_host: isoDate,
  started_at: isoDate.nullable(),
  last_synced_at: isoDate,
});
export type Container = z.infer<typeof container>;

export const containerListQuery = listQuery.extend({
  server_id: uuid.optional(),
  state: containerState.optional(),
  image: z.string().max(200).optional(),
});

export const containerAction = z.enum(["start", "stop", "restart", "remove"]);

/* ------------------------------------------------------------------ *
 * Monitoring
 * ------------------------------------------------------------------ */

export const metricPoint = z.object({ ts: isoDate, value: z.number() });

export const metricSeries = z.object({
  server_id: uuid,
  server_name: z.string(),
  metric: metricName,
  unit: z.enum(["percent", "bytes", "bytes_per_second", "count", "load"]),
  points: z.array(metricPoint),
});
export type MetricSeries = z.infer<typeof metricSeries>;

export const seriesQuery = z.object({
  metric: metricName,
  range: timeRange.default("24h"),
  server_id: uuid.optional(),
  /** Bucket size hint in seconds; the API picks a sane value if omitted. */
  step: z.coerce.number().int().min(10).max(86400).optional(),
});

export const monitoringOverview = z.object({
  fleet: z.object({
    servers_total: z.number().int(),
    servers_connected: z.number().int(),
    servers_unhealthy: z.number().int(),
    cpu_percent_avg: percent,
    memory_used: bytes,
    memory_total: bytes,
    disk_used: bytes,
    disk_total: bytes,
    net_rx_rate: z.number(),
    net_tx_rate: z.number(),
    open_alerts: z.number().int(),
  }),
  servers: z.array(
    z.object({
      server_id: uuid,
      name: z.string(),
      connection: agentConnection,
      health: healthState,
      cpu_percent: percent,
      memory_percent: percent,
      disk_percent: percent,
      load1: z.number(),
      uptime_seconds: z.number().int().nullable(),
      sparkline: z.array(z.number()).max(96),
    }),
  ),
});
export type MonitoringOverview = z.infer<typeof monitoringOverview>;

export const alertRule = z.object({
  id: uuid,
  name: z.string(),
  metric: metricName,
  comparator: alertComparator,
  threshold: z.number(),
  duration_seconds: z.number().int(),
  severity: alertSeverity,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fleet") }),
    z.object({ kind: z.literal("servers"), server_ids: z.array(uuid) }),
  ]),
  enabled: z.boolean(),
  channels: z.array(uuid).default([]),
  created_at: isoDate,
  updated_at: isoDate,
});
export type AlertRule = z.infer<typeof alertRule>;

export const alert = z.object({
  id: uuid,
  rule_id: uuid,
  rule_name: z.string(),
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  state: alertState,
  severity: alertSeverity,
  value: z.number(),
  threshold: z.number(),
  message: z.string(),
  started_at: isoDate,
  resolved_at: isoDate.nullable(),
  acknowledged_by: uuid.nullable(),
});
export type Alert = z.infer<typeof alert>;

export const createAlertRuleInput = alertRule
  .omit({ id: true, created_at: true, updated_at: true })
  .partial({ enabled: true, channels: true });

/* ------------------------------------------------------------------ *
 * Command Center
 * ------------------------------------------------------------------ */

export const commandCenterSummary = z.object({
  fleet: monitoringOverview.shape.fleet,
  attention: z.array(
    z.object({
      kind: z.enum([
        "agent_offline",
        "disk_pressure",
        "cert_expiring",
        "backup_failed",
        "service_failed",
        "mail_auth_failing",
        "threat_spike",
        "job_failed",
        "update_available",
      ]),
      severity: alertSeverity,
      title: z.string(),
      detail: z.string(),
      server_id: uuid.nullable(),
      server_name: z.string().nullable(),
      href: z.string(),
      since: isoDate,
    }),
  ),
  recent_jobs: z.array(z.unknown()),
  recent_audit: z.array(z.unknown()),
  certificates_expiring: z.array(
    z.object({ id: uuid, subject: z.string(), expires_at: isoDate, days_left: z.number().int() }),
  ),
  backups: z.object({
    last_success_at: isoDate.nullable(),
    failing_schedules: z.number().int(),
    protected_bytes: bytes,
  }),
  threats_24h: z.object({
    blocked: z.number().int(),
    observed: z.number().int(),
    top_sources: z.array(
      z.object({ ip: ipAddress, attempts: z.number().int(), country: z.string().nullable() }),
    ),
  }),
});
export type CommandCenterSummary = z.infer<typeof commandCenterSummary>;
