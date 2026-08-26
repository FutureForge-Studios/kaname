"use client";

import * as React from "react";
import { useIsomorphicLayoutEffect } from "../components/Portal.js";

/* ------------------------------------------------------------------ *
 * useFloating — anchored positioning for menus, popovers and tooltips.
 *
 * Deliberately not @floating-ui: the kit needs one placement pass with
 * a flip, a clamp and a viewport-derived max size. That is ~120 lines
 * and no dependency.
 *
 * Coordinates are viewport coordinates applied with `position: fixed`,
 * so a layer stays correct inside scroll containers and transformed
 * ancestors without ever measuring an offset parent.
 * ------------------------------------------------------------------ */

export type Placement =
  | "top"
  | "top-start"
  | "top-end"
  | "right"
  | "right-start"
  | "right-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end";

type Side = "top" | "right" | "bottom" | "left";
type Align = "start" | "center" | "end";

const OPPOSITE: Record<Side, Side> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/** Floor for the derived max size — below this both sides are cramped. */
const MIN_SIZE = 96;

export interface UseFloatingOptions {
  placement?: Placement;
  /** Gap between anchor and layer. On the 4px grid. */
  offset?: number;
  /** Distance kept from the viewport edge. */
  padding?: number;
  /** Measurement and listeners only run while this is true. */
  open?: boolean;
  /** Layer takes the anchor's width — comboboxes, selects. */
  matchAnchorWidth?: boolean;
}

export interface UseFloatingResult<F extends HTMLElement> {
  /** Attach to the floating element. */
  setFloating: React.RefCallback<F>;
  /** The floating node itself, for `contains()` checks and effect deps. */
  floating: F | null;
  style: React.CSSProperties;
  /** What was actually used — differs from the request after a flip. */
  placement: Placement;
  /** Force a reposition (content grew, anchor moved). */
  update: () => void;
}

function split(placement: Placement): { side: Side; align: Align } {
  const dash = placement.indexOf("-");
  if (dash === -1) return { side: placement as Side, align: "center" };
  return {
    side: placement.slice(0, dash) as Side,
    align: placement.slice(dash + 1) as Align,
  };
}

function join(side: Side, align: Align): Placement {
  return (align === "center" ? side : `${side}-${align}`) as Placement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const HIDDEN: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  visibility: "hidden",
};

export function useFloating<F extends HTMLElement = HTMLDivElement>(
  anchorRef: React.RefObject<HTMLElement | null>,
  options: UseFloatingOptions = {},
): UseFloatingResult<F> {
  const {
    placement: requested = "bottom-start",
    offset = 4,
    padding = 8,
    open = true,
    matchAnchorWidth = false,
  } = options;

  const [floating, setFloatingNode] = React.useState<F | null>(null);
  const [resolved, setResolved] = React.useState<{
    style: React.CSSProperties;
    placement: Placement;
  }>({ style: HIDDEN, placement: requested });

  // A node in state rather than a ref: positioning has to re-run on the
  // commit that mounts the layer, and a ref mutation does not re-render.
  const setFloating = React.useCallback<React.RefCallback<F>>((node) => {
    setFloatingNode(node);
  }, []);

  const update = React.useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || !floating) return;

    const rect = anchor.getBoundingClientRect();
    const width = floating.offsetWidth;
    const height = floating.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const { side: wanted, align } = split(requested);
    const room: Record<Side, number> = {
      top: rect.top - padding - offset,
      bottom: vh - rect.bottom - padding - offset,
      left: rect.left - padding - offset,
      right: vw - rect.right - padding - offset,
    };

    const needed = wanted === "top" || wanted === "bottom" ? height : width;
    const flipped = OPPOSITE[wanted];
    const side = room[wanted] < needed && room[flipped] > room[wanted] ? flipped : wanted;
    const vertical = side === "top" || side === "bottom";

    let left: number;
    let top: number;
    if (vertical) {
      top = side === "top" ? rect.top - height - offset : rect.bottom + offset;
      left =
        align === "start"
          ? rect.left
          : align === "end"
            ? rect.right - width
            : rect.left + (rect.width - width) / 2;
    } else {
      left = side === "left" ? rect.left - width - offset : rect.right + offset;
      top =
        align === "start"
          ? rect.top
          : align === "end"
            ? rect.bottom - height
            : rect.top + (rect.height - height) / 2;
    }

    const style: React.CSSProperties = {
      position: "fixed",
      left: Math.round(clamp(left, padding, vw - width - padding)),
      top: Math.round(clamp(top, padding, vh - height - padding)),
      maxWidth: Math.round(Math.max(vw - padding * 2, MIN_SIZE)),
      maxHeight: Math.round(Math.max(vertical ? room[side] : vh - padding * 2, MIN_SIZE)),
    };
    if (matchAnchorWidth) style.width = Math.round(rect.width);

    const next = join(side, align);
    setResolved((prev) => {
      const p = prev.style;
      const same =
        prev.placement === next &&
        p.left === style.left &&
        p.top === style.top &&
        p.maxWidth === style.maxWidth &&
        p.maxHeight === style.maxHeight &&
        p.width === style.width;
      // Bailing out matters: a ResizeObserver feeding an unconditional
      // setState is an infinite loop.
      return same ? prev : { style, placement: next };
    });
  }, [anchorRef, floating, matchAnchorWidth, offset, padding, requested]);

  useIsomorphicLayoutEffect(() => {
    if (open) update();
  }, [open, update]);

  React.useEffect(() => {
    if (!open || !floating) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    // Capture phase so scrolling ancestors — not just the window — drag
    // the layer along with its anchor.
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);

    const observer = new ResizeObserver(schedule);
    const anchor = anchorRef.current;
    if (anchor) observer.observe(anchor);
    observer.observe(floating);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [anchorRef, floating, open, update]);

  return { setFloating, floating, style: resolved.style, placement: resolved.placement, update };
}
