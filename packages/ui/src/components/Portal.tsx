"use client";

import * as React from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ *
 * Portal — every overlay in the kit (menu, popover, tooltip, dialog,
 * drawer, toast) renders through here. Dense tables clip their own
 * cells with `overflow:hidden`, and sticky headers create stacking
 * contexts; escaping to <body> is the only way an anchored layer can
 * survive both.
 * ------------------------------------------------------------------ */

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server. Overlays
 * measure the DOM before paint, which React refuses to do during SSR.
 */
export const useIsomorphicLayoutEffect =
  typeof document !== "undefined" ? React.useLayoutEffect : React.useEffect;

export interface PortalProps {
  /** Defaults to `document.body`. */
  container?: Element | null;
  children: React.ReactNode;
}

export function Portal({ container, children }: PortalProps) {
  const [target, setTarget] = React.useState<Element | null>(null);

  // Resolved after mount so the server render and the first client
  // render agree on "nothing here yet".
  React.useEffect(() => {
    setTarget(container ?? document.body);
  }, [container]);

  return target ? createPortal(children, target) : null;
}
