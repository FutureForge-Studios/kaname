import { expect, test, type Locator, type Page } from "@playwright/test";
import { auditRows, owner, server } from "../support/secops.js";

/* ------------------------------------------------------------------ *
 * Monitoring — charts over a chosen range, and alert rules that really
 * fire and really resolve.
 *
 * The evaluator runs once a minute against raw samples the live agents
 * push, so the fire/resolve journey waits on the alert's own state as
 * the API reports it — up to a few ticks — never on a fixed delay.
 * ------------------------------------------------------------------ */

interface AlertRow {
  id: string;
  rule_name: string;
  server_name: string | null;
  state: string;
  acknowledged_by: string | null;
}

const TICKS = 4 * 60_000;

async function alertFor(rule: string): Promise<AlertRow | undefined> {
  const rows = await (await owner()).get<AlertRow[]>(
    `/monitoring/alerts?q=${encodeURIComponent(rule)}&per_page=20&sort=started_at&order=desc`,
  );
  return rows.find((row) => row.rule_name === rule);
}

async function rowMenu(page: Page, row: Locator, item: string): Promise<void> {
  await row.getByRole("button", { name: "Row actions" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.describe("monitoring", () => {
  test("charts follow the chosen range, and coarser ranges come from the rollup", async ({ page }) => {
    await page.goto("/monitoring");
    await expect(page.getByRole("heading", { level: 1, name: "Monitoring" })).toBeVisible();
    await expect(page.getByText(/4\/4 agents connected/)).toBeVisible();
    for (const title of ["CPU", "Memory used", "Disk, worst filesystem", "Network", "Load average, 1 minute"]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("radio", { name: "Last 24 hours" })).toHaveAttribute("aria-checked", "true");

    const hour = page.waitForResponse((r) => r.url().includes("/monitoring/series") && r.url().includes("range=1h"));
    await page.getByRole("radio", { name: "Last hour" }).click();
    const raw = (await (await hour).json()) as { data: { resolution: string; series: { points: unknown[] }[] } };
    expect(raw.data.resolution).toBe("raw");
    /* The last hour has live samples from the agents, not only seeded history. */
    expect(raw.data.series.some((s) => s.points.length > 0)).toBe(true);
    await expect(page).toHaveURL(/range=1h/);

    const week = page.waitForResponse((r) => r.url().includes("/monitoring/series") && r.url().includes("range=7d"));
    await page.getByRole("radio", { name: "Last 7 days" }).click();
    expect(((await (await week).json()) as { data: { resolution: string } }).data.resolution).toBe("5m");

    /* The range survives a reload, and the per-server table is there. */
    await page.reload();
    await expect(page.getByRole("radio", { name: "Last 7 days" })).toHaveAttribute("aria-checked", "true");
    const perServer = page.getByRole("table", { name: "Per-server metrics" });
    await expect(perServer.locator("tbody tr")).toHaveCount(4);

    /* A range the API does not know is refused, not silently defaulted. */
    const api = await owner();
    const bad = await api.call("GET", "/monitoring/series?metric=cpu&range=2y");
    expect(bad.status).toBe(422);
    const metric = await api.call("GET", "/monitoring/series?metric=temperature&range=1h");
    expect(metric.status).toBe(422);
  });

  test("an alert rule is validated before it is saved", async ({ page }) => {
    await page.goto("/monitoring?tab=rules");
    await page.getByRole("button", { name: "New rule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New alert rule" });
    await dialog.getByRole("textbox", { name: /^Name/ }).fill("e2e invalid rule");
    await dialog.getByLabel("Threshold").fill("90");
    await dialog.getByLabel("Duration").fill("-60");
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await expect(dialog.getByText("Number must be greater than or equal to 0")).toBeVisible();
    await expect(dialog).toBeVisible();

    const api = await owner();
    const noName = await api.call("POST", "/monitoring/alert-rules", {
      name: "",
      metric: "cpu",
      comparator: "gt",
      threshold: 90,
      duration_seconds: 60,
      severity: "warning",
      scope: { kind: "fleet" },
    });
    expect(noName.status).toBe(422);
    const noServers = await api.call("POST", "/monitoring/alert-rules", {
      name: "x",
      metric: "cpu",
      comparator: "gt",
      threshold: 90,
      duration_seconds: 60,
      severity: "warning",
      scope: { kind: "servers", server_ids: ["not-a-uuid"] },
    });
    expect(noServers.status).toBe(422);
    expect(Object.keys(noServers.error?.fields ?? {}).join(",")).toMatch(/scope/);
  });

  test("a rule fires on a sustained breach and resolves when it ends", async ({ page }) => {
    test.setTimeout(TICKS * 2 + 60_000);
    const forge = await server("forge-01");
    const name = "e2e cpu floor";

    /* Create it in the panel: CPU at or above 0% — always true — on one host. */
    await page.goto("/monitoring?tab=rules");
    await page.getByRole("button", { name: "New rule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New alert rule" });
    await dialog.getByRole("textbox", { name: /^Name/ }).fill(name);
    await dialog.getByLabel("Metric").selectOption("cpu");
    await dialog.getByLabel("Comparator").selectOption("gte");
    await dialog.getByLabel("Threshold").fill("0");
    await dialog.getByLabel("Duration").fill("0");
    await dialog.getByLabel("Severity").selectOption("critical");
    await dialog.getByLabel("Apply to the whole fleet").uncheck();
    await dialog.getByRole("combobox").click();
    await page.getByRole("option", { name: /forge-01/ }).click();
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Create rule" }).click();
    await expect(dialog).toBeHidden();
    const ruleRow = page.getByRole("table", { name: "Alert rules" }).locator("tbody tr").filter({ hasText: name });
    await expect(ruleRow).toContainText("forge-01");

    await expect
      .poll(async () => (await alertFor(name))?.state ?? "none", { timeout: TICKS, intervals: [5000] })
      .toBe("firing");
    const fired = (await alertFor(name))!;
    expect(fired.server_name).toBe("forge-01");

    await page.goto("/monitoring?tab=alerts");
    const alertRow = page.getByRole("table", { name: "Alerts" }).locator("tbody tr").filter({ hasText: name });
    await expect(alertRow).toContainText(/firing/i);
    await rowMenu(page, alertRow, "Acknowledge");
    await expect
      .poll(async () => (await alertFor(name))?.acknowledged_by ?? null)
      .not.toBeNull();

    /* Move the line out of reach: the next tick resolves it. */
    await page.goto("/monitoring?tab=rules");
    await rowMenu(page, ruleRow, "Edit");
    const edit = page.getByRole("dialog", { name: `Edit ${name}` });
    await edit.getByLabel("Threshold").fill("1000");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toBeHidden();

    await expect
      .poll(async () => (await alertFor(name))?.state, { timeout: TICKS, intervals: [5000] })
      .toBe("resolved");

    const actions = (await auditRows("alert_rule.", 5)).map((r) => r.action);
    expect(actions.slice(0, 2)).toEqual(["alert_rule.updated", "alert_rule.created"]);
    void forge;
  });
});
