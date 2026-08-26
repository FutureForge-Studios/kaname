"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Portal } from "./Portal.js";
import { Button, IconButton } from "./Button.js";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Dialog — modal, focus-trapped, scroll-locked.
 *
 * Escape is handled from the panel's own subtree only, so a menu or
 * popover opened from inside a dialog closes first and the dialog
 * survives the keypress that dismissed it.
 * ------------------------------------------------------------------ */

export type DialogSize = "sm" | "md" | "lg";

const SIZES: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
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

/** Body scroll lock, ref-counted so nested layers restore in order. */
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

interface DialogContextValue {
  titleId: string;
  descriptionId: string;
  dismissible: boolean;
  close: () => void;
  setHasDescription: (has: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext(part: string): DialogContextValue {
  const context = React.useContext(DialogContext);
  if (!context) throw new Error(`${part} must be rendered inside <Dialog>`);
  return context;
}

export interface DialogProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "title"
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  size?: DialogSize;
  /** False pins the dialog open: no Escape, no overlay click, no close button. */
  dismissible?: boolean;
  /** Accessible name when the dialog has no DialogHeader. */
  label?: string;
}

export const Dialog = React.forwardRef<HTMLDivElement, DialogProps>(function Dialog(
  {
    open,
    onOpenChange,
    children,
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
      // A portaled layer above us owns its own Escape.
      if (target && target !== document.body && !panel.contains(target)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [close, dismissible, open, panel]);

  const context = React.useMemo<DialogContextValue>(
    () => ({ titleId, descriptionId, dismissible, close, setHasDescription }),
    [close, descriptionId, dismissible, titleId],
  );

  if (!open) return null;

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

  return (
    <Portal>
      <div
        className={cn(
          "fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4",
          "bg-[var(--kn-overlay)] animate-[var(--animate-fade-in)]",
        )}
        onPointerDown={(event) => {
          if (dismissible && event.target === event.currentTarget) close();
        }}
      >
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
            "flex max-h-full w-full flex-col overflow-hidden outline-none",
            "rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)]",
            "text-base text-[var(--kn-text)] shadow-[var(--kn-shadow-lg)]",
            "animate-[var(--animate-scale-in)]",
            variant(SIZES, size, "md"),
            className,
          )}
        >
          <DialogContext.Provider value={context}>{children}</DialogContext.Provider>
        </div>
      </div>
    </Portal>
  );
});

/* ----------------------------- DialogHeader ---------------------------- */

export interface DialogHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Extra controls rendered between the title block and the close button. */
  actions?: React.ReactNode;
}

export const DialogHeader = React.forwardRef<HTMLDivElement, DialogHeaderProps>(
  function DialogHeader({ className, title, description, actions, ...props }, ref) {
    const { titleId, descriptionId, dismissible, close, setHasDescription } =
      useDialogContext("DialogHeader");

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
          <h2 id={titleId} className="text-md font-medium text-[var(--kn-text)]">
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

/* ------------------------ DialogBody / DialogFooter --------------------- */

export type DialogBodyProps = React.HTMLAttributes<HTMLDivElement>;

export const DialogBody = React.forwardRef<HTMLDivElement, DialogBodyProps>(function DialogBody(
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

export type DialogFooterProps = React.HTMLAttributes<HTMLDivElement>;

export const DialogFooter = React.forwardRef<HTMLDivElement, DialogFooterProps>(
  function DialogFooter({ className, ...props }, ref) {
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

/* ----------------------------- ConfirmDialog --------------------------- */

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /**
   * When set, the operator must type this exact string before the
   * action enables — the server name, the domain, the mailbox address.
   */
  confirmText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Default for anything that destroys state. */
  destructive?: boolean;
  /** Keeps the dialog open and pinned while the job is being created. */
  loading?: boolean;
  /** The dialog does not close itself: the caller owns the outcome. */
  onConfirm: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  loading = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState("");
  const inputId = React.useId();

  React.useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const armed = confirmText === undefined || typed.trim() === confirmText;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      dismissible={!loading}
      aria-busy={loading || undefined}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (armed && !loading) onConfirm();
        }}
      >
        <DialogHeader title={title} description={description} />
        {(confirmText !== undefined || children) && (
          <DialogBody>
            {children}
            {confirmText !== undefined && (
              <div className={cn("flex flex-col gap-2", children ? "mt-4" : undefined)}>
                <label htmlFor={inputId} className="text-sm text-[var(--kn-text-2)]">
                  Type <span className="font-mono text-[var(--kn-text)]">{confirmText}</span> to
                  confirm
                </label>
                <input
                  id={inputId}
                  data-autofocus=""
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={loading}
                  className={cn(
                    "h-8 w-full rounded-[var(--kn-r-md)] border border-[var(--kn-border)] px-2",
                    "bg-[var(--kn-bg-inset)] font-mono text-base text-[var(--kn-text)]",
                    "transition-[border-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                    "focus-visible:border-[var(--kn-accent-500)] disabled:opacity-50",
                  )}
                />
              </div>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant={destructive ? "danger" : "primary"}
            disabled={!armed}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
