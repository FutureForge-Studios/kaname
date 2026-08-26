"use client";

import * as React from "react";
import type { AgentConnection, HealthState } from "@kaname/contract";
import { cn } from "../lib/cn.js";
import { Dot, StatusBadge, type BadgeSize, type Tone } from "./Badge.js";
import { useRelativeTime, type DateInput } from "./Primitives.js";

/* ------------------------------------------------------------------ *
 * The two independent status axes (PLAN.md 2.6).
 *
 * AgentConnectionIndicator answers "can we reach the box".
 * HealthBadge answers "is the box OK".
 *
 * They are deliberately different shapes — a bare dot plus label versus
 * a pill — because a server is routinely `connected` + `critical` or
 * `disconnected` + `unknown`, and collapsing them into one indicator
 * loses the distinction an operator needs to act.
 * ------------------------------------------------------------------ */

interface ConnectionMeta {
  label: string;
  tone: Tone;
  pulse: boolean;
  hollow: boolean;
  description: string;
  /** How the timestamp reads for this state, or null when it has none. */
  sinceLabel: string | null;
}

const CONNECTION_META: Record<AgentConnection, ConnectionMeta> = {
  connected: {
    label: "Connected",
    tone: "ok",
    pulse: false,
    hollow: false,
    description: "The agent is connected and heartbeating.",
    sinceLabel: "Last seen",
  },
  degraded: {
    label: "Degraded",
    tone: "warn",
    pulse: true,
    hollow: false,
    description: "The socket is open but heartbeats are late. Calls may time out.",
    sinceLabel: "Last seen",
  },
  disconnected: {
    label: "Disconnected",
    tone: "danger",
    pulse: false,
    hollow: true,
    description: "The agent is not connected. Jobs stay queued until it dials back in.",
    sinceLabel: "Last seen",
  },
  never_enrolled: {
    label: "Never enrolled",
    tone: "neutral",
    pulse: false,
    hollow: true,
    description: "No agent has ever connected from this host. Run the enrollment command on it.",
    sinceLabel: null,
  },
  revoked: {
    label: "Revoked",
    tone: "danger",
    pulse: false,
    hollow: true,
    description: "This host's certificate was revoked. Re-enroll it to reconnect.",
    sinceLabel: "Revoked",
  },
};

export interface AgentConnectionIndicatorProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children" | "title"
> {
  connection: AgentConnection;
  /** `last_seen_at` for most states, the revocation time for `revoked`. */
  since?: DateInput | null;
  showLabel?: boolean;
}

export const AgentConnectionIndicator = React.forwardRef<
  HTMLSpanElement,
  AgentConnectionIndicatorProps
>(function AgentConnectionIndicator(
  { connection, since, showLabel = true, className, ...props },
  ref,
) {
  const meta = CONNECTION_META[connection] ?? CONNECTION_META.never_enrolled;
  const relative = useRelativeTime(meta.sinceLabel === null ? null : since);
  const tooltip = relative
    ? `${meta.description} ${meta.sinceLabel} ${relative}.`
    : meta.description;

  return (
    <span
      ref={ref}
      title={tooltip}
      suppressHydrationWarning
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}
      {...props}
    >
      <Dot tone={meta.tone} pulse={meta.pulse} hollow={meta.hollow} />
      {showLabel && <span className="text-[var(--kn-text)]">{meta.label}</span>}
      <span className="sr-only">{showLabel ? tooltip : `Agent ${meta.label}. ${tooltip}`}</span>
    </span>
  );
});

/* ------------------------------ HealthBadge ----------------------------- */

interface HealthMeta {
  label: string;
  tone: Tone;
  description: string;
}

const HEALTH_META: Record<HealthState, HealthMeta> = {
  healthy: {
    label: "Healthy",
    tone: "ok",
    description: "Every monitored threshold is within range.",
  },
  warning: {
    label: "Warning",
    tone: "warn",
    description: "At least one threshold is close to its limit.",
  },
  critical: {
    label: "Critical",
    tone: "danger",
    description: "At least one threshold has been breached.",
  },
  unknown: {
    label: "Unknown",
    tone: "neutral",
    description: "No recent metrics, so health cannot be evaluated.",
  },
};

export interface HealthBadgeProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children" | "title"
> {
  health: HealthState;
  /** Why it is not healthy, e.g. ["/ at 94%", "nginx.service failed"]. */
  reasons?: string[];
  /** When the metrics behind this verdict were sampled. */
  since?: DateInput | null;
  size?: BadgeSize;
  showLabel?: boolean;
}

export const HealthBadge = React.forwardRef<HTMLSpanElement, HealthBadgeProps>(function HealthBadge(
  { health, reasons, since, size = "sm", showLabel = true, className, ...props },
  ref,
) {
  const meta = HEALTH_META[health] ?? HEALTH_META.unknown;
  const relative = useRelativeTime(since);
  const detail = reasons && reasons.length > 0 ? reasons.join(" · ") : meta.description;
  const tooltip = relative ? `${detail} Sampled ${relative}.` : detail;

  return (
    <StatusBadge
      ref={ref}
      tone={meta.tone}
      size={size}
      title={`${meta.label}. ${tooltip}`}
      suppressHydrationWarning
      className={className}
      {...props}
    >
      {showLabel ? meta.label : <span className="sr-only">{meta.label}</span>}
    </StatusBadge>
  );
});
