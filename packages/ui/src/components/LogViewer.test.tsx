import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOG_LEVELS, LogViewer, type LogLine } from "./LogViewer.js";

/* ------------------------------------------------------------------ *
 * LogViewer is every log surface in the product: journald, container
 * logs, mail logs, job logs. Four things have to keep working or an
 * operator loses the ability to read a failure:
 *   - the level filter and the search actually narrow what is shown
 *   - follow-tail lets go the moment the operator scrolls away from it
 *   - a 50k-line buffer renders a window, not 50k rows
 *
 * jsdom has no layout, so the scroll region's geometry is declared
 * explicitly; the height the component itself sets inline is what the
 * stubbed ResizeObserver in src/test/setup.ts reports back.
 * ------------------------------------------------------------------ */

const LINE_HEIGHT = 18;
const VIEW_HEIGHT = 420;

const LINES: readonly LogLine[] = [
  { id: "l1", ts: "2026-08-26T10:00:00.000Z", level: "info", message: "nginx: worker started" },
  { id: "l2", ts: "2026-08-26T10:00:01.000Z", level: "warn", message: "nginx: 404 for /admin" },
  { id: "l3", ts: "2026-08-26T10:00:02.000Z", level: "error", message: "nginx: upstream 502" },
  { id: "l4", ts: "2026-08-26T10:00:03.000Z", level: "debug", message: "postfix: queue drained" },
  { id: "l5", ts: "2026-08-26T10:00:04.000Z", message: "kernel: NGINX oom-killed" },
];

function region(): HTMLElement {
  return screen.getByRole("log");
}

function renderedLines(): number[] {
  return screen
    .queryAllByRole("button", { name: /^Copy line \d+$/ })
    .map((button) => Number((button.getAttribute("aria-label") ?? "").replace("Copy line ", "")));
}

/** The windowed rows: spacer > translated container > one div per line. */
function rowNodes(): HTMLElement[] {
  const container = region().firstElementChild?.firstElementChild;
  return container ? Array.from(container.children as HTMLCollectionOf<HTMLElement>) : [];
}

function messages(): string[] {
  return rowNodes().map((row) => row.lastElementChild?.textContent ?? "");
}

/** jsdom never lays anything out, so the scroll box is described by hand. */
function scrollTo(element: HTMLElement, top: number, contentHeight: number): void {
  Object.defineProperty(element, "scrollHeight", { value: contentHeight, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: VIEW_HEIGHT, configurable: true });
  Object.defineProperty(element, "scrollTop", { value: top, writable: true, configurable: true });
  fireEvent.scroll(element);
}

