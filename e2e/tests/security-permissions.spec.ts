import { expect, test } from "@playwright/test";
import {
  owner,
  roleApi,
  roleContext,
  server,
  type Api,
  type RoleSlug,
} from "../support/secops.js";

/* ------------------------------------------------------------------ *
 * Permissions across security and operations, for every system role.
 *
 * Each role is a real account: invited by the owner, the invitation
 * accepted with the invitee's own password, then signed in. The matrix
 * is asked of the API — which is where the decision is made — and a
 * few journeys check the panel tells the same story instead of offering
 * a button that can only fail.
 * ------------------------------------------------------------------ */

type Probe = { method: string; path: (ids: Ids) => string; body?: (ids: Ids) => unknown; perm: string };
interface Ids {
  forge: string;
}

const READS: Record<string, Probe> = {
  firewall: { method: "GET", path: (i) => `/firewall?server_id=${i.forge}`, perm: "security.firewall:read" },
  threats: { method: "GET", path: () => "/threats", perm: "security.threats:read" },
  sshKeys: { method: "GET", path: () => "/ssh/keys", perm: "security.ssh:read" },
  audit: { method: "GET", path: () => "/audit/verify", perm: "security.audit:read" },
  backups: { method: "GET", path: () => "/backups/schedules", perm: "backups.schedules:read" },
  metrics: { method: "GET", path: () => "/monitoring/series?metric=cpu&range=1h", perm: "monitoring.metrics:read" },
  alerts: { method: "GET", path: () => "/monitoring/alerts", perm: "monitoring.alerts:read" },
  logs: { method: "GET", path: (i) => `/logs/sources?server_id=${i.forge}`, perm: "logs.streams:read" },
  settings: { method: "GET", path: () => "/settings", perm: "admin.settings:read" },
  updates: { method: "GET", path: () => "/updates", perm: "admin.settings:read" },
};

const WRITES: Record<string, Probe> = {
  firewallRule: {
    method: "POST",
    path: () => "/firewall",
    body: (i) => ({ server_id: i.forge, action: "deny", port_spec: "9", comment: "e2e rbac probe" }),
    perm: "security.firewall:write",
  },
  ban: {
    method: "POST",
    path: () => "/threats/192.0.2.250/ban",
    body: (i) => ({ server_id: i.forge, reason: "e2e rbac probe" }),
    perm: "security.threats:write",
  },
  alertRule: {
    method: "POST",
    path: () => "/monitoring/alert-rules",
    body: () => ({
      name: "e2e rbac probe",
      metric: "cpu",
      comparator: "gt",
      threshold: 1000,
      duration_seconds: 60,
      severity: "info",
      scope: { kind: "fleet" },
      enabled: false,
    }),
    perm: "monitoring.alerts:write",
  },
  settings: {
    method: "PATCH",
    path: () => "/settings",
    body: () => ({ panel: {} }),
    perm: "admin.settings:write",
  },
  updateCheck: { method: "POST", path: () => "/updates/check", perm: "admin.settings:write" },
};

/** Which probes each role may pass, straight from rbac.ts's system roles. */
const ALLOWED: Record<RoleSlug, { reads: string[]; writes: string[] }> = {
  operator: {
    reads: ["firewall", "threats", "sshKeys", "audit", "backups", "metrics", "alerts", "logs"],
    writes: ["firewallRule", "ban", "alertRule"],
  },
  developer: { reads: ["metrics", "logs"], writes: [] },
  auditor: { reads: Object.keys(READS), writes: [] },
  viewer: { reads: ["metrics", "alerts"], writes: [] },
};

async function cleanup(): Promise<void> {
  const api = await owner();
  const rules = await api.get<{ id: string; comment: string | null }[]>("/firewall?q=e2e%20rbac%20probe&per_page=50");
  for (const rule of rules) await api.call("DELETE", `/firewall/${rule.id}`);
  const alertRules = await api.get<{ id: string; name: string }[]>("/monitoring/alert-rules?q=e2e%20rbac&per_page=50");
  for (const rule of alertRules) await api.call("DELETE", `/monitoring/alert-rules/${rule.id}`);
}

