import { expect, test, type Page } from "@playwright/test";
import { missingId } from "../support/config.js";
import { cellAt, columnIndex } from "../support/ui.js";
import {
  api,
  choose,
  get,
  rowWith,
  serverNamed,
  settledJob,
  unique,
  type JobRow,
} from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — domains.
 *
 * A domain row is control-plane state, so its mutations return the row
 * rather than a job. The one call that leaves the panel is "Check
 * control", which resolves from the managed host's own vantage point —
 * and on failure it must hand back the exact record to publish, not
 * "could not verify". The simulated host's resolver serves a fixed
 * zone, so a proof can never be published to it; that is why the
 * journeys here prove the failure path end to end and the happy path
 * only through the seeded domains that were verified when they were
 * added.
 * ------------------------------------------------------------------ */

interface DomainRow {
  id: string;
  name: string;
  status: string;
  has_mail: boolean;
  dns_provider: string;
  site_id: string | null;
  verified: { ok: boolean; method: string; checked_at: string | null };
}

async function domainNamed(name: string): Promise<DomainRow> {
  const rows = await get<DomainRow[]>(`/domains?q=${encodeURIComponent(name)}&per_page=50`);
  const row = rows.find((domain) => domain.name === name);
  if (!row) throw new Error(`no domain named ${name}`);
  return row;
}

async function addDomain(body: Record<string, unknown>): Promise<DomainRow> {
  const res = await api<DomainRow>("POST", "/domains", body);
  expect(res.status, res.error?.message).toBe(201);
  return res.data;
}

async function domainsTable(page: Page) {
  const table = page.getByRole("table", { name: "Domains" });
  await expect(table).toBeVisible();
  return table;
}

/* ------------------------------ the list ----------------------------- */

