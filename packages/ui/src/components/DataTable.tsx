"use client";

import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  MoreHorizontal,
  X,
} from "lucide-react";
import { cn, variant } from "../lib/cn.js";
import { Button, IconButton } from "./Button.js";
import { Checkbox } from "./Checkbox.js";
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from "./DropdownMenu.js";

/* ------------------------------------------------------------------ *
 * DataTable — every list page in the product is this component.
 *
 * Deliberately server-shaped: sorting, pagination and search are
 * controlled by the consumer, because the REST contract paginates and
 * sorts server-side. The table renders exactly the rows it was handed
 * and never filters them itself.
 * ------------------------------------------------------------------ */

export type SortOrder = "asc" | "desc";
export interface SortState {
  id: string;
  order: SortOrder;
}

export type DataTableAlign = "left" | "center" | "right";
export type DataTableDensity = "default" | "compact";
export type DataTableBreakpoint = "md" | "lg";

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  /** Simple value extractor. Ignored when `cell` is given. */
  accessor?: (row: T) => React.ReactNode;
  /** Full control over the cell body. */
  cell?: (row: T, index: number) => React.ReactNode;
  width?: number | string;
  minWidth?: number | string;
  align?: DataTableAlign;
  sortable?: boolean;
  /** Identifiers, paths, IPs, ports, hashes — anything that must line up. */
  mono?: boolean;
  /** Collapses into the secondary line under the primary cell below this breakpoint. */
  hideBelow?: DataTableBreakpoint;
  /** Pinned against the horizontal scroll. `left` needs a numeric `width`. */
  sticky?: "left" | "right";
  /** Kept out of the column-visibility menu and always rendered. */
  locked?: boolean;
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableRowAction<T> {
  id: string;
  label: string;
  icon?: React.ComponentType<{ size?: number | string; className?: string }>;
  onSelect: (row: T) => void;
  disabled?: boolean;
  /** Red treatment for destroy/revoke/ban. Never the default action. */
  destructive?: boolean;
  separatorBefore?: boolean;
}

export interface DataTableProps<T> extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T, index: number) => string;
  /** Names the table for assistive technology. */
  label: string;

  density?: DataTableDensity;
  stickyHeader?: boolean;
  /** Distance from the scroll container's top edge, for a header under a topbar. */
  stickyHeaderOffset?: number;

  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;

  page?: number;
  perPage?: number;
  total?: number;
  onPageChange?: (page: number) => void;

  /** Passing `onSelectionChange` is what turns selection on. */
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;
  isRowSelectable?: (row: T) => boolean;
  /** Rendered inside the bar that appears above the table while rows are selected. */
  bulkActions?: (ids: string[]) => React.ReactNode;

  rowActions?: (row: T, index: number) => readonly DataTableRowAction<T>[];
  onRowClick?: (row: T, index: number) => void;

  hiddenColumns?: readonly string[];
  onHiddenColumnsChange?: (ids: string[]) => void;
  /** Set false to drop the column-visibility menu entirely. */
  columnVisibility?: boolean;
  /** Left side of the toolbar — search and filters live here, owned by the consumer. */
  toolbar?: React.ReactNode;

  loading?: boolean;
  skeletonRows?: number;
  /** Rendered in place of the rows. Pass an `<EmptyState />`. */
  empty?: React.ReactNode;
  /** Takes precedence over loading and empty. Pass an `<ErrorState />`. */
  error?: React.ReactNode;
}

const ROW_HEIGHT: Record<DataTableDensity, string> = {
  default: "h-[var(--kn-row-h)]",
  compact: "h-[var(--kn-row-h-compact)]",
};

const CELL_PAD: Record<DataTableDensity, string> = {
  default: "px-3",
  compact: "px-2",
};

const ALIGN: Record<DataTableAlign, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

const HEADER_JUSTIFY: Record<DataTableAlign, string> = {
  left: "justify-start",
  center: "justify-center",
  right: "justify-end",
};

