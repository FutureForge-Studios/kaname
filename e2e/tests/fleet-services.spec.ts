import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import { sectionNamed, cellAt, columnIndex, jobStatusPill } from "../support/ui.js";
import {
  drawerJob,
  job,
  openRowActions,
  ownerCall,
  server,
  service,
  serviceVerb,
  settledJob,
  tableRow,
  type JobRow,
} from "../support/fleet.js";

/* ------------------------------------------------------------------ *
 * Services: every verb is a job, and the row is the proof.
 *
 * KD-008 says a host-touching mutation answers 202 and a job, and the
 * table is a cache of what the agent last reported (KD-012). So each
 * verb here is asserted twice over: its job reaches a terminal state,
 * and the cached row changes to what the host now says — which can only
 * happen because the agent's answer came back through the reconciler.
 *
 * The unit under test is redis-server.service on db-01, which ships
 * stopped and disabled, so the whole start/enable/stop/disable cycle
 * runs on a unit nothing else in the suite cares about, and ends where
 * it began.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const HOST = "db-01";
const UNIT = "redis-server.service";

test.afterAll(async () => {
  // Leave the seeded state for anyone after: stopped and disabled.
  const row = await service(HOST, UNIT);
  if (row.active_state !== "inactive") await serviceVerb(HOST, UNIT, "stop");
  if (row.enabled) await serviceVerb(HOST, UNIT, "disable");
});

test("failed-only narrows the fleet to units that really failed, on every host", async ({
  page,
}) => {
  await page.goto("/infrastructure/services");
  const table = page.getByRole("table", { name: "Services" });
  await expect(table.locator("tbody tr").first()).toBeVisible();

  const failedOnly = page.getByRole("switch", { name: "Failed only" });
  await failedOnly.click();
  await expect(page).toHaveURL(/active_state=failed/);
  await expect(failedOnly).toBeChecked();

  const state = await columnIndex(table, "State");
  const serverCol = await columnIndex(table, "Server");
  /* Each simulated host ships one failed unit; none is green. */
  const fleet = await ownerCall<{ name: string }[]>("GET", "/servers?per_page=100");
  await expect(table.locator("tbody tr")).toHaveCount(fleet.length);
  for (const text of await table.locator(`tbody tr td:nth-child(${state + 1})`).allInnerTexts()) {
    expect(text).toContain("failed");
  }
  const hosts = await table.locator(`tbody tr td:nth-child(${serverCol + 1})`).allInnerTexts();
  expect(hosts.map((h) => h.trim()).sort()).toEqual(fleet.map((s) => s.name).sort());

  /* The state select is driven by the switch, not fighting it. */
  await expect(page.getByLabel("Filter by unit state")).toBeDisabled();

  /* Narrowing by host keeps the filter: one failed unit on db-01. */
  const db = await server(HOST);
  await page.goto(`/infrastructure/services?server_id=${db.id}&active_state=failed`);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(tableRow(table, "clamav-freshclam.service")).toBeVisible();
  /* On one host the Server column has nothing to say, so it is gone. */
  const headers = await table.locator("thead th").allInnerTexts();
  expect(headers.map((h) => h.trim())).not.toContain("Server");
});