/** The component drops its programmatic-scroll guard on the next frame. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function manyLines(count: number): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    ts: 1_756_200_000_000 + i * 1000,
    level: i % 50 === 0 ? ("error" as const) : ("info" as const),
    message: `line ${i + 1} of ${count}`,
  }));
}

describe("level filtering", () => {
  it("shows only the levels the page asked for", () => {
    render(<LogViewer lines={LINES} levels={["error", "warn"]} />);

    const shown = messages();
    expect(shown).toContain("nginx: 404 for /admin");
    expect(shown).toContain("nginx: upstream 502");
    expect(shown).not.toContain("nginx: worker started");
    expect(shown).not.toContain("postfix: queue drained");
    // A line with no level at all is never filtered out.
    expect(shown).toContain("kernel: NGINX oom-killed");

    expect(screen.getByText("3 of 5 lines")).toBeTruthy();
  });

  it("reports every level as on until one is turned off", async () => {
    const user = userEvent.setup();
    const onLevelsChange = vi.fn();
    render(<LogViewer lines={LINES} onLevelsChange={onLevelsChange} />);

    expect(screen.getByRole("button", { name: "All levels" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "All levels" }));
    const item = screen.getByRole("menuitemcheckbox", { name: "ERR error" });
    expect(item.getAttribute("aria-checked")).toBe("true");

    await user.click(item);
    expect(onLevelsChange).toHaveBeenCalledWith([
      "trace",
      "debug",
      "info",
      "notice",
      "warn",
      "fatal",
    ]);
  });

  it("filters on its own when no page is controlling it", async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={LINES} />);

    await user.click(screen.getByRole("button", { name: "All levels" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "ERR error" }));

    expect(messages()).not.toContain("nginx: upstream 502");
    expect(screen.getByText("4 of 5 lines")).toBeTruthy();
    expect(screen.getByRole("button", { name: "6 levels" })).toBeTruthy();

    await user.click(screen.getByRole("menuitem", { name: "Show all levels" }));
    expect(messages()).toContain("nginx: upstream 502");
    expect(screen.getByText("5 of 5 lines")).toBeTruthy();
  });

  it("says so when the filter leaves nothing", () => {
    render(<LogViewer lines={LINES.slice(0, 1)} levels={["fatal"]} emptyLabel="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });
});

describe("search", () => {
  it("highlights every occurrence, case-insensitively", async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={LINES} />);

    await user.type(screen.getByLabelText("Search log lines"), "nginx");

    const marks = Array.from(region().querySelectorAll("mark"));
    // Three nginx lines plus the upper-case one in the kernel message.
    expect(marks.map((mark) => mark.textContent)).toEqual(["nginx", "nginx", "nginx", "NGINX"]);
    expect(screen.getByText("1/4")).toBeTruthy();
  });

  it("treats the query as a regular expression once .* is armed", async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={LINES} />);

    await user.click(screen.getByRole("button", { name: "Match as a regular expression" }));
    await user.type(screen.getByLabelText("Search log lines"), "\\d+");

    const marks = Array.from(region().querySelectorAll("mark")).map((mark) => mark.textContent);
    expect(marks).toEqual(["404", "502"]);
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("leaves the same query literal while .* is off", async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={LINES} />);

    await user.type(screen.getByLabelText("Search log lines"), "\\d+");

    expect(region().querySelectorAll("mark")).toHaveLength(0);
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("flags an unparseable expression instead of throwing", async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={LINES} />);

    await user.click(screen.getByRole("button", { name: "Match as a regular expression" }));
    await user.type(screen.getByLabelText("Search log lines"), "nginx(");

    expect(screen.getByLabelText("Search log lines").getAttribute("aria-invalid")).toBe("true");
    expect(region().querySelectorAll("mark")).toHaveLength(0);
    expect(messages()).toHaveLength(LINES.length);
  });

  it("steps through the matches and stops following the tail", async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={LINES} />);

    await user.type(screen.getByLabelText("Search log lines"), "nginx");
    expect(screen.getByText("Following")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Next match" }));

    expect(screen.getByText("2/4")).toBeTruthy();
    expect(screen.getByText("Scrolled back")).toBeTruthy();
  });

  it("searches what the level filter left behind, not the raw buffer", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LogViewer lines={LINES} />);

    await user.type(screen.getByLabelText("Search log lines"), "nginx");
    expect(screen.getByText("1/4")).toBeTruthy();

    rerender(<LogViewer lines={LINES} levels={["error"]} />);
    expect(screen.getByText("2 of 5 lines")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});

describe("follow tail", () => {
  it("lets go when the operator scrolls away, and takes hold again on demand", async () => {
    const user = userEvent.setup();
    const lines = manyLines(400);
    render(<LogViewer lines={lines} />);
    await nextFrame();

    expect(screen.getByText("Following")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();

    scrollTo(region(), 0, lines.length * LINE_HEIGHT);

    expect(screen.getByText("Scrolled back")).toBeTruthy();
    const jump = screen.getByRole("button", { name: "Jump to latest" });

    await user.click(jump);
    expect(screen.getByText("Following")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("keeps following while the operator sits at the bottom", async () => {
    const lines = manyLines(400);
    render(<LogViewer lines={lines} />);
    await nextFrame();

    const total = lines.length * LINE_HEIGHT;
    scrollTo(region(), total - VIEW_HEIGHT, total);

    expect(screen.getByText("Following")).toBeTruthy();
  });

  it("freezes the buffer while paused and counts what is waiting", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LogViewer lines={LINES} />);

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Paused")).toBeTruthy();

    rerender(
      <LogViewer
        lines={[
          ...LINES,
          { id: "l6", level: "error", message: "nginx: upstream 502" },
          { id: "l7", level: "info", message: "nginx: recovered" },
        ]}
      />,
    );

    expect(screen.getByText("5 of 5 lines")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume (2)" })).toBeTruthy();
    expect(messages()).not.toContain("nginx: recovered");

    await user.click(screen.getByRole("button", { name: "Resume (2)" }));
    expect(screen.getByText("7 of 7 lines")).toBeTruthy();
    expect(messages()).toContain("nginx: recovered");
  });
});

describe("windowing", () => {
  it("renders a window over a large buffer rather than every line", async () => {
    const lines = manyLines(5000);
    render(<LogViewer lines={lines} />);
    await nextFrame();

    const rendered = renderedLines();
    // Enough to cover 420px of 18px rows plus overscan — nowhere near 5000.
    expect(rendered.length).toBeGreaterThan(VIEW_HEIGHT / LINE_HEIGHT);
    expect(rendered.length).toBeLessThan(100);

    expect(rendered).toContain(1);
    expect(rendered).not.toContain(2500);

    // The scrollbar still spans the whole buffer.
    const spacer = region().firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${5000 * LINE_HEIGHT}px`);
    expect(screen.getByText("5,000 of 5,000 lines")).toBeTruthy();
  });

  it("moves the window to wherever the operator scrolled", async () => {
    const lines = manyLines(5000);
    render(<LogViewer lines={lines} />);
    await nextFrame();

    const total = 5000 * LINE_HEIGHT;
    scrollTo(region(), 2500 * LINE_HEIGHT, total);

    const rendered = renderedLines();
    expect(rendered).toContain(2501);
    expect(rendered).not.toContain(1);
    expect(rendered.length).toBeLessThan(100);

    const offset = region().firstElementChild?.firstElementChild as HTMLElement;
    expect(offset.style.transform).toBe(`translateY(${(2500 - 12) * LINE_HEIGHT}px)`);
  });

  it("windows what is left after a filter, not the raw buffer", async () => {
    const lines = manyLines(5000);
    render(<LogViewer lines={lines} levels={["error"]} />);
    await nextFrame();

    // Every fiftieth line is an error, so 100 survive the filter.
    expect(screen.getByText("100 of 5,000 lines")).toBeTruthy();
    const spacer = region().firstElementChild as HTMLElement;
    expect(spacer.style.height).toBe(`${100 * LINE_HEIGHT}px`);
    expect(renderedLines().length).toBeLessThanOrEqual(100);
  });
});
