import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentConnection,
  ContainerState,
  DiskUsage,
  HealthState,
  ServerCapability,
  ServiceActiveState,
} from "@kaname/contract";
import { pk, timestamps, ts } from "./common";
import { users } from "./identity";

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

export const servers = pgTable(
  "servers",
  {
    id: pk(),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    address: text("address"),
    provider: text("provider"),

    os: text("os"),
    osFamily: text("os_family"),
    osVersion: text("os_version"),
    arch: text("arch"),
    kernel: text("kernel"),
    machineId: text("machine_id"),
    cpuModel: text("cpu_model"),
    cpuCores: integer("cpu_cores"),
    memoryTotal: bigint("memory_total", { mode: "number" }),
    timezone: text("timezone"),
    virtualization: text("virtualization"),

    agentVersion: text("agent_version"),
    capabilities: text("capabilities")
      .array()
      .$type<ServerCapability[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    simulated: boolean("simulated").notNull().default(false),

    /** "Can we reach the box." Maintained by the agent hub. */
    connection: text("connection").$type<AgentConnection>().notNull().default("never_enrolled"),
    /** "Is the box OK." Maintained by the health evaluator. Independent axis. */
    health: text("health").$type<HealthState>().notNull().default("unknown"),
    healthReasons: text("health_reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    lastSeenAt: ts("last_seen_at"),
    enrolledAt: ts("enrolled_at"),
    bootTime: ts("boot_time"),

    /** Client certificate identity. Revoking clears these and drops the socket. */
    certSerial: text("cert_serial"),
    certFingerprint: text("cert_fingerprint"),
    /** Public half only — used to verify the agent's proof of possession. */
    certPem: text("cert_pem"),
    certExpiresAt: ts("cert_expires_at"),
    revokedAt: ts("revoked_at"),

    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("servers_name_key").on(t.name),
    index("servers_connection_idx").on(t.connection),
    index("servers_health_idx").on(t.health),
    uniqueIndex("servers_cert_serial_key").on(t.certSerial),
  ],
);

export const enrollmentTokens = pgTable(
  "enrollment_tokens",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("enrollment_tokens_hash_key").on(t.tokenHash),
    index("enrollment_tokens_server_idx").on(t.serverId),
  ],
);

/* ------------------------------------------------------------------ *
 * Metrics
 *
 * Raw samples at the agent's push cadence with a short retention, plus
 * 5-minute rollups kept for the full window. Both are plain tables; a
 * retention job prunes them. Partitioning is a later optimisation that
 * does not change the query shape.
 * ------------------------------------------------------------------ */

const metricColumns = {
  cpuPercent: real("cpu_percent").notNull(),
  memoryUsed: bigint("memory_used", { mode: "number" }).notNull(),
  memoryTotal: bigint("memory_total", { mode: "number" }).notNull(),
  swapUsed: bigint("swap_used", { mode: "number" }).notNull().default(0),
  swapTotal: bigint("swap_total", { mode: "number" }).notNull().default(0),
  load1: real("load1").notNull().default(0),
  load5: real("load5").notNull().default(0),
  load15: real("load15").notNull().default(0),
  processes: integer("processes").notNull().default(0),
  netRxRate: doublePrecision("net_rx_rate").notNull().default(0),
  netTxRate: doublePrecision("net_tx_rate").notNull().default(0),
  netRxBytes: bigint("net_rx_bytes", { mode: "number" }).notNull().default(0),
  netTxBytes: bigint("net_tx_bytes", { mode: "number" }).notNull().default(0),
  diskReadRate: doublePrecision("disk_read_rate"),
  diskWriteRate: doublePrecision("disk_write_rate"),
  disks: jsonb("disks").$type<DiskUsage[]>().notNull().default([]),
};

export const serverMetrics = pgTable(
  "server_metrics",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    ts: ts("ts").notNull().defaultNow(),
    ...metricColumns,
  },
  (t) => [index("server_metrics_server_ts_idx").on(t.serverId, t.ts)],
);

export const serverMetrics5m = pgTable(
  "server_metrics_5m",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    bucket: ts("bucket").notNull(),
    samples: integer("samples").notNull().default(1),
    ...metricColumns,
  },
  (t) => [uniqueIndex("server_metrics_5m_key").on(t.serverId, t.bucket)],
);

