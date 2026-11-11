import { z } from "zod";
import { isoDate, uuid } from "../primitives.js";
import { alertSeverity } from "../enums.js";
import { alert, alertRule, appAlertKind, type AppAlertKind } from "./fleet.js";

/* ------------------------------------------------------------------ *
 * App health — is an installed app answering, and is it well.
 *
 * Signals, collected by the control plane's app monitor (KD-041):
 *   - an HTTP(S) probe of the app's own address, once a minute;
 *   - for image recipes, its Kaname-labelled containers (state,
 *     healthcheck, restarts, CPU and memory), every other minute;
 *   - the certificate the install issued, read from the database;
 *   - the size of its managed data directory, every six hours.
 * Alert rules on these are ordinary alert rules with an app kind as
 * their metric (see `appAlertKind` in fleet.ts).
 * ------------------------------------------------------------------ */

/**
 * The path probed when nobody has chosen one. A recipe's own health
 * endpoint where it has one that answers 200 without signing in; "/"
 * otherwise. Keyed by recipe id.
 */
export const APP_HEALTH_PATHS: Readonly<Record<string, string>> = {
  wordpress: "/wp-login.php",
  dokuwiki: "/doku.php",
  ghost: "/ghost/api/admin/site/",
  nextcloud: "/status.php",
  "uptime-kuma": "/",
  n8n: "/healthz",
  gitea: "/api/healthz",
  plausible: "/api/health",
};

export function defaultHealthPath(appId: string): string {
  return APP_HEALTH_PATHS[appId] ?? "/";
}

/** A probe path: absolute, no scheme or host, no traversal, no whitespace. */
export const probePath = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/, "must be a path starting with /")
  .refine((p) => !p.split(/[/?]/).includes(".."), { message: "path traversal is not allowed" });

export const APP_ALERT_KIND_LABELS: Record<AppAlertKind, string> = {
  app_down: "App down",
  app_slow: "Slow responses",
  app_restart_loop: "Restart loop",
  app_container_unhealthy: "Container exited or unhealthy",
  app_memory: "High memory",
  app_cpu: "High CPU",
  app_cert_expiring: "Certificate expiring",
};

/** Unit of `threshold` per app kind, for forms and messages. */
export const APP_ALERT_KIND_UNITS: Record<AppAlertKind, string> = {
  app_down: "failed checks",
  app_slow: "ms",
  app_restart_loop: "restarts",
  app_container_unhealthy: "containers",
  app_memory: "%",
  app_cpu: "%",
  app_cert_expiring: "days",
};

/** Kinds that only make sense for an image recipe (they read container samples). */
export const CONTAINER_ALERT_KINDS: ReadonlySet<AppAlertKind> = new Set([
  "app_restart_loop",
  "app_container_unhealthy",
  "app_memory",
  "app_cpu",
]);

export interface AppRuleTemplate {
  kind: AppAlertKind;
  comparator: "gt" | "gte" | "lt" | "lte";
  threshold: number;
  duration_seconds: number;
  severity: z.infer<typeof alertSeverity>;
  /** Created with every install that the kind applies to. */
  default: boolean;
}

/**
 * Every app kind with its sensible starting point. The `default` ones
 * are created for each install (app down; restart loop for image
 * recipes; certificate expiring when it has HTTPS); the rest can be
 * added from the app's Health section and start disabled.
 */
export const APP_RULE_TEMPLATES: readonly AppRuleTemplate[] = [
  { kind: "app_down", comparator: "gte", threshold: 3, duration_seconds: 0, severity: "critical", default: true },
  { kind: "app_slow", comparator: "gt", threshold: 3000, duration_seconds: 600, severity: "warning", default: false },
  { kind: "app_restart_loop", comparator: "gte", threshold: 3, duration_seconds: 900, severity: "critical", default: true },
  { kind: "app_container_unhealthy", comparator: "gt", threshold: 0, duration_seconds: 240, severity: "critical", default: false },
  { kind: "app_memory", comparator: "gt", threshold: 90, duration_seconds: 600, severity: "warning", default: false },
  { kind: "app_cpu", comparator: "gt", threshold: 90, duration_seconds: 600, severity: "warning", default: false },
  { kind: "app_cert_expiring", comparator: "lte", threshold: 14, duration_seconds: 0, severity: "warning", default: true },
];

