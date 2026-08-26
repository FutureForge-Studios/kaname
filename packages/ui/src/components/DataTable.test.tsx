import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DataTable, type DataTableColumn, type SortState } from "./DataTable.js";

/* ------------------------------------------------------------------ *
 * Every list page in the product is this component, so each promise it
 * makes to those pages is pinned here: the rows it was handed, the
 * sort cycle the REST contract expects, selection (including the
 * shift-click range and the mixed-state header box), the j/k keyboard
 * contract from PLAN.md 6, and the loading / empty / error precedence
 * that decides what an operator sees when a host is unreachable.
 * ------------------------------------------------------------------ */

interface Server {
  id: string;
  name: string;
  address: string;
  health: string;
}

const ROWS: readonly Server[] = [
  { id: "s1", name: "web-01", address: "10.0.0.11", health: "Healthy" },
  { id: "s2", name: "web-02", address: "10.0.0.12", health: "Warning" },
  { id: "s3", name: "db-01", address: "10.0.0.21", health: "Critical" },
  { id: "s4", name: "mail-01", address: "10.0.0.31", health: "Healthy" },
  { id: "s5", name: "edge-01", address: "10.0.0.41", health: "Unknown" },
];

const COLUMNS: readonly DataTableColumn<Server>[] = [
  { id: "name", header: "Name", accessor: (row) => row.name, sortable: true, locked: true },
  { id: "address", header: "Address", accessor: (row) => row.address, mono: true, sortable: true },
  { id: "health", header: "Health", accessor: (row) => row.health },
];

const getRowId = (row: Server) => row.id;

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"));
}

/** Selection is controlled by the page in the real product, so it is here too. */
function SelectableTable({
  initial = [],
  onChange,
  isRowSelectable,
  onRowClick,
}: {
  initial?: string[];
  onChange?: (ids: string[]) => void;
  isRowSelectable?: (row: Server) => boolean;
  onRowClick?: (row: Server, index: number) => void;
}) {
  const [ids, setIds] = React.useState<string[]>(initial);
  return (
    <DataTable
      label="Servers"
      columns={COLUMNS}
      rows={ROWS}
      getRowId={getRowId}
      selectedIds={ids}
      isRowSelectable={isRowSelectable}
      onRowClick={onRowClick}
      onSelectionChange={(next) => {
        setIds(next);
        onChange?.(next);
      }}
    />
  );
}

describe("rendering", () => {
  it("renders one row per record and one cell per column", () => {
    const { container } = render(
      <DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} />,
    );

    const rows = bodyRows(container);
    expect(rows).toHaveLength(ROWS.length);
    expect(rows[0]?.querySelectorAll("td")).toHaveLength(COLUMNS.length);

    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("web-01")).toBeTruthy();
    expect(screen.getByText("10.0.0.21")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Servers" })).toBeTruthy();
  });

  it("renders the rows it was handed, in the order it was handed them", () => {
    // Sorting and filtering are server-side; the table must never reorder.
    const reversed = [...ROWS].reverse();
    const { container } = render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={reversed}
        getRowId={getRowId}
        sort={{ id: "name", order: "asc" }}
        onSortChange={() => {}}
      />,
    );

    const names = bodyRows(container).map((row) => row.querySelector("td")?.textContent);
    expect(names).toEqual(["edge-01", "mail-01", "db-01", "web-02", "web-01"]);
  });
});

describe("sorting", () => {
  it("cycles ascending, descending, off", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    let sort: SortState | null = null;

    const { rerender } = render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        sort={sort}
        onSortChange={onSortChange}
      />,
    );

    const header = () => screen.getByRole("button", { name: "Name" });

    await user.click(header());
    expect(onSortChange).toHaveBeenLastCalledWith({ id: "name", order: "asc" });

    sort = { id: "name", order: "asc" };
    rerender(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        sort={sort}
        onSortChange={onSortChange}
      />,
    );
    await user.click(header());
    expect(onSortChange).toHaveBeenLastCalledWith({ id: "name", order: "desc" });

    sort = { id: "name", order: "desc" };
    rerender(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        sort={sort}
        onSortChange={onSortChange}
      />,
    );
    await user.click(header());
    expect(onSortChange).toHaveBeenLastCalledWith(null);
  });

  it("restarts at ascending when a different column takes over", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();

    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        sort={{ id: "name", order: "desc" }}
        onSortChange={onSortChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Address" }));
    expect(onSortChange).toHaveBeenLastCalledWith({ id: "address", order: "asc" });
  });

  it("announces the sorted column to assistive technology", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        sort={{ id: "address", order: "desc" }}
        onSortChange={() => {}}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Address" }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBeNull();
  });

  it("offers no sort control for a column that cannot be sorted", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        onSortChange={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Health" })).toBeNull();
  });
});

