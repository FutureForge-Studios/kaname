import { Plug, PlugZap, Unplug } from "lucide-react";
import type { AgentConnection, HealthState } from "../lib/api";
import type { JobStatus } from "../lib/jobs";

/*
 * Kaname rule: reachability ("can we reach the box") and health ("is
 * the box OK") are two facts, shown as two labelled indicators. Never
 * one dot.
 */

const REACH: Record<string, { label: string; tone: string; Icon: typeof Plug }> = {
  connected: { label: "Connected", tone: "ok", Icon: Plug },
  degraded: { label: "Degraded", tone: "warn", Icon: PlugZap },
  disconnected: { label: "Disconnected", tone: "danger", Icon: Unplug },
  never_enrolled: { label: "Not enrolled", tone: "neutral", Icon: Unplug },
};

export function ReachBadge({ value }: { value: AgentConnection | undefined }) {
  const r = REACH[value ?? ""] ?? { label: value ?? "Unknown", tone: "neutral", Icon: Unplug };
  return (
    <span className={`badge tone-${r.tone}`} title={`Agent: ${r.label}`}>
      <r.Icon size={12} aria-hidden />
      <span className="sr-only">Agent </span>
      {r.label}
    </span>
  );
}

const HEALTH: Record<string, { label: string; tone: string }> = {
  healthy: { label: "Healthy", tone: "ok" },
  warning: { label: "Warning", tone: "warn" },
  critical: { label: "Critical", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
};

export function HealthBadge({ value, reasons }: { value: HealthState | undefined; reasons?: string[] }) {
  const h = HEALTH[value ?? "unknown"] ?? { label: value ?? "Unknown", tone: "neutral" };
  return (
    <span className={`badge tone-${h.tone}`} title={reasons?.length ? reasons.join("\n") : `Health: ${h.label}`}>
      <span className="dot" aria-hidden />
      <span className="sr-only">Health </span>
      {h.label}
    </span>
  );
}

const STATE_TONE: Record<string, string> = {
  active: "ok",
  running: "ok",
  reloading: "info",
  activating: "info",
  deactivating: "info",
  restarting: "info",
  inactive: "neutral",
  exited: "neutral",
  created: "neutral",
  paused: "warn",
  failed: "danger",
  dead: "danger",
};

export function StateBadge({ value }: { value: string | undefined }) {
  const tone = STATE_TONE[value ?? ""] ?? "neutral";
  return (
    <span className={`badge tone-${tone}`}>
      <span className="dot" aria-hidden />
      {value ?? "unknown"}
    </span>
  );
}

const JOB_TONE: Record<JobStatus, string> = {
  queued: "neutral",
  running: "info",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  timed_out: "danger",
};

export function JobBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`badge tone-${JOB_TONE[status]}${status === "running" ? " pulsing" : ""}`}>
      <span className="dot" aria-hidden />
      {status.replace("_", " ")}
    </span>
  );
}
