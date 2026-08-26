import { expect, test as setup } from "@playwright/test";
import { authStatePath, fleetSize, ownerEmail, ownerPassword } from "../support/config.js";
import { sectionNamed } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Journey 1 — sign in and land somewhere useful.
 *
 * The Command Center's job is to answer "what needs me right now", so
 * an empty attention list on a fleet with a failed unit on every host
 * would be the panel lying. The assertion below is deliberately about
 * an item that can only exist because four real agents connected and
 * pushed their unit lists up: nothing in the seed writes a service row.
 *
 * The session this leaves behind is what every other spec runs on.
 * ------------------------------------------------------------------ */

setup("signs in and lands on a Command Center showing the live fleet", async ({ page }) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("**/");
  const header = page.getByRole("heading", { level: 1, name: "Command Center" });
  await expect(header).toBeVisible();

  /* Both axes of the fleet rollup, straight off /health's own truth. */
  await expect(page.getByText(`${fleetSize}/${fleetSize} agents connected`)).toBeVisible();

  const attention = sectionNamed(page, "Needs attention");
  const items = attention.getByRole("listitem");
  await expect
    .poll(() => items.count(), { message: "the attention list never filled" })
    .toBeGreaterThan(0);

  /* A failed unit is only knowable from a connected agent's inventory. */
  await expect(attention.getByText(/\d+ failed units? on \S+/).first()).toBeVisible();

  await page.context().storageState({ path: authStatePath });
});