/* ------------------------------------------------------------------ *
 * Cached host inventory (KD-012 — staleness is surfaced, not hidden)
 * ------------------------------------------------------------------ */

export const services = pgTable(
  "services",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    unit: text("unit").notNull(),
    description: text("description").notNull().default(""),
    loadState: text("load_state").notNull().default("loaded"),
    activeState: text("active_state").$type<ServiceActiveState>().notNull().default("unknown"),
    subState: text("sub_state").notNull().default(""),
    enabled: boolean("enabled").notNull().default(false),
    mainPid: integer("main_pid"),
    memoryCurrent: bigint("memory_current", { mode: "number" }),
    activeSince: ts("active_since"),
    restartCount: integer("restart_count").notNull().default(0),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("services_server_unit_key").on(t.serverId, t.unit),
    index("services_state_idx").on(t.serverId, t.activeState),
  ],
);

export const containers = pgTable(
  "containers",
  {
    id: pk(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    containerId: text("container_id").notNull(),
    name: text("name").notNull(),
    image: text("image").notNull(),
    imageId: text("image_id").notNull().default(""),
    state: text("state").$type<ContainerState>().notNull().default("unknown"),
    status: text("status").notNull().default(""),
    runtime: text("runtime", { enum: ["docker", "podman"] })
      .notNull()
      .default("docker"),
    ports: jsonb("ports").$type<unknown[]>().notNull().default([]),
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    networks: text("networks")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    mounts: jsonb("mounts").$type<unknown[]>().notNull().default([]),
    restartCount: integer("restart_count").notNull().default(0),
    cpuPercent: real("cpu_percent"),
    memoryUsage: bigint("memory_usage", { mode: "number" }),
    memoryLimit: bigint("memory_limit", { mode: "number" }),
    createdAtHost: ts("created_at_host"),
    startedAt: ts("started_at"),
    lastSyncedAt: ts("last_synced_at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("containers_server_cid_key").on(t.serverId, t.containerId),
    index("containers_state_idx").on(t.serverId, t.state),
  ],
);

/* ------------------------------------------------------------------ *
 * Alerting
 * ------------------------------------------------------------------ */

export const alertRules = pgTable(
  "alert_rules",
  {
    id: pk(),
    name: text("name").notNull(),
    metric: text("metric").notNull(),
    comparator: text("comparator", { enum: ["gt", "gte", "lt", "lte"] }).notNull(),
    threshold: doublePrecision("threshold").notNull(),
    durationSeconds: integer("duration_seconds").notNull().default(300),
    severity: text("severity", { enum: ["info", "warning", "critical"] })
      .notNull()
      .default("warning"),
    scope: jsonb("scope")
      .$type<{ kind: "fleet" } | { kind: "servers"; server_ids: string[] }>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    channels: uuid("channels")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ...timestamps,
  },
  (t) => [index("alert_rules_metric_idx").on(t.metric)],
);

export const alerts = pgTable(
  "alerts",
  {
    id: pk(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "cascade" }),
    state: text("state", { enum: ["ok", "pending", "firing", "resolved", "silenced"] })
      .notNull()
      .default("pending"),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    value: doublePrecision("value").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    message: text("message").notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: ts("acknowledged_at"),
    ...timestamps,
  },
  (t) => [
    index("alerts_state_idx").on(t.state),
    index("alerts_server_idx").on(t.serverId),
    uniqueIndex("alerts_open_key")
      .on(t.ruleId, t.serverId)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

/* ---------------------------- relations ---------------------------- */

export const serversRelations = relations(servers, ({ many }) => ({
  services: many(services),
  containers: many(containers),
  metrics: many(serverMetrics),
}));

export const servicesRelations = relations(services, ({ one }) => ({
  server: one(servers, { fields: [services.serverId], references: [servers.id] }),
}));

export const containersRelations = relations(containers, ({ one }) => ({
  server: one(servers, { fields: [containers.serverId], references: [servers.id] }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  rule: one(alertRules, { fields: [alerts.ruleId], references: [alertRules.id] }),
  server: one(servers, { fields: [alerts.serverId], references: [servers.id] }),
}));
