import * as React from "react";
import { cn } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * AppMark — a simple line drawing per catalog app.
 *
 * Deliberately not the projects' logos: a one-colour geometric glyph
 * in the ffstudios line style (1.5px stroke, currentColor, round
 * joins), so the gallery reads as one family and nothing here pretends
 * to be the upstream brand. An unknown id falls back to a package box.
 * ------------------------------------------------------------------ */

const MARKS: Record<string, React.ReactNode> = {
  // A page with a "W"-like zigzag: publishing.
  wordpress: (
    <>
      <circle cx="24" cy="24" r="15" />
      <path d="M13 18l5 14 6-12 6 12 5-14" />
    </>
  ),
  // Stacked pages: a wiki.
  dokuwiki: (
    <>
      <path d="M15 12h14l6 6v18H15z" />
      <path d="M29 12v6h6" />
      <path d="M19 24h12M19 29h12M19 34h8" />
    </>
  ),
  // A ghostly arch with a newsletter line.
  ghost: (
    <>
      <path d="M14 36V22a10 10 0 0 1 20 0v14l-4-3-3 3-3-3-3 3-3-3z" />
      <circle cx="20" cy="22" r="1.5" />
      <circle cx="28" cy="22" r="1.5" />
    </>
  ),
  // A cloud of three circles: files you host.
  nextcloud: (
    <>
      <circle cx="14" cy="26" r="5" />
      <circle cx="24" cy="26" r="8" />
      <circle cx="34" cy="26" r="5" />
    </>
  ),
  // A heartbeat line: uptime.
  "uptime-kuma": (
    <>
      <rect x="10" y="12" width="28" height="24" rx="4" />
      <path d="M14 26h6l3-7 4 12 3-5h4" />
    </>
  ),
  // Three linked nodes: a workflow.
  n8n: (
    <>
      <circle cx="13" cy="24" r="4" />
      <circle cx="35" cy="15" r="4" />
      <circle cx="35" cy="33" r="4" />
      <path d="M17 24h6l8-9M23 24l8 9" />
    </>
  ),
  // A branch: git.
  gitea: (
    <>
      <circle cx="16" cy="13" r="3.5" />
      <circle cx="16" cy="35" r="3.5" />
      <circle cx="32" cy="18" r="3.5" />
      <path d="M16 16.5v15M32 21.5c0 7-16 5-16 10" />
    </>
  ),
};

const FALLBACK = (
  <>
    <path d="M24 10l13 7v14l-13 7-13-7V17z" />
    <path d="M11 17l13 7 13-7M24 24v14" />
  </>
);

export interface AppMarkProps extends React.SVGAttributes<SVGSVGElement> {
  appId: string;
  size?: number;
}

export function AppMark({ appId, size = 48, className, ...props }: AppMarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("shrink-0", className)}
      {...props}
    >
      {MARKS[appId] ?? FALLBACK}
    </svg>
  );
}

/** "v6.8" for a numbered release, the bare word for a channel such as "stable". */
export function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}
