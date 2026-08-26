"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FilterX, RefreshCw } from "lucide-react";
import {
  Button,
  DataTable,
  EmptyState,
  IconButton,
  PageHeader,
  RelativeTime,
  SearchInput,
  cn,
  type DataTableColumn,
  type DataTableDensity,
  type DataTableRowAction,
  type SortState,
} from "@kaname/ui";
import type { QueryParams, ApiError, ListResult } from "@/lib/api";
import type { UseQueryResult } from "@tanstack/react-query";
import type { IconComponent } from "@/lib/icons";
import { PageError } from "./PageError";

/* ------------------------------------------------------------------ *
 * ResourcePage — the shared list scaffold.
 *
 * Thirty list pages exist in this product and they must feel like one.
 * That is only true if the search box, the filter row, the refresh
 * control, the staleness indicator, the primary action, the bulk bar,
 * the skeleton, the empty state and the error state all live in one
 * place. A page that hand-rolled any of them would be the page that
 * behaves differently under a failing agent.
 *
 * List state lives in the query string, not in component state, so
 * every view an operator reaches is a URL they can send to someone.
 * ------------------------------------------------------------------ */

const SEARCH_DEBOUNCE_MS = 200;

/** The `/` shortcut looks for this attribute. */
export const LIST_SEARCH_ATTR = "data-kn-list-search";

export interface ResourceListState {
  /** Raw input value; updates on every keystroke. */
  search: string;
  setSearch: (value: string) => void;
  /** Debounced value that is actually in the URL and the query. */
  q: string;
  sort: SortState | null;
  setSort: (sort: SortState | null) => void;
  page: number;
  setPage: (page: number) => void;
  perPage: number;
  setPerPage: (perPage: number) => void;
  filters: Record<string, string>;
  setFilter: (key: string, value: string | null) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  selected: string[];
  setSelected: (ids: string[]) => void;
  /** Ready to hand straight to `useList`. */
  params: QueryParams;
}

export interface ResourceListStateOptions {
  defaultSort?: SortState | null;
  defaultPerPage?: number;
  /** Query-string keys this page treats as filters. */
  filterKeys?: readonly string[];
  /** Merged into `params`, e.g. `{ server_id }` from the ServerPicker. */
  extraParams?: QueryParams;
}

