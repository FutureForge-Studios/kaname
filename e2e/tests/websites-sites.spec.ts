import { expect, test, type Page } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { missingId } from "../support/config.js";
import {
  api,
  choose,
  drawerJob,
  expectJobStatus,
  get,
  rowWith,
  settledJob,
  unique,
  type JobRow,
} from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — sites.
 *
 * A site row is Kaname's intent and the vhost is the effect, so every
 * journey here checks both halves: the row on the page moves to the
 * state the job earned, and the file on the (simulated) host says what
 * the operator asked for. A "Create site" that only ever produced a
 * green toast would pass a weaker suite while writing nothing at all.
 *
 * Everything runs on forge-01, whose simulated world is never restarted
 * by this suite (the outage journey uses edge-01).
 * ------------------------------------------------------------------ */

const HOST = "forge-01";

interface SiteRow {
  id: string;
  name: string;
  status: string;
  runtime: string;
  config_path: string | null;
  domains: { id: string; name: string }[];
  server_id: string;
}

async function siteNamed(name: string): Promise<SiteRow> {
  const rows = await get<SiteRow[]>(`/sites?q=${encodeURIComponent(name)}&per_page=50`);
  const row = rows.find((site) => site.name === name);
  if (!row) throw new Error(`no site named ${name}`);
  return row;
}

async function vhost(serverId: string, path: string): Promise<string> {
  const read = await api<{ content: string }>(
    "GET",
    `/files/read?server_id=${serverId}&path=${encodeURIComponent(path)}`,
  );
  expect(read.status, `could not read ${path}: ${read.error?.message}`).toBe(200);
  return read.data.content;
}

