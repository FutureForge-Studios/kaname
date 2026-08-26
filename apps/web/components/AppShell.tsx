"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Drawer, DrawerBody, DrawerHeader, Spinner } from "@kaname/ui";
import { redirectToLogin } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { JobDrawer } from "./JobDrawer";
import { PageError } from "./PageError";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/* ------------------------------------------------------------------ *
 * AppShell — the frame every authenticated page renders inside.
 *
 * Desktop-first: a fixed 232px rail that collapses to 56px, a 48px
 * topbar, and one scroll container for the page body. Below 1024px the
 * rail becomes a sheet, because a 232px column on a tablet costs a
 * quarter of a dense table's width for navigation that is not being
 * read.
 *
 * The global surfaces — palette, job drawer, shortcut sheet — live here
 * rather than on any page, so they survive navigation and so a job
 * started anywhere is still watchable everywhere.
 * ------------------------------------------------------------------ */

const COLLAPSE_KEY = "kaname.sidebar.collapsed";

function readCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, isLoading, error, refresh } = useSession();
  const [collapsed, setCollapsed] = React.useState(false);
  const [navOpen, setNavOpen] = React.useState(false);

  const signedIn = Boolean(session?.user ?? session?.api_key);

  /*
   * An unreachable control plane is not an expired session, and bouncing
   * to a sign-in form that also cannot reach it helps nobody. Only a
   * resolved "you are not signed in" sends the operator to /login.
   */
  const unreachable = Boolean(error) && error?.code !== "unauthenticated";

  React.useEffect(() => {
    if (!isLoading && !signedIn && !unreachable) redirectToLogin();
  }, [isLoading, signedIn, unreachable]);

  /* Read after mount: the server has no idea what this browser prefers,
   * and guessing would flash the wrong width on every load. */
  React.useEffect(() => setCollapsed(readCollapsed()), []);

  const changeCollapsed = React.useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* The preference is a convenience, not state the app depends on. */
    }
  }, []);

  React.useEffect(() => setNavOpen(false), [pathname]);

  if (!signedIn) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[var(--kn-bg)] px-4">
        {unreachable ? (
          <div className="w-full max-w-md">
            <PageError error={error} onRetry={refresh} context="Session" />
          </div>
        ) : (
          <div role="status" aria-live="polite">
            <Spinner
              size={16}
              label={isLoading ? "Checking your session" : "Redirecting to sign in"}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-[var(--kn-bg)]">
      <a href="#kn-main" className="kn-skip-link">
        <span className="inline-flex h-8 items-center rounded-[var(--kn-r-md)] border border-[var(--kn-accent-500)] bg-[var(--kn-surface)] px-3 text-[var(--kn-text)]">
          Skip to content
        </span>
      </a>

      <aside
        style={{
          width: collapsed ? "var(--kn-sidebar-collapsed-w)" : "var(--kn-sidebar-w)",
        }}
        className="hidden shrink-0 transition-[width] duration-[var(--kn-dur)] ease-[var(--kn-ease)] motion-reduce:transition-none lg:block"
      >
        <Sidebar collapsed={collapsed} onCollapsedChange={changeCollapsed} />
      </aside>

      <Drawer open={navOpen} onOpenChange={setNavOpen} side="bottom" label="Navigation">
        <DrawerHeader title="Kaname" description="Jump to any section." />
        <DrawerBody className="px-0 py-0">
          <Sidebar variant="drawer" onNavigate={() => setNavOpen(false)} />
        </DrawerBody>
      </Drawer>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar onOpenNav={() => setNavOpen(true)} />
        <main id="kn-main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto outline-none">
          {children}
        </main>
      </div>

      <JobDrawer />
      <KeyboardShortcuts />
    </div>
  );
}