export function useResourceListState(options: ResourceListStateOptions = {}): ResourceListState {
  const { defaultSort = null, defaultPerPage = 50, filterKeys = [], extraParams } = options;
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();

  const filterSignature = filterKeys.join(",");
  const paramString = searchParams.toString();

  const q = searchParams.get("q") ?? "";
  const page = toPositiveInt(searchParams.get("page"), 1);
  const perPage = toPositiveInt(searchParams.get("per_page"), defaultPerPage);
  const sortId = searchParams.get("sort");
  const sort: SortState | null = sortId
    ? { id: sortId, order: searchParams.get("order") === "asc" ? "asc" : "desc" }
    : defaultSort;

  const filters = React.useMemo(() => {
    const current = new URLSearchParams(paramString);
    const out: Record<string, string> = {};
    for (const key of filterSignature.split(",").filter(Boolean)) {
      const value = current.get(key);
      if (value) out[key] = value;
    }
    return out;
  }, [filterSignature, paramString]);

  const update = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(paramString);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [paramString, pathname, router],
  );

  const [search, setSearchValue] = React.useState(q);
  const searchRef = React.useRef(q);

  /* An external navigation (palette, breadcrumb, back button) owns the
   * input; a keystroke owns it until the debounce lands. */
  React.useEffect(() => {
    if (q !== searchRef.current) {
      searchRef.current = q;
      setSearchValue(q);
    }
  }, [q]);

  React.useEffect(() => {
    if (search === searchRef.current) return;
    const timer = window.setTimeout(() => {
      searchRef.current = search;
      update({ q: search || null, page: null });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, update]);

  const [selected, setSelected] = React.useState<string[]>([]);

  /* A selection that survived a filter change would act on rows the
   * operator can no longer see. */
  React.useEffect(() => {
    setSelected([]);
  }, [paramString]);

  const params = React.useMemo<QueryParams>(
    () => ({
      ...extraParams,
      ...filters,
      q: q || undefined,
      sort: sort?.id,
      order: sort?.order,
      page,
      per_page: perPage,
    }),
    [extraParams, filters, page, perPage, q, sort],
  );

  return {
    search,
    setSearch: setSearchValue,
    q,
    sort,
    setSort: (next) => update({ sort: next?.id ?? null, order: next?.order ?? null, page: null }),
    page,
    setPage: (next) => update({ page: next <= 1 ? null : String(next) }),
    perPage,
    setPerPage: (next) => update({ per_page: String(next), page: null }),
    filters,
    setFilter: (key, value) => update({ [key]: value, page: null }),
    clearFilters: () =>
      update(Object.fromEntries(Object.keys(filters).map((key) => [key, null]))),
    activeFilterCount: Object.keys(filters).length,
    selected,
    setSelected,
    params,
  };
}

function toPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/* ------------------------------------------------------------------ */

export interface ResourcePageProps<T> {
  title: React.ReactNode;
  /** Technical second line: a hostname, a path, a connection string. */
  subtitle?: React.ReactNode;
  tabs?: React.ReactNode;
  /** The one thing this page exists to let you do. */
  primaryAction?: React.ReactNode;
  headerActions?: React.ReactNode;

  state: ResourceListState;
  query: UseQueryResult<ListResult<T>, ApiError>;

  columns: readonly DataTableColumn<T>[];
  getRowId: (row: T, index: number) => string;
  /** Accessible name for the table. */
  tableLabel: string;
  density?: DataTableDensity;

  searchPlaceholder?: string;
  /** Selects, comboboxes and toggles that narrow the list. */
  filters?: React.ReactNode;
  toolbarExtra?: React.ReactNode;

  selectable?: boolean;
  isRowSelectable?: (row: T) => boolean;
  bulkActions?: (ids: string[]) => React.ReactNode;
  rowActions?: (row: T, index: number) => readonly DataTableRowAction<T>[];
  onRowClick?: (row: T, index: number) => void;

  emptyIcon?: IconComponent;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Same button as `primaryAction`; an empty table is where it matters most. */
  emptyAction?: React.ReactNode;

  /** Prefix for the error message, e.g. "Mailboxes". */
  errorContext?: string;
  /** Rendered between the header and the table — a ServerPicker, a banner. */
  children?: React.ReactNode;
  className?: string;
}

export function ResourcePage<T>({
  title,
  subtitle,
  tabs,
  primaryAction,
  headerActions,
  state,
  query,
  columns,
  getRowId,
  tableLabel,
  density = "default",
  searchPlaceholder = "Search",
  filters,
  toolbarExtra,
  selectable = false,
  isRowSelectable,
  bulkActions,
  rowActions,
  onRowClick,
  emptyIcon,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  errorContext,
  children,
  className,
}: ResourcePageProps<T>) {
  const rows = query.data?.data ?? [];
  const meta = query.data?.meta;
  const filtered = state.q.length > 0 || state.activeFilterCount > 0;

  const toolbar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <SearchInput
        data-kn-list-search=""
        value={state.search}
        onChange={(event) => state.setSearch(event.target.value)}
        onClear={() => state.setSearch("")}
        placeholder={searchPlaceholder}
        aria-label={`Search ${tableLabel.toLowerCase()}`}
        size="sm"
        className="w-48"
      />
      {filters}
      {state.activeFilterCount > 0 && (
        <Button variant="ghost" size="xs" icon={FilterX} onClick={state.clearFilters}>
          Clear filters
        </Button>
      )}
      {toolbarExtra}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {query.dataUpdatedAt > 0 && (
          <span className="hidden items-center gap-1 text-xs text-[var(--kn-text-3)] md:inline-flex">
            synced <RelativeTime value={query.dataUpdatedAt} />
          </span>
        )}
        <IconButton
          icon={RefreshCw}
          label="Refresh"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        />
      </div>
    </div>
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        tabs={tabs}
        actions={
          (primaryAction || headerActions) && (
            <>
              {headerActions}
              {primaryAction}
            </>
          )
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        {children}

        <DataTable<T>
          columns={columns}
          rows={rows}
          getRowId={getRowId}
          label={tableLabel}
          density={density}
          toolbar={toolbar}
          sort={state.sort}
          onSortChange={state.setSort}
          page={state.page}
          perPage={state.perPage}
          total={meta?.total}
          onPageChange={state.setPage}
          selectedIds={selectable ? state.selected : undefined}
          onSelectionChange={selectable ? state.setSelected : undefined}
          isRowSelectable={isRowSelectable}
          bulkActions={bulkActions}
          rowActions={rowActions}
          onRowClick={onRowClick}
          loading={query.isLoading}
          skeletonRows={Math.min(state.perPage, 10)}
          error={
            query.isError ? (
              <PageError
                error={query.error}
                onRetry={() => void query.refetch()}
                context={errorContext}
              />
            ) : undefined
          }
          empty={
            <EmptyState
              icon={emptyIcon}
              title={filtered ? "No matches" : emptyTitle}
              description={
                filtered
                  ? "Nothing in this list matches the current search and filters."
                  : emptyDescription
              }
              action={filtered ? undefined : emptyAction}
              secondaryAction={
                filtered ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      state.setSearch("");
                      state.clearFilters();
                    }}
                  >
                    Clear search and filters
                  </Button>
                ) : undefined
              }
              size="md"
            />
          }
          className="min-h-0 flex-1"
        />
      </div>
    </div>
  );
}
