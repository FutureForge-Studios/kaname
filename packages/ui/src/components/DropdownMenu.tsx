"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Portal } from "./Portal.js";
import { Kbd } from "./Kbd.js";
import { useFloating, type Placement } from "../hooks/useFloating.js";
import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * DropdownMenu — row actions, bulk actions, the topbar account menu.
 *
 * Focus is the selection model: items are real buttons with
 * `tabIndex={-1}` that get focused as you arrow through them, so Enter,
 * Space and screen-reader semantics come from the platform instead of
 * from an `aria-activedescendant` shadow state.
 *
 * Every panel is portaled, which is also why a panel can query its own
 * items with a flat selector: a submenu's items live in a different
 * subtree, never inside its parent panel.
 * ------------------------------------------------------------------ */

type TriggerProps = React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> };
type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

const ITEM_SELECTOR = "[data-kn-menuitem]";
const TYPEAHEAD_WINDOW = 500;
const SUBMENU_OPEN_DELAY = 100;
const SUBMENU_CLOSE_DELAY = 150;

const PANEL_CLASS = [
  "z-50 min-w-48 overflow-y-auto p-1 text-base text-[var(--kn-text)] outline-none",
  "rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)]",
  "shadow-[var(--kn-shadow-md)] animate-[var(--animate-scale-in)]",
].join(" ");

interface Typeahead {
  query: string;
  at: number;
}

interface MenuContextValue {
  /** Closes the whole tree, back to the root trigger. */
  closeAll: () => void;
}

const MenuContext = React.createContext<MenuContextValue | null>(null);

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.RefObject<T | null>).current = value;
}

function itemsOf(panel: HTMLElement | null): HTMLElement[] {
  return panel ? Array.from(panel.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : [];
}

function indexOfActive(list: HTMLElement[]): number {
  return list.findIndex((el) => el === document.activeElement);
}

function focusAt(list: HTMLElement[], index: number): void {
  if (list.length === 0) return;
  const wrapped = ((index % list.length) + list.length) % list.length;
  list[wrapped]?.focus({ preventScroll: true });
}

function typeaheadMatch(
  list: HTMLElement[],
  state: Typeahead,
  key: string,
): HTMLElement | undefined {
  const now = Date.now();
  state.query = now - state.at > TYPEAHEAD_WINDOW ? key : state.query + key;
  state.at = now;

  const query = state.query.toLowerCase();
  const from = Math.max(indexOfActive(list), 0);
  // A single repeated letter cycles; a longer string re-matches in place.
  const ordered =
    state.query.length === 1 ? [...list.slice(from + 1), ...list.slice(0, from + 1)] : list;
  return ordered.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(query));
}

function handleMenuKeys(
  event: React.KeyboardEvent<HTMLElement>,
  panel: HTMLElement | null,
  typeahead: Typeahead,
  actions: { close: () => void; closeAll: () => void; back?: (() => void) | undefined },
): void {
  if (event.defaultPrevented) return;
  const list = itemsOf(panel);
  const active = indexOfActive(list);
  // Stopping propagation keeps a submenu's keys out of its parent panel:
  // portaled children still bubble through the React tree.
  const consume = () => {
    event.preventDefault();
    event.stopPropagation();
  };

  switch (event.key) {
    case "ArrowDown":
      consume();
      focusAt(list, active + 1);
      return;
    case "ArrowUp":
      consume();
      focusAt(list, active < 0 ? list.length - 1 : active - 1);
      return;
    case "Home":
      consume();
      focusAt(list, 0);
      return;
    case "End":
      consume();
      focusAt(list, list.length - 1);
      return;
    case "Escape":
      consume();
      actions.close();
      return;
    case "ArrowLeft":
      if (actions.back) {
        consume();
        actions.back();
      }
      return;
    case "Tab":
      actions.closeAll();
      return;
    default:
      break;
  }

  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    // Held even on a miss, so a stray letter in a submenu never moves
    // focus in the panel behind it.
    event.stopPropagation();
    const match = typeaheadMatch(list, typeahead, event.key);
    if (match) {
      event.preventDefault();
      match.focus({ preventScroll: true });
    }
  }
}

/* ---------------------------- DropdownMenu ---------------------------- */

export interface DropdownMenuProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "title"
> {
  /** Opens and anchors the menu. Cloned, not wrapped. */
  trigger: React.ReactElement;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  offset?: number;
  /** Accessible name for the menu. */
  label?: string;
}

