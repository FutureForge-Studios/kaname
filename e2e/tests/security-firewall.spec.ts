import { expect, test, type Locator, type Page } from "@playwright/test";
import { missingId } from "../support/config.js";
import {
  auditRows,
  hostFile,
  owner,
  server,
  settled,
  startAgent,
  stopAgent,
  type JobRow,
} from "../support/secops.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Firewall — staging, applying, and the rollback window.
 *
 * The page's whole reason to exist is that a firewall change can cost
 * the operator the machine. So the assertions here are about the host,
 * not the page: what /etc/nftables.conf on the simulated host says
 * after an apply, after a confirm, and after a window that nobody
 * confirmed. A toast saying "applied" proves nothing.
 *
 * Each journey uses its own server so that one journey's rollback timer
 * can never be what another journey observes.
 * ------------------------------------------------------------------ */

const NFT = "/etc/nftables.conf";
/** The shortest window the panel offers. The lapse is waited out for real. */
const WINDOW_S = 30;

async function openFirewall(page: Page, serverName: string): Promise<Locator> {
  const target = await server(serverName);
  await page.goto(`/security/firewall?server_id=${target.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Firewall" })).toBeVisible();
  const table = page.getByRole("table", { name: "Firewall rules" });
  // Every seeded host has this rule; waiting for it (not just any row)
  // skips the moment the list renders before the server is resolved.
  await expect(ruleRow(table, "ICMP echo")).toBeVisible();
  return table;
}

function ruleRow(table: Locator, text: string): Locator {
  return table.locator("tbody tr").filter({ hasText: text });
}

async function rowAction(page: Page, row: Locator, action: string): Promise<void> {
  // By keyboard: the toast stack sits over the right-hand column, where
  // the row menu lives, for a few seconds after every mutation.
  await row.getByRole("button", { name: "Row actions" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

async function addRule(
  page: Page,
  rule: { priority?: string; action?: string; port?: string; source?: string; comment: string },
): Promise<void> {
  await page.getByRole("button", { name: "New rule" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New rule" });
  await expect(dialog).toBeVisible();
  if (rule.priority) await dialog.getByLabel("Priority").fill(rule.priority);
  if (rule.action) await dialog.getByLabel("Action").selectOption(rule.action);
  if (rule.port !== undefined) await dialog.getByLabel("Port").fill(rule.port);
  if (rule.source !== undefined) await dialog.getByLabel("Source").fill(rule.source);
  await dialog.getByLabel("Comment").fill(rule.comment);
  await dialog.getByRole("button", { name: "Add rule" }).click();
  await expect(dialog).toBeHidden();
}

/** The job the drawer opened on, watched to its terminal state. */
async function drawerJob(page: Page, serverName: string): Promise<string> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const job = drawer.getByRole("listitem").filter({ hasText: serverName }).first();
  const pill = jobStatusPill(job);
  await expect(pill).toHaveText(/Succeeded|Failed|Cancelled|Timed out/, { timeout: 60_000 });
  const text = (await pill.innerText()).trim();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  return text;
}

async function lastApplyJob(serverId: string): Promise<JobRow> {
  const api = await owner();
  const jobs = await api.get<JobRow[]>(
    `/jobs?server_id=${serverId}&type=fw.apply&per_page=1&sort=created_at&order=desc`,
  );
  expect(jobs[0], "no fw.apply job was queued").toBeTruthy();
  return jobs[0]!;
}

test.describe("firewall", () => {
  test("rules are listed, filtered and validated field by field", async ({ page }) => {
    const table = await openFirewall(page, "db-01");

    /* The seeded set, and the status strip that reads the host's policy. */
    await expect(ruleRow(table, "SSH from the private network")).toBeVisible();
    await expect(page.getByText("Default inbound", { exact: true }).locator("xpath=../..")).toContainText("deny");

    await page.getByLabel("Protocol").selectOption("icmp");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(ruleRow(table, "ICMP echo")).toBeVisible();
    await page.getByLabel("Protocol").selectOption("");
    await expect(ruleRow(table, "HTTP and HTTPS")).toBeVisible();

    /* Bad input is refused in the form, with the field's own message. */
    await page.getByRole("button", { name: "New rule" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New rule" });
    const add = dialog.getByRole("button", { name: "Add rule" });

    for (const bad of ["22-", "abc", "80;443", "1,,2"]) {
      await dialog.getByLabel("Port").fill(bad);
      await expect(dialog.getByText("a port, a comma-separated list, or a range")).toBeVisible();
      await expect(add).toBeDisabled();
    }
    await dialog.getByLabel("Port").fill("3000-4000");
    await expect(dialog.getByText("a port, a comma-separated list, or a range")).toBeHidden();

    for (const bad of ["10.0.0.0", "10.0.0.0/33", "300.1.1.1/32", "not-a-cidr"]) {
      await dialog.getByLabel("Source").fill(bad);
      await expect(dialog.getByText("must be a CIDR block, e.g. 203.0.113.4/32")).toBeVisible();
      await expect(add).toBeDisabled();
    }
    for (const good of ["0.0.0.0/0", "203.0.113.4/32", "2001:db8::/32"]) {
      await dialog.getByLabel("Source").fill(good);
      await expect(dialog.getByText("must be a CIDR block, e.g. 203.0.113.4/32")).toBeHidden();
    }
    await dialog.getByLabel("Destination").fill("10.0.0.0/8/8");
    await expect(dialog.getByText("must be a CIDR block, e.g. 10.0.0.0/8")).toBeVisible();

    /* ICMP has no ports, so the field stops taking one. */
    await dialog.getByLabel("Protocol").selectOption("icmp");
    await expect(dialog.getByLabel("Port")).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    /* The API applies the same contract to a caller that skips the form. */
    const api = await owner();
    const db = await server("db-01");
    const refused = await api.call("POST", "/firewall", {
      server_id: db.id,
      action: "allow",
      port_spec: "65536-",
      source_cidr: "10.0.0.0/40",
      priority: 70000,
    });
    expect(refused.status).toBe(422);
    expect(refused.error?.code).toBe("validation_failed");
    expect(refused.error?.fields?.["port_spec"]).toBe(
      "must be a port, a comma-separated list, or a range",
    );
    expect(refused.error?.fields?.["source_cidr"]).toBeTruthy();
    expect(refused.error?.fields?.["priority"]).toBeTruthy();
  });

  test("a rule is added, edited, re-ordered, disabled and deleted — staged, never applied", async ({
    page,
  }) => {
    const db = await server("db-01");
    const before = await hostFile(db.id, NFT);
    const table = await openFirewall(page, "db-01");

    await addRule(page, { priority: "50", port: "8443", source: "198.51.100.0/24", comment: "e2e partner API" });
    const row = ruleRow(table, "e2e partner API");
    await expect(row).toBeVisible();
    await expect(row).toContainText("8443");
    await expect(row).toContainText("198.51.100.0/24");
    await expect(row.getByText("staged")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /staged in Kaname and not on db-01/ })).toBeVisible();

    /* Edit through the dialog. */
    await rowAction(page, row, "Edit rule");
    const edit = page.getByRole("dialog", { name: "Edit rule" });
    await expect(edit.getByLabel("Port")).toHaveValue("8443");
    await edit.getByLabel("Port").fill("8443,9443");
    await edit.getByLabel("Comment").fill("e2e partner API v2");
    await edit.getByRole("button", { name: "Save rule" }).click();
    await expect(edit).toBeHidden();
    const edited = ruleRow(table, "e2e partner API v2");
    await expect(edited).toContainText("8443,9443");

    /* Priority is edited inline, as the number the host will read. */
    const priority = edited.getByLabel(/^Priority of allow inbound tcp 8443,9443/);
    await priority.fill("15");
    await priority.press("Enter");
    await expect(priority).toHaveValue("15");
    await page.reload();
    await expect(ruleRow(table, "e2e partner API v2").getByLabel(/^Priority of/)).toHaveValue("15");

    /* Out of range is not sent at all — the cell snaps back. */
    const again = ruleRow(table, "e2e partner API v2").getByLabel(/^Priority of/);
    await again.fill("70000");
    await again.press("Enter");
    await expect(again).toHaveValue("15");

    await rowAction(page, ruleRow(table, "e2e partner API v2"), "Disable rule");
    await expect(ruleRow(table, "e2e partner API v2").getByText("disabled")).toBeVisible();

    await rowAction(page, ruleRow(table, "e2e partner API v2"), "Delete rule");
    const confirm = page.getByRole("dialog", { name: "Delete this rule?" });
    await expect(confirm).toContainText("allow inbound tcp 8443,9443 from 198.51.100.0/24");
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(confirm).toBeHidden();
    await expect(ruleRow(table, "e2e partner API v2")).toHaveCount(0);

    /* None of that touched the host: rules are staged until Apply. */
    expect(await hostFile(db.id, NFT)).toBe(before);

    /* And every step is in the audit trail, in order. */
    const actions = (await auditRows("firewall.rule_", 10))
      .filter((row) => row.server_id === db.id)
      .map((row) => row.action);
    expect(actions.slice(0, 5)).toEqual([
      "firewall.rule_deleted",
      "firewall.rule_updated",
      "firewall.rule_updated",
      "firewall.rule_updated",
      "firewall.rule_created",
    ]);
  });

  test("apply writes the host, and confirming inside the window keeps it", async ({ page }) => {
    const forge = await server("forge-01");
    const table = await openFirewall(page, "forge-01");

    /* The address the panel is reached from needs SSH, or the check says so. */
    await addRule(page, { priority: "5", port: "22", source: "127.0.0.1/32", comment: "e2e operator SSH" });
    await expect(ruleRow(table, "e2e operator SSH")).toBeVisible();

    await page.getByRole("button", { name: "Apply to host" }).click();
    const dialog = page.getByRole("dialog", { name: /^Apply \d+ rules to forge-01$/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("table")).toContainText("allow inbound tcp 22 from 127.0.0.1/32");
    await dialog.getByLabel("Rollback window").selectOption(String(WINDOW_S));
    await dialog.getByRole("button", { name: "Apply to forge-01" }).click();

    expect(await drawerJob(page, "forge-01")).toContain("Succeeded");
    const appliedAt = Date.now();

    /* The host has the new set, rule for rule. */
    await expect
      .poll(() => hostFile(forge.id, NFT))
      .toContain('ip saddr 127.0.0.1/32 tcp dport { 22 } accept comment "e2e operator SSH"');

    const banner = page.getByRole("status").filter({ hasText: "forge-01 reverts its firewall rule set in" });
    await expect(banner).toBeVisible();
    /* It counts down, it does not just sit there. */
    const remaining = banner.getByLabel(/remaining$/);
    const first = await remaining.getAttribute("aria-label");
    await expect.poll(() => remaining.getAttribute("aria-label")).not.toBe(first);

    await banner.getByRole("button", { name: "Confirm — keep these changes" }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByText("Staged, not applied", { exact: true }).locator("xpath=../..")).toContainText("0");
    await expect(ruleRow(table, "e2e operator SSH").getByText("staged")).toHaveCount(0);

    /* A second confirm has nothing left to confirm, and says why. */
    const api = await owner();
    const twice = await api.call("POST", "/firewall/confirm", { server_id: forge.id });
    expect(twice.status).toBe(409);
    expect(twice.error?.message).toBe("forge-01 has no firewall rule set waiting to be confirmed.");

    /* The real proof: the window passes and the host still has the rule. */
    await expect
      .poll(
        async () => {
          const content = await hostFile(forge.id, NFT);
          if (!content.includes('comment "e2e operator SSH"')) return "reverted";
          return Date.now() > appliedAt + (WINDOW_S + 5) * 1000 ? "held" : "waiting";
        },
        { timeout: (WINDOW_S + 30) * 1000, intervals: [2000] },
      )
      .toBe("held");

    const audit = (await auditRows("firewall.", 10)).filter((row) => row.server_id === forge.id);
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(["firewall.applied", "firewall.confirmed"]),
    );
  });

  test("an unconfirmed apply reverts on the host when the window lapses", async ({ page }) => {
    const edge = await server("edge-01");
    const table = await openFirewall(page, "edge-01");
    const original = await hostFile(edge.id, NFT);

    await addRule(page, { priority: "5", port: "22", source: "127.0.0.1/32", comment: "e2e lapse probe" });
    await expect(ruleRow(table, "e2e lapse probe")).toBeVisible();
    await page.getByRole("button", { name: "Apply to host" }).click();
    const dialog = page.getByRole("dialog", { name: /^Apply \d+ rules to edge-01$/ });
    await dialog.getByLabel("Rollback window").selectOption(String(WINDOW_S));
    await dialog.getByRole("button", { name: "Apply to edge-01" }).click();
    expect(await drawerJob(page, "edge-01")).toContain("Succeeded");

    await expect.poll(() => hostFile(edge.id, NFT)).toContain('comment "e2e lapse probe"');

    /* Do nothing. The banner closes on its own clock... */
    const open = page.getByRole("status").filter({ hasText: "edge-01 reverts its firewall rule set in" });
    await expect(open.getByRole("button", { name: "Confirm — keep these changes" })).toBeVisible();
    const closed = page
      .getByRole("status")
      .filter({ hasText: "The rollback window on edge-01 has closed." });
    await expect(closed).toBeVisible({ timeout: (WINDOW_S + 15) * 1000 });
    await expect(closed.getByRole("button", { name: /Confirm/ })).toHaveCount(0);

    /* ...and the host's own timer has put the previous set back. */
    await expect
      .poll(() => hostFile(edge.id, NFT), { timeout: 20_000 })
      .not.toContain('comment "e2e lapse probe"');
    /* The host's own previous set — the agent's, not Kaname's — is what came back. */
    const reverted = await hostFile(edge.id, NFT);
    expect(reverted).toContain('comment "MariaDB is loopback only"');
    expect(original).not.toContain('comment "e2e lapse probe"');

    /* Too late to confirm, and the API says so in words. */
    const api = await owner();
    const late = await api.call("POST", "/firewall/confirm", { server_id: edge.id });
    expect(late.status).toBe(409);
    expect(late.error?.message).toMatch(/edge-01/);

    /* The panel must not claim the reverted rules are live. */
    await page.reload();
    await expect(
      page.getByRole("status").filter({ hasText: /staged in Kaname and not on edge-01/ }),
    ).toBeVisible();
    await expect(ruleRow(table, "e2e lapse probe").getByText("staged")).toBeVisible();
  });

  test("a rule set that would lock the panel out is refused without a window", async ({ page }) => {
    const mail = await server("mail-01");
    await openFirewall(page, "mail-01");
    const before = await hostFile(mail.id, NFT);

    /* The seeded set only allows SSH from 10/8; this browser is on 127.0.0.1. */
    await page.getByRole("button", { name: "Apply to host" }).click();
    const dialog = page.getByRole("dialog", { name: /^Apply \d+ rules to mail-01$/ });
    await dialog.getByLabel("Rollback window").selectOption("0");

    const apply = dialog.getByRole("button", { name: "Apply to mail-01" });
    await expect(apply).toBeDisabled();
    await dialog.getByLabel("Apply with no rollback window").check();
    await apply.click();

    await expect(
      dialog.getByText(
        "This rule set would cut Kaname off from mail-01 and you asked for no rollback window.",
      ),
    ).toBeVisible();
    const notice = dialog.getByRole("alert").filter({ hasText: "This rule set would lock you out." });
    await expect(notice).toContainText("ssh_lockout");
    await expect(notice).toContainText("Checked against 127.0.0.1");
    await expect(notice).toContainText("allow inbound tcp 22 from 127.0.0.1/32");
    await expect(dialog).toBeVisible();

    /* Refused means refused: no job, nothing on the host. */
    expect(await hostFile(mail.id, NFT)).toBe(before);
    const api = await owner();
    const jobs = await api.get<JobRow[]>(`/jobs?server_id=${mail.id}&type=fw.apply&per_page=5`);
    expect(jobs).toHaveLength(0);

    /* An outbound block on the panel's own port is the same refusal. */
    const outbound = await api.call("POST", "/firewall/apply", {
      server_id: mail.id,
      rules: [{ priority: 1, action: "allow", direction: "inbound", protocol: "tcp", port_spec: "22", source_cidr: "127.0.0.1/32" }],
      default_outbound: "deny",
      rollback_seconds: 0,
    });
    expect(outbound.status).toBe(412);
    expect(
      (outbound.error?.detail as { checks: { code: string }[] }).checks.map((c) => c.code),
    ).toContain("agent_lockout");
  });

  test("an apply sent while the agent is gone waits, then lands when it is back", async ({ page }) => {
    const db = await server("db-01");
    await openFirewall(page, "db-01");
    const api = await owner();

    await stopAgent("db-01");
    try {
      await page.reload();
      await page.getByRole("button", { name: "Apply to host" }).click();
      const dialog = page.getByRole("dialog", { name: /^Apply \d+ rules to db-01$/ });
      await dialog.getByLabel("Rollback window").selectOption("300");
      await dialog.getByRole("button", { name: "Apply to db-01" }).click();

      const drawer = page.getByRole("dialog", { name: "Job activity" });
      await expect(drawer).toBeVisible();
      const job = await lastApplyJob(db.id);
      /* Not failed, not succeeded: held, and saying what it is waiting for. */
      await expect
        .poll(async () => {
          const row = await api.get<JobRow>(`/jobs/${job.id}`);
          return `${row.status}:${row.blocked_reason ?? ""}`;
        })
        .toBe("queued:agent_offline");
      await page.keyboard.press("Escape");

      /* Confirming needs a live host; it is refused rather than faked. */
      const confirm = await api.call("POST", "/firewall/confirm", { server_id: db.id });
      expect(confirm.status).toBeGreaterThanOrEqual(400);
      expect(confirm.error?.message).toMatch(/db-01/);
    } finally {
      await startAgent("db-01");
    }

    const job = await lastApplyJob(db.id);
    const done = await settled(job.id, 90_000);
    expect(done.status, JSON.stringify(done.error)).toBe("succeeded");
    await expect.poll(() => hostFile(db.id, NFT)).toContain('comment "SSH from the private network"');
    expect((await api.call("POST", "/firewall/confirm", { server_id: db.id })).status).toBe(200);
  });

  test("a rule id that does not exist is a not-found, not a blank page", async () => {
    const api = await owner();
    const missing = await api.call("PATCH", `/firewall/${missingId}`, { comment: "x" });
    expect(missing.status).toBe(404);
    expect(missing.error?.message).toBe(`Firewall rule ${missingId} not found.`);
    const gone = await api.call("DELETE", `/firewall/${missingId}`);
    expect(gone.status).toBe(404);
  });
});