test("the seeded domains list renders with their mail and control badges", async ({ page }) => {
  await page.goto("/websites/domains");
  await expect(page.getByRole("heading", { level: 1, name: "Domains" })).toBeVisible();
  const table = await domainsTable(page);

  /* futureforge.dev carries mail; the others do not. The flag drives
   * whether the Email module offers the domain at all. */
  const mail = rowWith(table, "futureforge.dev").filter({ hasNotText: "panel." }).filter({
    hasNotText: "shop.",
  });
  await expect(mail.first()).toContainText("Mail");
  await expect(rowWith(table, "docs.forgebase.dev")).not.toContainText("Mail");

  /* Verified when they were added, by a TXT proof — and said so. */
  await expect(rowWith(table, "docs.forgebase.dev")).toContainText("Verified");
  await expect(rowWith(table, "docs.forgebase.dev")).toContainText("Cloudflare");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("the mail filter means what it says in both directions", async ({ page }) => {
  await page.goto("/websites/domains");
  const table = await domainsTable(page);
  const column = await columnIndex(table, "Domain");
  /* The Domain cell also carries the Mail badge, so take its first line. */
  const names = async () => {
    const out: string[] = [];
    for (const row of await table.locator("tbody tr").all()) {
      out.push((await cellAt(row, column).innerText()).split("\n")[0]!.trim());
    }
    return out;
  };

  await page.getByRole("combobox", { name: "Mail" }).selectOption("true");
  await expect.poll(names).toEqual(["futureforge.dev"]);

  /* "No mail" must exclude the domain that carries mail — a query-string
   * "false" read as true used to return exactly that one. */
  await page.getByRole("combobox", { name: "Mail" }).selectOption("false");
  await expect.poll(async () => (await names()).length).toBeGreaterThan(0);
  expect(await names()).not.toContain("futureforge.dev");
  for (const row of await table.locator("tbody tr").all()) {
    await expect(cellAt(row, column)).not.toContainText("Mail");
  }
});

/* ------------------------------ add ---------------------------------- */

test("adding a domain validates the name and registers it unverified", async ({ page }) => {
  const name = `${unique("add")}.e2e.test`;
  await page.goto("/websites/domains");
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add domain" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect(
    dialog.getByText("Must be a domain name, for example example.com.", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Domain name").fill("-leading-dash.example");
  await expect(
    dialog.getByText("Must be a domain name, for example example.com.", { exact: true }),
  ).toBeVisible();

  /* Manual DNS has nothing to proxy through, so the switch is off-limits. */
  await expect(dialog.getByLabel("Proxy web traffic through the provider")).toBeDisabled();

  await dialog.getByLabel("Domain name").fill(name.toUpperCase());
  await dialog.getByLabel("Registrar").fill("Gandi");
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect(dialog).toBeHidden();

  const table = await domainsTable(page);
  /* Lower-cased on the way in: one row per name, however it was typed. */
  const row = rowWith(table, name);
  await expect(row).toContainText("Unverified");
  await expect(row).toContainText("Manual");
  await expect(row).toContainText("Not attached");

  /* A second row for the same name is refused, with a way to the first. */
  await page.getByRole("button", { name: "Add domain" }).first().click();
  await dialog.getByLabel("Domain name").fill(name);
  await dialog.getByRole("button", { name: "Add domain" }).click();
  const clash = dialog.getByRole("alert").filter({ hasText: "conflict" });
  await expect(clash).toContainText(`${name} is already registered in Kaname.`);
  await expect(clash.getByRole("button", { name: "Open it" })).toBeVisible();
});

/* ---------------------------- verification --------------------------- */

test("a domain with no host to resolve from cannot be checked, and says why", async ({ page }) => {
  const domain = await addDomain({ name: `${unique("nohost")}.e2e.test` });
  await page.goto(`/websites/domains/${domain.id}`);
  await page.getByRole("button", { name: "Check control" }).click();

  const error = page.getByRole("alert").filter({ hasText: "precondition_failed" });
  await expect(error).toContainText(
    `${domain.name} is not attached to a server, so Kaname has nowhere to resolve it from.`,
  );
  await expect(error.getByRole("button", { name: "Edit the domain" })).toBeVisible();
});

test("a failed control check hands over the TXT record to publish", async ({ page }) => {
  const forge = await serverNamed("forge-01");
  const domain = await addDomain({ name: `${unique("verify")}.e2e.test`, server_id: forge.id });

  await page.goto(`/websites/domains/${domain.id}`);
  await expect(page.getByRole("heading", { level: 1, name: domain.name })).toBeVisible();
  await page.getByRole("button", { name: "Check control" }).click();

  const error = page.getByRole("alert").filter({ hasText: "precondition_failed" });
  await expect(error).toContainText(`forge-01 cannot see proof that you control ${domain.name}.`);
  /* The remedy is the exact zone line, and it is the same token every
   * time, so it can be published before anyone presses the button. */
  await expect(error).toContainText(
    new RegExp(`_kaname\\.${domain.name.replace(/\./g, "\\.")}\\. 300 IN TXT "kaname-verification=[A-Za-z0-9_-]{32}"`),
  );
  await expect(error.getByRole("button", { name: "Copy the record" })).toBeVisible();

  /* The attempt is recorded even though it failed: the badge stays
   * Unverified, but "last checked" now has a time. */
  const after = await domainNamed(domain.name);
  expect(after.verified.ok).toBe(false);
  expect(after.verified.checked_at).not.toBeNull();
  await expect(page.getByText("Unverified").first()).toBeVisible();
});

/* --------------------------- provider switch ------------------------- */

test("moving a zone to Cloudflare without a token explains what is missing", async ({ page }) => {
  const domain = await addDomain({ name: `${unique("cf")}.e2e.test` });
  await page.goto(`/websites/domains/${domain.id}`);

  /* A manual zone has no API to pull from, and the menu says so. */
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Sync zone (needs an API provider)" }),
  ).toBeDisabled();
  await page.getByRole("menuitem", { name: "Edit domain" }).click();

  const dialog = page.getByRole("dialog", { name: `Edit ${domain.name}` });
  await dialog.getByLabel("DNS provider").selectOption("cloudflare");
  await expect(dialog.getByLabel("Zone identifier")).toBeVisible();
  await expect(dialog.getByLabel("Proxy web traffic through the provider")).toBeEnabled();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cloudflare").first()).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Sync zone from provider" }).click();
  const error = page.getByRole("alert").filter({ hasText: "Cloudflare" }).first();
  await expect(error).toContainText(`No Cloudflare API token is stored for ${domain.name}.`);
  expect((await domainNamed(domain.name)).dns_provider).toBe("cloudflare");
});

