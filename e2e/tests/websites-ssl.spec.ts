import { expect, test, type Page } from "@playwright/test";
import { missingId } from "../support/config.js";
import { sectionNamed } from "../support/ui.js";
import {
  api,
  choose,
  drawerJob,
  expectJobStatus,
  field,
  get,
  rowWith,
  settledJob,
  unique,
  type JobRow,
  serverNamed,
} from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — SSL / TLS.
 *
 * ACME runs on the host, so issue, renew and revoke are jobs. What is
 * asserted is the certificate's own state after the job — status, the
 * challenge that was used, an expiry pushed out — and, when a renewal
 * fails, that the failure is recorded on the certificate where the SSL
 * page and the Command Center can see it, instead of the row sitting
 * on "pending" with the reason buried in a job log.
 *
 * Not covered: installing a custom (externally issued) certificate.
 * The agent implements cert.install, but no route or dialog reaches it,
 * so there is no PEM to validate yet.
 * ------------------------------------------------------------------ */

const HOST = "forge-01";

interface CertRow {
  id: string;
  subject: string;
  status: string;
  challenge: string;
  sans: string[];
  days_remaining: number | null;
  expires_at: string | null;
  auto_renew: boolean;
  last_error: { code: string; message: string } | null;
}

interface DomainRow {
  id: string;
  name: string;
}

/** A static site on forge-01 with its own domain, ready for an http-01 order. */
async function siteWithDomain(): Promise<{ siteId: string; webroot: string; domain: DomainRow }> {
  const forge = await serverNamed(HOST);
  const name = unique("e2e-tls");
  const created = await api<{ job: JobRow }>("POST", "/sites", {
    server_id: forge.id,
    name,
    webroot: `/var/www/${name}`,
    runtime: "static",
    primary_domain: `${name}.e2e.test`,
  });
  expect((await settledJob(created.data.job.id)).status).toBe("succeeded");
  const site = (await get<{ id: string; name: string }[]>(`/sites?q=${name}`)).find(
    (s) => s.name === name,
  )!;
  const domain = (await get<DomainRow[]>(`/domains?q=${name}.e2e.test`))[0]!;
  return { siteId: site.id, webroot: `/var/www/${name}`, domain };
}

async function certificateFor(subject: string): Promise<CertRow> {
  const rows = await get<CertRow[]>(`/certificates?q=${encodeURIComponent(subject)}&per_page=50`);
  const row = rows.find((c) => c.subject === subject);
  if (!row) throw new Error(`no certificate for ${subject}`);
  return row;
}

/** Issues over the API and waits; for journeys that start from a certificate. */
async function issued(domain: DomainRow, challenge = "http-01"): Promise<CertRow> {
  const forge = await serverNamed(HOST);
  const res = await api<{ job: JobRow }>("POST", "/certificates", {
    domain_id: domain.id,
    server_id: forge.id,
    challenge,
    contact_email: "ops@e2e.test",
  });
  expect(res.status, res.error?.message).toBe(202);
  expect((await settledJob(res.data.job.id)).status).toBe("succeeded");
  return certificateFor(domain.name);
}

function certificateJob(page: Page) {
  return sectionNamed(page, "Certificate job");
}

/* ------------------------------- issue ------------------------------- */

