import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  call,
  drawerJob,
  openRowActions,
  ownerCall,
  server,
  service,
  settledJob,
  signedInAs,
  signedInContext,
  tableRow,
  type JobRow,
  type SystemRole,
} from "../support/fleet.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Who may touch the fleet.
 *
 * packages/contract/src/rbac.ts defines five system roles and a scope
 * per grant. A hidden button is not a control — the API re-checks every
 * verb — so each persona is asserted on both sides: what the panel
 * offers them, and what the control plane does when they ask anyway.
 * The last persona is the one most panels get wrong: a grant scoped to
 * a single host must not leak to the rest of the fleet, in a menu, in
 * an API call, or in the command palette.
 *
 * Every user here is invited by the owner and accepts the invitation
 * through the panel, exactly as a colleague would.
 * ------------------------------------------------------------------ */

const contexts: BrowserContext[] = [];

async function as(browser: Browser, role: SystemRole): Promise<Page> {
  const context = await signedInAs(browser, role);
  contexts.push(context);
  return context.newPage();
}

test.afterAll(async () => {
  for (const context of contexts) await context.close();
});

async function servicePage(page: Page, hostName: string, unit: string) {
  const host = await server(hostName);
  await page.goto(`/infrastructure/services?server_id=${host.id}&q=${encodeURIComponent(unit)}`);
  const row = tableRow(page.getByRole("table", { name: "Services" }), unit).first();
  await expect(row).toBeVisible();
  return row;
}

