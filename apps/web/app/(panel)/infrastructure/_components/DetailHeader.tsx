"use client";

import * as React from "react";
import type { AgentConnection, HealthState } from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Eyebrow,
  HealthBadge,
  RelativeTime,
  StatusLine,
  cn,
  type Tone,
} from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * DetailHeader — the infrastructure detail pages' header.
 *
 * ResourceHeader's anatomy (name, both status axes side by side, mono
 * identity, pill actions, overflow menu, tabs on the hairline) plus the
 * two editorial pieces it has no slot for yet: the eyebrow chip naming
 * the kind of thing this is, and a StatusLine that says in one sentence
 * what the two axes add up to. Composed from kit pieces only; when
 * ResourceHeader grows `eyebrow` and `status` this file can go.
 *
 * The two axes stay separate components (PLAN.md 2.6): the sentence
 * under them explains, it never replaces them.
 * ------------------------------------------------------------------ */

export interface DetailHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** The kind of resource: "Server", "Unit", "Container". */
  eyebrow: string;
  breadcrumb?: React.ReactNode;
  name: React.ReactNode;
  /** Mono identity line: hostname, address, image. */
  identity?: React.ReactNode;
  connection?: AgentConnection;
  lastSeenAt?: string | null;
  health?: HealthState;
  healthReasons?: string[];
  badges?: React.ReactNode;
  /** A `<StatusLine>`. */
  status?: React.ReactNode;
  actions?: React.ReactNode;
  menu?: React.ReactNode;
  tabs?: React.ReactNode;
}

export function DetailHeader({
  eyebrow,
  breadcrumb,
  name,
  identity,
  connection,
  lastSeenAt,
  health,
  healthReasons,
  badges,
  status,
  actions,
  menu,
  tabs,
  className,
  ...props
}: DetailHeaderProps) {
  return (
    <header
      className={cn(
        "kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 pt-6",
        tabs ? "pb-0" : "pb-5",
        className,
      )}
      {...props}
    >
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Eyebrow>{eyebrow}</Eyebrow>
        {breadcrumb && (
          <div className="kn-label-sm flex min-w-0 items-center text-[var(--kn-text-3)]">
            {breadcrumb}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 max-w-full flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="kn-display truncate text-[var(--kn-text)]">{name}</h1>
            {connection && <AgentConnectionIndicator connection={connection} since={lastSeenAt} />}
            {health && <HealthBadge health={health} reasons={healthReasons} />}
            {badges}
          </div>
          {identity && <div className="kn-mono truncate text-[var(--kn-text-3)]">{identity}</div>}
          {status && <div className="mt-1.5 min-w-0">{status}</div>}
        </div>

        {(actions || menu) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
            {menu}
          </div>
        )}
      </div>

      {tabs && <div className="-mb-px mt-4">{tabs}</div>}
    </header>
  );
}

/** Skeleton for the header while the resource loads, same footprint. */
export function DetailHeaderSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 pb-5 pt-6">
      {children}
    </header>
  );
}

/* ----------------------------- HostStatusLine --------------------------- */

const CONNECTION_TONE: Record<AgentConnection, Tone> = {
  connected: "ok",
  degraded: "warn",
  disconnected: "danger",
  never_enrolled: "info",
  revoked: "danger",
};

const HEALTH_TONE: Record<HealthState, Tone> = {
  healthy: "ok",
  warning: "warn",
  critical: "danger",
  unknown: "neutral",
};

const RANK: Record<string, number> = { neutral: 0, info: 1, ok: 1, warn: 2, danger: 3 };

export interface HostStatusLineProps {
  host: {
    name: string;
    connection: AgentConnection;
    last_seen_at: string | null;
    health: HealthState;
    health_reasons: string[];
  };
}

/**
 * The two axes read as one sentence: "Agent connected, seen 4s ago ·
 * 2 health findings: disk / is 91% full". The dot takes the worse of the
 * two tones; the badges beside the name keep them apart.
 */
export function HostStatusLine({ host }: HostStatusLineProps) {
  const connectionTone = CONNECTION_TONE[host.connection] ?? "neutral";
  const healthTone = HEALTH_TONE[host.health] ?? "neutral";
  const tone = (RANK[healthTone] ?? 0) > (RANK[connectionTone] ?? 0) ? healthTone : connectionTone;

  const agent =
    host.connection === "never_enrolled" ? (
      <>Agent never enrolled — run the enrollment command on the host</>
    ) : host.connection === "revoked" ? (
      <>Certificate revoked — the agent cannot reconnect until it is enrolled again</>
    ) : (
      <>
        Agent {host.connection === "connected" ? "online" : host.connection}
        {host.last_seen_at && (
          <>
            , last heard from <RelativeTime value={host.last_seen_at} />
          </>
        )}
      </>
    );

  const first = host.health_reasons[0];
  const health =
    host.health === "unknown"
      ? "health not evaluated without recent metrics"
      : host.health === "healthy"
        ? "every monitored threshold within range"
        : `${host.health_reasons.length} health finding${host.health_reasons.length === 1 ? "" : "s"}${first ? `: ${first}` : ""}`;

  return (
    <StatusLine tone={tone} pulse={host.connection === "connected"} className="min-w-0">
      {agent} · {health}
    </StatusLine>
  );
}
