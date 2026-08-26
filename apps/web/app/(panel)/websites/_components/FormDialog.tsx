"use client";

import * as React from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  type DialogSize,
} from "@kaname/ui";
import { isApiError, type ApiError } from "@/lib/api";
import { PageError } from "@/components/PageError";

/* ------------------------------------------------------------------ *
 * FormDialog — the one create/edit surface in this module.
 *
 * Creating a site, adding a domain, writing a DNS record and issuing a
 * certificate are four different operations that must feel like one
 * gesture: same header, same field column, same Cancel/Confirm order,
 * same place for the failure to appear. That only holds if there is a
 * single component, so there is.
 *
 * The failure is rendered with the same ErrorState the rest of the
 * product uses, which means the control plane's `remediation` — the
 * record to publish, the site to open — is offered inside the dialog
 * rather than discarded into a toast.
 * ------------------------------------------------------------------ */

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  submitLabel: string;
  /** Blocks the form and pins the dialog open while the request is in flight. */
  submitting?: boolean;
  /** Set false while required fields are missing. */
  canSubmit?: boolean;
  error?: unknown;
  onSubmit: () => void;
  size?: DialogSize;
  destructive?: boolean;
  /** Extra control on the left of the footer — "Use http-01", "Advanced". */
  footerExtra?: React.ReactNode;
  children: React.ReactNode;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  submitting = false,
  canSubmit = true,
  error,
  onSubmit,
  size = "md",
  destructive = false,
  footerExtra,
  children,
}: FormDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size={size}
      dismissible={!submitting}
      aria-busy={submitting || undefined}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !submitting) onSubmit();
        }}
      >
        <DialogHeader title={title} description={description} />
        <DialogBody>
          <div className="flex flex-col gap-3">
            {error != null && <PageError error={error} />}
            {children}
          </div>
        </DialogBody>
        <DialogFooter>
          {footerExtra && <div className="mr-auto flex items-center gap-2">{footerExtra}</div>}
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant={destructive ? "danger" : "primary"}
            loading={submitting}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * The control plane returns per-field messages on a 422, so a rejected
 * form marks the field that caused it instead of only printing a banner.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  return isApiError(error) ? (error as ApiError).fields : {};
}
