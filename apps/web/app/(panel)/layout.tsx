import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

/*
 * Everything behind the session cookie renders inside the shell. The
 * segment is dynamic because every page under it reads live control
 * plane state and its own query string — there is nothing here worth
 * prerendering, and a prerendered shell would only serve a stale
 * navigation to an operator who no longer holds those permissions.
 */
export const dynamic = "force-dynamic";

export default function PanelLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
