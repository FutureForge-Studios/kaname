import { expect, test } from "@playwright/test";
import { fleetSize } from "../support/config.js";
import { cellAt, columnIndex } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Journey 3 — the fleet table keeps the two status axes apart.
 *
 * PLAN.md 2.6 makes this a rule rather than a preference: "can we reach
 * the box" and "is the box OK" are independent, a host is routinely
 * connected and critical at once, and neither may ever be collapsed
 * into a single dot. So the assertion is not that a status is shown —
 * it is that there are two of them, in two columns, drawing from two
 * different vocabularies.
 * ------------------------------------------------------------------ */

const CONNECTION_WORDS = /Connected|Degraded|Disconnected|Never enrolled|Revoked/;
const HEALTH_WORDS = /^(Healthy|Warning|Critical|Unknown)$/;

test("a connected server shows its agent state and its health separately", async ({ page }) => {
  await page.goto("/infrastructure/servers");

  const table = page.getByRole("table", { name: "Servers" });
  await expect(table).toBeVisible();

  const agent = await columnIndex(table, "Agent");
  const health = await columnIndex(table, "Health");
  expect(agent, "the two axes share a column").not.toBe(health);

  const row = table.locator("tbody tr").filter({ hasText: "forge-01" }).first();
  await expect(row).toBeVisible();

  /* The agent really is connected — these four hosts dialled in over
   * the real socket during global setup. */
  const agentCell = cellAt(row, agent);
  await expect(agentCell).toContainText("Connected");

  /* Health is a separate verdict about the same host, and it is a
   * health word — not a second rendering of the connection. */
  const healthCell = cellAt(row, health);
  await expect(healthCell).toHaveText(HEALTH_WORDS);
  await expect(healthCell).not.toContainText(CONNECTION_WORDS);

  /* Filtering on one axis must not answer for the other. Every
   * simulated host is connected, so narrowing to `connected` keeps all
   * four — and each still carries its own health verdict. */
  await page.getByLabel("Filter by agent state").selectOption("connected");
  await expect
    .poll(
      async () => {
        const cells = await table.locator(`tbody tr td:nth-child(${agent + 1})`).allInnerTexts();
        return cells.every((text) => text.includes("Connected")) ? cells.length : -1;
      },
      { message: "the connected filter never settled on the whole fleet" },
    )
    .toBe(fleetSize);

  const verdicts = await table.locator(`tbody tr td:nth-child(${health + 1})`).allInnerTexts();
  expect(verdicts).toHaveLength(fleetSize);
  for (const verdict of verdicts) expect(verdict.trim()).toMatch(HEALTH_WORDS);
});