const HIDE_BELOW_CELL: Record<DataTableBreakpoint, string> = {
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

const HIDE_ABOVE_INLINE: Record<DataTableBreakpoint, string> = {
  md: "md:hidden",
  lg: "lg:hidden",
};

const SELECT_COL_WIDTH = 36;
const ACTION_COL_WIDTH = 44;

/** Interactive descendants own their own click; the row must not also fire. */
const CONTROL_SELECTOR =
  "a,button,input,select,textarea,label,[role='menuitem'],[role='menuitemcheckbox'],[role='checkbox'],[data-no-row-click]";

function cellValue<T>(col: DataTableColumn<T>, row: T, index: number): React.ReactNode {
  if (col.cell) return col.cell(row, index);
  if (col.accessor) return col.accessor(row);
  return null;
}

function pxWidth(value: number | string | undefined): number {
  return typeof value === "number" ? value : 0;
}

function groupThousands(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = Math.abs(Math.trunc(value)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Stable across server and client so the skeleton never reflows on hydration. */
function skeletonWidth(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return `${40 + (h % 7) * 8}%`;
}

function DataTableInner<T>(
  {
    columns,
    rows,
    getRowId,
    label,
    density = "default",
    stickyHeader = true,
    stickyHeaderOffset = 0,
    sort = null,
    onSortChange,
    page = 1,
    perPage = 50,
    total,
    onPageChange,
    selectedIds,
    onSelectionChange,
    isRowSelectable,
    bulkActions,
    rowActions,
    onRowClick,
    hiddenColumns,
    onHiddenColumnsChange,
    columnVisibility = true,
    toolbar,
    loading = false,
    skeletonRows = 8,
    empty,
    error,
    className,
    ...props
  }: DataTableProps<T>,
  ref: React.ForwardedRef<HTMLDivElement>,
) {
  const [internalHidden, setInternalHidden] = React.useState<string[]>([]);
  const hidden = React.useMemo(
    () => new Set(hiddenColumns ?? internalHidden),
    [hiddenColumns, internalHidden],
  );
  const setHidden = React.useCallback(
    (next: string[]) => {
      if (onHiddenColumnsChange) onHiddenColumnsChange(next);
      else setInternalHidden(next);
    },
    [onHiddenColumnsChange],
  );

  const visible = React.useMemo(
    () => columns.filter((c) => c.locked || !hidden.has(c.id)),
    [columns, hidden],
  );

  const selectable = onSelectionChange !== undefined;
  const selected = React.useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const hasActions = rowActions !== undefined;

  const rowIds = React.useMemo(() => rows.map((r, i) => getRowId(r, i)), [rows, getRowId]);
  const selectableIds = React.useMemo(
    () => rowIds.filter((_, i) => !isRowSelectable || isRowSelectable(rows[i] as T)),
    [rowIds, rows, isRowSelectable],
  );
  const selectedOnPage = selectableIds.filter((id) => selected.has(id)).length;
  const allSelected = selectableIds.length > 0 && selectedOnPage === selectableIds.length;

  /* ---- sticky offsets ------------------------------------------- */

  const { stickyLeft, stickyRight } = React.useMemo(() => {
    const left = new Map<string, number>();
    const right = new Map<string, number>();
    let acc = selectable ? SELECT_COL_WIDTH : 0;
    for (const col of visible) {
      if (col.sticky === "left") {
        left.set(col.id, acc);
        acc += pxWidth(col.width);
      }
    }
    acc = hasActions ? ACTION_COL_WIDTH : 0;
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const col = visible[i];
      if (col && col.sticky === "right") {
        right.set(col.id, acc);
        acc += pxWidth(col.width);
      }
    }
    return { stickyLeft: left, stickyRight: right };
  }, [visible, selectable, hasActions]);

  const tableMinWidth = React.useMemo(() => {
    let sum = (selectable ? SELECT_COL_WIDTH : 0) + (hasActions ? ACTION_COL_WIDTH : 0);
    for (const col of visible) sum += pxWidth(col.minWidth) || pxWidth(col.width);
    return sum > 0 ? sum : undefined;
  }, [visible, selectable, hasActions]);

  /* ---- selection ------------------------------------------------ */

  const anchorRef = React.useRef<number | null>(null);
  const shiftRef = React.useRef(false);

  const toggleRow = React.useCallback(
    (index: number, range: boolean) => {
      if (!onSelectionChange) return;
      const id = rowIds[index];
      if (id === undefined) return;
      const next = new Set(selected);
      const anchor = anchorRef.current;
      if (range && anchor !== null && anchor !== index) {
        const shouldSelect = !next.has(id);
        const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = lo; i <= hi; i += 1) {
          const rid = rowIds[i];
          const row = rows[i];
          if (rid === undefined || row === undefined) continue;
          if (isRowSelectable && !isRowSelectable(row)) continue;
          if (shouldSelect) next.add(rid);
          else next.delete(rid);
        }
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
        anchorRef.current = index;
      }
      onSelectionChange([...next]);
    },
    [onSelectionChange, rowIds, rows, selected, isRowSelectable],
  );

  const toggleAll = React.useCallback(() => {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (allSelected) for (const id of selectableIds) next.delete(id);
    else for (const id of selectableIds) next.add(id);
    anchorRef.current = null;
    onSelectionChange([...next]);
  }, [onSelectionChange, selected, selectableIds, allSelected]);

  /* ---- keyboard navigation -------------------------------------- */

  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const rowRefs = React.useRef<(HTMLTableRowElement | null)[]>([]);

  React.useEffect(() => {
    if (focusedIndex > rows.length - 1) setFocusedIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusedIndex]);

  const focusRow = React.useCallback((index: number) => {
    setFocusedIndex(index);
    rowRefs.current[index]?.focus();
  }, []);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTableSectionElement>) => {
      if (rows.length === 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,select,[contenteditable='true']")) return;

      const current = Math.min(focusedIndex, rows.length - 1);
      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          focusRow(Math.min(current + 1, rows.length - 1));
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          focusRow(Math.max(current - 1, 0));
          break;
        case "Home":
          event.preventDefault();
          focusRow(0);
          break;
        case "End":
          event.preventDefault();
          focusRow(rows.length - 1);
          break;
        case "Enter": {
          const row = rows[current];
          if (onRowClick && row !== undefined) {
            event.preventDefault();
            onRowClick(row, current);
          }
          break;
        }
        case "x":
          if (selectable) {
            event.preventDefault();
            toggleRow(current, event.shiftKey);
          }
          break;
        case "Escape":
          if (selectable && selected.size > 0) {
            event.preventDefault();
            onSelectionChange?.([]);
          }
          break;
        default:
          break;
      }
    },
    [
      rows,
      focusedIndex,
      focusRow,
      onRowClick,
      selectable,
      toggleRow,
      selected.size,
      onSelectionChange,
    ],
  );

  const handleRowClick = React.useCallback(
    (event: React.MouseEvent<HTMLTableRowElement>, row: T, index: number) => {
      const target = event.target as HTMLElement;
      if (target.closest(CONTROL_SELECTOR)) return;
      setFocusedIndex(index);
      if (event.shiftKey && selectable) {
        toggleRow(index, true);
        return;
      }
      onRowClick?.(row, index);
    },
    [onRowClick, selectable, toggleRow],
  );

  /* ---- sorting -------------------------------------------------- */

  const cycleSort = React.useCallback(
    (id: string) => {
      if (!onSortChange) return;
      if (!sort || sort.id !== id) onSortChange({ id, order: "asc" });
      else if (sort.order === "asc") onSortChange({ id, order: "desc" });
      else onSortChange(null);
    },
    [sort, onSortChange],
  );

  /* ---- states --------------------------------------------------- */

  const showError = error != null;
  const showLoading = !showError && loading;
  const showEmpty = !showError && !loading && rows.length === 0;
  const colSpan = visible.length + (selectable ? 1 : 0) + (hasActions ? 1 : 0);

  const secondary = React.useMemo(() => visible.filter((c) => c.hideBelow), [visible]);
  const secondaryScope: DataTableBreakpoint | null = secondary.some((c) => c.hideBelow === "lg")
    ? "lg"
    : secondary.length > 0
      ? "md"
      : null;
  const primaryColumnId = visible.find((c) => !c.hideBelow)?.id ?? visible[0]?.id;

  const rowH = variant(ROW_HEIGHT, density, "default");
  const pad = variant(CELL_PAD, density, "default");

  const pageCount = total !== undefined ? Math.max(1, Math.ceil(total / perPage)) : 1;
  const rangeFrom = total === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeTo = total !== undefined ? Math.min(page * perPage, total) : page * perPage;

  const showToolbar = toolbar != null || columnVisibility;
  const selectionCount = selected.size;

  return (
    <div
      ref={ref}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]",
        className,
      )}
      {...props}
    >
      {showToolbar && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--kn-border)] px-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">{toolbar}</div>
          {columnVisibility && (
            <DropdownMenu
              placement="bottom-end"
              label="Column visibility"
              trigger={<IconButton icon={Columns3} label="Columns" size="sm" />}
            >
              <MenuLabel>Columns</MenuLabel>
              <MenuSeparator />
              {columns.map((col) => {
                const shown = Boolean(col.locked) || !hidden.has(col.id);
                return (
                  <MenuItem
                    key={col.id}
                    role="menuitemcheckbox"
                    aria-checked={shown}
                    disabled={col.locked}
                    closeOnSelect={false}
                    icon={shown ? Check : undefined}
                    className={cn(!shown && "pl-8")}
                    onSelect={() => {
                      const draft = new Set(hidden);
                      if (shown) draft.add(col.id);
                      else draft.delete(col.id);
                      setHidden([...draft]);
                    }}
                  >
                    {col.header}
                  </MenuItem>
                );
              })}
              {hidden.size > 0 && (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={() => setHidden([])}>Show all columns</MenuItem>
                </>
              )}
            </DropdownMenu>
          )}
        </div>
      )}

      {selectable && selectionCount > 0 && !showLoading && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--kn-border)] bg-[var(--kn-accent-soft)] px-2">
          <span className="tabular-nums px-1 text-base font-medium text-[var(--kn-text)]">
            {groupThousands(selectionCount)} selected
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {bulkActions?.([...selected])}
          </div>
          <Button variant="ghost" size="xs" icon={X} onClick={() => onSelectionChange?.([])}>
            Clear
          </Button>
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-auto">
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-base"
          style={tableMinWidth ? { minWidth: tableMinWidth } : undefined}
          aria-label={label}
          aria-busy={showLoading || undefined}
        >
          <colgroup>
            {selectable && <col style={{ width: SELECT_COL_WIDTH }} />}
            {visible.map((col) => (
              <col
                key={col.id}
                style={col.width !== undefined ? { width: col.width } : undefined}
              />
            ))}
            {hasActions && <col style={{ width: ACTION_COL_WIDTH }} />}
          </colgroup>

          <thead>
            <tr>
              {selectable && (
                <th
                  scope="col"
                  style={stickyHeader ? { top: stickyHeaderOffset, left: 0 } : { left: 0 }}
                  className={cn(
                    "sticky left-0 z-30 h-8 border-b border-[var(--kn-border)] bg-[var(--kn-surface)] px-2",
                    stickyHeader && "top-0",
                  )}
                >
                  <Checkbox
                    checked={allSelected}
                    indeterminate={selectedOnPage > 0 && !allSelected}
                    disabled={selectableIds.length === 0}
                    onChange={toggleAll}
                    aria-label={allSelected ? "Deselect all rows" : "Select all rows"}
                  />
                </th>
              )}

              {visible.map((col) => {
                const align = col.align ?? "left";
                const active = sort?.id === col.id;
                const SortIcon = !active
                  ? ChevronsUpDown
                  : sort.order === "asc"
                    ? ArrowUp
                    : ArrowDown;
                const left = stickyLeft.get(col.id);
                const right = stickyRight.get(col.id);
                const style: React.CSSProperties = {};
                if (stickyHeader) style.top = stickyHeaderOffset;
                if (left !== undefined) style.left = left;
                if (right !== undefined) style.right = right;
                return (
                  <th
                    key={col.id}
                    scope="col"
                    aria-sort={
                      active ? (sort.order === "asc" ? "ascending" : "descending") : undefined
                    }
                    style={style}
                    className={cn(
                      "z-20 h-8 border-b border-[var(--kn-border)] bg-[var(--kn-surface)] font-medium text-xs text-[var(--kn-text-3)]",
                      pad,
                      variant(ALIGN, align, "left"),
                      (stickyHeader || left !== undefined || right !== undefined) && "sticky",
                      left !== undefined && "z-30 border-r border-[var(--kn-border-subtle)]",
                      right !== undefined && "z-30 border-l border-[var(--kn-border-subtle)]",
                      col.hideBelow && HIDE_BELOW_CELL[col.hideBelow],
                      col.headerClassName,
                    )}
                  >
                    {col.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => cycleSort(col.id)}
                        className={cn(
                          "-mx-1 inline-flex w-[calc(100%+8px)] items-center gap-1 rounded-[var(--kn-r-xs)] px-1 py-0.5",
                          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                          "hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]",
                          active && "text-[var(--kn-text)]",
                          variant(HEADER_JUSTIFY, align, "left"),
                        )}
                      >
                        <span className="truncate">{col.header}</span>
                        <SortIcon size={12} className="shrink-0 opacity-70" aria-hidden />
                      </button>
                    ) : (
                      <span className="block truncate">{col.header}</span>
                    )}
                  </th>
                );
              })}

              {hasActions && (
                <th
                  scope="col"
                  style={stickyHeader ? { top: stickyHeaderOffset, right: 0 } : { right: 0 }}
                  className={cn(
                    "sticky right-0 z-30 h-8 border-b border-l border-[var(--kn-border-subtle)] bg-[var(--kn-surface)]",
                    stickyHeader && "top-0",
                  )}
                >
                  <span className="sr-only">Row actions</span>
                </th>
              )}
            </tr>
          </thead>

          <tbody onKeyDown={handleKeyDown}>
            {showError && (
              <tr>
                <td colSpan={colSpan} className="p-0">
                  {error}
                </td>
              </tr>
            )}

            {showLoading &&
              Array.from({ length: skeletonRows }, (_, i) => (
                <DataTableSkeletonRow
                  key={`skeleton-${i}`}
                  columns={visible}
                  density={density}
                  withSelection={selectable}
                  withActions={hasActions}
                />
              ))}

            {showEmpty && (
              <tr>
                <td colSpan={colSpan} className="p-0">
                  {empty}
                </td>
              </tr>
            )}

            {!showError &&
              !showLoading &&
              rows.map((row, index) => {
                const id = rowIds[index] ?? String(index);
                const isSelected = selected.has(id);
                const canSelect = !isRowSelectable || isRowSelectable(row);
                const actions = rowActions?.(row, index) ?? [];
                return (
                  <tr
                    key={id}
                    ref={(el) => {
                      rowRefs.current[index] = el;
                    }}
                    tabIndex={index === focusedIndex ? 0 : -1}
                    aria-selected={selectable ? isSelected : undefined}
                    data-selected={isSelected || undefined}
                    onFocus={() => setFocusedIndex(index)}
                    onClick={(event) => handleRowClick(event, row, index)}
                    className={cn(
                      "group/row outline-none",
                      "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                      "focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--kn-ring)]",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {selectable && (
                      <td
                        style={{ left: 0 }}
                        className={cn(
                          "sticky left-0 z-10 border-b border-[var(--kn-border-subtle)] bg-[var(--kn-surface)] px-2 align-middle",
                          "group-hover/row:bg-[var(--kn-surface-2)] group-data-[selected]/row:bg-[var(--kn-accent-soft)]",
                          rowH,
                        )}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={!canSelect}
                          onClick={(event: React.MouseEvent<HTMLInputElement>) => {
                            shiftRef.current = event.shiftKey;
                          }}
                          onChange={() => toggleRow(index, shiftRef.current)}
                          aria-label={isSelected ? "Deselect row" : "Select row"}
                        />
                      </td>
                    )}

                    {visible.map((col) => {
                      const align = col.align ?? "left";
                      const left = stickyLeft.get(col.id);
                      const right = stickyRight.get(col.id);
                      const style: React.CSSProperties = {};
                      if (left !== undefined) style.left = left;
                      if (right !== undefined) style.right = right;
                      const isPrimary = col.id === primaryColumnId;
                      return (
                        <td
                          key={col.id}
                          style={Object.keys(style).length > 0 ? style : undefined}
                          className={cn(
                            "border-b border-[var(--kn-border-subtle)] align-middle text-[var(--kn-text)]",
                            pad,
                            rowH,
                            variant(ALIGN, align, "left"),
                            col.mono && "font-mono text-sm",
                            align === "right" && "tabular-nums",
                            (left !== undefined || right !== undefined) &&
                              "sticky z-10 bg-[var(--kn-surface)] group-hover/row:bg-[var(--kn-surface-2)] group-data-[selected]/row:bg-[var(--kn-accent-soft)]",
                            left !== undefined && "border-r border-[var(--kn-border-subtle)]",
                            right !== undefined && "border-l border-[var(--kn-border-subtle)]",
                            col.hideBelow && HIDE_BELOW_CELL[col.hideBelow],
                            col.cellClassName,
                          )}
                        >
                          <div className="min-w-0 truncate">{cellValue(col, row, index)}</div>
                          {isPrimary && secondaryScope && (
                            <div
                              className={cn(
                                "flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-xs text-[var(--kn-text-2)]",
                                HIDE_ABOVE_INLINE[secondaryScope],
                              )}
                            >
                              {secondary.map((sc) => (
                                <span
                                  key={sc.id}
                                  className={cn(
                                    "inline-flex min-w-0 items-baseline gap-1",
                                    sc.hideBelow && HIDE_ABOVE_INLINE[sc.hideBelow],
                                  )}
                                >
                                  <span className="text-[var(--kn-text-3)]">{sc.header}</span>
                                  <span className={cn("truncate", sc.mono && "font-mono")}>
                                    {cellValue(sc, row, index)}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}

                    {hasActions && (
                      <td
                        style={{ right: 0 }}
                        className={cn(
                          "sticky right-0 z-10 border-b border-l border-[var(--kn-border-subtle)] bg-[var(--kn-surface)] text-center align-middle",
                          "group-hover/row:bg-[var(--kn-surface-2)] group-data-[selected]/row:bg-[var(--kn-accent-soft)]",
                          rowH,
                        )}
                      >
                        {actions.length > 0 && (
                          <DropdownMenu
                            placement="bottom-end"
                            label="Row actions"
                            trigger={
                              <IconButton
                                icon={MoreHorizontal}
                                label="Row actions"
                                size="xs"
                                data-no-row-click=""
                              />
                            }
                          >
                            {actions.map((action) => (
                              <React.Fragment key={action.id}>
                                {action.separatorBefore && <MenuSeparator />}
                                <MenuItem
                                  icon={action.icon}
                                  disabled={action.disabled}
                                  destructive={action.destructive}
                                  onSelect={() => action.onSelect(row)}
                                >
                                  {action.label}
                                </MenuItem>
                              </React.Fragment>
                            ))}
                          </DropdownMenu>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {total !== undefined && (
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-[var(--kn-border)] px-3 text-xs text-[var(--kn-text-2)]">
          <span className="tabular-nums">
            {groupThousands(rangeFrom)}–{groupThousands(rangeTo)} of {groupThousands(total)}
          </span>
          {onPageChange && (
            <div className="flex items-center gap-1">
              <IconButton
                icon={ChevronLeft}
                label="Previous page"
                size="xs"
                disabled={page <= 1}
                onClick={() => onPageChange(page - 1)}
              />
              <span className="tabular-nums px-1">
                {groupThousands(page)} / {groupThousands(pageCount)}
              </span>
              <IconButton
                icon={ChevronRight}
                label="Next page"
                size="xs"
                disabled={page >= pageCount}
                onClick={() => onPageChange(page + 1)}
              />
            </div>
          )}
        </div>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {selectable && selectionCount > 0 ? `${selectionCount} rows selected` : ""}
      </div>
    </div>
  );
}

/**
 * forwardRef erases the row type parameter, so the public value is cast
 * back to a generic call signature. This is the only place in the kit
 * that needs it.
 */
export const DataTable = React.forwardRef(DataTableInner) as <T>(
  props: DataTableProps<T> & { ref?: React.Ref<HTMLDivElement> },
) => React.ReactElement;

/* --------------------------- Skeleton row --------------------------- */

export interface DataTableSkeletonRowProps<T> {
  columns: readonly DataTableColumn<T>[];
  density?: DataTableDensity;
  withSelection?: boolean;
  withActions?: boolean;
}

/** Matches the real column widths so loading never reflows into loaded. */
export function DataTableSkeletonRow<T>({
  columns,
  density = "default",
  withSelection = false,
  withActions = false,
}: DataTableSkeletonRowProps<T>) {
  const rowH = variant(ROW_HEIGHT, density, "default");
  const pad = variant(CELL_PAD, density, "default");
  const bar =
    "block h-2 rounded-[var(--kn-r-xs)] bg-[var(--kn-surface-3)] animate-[kn-shimmer_1.1s_ease-in-out_infinite_alternate] motion-reduce:animate-none";

  return (
    <tr aria-hidden>
      {withSelection && (
        <td className={cn("border-b border-[var(--kn-border-subtle)] px-2", rowH)}>
          <span className={cn(bar, "h-3.5 w-3.5 rounded-[var(--kn-r-xs)]")} />
        </td>
      )}
      {columns.map((col) => (
        <td
          key={col.id}
          className={cn(
            "border-b border-[var(--kn-border-subtle)]",
            pad,
            rowH,
            col.hideBelow && HIDE_BELOW_CELL[col.hideBelow],
          )}
        >
          <span
            className={cn(bar, (col.align ?? "left") === "right" && "ml-auto")}
            style={{ width: skeletonWidth(col.id) }}
          />
        </td>
      ))}
      {withActions && (
        <td className={cn("border-b border-l border-[var(--kn-border-subtle)]", rowH)} />
      )}
    </tr>
  );
}