export const DropdownMenu = React.forwardRef<HTMLDivElement, DropdownMenuProps>(
  function DropdownMenu(
    {
      trigger,
      children,
      open: openProp,
      defaultOpen = false,
      onOpenChange,
      placement = "bottom-start",
      offset = 4,
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
    const entryRef = React.useRef<"first" | "last">("first");
    const typeahead = React.useRef<Typeahead>({ query: "", at: 0 });
    const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
    const open = openProp ?? uncontrolled;
    const menuId = React.useId();

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

    const openWith = React.useCallback(
      (entry: "first" | "last") => {
        entryRef.current = entry;
        setOpen(true);
      },
      [setOpen],
    );

    React.useEffect(() => {
      if (!open || !floating) return;
      restoreRef.current = anchorRef.current;
      const list = itemsOf(floating);
      const target = entryRef.current === "last" ? list[list.length - 1] : list[0];
      (target ?? floating).focus({ preventScroll: true });
      entryRef.current = "first";
    }, [floating, open]);

    React.useEffect(() => {
      if (open) return;
      const restore = restoreRef.current;
      restoreRef.current = null;
      if (!restore || !restore.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      restore.focus({ preventScroll: true });
    }, [open]);

    React.useEffect(() => {
      if (!open) return;
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (anchorRef.current?.contains(target)) return;
        // Submenu panels live outside this panel, hence the attribute probe.
        if (target instanceof Element && target.closest("[data-kn-menu]")) return;
        setOpen(false);
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [open, setOpen]);

    const closeAll = React.useCallback(() => setOpen(false), [setOpen]);
    const context = React.useMemo<MenuContextValue>(() => ({ closeAll }), [closeAll]);

    const anchored = React.cloneElement(triggerEl, {
      ref: setAnchor,
      "aria-haspopup": "menu",
      "aria-expanded": open,
      "aria-controls": open ? menuId : undefined,
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        triggerEl.props.onClick?.(event);
        if (!event.defaultPrevented) setOpen(!open);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        triggerEl.props.onKeyDown?.(event);
        if (event.defaultPrevented || open) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          openWith("first");
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          openWith("last");
        }
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
              id={menuId}
              role="menu"
              aria-label={label}
              data-kn-menu=""
              tabIndex={-1}
              style={{ ...style, ...styleProp }}
              onKeyDown={(event) => {
                onKeyDown?.(event);
                handleMenuKeys(event, floating, typeahead.current, {
                  close: closeAll,
                  closeAll,
                });
              }}
              className={cn(PANEL_CLASS, className)}
            >
              <MenuContext.Provider value={context}>{children}</MenuContext.Provider>
            </div>
          </Portal>
        )}
      </>
    );
  },
);

/* ------------------------------- MenuItem ------------------------------ */

export interface MenuItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onSelect"
> {
  icon?: IconComponent;
  /** Red treatment for destroy/revoke/ban. Never the default action. */
  destructive?: boolean;
  /** Fires on click, Enter and Space. */
  onSelect?: () => void;
  /** Default true; false for items that toggle something in place. */
  closeOnSelect?: boolean;
}

export const MenuItem = React.forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  {
    className,
    icon: Icon,
    destructive = false,
    onSelect,
    closeOnSelect = true,
    disabled = false,
    onClick,
    onPointerEnter,
    children,
    ...props
  },
  ref,
) {
  const menu = React.useContext(MenuContext);

  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      data-kn-menuitem=""
      tabIndex={-1}
      // Not the native attribute: a disabled item stays in the arrow
      // order so its existence is discoverable.
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        onSelect?.();
        if (closeOnSelect) menu?.closeAll();
      }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (!disabled) event.currentTarget.focus({ preventScroll: true });
      }}
      className={cn(
        "flex h-7 w-full items-center gap-2 overflow-hidden whitespace-nowrap px-2 text-left text-base",
        "rounded-[var(--kn-r-sm)] outline-none",
        "transition-[background-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        destructive
          ? "text-[var(--kn-danger)] hover:bg-[var(--kn-danger-soft)] focus:bg-[var(--kn-danger-soft)]"
          : "text-[var(--kn-text)] hover:bg-[var(--kn-surface-3)] focus:bg-[var(--kn-surface-3)]",
        disabled && "cursor-not-allowed text-[var(--kn-text-3)] hover:bg-transparent",
        className,
      )}
      {...props}
    >
      {Icon && (
        <Icon
          size={14}
          className={cn("shrink-0", !destructive && "text-[var(--kn-text-2)]")}
          aria-hidden
        />
      )}
      {children}
    </button>
  );
});

/* ------------------------------- SubMenu ------------------------------- */