describe("selection", () => {
  it("stays off until the page asks for it", () => {
    render(<DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("toggles a single row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<SelectableTable onChange={onChange} />);

    const row = bodyRows(container)[1];
    if (!row) throw new Error("no second row");
    await user.click(within(row).getByRole("checkbox"));

    expect(onChange).toHaveBeenLastCalledWith(["s2"]);
    expect(row.getAttribute("aria-selected")).toBe("true");

    await user.click(within(row).getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("puts the header box in the mixed state for a partial selection", async () => {
    const user = userEvent.setup();
    const { container } = render(<SelectableTable />);

    const header = screen.getByRole("checkbox", { name: "Select all rows" }) as HTMLInputElement;
    expect(header.indeterminate).toBe(false);
    expect(header.checked).toBe(false);

    const row = bodyRows(container)[0];
    if (!row) throw new Error("no first row");
    await user.click(within(row).getByRole("checkbox"));

    expect(header.indeterminate).toBe(true);
    expect(header.checked).toBe(false);
  });

  it("selects and clears the whole page from the header box", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SelectableTable onChange={onChange} />);

    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(onChange).toHaveBeenLastCalledWith(["s1", "s2", "s3", "s4", "s5"]);

    const header = screen.getByRole("checkbox", { name: "Deselect all rows" }) as HTMLInputElement;
    expect(header.checked).toBe(true);
    expect(header.indeterminate).toBe(false);

    await user.click(header);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("selects a range on shift-click, anchored on the last plain click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<SelectableTable onChange={onChange} />);

    const boxAt = (index: number) => {
      const row = bodyRows(container)[index];
      if (!row) throw new Error(`no row ${index}`);
      return within(row).getByRole("checkbox");
    };

    await user.click(boxAt(1));
    expect(onChange).toHaveBeenLastCalledWith(["s2"]);

    await user.keyboard("{Shift>}");
    await user.click(boxAt(3));
    await user.keyboard("{/Shift}");

    expect(onChange).toHaveBeenLastCalledWith(["s2", "s3", "s4"]);
  });

  it("clears a range on shift-click when the far end is already selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <SelectableTable initial={["s1", "s2", "s3", "s4"]} onChange={onChange} />,
    );

    const boxAt = (index: number) => {
      const row = bodyRows(container)[index];
      if (!row) throw new Error(`no row ${index}`);
      return within(row).getByRole("checkbox");
    };

    // Plain click drops s4 and anchors there; the range then follows suit.
    await user.click(boxAt(3));
    expect(onChange).toHaveBeenLastCalledWith(["s1", "s2", "s3"]);

    await user.keyboard("{Shift>}");
    await user.click(boxAt(1));
    await user.keyboard("{/Shift}");

    expect(onChange).toHaveBeenLastCalledWith(["s1"]);
  });

  it("never selects a row the page marked unselectable", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <SelectableTable onChange={onChange} isRowSelectable={(row) => row.id !== "s3"} />,
    );

    const rowThree = bodyRows(container)[2];
    expect(
      (within(rowThree as HTMLTableRowElement).getByRole("checkbox") as HTMLInputElement).disabled,
    ).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(onChange).toHaveBeenLastCalledWith(["s1", "s2", "s4", "s5"]);

    await user.click(screen.getByRole("checkbox", { name: "Deselect all rows" }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    const boxAt = (index: number) => {
      const row = bodyRows(container)[index];
      if (!row) throw new Error(`no row ${index}`);
      return within(row).getByRole("checkbox");
    };

    // The range spans row 1 to row 4 and steps over the locked row 3.
    await user.click(boxAt(0));
    await user.keyboard("{Shift>}");
    await user.click(boxAt(3));
    await user.keyboard("{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(["s1", "s2", "s4"]);
  });

  it("shows the bulk bar with a count while rows are selected", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        selectedIds={["s1", "s2"]}
        onSelectionChange={() => {}}
        bulkActions={(ids) => <button type="button">Restart {ids.length}</button>}
      />,
    );

    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart 2" })).toBeTruthy();
  });
});

describe("keyboard navigation", () => {
  async function focusFirstRow(container: HTMLElement) {
    const rows = bodyRows(container);
    rows[0]?.focus();
    return rows;
  }

  it("moves the focused row with j/k and the arrow keys", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} />,
    );
    const rows = await focusFirstRow(container);

    await user.keyboard("j");
    expect(document.activeElement).toBe(rows[1]);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[2]);

    await user.keyboard("k");
    expect(document.activeElement).toBe(rows[1]);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows[0]);

    // The ends hold rather than wrapping.
    await user.keyboard("k");
    expect(document.activeElement).toBe(rows[0]);

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(rows[ROWS.length - 1]);

    await user.keyboard("j");
    expect(document.activeElement).toBe(rows[ROWS.length - 1]);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("keeps exactly one row in the tab order", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} />,
    );
    const rows = await focusFirstRow(container);

    await user.keyboard("jj");
    expect(rows.filter((row) => row.tabIndex === 0)).toEqual([rows[2]]);
  });

  it("opens the focused row on Enter", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const { container } = render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        onRowClick={onRowClick}
      />,
    );
    await focusFirstRow(container);

    await user.keyboard("j");
    await user.keyboard("{Enter}");

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1], 1);
  });

  it("toggles selection on x, and clears it on Escape", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<SelectableTable onChange={onChange} />);
    await focusFirstRow(container);

    await user.keyboard("jjx");
    expect(onChange).toHaveBeenLastCalledWith(["s3"]);

    await user.keyboard("x");
    expect(onChange).toHaveBeenLastCalledWith([]);

    await user.keyboard("x");
    await user.keyboard("{Escape}");
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("leaves the keys alone while a control inside the table has focus", async () => {
    const user = userEvent.setup();
    const columns: DataTableColumn<Server>[] = [
      ...COLUMNS,
      {
        id: "note",
        header: "Note",
        cell: (row) => <input aria-label={`Note for ${row.name}`} defaultValue="" />,
      },
    ];
    const { container } = render(
      <DataTable label="Servers" columns={columns} rows={ROWS} getRowId={getRowId} />,
    );

    const rows = bodyRows(container);
    const field = screen.getByLabelText("Note for web-01");
    await user.click(field);
    await user.keyboard("jk");

    expect(document.activeElement).toBe(field);
    expect(field).toHaveProperty("value", "jk");
    expect(rows.filter((row) => row.tabIndex === 0)).toEqual([rows[0]]);
  });
});

