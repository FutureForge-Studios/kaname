import { expect, test } from "@playwright/test";
import {
  api,
  choose,
  connection,
  drawerJob,
  expectJobStatus,
  get,
  rowWith,
  startAgent,
  stopAgent,
  unique,
  serverNamed,
} from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — the host goes dark.
 *
 * "The box is unreachable" is a wait, not a failure (KD-008): a vhost
 * write queued while edge-01's agent is down must stay queued, say why,
 * and run by itself when the agent dials back in. Reads that need the
 * host — the pre-reload config test, a domain check — cannot wait, so
 * they must refuse at once and name the host, rather than hang or
 * pretend.
 *
 * Only edge-01 is stopped, and it is always restarted, even when an
 * assertion fails: the rest of the suite runs on the other hosts.
 * ------------------------------------------------------------------ */

const HOST = "edge-01";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  startAgent(HOST);
  const edge = await serverNamed(HOST);
  await expect
    .poll(() => connection(edge.id), { timeout: 60_000, message: `${HOST} never reconnected` })
    .toBe("connected");
});

test("work queued against a disconnected host waits for it and then runs", async ({ page }) => {
  const edge = await serverNamed(HOST);
  const panel = (await get<{ id: string; name: string }[]>("/sites?q=kaname-panel"))[0]!;

  await stopAgent(HOST);
  await expect
    .poll(() => connection(edge.id), { message: `${HOST} still reads as connected` })
    .toBe("disconnected");

  /* The site page says the host is unreachable, beside the site's own state. */
  await page.goto(`/websites/sites/${panel.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "kaname-panel" })).toBeVisible();
  await expect(page.getByText("Disconnected").first()).toBeVisible();

  /* A reload needs `nginx -t` from the host first, so it is refused now. */
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "is not connected" })).toContainText(
    `The agent on ${HOST} is not connected.`,
  );

  /* So is a domain check — it resolves from the host's own vantage point. */
  const domain = await api<{ id: string; name: string }>("POST", "/domains", {
    name: `${unique("dark")}.e2e.test`,
    server_id: edge.id,
  });
  await page.goto(`/websites/domains/${domain.data.id}`);
  await page.getByRole("button", { name: "Check control" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "agent_offline" })).toContainText(
    `The agent on ${HOST} is not connected.`,
  );

  /* A create is a job, so it is accepted — and waits, saying why. */
  const name = unique("e2e-dark");
  await page.goto("/websites/sites");
  await page.getByRole("button", { name: "New site" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New site" });
  await choose(page, dialog.getByLabel("Server"), HOST);
  await dialog.getByLabel("Site name").fill(name);
  await dialog.getByLabel("Primary domain").fill(`${name}.e2e.test`);
  await dialog.getByRole("button", { name: "Create site" }).click();
  await expect(dialog).toBeHidden();

  const job = drawerJob(page, "Create site", name);
  await expect(job).toBeVisible();
  await expect(job.locator('span[title^="Queued."]')).toContainText("agent offline", {
    timeout: 30_000,
  });
  await page.keyboard.press("Escape");
  /* Search rather than scan: the suite has made more sites than a page holds. */
  await page.getByRole("searchbox", { name: "Search sites" }).fill(name);
  const row = rowWith(page.getByRole("table", { name: "Sites" }), name);
  await expect(row).toContainText("Provisioning");
  await expect(row).toContainText("Disconnected");

  /* The host comes back; nobody presses anything; the job runs. */
  startAgent(HOST);
  await expect
    .poll(() => connection(edge.id), { timeout: 60_000, message: `${HOST} never reconnected` })
    .toBe("connected");

  await page
    .getByRole("button", { name: /Job activity/ })
    .first()
    .click();
  await expectJobStatus(drawerJob(page, "Create site", name), "Succeeded", 90_000);
  await page.keyboard.press("Escape");
  await expect(row).toContainText("Active");
  await expect(row).not.toContainText("Provisioning");

  /* And the vhost really is on the host that was dark. */
  const read = await api<{ content: string }>(
    "GET",
    `/files/read?server_id=${edge.id}&path=${encodeURIComponent(`/etc/nginx/sites-available/${name}`)}`,
  );
  expect(read.status).toBe(200);
  expect(read.data.content).toContain(`server_name ${name}.e2e.test;`);
});
