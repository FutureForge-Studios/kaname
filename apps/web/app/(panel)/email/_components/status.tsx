"use client";

import * as React from "react";
import { CircleAlert, CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";
import type { CheckStatus, MailDomain, MailLogEntry } from "@kaname/contract";
import {
  Badge,
  Combobox,
  Skeleton,
  StatusBadge,
  cn,
  type ComboboxOption,
  type Tone,
} from "@kaname/ui";
import type { IconComponent } from "@/lib/icons";
import { useMailDomains } from "./queries";

/* ------------------------------------------------------------------ *
 * The Email module's shared vocabulary.
 *
 * Five pages render the same three state families — a check's verdict, a
 * message's fate, a domain's identity — and they have to mean the same
 * thing on every one of them. In particular "warn" is never painted as a
 * failure: a domain with a working SPF record and no DMARC reporting
 * address is not broken, and a panel that colours it red teaches
 * operators to ignore the colour.
 * ------------------------------------------------------------------ */

/* ---------------------------- check status --------------------------- */

interface CheckMeta {
  label: string;
  tone: Tone;
  icon: IconComponent;
  description: string;
}

export const CHECK_META: Record<CheckStatus, CheckMeta> = {
  pass: {
    label: "Pass",
    tone: "ok",
    icon: CircleCheck,
    description: "This is set up the way receivers expect.",
  },
  warn: {
    label: "Warn",
    tone: "warn",
    icon: TriangleAlert,
    description: "Mail flows today, but this will bite under load, at scale or after a change.",
  },
  fail: {
    label: "Fail",
    tone: "danger",
    icon: CircleAlert,
    description: "Mail is being lost, refused or spoofable right now.",
  },
  unknown: {
    label: "Unknown",
    tone: "neutral",
    icon: CircleHelp,
    description: "The check could not reach an answer, so its verdict says nothing either way.",
  },
};

export function CheckStatusBadge({
  status,
  size = "xs",
}: {
  status: CheckStatus;
  size?: "xs" | "sm";
}) {
  const meta = CHECK_META[status];
  return (
    <StatusBadge tone={meta.tone} size={size} icon={meta.icon} title={meta.description}>
      {meta.label}
    </StatusBadge>
  );
}

/** Ranking used to sort domains and to pick a rail's colour. */
export const CHECK_RANK: Record<CheckStatus, number> = {
  fail: 0,
  warn: 1,
  unknown: 2,
  pass: 3,
};

export function checkTextClass(status: CheckStatus): string {
  if (status === "fail") return "text-[var(--kn-danger)]";
  if (status === "warn") return "text-[var(--kn-warn)]";
  if (status === "pass") return "text-[var(--kn-ok)]";
  return "text-[var(--kn-text-3)]";
}

/* --------------------------- delivery status ------------------------- */

type DeliveryStatus = MailLogEntry["status"];

const DELIVERY_META: Record<DeliveryStatus, { label: string; tone: Tone; description: string }> = {
  received: {
    label: "Received",
    tone: "info",
    description: "Accepted for a mailbox on this host.",
  },
  sent: {
    label: "Sent",
    tone: "ok",
    description: "The receiving server accepted responsibility for the message.",
  },
  deferred: {
    label: "Deferred",
    tone: "warn",
    description:
      "Temporarily refused, so it is still in the queue and will be retried. Repeated deferrals are usually rate limiting or greylisting.",
  },
  bounced: {
    label: "Bounced",
    tone: "danger",
    description: "Permanently refused after acceptance; the sender was told.",
  },
  rejected: {
    label: "Rejected",
    tone: "danger",
    description: "Refused during the SMTP conversation, so it was never queued.",
  },
  quarantined: {
    label: "Quarantined",
    tone: "warn",
    description: "Held aside by content or reputation filtering rather than delivered.",
  },
};

export const DELIVERY_TONE_BG: Record<DeliveryStatus, string> = {
  received: "bg-[var(--kn-info)]",
  sent: "bg-[var(--kn-ok)]",
  deferred: "bg-[var(--kn-warn)]",
  bounced: "bg-[var(--kn-danger)]",
  rejected: "bg-[var(--kn-danger)]",
  quarantined: "bg-[var(--kn-warn)]",
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const meta = DELIVERY_META[status];
  return (
    <StatusBadge tone={meta.tone} size="xs" title={meta.description}>
      {meta.label}
    </StatusBadge>
  );
}

export function deliveryLabel(status: DeliveryStatus): string {
  return DELIVERY_META[status].label;
}

/* ------------------------------ domains ------------------------------ */

export interface DomainPickerProps {
  value: string | null;
  onChange: (mailDomainId: string | null) => void;
  /** Adds an "All domains" entry for list pages that can span them. */
  allowAll?: boolean;
  className?: string;
}

/**
 * One control for choosing a mail domain, shared by the mailbox, alias
 * and forwarder lists. The worst auth verdict rides along in the
 * description, because a domain whose DKIM is failing is exactly the one
 * an operator is about to add a mailbox to.
 */
export function DomainPicker({ value, onChange, allowAll = false, className }: DomainPickerProps) {
  const query = useMailDomains();
  const domains = query.data?.data ?? [];

  const options = React.useMemo<ComboboxOption[]>(() => {
    const entries: ComboboxOption[] = allowAll
      ? [{ value: "", label: "All domains", description: `${domains.length} hosting mail` }]
      : [];
    for (const domain of domains) {
      entries.push({
        value: domain.id,
        label: domain.domain_name,
        description: `${domain.mailbox_count} mailboxes · auth ${domain.auth_summary.worst}`,
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

/** Domain identity for a table cell: the name plus its auth verdict. */
export function DomainCell({ domain }: { domain: MailDomain }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="kn-mono min-w-0 truncate text-[var(--kn-text)]">{domain.domain_name}</span>
      <Badge tone={CHECK_META[domain.auth_summary.worst].tone} size="xs">
        {domain.auth_summary.worst}
      </Badge>
    </span>
  );
}
