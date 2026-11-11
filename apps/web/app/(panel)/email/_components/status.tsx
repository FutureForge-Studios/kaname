"use client";

import * as React from "react";
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock,
  ExternalLink,
  Info,
  Loader2,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  MailCheck,
  MailCheckStatus,
  MailInstallStep,
  MailInstallStepStatus,
  MailRelayProvider,
  MailServer,
  MailServerStatus,
  MailServiceState,
} from "@kaname/contract";
import {
  CheckItem,
  CheckList,
  Combobox,
  Dot,
  Skeleton,
  StatusBadge,
  cn,
  formatIndex,
  type CheckItemState,
  type ComboboxOption,
  type Tone,
} from "@kaname/ui";
import type { IconComponent } from "@/lib/icons";
import { pluralize } from "@/lib/format";
import { useMailDomains, useMailServers } from "./queries";

/* ------------------------------------------------------------------ *
 * The Email module's shared vocabulary.
 *
 * Six pages render the same few state families — a check's verdict, an
 * install step, a service, a row's lifecycle — and they have to mean the
 * same thing on every one of them. Every state is a word next to its
 * colour, never the colour alone, and "warn" is never painted as a
 * failure: a server whose DMARC policy is still p=none is not broken,
 * and a panel that colours it red teaches operators to ignore red.
 *
 * The verdict words are Yunori's own (pass / warn / fail / info), so an
 * operator reading the Yunori console and this page sees one story.
 * ------------------------------------------------------------------ */

/* ----------------------------- check status -------------------------- */

interface CheckMeta {
  label: string;
  tone: Tone;
  icon: IconComponent;
  description: string;
}

export const CHECK_META: Record<MailCheckStatus, CheckMeta> = {
  pass: {
    label: "Pass",
    tone: "ok",
    icon: CircleCheck,
    description: "Set up the way receivers expect.",
  },
  warn: {
    label: "Warn",
    tone: "warn",
    icon: TriangleAlert,
    description: "Mail flows today, but this will bite under load or after a change.",
  },
  fail: {
    label: "Fail",
    tone: "danger",
    icon: CircleAlert,
    description: "Mail is being lost, refused or spoofable right now.",
  },
  info: {
    label: "Info",
    tone: "info",
    icon: Info,
    description: "A finding that is neither good nor bad, kept so you know it was looked at.",
  },
  unknown: {
    label: "Unknown",
    tone: "neutral",
    icon: CircleHelp,
    description: "The check could not reach an answer, so its verdict says nothing either way.",
  },
};

/** Sort order: what needs a hand first. */
export const CHECK_RANK: Record<MailCheckStatus, number> = {
  fail: 0,
  warn: 1,
  unknown: 2,
  info: 3,
  pass: 4,
};

export function MailCheckBadge({
  status,
  size = "xs",
  label,
}: {
  status: MailCheckStatus;
  size?: "xs" | "sm";
  /** Replace the verdict word, e.g. "Healthy" for a server's rollup. */
  label?: string;
}) {
  const meta = CHECK_META[status];
  return (
    <StatusBadge tone={meta.tone} size={size} icon={meta.icon} title={meta.description}>
      {label ?? meta.label}
    </StatusBadge>
  );
}

export function checkTextClass(status: MailCheckStatus): string {
  if (status === "fail") return "text-[var(--kn-danger)]";
  if (status === "warn") return "text-[var(--kn-warn)]";
  if (status === "pass") return "text-[var(--kn-ok)]";
  if (status === "info") return "text-[var(--kn-info)]";
  return "text-[var(--kn-text-3)]";
}

export interface CheckCounts {
  fail: number;
  warn: number;
  pass: number;
  info: number;
  unknown: number;
}

