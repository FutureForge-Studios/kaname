"use client";

import * as React from "react";
import { MonoLabel, SegmentedControl } from "@kaname/ui";
import { AUDIENCE_LABELS, useModes } from "@/lib/modes";

/** The view-mode preference, for the account page (the top bar has the same switch). */
export function ViewModeSettings() {
  const { viewMode, setViewMode, actualAudience, branding } = useModes();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[var(--kn-text)]">View mode</p>
          <p className="text-[var(--kn-text-2)]">
            Simplified hides expert pages and opens on everyday tasks. It changes what is shown,
            never what you are allowed to do. Saved to your account.
          </p>
        </div>
        <SegmentedControl
          label="View mode"
          options={[
            { value: "simplified", label: "Simplified" },
            { value: "advanced", label: "Advanced" },
          ]}
          value={viewMode}
          onValueChange={setViewMode}
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--kn-border)] pt-3">
        <MonoLabel tone="muted">Account type</MonoLabel>
        <span className="text-[var(--kn-text)]">{AUDIENCE_LABELS[actualAudience]}</span>
        {branding && actualAudience === "client" && (
          <span className="text-[var(--kn-text-2)]">· provided by {branding.display_name}</span>
        )}
      </div>
    </div>
  );
}
