"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import type { Job } from "@kaname/contract";
import {
  Button,
  CopyButton,
  CopyableCode,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  IconButton,
  Input,
  JobProgress,
  JobStatusPill,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useJob } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Credential controls.
 *
 * A transfer account and a mailbox both hand a human a password that
 * gets pasted into a mail client or an SFTP client once and then lives
 * for years. Kaname never stores it retrievably — it is envelope
 * encrypted for the host and nothing reads it back — so the panel shows
 * it exactly once, at the moment it is set, and says so plainly.
 *
 * Generating it here rather than asking the operator to invent one is
 * deliberate: the contract's floor is 16 characters, and the passwords
 * humans type into a "new password" box are the ones that end up in the
 * mail-bruteforce list on the Threats page.
 * ------------------------------------------------------------------ */

/**
 * No 0/O/1/l/I and no quoting-sensitive punctuation: this string is
 * read off a screen and pasted into config files and shell one-liners.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_=+.@%^";

export function generatePassword(length = 24): string {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += ALPHABET.charAt((values[index] ?? 0) % ALPHABET.length);
  }
  return out;
}

/* ------------------------------ field ------------------------------- */

export interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  disabled?: boolean;
}

/**
 * Shown in plain text on purpose. Masking a credential the operator has
 * to transcribe into another application buys nothing — it is on screen
 * for one dialog, and hiding it only invites a typo they cannot see.
 */
export function PasswordField({
  value,
  onChange,
  label = "Password",
  description,
  error,
  required = true,
  disabled = false,
}: PasswordFieldProps) {
  return (
    <FormField
      label={label}
      description={
        description ??
        "Kaname shows this once. Copy it into the client before you close this dialog."
      }
      error={error}
      required={required}
      hint={`${value.length} characters`}
    >
      <Input
        mono
        value={value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        trailing={
          <>
            <IconButton
              icon={RefreshCw}
              label="Generate a new password"
              size="xs"
              disabled={disabled}
              onClick={() => onChange(generatePassword())}
            />
            <CopyButton value={value} label="Copy password" size="xs" />
          </>
        }
      />
    </FormField>
  );
}

/* ------------------------------ dialog ------------------------------ */

export interface PasswordResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the credential belongs to — an address, a username. */
  subject: string;
  password: string;
  onPasswordChange: (password: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error?: unknown;
  /** The queued job, once there is one. Its pill replaces the form. */
  job: Job | null;
  /** Extra controls above the credential — "sign out active sessions". */
  extra?: React.ReactNode;
}

/**
 * Two phases in one dialog: arm the change, then watch the job that
 * applies it. The password stays on screen through both, because the
 * moment it disappears there is no way to get it back (KD-008 means the
 * reset is still in flight when the dialog would otherwise close).
 */
export function PasswordResetDialog({
  open,
  onOpenChange,
  subject,
  password,
  onPasswordChange,
  onSubmit,
  submitting,
  error,
  job,
  extra,
}: PasswordResetDialogProps) {
  const queued = job !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" dismissible={!submitting}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (queued) onOpenChange(false);
          else if (!submitting && password.length >= 16) onSubmit();
        }}
      >
        <DialogHeader
          title={queued ? "Password reset queued" : "Reset password"}
          description={
            queued
              ? `The host is being told about the new credential for ${subject}. Sessions already open keep working until the job lands.`
              : `Kaname will set a new password for ${subject} on the host. The old one stops working the moment the job succeeds.`
          }
        />

        <DialogBody>
          <div className="flex flex-col gap-3">
            {error != null && <PageError error={error} />}

            {queued && job && <JobWatch job={job} />}

            {!queued && extra}

            <CopyableCode value={password} label={`New password for ${subject}`} />

            <p className="text-sm text-[var(--kn-text-2)]">
              This is the only time this password is shown. Kaname stores it encrypted for the host
              and cannot read it back, so if it is lost the only remedy is another reset.
            </p>

            {!queued && (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={RefreshCw}
                  disabled={submitting}
                  onClick={() => onPasswordChange(generatePassword())}
                >
                  Generate a different one
                </Button>
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          {!queued && (
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" loading={submitting}>
            {queued ? "Done" : "Reset password"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Live job state for the dialog that started it. */
function JobWatch({ job }: { job: Job }) {
  const query = useJob(job.id);
  const current = query.data ?? job;

  return (
    <div className="flex flex-col gap-2 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] p-3">
      <div className="flex min-w-0 items-center gap-2">
        <JobStatusPill status={current.status} size="xs" blockedReason={current.blocked_reason} />
        <span className="min-w-0 truncate text-[var(--kn-text)]">{current.label}</span>
      </div>
      <JobProgress value={current.progress} status={current.status} label="Reset progress" />
      {current.error && (
        <p className="text-xs text-[var(--kn-danger)]">
          <span className="kn-mono">{current.error.code}</span> — {current.error.message}
        </p>
      )}
    </div>
  );
}
