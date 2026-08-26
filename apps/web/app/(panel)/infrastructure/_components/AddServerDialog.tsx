"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createServerInput, type Server } from "@kaname/contract";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  Input,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCreateServer } from "../_lib/infra";
import { EnrollmentPanel } from "./EnrollmentPanel";

/* ------------------------------------------------------------------ *
 * Add server.
 *
 * Creating the row is only half the act — a server nobody enrolled is a
 * name in a table. So the dialog does not close on save: it hands over
 * to the enrollment panel, which mints the token, shows the one-liner
 * and waits for the agent to dial in (PLAN.md 2.3).
 * ------------------------------------------------------------------ */

export interface AddServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Draft {
  name: string;
  hostname: string;
  address: string;
  provider: string;
}

const EMPTY: Draft = { name: "", hostname: "", address: "", provider: "" };

export function AddServerDialog({ open, onOpenChange }: AddServerDialogProps) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [created, setCreated] = React.useState<Server | null>(null);

  const create = useCreateServer(setCreated);

  React.useEffect(() => {
    if (open) return;
    // Reset only once closed, so nothing flickers on the way out.
    setDraft(EMPTY);
    setFieldErrors({});
    setCreated(null);
  }, [open]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = createServerInput.safeParse({
      name: draft.name.trim(),
      hostname: draft.hostname.trim(),
      address: draft.address.trim() || undefined,
      provider: draft.provider.trim() || undefined,
      labels: {},
    });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    create.mutate(parsed.data);
  };

  const errorFor = (field: keyof Draft): string | undefined =>
    fieldErrors[field] ?? create.error?.fields[field];

  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((previous) => ({ ...previous, [field]: event.target.value }));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size={created ? "lg" : "md"}
      dismissible={!create.isPending}
    >
      {created ? (
        <>
          <DialogHeader
            title={`Enroll ${created.name}`}
            description="Kaname never dials a host. Run this on the box and the agent dials out to the control plane."
          />
          <DialogBody>
            <EnrollmentPanel server={created} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                router.push(`/infrastructure/servers/${created.id}`);
                onOpenChange(false);
              }}
            >
              Open server
            </Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader
            title="Add server"
            description="Creating the row mints a single-use enrollment token. Nothing reaches the host until you run the command it prints."
          />
          <DialogBody className="flex flex-col gap-3">
            {create.error && Object.keys(create.error.fields).length === 0 && (
              <PageError error={create.error} context="Add server" />
            )}
            <FormField label="Name" required error={errorFor("name")}>
              <Input
                data-autofocus=""
                value={draft.name}
                onChange={set("name")}
                placeholder="web-01"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField
              label="Hostname"
              required
              error={errorFor("hostname")}
              description="What the box calls itself. The agent reports it back at enrollment, so a mismatch is visible."
            >
              <Input
                mono
                value={draft.hostname}
                onChange={set("hostname")}
                placeholder="web-01.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                label="Address"
                error={errorFor("address")}
                description="Where you reach it, for your own reference."
              >
                <Input
                  mono
                  value={draft.address}
                  onChange={set("address")}
                  placeholder="203.0.113.10"
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField label="Provider" error={errorFor("provider")}>
                <Input
                  value={draft.provider}
                  onChange={set("provider")}
                  placeholder="Hetzner"
                  autoComplete="off"
                />
              </FormField>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create and enroll
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
