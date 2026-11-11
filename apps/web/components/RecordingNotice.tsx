"use client";

import { RadioTower, ShieldAlert } from "lucide-react";
import { MonoText } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * Whether a shell is being recorded, stated for as long as it is open
 * (KD-013). Shared by the host terminal and a container's Exec tab,
 * because both are the same recorded path and must say so the same way.
 * ------------------------------------------------------------------ */

export function RecordingNotice({ recorded, serverName }: { recorded: boolean; serverName: string }) {
  if (recorded) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-[var(--kn-r-md)] border border-[color-mix(in_srgb,var(--kn-info)_45%,transparent)] bg-[var(--kn-info-soft)] px-3 py-2.5"
      >
        <RadioTower size={14} className="mt-0.5 shrink-0 text-[var(--kn-info)]" aria-hidden />
        <p className="text-[var(--kn-text)]">
          <span className="font-medium">This session is being recorded.</span> Everything typed and
          everything printed on <MonoText>{serverName}</MonoText> is stored and replayable, and
          reading that recording back is itself audited.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-[var(--kn-r-md)] border border-[color-mix(in_srgb,var(--kn-warn)_45%,transparent)] bg-[var(--kn-warn-soft)] px-3 py-2.5"
    >
      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
      <p className="text-[var(--kn-text)]">
        <span className="font-medium">This session is not being recorded.</span> Session recording
        is switched off for this install — the open and close are still audited, but what happens in
        between is not.
      </p>
    </div>
  );
}
