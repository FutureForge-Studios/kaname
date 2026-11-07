import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import { jobStatusPill, sectionNamed } from "../support/ui.js";
import {
  agentPids,
  call,
  killAgent,
  ownerCall,
  server,
  service,
  settledJob,
  signedInAs,
  startAgent,
  tableRow,
  waitForConnection,
  type JobRow,
} from "../support/fleet.js";

/* ------------------------------------------------------------------ *
 * Jobs, the Command Center and the command palette — the three places
 * an operator finds out what happened and starts the next thing.
 *
 * The job rules (KD-008) that matter to someone watching the drawer:
 * a job for a host that is down waits, says why it is waiting, does not
 * spend an attempt doing so, and runs by itself when the host returns;
 * a waiting job can be cancelled and then never runs. The palette
 * (PLAN.md 6) has to land an action on the surface that does it, with
 * the row already found.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const HOST = "edge-01";

test.afterAll(() => {
  if (agentPids(HOST).length === 0) startAgent(HOST);
});

test("a job for a host that is down waits, says why, and runs when it returns", async ({
  page,
}) => {
  const edge = await server(HOST);
  killAgent(HOST);
  await waitForConnection(HOST, "disconnected");

  /* Queue a restart through the table, as an operator would. */
  await page.goto(`/infrastructure/services?server_id=${edge.id}&q=cron.service`);
  const row = tableRow(page.getByRole("table", { name: "Services" }), "cron.service").first();
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Restart", exact: true }).click();

  const drawer = page.getByRole("dialog", { name: "Job activity" });
  const item = drawer
    .getByRole("listitem")
    .filter({ hasText: "Restart service" })
    .filter({ hasText: HOST })
    .first();
  const pill = jobStatusPill(item);
  /* Queued, and the pill says it is the host it waits for. */
  await expect(pill).toContainText("Queued");
  await expect(pill).toContainText("agent offline");

  /* A second one, cancelled while it waits, must never run. */
  const stop = await service(HOST, "rsyslog.service");
  const { job: doomed } = await ownerCall<{ job: JobRow }>(
    "POST",
    `/services/${stop.id}/stop`,
    {},
  );
  await drawer.getByRole("button", { name: "Refresh" }).click();
  const doomedItem = drawer
    .getByRole("listitem")
    .filter({ hasText: "Stop service" })
    .filter({ hasText: "rsyslog.service" })
    .first();
  await doomedItem.getByRole("button", { name: "Cancel" }).click();
  await expect(jobStatusPill(doomedItem)).toContainText("Cancelled");

  /* The host comes back; the waiting job runs on its own. */
  startAgent(HOST);
  await expect(pill).toContainText("Succeeded", { timeout: 90_000 });

  const jobs = await ownerCall<JobRow[]>(
    "GET",
    `/jobs?server_id=${edge.id}&type=service.restart&per_page=5`,
  );
  /* Waiting did not cost it an attempt. */
  expect(jobs[0]!.status).toBe("succeeded");
  expect(jobs[0]!.attempt).toBe(1);
  expect(jobs[0]!.blocked_reason).toBeNull();

  /* And the cancelled one stayed cancelled: rsyslog is still running. */
  expect((await settledJob(doomed.id)).status).toBe("cancelled");
  expect((await service(HOST, "rsyslog.service")).active_state).toBe("active");
});

test("a job has an address: the drawer's details link survives a reload", async ({ page }) => {
  const cron = await service(HOST, "cron.service");
  const { job } = await ownerCall<{ job: JobRow }>("POST", `/services/${cron.id}/restart`, {});
  await settledJob(job.id);

  await page.goto("/");
  await page.getByRole("button", { name: /^Job activity/ }).click();
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  const item = drawer.getByRole("listitem").filter({ hasText: "Restart service" }).first();
  await expect(item).toBeVisible();

  /* Expanding shows the stored log, fetched from the API. */
  await item.getByRole("button", { name: "Show job log" }).click();
  await expect(item.getByRole("log", { name: "Job log" })).toContainText("service.restart");

  await item.getByRole("link", { name: "Details" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}$/);
  await expect(drawer).toBeHidden();
  await page.reload();
  await expect(jobStatusPill(page.getByRole("heading", { level: 1 }))).toContainText("Succeeded");
  await expect(page.getByText(/started by Owner/)).toBeVisible();

  /* Back returns to where the operator was. */
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/$/);

  /* A job id that does not exist is reported as such. */
  await page.goto(`/jobs/${missingId}`);
  await expect(page.getByRole("alert").filter({ hasText: "not_found" })).toBeVisible();
});

