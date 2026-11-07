import { expect, test, type Locator, type Page } from "@playwright/test";
import { missingId } from "../support/config.js";
import { auditRows, hostFile, owner, server, settled, type JobRow } from "../support/secops.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Backups — destination, schedule, run, restore point, verify,
 * restore, retention, and a run that fails.
 *
 * A backup that "succeeded" is only worth the snapshot it left behind,
 * so each step is asserted by what the next one can do with it: a run
 * leaves a restore point, the restore point verifies, the restore writes
 * onto the host, and retention takes old points away again.
 * ------------------------------------------------------------------ */

interface Destination {
  id: string;
  name: string;
  status: string;
}
interface Schedule {
  id: string;
  name: string;
  last_run_status: string | null;
}
interface Run {
  id: string;
  status: string;
  error: string | null;
  restore_point_id: string | null;
  job_id: string;
}
interface Point {
  id: string;
  label: string;
  run_id: string;
  verified_at: string | null;
  schedule_id: string;
}

const DIR = "/var/backups";

async function localDestination(name: string): Promise<Destination> {
  const api = await owner();
  const forge = await server("forge-01");
  const found = (await api.get<Destination[]>(`/backups/destinations?q=${encodeURIComponent(name)}`)).find(
    (d) => d.name === name,
  );
  if (found) return found;
  return api.ok<Destination>("POST", "/backups/destinations", {
    name,
    target: { kind: "local", server_id: forge.id, path: DIR },
  });
}

async function schedule(name: string, selectors: string[], keepLast = 2): Promise<Schedule> {
  const api = await owner();
  const forge = await server("forge-01");
  const destination = await localDestination("e2e local repository");
  return api.ok<Schedule>("POST", "/backups/schedules", {
    name,
    server_id: forge.id,
    destination_id: destination.id,
    scope: [{ kind: "files", selectors }],
    cron: "30 2 * * *",
    retention: { keep_last: keepLast, keep_daily: 0, keep_weekly: 0, keep_monthly: 0 },
  });
}

async function runNow(scheduleId: string): Promise<JobRow> {
  const api = await owner();
  const accepted = await api.ok<{ job: JobRow }>("POST", `/backups/schedules/${scheduleId}/run`);
  return settled(accepted.job.id, 90_000);
}

async function pointsFor(scheduleId: string): Promise<Point[]> {
  return (await owner()).get<Point[]>(
    `/backups/restore-points?schedule_id=${scheduleId}&per_page=50&sort=taken_at&order=desc`,
  );
}