describe("row clicks", () => {
  it("opens the row when the cell itself is clicked", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        onRowClick={onRowClick}
      />,
    );

    await user.click(screen.getByText("db-01"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[2], 2);
  });

  it("does not open the row when a control inside it is clicked", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onRestart = vi.fn();
    const columns: DataTableColumn<Server>[] = [
      ...COLUMNS,
      {
        id: "restart",
        header: "Restart",
        cell: (row) => (
          <button type="button" onClick={() => onRestart(row.id)}>
            Restart {row.name}
          </button>
        ),
      },
    ];

    render(
      <DataTable
        label="Servers"
        columns={columns}
        rows={ROWS}
        getRowId={getRowId}
        onRowClick={onRowClick}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Restart web-01" }));

    expect(onRestart).toHaveBeenCalledWith("s1");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not open the row when its selection box is clicked", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<SelectableTable onChange={onChange} onRowClick={onRowClick} />);

    const row = bodyRows(container)[0];
    if (!row) throw new Error("no first row");
    await user.click(within(row).getByRole("checkbox"));

    expect(onChange).toHaveBeenLastCalledWith(["s1"]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("does not open the row when a row action is chosen", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onSelect = vi.fn();

    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        onRowClick={onRowClick}
        rowActions={(row) => [
          { id: "revoke", label: "Revoke", destructive: true, onSelect: () => onSelect(row.id) },
        ]}
      />,
    );

    const triggers = screen.getAllByRole("button", { name: "Row actions" });
    await user.click(triggers[0] as HTMLElement);
    await user.click(screen.getByRole("menuitem", { name: "Revoke" }));

    expect(onSelect).toHaveBeenCalledWith("s1");
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("loading, empty and error states", () => {
  const empty = <div data-testid="empty">No servers yet</div>;
  const error = <div data-testid="error">Agent unreachable</div>;

  it("renders skeleton rows rather than an empty table while loading", () => {
    const { container } = render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={[]}
        getRowId={getRowId}
        loading
        skeletonRows={6}
        empty={empty}
      />,
    );

    const rows = bodyRows(container);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.getAttribute("aria-hidden") === "true")).toBe(true);
    // Same column count as a real row, so loading never reflows into loaded.
    expect(rows[0]?.querySelectorAll("td")).toHaveLength(COLUMNS.length);
    expect(screen.getByRole("table", { name: "Servers" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("empty")).toBeNull();
  });

  it("hides stale rows while loading", () => {
    const { container } = render(
      <DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} loading />,
    );

    expect(screen.queryByText("web-01")).toBeNull();
    expect(bodyRows(container)).toHaveLength(8);
  });

  it("shows the empty state only when the page is genuinely empty", () => {
    const { rerender } = render(
      <DataTable label="Servers" columns={COLUMNS} rows={[]} getRowId={getRowId} empty={empty} />,
    );
    expect(screen.getByTestId("empty")).toBeTruthy();

    rerender(
      <DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} empty={empty} />,
    );
    expect(screen.queryByTestId("empty")).toBeNull();
  });

  it("puts the error above everything else", () => {
    const { container } = render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        loading
        empty={empty}
        error={error}
      />,
    );

    expect(screen.getByTestId("error")).toBeTruthy();
    expect(screen.queryByTestId("empty")).toBeNull();
    expect(screen.queryByText("web-01")).toBeNull();
    // Exactly one row: the error. No skeletons underneath it.
    expect(bodyRows(container)).toHaveLength(1);
  });

  it("prefers the error to the empty state on a failed empty page", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={[]}
        getRowId={getRowId}
        empty={empty}
        error={error}
      />,
    );

    expect(screen.getByTestId("error")).toBeTruthy();
    expect(screen.queryByTestId("empty")).toBeNull();
  });
});

