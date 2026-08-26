import { expect, type Locator, type Page } from "@playwright/test";

/* ------------------------------------------------------------------ *
 * Locators the panel's own structure implies.
 *
 * Everything here is derived from something the product asserts about
 * itself — a heading, a dialog label, a column header, the tooltip a
 * JobStatusPill carries — rather than from a class name, so a restyle
 * does not break the suite but a change of meaning does.
 * ------------------------------------------------------------------ */

/** SectionCard is a plain <section> with a heading, not a labelled region. */
export function sectionNamed(page: Page, title: string): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: title }) });
}

/**
 * The index of a DataTable column, by its header. Header cells and body
 * cells are one to one — a column hidden at this width still renders
 * both — so the same index reads the cell under it.
 */
export async function columnIndex(table: Locator, header: string): Promise<number> {
  const headers = await table.locator("thead th").allInnerTexts();
  const index = headers.findIndex((text) => text.trim() === header);
  expect(index, `the table has no "${header}" column, only ${headers.join(", ")}`).toBeGreaterThan(
    -1,
  );
  return index;
}

export function cellAt(row: Locator, index: number): Locator {
  return row.locator("td").nth(index);
}

/**
 * A JobStatusPill, found by the tooltip each status carries. Matching on
 * the description rather than the label means the locator survives every
 * transition, so one element can be watched from queued to succeeded.
 */
export function jobStatusPill(scope: Locator): Locator {
  return scope.locator(
    [
      'span[title^="Queued."]',
      'span[title^="Running."]',
      'span[title^="Succeeded."]',
      'span[title^="Failed."]',
      'span[title^="Cancelled."]',
      'span[title^="Timed out."]',
    ].join(", "),
  );
}
