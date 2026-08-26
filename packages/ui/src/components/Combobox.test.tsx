import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Combobox, type ComboboxOption } from "./Combobox.js";

/* ------------------------------------------------------------------ *
 * Combobox is how an operator picks one of forty systemd units, and the
 * product is keyboard-first (PLAN.md 6), so the whole contract has to
 * hold from the keyboard alone: arrows move, Enter selects, Escape
 * closes, printable keys filter — and with `filter={false}` they drive
 * a type-ahead instead, which is the only way an async list is
 * navigable at all. `aria-activedescendant` is what makes any of that
 * audible to a screen reader, so it is asserted alongside.
 * ------------------------------------------------------------------ */

const UNITS: readonly ComboboxOption[] = [
  { value: "nginx.service", label: "nginx.service", mono: true },
  { value: "postgresql.service", label: "postgresql.service", mono: true, disabled: true },
  { value: "postfix.service", label: "postfix.service", mono: true },
  { value: "dovecot.service", label: "dovecot.service", mono: true },
];

function field(): HTMLInputElement {
  return screen.getByRole("combobox", { name: "Unit" }) as HTMLInputElement;
}

/** What a screen reader would read as the current row. */
function activeOption(): HTMLElement | null {
  const id = field().getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id);
}

function optionLabels(): string[] {
  return screen.getAllByRole("option").map((option) => option.textContent ?? "");
}

describe("opening and closing", () => {
  it("opens on ArrowDown and closes on Escape without selecting", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox options={UNITS} onValueChange={onValueChange} aria-label="Unit" />);

    field().focus();
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.keyboard("{ArrowDown}");
    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("advertises no active option while it is closed", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" />);

    expect(field().getAttribute("aria-activedescendant")).toBeNull();
    await user.click(field());
    expect(field().getAttribute("aria-activedescendant")).not.toBeNull();
  });

  it("closes when the pointer goes elsewhere", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Combobox options={UNITS} aria-label="Unit" />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.click(field());
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("keyboard navigation", () => {
  it("moves the active option with the arrows, skipping disabled rows", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" />);

    await user.click(field());
    expect(activeOption()?.textContent).toBe("nginx.service");

    // postgresql.service is disabled and must not become active.
    await user.keyboard("{ArrowDown}");
    expect(activeOption()?.textContent).toBe("postfix.service");

    await user.keyboard("{ArrowDown}");
    expect(activeOption()?.textContent).toBe("dovecot.service");

    await user.keyboard("{ArrowUp}");
    expect(activeOption()?.textContent).toBe("postfix.service");
  });

  it("wraps around both ends", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" />);

    await user.click(field());
    await user.keyboard("{ArrowUp}");
    expect(activeOption()?.textContent).toBe("dovecot.service");

    await user.keyboard("{ArrowDown}");
    expect(activeOption()?.textContent).toBe("nginx.service");
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" />);

    await user.click(field());
    await user.keyboard("{End}");
    expect(activeOption()?.textContent).toBe("dovecot.service");

    await user.keyboard("{Home}");
    expect(activeOption()?.textContent).toBe("nginx.service");
  });

  it("marks the active option as the one the listbox highlights", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" />);

    await user.click(field());
    await user.keyboard("{ArrowDown}");

    const active = activeOption();
    expect(active?.getAttribute("data-index")).toBe("2");
    expect(active?.className).toContain("bg-[var(--kn-surface-3)]");
    for (const option of screen.getAllByRole("option")) {
      if (option !== active) expect(option.className).not.toContain("bg-[var(--kn-surface-3)]");
    }
  });

  it("selects the active option on Enter and closes", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox options={UNITS} onValueChange={onValueChange} aria-label="Unit" />);

    await user.click(field());
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onValueChange).toHaveBeenCalledWith("postfix.service");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().value).toBe("postfix.service");
  });

  it("opens on the selected option rather than the first one", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} value="dovecot.service" aria-label="Unit" />);

    await user.click(field());
    expect(activeOption()?.textContent).toBe("dovecot.service");
  });
});

describe("filtering", () => {
  it("narrows the list as the operator types", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" />);

    await user.type(field(), "postf");

    expect(optionLabels()).toEqual(["postfix.service"]);
    expect(activeOption()?.textContent).toBe("postfix.service");
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} aria-label="Unit" emptyMessage="No units" />);

    await user.type(field(), "redis");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No units")).toBeTruthy();
  });

  it("clears the query once a value is chosen", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(<Combobox options={UNITS} onQueryChange={onQueryChange} aria-label="Unit" />);

    await user.type(field(), "dove");
    expect(onQueryChange).toHaveBeenLastCalledWith("dove");

    await user.keyboard("{Enter}");
    expect(onQueryChange).toHaveBeenLastCalledWith("");
    expect(field().value).toBe("dovecot.service");
  });

  it("hands filtering to the parent, and types ahead instead", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(
      <Combobox options={UNITS} filter={false} onQueryChange={onQueryChange} aria-label="Unit" />,
    );

    await user.click(field());
    await user.keyboard("dove");

    // The list is the parent's business — every row is still there.
    expect(optionLabels()).toHaveLength(UNITS.length);
    expect(onQueryChange).toHaveBeenLastCalledWith("dove");
    // ...but the type-ahead still moved the cursor to the match.
    expect(activeOption()?.textContent).toBe("dovecot.service");
  });

  it("never types ahead onto a disabled row", async () => {
    const user = userEvent.setup();
    render(<Combobox options={UNITS} filter={false} aria-label="Unit" />);

    await user.click(field());
    await user.keyboard("postg");

    expect(activeOption()?.textContent).toBe("postfix.service");
  });
});

describe("pointer selection", () => {
  it("selects the option that was clicked", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox options={UNITS} onValueChange={onValueChange} aria-label="Unit" />);

    await user.click(field());
    await user.click(screen.getByRole("option", { name: "dovecot.service" }));

    expect(onValueChange).toHaveBeenCalledWith("dovecot.service");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ignores a click on a disabled option", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox options={UNITS} onValueChange={onValueChange} aria-label="Unit" />);

    await user.click(field());
    await user.click(screen.getByRole("option", { name: "postgresql.service" }));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

describe("multiple selection", () => {
  it("keeps the list open and accumulates values", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        multiple
        options={UNITS}
        value={["nginx.service"]}
        onValueChange={onValueChange}
        aria-label="Unit"
      />,
    );

    await user.click(field());
    await user.click(screen.getByRole("option", { name: "dovecot.service" }));

    expect(onValueChange).toHaveBeenCalledWith(["nginx.service", "dovecot.service"]);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("peels the last chip off with Backspace on an empty query", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        multiple
        options={UNITS}
        value={["nginx.service", "postfix.service"]}
        onValueChange={onValueChange}
        aria-label="Unit"
      />,
    );

    expect(screen.getByRole("button", { name: "Remove postfix.service" })).toBeTruthy();

    field().focus();
    await user.keyboard("{Backspace}");

    expect(onValueChange).toHaveBeenCalledWith(["nginx.service"]);
  });

  it("leaves the chips alone while the query has text", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        multiple
        options={UNITS}
        value={["nginx.service", "postfix.service"]}
        onValueChange={onValueChange}
        aria-label="Unit"
      />,
    );

    await user.type(field(), "do");
    await user.keyboard("{Backspace}");

    expect(onValueChange).not.toHaveBeenCalled();
  });
});