async function rowMenu(page: Page, row: Locator, item: string): Promise<void> {
  await row.getByRole("button", { name: "Row actions" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

async function drawerSettles(page: Page, text: string): Promise<string> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const pill = jobStatusPill(drawer.getByRole("listitem").filter({ hasText: text }).first());
  await expect(pill).toHaveText(/Succeeded|Failed|Cancelled|Timed out/, { timeout: 90_000 });
  const status = (await pill.innerText()).trim();
  await page.keyboard.press("Escape");
  return status;
}

test.describe("backups", () => {
  test("a local repository is set up and tested from the panel", async ({ page }) => {
    await page.goto("/backups?tab=destinations&new=1");
    const dialog = page.getByRole("dialog", { name: "New backup destination" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: /^Name/ }).fill("e2e panel repository");
    await dialog.getByLabel("Kind").selectOption("local");
    await dialog.getByRole("combobox", { name: /^Server/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: /forge-01/ }).click();

    /* A relative path is refused by name. */
    await dialog.getByLabel("Directory").fill("var/backups");
    await dialog.getByRole("button", { name: "Create destination" }).click();
    await expect(dialog.getByText("must be an absolute path")).toBeVisible();

    /* A path that is not there is reported as unreachable, with the host's reason. */
    await dialog.getByLabel("Directory").fill("/nonexistent/e2e");
    await dialog.getByRole("button", { name: "Test connection" }).click();
    await expect(dialog.getByText("Not reachable", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/\/nonexistent\/e2e is not reachable on forge-01/)).toBeVisible();

    await dialog.getByLabel("Directory").fill(DIR);
    await dialog.getByRole("button", { name: "Test connection" }).click();
    await expect(dialog.getByText("Reachable", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Create destination" }).click();
    await expect(dialog).toBeHidden();

    const table = page.getByRole("table", { name: "Backup destinations" });
    const row = table.locator("tbody tr").filter({ hasText: "e2e panel repository" });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/untested/i);

    await rowMenu(page, row, "Test connection");
    await expect(row).toContainText(/reachable|ok/i);
    const api = await owner();
    const saved = (await api.get<Destination[]>("/backups/destinations?q=e2e%20panel")).find(
      (d) => d.name === "e2e panel repository",
    );
    expect(saved?.status).toBe("ok");

    /* Names are unique. */
    const forge = await server("forge-01");
    const again = await api.call("POST", "/backups/destinations", {
      name: "e2e panel repository",
      target: { kind: "local", server_id: forge.id, path: DIR },
    });
    expect(again.status).toBe(409);
    expect(again.error?.message).toBe('A backup destination named "e2e panel repository" already exists.');
  });

  test("a schedule's cron and retention are validated field by field", async ({ page }) => {
    await localDestination("e2e local repository");
    await page.goto("/backups?tab=schedules&new=1");
    const dialog = page.getByRole("dialog", { name: "New backup schedule" });
    await expect(dialog).toBeVisible();

    await dialog.getByRole("textbox", { name: /^Name/ }).fill("e2e invalid");
    await dialog.getByRole("combobox", { name: /^Server/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: /forge-01/ }).click();
    await dialog.getByRole("combobox", { name: /^Destination/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: /e2e local repository/ }).click();
    await dialog.getByLabel("Scope 1 selectors").fill("/etc");

    await dialog.getByLabel("Cron expression").fill("61 2 * * *");
    await expect(dialog.getByText("Unrecognised cron expression")).toBeVisible();
    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(dialog.getByText('"61": it must be between 0 and 59')).toBeVisible();

    await dialog.getByLabel("Cron expression").fill("0 0 30 2 *");
    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(dialog.getByText("matches no real date, e.g. February 30th")).toBeVisible();

    await dialog.getByLabel("Cron expression").fill("30 2 * * *");
    for (const field of ["Latest", "Daily", "Weekly", "Monthly"]) {
      await dialog.getByLabel(field, { exact: true }).fill("0");
    }
    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(dialog.getByText("retention must keep at least one snapshot")).toBeVisible();
    await expect(dialog).toBeVisible();

    /* The boundary itself is fine: keeping exactly one. */
    await dialog.getByLabel("Latest", { exact: true }).fill("1");
    await dialog.getByRole("button", { name: "Create schedule" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("table", { name: "Backup schedules" }).locator("tbody tr").filter({ hasText: "e2e invalid" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Keep 1");
  });

  test("run, restore point, verify and restore, end to end", async ({ page }) => {
    const forge = await server("forge-01");
    const plan = await schedule("e2e etc nightly", ["/etc"]);

    await page.goto("/backups?tab=schedules");
    const row = page.getByRole("table", { name: "Backup schedules" }).locator("tbody tr").filter({ hasText: "e2e etc nightly" });
    await rowMenu(page, row, "Run now");
    expect(await drawerSettles(page, "forge-01")).toContain("Succeeded");

    /* The run, the schedule and the restore point all agree. */
    const api = await owner();
    const runs = await api.get<Run[]>(`/backups/runs?schedule_id=${plan.id}`);
    expect(runs[0]?.status).toBe("succeeded");
    expect(runs[0]?.restore_point_id).toBeTruthy();
    await expect.poll(async () => (await api.get<Schedule>(`/backups/schedules/${plan.id}`)).last_run_status).toBe("succeeded");
    await page.reload();
    await expect(row).toContainText(/succeeded/i);

    const [point] = await pointsFor(plan.id);
    expect(point?.run_id).toBe(runs[0]!.id);

    await page.goto("/backups?tab=restore-points");
    const pointRow = page.getByRole("table", { name: "Restore points" }).locator("tbody tr").filter({ hasText: point!.label });
    await expect(pointRow).toContainText("unverified");
    await rowMenu(page, pointRow, "Verify");
    expect(await drawerSettles(page, point!.label)).toContain("Succeeded");
    await expect.poll(async () => (await api.get<Point>(`/backups/restore-points/${point!.id}`)).verified_at).not.toBeNull();
    await page.reload();
    await expect(pointRow).not.toContainText("unverified");

    /* Restore, the safe way: only gaps are filled. */
    await rowMenu(page, pointRow, "Restore…");
    const dialog = page.getByRole("dialog", { name: "Restore from a snapshot" });
    await expect(dialog).toContainText("Only files missing under");
    await dialog.getByLabel("Target directory").fill("/srv/e2e-restore");
    await dialog.getByLabel("Overwrite existing files").check();
    await expect(dialog).toContainText("will be replaced by the contents of this snapshot. There is no undo.");
    await dialog.getByLabel("Overwrite existing files").uncheck();
    const restore = dialog.getByRole("button", { name: "Restore" });
    await expect(restore).toBeDisabled();
    await dialog.getByRole("textbox").last().fill(point!.label);
    await restore.click();
    expect(await drawerSettles(page, "forge-01")).toContain("Succeeded");
    await expect.poll(() => hostFile(forge.id, "/srv/e2e-restore/etc/.restored-from")).toContain(`taken`);

    /* What was sent to the host is on record: no overwrite, this target. */
    const [requested] = await api.get<{ metadata: { params: { overwrite: boolean; target: string } } }[]>(
      "/audit?action=backup.restore.requested&per_page=1&sort=seq&order=desc",
    );
    expect(requested?.metadata.params).toMatchObject({ overwrite: false, target: "/srv/e2e-restore" });

    /* The label is retyped and checked against the row, not the browser. */
    const wrong = await api.call("POST", "/backups/restore", {
      restore_point_id: point!.id,
      target_server_id: forge.id,
      target_path: "/srv/x",
      confirm_label: "not-the-label",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.error?.fields?.["confirm_label"]).toBe(`must be exactly "${point!.label}"`);
    const relative = await api.call("POST", "/backups/restore", {
      restore_point_id: point!.id,
      target_server_id: forge.id,
      target_path: "srv/x",
      confirm_label: point!.label,
    });
    expect(relative.status).toBe(422);
    expect(relative.error?.fields?.["target_path"]).toBe("must be an absolute path");

    const audit = (await auditRows("backup.", 10)).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(["backup.run.requested", "backup.verify.requested", "backup.restore.requested"]));
  });

  test("retention prunes the oldest restore points after a run", async () => {
    const plan = await schedule("e2e retention", ["/etc/nginx"], 2);
    const first = await runNow(plan.id);
    expect(first.status, JSON.stringify(first.error)).toBe("succeeded");
    const [oldest] = await pointsFor(plan.id);
    expect(oldest).toBeTruthy();

    expect((await runNow(plan.id)).status).toBe("succeeded");
    expect(await pointsFor(plan.id)).toHaveLength(2);

    expect((await runNow(plan.id)).status).toBe("succeeded");
    const kept = await pointsFor(plan.id);
    expect(kept).toHaveLength(2);
    expect(kept.map((p) => p.id)).not.toContain(oldest!.id);

    const api = await owner();
    const gone = await api.call("GET", `/backups/restore-points/${oldest!.id}`);
    expect(gone.status).toBe(404);
  });

  test("a run that fails settles as failed everywhere, with the host's reason", async ({ page }) => {
    const plan = await schedule("e2e broken path", ["/nonexistent/e2e-data"]);
    const job = await runNow(plan.id);
    expect(job.status).toBe("failed");
    expect(job.error?.message).toMatch(/nonexistent/);

    const api = await owner();
    const [run] = await api.get<Run[]>(`/backups/runs?schedule_id=${plan.id}`);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/nonexistent/);
    expect(run?.restore_point_id).toBeNull();
    expect(await pointsFor(plan.id)).toHaveLength(0);
    expect((await api.get<Schedule>(`/backups/schedules/${plan.id}`)).last_run_status).toBe("failed");

    await page.goto("/backups?tab=runs");
    const row = page.getByRole("table", { name: "Backup runs" }).locator("tbody tr").filter({ hasText: "e2e broken path" }).first();
    await expect(row).toContainText(/failed/i);
    await expect(row).toContainText(/nonexistent/);

    await page.goto("/backups?tab=schedules");
    await page.getByLabel("Filter by last run").selectOption("failed");
    await expect(page.getByRole("table", { name: "Backup schedules" }).locator("tbody tr").filter({ hasText: "e2e broken path" })).toBeVisible();
  });

  test("not-found deep links and ids are reported specifically", async ({ page }) => {
    await page.goto(`/backups/${missingId}`);
    const error = page.getByRole("alert").filter({ hasText: "not_found" });
    await expect(error).toBeVisible();
    await expect(error).toContainText(missingId);

    const api = await owner();
    for (const path of [
      `/backups/schedules/${missingId}`,
      `/backups/runs/${missingId}`,
      `/backups/restore-points/${missingId}`,
      `/backups/destinations/${missingId}`,
    ]) {
      const res = await api.call("GET", path);
      expect(res.status, path).toBe(404);
    }
    const run = await api.call("POST", `/backups/schedules/${missingId}/run`);
    expect(run.status).toBe(404);
  });
});
