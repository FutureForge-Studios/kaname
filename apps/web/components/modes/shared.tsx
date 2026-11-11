"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Eye, Mail } from "lucide-react";
import type { AccountQuota, QuotaUsage } from "@kaname/contract";
import {
  Button,
  Card,
  CopyableCode,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  InlineError,
  Input,
  MonoLabel,
  Progress,
  RelativeTime,
  StatusLine,
  cn,
  type Tone,
} from "@kaname/ui";
import { QUOTA_ROWS, formatMb, quotaFraction } from "@/lib/accounts";
import type { IconComponent } from "@/lib/icons";
import { useModes } from "@/lib/modes";
import { LinkButton } from "@/components/ResourcePage";

/* ------------------------------------------------------------------ *
 * Pieces shared by the mode homes and the reseller / resellers pages.
 * Composed from the kit; nothing here draws its own colours.
 * ------------------------------------------------------------------ */

export function toneFor(fraction: number | null): Tone {
  if (fraction === null) return "neutral";
  if (fraction >= 1) return "danger";
  if (fraction >= 0.8) return "warn";
  return "ok";
}

function amount(value: number, unit?: string): string {
  return unit === "MB" ? formatMb(value) : String(value);
}

/** Usage-vs-quota meters, one hairline row per resource kind. */
export function QuotaMeters({
  quota,
  usage,
  className,
  compact = false,
}: {
  quota: AccountQuota | null;
  usage: QuotaUsage;
  className?: string;
  compact?: boolean;
}) {
  return (
    <ul className={cn("flex flex-col divide-y divide-[var(--kn-border)]", className)}>
      {QUOTA_ROWS.map((row) => {
        const used = usage[row.usage];
        const limit = quota ? quota[row.key] : null;
        const fraction = quotaFraction(used, limit);
        const tone = toneFor(fraction);
        return (
          <li
            key={row.key}
            className={cn("grid items-center gap-x-4 gap-y-1.5", compact ? "py-2" : "py-3", "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[140px_minmax(0,1fr)_120px]")}
          >
            <MonoLabel tone="muted">{row.label}</MonoLabel>
            <span className="kn-mono text-right text-[var(--kn-text)] sm:order-last">
              {amount(used, row.unit)}
              <span className="text-[var(--kn-text-3)]">
                {limit === null ? " · no limit" : ` / ${amount(limit, row.unit)}`}
              </span>
            </span>
            <Progress
              className="col-span-2 sm:col-span-1"
              size="xs"
              value={fraction === null ? 0 : Math.min(1, fraction) * 100}
              max={100}
              tone={tone === "neutral" ? "info" : tone}
              label={`${row.label}: ${amount(used, row.unit)}${limit === null ? ", no limit" : ` of ${amount(limit, row.unit)}`}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The one-sentence summary of how close an account is to its ceilings. */
export function QuotaStatus({ quota, usage }: { quota: AccountQuota | null; usage: QuotaUsage }) {
  const worst = QUOTA_ROWS.map((row) => ({
    row,
    fraction: quotaFraction(usage[row.usage], quota ? quota[row.key] : null),
  }))
    .filter((entry) => entry.fraction !== null)
    .sort((a, b) => (b.fraction ?? 0) - (a.fraction ?? 0))[0];
  if (!worst || worst.fraction === null) {
    return <StatusLine tone="ok">No limits set on this account</StatusLine>;
  }
  const tone = toneFor(worst.fraction);
  const pct = Math.round(worst.fraction * 100);
  return (
    <StatusLine tone={tone}>
      {tone === "ok"
        ? `Within every allowance · ${worst.row.label.toLowerCase()} at ${pct}%`
        : `${worst.row.label} at ${pct}% of the allowance`}
    </StatusLine>
  );
}

/* ----------------------------- quota form ---------------------------- */

export type QuotaDraft = Record<keyof AccountQuota, string>;

export function draftFromQuota(quota: Partial<AccountQuota> | null | undefined): QuotaDraft {
  const out = {} as QuotaDraft;
  for (const row of QUOTA_ROWS) {
    const value = quota?.[row.key];
    out[row.key] = value === null || value === undefined ? "" : String(value);
  }
  return out;
}

/** Empty means "no limit of its own" (null). */
export function quotaFromDraft(draft: QuotaDraft): AccountQuota {
  const out = {} as AccountQuota;
  for (const row of QUOTA_ROWS) {
    const raw = draft[row.key].trim();
    out[row.key] = raw === "" ? null : Math.max(0, Math.floor(Number(raw)));
  }
  return out;
}

/** Five number fields. `ceiling` shows the parent's allowance beside each. */
export function QuotaFields({
  draft,
  onChange,
  ceiling,
  errors,
}: {
  draft: QuotaDraft;
  onChange: (draft: QuotaDraft) => void;
  ceiling?: AccountQuota | null;
  errors?: Record<string, string | undefined>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {QUOTA_ROWS.map((row) => {
        const max = ceiling ? ceiling[row.key] : null;
        return (
          <FormField
            key={row.key}
            label={row.unit ? `${row.label} (${row.unit})` : row.label}
            hint={max === null ? "no limit" : `up to ${amount(max, row.unit)}`}
            error={errors?.[`quota.${row.key}`] ?? errors?.[row.key]}
          >
            <Input
              mono
              type="number"
              inputMode="numeric"
              min={0}
              max={max ?? undefined}
              placeholder="No limit"
              value={draft[row.key]}
              onChange={(event) => onChange({ ...draft, [row.key]: event.target.value })}
            />
          </FormField>
        );
      })}
    </div>
  );
}

/* ----------------------------- invitations --------------------------- */

export interface InviteResult {
  email: string;
  invite: {
    url: string;
    expires_at: string;
    email: { sent: boolean; error: string | null } | null;
  };
}

/** Shows the one-time invitation link after creating a reseller or client. */
export function InviteLinkDialog({
  result,
  noun,
  onClose,
}: {
  result: InviteResult | null;
  noun: string;
  onClose: () => void;
}) {
  if (!result) return null;
  const emailed = result.invite.email;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} size="md">
      <DialogHeader
        title={`${result.email} is invited`}
        description={
          emailed?.sent
            ? `The ${noun} invitation was emailed. The same link is below, shown once, in case it does not arrive.`
            : "This link sets their first password. It is shown once and expires on its own."
        }
      />
      <DialogBody>
        {emailed && !emailed.sent && (
          <InlineError
            tone="warn"
            className="mb-3"
            message={`The invitation email could not be sent: ${emailed.error ?? "the mail server refused it"} Send the link below yourself.`}
          />
        )}
        <CopyableCode value={result.invite.url} label="Invitation link" block />
        <p className="mt-3 text-[var(--kn-text-2)]">
          Expires <RelativeTime value={result.invite.expires_at} />. Anyone holding it can set
          the password for this account.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" icon={Mail} onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ------------------------------ task cards --------------------------- */

export interface TaskCardProps {
  href: string;
  icon: IconComponent;
  title: string;
  description: string;
  meta?: React.ReactNode;
}

/** A friendly, whole-card link: icon, title, one sentence, arrow. */
export function TaskCard({ href, icon: Icon, title, description, meta }: TaskCardProps) {
  return (
    <Link
      href={href}
      className="group/task block rounded-[var(--kn-r-lg)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
    >
      <Card interactive padding="lg" className="flex h-full flex-col gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--kn-r-pill)] bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]">
          <Icon size={17} aria-hidden />
        </span>
        <span className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.02em] text-[var(--kn-text)]">
          {title}
          <ArrowRight
            size={15}
            aria-hidden
            className="text-[var(--kn-text-3)] transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)] group-hover/task:translate-x-0.5 group-hover/task:text-[var(--kn-accent-400)] motion-reduce:transition-none"
          />
        </span>
        <span className="text-[var(--kn-text-2)]">{description}</span>
        {meta && <span className="mt-auto pt-1">{meta}</span>}
      </Card>
    </Link>
  );
}

/* ------------------------------ preview ------------------------------ */

/**
 * On a page whose data belongs to someone else's account (a reseller's
 * clients), an owner previewing it sees this instead of a 403: the
 * preview filters what is drawn, it never borrows the account.
 */
export function PreviewNotice({
  what,
  manageHref,
  manageLabel,
}: {
  what: string;
  manageHref?: string;
  manageLabel?: string;
}) {
  const { exitPreview, preview } = useModes();
  return (
    <Card padding="lg" className="flex flex-col gap-3 border-[var(--kn-accent-500)]">
      <span className="flex items-center gap-2">
        <Eye size={15} aria-hidden className="text-[var(--kn-accent-400)]" />
        <MonoLabel tone="accent">Preview</MonoLabel>
      </span>
      <p className="max-w-[64ch] text-[var(--kn-text-2)]">
        {what} belong to a signed-in {preview ?? "reseller"} account, so a preview shows the
        layout without them. Your operator account is unchanged.
      </p>
      <div className="flex flex-wrap gap-2">
        {manageHref && <LinkButton href={manageHref}>{manageLabel ?? "Manage"}</LinkButton>}
        {preview && (
          <Button size="sm" onClick={exitPreview}>
            Exit preview
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Two-column property row used in detail rails. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <MonoLabel tone="muted">{label}</MonoLabel>
      <span className="min-w-0 truncate text-right text-[var(--kn-text)]">{children}</span>
    </div>
  );
}
