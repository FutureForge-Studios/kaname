import { expect, test } from "@playwright/test";

/* ------------------------------------------------------------------ *
 * Journey 2 — the command palette.
 *
 * PLAN.md 6 is specific about what makes this worth building rather
 * than buying: it exposes ACTIONS, not just navigation. A palette that
 * only jumps between pages sends an operator to a list to hunt for the
 * row they already named, which is the thing it exists to replace — so
 * finding a server is only half of what is asserted here.
 * ------------------------------------------------------------------ */

test("Cmd/Ctrl+K finds a host by name and offers verbs against it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Command Center" })).toBeVisible();

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeHidden();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();

  /* Destinations resolve locally, before anything is typed. */
  await expect(palette.getByRole("group", { name: "Go to" })).toBeVisible();

  await palette.getByRole("combobox", { name: "Search and commands" }).fill("forge-01");

  /* The row itself: found across the fleet, not typed into a URL. */
  const servers = palette.getByRole("group", { name: "Servers" });
  await expect(servers.getByRole("option", { name: /forge-01/ })).toBeVisible();

  /* And the verbs. forge-01 advertises nginx, so the palette offers to
   * restart it; the terminal is offered because this account holds
   * terminal.session:exec on that host. */
  const actions = palette.getByRole("group", { name: "Actions" });
  await expect(actions.getByRole("option", { name: /Restart nginx on forge-01/ })).toBeVisible();
  await expect(actions.getByRole("option", { name: /Open terminal on forge-01/ })).toBeVisible();

  /* An action is a thing you can run, so running one has to land on the
   * surface that runs it rather than on a search page. */
  await actions.getByRole("option", { name: /Open terminal on forge-01/ }).click();
  await expect(page).toHaveURL(/\/terminal\?server_id=[0-9a-f-]{36}/);
  await expect(palette).toBeHidden();
});

test("Escape closes the palette without navigating", async ({ page }) => {
  await page.goto("/infrastructure/servers");
  /* The shortcut is bound in an effect, so wait for a rendered list
   * rather than for `load` — otherwise this races hydration. */
  await expect(page.getByRole("table", { name: "Servers" })).toBeVisible();

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/infrastructure\/servers/);
});
