"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Portal } from "./Portal.js";
import { IconButton } from "./Button.js";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Drawer — the job drawer and every resource detail pane.
 *
 * Same modal semantics as Dialog (focus trap, scroll lock, Escape from
 * its own subtree), but it slides, so it animates on the way out too:
 * a detail pane that vanishes gives no sense of where it went.
 * ------------------------------------------------------------------ */

export type DrawerSide = "right" | "bottom";
export type DrawerSize = "sm" | "md" | "lg";

/** Matches --kn-dur; the panel unmounts once the slide has finished. */
const EXIT_MS = 160;

const RIGHT_SIZES: Record<DrawerSize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-xl",
  lg: "sm:max-w-3xl",
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0,
  );
}

let lockCount = 0;
let lockedOverflow = "";
let lockedPadding = "";

function lockScroll(): () => void {
  if (lockCount === 0) {
    lockedOverflow = document.body.style.overflow;
    lockedPadding = document.body.style.paddingRight;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
  }
  lockCount += 1;

  return () => {
    lockCount -= 1;
    if (lockCount === 0) {
      document.body.style.overflow = lockedOverflow;
      document.body.style.paddingRight = lockedPadding;
    }
  };
}

interface DrawerContextValue {
  titleId: string;
  descriptionId: string;
  dismissible: boolean;
  close: () => void;
  setHasDescription: (has: boolean) => void;
}

const DrawerContext = React.createContext<DrawerContextValue | null>(null);

function useDrawerContext(part: string): DrawerContextValue {
  const context = React.useContext(DrawerContext);
  if (!context) throw new Error(`${part} must be rendered inside <Drawer>`);
  return context;
}

export interface DrawerProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "title"
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** `bottom` is the narrow-viewport form; pick it from the app's breakpoint. */
  side?: DrawerSide;
  /** Width of the right-hand form. The bottom sheet is always full width. */
  size?: DrawerSize;
  dismissible?: boolean;
  /** Accessible name when the drawer has no DrawerHeader. */
  label?: string;
}

export const Drawer = React.forwardRef<HTMLDivElement, DrawerProps>(function Drawer(
  {
    open,
    onOpenChange,
    children,
    side = "right",
    size = "md",
    dismissible = true,
    label,
    className,
    onKeyDown,
    ...props
  },
  ref,
) {
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null);
  const [present, setPresent] = React.useState(open);
  const [entered, setEntered] = React.useState(false);
  const [hasDescription, setHasDescription] = React.useState(false);
  const restoreRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);

  const setPanelRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setPanel(node);
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  React.useEffect(() => {
    if (open) {
      setPresent(true);
      // One frame at the closed transform, then transition to open.
      const frame = window.requestAnimationFrame(() => setEntered(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setEntered(false);
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    return lockScroll();
  }, [open]);

  React.useEffect(() => {
    if (!open || !panel) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const preferred = panel.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? focusables(panel)[0] ?? panel).focus({ preventScroll: true });
  }, [open, panel]);

  React.useEffect(() => {
    if (open) return;
    const restore = restoreRef.current;
    restoreRef.current = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, [open]);

  React.useEffect(() => {
    if (!open || !panel || !dismissible) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as Node | null;
      if (target && target !== document.body && !panel.contains(target)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [close, dismissible, open, panel]);

  const context = React.useMemo<DrawerContextValue>(
    () => ({ titleId, descriptionId, dismissible, close, setHasDescription }),
    [close, descriptionId, dismissible, titleId],
  );

  if (!present) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.key !== "Tab" || event.defaultPrevented || !panel) return;
    const list = focusables(panel);
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const right = side === "right";

  return (
    <Portal>
      <div className="fixed inset-0 z-50">
        <div
          aria-hidden
          onPointerDown={() => {
            if (dismissible) close();
          }}
          className={cn(
            "absolute inset-0 bg-[var(--kn-overlay)]",
            "transition-opacity duration-[var(--kn-dur)] ease-[var(--kn-ease)]",
            entered ? "opacity-100" : "opacity-0",
          )}
        />
        <div
          {...props}
          ref={setPanelRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={label ? undefined : titleId}
          aria-describedby={hasDescription ? descriptionId : undefined}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className={cn(
            "absolute flex w-full flex-col overflow-hidden bg-[var(--kn-surface)] outline-none",
            "text-base text-[var(--kn-text)] shadow-[var(--kn-shadow-lg)]",
            "transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)]",
            right
              ? cn(
                  "inset-y-0 right-0 h-full border-l border-[var(--kn-border)]",
                  variant(RIGHT_SIZES, size, "md"),
                  entered ? "translate-x-0" : "translate-x-full",
                )
              : cn(
                  "inset-x-0 bottom-0 max-h-[85vh] border-t border-[var(--kn-border)]",
                  "rounded-t-[var(--kn-r-lg)]",
                  entered ? "translate-y-0" : "translate-y-full",
                ),
            className,
          )}
        >
          <DrawerContext.Provider value={context}>{children}</DrawerContext.Provider>
        </div>
      </div>
    </Portal>
  );
});

/* ----------------------------- DrawerHeader ---------------------------- */

export interface DrawerHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Status pills, refresh controls — anything that belongs beside the title. */
  actions?: React.ReactNode;
}

export const DrawerHeader = React.forwardRef<HTMLDivElement, DrawerHeaderProps>(
  function DrawerHeader({ className, title, description, actions, ...props }, ref) {
    const { titleId, descriptionId, dismissible, close, setHasDescription } =
      useDrawerContext("DrawerHeader");

    React.useEffect(() => {
      setHasDescription(description !== undefined && description !== null);
      return () => setHasDescription(false);
    }, [description, setHasDescription]);

    return (
      <div
        ref={ref}
        className={cn(
          "flex items-start gap-3 border-b border-[var(--kn-border)] px-4 py-3",
          className,
        )}
        {...props}
      >
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-md font-medium text-[var(--kn-text)]">
            {title}
          </h2>
          {description !== undefined && description !== null && (
            <p id={descriptionId} className="mt-1 text-sm text-[var(--kn-text-2)]">
              {description}
            </p>
          )}
        </div>
        {actions}
        {dismissible && <IconButton icon={X} label="Close" size="sm" onClick={close} />}
      </div>
    );
  },
);

/* ------------------------ DrawerBody / DrawerFooter -------------------- */

export type DrawerBodyProps = React.HTMLAttributes<HTMLDivElement>;

export const DrawerBody = React.forwardRef<HTMLDivElement, DrawerBodyProps>(function DrawerBody(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-3", className)}
      {...props}
    />
  );
});

export type DrawerFooterProps = React.HTMLAttributes<HTMLDivElement>;

export const DrawerFooter = React.forwardRef<HTMLDivElement, DrawerFooterProps>(
  function DrawerFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center justify-end gap-2 border-t border-[var(--kn-border)] px-4 py-3",
          className,
        )}
        {...props}
      />
    );
  },
);
