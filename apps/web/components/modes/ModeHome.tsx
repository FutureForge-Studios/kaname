"use client";

import * as React from "react";
import { useModes } from "@/lib/modes";
import { ClientHome } from "./ClientHome";
import { ResellerHome } from "./ResellerHome";
import { SimplifiedHome } from "./SimplifiedHome";

/* ------------------------------------------------------------------ *
 * The home page for the person signed in, in their current mode
 * (KD-039). A client or reseller — real or previewed — gets their own
 * home; an operator in Simplified gets the task cards; an operator in
 * Advanced gets `fallback` (the Command Center), or null.
 * ------------------------------------------------------------------ */

export function ModeHome({ fallback = null }: { fallback?: React.ReactNode }) {
  const { audience, viewMode, accountQuery } = useModes();
  // Wait for /me before choosing, so a client never flashes the Command Center.
  if (accountQuery.isLoading) return null;
  if (audience === "client") return <ClientHome />;
  if (audience === "reseller") return <ResellerHome />;
  if (viewMode === "simplified") return <SimplifiedHome />;
  return <>{fallback}</>;
}

/** True when ModeHome would draw its own home instead of the fallback. */
export function useHasModeHome(): boolean {
  const { audience, viewMode } = useModes();
  return audience !== "operator" || viewMode === "simplified";
}
