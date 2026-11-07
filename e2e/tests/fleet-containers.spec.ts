import { expect, test } from "@playwright/test";
import { cellAt, columnIndex, jobStatusPill } from "../support/ui.js";
import { container, drawerJob, openRowActions, server, tableRow } from "../support/fleet.js";

/* ------------------------------------------------------------------ *
 * Containers: the same contract as units — every verb a job, the
 * cached row the proof — plus the one verb that destroys data.
 *
 * Removal discards a writable layer, so it is typed-confirmed, and a
 * running container is refused unless force is chosen. That refusal is
 * the control plane's, not the dialog's; the dialog only pre-ticks
 * force so the operator is not sent on a round trip to learn it. Both
 * halves are exercised here.
 *
 * Everything runs on mail-01 so the suite's other journeys keep the
 * containers they expect on forge-01.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const HOST = "mail-01";

async function openFleetFilteredTo(page: import("@playwright/test").Page, name: string) {
  const host = await server(HOST);
  await page.goto(`/infrastructure/containers?server_id=${host.id}`);
  await page.getByLabel("Search containers").fill(name);
  const table = page.getByRole("table", { name: "Containers" });
  const row = tableRow(table, name).first();
  await expect(row).toBeVisible();
  return { table, row };
}

test("the state filter narrows the fleet, and each row says which host it is on", async ({
  page,
}) => {
  await page.goto("/infrastructure/containers");
  const table = page.getByRole("table", { name: "Containers" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await page.getByLabel("Filter by container state").selectOption("exited");
  await expect(page).toHaveURL(/state=exited/);

  const state = await columnIndex(table, "State");
  await expect
    .poll(async () => {
      const cells = await table.locator(`tbody tr td:nth-child(${state + 1})`).allInnerTexts();
      return cells.length > 0 && cells.every((text) => text.startsWith("exited"));
    })
    .toBe(true);
  await expect(tableRow(table, "n8n").filter({ hasText: HOST })).toBeVisible();
});

test("start, restart and stop each run as a job and the row follows the host", async ({ page }) => {
  const { table, row } = await openFleetFilteredTo(page, "n8n");
  const state = await columnIndex(table, "State");
  await expect(cellAt(row, state)).toContainText("exited");

  /* Stopped containers offer Start and nothing that needs them running. */
  let menu = await openRowActions(page, row);
  await expect(menu.getByRole("menuitem", { name: "Stop", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Restart", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Start", exact: true }).click();
  await expect(jobStatusPill(drawerJob(page, "n8n"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(cellAt(row, state)).toContainText("running", { timeout: 30_000 });

  /* Restart counts on the host, not in the browser. */
  const before = (await container(HOST, "n8n")).restart_count;
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Restart", exact: true }).click();
  await expect
    .poll(async () => (await container(HOST, "n8n")).restart_count, { timeout: 60_000 })
    .toBe(before + 1);

  /* Stop is confirmed; then the row goes back to exited. */
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Stop", exact: true }).click();
  await page.getByRole("dialog", { name: "Stop n8n?" }).getByRole("button", { name: "Stop" }).click();
  await expect(cellAt(row, state)).toContainText("exited", { timeout: 60_000 });
  expect((await container(HOST, "n8n")).state).toBe("exited");
});

test("removing a running container without force is refused by the control plane", async ({
  page,
}) => {
  const { row } = await openFleetFilteredTo(page, "uptime-kuma");
  const menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Remove uptime-kuma?" });
  await expect(dialog).toContainText("still running");
  const force = dialog.getByRole("checkbox", { name: /Force removal/ });
  /* Pre-ticked for a running container, and the operator can untick it. */
  await expect(force).toBeChecked();
  await force.uncheck();
  await dialog.getByLabel(/to confirm/).fill("uptime-kuma");
  await dialog.getByRole("button", { name: "Remove" }).click();

  /* The refusal is the API's own sentence, and nothing was removed. */
  await expect(page.getByText(`uptime-kuma is still running on ${HOST}.`).first()).toBeVisible();
  expect((await container(HOST, "uptime-kuma")).state).toBe("running");
});

test("removing a container is typed-confirmed and the row leaves the table", async ({ page }) => {
  const { table, row } = await openFleetFilteredTo(page, "watchtower");
  const menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Remove watchtower?" });
  const remove = dialog.getByRole("button", { name: "Remove" });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill("watchtowe");
  await expect(remove).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill("watchtower");
  await remove.click();

  await expect(jobStatusPill(drawerJob(page, "watchtower"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(tableRow(table, "watchtower")).toHaveCount(0, { timeout: 30_000 });
  await expect(container(HOST, "watchtower")).rejects.toThrow(/no container watchtower/);
});

test("a container's logs stream, and exec goes through the audited terminal", async ({ page }) => {
  const redis = await container(HOST, "kaname-redis");
  await page.goto(`/infrastructure/containers/${redis.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "kaname-redis" })).toBeVisible();

  await page.getByRole("tab", { name: /Logs/ }).click();
  await expect(page).toHaveURL(/tab=logs/);
  const output = page.getByRole("log", { name: "Output from kaname-redis" });
  await expect
    .poll(async () => (await output.innerText()).trim().length, { message: "no container output" })
    .toBeGreaterThan(0);

  /* Exec is not a shell string over the RPC surface: it is the command
   * to run, and the way into a recorded terminal on that host. */
  await page.getByRole("tab", { name: /Exec/ }).click();
  await expect(page.locator("code").filter({ hasText: "docker exec -it kaname-redis sh" })).toBeVisible();
  await page.getByRole("button", { name: `Open terminal on ${HOST}` }).click();
  const host = await server(HOST);
  await expect(page).toHaveURL(new RegExp(`/terminal\\?server_id=${host.id}`));
});