test("start, enable, stop and disable each land as a job and change the row", async ({ page }) => {
  const db = await server(HOST);
  await page.goto(`/infrastructure/services?server_id=${db.id}`);
  await page.getByLabel("Search services").fill(UNIT);
  const table = page.getByRole("table", { name: "Services" });
  const row = tableRow(table, UNIT).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("inactive");

  const state = await columnIndex(table, "State");
  const atBoot = await columnIndex(table, "At boot");

  /* What cannot apply to a stopped, disabled unit is not offered. */
  let menu = await openRowActions(page, row);
  await expect(menu.getByRole("menuitem", { name: "Stop", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Reload", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Disable at boot" })).toBeDisabled();

  /* Start: no confirmation for a verb that brings something up. */
  await menu.getByRole("menuitem", { name: "Start", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /^Start / })).toHaveCount(0);
  const started = drawerJob(page, "Start service");
  await expect(started).toContainText(UNIT);
  await expect(jobStatusPill(started)).toContainText("Succeeded", { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(cellAt(row, state)).toContainText("active", { timeout: 30_000 });
  await expect(cellAt(row, state)).not.toContainText("inactive");

  /* Enable at boot. */
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Enable at boot" }).click();
  await expect(jobStatusPill(drawerJob(page, "Enable service"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(cellAt(row, atBoot)).toHaveText("enabled", { timeout: 30_000 });

  /* Stop takes something down, so it is confirmed first — and the
   * confirmation names the host it runs on. */
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Stop", exact: true }).click();
  const confirmStop = page.getByRole("dialog", { name: `Stop ${UNIT}?` });
  await expect(confirmStop).toContainText(`runs as a job on ${HOST}`);
  /* Cancelling really does nothing. */
  await confirmStop.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmStop).toBeHidden();
  await expect(cellAt(row, state)).not.toContainText("inactive");

  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Stop", exact: true }).click();
  await confirmStop.getByRole("button", { name: "Stop" }).click();
  await expect(jobStatusPill(drawerJob(page, "Stop service"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(cellAt(row, state)).toContainText("inactive", { timeout: 30_000 });

  /* Disable at boot is also confirmed: it is "not running" after a boot. */
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Disable at boot" }).click();
  await page
    .getByRole("dialog", { name: `Disable at boot ${UNIT}?` })
    .getByRole("button", { name: "Disable at boot" })
    .click();
  await expect(jobStatusPill(drawerJob(page, "Disable service"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(cellAt(row, atBoot)).toHaveText("disabled", { timeout: 30_000 });

  /* And the host agrees, not just the cache the page read. */
  const fresh = await service(HOST, UNIT);
  expect(fresh.active_state).toBe("inactive");
  expect(fresh.enabled).toBe(false);
});

test("a verb the host refuses fails with the host's reason and is not retried", async ({
  page,
}) => {
  /* The UI will not offer reload on a stopped unit, but a stale cache
   * or another client can still ask; the host is the one that refuses. */
  const row = await service(HOST, UNIT);
  expect(row.active_state).toBe("inactive");
  const { job: queued } = await ownerCall<{ job: JobRow }>(
    "POST",
    `/services/${row.id}/reload`,
    {},
  );
  const failed = await settledJob(queued.id);
  expect(failed.status).toBe("failed");
  expect(failed.error?.code).toBe("precondition_failed");
  /* A refusal is not transient: one attempt, no automatic second. */
  expect(failed.attempt).toBe(1);

  await page.goto(`/jobs/${queued.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Reload service");
  await expect(jobStatusPill(page.getByRole("heading", { level: 1 }))).toContainText("Failed");
  await expect(page.getByText("precondition_failed").first()).toBeVisible();
  await expect(page.getByText(`unit ${UNIT} is not running`).first()).toBeVisible();
  /* The log is the worker's own record, including the RPC it sent. */
  await expect(page.getByRole("log").first()).toContainText(`service.reload ${UNIT}`);

  /* The failure is something that needs attention, and links back here. */
  await page.goto("/");
  const item = sectionNamed(page, "Needs attention")
    .getByRole("link")
    .filter({ hasText: `Reload service failed on ${HOST}` });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("href", `/jobs/${queued.id}`);

  /* Still failed, still one attempt: nothing retried it behind our back. */
  const later = await job(queued.id);
  expect(later.status).toBe("failed");
  expect(later.attempt).toBe(1);
});

test("the unit page follows the journal and restarts from its header", async ({ page }) => {
  const cron = await service(HOST, "cron.service");
  await page.goto(`/infrastructure/services/${cron.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "cron.service" })).toBeVisible();

  /* The journal is read live from the host, so lines arrive. */
  const journal = page.getByRole("log", { name: "Journal for cron.service" });
  await expect(journal).toBeVisible();
  await expect
    .poll(async () => (await journal.innerText()).trim().length, {
      message: "the journal stayed empty",
    })
    .toBeGreaterThan(0);

  const before = (await service(HOST, "cron.service")).main_pid;
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  const restarted = drawerJob(page, "Restart service");
  await expect(jobStatusPill(restarted)).toContainText("Succeeded", { timeout: 60_000 });

  /* A restart gives the unit a new main process. */
  await expect
    .poll(async () => (await service(HOST, "cron.service")).main_pid, { timeout: 30_000 })
    .not.toBe(before);
});

test("a bulk restart confirms the exact units and runs one job each", async ({ page }) => {
  const db = await server(HOST);
  await page.goto(`/infrastructure/services?server_id=${db.id}`);
  const table = page.getByRole("table", { name: "Services" });
  await page.getByLabel("Search services").fill("systemd-time");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Search services").fill("rsyslog");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Search services").fill("");

  const targets = ["cron.service", "rsyslog.service"];
  for (const unit of targets) {
    await tableRow(table, unit).first().getByRole("checkbox", { name: "Select row" }).check();
  }
  const started = new Date().toISOString();
  await page.getByRole("button", { name: "Restart", exact: true }).click();

  const confirm = page.getByRole("dialog", { name: "Restart 2 units?" });
  for (const unit of targets) await expect(confirm).toContainText(`${HOST} · ${unit}`);
  await confirm.getByRole("button", { name: "Restart" }).click();

  /* One job per unit, under one correlation, both succeeded. */
  await expect
    .poll(
      async () => {
        const jobs = await ownerCall<(JobRow & { target_label: string; created_at: string })[]>(
          "GET",
          `/jobs?type=service.restart&server_id=${db.id}&per_page=20`,
        );
        return jobs
          .filter((j) => j.created_at >= started && j.status === "succeeded")
          .map((j) => j.target_label)
          .sort();
      },
      { message: "the bulk restart did not produce two succeeded jobs", timeout: 60_000 },
    )
    .toEqual(targets);
});

test("a unit that is not there is reported as missing, by id", async ({ page }) => {
  await page.goto(`/infrastructure/services/${missingId}`);
  const error = page.getByRole("alert").filter({ hasText: "not_found" });
  await expect(error).toBeVisible();
  await expect(error).toContainText(missingId);
});
