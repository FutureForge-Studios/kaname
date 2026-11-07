import { expect, test, type Page } from "@playwright/test";
import { owner, server, settled, startAgent, stopAgent, type JobRow } from "../support/secops.js";
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
  disposition_error: string | null;
}

interface BanRow {
  id: string;
  cidr: string;
  server_id: string | null;
  server_name: string | null;
  reason: string;
  expires_at: string | null;
}

async function bans(query = ""): Promise<BanRow[]> {
  return (await owner()).get<BanRow[]>(`/threats/bans?per_page=100${query}`);
}

/** Waits for the agent's own feed to have put an observed source on a host. */
async function observedOn(serverId: string): Promise<Threat> {
  let found: Threat | undefined;
  await expect
    .poll(
      async () => {
        const rows = await (await owner()).get<Threat[]>(
          `/threats?server_id=${serverId}&disposition=observed&per_page=50`,
        );
        found = rows[0];
        return Boolean(found);
      },
      { timeout: 120_000, message: "the simulated agent never reported a threat on this host" },
    )
    .toBe(true);
  return found!;
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
    // "banned" is only written by the succeeded job, so the job and the
    // disposition must agree.
    const banJobs = await api.get<JobRow[]>(`/jobs?server_id=${forge.id}&type=fw.ban&per_page=1`);
    const banned = await settled(banJobs[0]!.id);
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
    /* One active ban per host, as the Bans view will list them. */
    expect((await bans(`&q=${ip}`)).filter((b) => b.cidr === `${ip}/32`)).toHaveLength(4);

    /* And back, fleet-wide. */
    const unban = await api.call<{ jobs: JobRow[] }>("POST", `/threats/${ip}/unban`, {});
    expect(unban.status).toBe(202);
    expect(unban.data.jobs).toHaveLength(4);
    for (const job of unban.data.jobs) {
      const done = await settled(job.id);
      expect(done.status, JSON.stringify(done.error)).toBe("succeeded");
    }
    expect((await bans(`&q=${ip}`)).filter((b) => b.cidr === `${ip}/32`)).toHaveLength(0);
  });

  test("a ban is pending while its job waits for the host, and banned once it has run", async ({ page }) => {
    const db = await server("db-01");
    const target = await observedOn(db.id);
    const ip = target.source_ip;
    const api = await owner();

    await stopAgent("db-01");
    try {
      await page.goto(`/security/threats?server_id=${db.id}`);
      const row = await threatRow(page, ip);
      await rowAction(page, row, "Ban this address");
      const dialog = page.getByRole("dialog", { name: `Ban ${ip}` });
      await dialog.getByLabel("Reason").fill("e2e: pending while queued");
      await dialog.getByRole("button", { name: "Ban" }).click();
      await expect(page.getByRole("dialog", { name: "Job activity" })).toBeVisible();
      await page.keyboard.press("Escape");

      /* The host has not done anything yet, and the row says exactly that. */
      const jobs = await api.get<JobRow[]>(`/jobs?server_id=${db.id}&type=fw.ban&per_page=1&sort=created_at&order=desc`);
      await expect
        .poll(async () => {
          const job = await api.get<JobRow>(`/jobs/${jobs[0]!.id}`);
          return `${job.status}:${job.blocked_reason ?? ""}`;
        })
        .toBe("queued:agent_offline");
      expect(await disposition(ip, "db-01")).toBe("pending");
      await expect(await threatRow(page, ip)).toContainText("pending");
      /* A pending ban is not an active one. */
      expect((await bans(`&server_id=${db.id}`)).map((b) => b.cidr)).not.toContain(`${ip}/32`);
    } finally {
      await startAgent("db-01");
    }

    const jobs = await api.get<JobRow[]>(`/jobs?server_id=${db.id}&type=fw.ban&per_page=1&sort=created_at&order=desc`);
    expect((await settled(jobs[0]!.id, 90_000)).status).toBe("succeeded");
    await expect.poll(() => disposition(ip, "db-01")).toBe("banned");
    expect((await bans(`&server_id=${db.id}`)).map((b) => b.cidr)).toContain(`${ip}/32`);

    const unban = await api.call<{ jobs: JobRow[] }>("POST", `/threats/${ip}/unban`, { server_id: db.id });
    expect((await settled(unban.data.jobs[0]!.id)).status).toBe("succeeded");
    await expect.poll(() => disposition(ip, "db-01")).toBe("observed");
  });

  test("the Ban address dialog validates, and a ban the host refuses goes back with its reason", async ({
    page,
  }) => {
    const db = await server("db-01");
    const target = await observedOn(db.id);
    await page.goto(`/security/threats?server_id=${db.id}`);
    await page.getByRole("button", { name: "Ban address" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Ban an address" });
    const submit = dialog.getByRole("button", { name: "Ban" });
    const message = "must be an IP address like 203.0.113.7, or a CIDR range like 198.51.100.0/24";

    for (const bad of ["not-an-ip", "10.0.0.0/33", "300.1.2.3", "203.0.113.7/", "2001:db8::/129"]) {
      await dialog.getByLabel("Address or range").fill(bad);
      await expect(dialog.getByText(message)).toBeVisible();
      await expect(submit).toBeDisabled();
    }
    for (const good of ["203.0.113.9", "198.51.100.0/24", "2001:db8::1", "2001:db8::/32"]) {
      await dialog.getByLabel("Address or range").fill(good);
      await expect(dialog.getByText(message)).toBeHidden();
    }
    /* No reason, no ban: the reason is the audit record. */
    await expect(submit).toBeDisabled();
    await expect(dialog.getByLabel("Where")).toHaveValue(db.id);

    /* Every address there is: the host refuses that outright. */
    await dialog.getByLabel("Address or range").fill("0.0.0.0/0");
    await dialog.getByLabel("Reason").fill("e2e: the host must refuse this");
    await submit.click();
    const drawer = page.getByRole("dialog", { name: "Job activity" });
    await expect(drawer).toBeVisible();
    await expect(jobStatusPill(drawer.getByRole("listitem").filter({ hasText: "0.0.0.0/0" }).first())).toHaveText(
      "Failed",
      { timeout: 60_000 },
    );
    await page.keyboard.press("Escape");

    /* Every row it touched is back to what it was, saying why. */
    await expect.poll(() => disposition(target.source_ip, "db-01")).toBe("observed");
    const rows = await (await owner()).get<Threat[]>(`/threats?server_id=${db.id}&per_page=100`);
    expect(rows.filter((r) => r.disposition === "pending")).toHaveLength(0);
    const after = rows.find((r) => r.id === target.id)!;
    expect(after.disposition_error).toMatch(/^0\.0\.0\.0\/0 covers every address/);
    const row = await threatRow(page, target.source_ip);
    await expect(row).toContainText("observed");
    await expect(row).toContainText("Last change failed: 0.0.0.0/0 covers every address");
    expect((await bans(`&server_id=${db.id}`)).map((b) => b.cidr)).not.toContain("0.0.0.0/0");
  });

  test("the Bans view lists what the hosts are blocking, and unbans from there", async ({ page }) => {
    const edge = await server("edge-01");
    const range = "192.0.2.128/25";

    /* An address nothing has observed: only the dialog could ban it. */
    await page.goto(`/security/threats?server_id=${edge.id}&panel=bans`);
    await expect(page.getByRole("link", { name: "Bans" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "Ban address" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Ban an address" });
    await dialog.getByLabel("Address or range").fill(range);
    await dialog.getByLabel("Reason").fill("e2e: bans view");
    await dialog.getByLabel("Duration").selectOption("0");
    await dialog.getByRole("button", { name: "Ban" }).click();
    const drawer = page.getByRole("dialog", { name: "Job activity" });
    await expect(jobStatusPill(drawer.getByRole("listitem").filter({ hasText: range }).first())).toHaveText(
      "Succeeded",
      { timeout: 60_000 },
    );
    await page.keyboard.press("Escape");

    const table = page.getByRole("table", { name: "Active bans" });
    const row = table.locator("tbody tr").filter({ hasText: range });
    await expect(row).toBeVisible();
    await expect(row).toContainText("edge-01");
    await expect(row).toContainText("e2e: bans view");
    await expect(row).toContainText("until unbanned");

    await row.getByRole("button", { name: "Row actions" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Unban", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: `Unban ${range}` });
    await expect(confirm).toContainText("edge-01 stops blocking it");
    await confirm.getByRole("button", { name: "Unban" }).click();
    await expect(jobStatusPill(drawer.getByRole("listitem").filter({ hasText: range }).first())).toHaveText(
      "Succeeded",
      { timeout: 60_000 },
    );
    await page.keyboard.press("Escape");
    await expect(row).toHaveCount(0);
    expect((await bans(`&server_id=${edge.id}`)).map((b) => b.cidr)).not.toContain(range);

    /* The tab back keeps the host. */
    await page.getByRole("link", { name: "Events" }).click();
    await expect(page).toHaveURL(new RegExp(`server_id=${edge.id}`));
    await expect(page.getByRole("table", { name: "Threat events" })).toBeVisible();
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