async function openNewSite(page: Page) {
  await page.goto("/websites/sites");
  await expect(page.getByRole("heading", { level: 1, name: "Sites" })).toBeVisible();
  await page.getByRole("button", { name: "New site" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New site" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/* -------------------------- every runtime ---------------------------- */

/*
 * The six runtimes render six different vhosts — a php site that came
 * out as a static one would serve its source code — so the generated
 * file is read back from the host and checked for the directive that
 * makes each runtime what it is.
 */
const RUNTIMES = [
  { runtime: "static", label: "Static", directive: "try_files $uri $uri/ =404;" },
  {
    runtime: "php",
    label: "PHP",
    version: "8.3",
    directive: "fastcgi_pass unix:/run/php/php8.3-fpm.sock;",
  },
  { runtime: "node", label: "Node", version: "22", directive: "proxy_pass http://127.0.0.1:3000;" },
  {
    runtime: "python",
    label: "Python",
    version: "3.12",
    directive: "uwsgi_pass unix:/run/uwsgi/app.sock;",
  },
  {
    runtime: "proxy",
    label: "Proxy",
    upstream: "http://127.0.0.1:8080",
    directive: "proxy_pass http://127.0.0.1:8080;",
  },
  {
    runtime: "container",
    label: "Container",
    upstream: "http://127.0.0.1:9090",
    directive: "proxy_pass http://127.0.0.1:9090;",
  },
] as const;

for (const spec of RUNTIMES) {
  test(`a ${spec.runtime} site is provisioned as a job and its vhost lands on the host`, async ({
    page,
  }) => {
    const forge = await serverNamed(HOST);
    const name = unique(`e2e-${spec.runtime}`);
    const domain = `${name}.e2e.test`;

    const dialog = await openNewSite(page);
    await choose(page, dialog.getByLabel("Server"), HOST);
    await dialog.getByLabel("Site name").fill(name);
    await dialog.getByLabel("Primary domain").fill(domain);
    await dialog.getByLabel("Runtime").selectOption(spec.runtime);
    if ("version" in spec) await dialog.getByLabel(`${spec.label} version`).fill(spec.version);
    if ("upstream" in spec) await dialog.getByLabel("Upstream origin").fill(spec.upstream);
    /* The webroot follows the name until it is touched. */
    await expect(dialog.getByLabel("Webroot")).toHaveValue(`/var/www/${name}`);

    await dialog.getByRole("button", { name: "Create site" }).click();
    await expect(dialog).toBeHidden();

    const job = drawerJob(page, "Create site", name);
    await expect(job).toBeVisible();
    await expect(job).toContainText(HOST);
    await expectJobStatus(job, "Succeeded");
    await page.keyboard.press("Escape");

    /* The row moved off "provisioning" because the job said so. */
    const table = page.getByRole("table", { name: "Sites" });
    const row = rowWith(table, name);
    await expect(row).toContainText("Active");
    await expect(row).toContainText(spec.label);
    await expect(row).toContainText(domain);

    /* And the vhost the agent wrote is the one this runtime needs. */
    const site = await siteNamed(name);
    expect(site.config_path).toBe(`/etc/nginx/sites-available/${name}`);
    const config = await vhost(forge.id, site.config_path!);
    expect(config).toContain(`server_name ${domain};`);
    expect(config).toContain(spec.directive);
    /* Force HTTPS is on by default, so plain HTTP is a redirect. */
    expect(config).toContain("return 301 https://$host$request_uri;");
  });
}

/* ---------------------------- validation ----------------------------- */

test("the site form names the field that is wrong before anything is sent", async ({ page }) => {
  const dialog = await openNewSite(page);
  const create = dialog.getByRole("button", { name: "Create site" });

  /* Nothing filled: one message per required field, at the field. */
  await create.click();
  await expect(dialog.getByText("Pick the host this site runs on.")).toBeVisible();
  await expect(dialog.getByText("Required.", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Must be a domain name, for example example.com.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Site name")).toHaveAttribute("aria-invalid", "true");

  await choose(page, dialog.getByLabel("Server"), HOST);
  await expect(dialog.getByText("Pick the host this site runs on.")).toBeHidden();

  /* The name is a vhost filename, so a space or a slash is refused. */
  await dialog.getByLabel("Site name").fill("not a/filename");
  await expect(
    dialog.getByText(
      "Letters, digits, dots, dashes and underscores only — this is the vhost filename.",
    ),
  ).toBeVisible();
  await dialog.getByLabel("Site name").fill(unique("e2e-valid"));

  /* A bare label is not a domain; neither is an alias with an underscore. */
  await dialog.getByLabel("Primary domain").fill("localhost");
  await expect(
    dialog.getByText("Must be a domain name, for example example.com.", { exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Primary domain").fill("valid.e2e.test");
  await dialog.getByLabel("Additional domains").fill("www.valid.e2e.test, not_a_domain");
  await expect(dialog.getByText('"not_a_domain" is not a domain name.')).toBeVisible();
  await dialog.getByLabel("Additional domains").fill("");

  /* The webroot must be absolute and must not climb out of itself. */
  await dialog.getByLabel("Webroot").fill("var/www/site");
  await expect(dialog.getByText("Must be an absolute path.")).toBeVisible();
  await dialog.getByLabel("Webroot").fill("/var/www/../etc");
  await expect(dialog.getByText("Path traversal is not allowed.")).toBeVisible();
  await dialog.getByLabel("Webroot").fill("/var/www/valid");

  /* A proxy with nowhere to forward to would render a vhost with no target. */
  await dialog.getByLabel("Runtime").selectOption("proxy");
  await expect(dialog.getByText("A proxy site needs an origin to forward to.")).toBeVisible();
  await dialog.getByLabel("Runtime").selectOption("static");

  await dialog.getByLabel("Owner").fill("9-not-posix");
  await expect(dialog.getByText("Must be a POSIX user name.")).toBeVisible();
  await dialog.getByLabel("Owner").fill("");

  /* Boundary: 128 characters is the contract's limit for a name. The form
   * does not count, so the control plane's message lands on the field. */
  await dialog.getByLabel("Site name").fill(`e2e-${"x".repeat(125)}`);
  await create.click();
  await expect(
    dialog.getByText("String must contain at most 128 character(s)", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();

  /* Nothing above reached the host. */
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("the control plane refuses what the form cannot check", async ({ page }) => {
  const forge = await serverNamed(HOST);
  const first = unique("e2e-taken");
  const domain = `${first}.e2e.test`;

  const created = await api<{ job: JobRow }>("POST", "/sites", {
    server_id: forge.id,
    name: first,
    webroot: `/var/www/${first}`,
    runtime: "static",
    primary_domain: domain,
  });
  expect(created.status).toBe(202);
  expect((await settledJob(created.data.job.id)).status).toBe("succeeded");

  /* Same name on the same host: the vhost file would be overwritten. */
  let dialog = await openNewSite(page);
  await choose(page, dialog.getByLabel("Server"), HOST);
  await dialog.getByLabel("Site name").fill(first);
  await dialog.getByLabel("Primary domain").fill(`other-${domain}`);
  await dialog.getByRole("button", { name: "Create site" }).click();
  const clash = dialog.getByRole("alert").filter({ hasText: "conflict" });
  await expect(clash).toContainText(`${HOST} already has a site named "${first}".`);
  /* The remedy is a link to the site that already has the name. */
  await expect(clash.getByRole("link", { name: "Open it" })).toHaveAttribute(
    "href",
    /\/websites\/sites\/[0-9a-f-]{36}$/,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* Same domain on a second site: two vhosts would claim one server_name. */
  dialog = await openNewSite(page);
  await choose(page, dialog.getByLabel("Server"), HOST);
  await dialog.getByLabel("Site name").fill(unique("e2e-second"));
  await dialog.getByLabel("Primary domain").fill(domain);
  await dialog.getByRole("button", { name: "Create site" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "conflict" })).toContainText(
    `${domain} already answers on another site.`,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* And the API holds the line on its own: a proxy with no upstream is a
   * field error even when no form stood in front of it. */
  const noUpstream = await api("POST", "/sites", {
    server_id: forge.id,
    name: unique("e2e-noup"),
    webroot: "/var/www/noup",
    runtime: "proxy",
    primary_domain: `${unique("noup")}.e2e.test`,
  });
  expect(noUpstream.status).toBe(422);
  expect(noUpstream.error?.fields?.["upstream"]).toBe("required for proxy sites");
});

/* ------------------------------- edit -------------------------------- */

test("editing a site rewrites its vhost and attaches the new names", async ({ page }) => {
  const forge = await serverNamed(HOST);
  const name = unique("e2e-edit");
  const domain = `${name}.e2e.test`;
  const created = await api<{ job: JobRow }>("POST", "/sites", {
    server_id: forge.id,
    name,
    webroot: `/var/www/${name}`,
    runtime: "node",
    runtime_version: "20",
    upstream: "http://127.0.0.1:3000",
    primary_domain: domain,
  });
  expect((await settledJob(created.data.job.id)).status).toBe("succeeded");
  const site = await siteNamed(name);

  await page.goto(`/websites/sites/${site.id}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit site" }).click();

  const dialog = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(dialog).toBeVisible();
  /* A site cannot move between hosts, so the host is not offered. */
  await expect(dialog.getByLabel("Server")).toHaveCount(0);
  await expect(dialog.getByLabel("Primary domain")).toHaveValue(domain);
  await dialog.getByLabel("Additional domains").fill(`www.${domain}`);
  await dialog.getByLabel("Upstream origin").fill("http://127.0.0.1:4100");
  await dialog.getByLabel("Redirect HTTP to HTTPS").uncheck();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  const job = drawerJob(page, "Update site", name);
  await expectJobStatus(job, "Succeeded");
  await page.keyboard.press("Escape");

  /* Both names now answer on the site… */
  await page.getByRole("tab", { name: /Domains/ }).click();
  const domains = page.getByRole("table", { name: "Site domains" });
  await expect(rowWith(domains, `www.${domain}`)).toBeVisible();
  await expect(rowWith(domains, domain).first()).toBeVisible();

  /* …and the host's vhost says the same thing, with no HTTP redirect. */
  const config = await vhost(forge.id, site.config_path!);
  expect(config).toContain(`server_name ${domain} www.${domain};`);
  expect(config).toContain("proxy_pass http://127.0.0.1:4100;");
  expect(config).not.toContain("return 301");
});

/* --------------------- reload, and the config test ------------------- */

/*
 * Reloading a broken nginx config takes every site on the host down, so
 * the control plane runs `nginx -t` before it will even queue a reload.
 * The journey breaks a vhost through the file manager's API, as an
 * operator editing by hand would, and expects the reload to be refused
 * with nginx's own words — then fixed, then accepted.
 */
test("a reload is tested first and refused while a vhost is broken", async ({ page }) => {
  const forge = await serverNamed(HOST);
  const name = unique("e2e-reload");
  const created = await api<{ job: JobRow }>("POST", "/sites", {
    server_id: forge.id,
    name,
    webroot: `/var/www/${name}`,
    runtime: "static",
    primary_domain: `${name}.e2e.test`,
  });
  expect((await settledJob(created.data.job.id)).status).toBe("succeeded");
  const site = await siteNamed(name);

  await page.goto(`/websites/sites/${site.id}`);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expectJobStatus(drawerJob(page, "Reload web server", HOST), "Succeeded");
  await page.keyboard.press("Escape");

  const good = await vhost(forge.id, site.config_path!);
  const broken = good.replace("listen 443 ssl http2;", "listen 443 ssl http2");
  const write = async (content: string) => {
    const res = await api<{ job: JobRow }>("POST", "/files/write", {
      server_id: forge.id,
      path: site.config_path,
      content,
    });
    expect(res.status).toBe(202);
    expect((await settledJob(res.data.job.id)).status).toBe("succeeded");
  };
  await write(broken);

  const reloadsBefore = (await get<JobRow[]>(`/jobs?type=site.reload&per_page=200`)).length;
  await page.getByRole("button", { name: "Reload", exact: true }).click();

  const refusal = page.getByRole("alert").filter({ hasText: "is invalid" });
  await expect(refusal).toContainText(
    `The web server configuration on ${HOST} is invalid, so reloading would take every site on the host offline.`,
  );
  /* nginx's own diagnosis, pointing at the file and line that broke. */
  await expect(refusal).toContainText(`directive "listen" is not terminated by ";"`);
  await expect(refusal).toContainText(name);
  /* Refused before queueing: no reload job exists for the broken config. */
  expect((await get<JobRow[]>(`/jobs?type=site.reload&per_page=200`)).length).toBe(reloadsBefore);

  await write(good);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expectJobStatus(drawerJob(page, "Reload web server", HOST), "Succeeded");
});

/* ------------------------------ delete ------------------------------- */

test("deleting a site removes the vhost but keeps its domain", async ({ page }) => {
  const forge = await serverNamed(HOST);
  const name = unique("e2e-delete");
  const domain = `${name}.e2e.test`;
  const created = await api<{ job: JobRow }>("POST", "/sites", {
    server_id: forge.id,
    name,
    webroot: `/var/www/${name}`,
    runtime: "static",
    primary_domain: domain,
  });
  expect((await settledJob(created.data.job.id)).status).toBe("succeeded");
  const site = await siteNamed(name);

  await page.goto(`/websites/sites?q=${name}`);
  const table = page.getByRole("table", { name: "Sites" });
  const row = rowWith(table, name);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete site" }).click();

  const confirm = page.getByRole("dialog", { name: `Delete ${name}?` });
  const remove = confirm.getByRole("button", { name: "Delete site" });
  /* Destructive, so it is armed only by typing the site's name. */
  await expect(remove).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill(name.slice(0, -1));
  await expect(remove).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill(name);
  await remove.click();

  await expectJobStatus(drawerJob(page, "Remove site", name), "Succeeded");
  await page.keyboard.press("Escape");
  await expect(row).toHaveCount(0);

  /* The vhost is gone from the host… */
  const gone = await api("GET", `/files/stat?server_id=${forge.id}&path=${site.config_path}`);
  expect(gone.status).toBe(404);

  /* …and the domain survives, unattached, with its history. */
  const domains = await get<{ name: string; site_id: string | null }[]>(
    `/domains?q=${encodeURIComponent(domain)}`,
  );
  expect(domains).toEqual([expect.objectContaining({ name: domain, site_id: null })]);
});

/* ---------------------------- job failure ---------------------------- */

/*
 * The simulated host already serves a vhost called example.com that
 * Kaname has no row for. Creating a site with that name passes every
 * control-plane check and is refused by the host — the realistic way a
 * create fails. The row must say so rather than pulse "provisioning"
 * for ever.
 */
test("a site the host refuses ends in an error, not stuck provisioning", async ({ page }) => {
  const name = "example.com";
  const dialog = await openNewSite(page);
  await choose(page, dialog.getByLabel("Server"), HOST);
  await dialog.getByLabel("Site name").fill(name);
  await dialog.getByLabel("Primary domain").fill(`${unique("refused")}.e2e.test`);
  await dialog.getByRole("button", { name: "Create site" }).click();

  const job = drawerJob(page, "Create site", name);
  await expectJobStatus(job, "Failed");
  await expect(job).toContainText("already exists");
  await page.keyboard.press("Escape");

  const row = rowWith(page.getByRole("table", { name: "Sites" }), name);
  await expect(row).toContainText("Error");
  await expect(row).not.toContainText("Provisioning");
});

/* ------------------------ navigation and edges ----------------------- */

test("a site that does not exist says so by id", async ({ page }) => {
  await page.goto(`/websites/sites/${missingId}`);
  const error = page.getByRole("alert").filter({ hasText: "not_found" });
  await expect(error).toContainText(`Site ${missingId} not found.`);
  await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a search with no match is an empty state, not an error", async ({ page }) => {
  await page.goto(`/websites/sites?q=${unique("no-such-site")}`);
  await expect(page.getByText("No matches")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rowWith(page.getByRole("table", { name: "Sites" }), "futureforge-www")).toBeVisible();
});

test("the detail tab survives a refresh and Back returns to the list", async ({ page }) => {
  await page.goto("/websites/sites");
  const table = page.getByRole("table", { name: "Sites" });
  await rowWith(table, "futureforge-www").getByText("futureforge-www").click();
  await expect(page).toHaveURL(/\/websites\/sites\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1, name: "futureforge-www" })).toBeVisible();

  await page.getByRole("tab", { name: /Deployments/ }).click();
  await expect(page.getByRole("tab", { name: /Deployments/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.reload();
  await expect(page.getByRole("tab", { name: /Deployments/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("table", { name: "Deployments" })).toBeVisible();

  /* Switching tab replaces the entry rather than pushing one, so a
   * single Back leaves the site, as an operator expects. */
  await page.goBack();
  await expect(page).toHaveURL(/\/websites\/sites$/);
  await expect(table).toBeVisible();
});
