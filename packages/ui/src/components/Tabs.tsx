"use client";

import * as React from "react";
import { cn } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Tabs — roving tabindex, one tab stop for the whole set.
 *
 * Selection lives on the value, not on an index, so a tab set can be
 * driven straight from the URL (?tab=logs) without a lookup table.
 * ------------------------------------------------------------------ */

export type TabsOrientation = "horizontal" | "vertical";
export type TabsActivation = "automatic" | "manual";

type IconComponent = React.ComponentType<{ size?: number | string; className?: string }>;

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  orientation: TabsOrientation;
  activation: TabsActivation;
  baseId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(part: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error(`${part} must be rendered inside <Tabs>`);
  return context;
}

const tabId = (base: string, value: string) => `${base}-tab-${value}`;
const panelId = (base: string, value: string) => `${base}-panel-${value}`;

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: TabsOrientation;
  /** `manual` requires Enter or Space after arrowing — use it for expensive panels. */
  activationMode?: TabsActivation;
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    className,
    value: valueProp,
    defaultValue = "",
    onValueChange,
    orientation = "horizontal",
    activationMode = "automatic",
    children,
    ...props
  },
  ref,
) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const value = valueProp ?? uncontrolled;
  const baseId = React.useId();

  const select = React.useCallback(
    (next: string) => {
      if (valueProp === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [onValueChange, valueProp],
  );

  const context = React.useMemo<TabsContextValue>(
    () => ({ value, select, orientation, activation: activationMode, baseId }),
    [activationMode, baseId, orientation, select, value],
  );

  return (
    <div
      ref={ref}
      data-orientation={orientation}
      className={cn(
        "flex min-w-0",
        orientation === "horizontal" ? "flex-col" : "flex-row",
        className,
      )}
      {...props}
    >
      <TabsContext.Provider value={context}>{children}</TabsContext.Provider>
    </div>
  );
});

/* ------------------------------- TabList ------------------------------- */

export type TabListProps = React.HTMLAttributes<HTMLDivElement>;

export const TabList = React.forwardRef<HTMLDivElement, TabListProps>(function TabList(
  { className, onKeyDown, ...props },
  ref,
) {
  const { orientation, activation, select } = useTabsContext("TabList");
  const horizontal = orientation === "horizontal";

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    const next = horizontal ? "ArrowRight" : "ArrowDown";
    const previous = horizontal ? "ArrowLeft" : "ArrowUp";
    if (!["Home", "End", next, previous].includes(event.key)) return;

    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([data-disabled])'),
    );
    if (tabs.length === 0) return;

    const current = tabs.findIndex((tab) => tab === document.activeElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : event.key === next
            ? (current + 1 + tabs.length) % tabs.length
            : (current - 1 + tabs.length) % tabs.length;

    const target = tabs[index];
    if (!target) return;
    event.preventDefault();
    target.focus();
    if (activation === "automatic") {
      const value = target.dataset["value"];
      if (value !== undefined) select(value);
    }
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-orientation={orientation}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex min-w-0",
        horizontal
          ? "items-center gap-1 border-b border-[var(--kn-border)]"
          : "flex-col items-stretch gap-1 border-r border-[var(--kn-border)]",
        className,
      )}
      {...props}
    />
  );
});

/* --------------------------------- Tab --------------------------------- */

export interface TabProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  icon?: IconComponent;
  /** Right-aligned count — open jobs, failing checks. */
  badge?: React.ReactNode;
}

export const Tab = React.forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { className, value, icon: Icon, badge, disabled = false, onClick, children, ...props },
  ref,
) {
  const { value: selectedValue, select, orientation, baseId } = useTabsContext("Tab");
  const selected = selectedValue === value;
  const horizontal = orientation === "horizontal";

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={tabId(baseId, value)}
      data-value={value}
      data-disabled={disabled || undefined}
      aria-selected={selected}
      aria-controls={panelId(baseId, value)}
      aria-disabled={disabled || undefined}
      tabIndex={selected ? 0 : -1}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        select(value);
      }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-base font-medium",
        "outline-none transition-[color,border-color] duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
        "text-[var(--kn-text-2)] hover:text-[var(--kn-text)]",
        "aria-selected:text-[var(--kn-text)]",
        horizontal
          ? "-mb-px border-b-2 border-transparent aria-selected:border-[var(--kn-accent-500)]"
          : "-mr-px justify-start border-r-2 border-transparent aria-selected:border-[var(--kn-accent-500)]",
        disabled && "cursor-not-allowed text-[var(--kn-text-3)] hover:text-[var(--kn-text-3)]",
        className,
      )}
      {...props}
    >
      {Icon && <Icon size={14} className="shrink-0" aria-hidden />}
      {children}
      {badge !== undefined && badge !== null && (
        <span className="text-xs text-[var(--kn-text-3)]">{badge}</span>
      )}
    </button>
  );
});

/* ------------------------------- TabPanel ------------------------------ */

export interface TabPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  /** Keeps the panel in the DOM while hidden, preserving its state. */
  keepMounted?: boolean;
}

export const TabPanel = React.forwardRef<HTMLDivElement, TabPanelProps>(function TabPanel(
  { className, value, keepMounted = false, children, ...props },
  ref,
) {
  const { value: selectedValue, baseId } = useTabsContext("TabPanel");
  const selected = selectedValue === value;

  if (!selected && !keepMounted) return null;

  return (
    <div
      ref={ref}
      role="tabpanel"
      id={panelId(baseId, value)}
      aria-labelledby={tabId(baseId, value)}
      hidden={!selected}
      // Focusable so keyboard users reach panel content that has no
      // controls of its own (log output, property lists).
      tabIndex={0}
      className={cn("min-w-0 flex-1 outline-none", className)}
      {...props}
    >
      {children}
    </div>
  );
});
