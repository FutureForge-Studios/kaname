"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { NAV_LEAVES } from "@kaname/contract";
import { Dialog, DialogBody, DialogHeader, Kbd, cn } from "@kaname/ui";
import { useCan, useJobDrawer } from "@/lib/queries";
import { useCommandPalette } from "./CommandPalette";
import { LIST_SEARCH_ATTR } from "./ResourcePage";

/* ------------------------------------------------------------------ *
 * Global key handling and the "?" sheet.
 *
 * One listener for the whole product, because two would fight over the
 * same key. Everything here is discoverable: the sheet is the contract,
 * and any binding not listed in it does not exist.
 *
 * Typing is sacred — a chord only fires when focus is not inside a
 * field, with the single exception of the palette, which has to open
 * from anywhere including a half-filled form.
 * ------------------------------------------------------------------ */

/** How long a "g" stays armed before it is just a letter again. */
const CHORD_MS = 1200;

const SHORTCUTS_EVENT = "kaname:shortcuts";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const can = useCan();
  const palette = useCommandPalette();
  const drawer = useJobDrawer();
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const jumps = React.useMemo(() => {
    const map = new Map<string, { href: string; label: string; section: string }>();
    map.set("h", { href: "/", label: "Command Center", section: "Overview" });
    for (const leaf of NAV_LEAVES) {
      if (!leaf.shortcut || !can(leaf.permission)) continue;
      if (map.has(leaf.shortcut)) continue;
      map.set(leaf.shortcut, { href: leaf.href, label: leaf.label, section: leaf.section });
    }
    return map;
  }, [can]);

  const jumpsRef = React.useRef(jumps);
  jumpsRef.current = jumps;

  React.useEffect(() => {
    const openSheet = () => setSheetOpen(true);
    window.addEventListener(SHORTCUTS_EVENT, openSheet);
    return () => window.removeEventListener(SHORTCUTS_EVENT, openSheet);
  }, []);

  React.useEffect(() => {
    let armed = false;
    let timer = 0;

    const disarm = () => {
      armed = false;
      window.clearTimeout(timer);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        palette.toggle();
        return;
      }

      if (mod || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      if (armed) {
        const destination = jumpsRef.current.get(event.key.toLowerCase());
        disarm();
        if (destination) {
          event.preventDefault();
          router.push(destination.href);
        }
        return;
      }

      switch (event.key) {
        case "g":
          armed = true;
          timer = window.setTimeout(disarm, CHORD_MS);
          break;
        case "?":
          event.preventDefault();
          setSheetOpen(true);
          break;
        case "/": {
          const search = document.querySelector<HTMLInputElement>(`[${LIST_SEARCH_ATTR}]`);
          if (!search) return;
          event.preventDefault();
          search.focus();
          search.select();
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      disarm();
    };
  }, [palette, router]);

  return (
    <ShortcutSheet
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      jumps={[...jumps.entries()]}
      onOpenJobs={() => {
        setSheetOpen(false);
        drawer.setOpen(true);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */

interface Binding {
  keys: string;
  description: string;
}

const GLOBAL_BINDINGS: readonly Binding[] = [
  { keys: "mod+k", description: "Open the command palette" },
  { keys: "/", description: "Focus the list search" },
  { keys: "shift+/", description: "Show this sheet" },
  { keys: "esc", description: "Close the palette, a dialog or a drawer" },
];

const LIST_BINDINGS: readonly Binding[] = [
  { keys: "j", description: "Move to the next row" },
  { keys: "k", description: "Move to the previous row" },
  { keys: "enter", description: "Open the focused row" },
  { keys: "x", description: "Select the focused row" },
  { keys: "shift+x", description: "Extend the selection to the focused row" },
  { keys: "esc", description: "Clear the selection" },
];

interface ShortcutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jumps: [string, { href: string; label: string; section: string }][];
  onOpenJobs: () => void;
}

function ShortcutSheet({ open, onOpenChange, jumps, onOpenJobs }: ShortcutSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogHeader
        title="Keyboard shortcuts"
        description="Kaname is built to be driven without a mouse. Chords are typed in sequence, not held."
      />
      <DialogBody>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <ShortcutGroup title="Global" bindings={GLOBAL_BINDINGS} />
          <ShortcutGroup title="Lists and tables" bindings={LIST_BINDINGS} />

          <section className="min-w-0">
            <h3 className="mb-2 text-2xs font-medium uppercase tracking-wider text-[var(--kn-text-3)]">
              Go to
            </h3>
            <ul className="flex flex-col">
              {jumps.map(([key, destination]) => (
                <li
                  key={key}
                  className="flex h-7 items-center justify-between gap-3 border-b border-[var(--kn-border-subtle)] last:border-b-0"
                >
                  <span className="min-w-0 truncate text-[var(--kn-text-2)]">
                    {destination.section === destination.label
                      ? destination.label
                      : `${destination.section} · ${destination.label}`}
                  </span>
                  <Kbd keys={`g then ${key}`} size="xs" />
                </li>
              ))}
            </ul>
          </section>

          <section className="min-w-0">
            <h3 className="mb-2 text-2xs font-medium uppercase tracking-wider text-[var(--kn-text-3)]">
              Jobs
            </h3>
            <p className="text-[var(--kn-text-2)]">
              Anything that touches a host runs as a job. The drawer keeps every one this session
              started, with its log, whatever page you move to.
            </p>
            <button
              type="button"
              onClick={onOpenJobs}
              className={cn(
                "mt-2 rounded-[var(--kn-r-sm)] text-[var(--kn-accent-400)] outline-none",
                "transition-opacity duration-[var(--kn-dur-fast)] hover:underline",
              )}
            >
              Open job activity
            </button>
          </section>
        </div>
      </DialogBody>
    </Dialog>
  );
}

function ShortcutGroup({ title, bindings }: { title: string; bindings: readonly Binding[] }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-2xs font-medium uppercase tracking-wider text-[var(--kn-text-3)]">
        {title}
      </h3>
      <ul className="flex flex-col">
        {bindings.map((binding) => (
          <li
            key={`${title}-${binding.keys}`}
            className="flex h-7 items-center justify-between gap-3 border-b border-[var(--kn-border-subtle)] last:border-b-0"
          >
            <span className="min-w-0 truncate text-[var(--kn-text-2)]">{binding.description}</span>
            <Kbd keys={binding.keys} size="xs" />
          </li>
        ))}
      </ul>
    </section>
  );
}