test.describe("security and operations permissions", () => {
  let ids: Ids;

  test.beforeAll(async () => {
    ids = { forge: (await server("forge-01")).id };
  });
  test.afterAll(cleanup);

  for (const slug of ["operator", "developer", "auditor", "viewer"] as RoleSlug[]) {
    test(`${slug}: the API grants exactly what the role holds`, async () => {
      const api: Api = await roleApi(slug);
      const allowed = ALLOWED[slug];

      for (const [name, probe] of Object.entries(READS)) {
        const res = await api.call(probe.method, probe.path(ids));
        if (allowed.reads.includes(name)) {
          expect(res.status, `${slug} should read ${name}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
        } else {
          expect(res.status, `${slug} must not read ${name}`).toBe(403);
          expect(res.error?.code).toBe("forbidden");
          expect(res.error?.message).toMatch(new RegExp(`^You do not have ${probe.perm.replace(".", "\\.")}`));
        }
      }

      for (const [name, probe] of Object.entries(WRITES)) {
        const res = await api.call(probe.method, probe.path(ids), probe.body?.(ids) ?? {});
        if (allowed.writes.includes(name)) {
          expect(res.status, `${slug} should write ${name}: ${JSON.stringify(res.error)}`).toBeLessThan(300);
        } else {
          expect(res.status, `${slug} must not write ${name}`).toBe(403);
          expect(res.error?.message).toContain(probe.perm);
        }
      }
    });
  }

  test("operator runs backups but may not restore", async () => {
    const api = await roleApi("operator");
    const points = await api.get<{ id: string; label: string; server_id: string }[]>("/backups/restore-points?per_page=1");
    expect(points.length).toBeGreaterThan(0);
    const restore = await api.call("POST", "/backups/restore", {
      restore_point_id: points[0]!.id,
      target_server_id: points[0]!.server_id,
      target_path: "/srv/e2e-rbac",
      confirm_label: points[0]!.label,
    });
    expect(restore.status).toBe(403);
    expect(restore.error?.message).toContain("backups.restore:exec");
  });

  test("auditor sees the firewall but every way to change it is disabled", async ({ browser }) => {
    const context = await roleContext(browser, "auditor");
    const page = await context.newPage();
    await page.goto(`/security/firewall?server_id=${ids.forge}`);
    const table = page.getByRole("table", { name: "Firewall rules" });
    await expect(table.locator("tbody tr").filter({ hasText: "ICMP echo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New rule" }).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Apply to host" })).toBeDisabled();
    await expect(table.getByRole("spinbutton").first()).toBeDisabled();

    /* The audit page is theirs to read, chain check included. */
    await page.goto("/security/audit");
    await expect(page.getByText(/Chain verified through/)).toBeVisible();
    await context.close();
  });

  test("viewer is not shown security, and a deep link says why", async ({ browser }) => {
    const context = await roleContext(browser, "viewer");
    const page = await context.newPage();
    await page.goto("/monitoring");
    await expect(page.getByRole("heading", { level: 1, name: "Monitoring" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" }).first();
    await expect(nav.getByRole("link", { name: "Monitoring" })).toBeVisible();
    for (const hidden of ["Firewall", "Audit", "Backups", "Logs"]) {
      await expect(nav.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
    }

    await page.goto("/security/audit");
    const error = page.getByRole("alert").filter({ hasText: "Chain verification" });
    await expect(error).toBeVisible();
    await expect(error).toContainText("security.audit:read");
    await context.close();
  });

  test("developer can read logs and metrics in the panel but not alerts", async ({ browser }) => {
    const context = await roleContext(browser, "developer");
    const page = await context.newPage();
    await page.goto(`/logs?server_id=${ids.forge}`);
    await expect(page.getByRole("heading", { level: 1, name: "Logs" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "forbidden" })).toHaveCount(0);

    await page.goto("/monitoring?tab=alerts");
    await expect(page.getByRole("alert").filter({ hasText: "monitoring.alerts:read" })).toBeVisible();
    await context.close();
  });
});
