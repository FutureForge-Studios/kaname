"use client";

import * as React from "react";
import { cn, variant } from "../lib/cn.js";

/* ------------------------------------------------------------------ *
 * Kbd — renders "mod+k" or "g then s" as key chips.
 *
 * `mod` is the point of this component: it resolves to the Command
 * glyph on Apple hardware and to Ctrl everywhere else, so a shortcut
 * is written once and displayed correctly. The glyphs are decorative,
 * so the accessible name is a spelled-out sibling.
 * ------------------------------------------------------------------ */

export type KbdSize = "xs" | "sm";

const APPLE_MODIFIERS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  cmd: "⌘",
  command: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  opt: "⌥",
  option: "⌥",
  shift: "⇧",
};

const PC_MODIFIERS: Record<string, string> = {
  mod: "Ctrl",
  meta: "Win",
  cmd: "Ctrl",
  command: "Ctrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  opt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const NAMED_KEYS: Record<string, string> = {
  enter: "↵",
  return: "↵",
  esc: "Esc",
  escape: "Esc",
  tab: "⇥",
  backspace: "⌫",
  del: "⌦",
  delete: "⌦",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  plus: "+",
};

const SPOKEN_KEYS: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  opt: "Option",
  option: "Option",
  shift: "Shift",
  enter: "Enter",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  del: "Delete",
  delete: "Delete",
  space: "Space",
  up: "Up arrow",
  down: "Down arrow",
  left: "Left arrow",
  right: "Right arrow",
  arrowup: "Up arrow",
  arrowdown: "Down arrow",
  arrowleft: "Left arrow",
  arrowright: "Right arrow",
  pageup: "Page up",
  pagedown: "Page down",
  home: "Home",
  end: "End",
  plus: "Plus",
};

const KBD_SIZES: Record<KbdSize, string> = {
  xs: "h-4 min-w-4 px-1 text-2xs",
  sm: "h-5 min-w-5 px-1.5 text-xs",
};

function displayKey(token: string, apple: boolean): string {
  const key = token.toLowerCase();
  const modifier = apple ? APPLE_MODIFIERS[key] : PC_MODIFIERS[key];
  if (modifier) return modifier;
  return NAMED_KEYS[key] ?? (token.length === 1 ? token.toUpperCase() : token);
}

/** "shift+/" -> ["shift", "/"]; a bare "+" survives the split. */
function tokensOf(segment: string): string[] {
  const parts = segment.split("+").filter(Boolean);
  return parts.length > 0 ? parts : ["+"];
}

function spokenKey(token: string, apple: boolean): string {
  const key = token.toLowerCase();
  if (key === "mod") return apple ? "Command" : "Control";
  if (key === "meta" || key === "cmd" || key === "command") return apple ? "Command" : "Windows";
  return SPOKEN_KEYS[key] ?? (token.length === 1 ? token.toUpperCase() : token);
}

const subscribeToNothing = () => () => {};
const getIsAppleClient = () => /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
const getIsAppleServer = () => false;

/** Platform is unknowable on the server, so it settles on the first client read. */
function useApplePlatform(): boolean {
  return React.useSyncExternalStore(subscribeToNothing, getIsAppleClient, getIsAppleServer);
}

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** `"mod+k"`, `"shift+/"`, `"g then s"`. Tokens: mod, meta, ctrl, alt, shift, plus, named keys. */
  keys?: string;
  size?: KbdSize;
}

export const Kbd = React.forwardRef<HTMLElement, KbdProps>(function Kbd(
  { keys, size = "sm", className, children, ...props },
  ref,
) {
  const apple = useApplePlatform();

  const chipClass = cn(
    "inline-flex items-center justify-center border border-[var(--kn-border)]",
    "rounded-[var(--kn-r-xs)] bg-[var(--kn-surface-2)] font-medium text-[var(--kn-text-2)]",
    variant(KBD_SIZES, size, "sm"),
  );

  /* A string child is the same thing as `keys`, which is what call sites
   * like MenuShortcut pass; any other node is rendered as a single chip. */
  const source = keys ?? (typeof children === "string" ? children : undefined);

  if (source === undefined) {
    return (
      <kbd ref={ref} className={cn(chipClass, className)} {...props}>
        {children}
      </kbd>
    );
  }

  const segments = source.trim().split(/\s+/).filter(Boolean);

  const spoken = segments
    .map((segment) =>
      segment.toLowerCase() === "then"
        ? "then"
        : tokensOf(segment)
            .map((token) => spokenKey(token, apple))
            .join(" "),
    )
    .join(" ");

  return (
    <kbd ref={ref} className={cn("inline-flex items-center gap-1", className)} {...props}>
      <span className="sr-only">{spoken}</span>
      {segments.map((segment, segmentIndex) => {
        if (segment.toLowerCase() === "then") {
          return (
            <span
              key={`then-${segmentIndex}`}
              aria-hidden
              className="text-2xs text-[var(--kn-text-3)]"
            >
              then
            </span>
          );
        }
        return tokensOf(segment).map((token, tokenIndex) => (
          <kbd key={`${segmentIndex}-${tokenIndex}-${token}`} aria-hidden className={chipClass}>
            {displayKey(token, apple)}
          </kbd>
        ));
      })}
    </kbd>
  );
});