export const appHealthStatus = z.enum([
  /** The last probe answered 2xx and no critical app alert is firing. */
  "up",
  /** Answering, but an app alert is firing (slow, restarting, a container down). */
  "degraded",
  /** The last probe failed. */
  "down",
  /** Not probed yet, probing is off, or the install is not active. */
  "unknown",
]);
export type AppHealthStatus = z.infer<typeof appHealthStatus>;

export const appHealthPoint = z.object({ ts: isoDate, value: z.number() });

export const appContainerHealth = z.object({
  name: z.string(),
  /** io.kaname.role: "app", "db", "events". */
  role: z.string(),
  state: z.string(),
  status: z.string(),
  /** From the healthcheck, when the image defines one. */
  health: z.enum(["healthy", "unhealthy", "starting", "none"]),
  restart_count: z.number().int(),
  cpu_percent: z.number().nullable(),
  memory_bytes: z.number().nullable(),
  memory_limit: z.number().nullable(),
});
export type AppContainerHealth = z.infer<typeof appContainerHealth>;

export const appHealth = z.object({
  install_id: uuid,
  status: appHealthStatus,
  probe: z.object({
    url: z.string(),
    path: z.string(),
    default_path: z.string(),
    enabled: z.boolean(),
    last_checked_at: isoDate.nullable(),
    status_code: z.number().int().nullable(),
    latency_ms: z.number().int().nullable(),
    error: z.string().nullable(),
    consecutive_failures: z.number().int(),
  }),
  /** Share of successful probes, 0–100; null without any probe in the window. */
  uptime_24h: z.number().nullable(),
  uptime_7d: z.number().nullable(),
  /** Probe latency over 24 h, bucketed to at most 96 points. */
  latency: z.array(appHealthPoint),
  /** Image recipes only; null for a site recipe. */
  containers: z
    .object({
      sampled_at: isoDate.nullable(),
      total: z.number().int(),
      running: z.number().int(),
      unhealthy: z.number().int(),
      restart_count: z.number().int(),
      cpu_percent: z.number().nullable(),
      memory_bytes: z.number().nullable(),
      memory_limit: z.number().nullable(),
      items: z.array(appContainerHealth),
    })
    .nullable(),
  /** The certificate the install issued; its expiry warnings come from the certificate sweep. */
  certificate: z
    .object({ id: uuid, subject: z.string(), expires_at: isoDate.nullable(), days_left: z.number().int().nullable() })
    .nullable(),
  /** Size of the managed data directory; null for a site recipe or until first measured. */
  data: z.object({ bytes: z.number(), measured_at: isoDate }).nullable(),
  open_alerts: z.number().int(),
  recent_alerts: z.array(alert),
  rules: z.array(alertRule),
  /** Kinds this install supports that have no rule yet, for "Add rule". */
  available_kinds: z.array(appAlertKind),
  /** Whether the caller may tune, mute or add this app's rules. */
  can_manage: z.boolean(),
});
export type AppHealth = z.infer<typeof appHealth>;

/** One row per visible install, for the Installed list and homes. */
export const appHealthSummary = z.object({
  install_id: uuid,
  app_name: z.string(),
  domain: z.string(),
  status: appHealthStatus,
  uptime_24h: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  last_checked_at: isoDate.nullable(),
  open_alerts: z.number().int(),
});
export type AppHealthSummary = z.infer<typeof appHealthSummary>;

/** What a person may change on an app's rule. Scope, kind and channels stay put. */
export const updateAppAlertRuleInput = z
  .object({
    enabled: z.boolean(),
    threshold: z.number().min(0).max(1_000_000),
    duration_seconds: z.number().int().min(0).max(86_400),
    severity: alertSeverity,
  })
  .partial()
  .strict();
export type UpdateAppAlertRuleInput = z.infer<typeof updateAppAlertRuleInput>;

export const createAppAlertRuleInput = z.object({ kind: appAlertKind }).strict();

export const updateAppMonitorInput = z
  .object({ probe_path: probePath, probe_enabled: z.boolean() })
  .partial()
  .strict();
export type UpdateAppMonitorInput = z.infer<typeof updateAppMonitorInput>;
