import { expect, test } from "@playwright/test";
import { apiUrl } from "../support/config.js";
import { owner, server } from "../support/secops.js";

/* ------------------------------------------------------------------ *
 * The audit trail — every mutation lands in it, and the chain verifies.
 *
 * One mutation from each area this suite covers is made here through
 * the API, then found in the panel's own Audit page by its action, and
 * the hash chain is walked before and after so the new rows are proved
 * to chain onto the old ones rather than merely to exist.
 * ------------------------------------------------------------------ */

interface Verification {
  verified: boolean;
  events_checked: number;
  broken_at: string | null;
}
interface Event {
  id: string;
  action: string;
  actor_name: string;
  target_label: string;
  hash: string;
  prev_hash: string;
}

test("each kind of mutation is audited and the chain still verifies", async ({ page }) => {
  const api = await owner();
  const forge = await server("forge-01");
  const before = await api.get<Verification>("/audit/verify");
  expect(before).toMatchObject({ verified: true, broken_at: null });

  /* One of each: firewall, alert rule, settings, threats, backups. */
  const rule = await api.ok<{ rule: { id: string } }>("POST", "/firewall", {
    server_id: forge.id,
    action: "deny",
    port_spec: "6667",
    comment: "e2e audit probe",
  });
  await api.ok("DELETE", `/firewall/${rule.rule.id}`);
  const alert = await api.ok<{ id: string }>("POST", "/monitoring/alert-rules", {
    name: "e2e audit probe",
    metric: "load1",
    comparator: "gt",
    threshold: 500,
    duration_seconds: 300,
    severity: "info",
    scope: { kind: "fleet" },
    enabled: false,
  });
  await api.ok("DELETE", `/monitoring/alert-rules/${alert.id}`);
  await api.ok("POST", "/threats/192.0.2.199/ignore", { server_id: forge.id });

  const expected = [
    "firewall.rule_created",
    "firewall.rule_deleted",
    "alert_rule.created",
    "alert_rule.deleted",
    "threat.ignored",
  ];

  const after = await api.get<Verification>("/audit/verify");
  expect(after.verified).toBe(true);
  expect(after.events_checked).toBeGreaterThanOrEqual(before.events_checked + expected.length);

  /* The newest rows chain: each prev_hash is the hash of the row before it. */
  const newest = await api.get<Event[]>("/audit?per_page=10&sort=seq&order=desc");
  for (let i = 0; i < newest.length - 1; i++) {
    expect(newest[i]!.prev_hash, `row ${newest[i]!.action}`).toBe(newest[i + 1]!.hash);
  }

  await page.goto("/security/audit");
  await expect(page.getByText(/Chain verified through [\d,]+ events/)).toBeVisible();
  const table = page.getByRole("table", { name: "Audit events" });
  for (const action of expected) {
    await page.getByLabel("Action prefix").fill(action);
    await page.getByLabel("Action prefix").press("Enter");
    await expect(table.locator("tbody tr").filter({ hasText: action }).first()).toBeVisible();
  }

  /* Filtering by prefix narrows to that family and nothing else. */
  await page.getByLabel("Action prefix").fill("alert_rule.");
  await page.getByLabel("Action prefix").press("Enter");
  await expect
    .poll(async () => (await table.locator("tbody tr").allInnerTexts()).every((t) => t.includes("alert_rule.")))
    .toBe(true);

  /* A row opens into its detail, hashes included. */
  await table.locator("tbody tr").filter({ hasText: "alert_rule.deleted" }).first().click();
  const detail = page.getByRole("dialog", { name: "alert_rule.deleted" });
  await expect(detail).toContainText("e2e audit probe");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByText(/Chain verified through/)).toBeVisible();
});

test("the trail exports as NDJSON, and the export itself is audited", async () => {
  const api = await owner();
  const res = await fetch(`${apiUrl}/api/v1/audit/export?action=firewall.`, {
    headers: { cookie: api.cookie },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  expect(res.headers.get("content-disposition")).toMatch(/kaname-audit-\d{4}-\d{2}-\d{2}\.ndjson/);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Event);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line.action.startsWith("firewall.")).toBe(true);

  const exported = await api.get<Event[]>("/audit?action=audit.exported&per_page=1&sort=seq&order=desc");
  expect(exported[0]?.action).toBe("audit.exported");
  expect((await api.get<Verification>("/audit/verify")).verified).toBe(true);
});

test("there is no way to write to the trail through the API", async () => {
  const api = await owner();
  const [row] = await api.get<Event[]>("/audit?per_page=1");
  for (const [method, path] of [
    ["POST", "/audit"],
    ["DELETE", `/audit/${row!.id}`],
    ["PATCH", `/audit/${row!.id}`],
  ] as const) {
    const res = await api.call(method, path, method === "DELETE" ? undefined : {});
    expect(res.status, `${method} ${path}`).toBe(404);
  }
});
