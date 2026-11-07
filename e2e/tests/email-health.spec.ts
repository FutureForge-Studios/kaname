import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import {
  closeJobDrawer,
  definition,
  expectJobInDrawer,
  mailServerOn,
  owner,
  serverCard,
  type JobRow,
} from "../support/email.js";
import { sectionNamed } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Email — health, certificate, preflight, update and the live tail.
 *
 * Health is Yunori's own `doctor` verdict, so the proof that the page is
 * honest is that "Check now" replaces the seed's checks with the ones
 * the simulated host reports (a Spamhaus ZEN listing, the PTR warning).
 * Preflight is the one live read that is not a job, run only when asked.
 * The tail is a journal stream off the host: lines arrive, a filter is
 * applied on the host, and stopping really stops it.
 * ------------------------------------------------------------------ */

const MAIL_HOST = "mail-01";

test.describe.configure({ mode: "serial" });

test("Check now runs doctor on the host and the page shows its verdict", async ({ page }) => {
  const api = await owner();
  const row = (await mailServerOn(api, MAIL_HOST))!;
  await page.goto(`/email/health?server_id=${row.server_id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Mail health" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Mail server" })).toHaveValue(MAIL_HOST);

  await page.getByRole("button", { name: "Check now" }).click();
  await expectJobInDrawer(page, "Check mail server");
  await closeJobDrawer(page);

  const synced = (await mailServerOn(api, MAIL_HOST))!;
  expect(synced.checks.map((c) => c.id)).toContain("dnsbl_spamhaus");
  expect(synced.health).toBe("fail");

  const checks = sectionNamed(page, "Checks");
  const zen = checks.getByRole("listitem").filter({ hasText: "Spamhaus ZEN" });
  await expect(zen).toContainText("Fail");
  await expect(zen).toContainText("Request removal at check.spamhaus.org");
  await expect(checks.getByRole("listitem").filter({ hasText: "Reverse DNS (PTR)" })).toContainText("Warn");
  await expect(page.getByText(/host read/)).toContainText(/just now|\ds ago/);

  /* Passing checks are folded away, and unfold. */
  const passing = synced.checks.filter((c) => c.status === "pass").length;
  await checks.getByRole("button", { name: `Show ${passing} passing checks` }).click();
  await expect(checks.getByRole("listitem").filter({ hasText: "Service stalwart" })).toContainText("Pass");
});

test("the certificate card reads the host's certificate and renews it as a job", async ({ page }) => {
  const api = await owner();
  const row = (await mailServerOn(api, MAIL_HOST))!;
  await page.goto(`/email/health?server_id=${row.server_id}`);

  const card = sectionNamed(page, "Certificate");
  expect(row.certificate?.covers).toEqual(["mail.futureforge.dev"]);
  await expect(definition(card, "State")).toContainText("Valid");
  await expect(definition(card, "State")).toContainText(`${row.certificate!.days_left} days left`);
  await expect(definition(card, "Covers")).toContainText("mail.futureforge.dev");
  await expect(definition(card, "Authority")).toHaveText("letsencrypt");

  await card.getByRole("button", { name: "Renew now" }).click();
  const entry = await expectJobInDrawer(page, "Renew mail certificate");
  await expect(entry).toContainText(MAIL_HOST);
  await closeJobDrawer(page);

  const jobs = await api.data<JobRow[]>(`/jobs?type=mail.certificate.renew&server_id=${row.server_id}&per_page=1`);
  expect(jobs[0]?.status).toBe("succeeded");
  expect(jobs[0]?.result).toMatchObject({ outcome: expect.stringContaining("nothing to do") });
  expect(await api.jobLog(jobs[0]!.id)).toContain("Checking the certificate for mail.futureforge.dev");
});

test("preflight runs on the live host only when asked", async ({ page }) => {
  const api = await owner();
  const row = (await mailServerOn(api, MAIL_HOST))!;
  await page.goto(`/email/health?server_id=${row.server_id}`);

  const card = page.locator("section").filter({ has: page.getByRole("button", { name: "Preflight" }) });
  await card.getByRole("button", { name: "Preflight" }).click();
  await expect(card).toContainText("Nothing has run yet.");

  const ran = page.waitForResponse((res) => res.url().includes(`/mail-servers/${row.id}/preflight`));
  await card.getByRole("button", { name: "Run preflight" }).click();
  expect((await ran).status()).toBe(200);

  await expect(card.getByRole("listitem").filter({ hasText: "Outbound port 25" })).toContainText("Info");
  await expect(card.getByRole("listitem").filter({ hasText: "Mail hostname" })).toContainText(
    "mail.futureforge.dev resolves to 198.51.100.42",
  );
  await expect(card.getByText(/ran .* on/)).toContainText(MAIL_HOST);
  await expect(card.getByRole("button", { name: "Run again" })).toBeVisible();

  /* It is not a job: nothing was queued for it. */
  const preflight = await api.get(`/mail-servers/${row.id}/preflight`);
  expect(preflight.status).toBe(200);
  expect((preflight.body.data as { checks: unknown[] }).checks.length).toBe(9);
});

test("Update yunori-mail runs as a job and reports what the host said", async ({ page }) => {
  const api = await owner();
  await page.goto("/email");
  const card = serverCard(page, MAIL_HOST);
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Update yunori-mail" }).click();
  await expectJobInDrawer(page, "Update Yunori Mail Server");
  await closeJobDrawer(page);

  const row = (await mailServerOn(api, MAIL_HOST))!;
  const job = (await api.data<JobRow[]>(`/jobs?type=mail.server.update&server_id=${row.server_id}&per_page=1`))[0]!;
  expect(job.status).toBe("succeeded");
  expect(await api.jobLog(job.id)).toContain(`${row.version} is the latest release; nothing to do`);
  await expect(card.getByText(row.version!, { exact: true })).toBeVisible();
});

test("the live tail streams the host's journal as messages, filters on the host and stops", async ({ page }) => {
  const api = await owner();
  const row = (await mailServerOn(api, MAIL_HOST))!;
  await page.goto(`/email/logs?server_id=${row.server_id}`);

  const viewer = page.getByRole("log", { name: `Mail log on ${MAIL_HOST}` });
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(viewer).toContainText("stalwart-mail");
  /* A line is the journal message, not the JSON record it travelled in. */
  await expect(viewer).not.toContainText('"cursor"');
  await expect(viewer).not.toContainText('{"ts"');

  await page.getByLabel("Filter the tail on the host").fill("dkim.pass");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(viewer).toContainText("DKIM verification passed");
  await expect(viewer).not.toContainText("Message delivered");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(viewer).toContainText("The tail is stopped.");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(viewer).toContainText("DKIM verification passed");
});

test("a deep link to a mail server that is not there says so instead of showing another", async ({ page }) => {
  await page.goto(`/email/health?server_id=${missingId}`);
  await expect(page.getByText("No mail server matches this link")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`server_id=${missingId}`));
  await page.getByRole("button", { name: `Show ${MAIL_HOST}` }).click();
  await expect(page.getByRole("combobox", { name: "Mail server" })).toHaveValue(MAIL_HOST);

  await page.goto(`/email/logs?server_id=${missingId}`);
  await expect(page.getByText("No mail server matches this link")).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);

  const api = await owner();
  expect((await api.get(`/mail-servers/${missingId}`)).status).toBe(404);
  expect((await api.get(`/mail-servers/${missingId}/preflight`)).status).toBe(404);
  expect((await api.post(`/mail-servers/${missingId}/sync`)).status).toBe(404);
  expect((await api.get(`/mail-logs/tail?server_id=${missingId}`)).status).toBe(404);
});
