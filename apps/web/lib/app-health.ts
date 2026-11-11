import { APP_ALERT_KIND_UNITS, type AlertRule, type AppAlertKind } from "@kaname/contract";
import { formatCount } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * App alert rules in words, shared by Monitoring → Alert rules and the
 * app's own Health section: "3 failed checks in a row", not
 * "app_down ≥ 3".
 * ------------------------------------------------------------------ */

export function formatAppThreshold(kind: AppAlertKind, threshold: number): string {
  const unit = APP_ALERT_KIND_UNITS[kind];
  if (unit === "%") return `${formatCount(threshold)}%`;
  if (unit === "ms") return `${formatCount(threshold)} ms`;
  return `${formatCount(threshold)} ${unit}`;
}

export function formatWindow(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds}s`;
}

export function describeAppRule(
  kind: AppAlertKind,
  rule: Pick<AlertRule, "threshold" | "duration_seconds">,
): string {
  const value = formatAppThreshold(kind, rule.threshold);
  const window = formatWindow(rule.duration_seconds);
  switch (kind) {
    case "app_down":
      return `${value} in a row (non-2xx or no answer)`;
    case "app_slow":
      return `every response slower than ${value} for ${window}`;
    case "app_restart_loop":
      return `${value} or more within ${window}`;
    case "app_container_unhealthy":
      return `more than ${formatCount(rule.threshold)} container${rule.threshold === 1 ? "" : "s"} exited or unhealthy for ${window}`;
    case "app_memory":
      return `memory above ${value} of its limit for ${window}`;
    case "app_cpu":
      return `CPU above ${value} for ${window}`;
    case "app_cert_expiring":
      return `certificate expires within ${value}`;
  }
}