test("an http-01 certificate is issued from the site and served from its webroot", async ({
  page,
}) => {
  const { siteId, webroot, domain } = await siteWithDomain();
  await page.goto(`/websites/sites/${siteId}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Issue certificate" }).click();

  const dialog = page.getByRole("dialog", { name: `Issue a certificate for ${domain.name}` });
  await expect(dialog).toBeVisible();
  /* Prefilled from where it was opened: the site's domain and host, and
   * the signed-in operator as the ACME contact. */
  await expect(field(dialog, "Server")).toHaveValue(HOST);
  await expect(field(dialog, "Contact email")).not.toHaveValue("");
  await expect(field(dialog, "Challenge")).toHaveValue("http-01");
  /* A manual zone cannot publish a dns-01 record in time, so it is not offered. */
  await expect(dialog.getByRole("option", { name: "dns-01 (DNS record)" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Request certificate" }).click();
  await expect(dialog).toBeHidden();

  const job = drawerJob(page, "Issue certificate", domain.name);
  await expectJobStatus(job, "Succeeded");
  /* certbot's own account of the challenge, from the host's webroot. */
  await expect(job.getByRole("log")).toContainText(
    `http-01 challenge for ${domain.name} served from ${webroot}`,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: /SSL/ }).click();
  const table = page.getByRole("table", { name: "Site certificates" });
  await expect(rowWith(table, domain.name)).toContainText("Active");

  const cert = await certificateFor(domain.name);
  expect(cert.status).toBe("active");
  expect(cert.challenge).toBe("http-01");
  expect(cert.days_remaining).toBeGreaterThanOrEqual(88);
});

test("a dns-01 certificate is issued for an API-driven zone without a site", async ({ page }) => {
  const forge = await serverNamed(HOST);
  const name = `${unique("wild")}.e2e.test`;
  const created = await api<DomainRow>("POST", "/domains", {
    name,
    server_id: forge.id,
    dns_provider: "cloudflare",
  });
  expect(created.status).toBe(201);

  await page.goto("/websites/ssl");
  await expect(page.getByRole("heading", { level: 1, name: "SSL / TLS" })).toBeVisible();
  await page.getByRole("button", { name: "Issue certificate" }).first().click();
  const dialog = page.getByRole("dialog", { name: /^Issue a certificate/ });
  await choose(page, field(dialog, "Domain"), name);
  await expect(field(dialog, "Server")).toHaveValue(HOST);
  await field(dialog, "Additional names").fill("");
  await field(dialog, "Challenge").selectOption("dns-01");
  await field(dialog, "Key type").selectOption("rsa");
  await dialog.getByRole("button", { name: "Request certificate" }).click();
  await expect(dialog).toBeHidden();

  const job = drawerJob(page, "Issue certificate", name);
  await expectJobStatus(job, "Succeeded");
  await expect(job.getByRole("log")).toContainText(`_acme-challenge.${name}`);
  await page.keyboard.press("Escape");

  const row = rowWith(page.getByRole("table", { name: "Certificates" }), name);
  await expect(row).toContainText("Active");
  const cert = await certificateFor(name);
  expect(cert.challenge).toBe("dns-01");
});

test("issuance that cannot work is refused before an ACME order is spent", async ({ page }) => {
  const forge = await serverNamed(HOST);

  /* http-01 needs a webroot, so a domain with no site has nothing to serve from. */
  const lonely = await api<DomainRow>("POST", "/domains", {
    name: `${unique("lonely")}.e2e.test`,
    server_id: forge.id,
  });
  await page.goto("/websites/ssl");
  await page.getByRole("button", { name: "Issue certificate" }).first().click();
  const dialog = page.getByRole("dialog", { name: /^Issue a certificate/ });

  /* Field checks first. */
  await field(dialog, "Contact email").fill("not-an-address");
  await dialog.getByRole("button", { name: "Request certificate" }).click();
  await expect(dialog.getByText("Pick the domain this certificate covers.")).toBeVisible();
  await expect(dialog.getByText("Let's Encrypt sends expiry warnings here.")).toBeVisible();

  await choose(page, field(dialog, "Domain"), lonely.data.name);
  await field(dialog, "Additional names").fill("ok.e2e.test, not_valid");
  await expect(dialog.getByText('"not_valid" is not a domain name.')).toBeVisible();
  await field(dialog, "Additional names").fill("");
  await field(dialog, "Contact email").fill("ops@e2e.test");
  await dialog.getByRole("button", { name: "Request certificate" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "precondition_failed" })).toContainText(
    `${lonely.data.name} is not attached to a site, so there is no webroot to serve the http-01 challenge from.`,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* dns-01 on a manual zone: the API refuses it even without the form. */
  const manualDns = await api("POST", "/certificates", {
    domain_id: lonely.data.id,
    server_id: forge.id,
    challenge: "dns-01",
    contact_email: "ops@e2e.test",
  });
  expect(manualDns.status).toBe(412);
  expect(manualDns.error?.message).toContain("uses manual DNS");

  /* A second certificate for a name the host already holds is a renewal. */
  const { domain } = await siteWithDomain();
  await issued(domain);
  const duplicate = await api("POST", "/certificates", {
    domain_id: domain.id,
    server_id: forge.id,
    contact_email: "ops@e2e.test",
  });
  expect(duplicate.status).toBe(409);
  expect(duplicate.error?.message).toBe(`${HOST} already holds a certificate for ${domain.name}.`);

  /* None of the refusals left a row behind. */
  const rows = await get<CertRow[]>(`/certificates?q=${lonely.data.name}`);
  expect(rows).toEqual([]);
});

/* ------------------------------- renew ------------------------------- */

test("renewing pushes the expiry out and is shown in place", async ({ page }) => {
  const { domain } = await siteWithDomain();
  const before = await issued(domain);

  await page.goto(`/websites/ssl/${before.id}`);
  await expect(page.getByRole("heading", { level: 1, name: domain.name })).toBeVisible();
  await page.getByRole("button", { name: "Renew now" }).first().click();

  const panel = certificateJob(page);
  await expectJobStatus(panel, "Succeeded");
  await expect(panel.getByRole("log")).toContainText("Renewal successful");

  const after = await certificateFor(domain.name);
  expect(after.status).toBe("active");
  expect(new Date(after.expires_at!).getTime()).toBeGreaterThan(
    new Date(before.expires_at!).getTime(),
  );
  expect(after.last_error).toBeNull();
});

test("a renewal the host refuses is recorded on the certificate, not left pending", async ({
  page,
}) => {
  const { domain } = await siteWithDomain();
  const cert = await issued(domain);

  /* Not forced and 90 days out: certbot declines. That is a failure of
   * this job, and the certificate on disk is still the live one. */
  const res = await api<{ job: JobRow }>("POST", `/certificates/${cert.id}/renew`, {
    force: false,
  });
  expect(res.status).toBe(202);
  const job = await settledJob(res.data.job.id);
  expect(job.status).toBe("failed");
  expect(job.error?.message).toContain("is not due for renewal");

  const after = await certificateFor(domain.name);
  expect(after.status).toBe("active");
  expect(after.last_error?.message).toContain("is not due for renewal");

  await page.goto(`/websites/ssl/${cert.id}`);
  await expect(page.getByText("Active").first()).toBeVisible();
  await expect(page.getByText("Pending")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "issuance_failed" })).toContainText(
    "is not due for renewal",
  );
});

/* ------------------------------- revoke ------------------------------ */

test("revoking a certificate ends its life and disables renewal", async ({ page }) => {
  const { domain } = await siteWithDomain();
  const cert = await issued(domain);

  await page.goto(`/websites/ssl/${cert.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Revoke certificate" }).click();
  const confirm = page.getByRole("dialog", { name: `Revoke ${domain.name}?` });
  await expect(confirm.getByRole("button", { name: "Revoke certificate" })).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill(domain.name);
  await confirm.getByRole("button", { name: "Revoke certificate" }).click();

  await expectJobStatus(certificateJob(page), "Succeeded");
  await expect(page.getByText("Revoked").first()).toBeVisible();
  for (const renew of await page.getByRole("button", { name: "Renew now" }).all()) {
    await expect(renew).toBeDisabled();
  }
  expect((await certificateFor(domain.name)).status).toBe("revoked");

  /* And the API agrees there is nothing left to renew or revoke. */
  expect((await api("POST", `/certificates/${cert.id}/renew`, {})).status).toBe(409);
  expect((await api("POST", `/certificates/${cert.id}/revoke`, {})).status).toBe(409);
});

/* ---------------------- auto-renew and its filter -------------------- */

test("turning auto-renew off is saved and the renewal filter finds it", async ({ page }) => {
  const { domain } = await siteWithDomain();
  await issued(domain);

  await page.goto(`/websites/ssl?q=${domain.name}`);
  const table = page.getByRole("table", { name: "Certificates" });
  const toggle = table.getByRole("switch", { name: `Automatic renewal for ${domain.name}` });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await certificateFor(domain.name)).auto_renew).toBe(false);

  /* "Auto-renew off" has to mean false: a query "false" read as true
   * returned the opposite set. */
  await page.goto("/websites/ssl");
  await page.getByRole("combobox", { name: "Renewal" }).selectOption("false");
  await expect(rowWith(table, domain.name)).toBeVisible();
  /* Every row of the settled, filtered page — not of the page before it. */
  await expect
    .poll(
      async () => {
        const rows = await table.locator("tbody tr").all();
        const states = await Promise.all(
          rows.map((row) =>
            row
              .getByRole("switch")
              .isChecked({ timeout: 1_000 })
              .catch(() => null),
          ),
        );
        return states.length > 0 && states.every((checked) => checked === false);
      },
      { message: '"Auto-renew off" listed a certificate that renews automatically' },
    )
    .toBe(true);
  await page.getByRole("combobox", { name: "Renewal" }).selectOption("true");
  await expect(rowWith(table, domain.name)).toHaveCount(0);
});

