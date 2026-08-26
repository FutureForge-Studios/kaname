import { z } from "zod";
import { absolutePath, bytes, fileMode, identifier, ipAddress, percent } from "../primitives.js";
import {
  containerState,
  dbEngine,
  fileKind,
  logLevel,
  processState,
  serviceActiveState,
  signalName,
  threatKind,
} from "../enums.js";

/* ------------------------------------------------------------------ *
 * Host-level shapes.
 *
 * These are what the agent reports. The REST resources in ../resources
 * compose them with control-plane fields (ids, sync timestamps, drift).
 * ------------------------------------------------------------------ */

/* ------------------------------- system ------------------------------ */

export const systemInfo = z.object({
  hostname: z.string(),
  machine_id: z.string(),
  os: z.string(),
  os_version: z.string(),
  os_family: z.string(),
  arch: z.string(),
  kernel: z.string(),
  boot_time: z.string(),
  uptime_seconds: z.number().int().nonnegative(),
  cpu_model: z.string(),
  cpu_cores: z.number().int().positive(),
  memory_total: bytes,
  swap_total: bytes,
  virtualization: z.string().optional(),
  timezone: z.string(),
  agent_version: z.string(),
  simulated: z.boolean().default(false),
});
export type SystemInfo = z.infer<typeof systemInfo>;

export const diskUsage = z.object({
  mount: z.string(),
  device: z.string(),
  fstype: z.string(),
  total: bytes,
  used: bytes,
  available: bytes,
  used_percent: percent,
  inodes_total: z.number().int().nonnegative().optional(),
  inodes_used: z.number().int().nonnegative().optional(),
});
export type DiskUsage = z.infer<typeof diskUsage>;

export const metricsSample = z.object({
  ts: z.string(),
  cpu_percent: percent,
  cpu_per_core: z.array(percent).optional(),
  memory_used: bytes,
  memory_total: bytes,
  memory_cached: bytes.optional(),
  swap_used: bytes,
  swap_total: bytes,
  load1: z.number().nonnegative(),
  load5: z.number().nonnegative(),
  load15: z.number().nonnegative(),
  processes: z.number().int().nonnegative(),
  disks: z.array(diskUsage),
  net_rx_bytes: bytes,
  net_tx_bytes: bytes,
  net_rx_rate: z.number().nonnegative(),
  net_tx_rate: z.number().nonnegative(),
  disk_read_rate: z.number().nonnegative().optional(),
  disk_write_rate: z.number().nonnegative().optional(),
});
export type MetricsSample = z.infer<typeof metricsSample>;

export const packageInfo = z.object({
  name: z.string(),
  installed_version: z.string(),
  available_version: z.string().nullable(),
  security: z.boolean().default(false),
});

/* ------------------------------ services ----------------------------- */

export const serviceInfo = z.object({
  unit: z.string(),
  description: z.string(),
  load_state: z.string(),
  active_state: serviceActiveState,
  sub_state: z.string(),
  enabled: z.boolean(),
  /** Present when the unit is running. */
  main_pid: z.number().int().nullable(),
  memory_current: bytes.nullable(),
  cpu_usage_ns: z.number().nonnegative().nullable(),
  active_since: z.string().nullable(),
  restart_count: z.number().int().nonnegative().default(0),
});
export type ServiceInfo = z.infer<typeof serviceInfo>;

/* ----------------------------- processes ----------------------------- */

export const processInfo = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  command: z.string(),
  /** argv joined, already truncated by the agent. */
  cmdline: z.string(),
  state: processState,
  cpu_percent: percent,
  memory_rss: bytes,
  memory_percent: percent,
  threads: z.number().int().nonnegative(),
  started_at: z.string(),
  nice: z.number().int(),
});
export type ProcessInfo = z.infer<typeof processInfo>;

/* ----------------------------- containers ---------------------------- */

export const containerPort = z.object({
  container_port: z.number().int(),
  host_port: z.number().int().nullable(),
  host_ip: z.string().nullable(),
  protocol: z.enum(["tcp", "udp"]),
});

export const containerInfo = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  image_id: z.string(),
  state: containerState,
  status: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  ports: z.array(containerPort),
  labels: z.record(z.string(), z.string()),
  networks: z.array(z.string()),
  mounts: z.array(z.object({ source: z.string(), destination: z.string(), rw: z.boolean() })),
  restart_count: z.number().int().nonnegative().default(0),
  cpu_percent: percent.nullable(),
  memory_usage: bytes.nullable(),
  memory_limit: bytes.nullable(),
  runtime: z.enum(["docker", "podman"]),
});
export type ContainerInfo = z.infer<typeof containerInfo>;

export const imageInfo = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  size: bytes,
  created_at: z.string(),
  in_use: z.boolean(),
});

/* ------------------------------- files ------------------------------- */

export const fileEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: fileKind,
  size: bytes,
  mode: fileMode,
  owner: z.string(),
  group: z.string(),
  uid: z.number().int(),
  gid: z.number().int(),
  modified_at: z.string(),
  /** Target of a symlink, else null. */
  link_target: z.string().nullable(),
  /** Set on directories once computed; usage is expensive so it is opt-in. */
  child_count: z.number().int().nonnegative().nullable(),
  mime: z.string().nullable(),
  is_editable: z.boolean(),
});
export type FileEntry = z.infer<typeof fileEntry>;

