"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";
import { Button, CopyableCode, Dialog, DialogBody, DialogFooter, DialogHeader } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * CredentialDialog — the one place a mailbox password is ever shown.
 *
 * Yunori generates the password on the host and the control plane
 * relays it in a single response (KD-024). It is not in a row, not in a
 * job result, not in a log. So this dialog cannot be dismissed by
 * clicking outside it — an accidental close would lose the credential
 * for good — and it says so in plain words rather than relying on the
 * operator to know.
 * ------------------------------------------------------------------ */

export interface Credential {
  address: string;
  password: string;
  /** "created" shows a welcome; "reset" warns that the old one is gone. */
  reason: "created" | "reset";
}

export interface CredentialDialogProps {
  credential: Credential | null;
  onClose: () => void;
}

export function CredentialDialog({ credential, onClose }: CredentialDialogProps) {
  const [acknowledged, setAcknowledged] = React.useState(false);

  React.useEffect(() => {
    if (credential === null) setAcknowledged(false);
  }, [credential]);

  return (
    <Dialog
      open={credential !== null}
      onOpenChange={(open) => !open && acknowledged && onClose()}
      size="md"
      dismissible={acknowledged}
    >
      {credential && (
        <>
          <DialogHeader
            title={credential.reason === "created" ? "Mailbox created" : "Password reset"}
            description={
              credential.reason === "created"
                ? "The mailbox exists on the host and this is its password."
                : `The old password for ${credential.address} stopped working the moment this one was set. Devices still signed in will start asking for it.`
            }
          />
          <DialogBody>
            <div className="flex flex-col gap-3">
              <CopyableCode value={credential.address} label="Address" />
              <CopyableCode value={credential.password} label="Password" />
              <p className="flex items-start gap-2 text-sm text-[var(--kn-text-2)]">
                <KeyRound size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
                <span>
                  This is the only time this password is shown. Store it in your password manager
                  now; Kaname does not keep it. If it is lost, the only remedy is another reset.
                </span>
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="primary"
              onClick={() => {
                setAcknowledged(true);
                onClose();
              }}
            >
              I have stored it
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
