"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { EyeOff } from "lucide-react";
import { Button, Drawer, DrawerBody, DrawerHeader, Eyebrow, Spinner } from "@kaname/ui";
import { redirectToLogin } from "@/lib/api";
import { AUDIENCE_LABELS, useModes } from "@/lib/modes";
import { useSession } from "@/lib/queries";
import { JobDrawer } from "./JobDrawer";
import { PageError } from "./PageError";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/* ------------------------------------------------------------------ *
 * AppShell — the frame every authenticated page renders inside.
 *
 * Desktop-first: a fixed 240px rail that collapses to 56px, a 52px
 * topbar, and one scroll container for the page body. The body is the
 * ffstudios canvas (`.kn-canvas`): the faint blueprint grid plus two
 * vertical frame rails half a gutter in from each edge, which the page
 * headers' crosshair marks register against. Below 1024px the
 * rail becomes a sheet, because a 232px column on a tablet costs a
 * quarter of a dense table's width for navigation that is not being
 * read.
 *
 * The global surfaces — palette, job drawer, shortcut sheet — live here
 * rather than on any page, so they survive navigation and so a job
 * started anywhere is still watchable everywhere.
 *
 * View mode, audience and the "view as" preview (KD-039) come from
 * lib/modes.tsx, so the sidebar, top bar, palette and pages read one
 * answer to "what is this person shown"; the preview banner sits here.
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
      <div className="kn-grid flex h-dvh items-center justify-center bg-[var(--kn-bg)] px-4">
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
    <Frame
      collapsed={collapsed}
      changeCollapsed={changeCollapsed}
      navOpen={navOpen}
      setNavOpen={setNavOpen}
    >
      {children}
    </Frame>
  );
}

interface FrameProps {
  collapsed: boolean;
  changeCollapsed: (next: boolean) => void;
  navOpen: boolean;
  setNavOpen: (open: boolean) => void;
  children: React.ReactNode;
}

function Frame({ collapsed, changeCollapsed, navOpen, setNavOpen, children }: FrameProps) {
  const { branding } = useModes();
  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-[var(--kn-bg)]">
      <a href="#kn-main" className="kn-skip-link">
        <span className="inline-flex h-8 items-center rounded-[var(--kn-r-pill)] border border-[var(--kn-accent-500)] bg-[var(--kn-surface)] px-4 text-[var(--kn-text)]">
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
        <DrawerHeader
          title={branding?.display_name ?? "Kaname"}
          description="Jump to any section."
        />
        <DrawerBody className="px-0 py-0">
          <Sidebar variant="drawer" onNavigate={() => setNavOpen(false)} />
        </DrawerBody>
      </Drawer>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar onOpenNav={() => setNavOpen(true)} />
        <PreviewBanner />
        <main id="kn-main" tabIndex={-1} className="kn-canvas flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto outline-none">
          {children}
        </main>
      </div>

      <JobDrawer />
      <KeyboardShortcuts />
    </div>
  );
}

/**
 * Shown for as long as an owner is "viewing as" someone. It says what
 * the preview is and is not, and ends it in one click.
 */
function PreviewBanner() {
  const { preview, exitPreview } = useModes();
  if (!preview) return null;
  return (
    <div
      role="status"
      data-testid="preview-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--kn-accent-500)] bg-[var(--kn-accent-soft)] px-3 py-2 lg:px-6"
    >
      <Eyebrow>Preview</Eyebrow>
      <p className="min-w-0 flex-1 text-[var(--kn-text)]">
        Viewing as {AUDIENCE_LABELS[preview].toLowerCase()}
        <span className="text-[var(--kn-text-2)]">
          {" "}
          — navigation and home only. Nothing is granted and nobody is impersonated; your own
          permissions still apply.
        </span>
      </p>
      <Button size="xs" variant="primary" icon={EyeOff} onClick={exitPreview}>
        Exit preview
      </Button>
    </div>
  );
}
