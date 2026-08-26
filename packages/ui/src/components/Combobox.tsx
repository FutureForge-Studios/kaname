"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { IconButton } from "./Button.js";
import {
  FIELD_ICON_SIZES,
  FIELD_MIN_HEIGHTS,
  fieldBox,
  isAriaInvalid,
  mergeRefs,
  type FieldSize,
} from "./Input.js";

/* ------------------------------------------------------------------ *
 * Combobox — a filterable listbox, built from scratch.
 *
 * Native <select> covers the short static case (see Select.tsx); this
 * covers the long, searchable, sometimes-remote case: picking one of
 * forty systemd units, or four of thirty servers. The popover is
 * portalled to <body> and positioned from the trigger's rect so it
 * escapes the overflow clipping of a table or a drawer.
 *
 * Keyboard contract: Arrow keys move, Home/End jump, Enter selects,
 * Escape closes, Backspace peels the last chip off a multi-select, and
 * printable keys both filter and drive a type-ahead buffer — the
 * latter is what makes an async list (filter={false}) navigable.
 * ------------------------------------------------------------------ */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line in the row — a hostname, a path, a count. */
  description?: string;
  disabled?: boolean;
  icon?: React.ComponentType<{ size?: number | string; className?: string }>;
  /** Renders the label in the mono face: hosts, paths, unit names. */
  mono?: boolean;
}

interface ComboboxBaseProps {
  options: readonly ComboboxOption[];
  size?: FieldSize;
  invalid?: boolean;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  /** Spinner in the field plus an aria-busy listbox while the parent fetches. */
  loading?: boolean;
  loadingMessage?: string;
  clearable?: boolean;
  /** Monospace face for the value and the query. */
  mono?: boolean;
  /** `false` hands filtering to the parent — async or server-side search. */
  filter?: ((option: ComboboxOption, query: string) => boolean) | false;
  onQueryChange?: (query: string) => void;
  /** Submits the current selection with a surrounding form. */
  name?: string;
  id?: string;
  className?: string;
  /** Applied to the popover listbox. */
  listClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
}

export interface SingleComboboxProps extends ComboboxBaseProps {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
}

export interface MultiComboboxProps extends ComboboxBaseProps {
  multiple: true;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[]) => void;
}

export type ComboboxProps = SingleComboboxProps | MultiComboboxProps;

const TYPE_AHEAD_RESET_MS = 600;
const POPOVER_GAP = 4;
const POPOVER_MARGIN = 8;
const POPOVER_MAX_HEIGHT = 280;
const POPOVER_MIN_HEIGHT = 96;

const defaultFilter = (option: ComboboxOption, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    option.label.toLowerCase().includes(needle) ||
    option.value.toLowerCase().includes(needle) ||
    (option.description?.toLowerCase().includes(needle) ?? false)
  );
};

function toArray(value: string | readonly string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value === "" ? [] : [value];
  return [...value];
}

