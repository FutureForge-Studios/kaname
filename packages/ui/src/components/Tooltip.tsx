"use client";

import * as React from "react";
import { Portal } from "./Portal.js";
import { useFloating, type Placement } from "../hooks/useFloating.js";
import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Tooltip — hover and keyboard focus, 400ms in, 0ms out.
 *
 * It never takes focus and never traps it: the panel is pointer-events
 * transparent and only ever described by `aria-describedby`. A tooltip
 * that can be focused is a popover wearing a disguise.
 * ------------------------------------------------------------------ */

type TriggerProps = React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> };

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.RefObject<T | null>).current = value;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export interface TooltipProps {
  /** The described element. Cloned, not wrapped. */
  children: React.ReactElement;
  content: React.ReactNode;
  placement?: Placement;
  /** Open delay in ms. Close is always immediate. */
  delay?: number;
  offset?: number;
  disabled?: boolean;
  className?: string;
}

export function Tooltip({
  children,
  content,
  placement = "top",
  delay = 400,
  offset = 6,
  disabled = false,
  className,
}: TooltipProps) {
  const anchorRef = React.useRef<HTMLElement | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const [open, setOpen] = React.useState(false);
  const tooltipId = React.useId();
  const reducedMotion = usePrefersReducedMotion();

  const { setFloating, style } = useFloating<HTMLDivElement>(anchorRef, {
    placement,
    offset,
    open,
  });

  const cancel = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = React.useCallback(
    (immediate: boolean) => {
      cancel();
      if (immediate || delay <= 0) {
        setOpen(true);
        return;
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setOpen(true);
      }, delay);
    },
    [cancel, delay],
  );

  const hide = React.useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  React.useEffect(() => cancel, [cancel]);

  React.useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  // WCAG 1.4.13: a pointer-triggered tooltip must be dismissible.
  React.useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [hide, open]);

  const triggerEl = children as React.ReactElement<TriggerProps>;
  const triggerRef = triggerEl.props.ref;
  const setAnchor = React.useCallback(
    (node: HTMLElement | null) => {
      anchorRef.current = node;
      assignRef(triggerRef, node);
    },
    [triggerRef],
  );

  if (disabled || content === null || content === undefined || content === "") {
    return children;
  }

  const described = [triggerEl.props["aria-describedby"], open ? tooltipId : null]
    .filter(Boolean)
    .join(" ");

  const anchored = React.cloneElement(triggerEl, {
    ref: setAnchor,
    "aria-describedby": described === "" ? undefined : described,
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      triggerEl.props.onPointerEnter?.(event);
      if (event.pointerType !== "touch") show(false);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      triggerEl.props.onPointerLeave?.(event);
      hide();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      triggerEl.props.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      triggerEl.props.onFocus?.(event);
      // Keyboard focus only — a click already showed the hover tooltip.
      if (event.currentTarget.matches(":focus-visible")) show(true);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      triggerEl.props.onBlur?.(event);
      hide();
    },
  });

  return (
    <>
      {anchored}
      {open && (
        <Portal>
          <div
            ref={setFloating}
            id={tooltipId}
            role="tooltip"
            style={style}
            className={cn(
              "pointer-events-none z-50 max-w-64 text-sm text-[var(--kn-text)]",
              "rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-surface-3)] px-2 py-1",
              "shadow-[var(--kn-shadow-md)]",
              !reducedMotion && "animate-[var(--animate-fade-in)]",
              className,
            )}
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  );
}
