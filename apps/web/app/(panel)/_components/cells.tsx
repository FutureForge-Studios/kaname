"use client";

import * as React from "react";
import Link from "next/link";
import {
  AgentConnectionIndicator,
  ByteSize,
  HealthBadge,
  MonoText,
  Progress,
  StatusBadge,
  cn,
  type Tone,
} from "@kaname/ui";
import { formatPercent, percentOf } from "@/lib/format";
import { useServers } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Dense table cells shared by the Files and Email modules.
 *
 * A transfer account, a mailbox and a mount all answer the same two
 * questions in a list — "how full is it" and "is it working" — and an
 * operator scanning the column has to be able to compare them without
 * re-learning the encoding. So the quota bar and the lifecycle badge are
 * defined once, with the same thresholds, rather than per page.
 * ------------------------------------------------------------------ */

/** Colour escalates only where it has started to matter. */
export function usageTone(percent: number): Tone {
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warn";
  return "accent";
}

export interface UsageBarProps {
  used: number;
  /** 0 means no quota was set; the bar is replaced by the raw figure. */
  total: number;
  /** Names the bar for assistive technology, e.g. "alice@example.com quota". */
  label: string;
  className?: string;
}

export function UsageBar({ used, total, label, className }: UsageBarProps) {
  const percent = percentOf(used, total);

  if (total <= 0) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-1", className)}>
        <span className="flex items-baseline gap-1 text-sm">
          <ByteSize bytes={used} />
          <span className="text-[var(--kn-text-3)]">of no quota</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="flex items-baseline gap-1 text-sm">
        <ByteSize bytes={used} />
        <span className="text-[var(--kn-text-3)]">/</span>
        <ByteSize bytes={total} className="text-[var(--kn-text-2)]" />
        <span
          className={cn(
            "kn-num ml-auto",
            percent >= 95
              ? "text-[var(--kn-danger)]"
              : percent >= 80
                ? "text-[var(--kn-warn)]"
                : "text-[var(--kn-text-3)]",
          )}
        >
          {formatPercent(percent)}
        </span>
      </span>
      <Progress
        value={percent}
        tone={usageTone(percent)}
        size="xs"
        label={`${label} — ${formatPercent(percent)} used`}
        className="rounded-[var(--kn-r-xs)]"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Transfer accounts, mailboxes and mail domains share one lifecycle,
 * because they share one cause: the row exists in Kaname the moment the
 * operator asks for it, and `provisioning` is the honest name for the
 * window before the host agrees.
 */
export type LifecycleStatus = "active" | "provisioning" | "suspended" | "error";

const LIFECYCLE_META: Record<LifecycleStatus, { label: string; tone: Tone; title: string }> = {
  active: {
    label: "Active",
    tone: "ok",
    title: "The host has this configured and it is accepting connections.",
  },
  provisioning: {
    label: "Provisioning",
    tone: "accent",
    title: "Kaname has the row; the job that creates it on the host has not landed yet.",
  },
  suspended: {
    label: "Suspended",
    tone: "neutral",
    title: "Configured on the host but deliberately refusing logins.",
  },
  error: {
    label: "Error",
    tone: "danger",
    title: "The last job against this row failed. Its job log says why.",
  },
};

export function LifecycleBadge({ status }: { status: LifecycleStatus }) {
  const meta = LIFECYCLE_META[status];
  return (
    <StatusBadge
      tone={meta.tone}
      size="xs"
      pulse={status === "provisioning"}
      title={`${meta.label}. ${meta.title}`}
    >
      {meta.label}
    </StatusBadge>
  );
}

/* ------------------------------------------------------------------ *
 * Host
 * ------------------------------------------------------------------ */

export interface HostCellProps {
  serverId: string;
  /** Used when the host is outside this account's scope. */
  serverName: string;
  className?: string;
}

/**
 * Both status axes, never collapsed (PLAN.md 2.6). A mailbox row on a
 * host whose agent is gone is not the same as a mailbox row on a host
 * that is full, and one dot cannot say which — so "can we reach it" and
 * "is it OK" bracket the name and stay separate.
 */
export function HostCell({ serverId, serverName, className }: HostCellProps) {
  const { data } = useServers();
  const server = data?.data.find((candidate) => candidate.id === serverId) ?? null;

  if (!server) {
    return (
      <MonoText muted truncate className={cn("min-w-0", className)}>
        {serverName}
      </MonoText>
    );
  }

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <AgentConnectionIndicator
        connection={server.connection}
        since={server.last_seen_at}
        showLabel={false}
      />
      <Link
        href={`/infrastructure/servers/${server.id}`}
        className="kn-mono min-w-0 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-text)] outline-none hover:text-[var(--kn-accent-400)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
      >
        {server.name}
      </Link>
      <HealthBadge
        health={server.health}
        reasons={server.health_reasons}
        since={server.latest?.sampled_at ?? null}
        size="xs"
        showLabel={false}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Empty values
 * ------------------------------------------------------------------ */

/** One rendering of "there is nothing here", so columns stay comparable. */
export function Blank({ children = "—" }: { children?: React.ReactNode }) {
  return <span className="text-[var(--kn-text-3)]">{children}</span>;
}
