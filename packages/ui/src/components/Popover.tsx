"use client";

import * as React from "react";
import { Portal } from "./Portal.js";
import { useFloating, type Placement } from "../hooks/useFloating.js";
import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Popover — anchored panel with a cloned trigger.
 *
 * The trigger is passed as an element and cloned rather than wrapped:
 * a wrapper span would break table cells and dense toolbars, and React
 * 19 lets `ref` ride along as an ordinary prop, so no Slot component is
 * needed.
 * ------------------------------------------------------------------ */

type TriggerProps = React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> };

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.RefObject<T | null>).current = value;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0,
  );
}

export interface PopoverProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "title"
> {
  /** Anchors and toggles the panel. Cloned, not wrapped. */
  trigger: React.ReactElement;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  offset?: number;
  /** Keeps Tab inside the panel. Off by default: most popovers are read-mostly. */
  trapFocus?: boolean;
  /** Accessible name for the panel. */
  label?: string;
}

export const Popover = React.forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  {
    trigger,
    children,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    placement = "bottom-start",
    offset = 4,
    trapFocus = false,
    label,
    className,
    style: styleProp,
    onKeyDown,
    ...props
  },
  ref,
) {
  const anchorRef = React.useRef<HTMLElement | null>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const panelId = React.useId();

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );

  const { setFloating, floating, style } = useFloating<HTMLDivElement>(anchorRef, {
    placement,
    offset,
    open,
  });

  const setPanel = React.useCallback(
    (node: HTMLDivElement | null) => {
      setFloating(node);
      assignRef(ref, node);
    },
    [ref, setFloating],
  );

  const triggerEl = trigger as React.ReactElement<TriggerProps>;
  const triggerRef = triggerEl.props.ref;
  const setAnchor = React.useCallback(
    (node: HTMLElement | null) => {
      anchorRef.current = node;
      assignRef(triggerRef, node);
    },
    [triggerRef],
  );

  React.useEffect(() => {
    if (!open || !floating) return;
    restoreRef.current = anchorRef.current;
    const first = trapFocus ? focusables(floating)[0] : undefined;
    (first ?? floating).focus({ preventScroll: true });
  }, [floating, open, trapFocus]);

  React.useEffect(() => {
    if (open) return;
    const restore = restoreRef.current;
    restoreRef.current = null;
    if (!restore || !restore.isConnected) return;
    // Only reclaim focus if the panel still had it; a click elsewhere
    // has already chosen where focus belongs.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    restore.focus({ preventScroll: true });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (floating?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [floating, open, setOpen]);

  React.useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Claims the key so a layer underneath does not also close.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open, setOpen]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (!trapFocus || event.key !== "Tab" || event.defaultPrevented || !floating) return;
    const list = focusables(floating);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === floating)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const anchored = React.cloneElement(triggerEl, {
    ref: setAnchor,
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? panelId : undefined,
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      triggerEl.props.onClick?.(event);
      if (!event.defaultPrevented) setOpen(!open);
    },
  });

  return (
    <>
      {anchored}
      {open && (
        <Portal>
          <div
            {...props}
            ref={setPanel}
            id={panelId}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            style={{ ...style, ...styleProp }}
            onKeyDown={handleKeyDown}
            className={cn(
              "z-50 min-w-48 overflow-y-auto text-base text-[var(--kn-text)] outline-none",
              "rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] p-3",
              "shadow-[var(--kn-shadow-md)] animate-[var(--animate-scale-in)]",
              className,
            )}
          >
            {children}
          </div>
        </Portal>
      )}
    </>
  );
});