export const directoryListing = z.object({
  path: absolutePath,
  parent: z.string().nullable(),
  entries: z.array(fileEntry),
  truncated: z.boolean().default(false),
  total: z.number().int().nonnegative(),
});
export type DirectoryListing = z.infer<typeof directoryListing>;

export const storageUsageEntry = z.object({
  path: z.string(),
  bytes,
  inodes: z.number().int().nonnegative().nullable(),
  kind: z.enum(["directory", "mount", "category"]),
  label: z.string().optional(),
});

/* -------------------------------- logs ------------------------------- */

export const logSource = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  /** journald unit, file path or container id depending on kind. */
  ref: z.string(),
  size: bytes.nullable(),
  supports_follow: z.boolean().default(true),
});
export type LogSource = z.infer<typeof logSource>;

export const logRecord = z.object({
  ts: z.string(),
  level: logLevel,
  source: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
  /** Monotonic cursor for resuming a tail. */
  cursor: z.string().optional(),
});
export type LogRecord = z.infer<typeof logRecord>;

/* --------------------------- mail / dns / db ------------------------- */

export const dkimKeyInfo = z.object({
  selector: z.string(),
  public_key: z.string(),
  key_bits: z.number().int(),
  txt_value: z.string(),
});

export const mailQueueEntry = z.object({
  queue_id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  size: bytes,
  arrived_at: z.string(),
  reason: z.string().nullable(),
});

export const resolvedRecord = z.object({
  name: z.string(),
  type: z.string(),
  values: z.array(z.string()),
  ttl: z.number().int().nonnegative().nullable(),
  /** Which resolver answered, so a mismatch can be explained. */
  resolver: z.string(),
});
export type ResolvedRecord = z.infer<typeof resolvedRecord>;

export const dbInstanceInfo = z.object({
  engine: dbEngine,
  version: z.string(),
  host: z.string(),
  port: z.number().int(),
  reachable: z.boolean(),
  uptime_seconds: z.number().int().nullable(),
  connections: z.number().int().nullable(),
  max_connections: z.number().int().nullable(),
  data_size: bytes.nullable(),
});

export const dbDatabaseInfo = z.object({
  name: z.string(),
  owner: z.string().nullable(),
  encoding: z.string(),
  collation: z.string().nullable(),
  size_bytes: bytes,
  table_count: z.number().int().nonnegative(),
});

export const dbUserInfo = z.object({
  username: z.string(),
  host_pattern: z.string(),
  auth_plugin: z.string().nullable(),
  is_superuser: z.boolean().default(false),
  can_login: z.boolean().default(true),
});

/* ------------------------------ security ----------------------------- */

export const firewallRuleInfo = z.object({
  id: z.string(),
  priority: z.number().int(),
  action: z.string(),
  direction: z.string(),
  protocol: z.string(),
  port_spec: z.string().nullable(),
  source: z.string().nullable(),
  destination: z.string().nullable(),
  comment: z.string().nullable(),
  enabled: z.boolean(),
  backend: z.enum(["nftables", "iptables", "ufw"]),
});

export const banEntry = z.object({
  ip: ipAddress,
  jail: z.string(),
  banned_at: z.string(),
  expires_at: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
});

export const threatObservation = z.object({
  kind: threatKind,
  source_ip: ipAddress,
  target: z.string(),
  attempts: z.number().int().positive(),
  first_seen: z.string(),
  last_seen: z.string(),
  sample: z.string().optional(),
});
export type ThreatObservation = z.infer<typeof threatObservation>;

export const sshKeyInfo = z.object({
  fingerprint: z.string(),
  type: z.string(),
  comment: z.string(),
  public_key: z.string(),
  user: identifier,
});

export const sshConfigInfo = z.object({
  port: z.number().int(),
  permit_root_login: z.enum(["yes", "no", "prohibit-password", "forced-commands-only"]),
  password_authentication: z.boolean(),
  pubkey_authentication: z.boolean(),
  max_auth_tries: z.number().int(),
  allow_users: z.array(z.string()),
  allow_groups: z.array(z.string()),
  x11_forwarding: z.boolean(),
});

export const sshSessionInfo = z.object({
  user: z.string(),
  from_ip: ipAddress,
  tty: z.string(),
  pid: z.number().int(),
  started_at: z.string(),
  idle_seconds: z.number().int().nonnegative(),
});

/* ------------------------------ backups ------------------------------ */

export const backupSnapshotInfo = z.object({
  id: z.string(),
  taken_at: z.string(),
  bytes,
  file_count: z.number().int().nonnegative(),
  paths: z.array(z.string()),
  tags: z.array(z.string()),
  verified: z.boolean().default(false),
});

/* -------------------------------- pty -------------------------------- */

export const ptyOpenParams = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  /** Optional working directory; defaults to the login shell's own. */
  cwd: absolutePath.optional(),
  /** POSIX user to run as. Defaults to root; the control plane audits it. */
  user: identifier.optional(),
  term: z.string().max(32).default("xterm-256color"),
});

export const ptyResizeParams = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export const signalParams = z.object({
  pid: z.number().int().positive(),
  signal: signalName,
});