test("the Command Center's numbers are the fleet's numbers", async ({ page }) => {
  const fleet = await ownerCall<{ connection: string; health: string }[]>(
    "GET",
    "/servers?per_page=100",
  );
  const connected = fleet.filter((s) => s.connection === "connected").length;

  await page.goto("/");
  await expect(
    page.getByText(`${connected}/${fleet.length} agents connected`, { exact: true }),
  ).toBeVisible();

  /* A failed-unit item goes to that host's failed units, already filtered. */
  const item = sectionNamed(page, "Needs attention")
    .getByRole("link")
    .filter({ hasText: /failed unit on db-01/ })
    .first();
  await item.click();
  const db = await server("db-01");
  await expect(page).toHaveURL(
    new RegExp(`/infrastructure/services\\?server_id=${db.id}&active_state=failed`),
  );
  const table = page.getByRole("table", { name: "Services" });
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(tableRow(table, "clamav-freshclam.service")).toBeVisible();
});

test("the palette finds units and containers, and its actions land on the row", async ({
  page,
}) => {
  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("table", { name: "Servers" })).toBeVisible();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const input = palette.getByRole("combobox", { name: "Search and commands" });

  /* A unit, by name, across the fleet. */
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("clamav");
  await expect(palette.getByRole("option", { name: /clamav-freshclam\.service/ }).first()).toBeVisible();

  /* A container, with a verb against it. */
  await input.fill("uptime-kuma");
  await expect(
    palette
      .getByRole("group", { name: "Actions" })
      .getByRole("option", { name: /Restart uptime-kuma on/ })
      .first(),
  ).toBeVisible();

  /* "Restart nginx on edge-01" lands on edge-01's units with nginx
   * already found, not on all of them. */
  await input.fill("edge-01");
  await palette.getByRole("option", { name: /Restart nginx on edge-01/ }).click();
  await expect(palette).toBeHidden();
  const edge = await server(HOST);
  await expect(page).toHaveURL(new RegExp(`server_id=${edge.id}`));
  const table = page.getByRole("table", { name: "Services" });
  await expect(tableRow(table, "nginx.service")).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(1);

  /* Built-in commands run, too: "Add a server" opens the dialog. */
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("add a server");
  await palette.getByRole("option", { name: /Add a server/ }).click();
  await expect(page.getByRole("dialog", { name: "Add server" })).toBeVisible();
});