describe("column visibility", () => {
  it("drops a hidden column from the header and every row", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        hiddenColumns={["address"]}
      />,
    );

    expect(screen.queryByRole("columnheader", { name: "Address" })).toBeNull();
    expect(screen.queryByText("10.0.0.11")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.getByText("web-01")).toBeTruthy();
  });

  it("refuses to hide a locked column", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        hiddenColumns={["name", "address"]}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Address" })).toBeNull();
  });

  it("hides a column from the visibility menu", async () => {
    const user = userEvent.setup();
    const onHiddenColumnsChange = vi.fn();

    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        hiddenColumns={[]}
        onHiddenColumnsChange={onHiddenColumnsChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Columns" }));

    const item = screen.getByRole("menuitemcheckbox", { name: "Address" });
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Name" }).getAttribute("aria-disabled"),
    ).toBe("true");

    await user.click(item);
    expect(onHiddenColumnsChange).toHaveBeenCalledWith(["address"]);
  });

  it("hides a column without a controlling page", async () => {
    const user = userEvent.setup();
    render(<DataTable label="Servers" columns={COLUMNS} rows={ROWS} getRowId={getRowId} />);

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Health" }));

    expect(screen.queryByRole("columnheader", { name: "Health" })).toBeNull();
    expect(screen.queryByText("Critical")).toBeNull();

    await user.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(screen.getByRole("columnheader", { name: "Health" })).toBeTruthy();
  });

  it("drops the menu entirely when the page turns it off", () => {
    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        columnVisibility={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
  });
});

describe("pagination", () => {
  it("reports the range and pages through it", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        page={2}
        perPage={5}
        total={12}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText("6–10 of 12")).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });

  it("stops at both ends", () => {
    const { rerender } = render(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        page={1}
        perPage={5}
        total={12}
        onPageChange={() => {}}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    rerender(
      <DataTable
        label="Servers"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={getRowId}
        page={3}
        perPage={5}
        total={12}
        onPageChange={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
