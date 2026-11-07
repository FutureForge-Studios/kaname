import { expect, test, type Page } from "@playwright/test";
import { owner, server, settled, type JobRow } from "../support/secops.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Threat protection — observations, bans and unbans.
 *
 * A ban is a firewall change on a host, so it is a job, and the row's
 * disposition only means something once that job has come back from
 * the agent. Ignore is the opposite: Kaname-only, said out loud.
 * ------------------------------------------------------------------ */

interface Threat {
  id: string;
  source_ip: string;
  server_name: string;
  disposition: string;
}

async function threatRow(page: Page, ip: string) {
  await page.getByPlaceholder("Search address, target or kind").fill(ip);
  const table = page.getByRole("table", { name: "Threat events" });
  const row = table.locator("tbody tr").filter({ hasText: ip }).first();
  await expect(row).toBeVisible();
  return row;
}

async function rowAction(page: Page, row: ReturnType<Page["locator"]>, action: string) {
  await row.getByRole("button", { name: "Row actions" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function drawerJobs(page: Page, count: number): Promise<void> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const pills = jobStatusPill(drawer.getByRole("listitem"));
  await expect(pills.first()).toBeVisible();
  await expect
    .poll(async () => (await pills.allInnerTexts()).filter((t) => t.includes("Succeeded")).length, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(count);
  await page.keyboard.press("Escape");
}

async function disposition(ip: string, serverName: string): Promise<string | undefined> {
  const rows = await (await owner()).get<Threat[]>(`/threats?q=${ip}&per_page=50`);
  return rows.find((r) => r.source_ip === ip && r.server_name === serverName)?.disposition;
}

test.describe("threat protection", () => {
  test("the summary and the log follow the chosen window and filters", async ({ page }) => {
    await page.goto("/security/threats");
    await expect(page.getByRole("heading", { level: 1, name: "Threat protection" })).toBeVisible();
    await expect(page.getByText("Attempts, last 24h")).toBeVisible();
    const table = page.getByRole("table", { name: "Threat events" });
    await expect(table.locator("tbody tr").first()).toBeVisible();

    /* Observations from the live agents land beside the seeded ones. */
    await expect
      .poll(async () => (await (await owner()).get<Threat[]>("/threats?q=203.0.113&per_page=5")).length, {
        timeout: 60_000,
      })
      .toBeGreaterThan(0);

    await page.getByRole("radio", { name: "Last 7 days" }).click();
    await expect(page.getByText("Attempts, last 7d")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Last 7 days" })).toHaveAttribute("aria-checked", "true");

    await page.getByLabel("Disposition").selectOption("banned");
    await expect
      .poll(async () => {
        const rows = await table.locator("tbody tr").allInnerTexts();
        return rows.length > 0 && rows.every((text) => text.includes("banned"));
      })
      .toBe(true);

    await page.getByPlaceholder("Search address, target or kind").fill("198.18.255.254");
    await expect(page.getByText("Nothing in this list matches the current search and filters.")).toBeVisible();
  });

  test("an address is banned on one host and then unbanned, each as a job", async ({ page }) => {
    const forge = await server("forge-01");
    const ip = "212.70.149.83";
    expect(await disposition(ip, "forge-01")).toBe("observed");

    await page.goto(`/security/threats?server_id=${forge.id}`);
    let row = await threatRow(page, ip);
    await expect(row).toContainText("observed");

    await rowAction(page, row, "Ban this address");
    const dialog = page.getByRole("dialog", { name: `Ban ${ip}` });
    await expect(dialog).toContainText("Applied on forge-01.");
    const reason = dialog.getByLabel("Reason");
    await expect(reason).toHaveValue(/failed attempts$/);

    /* A ban without a reason cannot be sent: the reason is the audit record. */
    await reason.fill("   ");
    await expect(dialog.getByRole("button", { name: "Ban" })).toBeDisabled();
    await reason.fill("e2e: repeated SMTP auth failures");
    await dialog.getByLabel("Duration").selectOption("3600");
    await dialog.getByRole("button", { name: "Ban" }).click();
    await drawerJobs(page, 1);

    await expect.poll(() => disposition(ip, "forge-01")).toBe("banned");
    row = await threatRow(page, ip);
    await expect(row).toContainText("banned");

    const api = await owner();
    // The disposition flips when the ban is requested, so the job is what
    // proves the host did it.
    const bans = await api.get<JobRow[]>(`/jobs?server_id=${forge.id}&type=fw.ban&per_page=1`);
    const banned = await settled(bans[0]!.id);
    expect(banned.status, JSON.stringify(banned.error)).toBe("succeeded");

    await rowAction(page, row, "Unban this address");
    await page.getByRole("dialog", { name: `Unban ${ip}` }).getByRole("button", { name: "Unban" }).click();
    await expect(page.getByRole("dialog", { name: "Job activity" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => disposition(ip, "forge-01")).toBe("observed");
    const unbans = await api.get<JobRow[]>(`/jobs?server_id=${forge.id}&type=fw.unban&per_page=1`);
    const unbanned = await settled(unbans[0]!.id);
    expect(unbanned.status, JSON.stringify(unbanned.error)).toBe("succeeded");
  });

  test("a fleet-wide ban fans out to every host in scope", async ({ page }) => {
    const ip = "80.94.95.226";
    await page.goto("/security/threats");
    const row = await threatRow(page, ip);
    await rowAction(page, row, "Ban this address");
    const dialog = page.getByRole("dialog", { name: `Ban ${ip}` });
    await expect(dialog).toContainText("Applied on every server in your scope.");
    await dialog.getByRole("button", { name: "Ban" }).click();
    await drawerJobs(page, 4);

    const api = await owner();
    const jobs = await api.get<JobRow[]>(`/jobs?type=fw.ban&per_page=10`);
    const fan = jobs.filter((job) => (job as unknown as { target_label: string }).target_label.startsWith(`${ip}/32 on `));
    expect(fan).toHaveLength(4);
    for (const job of fan) expect((await settled(job.id)).status).toBe("succeeded");
    await expect.poll(() => disposition(ip, "mail-01")).toBe("banned");

    /* And back, fleet-wide. */
    const unban = await api.call<{ jobs: JobRow[] }>("POST", `/threats/${ip}/unban`, {});
    expect(unban.status).toBe(202);
    expect(unban.data.jobs).toHaveLength(4);
    for (const job of unban.data.jobs) {
      const done = await settled(job.id);
      expect(done.status, JSON.stringify(done.error)).toBe("succeeded");
    }
  });

  test("a range can be banned and unbanned, and malformed targets are refused", async () => {
    const api = await owner();
    const forge = await server("forge-01");
    const range = "198.51.100.0/24";

    const ban = await api.call<{ jobs: JobRow[] }>(
      "POST",
      `/threats/${encodeURIComponent(range)}/ban`,
      { server_id: forge.id, reason: "e2e: documentation range", duration_seconds: 600 },
    );
    expect(ban.status, JSON.stringify(ban.error)).toBe(202);
    expect((await settled(ban.data.jobs[0]!.id)).status).toBe("succeeded");
    const label = (ban.data.jobs[0] as unknown as { target_label: string }).target_label;
    expect(label).toBe(`${range} on forge-01`);

    /* Every observed address inside the range is marked, nothing outside it. */
    const inside = await api.get<Threat[]>(`/threats?server_id=${forge.id}&q=198.51.100.&per_page=50`);
    for (const row of inside) expect(row.disposition, row.source_ip).toBe("banned");

    const unban = await api.call<{ jobs: JobRow[] }>(
      "POST",
      `/threats/${encodeURIComponent(range)}/unban`,
      { server_id: forge.id },
    );
    expect(unban.status).toBe(202);
    const done = await settled(unban.data.jobs[0]!.id);
    expect(done.status, JSON.stringify(done.error)).toBe("succeeded");

    for (const bad of ["not-an-ip", "10.0.0.0%2F33", "300.1.2.3"]) {
      const refused = await api.call("POST", `/threats/${bad}/ban`, { reason: "x" });
      expect(refused.status, bad).toBe(422);
      expect(refused.error?.fields?.["ip"], bad).toBeTruthy();
    }
    const noReason = await api.call("POST", "/threats/192.0.2.1/ban", { reason: "" });
    expect(noReason.status).toBe(422);
    expect(noReason.error?.fields?.["reason"]).toBeTruthy();
    const tooLong = await api.call("POST", "/threats/192.0.2.1/ban", {
      reason: "x",
      duration_seconds: 31536001,
    });
    expect(tooLong.status).toBe(422);
    expect(tooLong.error?.fields?.["duration_seconds"]).toBeTruthy();
  });

  test("ignoring an address changes Kaname only, and says so", async ({ page }) => {
    const mail = await server("mail-01");
    const ip = "103.156.91.14";
    await page.goto(`/security/threats?server_id=${mail.id}`);
    const row = await threatRow(page, ip);
    await rowAction(page, row, "Ignore in Kaname");
    const dialog = page.getByRole("dialog", { name: `Ignore ${ip}` });
    await expect(dialog).toContainText("This changes nothing on the host.");
    await dialog.getByRole("button", { name: "Ignore" }).click();
    await expect(page.getByText("Ignored in Kaname only. The host still sees this traffic and the firewall is unchanged.")).toBeVisible();
    await expect.poll(() => disposition(ip, "mail-01")).toBe("ignored");

    /* No job: nothing went to the host. */
    const api = await owner();
    const jobs = await api.get<{ target_label: string }[]>(`/jobs?server_id=${mail.id}&per_page=50`);
    expect(jobs.filter((j) => j.target_label?.startsWith(ip))).toHaveLength(0);
  });
});
