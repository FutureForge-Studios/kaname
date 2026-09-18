import { expect, test } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { cellAt, columnIndex, jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Journey 4 — the job path, end to end, in a browser.
 *
 * This is the architecture (KD-008). Restarting a unit does not return
 * its outcome inline: the route enqueues a job, the worker claims it,
 * the hub calls the agent over its own socket, the agent's provider
 * does the work and answers, and only then does the panel learn what
 * happened. Every one of those hops is real here — the only fake in the
 * chain is the syscall at the far end.
 *
 * So the test refuses to settle for "it eventually said Succeeded". It
 * watches one pill across its whole life and fails if the operator was
 * never shown a pre-terminal state, because a mutation that resolves
 * instantly is the synchronous pass-through the design forbids. Then it
 * checks the table, where "active since" can only have moved because
 * the agent's own answer came back and replaced the cached row.
 * ------------------------------------------------------------------ */

const UNIT = "nginx.service";
const PRE_TERMINAL = ["Queued", "Running"];
const OBSERVED = ["Queued", "Running", "Succeeded", "Failed", "Cancelled", "Timed out"];

test("restarting a unit runs as a job and lands on succeeded", async ({ page }) => {
  const forge = await serverNamed("forge-01");
  await page.goto(`/infrastructure/services?server_id=${forge.id}`);

  const table = page.getByRole("table", { name: "Services" });
  await page.getByLabel("Search services").fill(UNIT);

  const row = table.locator("tbody tr").filter({ hasText: UNIT }).first();
  await expect(row).toBeVisible();

  const activeSince = await columnIndex(table, "Active since");
  const before = (await cellAt(row, activeSince).innerText()).trim();
  expect(before, "the seeded unit should already have been up for a while").not.toMatch(
    /just now|^\d+s ago$/,
  );

  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Restart", exact: true }).click();

  /* No toast-and-hope: the drawer opens on the 202 and the job is in it. */
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();

  const job = drawer
    .getByRole("listitem")
    .filter({ hasText: "Restart service" })
    .filter({ hasText: UNIT })
    .first();
  await expect(job).toBeVisible();
  await expect(job).toContainText("forge-01");

  const pill = jobStatusPill(job);
  const seen = new Set<string>();

  await expect
    .poll(
      async () => {
        const text = (await pill.innerText()).trim();
        for (const status of OBSERVED) if (text.includes(status)) seen.add(status);
        return text;
      },
      {
        message: "the job never reached a terminal state",
        intervals: [100],
        timeout: 60_000,
      },
    )
    .toContain("Succeeded");

  expect(
    PRE_TERMINAL.some((status) => seen.has(status)),
    `the pill went straight to a terminal state (saw ${[...seen].join(", ")}); ` +
      "a host-touching mutation must be queued, not answered inline",
  ).toBe(true);

  /* The drawer opens focused on what it just started, so the job's log
   * is already on screen — and it is the worker naming the RPC it sent,
   * not the panel narrating what it hoped would happen. */
  const log = job.getByRole("log");
  await expect(log).toContainText(`service.restart ${UNIT}`);
  /* And the stored log was fetched, not just appended live: a cap
   * mismatch between the drawer and the API used to fail this silently. */
  await expect(job.getByText(/validation_failed|could not be loaded/)).toHaveCount(0);

  /* Back to the table: the unit's uptime was reset by the far end, and
   * the cache learned it from the agent's reply rather than from a
   * guess made when the button was clicked. */
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await expect
    .poll(async () => (await cellAt(row, activeSince).innerText()).trim(), {
      message: "the restarted unit's active-since never moved",
      timeout: 30_000,
    })
    .toMatch(/just now|^\d+s ago$/);
});