/** Walks the list in `dir`, wrapping once, skipping disabled rows. */
function nextEnabled(list: readonly ComboboxOption[], from: number, dir: 1 | -1): number {
  const count = list.length;
  if (count === 0) return -1;
  let index = from;
  for (let step = 0; step < count; step += 1) {
    index = (index + dir + count) % count;
    if (!list[index]?.disabled) return index;
  }
  return -1;
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export const Combobox = React.forwardRef<HTMLDivElement, ComboboxProps>(
  function Combobox(props, ref) {
    const {
      options,
      size = "sm",
      invalid,
      disabled = false,
      required = false,
      placeholder = "Select…",
      emptyMessage = "No matches",
      loading = false,
      loadingMessage = "Loading…",
      clearable = false,
      mono = false,
      filter = defaultFilter,
      onQueryChange,
      name,
      id,
      className,
      listClassName,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
    } = props;

    const multiple = props.multiple === true;
    const isInvalid = invalid ?? isAriaInvalid(ariaInvalid);
    const controlled = props.value !== undefined;

    const generatedId = React.useId();
    const inputId = id ?? `${generatedId}cb`;
    const listboxId = `${generatedId}list`;

    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const setRootRef = React.useMemo(() => mergeRefs<HTMLDivElement>(ref, rootRef), [ref]);

    const [internal, setInternal] = React.useState<string[]>(() => toArray(props.defaultValue));
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const [activeIndex, setActiveIndex] = React.useState(-1);
    const [popoverStyle, setPopoverStyle] = React.useState<React.CSSProperties>({
      position: "fixed",
      top: 0,
      left: 0,
    });

    const selected = controlled ? toArray(props.value) : internal;

    /* Latest-value refs: the effects below must not re-subscribe whenever a
     * parent re-renders with a fresh callback or a fresh selection array. */
    const selectedRef = React.useRef(selected);
    selectedRef.current = selected;
    const queryChangeRef = React.useRef(onQueryChange);
    queryChangeRef.current = onQueryChange;

    /* Async lists drop options as the query narrows, so remember the labels
     * we have seen; a selected value must keep rendering as its name. */
    const seenLabels = React.useRef(new Map<string, string>());
    React.useEffect(() => {
      for (const option of options) seenLabels.current.set(option.value, option.label);
    }, [options]);

    const labelFor = React.useCallback(
      (value: string): string =>
        options.find((option) => option.value === value)?.label ??
        seenLabels.current.get(value) ??
        value,
      [options],
    );

    const filtered = React.useMemo(
      () => (filter === false ? options : options.filter((option) => filter(option, query))),
      [options, filter, query],
    );

    React.useEffect(() => {
      if (!open) {
        setActiveIndex(-1);
        return;
      }
      const current = selectedRef.current[0];
      const preferred = current ? filtered.findIndex((option) => option.value === current) : -1;
      setActiveIndex(
        preferred >= 0 && !filtered[preferred]?.disabled ? preferred : nextEnabled(filtered, -1, 1),
      );
    }, [open, filtered]);

    React.useEffect(() => {
      if (!open || activeIndex < 0) return;
      listRef.current
        ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);

    useIsomorphicLayoutEffect(() => {
      const anchor = rootRef.current;
      if (!open || !anchor) return;

      const update = () => {
        const rect = anchor.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom - POPOVER_MARGIN;
        const above = rect.top - POPOVER_MARGIN;
        const flip = below < POPOVER_MAX_HEIGHT / 2 && above > below;
        setPopoverStyle({
          position: "fixed",
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          maxHeight: Math.round(
            Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, flip ? above : below)),
          ),
          ...(flip
            ? { bottom: Math.round(window.innerHeight - rect.top + POPOVER_GAP) }
            : { top: Math.round(rect.bottom + POPOVER_GAP) }),
        });
      };

      update();
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      const observer = new ResizeObserver(update);
      observer.observe(anchor);
      return () => {
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        observer.disconnect();
      };
    }, [open]);

    React.useEffect(() => {
      if (!open) return;
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
        setOpen(false);
        setQuery("");
        queryChangeRef.current?.("");
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [open]);

    const updateQuery = (next: string) => {
      setQuery(next);
      queryChangeRef.current?.(next);
    };

    const commit = (next: string[]) => {
      if (!controlled) setInternal(next);
      if (props.multiple === true) props.onValueChange?.(next);
      else props.onValueChange?.(next[0] ?? null);
    };

    const closeList = () => {
      setOpen(false);
      if (query !== "") updateQuery("");
    };

    const selectOption = (option: ComboboxOption) => {
      if (disabled || option.disabled) return;
      if (multiple) {
        commit(
          selected.includes(option.value)
            ? selected.filter((value) => value !== option.value)
            : [...selected, option.value],
        );
        if (query !== "") updateQuery("");
        inputRef.current?.focus();
        return;
      }
      commit([option.value]);
      setOpen(false);
      if (query !== "") updateQuery("");
    };

    const typeAhead = React.useRef({ buffer: "", at: 0 });

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const dir = event.key === "ArrowDown" ? 1 : -1;
          setActiveIndex((current) => nextEnabled(filtered, current, dir));
          return;
        }
        case "Home":
        case "End": {
          if (!open) return;
          event.preventDefault();
          setActiveIndex(
            event.key === "Home"
              ? nextEnabled(filtered, -1, 1)
              : nextEnabled(filtered, filtered.length, -1),
          );
          return;
        }
        case "Enter": {
          if (!open) return;
          const option = filtered[activeIndex];
          if (!option) return;
          event.preventDefault();
          selectOption(option);
          return;
        }
        case "Escape": {
          if (!open) return;
          event.preventDefault();
          event.stopPropagation();
          closeList();
          return;
        }
        case "Tab": {
          if (open) closeList();
          return;
        }
        case "Backspace": {
          if (multiple && query === "" && selected.length > 0) commit(selected.slice(0, -1));
          return;
        }
        default: {
          if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
          const now = Date.now();
          const state = typeAhead.current;
          state.buffer =
            now - state.at > TYPE_AHEAD_RESET_MS ? event.key : state.buffer + event.key;
          state.at = now;
          const needle = state.buffer.toLowerCase();
          const match = filtered.findIndex(
            (option) => !option.disabled && option.label.toLowerCase().startsWith(needle),
          );
          if (match >= 0) setActiveIndex(match);
        }
      }
    };

    const singleLabel = !multiple && selected[0] !== undefined ? labelFor(selected[0]) : "";

    let inputPlaceholder = placeholder;
    if (multiple) inputPlaceholder = selected.length > 0 ? "" : placeholder;
    else if (open && singleLabel !== "") inputPlaceholder = singleLabel;

    return (
      <div
        ref={setRootRef}
        className={cn(
          fieldBox({ size, invalid: isInvalid, fixedHeight: !multiple }),
          multiple && cn("flex-wrap py-1", variant(FIELD_MIN_HEIGHTS, size, "sm")),
          className,
        )}
        onClick={() => {
          if (disabled) return;
          inputRef.current?.focus();
          if (!open) setOpen(true);
        }}
      >
        {multiple &&
          selected.map((value) => (
            <span
              key={value}
              className={cn(
                "inline-flex h-5 max-w-32 shrink-0 items-center gap-1 rounded-[var(--kn-r-xs)]",
                "border border-[var(--kn-border)] bg-[var(--kn-surface-3)] pl-1.5 pr-1 text-xs",
                mono && "font-mono",
              )}
            >
              <span className="truncate">{labelFor(value)}</span>
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                aria-label={`Remove ${labelFor(value)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  commit(selected.filter((entry) => entry !== value));
                  inputRef.current?.focus();
                }}
                className={cn(
                  "inline-flex shrink-0 items-center text-[var(--kn-text-3)] hover:text-[var(--kn-text)]",
                  "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
                )}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={multiple || open ? query : singleLabel}
          placeholder={inputPlaceholder}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0 ? `${generatedId}o${activeIndex}` : undefined
          }
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={isInvalid || undefined}
          aria-required={required || undefined}
          onChange={(event) => {
            updateQuery(event.currentTarget.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "min-w-16 flex-1 bg-transparent text-[inherit] outline-none",
            "placeholder:text-[var(--kn-text-3)] disabled:cursor-not-allowed",
            mono && "font-mono",
          )}
        />

        <span className="ml-auto flex shrink-0 items-center gap-1">
          {loading && (
            <Loader2
              size={FIELD_ICON_SIZES[size]}
              aria-hidden
              className="animate-[var(--animate-spin-slow)] text-[var(--kn-text-3)]"
            />
          )}
          {clearable && selected.length > 0 && !disabled && (
            <IconButton
              icon={X}
              label="Clear selection"
              size="xs"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                commit([]);
                if (query !== "") updateQuery("");
                inputRef.current?.focus();
              }}
            />
          )}
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={open ? "Close options" : "Open options"}
            onClick={(event) => {
              event.stopPropagation();
              if (open) closeList();
              else setOpen(true);
              inputRef.current?.focus();
            }}
            className="inline-flex shrink-0 items-center text-[var(--kn-text-3)] disabled:cursor-not-allowed"
          >
            <ChevronDown
              size={FIELD_ICON_SIZES[size]}
              aria-hidden
              className={cn(
                "transition-transform duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                open && "rotate-180",
              )}
            />
          </button>
        </span>

        {name !== undefined &&
          selected.map((value) => <input key={value} type="hidden" name={name} value={value} />)}

        {open &&
          typeof document !== "undefined" &&
          createPortal(
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              aria-multiselectable={multiple || undefined}
              aria-busy={loading || undefined}
              style={popoverStyle}
              className={cn(
                "z-50 overflow-y-auto py-1 text-base text-[var(--kn-text)]",
                "border border-[var(--kn-border-strong)] bg-[var(--kn-surface)]",
                "rounded-[var(--kn-r-md)] shadow-[var(--kn-shadow-md)]",
                "animate-[var(--animate-rise)]",
                listClassName,
              )}
            >
              {loading ? (
                <div
                  role="presentation"
                  className="flex items-center gap-2 px-2 py-2 text-[var(--kn-text-2)]"
                >
                  <Loader2 size={12} aria-hidden className="animate-[var(--animate-spin-slow)]" />
                  {loadingMessage}
                </div>
              ) : filtered.length === 0 ? (
                <div role="presentation" className="px-2 py-2 text-[var(--kn-text-2)]">
                  {emptyMessage}
                </div>
              ) : (
                filtered.map((option, index) => {
                  const isSelected = selected.includes(option.value);
                  const OptionIcon = option.icon;
                  return (
                    <div
                      key={option.value}
                      id={`${generatedId}o${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectOption(option)}
                      onMouseMove={() => {
                        if (!option.disabled && index !== activeIndex) setActiveIndex(index);
                      }}
                      className={cn(
                        "flex min-h-7 cursor-pointer select-none items-center gap-2 px-2 py-1",
                        index === activeIndex && "bg-[var(--kn-surface-3)]",
                        option.disabled && "cursor-not-allowed opacity-50",
                      )}
                    >
                      {OptionIcon && (
                        <OptionIcon size={14} className="shrink-0 text-[var(--kn-text-3)]" />
                      )}
                      <span className="flex min-w-0 flex-col">
                        <span className={cn("truncate", option.mono && "font-mono")}>
                          {option.label}
                        </span>
                        {option.description !== undefined && (
                          <span className="truncate text-sm text-[var(--kn-text-3)]">
                            {option.description}
                          </span>
                        )}
                      </span>
                      <Check
                        size={12}
                        aria-hidden
                        className={cn(
                          "ml-auto shrink-0 text-[var(--kn-accent-400)]",
                          !isSelected && "invisible",
                        )}
                      />
                    </div>
                  );
                })
              )}
            </div>,
            document.body,
          )}
      </div>
    );
  },
);