test("a viewer sees the fleet and can change none of it", async ({ browser }) => {
  const page = await as(browser, "viewer");
  const db = await server("db-01");

  await page.goto("/infrastructure/servers");
  await expect(tableRow(page.getByRole("table", { name: "Servers" }), "forge-01")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add server" })).toHaveCount(0);

  /* Processes and the terminal are not theirs: not in the navigation... */
  const nav = page.getByRole("navigation", { name: "Primary" }).first();
  await expect(nav.getByRole("link", { name: "Servers" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Processes" })).toHaveCount(0);

  /* ...and every verb on a unit is greyed out. */
  const row = await servicePage(page, "db-01", "cron.service");
  const menu = await openRowActions(page, row);
  for (const verb of ["Restart", "Stop"]) {
    await expect(menu.getByRole("menuitem", { name: verb, exact: true })).toBeDisabled();
  }
  await page.keyboard.press("Escape");

  /* Asking the API directly is refused, with the machine code. */
  const api = page.context().request;
  const cron = await service("db-01", "cron.service");
  const restart = await call(api, "POST", `/services/${cron.id}/restart`, {});
  expect(restart.status).toBe(403);
  expect(restart.error?.code).toBe("forbidden");
  expect((await call(api, "GET", `/processes?server_id=${db.id}`)).status).toBe(403);
  expect(
    (await call(api, "POST", "/terminal/sessions", { server_id: db.id, cols: 80, rows: 24 }))
      .status,
  ).toBe(403);
  expect((await call(api, "POST", "/servers", { name: "v", hostname: "v.example.com" })).status).toBe(
    403,
  );
});

test("an auditor reads everything, including processes, and changes nothing", async ({
  browser,
}) => {
  const page = await as(browser, "auditor");
  const edge = await server("edge-01");

  /* Unlike a viewer, an auditor may look at the live process table. */
  await page.goto(`/infrastructure/processes?server_id=${edge.id}`);
  const table = page.getByRole("table", { name: "Processes" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  const menu = await openRowActions(page, table.locator("tbody tr").nth(3));
  await expect(menu.getByRole("menuitem", { name: "Send signal" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("button", { name: "Add server" })).toHaveCount(0);

  const api = page.context().request;
  expect(
    (await call(api, "POST", "/processes/2/signal", { server_id: edge.id, signal: "SIGTERM" }))
      .status,
  ).toBe(403);
  expect((await call(api, "POST", `/servers/${edge.id}/revoke`, {})).status).toBe(403);

  /* Jobs are readable — the audit trail is no use without them — but a
   * running one cannot be cancelled by someone who only reads. */
  const cron = await service("edge-01", "cron.service");
  const { job } = await ownerCall<{ job: JobRow }>("POST", `/services/${cron.id}/restart`, {});
  expect((await call(api, "GET", `/jobs/${job.id}`)).status).toBe(200);
  expect((await call(api, "POST", `/jobs/${job.id}/cancel`, {})).status).toBe(403);
  await settledJob(job.id);
});

test("a developer runs units and containers, but not hosts, processes or shells", async ({
  browser,
}) => {
  const page = await as(browser, "developer");
  const db = await server("db-01");

  /* A unit restart they start themselves lands on succeeded. */
  const row = await servicePage(page, "db-01", "rsyslog.service");
  const menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Restart", exact: true }).click();
  const job = drawerJob(page, "Restart service");
  await expect(job).toContainText("rsyslog.service");
  await expect(jobStatusPill(job)).toContainText("Succeeded", { timeout: 60_000 });
  await page.keyboard.press("Escape");

  /* Containers: lifecycle yes, delete no. */
  const forge = await server("forge-01");
  await page.goto(`/infrastructure/containers?server_id=${forge.id}&q=kaname-redis`);
  const crow = tableRow(page.getByRole("table", { name: "Containers" }), "kaname-redis").first();
  const cmenu = await openRowActions(page, crow);
  await expect(cmenu.getByRole("menuitem", { name: "Restart", exact: true })).toBeEnabled();
  await expect(cmenu.getByRole("menuitem", { name: "Remove", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  /* The host itself, the process table's verbs and a root shell are
   * an operator's. */
  await page.goto(`/infrastructure/servers/${db.id}`);
  await expect(page.getByRole("button", { name: "Terminal" })).toBeDisabled();
  await page.getByRole("button", { name: "Server actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Reboot" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Revoke certificate" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Remove from Kaname" })).toBeDisabled();
  await page.keyboard.press("Escape");

  const api = page.context().request;
  expect((await call(api, "POST", `/servers/${db.id}/reboot`, {})).status).toBe(403);
  expect(
    (await call(api, "POST", "/processes/2/signal", { server_id: db.id, signal: "SIGTERM" }))
      .status,
  ).toBe(403);
  expect(
    (await call(api, "POST", "/terminal/sessions", { server_id: db.id, cols: 80, rows: 24 }))
      .status,
  ).toBe(403);
});

test("an operator runs the fleet: adds servers, signals processes, opens shells", async ({
  browser,
}) => {
  const page = await as(browser, "operator");
  const edge = await server("edge-01");

  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("button", { name: "Add server" })).toBeVisible();

  await page.goto(`/infrastructure/processes?server_id=${edge.id}`);
  const table = page.getByRole("table", { name: "Processes" });
  await expect(table.locator("tbody tr").nth(3)).toBeVisible();
  const menu = await openRowActions(page, table.locator("tbody tr").nth(3));
  await expect(menu.getByRole("menuitem", { name: "Send signal" })).toBeEnabled();
  await page.keyboard.press("Escape");

  await page.goto(`/terminal?server_id=${edge.id}`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("This is a simulated host", {
    timeout: 30_000,
  });

  /* Panel administration is not part of running the infrastructure. */
  const api = page.context().request;
  expect((await call(api, "GET", "/users")).status).toBe(403);
});

test("a grant scoped to one host does not leak to the rest of the fleet", async ({ browser }) => {
  const edge = await server("edge-01");
  const db = await server("db-01");

  const context = await signedInContext(browser, "scoped-edge-operator", async () => {
    const existing = await ownerCall<{ id: string; slug: string }[]>("GET", "/roles?per_page=100");
    const found = existing.find((r) => r.slug === "edge-hands");
    if (found) return [found.id];
    const created = await ownerCall<{ id: string }>("POST", "/roles", {
      name: "Edge hands",
      slug: "edge-hands",
      description: "Runs units and opens shells on edge-01 only.",
      grants: [
        { permission: "infra.servers:read", scope: { kind: "global" } },
        { permission: "infra.services:read", scope: { kind: "global" } },
        { permission: "infra.services:exec", scope: { kind: "servers", server_ids: [edge.id] } },
        { permission: "terminal.session:exec", scope: { kind: "servers", server_ids: [edge.id] } },
      ],
    });
    return [created.id];
  });
  contexts.push(context);
  const page = await context.newPage();

  /* The menu is enabled on the host they hold, disabled on the other. */
  let row = await servicePage(page, "edge-01", "cron.service");
  let menu = await openRowActions(page, row);
  await expect(menu.getByRole("menuitem", { name: "Restart", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  row = await servicePage(page, "db-01", "cron.service");
  menu = await openRowActions(page, row);
  await expect(menu.getByRole("menuitem", { name: "Restart", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  /* The API agrees, host by host. */
  const api = context.request;
  const edgeCron = await service("edge-01", "cron.service");
  const dbCron = await service("db-01", "cron.service");
  expect((await call(api, "POST", `/services/${dbCron.id}/restart`, {})).status).toBe(403);
  const allowed = await call<{ job: JobRow }>(api, "POST", `/services/${edgeCron.id}/restart`, {});
  expect(allowed.status).toBe(202);
  expect((await settledJob(allowed.data.job.id)).status).toBe("succeeded");
  expect(
    (await call(api, "POST", "/terminal/sessions", { server_id: db.id, cols: 80, rows: 24 }))
      .status,
  ).toBe(403);

  /* And the palette offers verbs only where they would be allowed. */
  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("table", { name: "Servers" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const input = palette.getByRole("combobox", { name: "Search and commands" });
  const actions = palette.getByRole("group", { name: "Actions" });

  await input.fill("edge-01");
  await expect(actions.getByRole("option", { name: /Open terminal on edge-01/ })).toBeVisible();

  await input.fill("db-01");
  await expect(palette.getByRole("group", { name: "Servers" }).getByRole("option", { name: /db-01/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Open terminal on db-01/ })).toHaveCount(0);
});