test("a search with no hits says so instead of going blank", async ({ page }) => {
  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("table", { name: "Servers" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search and commands" }).fill("zzzz-nothing-zzzz");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await expect(palette.getByText("Nothing matches “zzzz-nothing-zzzz”.")).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * KD-037: the job's creator may cancel it. A Developer can restart a
 * unit, so they can take that restart back; somebody else's job still
 * needs infra.servers:write, and the drawer only offers what the API
 * would accept.
 * ------------------------------------------------------------------ */

test("a developer cancels the restart they started, and only that one", async ({ browser }) => {
  const edge = await server(HOST);
  killAgent(HOST);
  await waitForConnection(HOST, "disconnected");

  const context = await signedInAs(browser, "developer");
  try {
    const cron = await service(HOST, "cron.service");
    /* Both wait for the host, so both are still cancellable. */
    const mine = await call<{ job: JobRow }>(
      context.request,
      "POST",
      `/services/${cron.id}/restart`,
      {},
    );
    expect(mine.status).toBe(202);
    const { job: theirs } = await ownerCall<{ job: JobRow }>(
      "POST",
      `/services/${cron.id}/reload`,
      {},
    );

    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: /^Job activity/ }).click();
    const drawer = page.getByRole("dialog", { name: "Job activity" });
    const ownItem = drawer
      .getByRole("listitem")
      .filter({ hasText: "Restart service" })
      .filter({ hasText: HOST })
      .first();
    const otherItem = drawer
      .getByRole("listitem")
      .filter({ hasText: "Reload service" })
      .filter({ hasText: HOST })
      .first();
    await expect(otherItem.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await ownItem.getByRole("button", { name: "Cancel" }).click();
    await expect(jobStatusPill(ownItem)).toContainText("Cancelled");
    expect((await settledJob(mine.data.job.id)).status).toBe("cancelled");

    /* The API holds the same line for the job that is not theirs. */
    const refused = await call(context.request, "POST", `/jobs/${theirs.id}/cancel`, {});
    expect(refused.status).toBe(403);
    expect(refused.error?.message).toContain("infra.servers:write");
    await ownerCall("POST", `/jobs/${theirs.id}/cancel`, {});
  } finally {
    await context.close();
    startAgent(HOST);
    await waitForConnection(HOST, "connected");
  }
  expect((await server(HOST)).id).toBe(edge.id);
});

/* ------------------------------------------------------------------ *
 * The shared DataTable toolbar. Backups › Schedules carries a search
 * and five filters (six with Clear filters); at 1440px it used to wrap
 * into a second row that the card's fixed 40px bar clipped, search row
 * and all. Every control must be inside the bar, on screen, and the
 * thing actually painted at its own centre — which is what "not
 * clipped" means to someone looking at it. Screenshots are kept at
 * deviceScaleFactor 1 for a person to check the same thing.
 * ------------------------------------------------------------------ */

test.describe("a toolbar with many filters", () => {
  test.use({ deviceScaleFactor: 1 });

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 1366, height: 900 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`wraps cleanly with nothing clipped at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      /* A filter in the URL adds "Clear filters", the widest the bar gets. */
      await page.goto("/backups?enabled=true");
      const search = page.getByLabel("Search backup schedules");
      await expect(search).toBeVisible();
      await expect(page.getByLabel("Filter by state")).toHaveValue("true");
      await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();

      const report = await page.evaluate(() => {
        const table = document.querySelector('table[aria-label="Backup schedules"]');
        const card = table?.closest(".overflow-hidden");
        const bar = card?.firstElementChild as HTMLElement | null | undefined;
        if (!bar) return { error: "no toolbar" };
        const box = bar.getBoundingClientRect();
        const problems: string[] = [];
        const controls = [...bar.querySelectorAll<HTMLElement>("input, select, button")];
        for (const control of controls) {
          control.scrollIntoView({ block: "center", inline: "nearest" });
          const r = control.getBoundingClientRect();
          const b = bar.getBoundingClientRect();
          const name =
            control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName;
          if (r.width === 0 || r.height === 0) problems.push(`${name}: not rendered`);
          if (r.left < b.left - 0.5 || r.right > b.right + 0.5) {
            problems.push(`${name}: past the bar's sides`);
          }
          if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
            problems.push(`${name}: past the bar's edge`);
          }
          if (r.right > window.innerWidth + 0.5) problems.push(`${name}: off screen`);
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const painted =
            hit !== null &&
            (hit === control ||
              control.contains(hit) ||
              hit.contains(control) ||
              (control.parentElement?.contains(hit) ?? false));
          if (!painted) problems.push(`${name}: covered or clipped`);
        }
        window.scrollTo(0, 0);
        return {
          problems,
          controls: controls.length,
          rows: Math.round(box.height),
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
      });

      await page.screenshot({
        path: testInfo.outputPath(`backups-toolbar-${viewport.width}.png`),
        fullPage: false,
      });
      expect(report.error).toBeUndefined();
      /* Search, five filters, Clear filters, Refresh — at least. */
      expect(report.controls).toBeGreaterThanOrEqual(8);
      expect(report.problems).toEqual([]);
      expect(report.overflowX, "the page scrolls sideways").toBe(false);
    });
  }
});