/* ----------------------- the Command Center view --------------------- */

/*
 * The seed ships shop.futureforge.dev three days from expiry and
 * docs.forgebase.dev eleven days out. Both belong in "Certificates
 * expiring"; only the three-day one is the operator's problem today,
 * because the other is still inside an auto-renew window that has not
 * failed. Following the attention item has to land on that certificate.
 */
test("expiring certificates surface on the Command Center and link to themselves", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Command Center" })).toBeVisible();

  const expiring = sectionNamed(page, "Certificates expiring");
  const shop = expiring.getByRole("listitem").filter({ hasText: "shop.futureforge.dev" });
  await expect(shop).toContainText(/[23] days/);
  await expect(
    expiring.getByRole("listitem").filter({ hasText: "docs.forgebase.dev" }),
  ).toContainText(/1[01] days/);

  const attention = sectionNamed(page, "Needs attention");
  const item = attention.getByRole("link", {
    name: /Certificate for shop\.futureforge\.dev expires in [23] days/,
  });
  await expect(item).toBeVisible();
  await expect(
    attention.getByRole("link", { name: /Certificate for docs\.forgebase\.dev/ }),
  ).toHaveCount(0);

  await item.click();
  const shopCert = await certificateFor("shop.futureforge.dev");
  await expect(page).toHaveURL(new RegExp(`/websites/ssl/${shopCert.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "shop.futureforge.dev" })).toBeVisible();
  /* Replaced, not pushed: Back is the Command Center, not a bounce. */
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Command Center" })).toBeVisible();
});

/*
 * The seeded certificates have no files on the simulated host, which is
 * what a certificate deleted behind Kaname's back looks like. Renewing
 * one fails on the host; the failure must reach the certificate and the
 * Command Center's attention item, which is how an operator learns that
 * "auto-renew" is not going to save it.
 */
test("a failed renewal of an expiring certificate is visible where it is triaged", async ({
  page,
}) => {
  const shop = await certificateFor("shop.futureforge.dev");
  await page.goto(`/websites/ssl/${shop.id}`);
  await page.getByRole("button", { name: "Renew now" }).first().click();
  await expectJobStatus(certificateJob(page), "Failed");

  const after = await certificateFor("shop.futureforge.dev");
  expect(after.status).not.toBe("pending");
  expect(after.last_error?.message).toContain("shop.futureforge.dev");
  await expect(page.getByText("Pending")).toHaveCount(0);

  await page.goto("/");
  const attention = sectionNamed(page, "Needs attention");
  const item = attention
    .getByRole("listitem")
    .filter({ hasText: "Certificate for shop.futureforge.dev" });
  await expect(item).toContainText("Last renewal failed");
});

test("a certificate that does not exist says so by id", async ({ page }) => {
  await page.goto(`/websites/ssl/${missingId}`);
  await expect(page.getByRole("alert").filter({ hasText: "not_found" })).toContainText(
    `Certificate ${missingId} not found.`,
  );
});
