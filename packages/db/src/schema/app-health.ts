import { bigint, boolean, index, integer, jsonb, pgTable, real, text, uuid } from "drizzle-orm/pg-core";
import type { AppContainerHealth } from "@kaname/contract";
import { pk, ts, timestamps } from "./common";
import { appInstalls } from "./apps";

/* ------------------------------------------------------------------ *
 * App health — what the monitor learned about each installed app.
 *
 * `app_monitors` is one row per install: how it is probed and the
 * running verdict the list pages read without touching the samples.
 * `app_health_samples` is the history behind it — one row per HTTP
 * probe and one per container poll — kept for eight days, which is
 * what a 7-day uptime figure needs and no more.
 *
 * Both cascade with the install, so uninstalling an app takes its
 * health history (and, through alert_rules.app_install_id, its alert
 * rules and their alerts) with it.
 * ------------------------------------------------------------------ */

export const appMonitors = pgTable("app_monitors", {
  appInstallId: uuid("app_install_id")
    .primaryKey()
    .references(() => appInstalls.id, { onDelete: "cascade" }),
  /** Path the HTTP probe requests, always starting with "/". */
  probePath: text("probe_path").notNull().default("/"),
  probeEnabled: boolean("probe_enabled").notNull().default(true),
  /** "up" | "down" | "unknown" — the latest probe's verdict. */
  status: text("status", { enum: ["up", "down", "unknown"] }).notNull().default("unknown"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastCheckedAt: ts("last_checked_at"),
  lastStatusCode: integer("last_status_code"),
  lastLatencyMs: integer("last_latency_ms"),
  lastError: text("last_error"),
  /** The latest container poll, per container (image recipes). */
  containers: jsonb("containers").$type<AppContainerHealth[]>().notNull().default([]),
  containersSampledAt: ts("containers_sampled_at"),
  /** Size of the managed data directory (image recipes), measured rarely. */
  dataBytes: bigint("data_bytes", { mode: "number" }),
  dataMeasuredAt: ts("data_measured_at"),
  /** When the default rules were created; null until they have been. */
  defaultsSeededAt: ts("defaults_seeded_at"),
  ...timestamps,
});

export const appHealthSamples = pgTable(
  "app_health_samples",
  {
    id: pk(),
    appInstallId: uuid("app_install_id")
      .notNull()
      .references(() => appInstalls.id, { onDelete: "cascade" }),
    ts: ts("ts").notNull().defaultNow(),
    kind: text("kind", { enum: ["http", "containers"] }).notNull(),
    /* http */
    ok: boolean("ok"),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    /* containers */
    containersTotal: integer("containers_total"),
    containersRunning: integer("containers_running"),
    containersUnhealthy: integer("containers_unhealthy"),
    restartCount: integer("restart_count"),
    cpuPercent: real("cpu_percent"),
    memoryBytes: bigint("memory_bytes", { mode: "number" }),
    memoryLimit: bigint("memory_limit", { mode: "number" }),
  },
  (t) => [index("app_health_samples_install_ts_idx").on(t.appInstallId, t.kind, t.ts)],
);