export function countChecks(checks: readonly MailCheck[]): CheckCounts {
  const counts: CheckCounts = { fail: 0, warn: 0, pass: 0, info: 0, unknown: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

/**
 * One sentence an operator can act on, derived from the last doctor run
 * rather than restated from the host — so the sentence and the rows
 * below it can never disagree.
 */
export function verdictSentence(server: Pick<MailServer, "checks" | "install_complete" | "status" | "last_synced_at">): string {
  if (server.status === "deploying" || server.status === "installing") {
    return "Yunori Mail Server is being installed. The steps below say where it is.";
  }
  if (server.status === "error") {
    return "The last job against this server failed. Its log says why.";
  }
  if (!server.install_complete) {
    return "Setup is not finished. The highlighted step is what to do next.";
  }
  if (server.last_synced_at === null || server.checks.length === 0) {
    return "Not checked yet. Run a check to hear what the host says.";
  }
  const counts = countChecks(server.checks);
  if (counts.fail > 0) {
    const warns = counts.warn > 0 ? ` and ${pluralize(counts.warn, "warning")}` : "";
    return `${pluralize(counts.fail, "check is", "checks are")} failing${warns}. Mail may be lost or refused.`;
  }
  if (counts.warn > 0) {
    return `Mail flows. ${pluralize(counts.warn, "check wants", "checks want")} attention before it stops.`;
  }
  if (counts.unknown > 0) {
    return `Nothing failing, but ${pluralize(counts.unknown, "check")} could not reach an answer.`;
  }
  return "Everything checks out. Mail is being delivered and signed.";
}

/* ------------------------------ checks list -------------------------- */

export interface ChecksListProps {
  checks: readonly MailCheck[];
  /** Sort failing first. Off for lists that already have an order, like preflight. */
  grouped?: boolean;
  /** Collapse passing rows behind a count, for cards that must stay short. */
  collapsePassing?: boolean;
  emptyLabel?: string;
  className?: string;
}

/**
 * A check is three things: the verdict, what was observed, and what to
 * do about it. The remedy is the row's payload — it is why the operator
 * is here — so it is never hidden behind a hover.
 */
export function ChecksList({
  checks,
  grouped = true,
  collapsePassing = false,
  emptyLabel = "No checks have run yet.",
  className,
}: ChecksListProps) {
  const [showPassing, setShowPassing] = React.useState(false);

  const ordered = React.useMemo(() => {
    if (!grouped) return [...checks];
    return [...checks].sort((a, b) => CHECK_RANK[a.status] - CHECK_RANK[b.status]);
  }, [checks, grouped]);

  const passing = ordered.filter((check) => check.status === "pass");
  const visible =
    collapsePassing && !showPassing ? ordered.filter((check) => check.status !== "pass") : ordered;

  if (checks.length === 0) {
    return <p className={cn("text-sm text-[var(--kn-text-3)]", className)}>{emptyLabel}</p>;
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <CheckList divided="between">
        {visible.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </CheckList>
      {collapsePassing && passing.length > 0 && (
        <button
          type="button"
          onClick={() => setShowPassing((current) => !current)}
          aria-expanded={showPassing}
          className="kn-label-sm mt-3 self-start rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
        >
          {showPassing
            ? `Hide ${pluralize(passing.length, "passing check")}`
            : `Show ${pluralize(passing.length, "passing check")}`}
        </button>
      )}
    </div>
  );
}

/**
 * A check reads as a CheckItem: resolved (pass), needs you (fail, warn),
 * or noted (info, unknown). The circle says where the operator is; the
 * verdict badge beside it carries the status colour.
 */
const CHECK_STATE: Record<MailCheckStatus, CheckItemState> = {
  pass: "done",
  fail: "current",
  warn: "current",
  info: "todo",
  unknown: "todo",
};

export function CheckRow({ check }: { check: MailCheck }) {
  return (
    <CheckItem
      id={`check-${check.id}`}
      state={CHECK_STATE[check.status]}
      icon={check.status === "fail" ? X : check.status === "warn" ? TriangleAlert : undefined}
      className="py-2.5"
      title={check.label}
      description={check.detail}
      action={<MailCheckBadge status={check.status} />}
    >
      {check.remedy && (
        <p className="m-0 mt-1.5 text-sm text-[var(--kn-text)]">
          <span className="kn-label-sm mr-1.5 text-[var(--kn-text-3)]">Fix</span>
          {check.remedy}
        </p>
      )}
      {check.help_url && (
        <a
          href={check.help_url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
        >
          Learn more
          <ExternalLink size={10} aria-hidden />
        </a>
      )}
    </CheckItem>
  );
}

/* ----------------------------- install steps ------------------------- */

interface StepMeta {
  label: string;
  tone: Tone;
  icon: IconComponent;
}

const STEP_META: Record<MailInstallStepStatus, StepMeta> = {
  pending: { label: "Pending", tone: "neutral", icon: Minus },
  running: { label: "Running", tone: "accent", icon: Loader2 },
  done: { label: "Done", tone: "ok", icon: Check },
  failed: { label: "Failed", tone: "danger", icon: X },
  waiting: { label: "Waiting for you", tone: "warn", icon: Clock },
  skipped: { label: "Skipped", tone: "neutral", icon: Minus },
};

/** The first step that needs the operator; the installer blocks on it. */
export function waitingStep(steps: readonly MailInstallStep[]): MailInstallStep | null {
  return steps.find((step) => step.status === "waiting") ?? null;
}

export interface InstallStepsProps {
  steps: readonly MailInstallStep[];
  className?: string;
}

/**
 * Yunori's installer is twelve resumable steps, and the ones that stop
 * — point the hostname here, publish these records, set reverse DNS —
 * stop for the operator. The waiting step's detail is exactly what they
 * must do, so it is the loudest thing in the list.
 */
export function InstallSteps({ steps, className }: InstallStepsProps) {
  if (steps.length === 0) {
    return (
      <p className={cn("text-sm text-[var(--kn-text-3)]", className)}>
        The host has not reported its install steps yet.
      </p>
    );
  }

  return (
    <CheckList divided="between" className={className} aria-label="Install steps">
      {steps.map((step, index) => {
        const meta = STEP_META[step.status];
        const waiting = step.status === "waiting";
        const failed = step.status === "failed";
        const settled = step.status === "done" || step.status === "skipped";
        return (
          <CheckItem
            key={`${index}-${step.title}`}
            state={STEP_STATE[step.status]}
            icon={
              failed ? X : waiting ? Clock : step.status === "skipped" ? Minus : undefined
            }
            className="py-2"
            title={
              <span className="inline-flex min-w-0 items-baseline gap-2.5">
                <span aria-hidden className="kn-num text-xs text-[var(--kn-text-3)]">
                  {formatIndex(index + 1)}
                </span>
                <span
                  className={cn(
                    settled ? "font-normal text-[var(--kn-text-2)]" : "text-[var(--kn-text)]",
                  )}
                >
                  {step.title}
                </span>
              </span>
            }
            action={
              waiting || failed || step.status === "running" ? (
                <StatusBadge
                  tone={meta.tone}
                  size="xs"
                  icon={meta.icon}
                  pulse={step.status === "running"}
                >
                  {meta.label}
                </StatusBadge>
              ) : (
                <span className={cn("kn-label-sm", checkToneClass(meta.tone))}>{meta.label}</span>
              )
            }
          >
            {step.detail && (waiting || failed) && (
              <p
                className={cn(
                  "m-0 mt-2 rounded-[var(--kn-r-md)] border px-3 py-2 text-sm text-[var(--kn-text)]",
                  waiting
                    ? "border-[color-mix(in_srgb,var(--kn-warn)_40%,transparent)] bg-[var(--kn-warn-soft)]"
                    : "border-[color-mix(in_srgb,var(--kn-danger)_40%,transparent)] bg-[var(--kn-danger-soft)]",
                )}
              >
                {step.detail}
              </p>
            )}
            {step.detail && step.status === "running" && (
              <p className="m-0 mt-0.5 text-xs text-[var(--kn-text-2)]">{step.detail}</p>
            )}
          </CheckItem>
        );
      })}
    </CheckList>
  );
}

const STEP_STATE: Record<MailInstallStepStatus, CheckItemState> = {
  done: "done",
  skipped: "done",
  running: "current",
  waiting: "current",
  failed: "current",
  pending: "todo",
};

function checkToneClass(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "text-[var(--kn-ok)]";
    case "warn":
      return "text-[var(--kn-warn)]";
    case "danger":
      return "text-[var(--kn-danger)]";
    case "info":
      return "text-[var(--kn-info)]";
    case "accent":
      return "text-[var(--kn-accent-400)]";
    default:
      return "text-[var(--kn-text-3)]";
  }
}

/* ------------------------------- services ---------------------------- */

const SERVICE_LABELS: Record<string, string> = {
  stalwart: "Stalwart (mail engine)",
  "yunori-mail": "yunori-mail (console and edge)",
  unbound: "unbound (resolver)",
};

/** Dot plus the word, per unit: a stopped engine must read as stopped. */
export function ServiceStates({
  services,
  className,
}: {
  services: readonly MailServiceState[];
  className?: string;
}) {
  if (services.length === 0) {
    return <span className={cn("text-sm text-[var(--kn-text-3)]", className)}>No services reported</span>;
  }
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", className)} aria-label="Services">
      {services.map((service) => (
        <li key={service.name} className="flex items-center gap-1.5 text-sm">
          <Dot tone={service.active ? "ok" : "danger"} hollow={!service.active} />
          <span className="kn-mono text-[var(--kn-text)]" title={SERVICE_LABELS[service.name]}>
            {service.name}
          </span>
          <span className={service.active ? "text-[var(--kn-text-3)]" : "text-[var(--kn-danger)]"}>
            {service.active ? "running" : "stopped"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------- server lifecycle ----------------------- */

const SERVER_STATUS_META: Record<MailServerStatus, { label: string; tone: Tone; title: string }> = {
  not_installed: {
    label: "Not installed",
    tone: "neutral",
    title: "Kaname has a record but the host has no yunori-mail binary.",
  },
  deploying: {
    label: "Deploying",
    tone: "accent",
    title: "The deploy job is copying the binary and starting the installer.",
  },
  installing: {
    label: "Installing",
    tone: "accent",
    title: "The installer is running on the host; some steps may be waiting for you.",
  },
  installed: {
    label: "Installed",
    tone: "ok",
    title: "Yunori Mail Server is installed and under Kaname's management.",
  },
  error: {
    label: "Error",
    tone: "danger",
    title: "The last job against this server failed. Its log says why.",
  },
};

export function MailServerStatusBadge({ status }: { status: MailServerStatus }) {
  const meta = SERVER_STATUS_META[status];
  return (
    <StatusBadge
      tone={meta.tone}
      size="xs"
      pulse={status === "deploying" || status === "installing"}
      title={`${meta.label}. ${meta.title}`}
    >
      {meta.label}
    </StatusBadge>
  );
}

/* ------------------------------ row lifecycle ------------------------ */

type RowStatus = "active" | "provisioning" | "removing" | "error";

const ROW_STATUS_META: Record<RowStatus, { label: string; tone: Tone; title: string }> = {
  active: {
    label: "Active",
    tone: "ok",
    title: "The host has this and it is accepting mail.",
  },
  provisioning: {
    label: "Provisioning",
    tone: "accent",
    title: "Kaname has the row; the job that creates it on the host has not landed yet.",
  },
  removing: {
    label: "Removing",
    tone: "warn",
    title: "A remove job is in flight. The row disappears when the host confirms.",
  },
  error: {
    label: "Error",
    tone: "danger",
    title: "The last job against this row failed. Its job log says why.",
  },
};

/** Domains, mailboxes and aliases share one lifecycle, so they share one badge. */
export function RowStatusBadge({ status }: { status: RowStatus }) {
  const meta = ROW_STATUS_META[status];
  return (
    <StatusBadge
      tone={meta.tone}
      size="xs"
      pulse={status === "provisioning" || status === "removing"}
      title={`${meta.label}. ${meta.title}`}
    >
      {meta.label}
    </StatusBadge>
  );
}

/* ------------------------------ certificate -------------------------- */

const CERT_STATE_META: Record<string, { label: string; tone: Tone; title: string }> = {
  valid: { label: "Valid", tone: "ok", title: "Issued by a trusted authority and in date." },
  test: {
    label: "Staging",
    tone: "warn",
    title: "Issued by the staging authority after a failure; browsers and mail apps do not trust it.",
  },
  self_signed: {
    label: "Self-signed",
    tone: "warn",
    title: "The temporary certificate the console starts with. Clients will warn until a real one arrives.",
  },
  expired: { label: "Expired", tone: "danger", title: "Mail apps will refuse to connect." },
  missing: { label: "Missing", tone: "danger", title: "No certificate at all; TLS cannot be offered." },
  unknown: { label: "Unknown", tone: "neutral", title: "The host did not say." },
};

export function CertificateStateBadge({ state }: { state: string }) {
  const meta = CERT_STATE_META[state] ?? {
    label: state,
    tone: "neutral" as Tone,
    title: "A state this panel does not know yet.",
  };
  return (
    <StatusBadge tone={meta.tone} size="xs" title={`${meta.label}. ${meta.title}`}>
      {meta.label}
    </StatusBadge>
  );
}

/* ------------------------------- relay ------------------------------- */

export const RELAY_PROVIDER_LABELS: Record<MailRelayProvider, string> = {
  ses: "Amazon SES",
  resend: "Resend",
  postmark: "Postmark",
  mailgun: "Mailgun",
  smtp2go: "SMTP2GO",
  brevo: "Brevo",
  custom: "Custom SMTP",
};

export const RELAY_PROVIDERS: readonly MailRelayProvider[] = [
  "ses",
  "resend",
  "postmark",
  "mailgun",
  "smtp2go",
  "brevo",
  "custom",
];

/* ------------------------------- pickers ----------------------------- */

export interface DomainPickerProps {
  value: string | null;
  onChange: (mailDomainId: string | null) => void;
  /** Adds an "All domains" entry for list pages that can span them. */
  allowAll?: boolean;
  /** Restrict to the domains hosted on one mail server. */
  mailServerId?: string | null;
  size?: "sm" | "md";
  id?: string;
  className?: string;
}

/**
 * One control for choosing a mail domain, shared by the mailbox and
 * alias pages and their dialogs. The DNS verdict rides along in the
 * description, because a domain whose DKIM is failing is exactly the
 * one an operator is about to add a mailbox to.
 */
export function DomainPicker({
  value,
  onChange,
  allowAll = false,
  mailServerId = null,
  size = "sm",
  id,
  className,
}: DomainPickerProps) {
  const query = useMailDomains();
  const domains = React.useMemo(() => {
    const all = query.data?.data ?? [];
    return mailServerId ? all.filter((domain) => domain.mail_server_id === mailServerId) : all;
  }, [mailServerId, query.data]);

  const options = React.useMemo<ComboboxOption[]>(() => {
    const entries: ComboboxOption[] = allowAll
      ? [{ value: "", label: "All domains", description: `${domains.length} hosting mail` }]
      : [];
    for (const domain of domains) {
      entries.push({
        value: domain.id,
        label: domain.domain_name,
        description: `${domain.server_name} · ${pluralize(domain.mailbox_count, "mailbox", "mailboxes")} · DNS ${CHECK_META[domain.dns_status].label.toLowerCase()}`,
        mono: true,
      });
    }
    return entries;
  }, [allowAll, domains]);

  if (query.isLoading) {
    return (
      <Skeleton
        className={cn("h-7 w-56 rounded-[var(--kn-r-sm)]", className)}
        label="Loading mail domains"
      />
    );
  }

  return (
    <Combobox
      id={id}
      size={size}
      options={options}
      value={value ?? ""}
      onValueChange={(next) => onChange(next && next.length > 0 ? next : null)}
      placeholder={domains.length === 0 ? "No domain hosts mail" : "Select a domain"}
      emptyMessage="No domain matches that name."
      disabled={domains.length === 0}
      clearable={allowAll}
      mono
      aria-label="Mail domain"
      className={cn("w-56", className)}
    />
  );
}

export interface MailServerPickerProps {
  /** The mail server row id, or the host's server id — both are accepted. */
  value: string | null;
  /** Hands back the row too, because list filters key on the host's `server_id`. */
  onChange: (mailServerId: string | null, server: MailServer | null) => void;
  allowAll?: boolean;
  size?: "sm" | "md";
  id?: string;
  className?: string;
}

/** Chooses among the hosts Kaname knows to be running Yunori Mail Server. */
export function MailServerPicker({
  value,
  onChange,
  allowAll = false,
  size = "sm",
  id,
  className,
}: MailServerPickerProps) {
  const query = useMailServers();
  const servers = query.data?.data ?? [];

  const options = React.useMemo<ComboboxOption[]>(() => {
    const entries: ComboboxOption[] = allowAll
      ? [{ value: "", label: "All mail servers", description: `${servers.length} running Yunori` }]
      : [];
    for (const server of servers) {
      entries.push({
        value: server.id,
        label: server.server_name,
        description: `${server.hostname ?? "no hostname yet"} · ${CHECK_META[server.health].label.toLowerCase()}`,
        mono: true,
      });
    }
    return entries;
  }, [allowAll, servers]);

  const resolved = servers.find((server) => server.id === value || server.server_id === value)?.id ?? "";

  if (query.isLoading) {
    return (
      <Skeleton className={cn("h-7 w-56 rounded-[var(--kn-r-sm)]", className)} label="Loading mail servers" />
    );
  }

  return (
    <Combobox
      id={id}
      size={size}
      options={options}
      value={resolved}
      onValueChange={(next) => {
        const chosen = servers.find((server) => server.id === next) ?? null;
        onChange(chosen?.id ?? null, chosen);
      }}
      placeholder={servers.length === 0 ? "No mail server yet" : "Select a mail server"}
      emptyMessage="No mail server matches that name."
      disabled={servers.length === 0}
      clearable={allowAll}
      mono
      aria-label="Mail server"
      className={cn("w-56", className)}
    />
  );
}