/* ------------------------------ detail ------------------------------- */

test("the domain page shows the mail flag the Email module keys on", async ({ page }) => {
  const seeded = await domainNamed("futureforge.dev");
  await page.goto(`/websites/domains/${seeded.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "futureforge.dev" })).toBeVisible();
  const registration = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Registration" }),
  });
  await expect(registration).toContainText(/Mail\s*Yes/);
  await expect(page.getByText("Verified").first()).toBeVisible();

  const other = await domainNamed("docs.forgebase.dev");
  await page.goto(`/websites/domains/${other.id}`);
  await expect(
    page.locator("section").filter({ has: page.getByRole("heading", { name: "Registration" }) }),
  ).toContainText(/Mail\s*No/);
});

test("a domain that does not exist says so by id", async ({ page }) => {
  await page.goto(`/websites/domains/${missingId}`);
  await expect(page.getByRole("alert").filter({ hasText: "not_found" })).toContainText(
    `Domain ${missingId} not found.`,
  );
});

/* ------------------------------ delete ------------------------------- */

test("a domain still serving a site cannot be deleted; a free one can", async ({ page }) => {
  const forge = await serverNamed("forge-01");
  const siteName = unique("e2e-dom-site");
  const attached = `${siteName}.e2e.test`;
  const created = await api<{ job: JobRow }>("POST", "/sites", {
    server_id: forge.id,
    name: siteName,
    webroot: `/var/www/${siteName}`,
    runtime: "static",
    primary_domain: attached,
  });
  expect((await settledJob(created.data.job.id)).status).toBe("succeeded");

  await page.goto(`/websites/domains?q=${attached}`);
  let table = await domainsTable(page);
  await rowWith(table, attached).getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete domain" }).click();
  let confirm = page.getByRole("dialog", { name: `Delete ${attached}?` });
  await confirm.getByLabel(/to confirm/).fill(attached);
  await confirm.getByRole("button", { name: "Delete domain" }).click();
  /* Deleting it would leave the vhost advertising a name nobody tracks. */
  await expect(page.getByRole("alert").filter({ hasText: "still answers on a site" })).toContainText(
    `${attached} still answers on a site.`,
  );
  await page.keyboard.press("Escape");
  expect((await domainNamed(attached)).site_id).not.toBeNull();

  const free = await addDomain({ name: `${unique("free")}.e2e.test` });
  await page.goto(`/websites/domains?q=${free.name}`);
  table = await domainsTable(page);
  await rowWith(table, free.name).getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete domain" }).click();
  confirm = page.getByRole("dialog", { name: `Delete ${free.name}?` });
  await confirm.getByLabel(/to confirm/).fill(free.name);
  await confirm.getByRole("button", { name: "Delete domain" }).click();
  await expect(confirm).toBeHidden();
  await expect(rowWith(table, free.name)).toHaveCount(0);
  expect((await api("GET", `/domains/${free.id}`)).status).toBe(404);
});

/* An attached domain picks its host up from the site, so the host field
 * follows and locks — a vhost only answers where it is written. */
test("attaching a domain to a site takes the site's host", async ({ page }) => {
  await page.goto("/websites/domains");
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add domain" });
  const name = `${unique("attach")}.e2e.test`;
  await dialog.getByLabel("Domain name").fill(name);
  await choose(page, dialog.getByLabel("Site"), "kaname-panel");
  await expect(dialog.getByLabel("Server")).toBeDisabled();
  await expect(dialog.getByLabel("Server")).toHaveValue("edge-01");
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect(dialog).toBeHidden();

  const row = rowWith(await domainsTable(page), name);
  await expect(row).toContainText("kaname-panel");
  const created = await domainNamed(name);
  expect(created.site_id).not.toBeNull();
});