export interface SubMenuProps {
  /** Plain text keeps type-ahead working on the parent panel. */
  label: React.ReactNode;
  icon?: IconComponent;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function SubMenu({
  label,
  icon: Icon,
  disabled = false,
  children,
  className,
}: SubMenuProps) {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const typeahead = React.useRef<Typeahead>({ query: "", at: 0 });
  const [open, setOpen] = React.useState(false);
  const menu = React.useContext(MenuContext);
  const submenuId = React.useId();

  const { setFloating, floating, style } = useFloating<HTMLDivElement>(triggerRef, {
    placement: "right-start",
    offset: 0,
    open,
  });

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = React.useCallback(
    (next: boolean, delay: number) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setOpen(next);
      }, delay);
    },
    [clearTimer],
  );

  React.useEffect(() => clearTimer, [clearTimer]);

  const close = React.useCallback(
    (returnFocus: boolean) => {
      clearTimer();
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [clearTimer],
  );

  React.useEffect(() => {
    if (!open || !floating) return;
    const first = itemsOf(floating)[0];
    (first ?? floating).focus({ preventScroll: true });
  }, [floating, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        data-kn-menuitem=""
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? submenuId : undefined}
        aria-disabled={disabled || undefined}
        onPointerEnter={() => {
          if (!disabled) schedule(true, SUBMENU_OPEN_DELAY);
        }}
        onPointerLeave={() => schedule(false, SUBMENU_CLOSE_DELAY)}
        onClick={(event) => {
          event.preventDefault();
          if (!disabled) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            clearTimer();
            setOpen(true);
          }
        }}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-[var(--kn-r-sm)] px-2 text-left text-base",
          "outline-none transition-[background-color,color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          "text-[var(--kn-text)] hover:bg-[var(--kn-surface-3)] focus:bg-[var(--kn-surface-3)]",
          open && "bg-[var(--kn-surface-3)]",
          disabled && "cursor-not-allowed text-[var(--kn-text-3)] hover:bg-transparent",
          className,
        )}
      >
        {Icon && <Icon size={14} className="shrink-0 text-[var(--kn-text-2)]" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
      </button>

      {open && (
        <Portal>
          <div
            ref={setFloating}
            id={submenuId}
            role="menu"
            data-kn-menu=""
            tabIndex={-1}
            style={style}
            onPointerEnter={clearTimer}
            onPointerLeave={() => schedule(false, SUBMENU_CLOSE_DELAY)}
            onKeyDown={(event) =>
              handleMenuKeys(event, floating, typeahead.current, {
                close: () => close(true),
                closeAll: () => menu?.closeAll(),
                back: () => close(true),
              })
            }
            className={PANEL_CLASS}
          >
            {children}
          </div>
        </Portal>
      )}
    </>
  );
}

/* ------------------- MenuLabel / MenuGroup / MenuSeparator ------------------- */

export type MenuLabelProps = React.HTMLAttributes<HTMLDivElement>;

export const MenuLabel = React.forwardRef<HTMLDivElement, MenuLabelProps>(function MenuLabel(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "px-2 py-1 text-2xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]",
        className,
      )}
      {...props}
    />
  );
});

export interface MenuGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Rendered as a MenuLabel and wired up with `aria-labelledby`. */
  label?: React.ReactNode;
}

export const MenuGroup = React.forwardRef<HTMLDivElement, MenuGroupProps>(function MenuGroup(
  { className, label, children, ...props },
  ref,
) {
  const labelId = React.useId();

  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={label === undefined ? undefined : labelId}
      className={cn(className)}
      {...props}
    >
      {label !== undefined && <MenuLabel id={labelId}>{label}</MenuLabel>}
      {children}
    </div>
  );
});

export type MenuSeparatorProps = React.HTMLAttributes<HTMLDivElement>;

export const MenuSeparator = React.forwardRef<HTMLDivElement, MenuSeparatorProps>(
  function MenuSeparator({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        role="separator"
        aria-orientation="horizontal"
        className={cn("-mx-1 my-1 h-px bg-[var(--kn-border)]", className)}
        {...props}
      />
    );
  },
);

/* ----------------------------- MenuShortcut ---------------------------- */

export interface MenuShortcutProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Kbd syntax: `"mod+r"`, `"shift+/"`, `"g then s"`. */
  keys: string;
}

export function MenuShortcut({ keys, className, ...props }: MenuShortcutProps) {
  return (
    <span className={cn("ml-auto flex shrink-0 items-center pl-4", className)} {...props}>
      <Kbd keys={keys} size="xs" />
    </span>
  );
}
