import { expect, test } from "@playwright/test";

/* ------------------------------------------------------------------ *
 * Journey 6 — Yunori Mail Server, from the fleet to the DNS record.
 *
 * Mail is where real setups break, and the two surfaces that matter are
 * the server card (is it installed, what is it waiting on) and the DNS
 * checklist (what exactly must be published). The seed runs a mail
 * server on mail-01 with its DKIM record failing, and the assertion is
 * that the failure arrives with the record to publish, on the clipboard
 * byte for byte.
 *
 * Structure is asserted — roles, labels, the vocabulary in the shared
 * status component — not prose, so copy can move without this breaking.
 * ------------------------------------------------------------------ */

const MAIL_HOST = "mail-01";
const DOMAIN = "futureforge.dev";
/** CHECK_META labels in apps/web/app/(panel)/email/_components/status.tsx. */
const VERDICT_WORDS = /^(Pass|Warn|Fail|Info|Unknown|Healthy|Not checked)$/;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("the seeded mail server shows its health and its install steps", async ({ page }) => {
  await page.goto("/email");
  await expect(page.getByRole("heading", { level: 1, name: "Mail servers" })).toBeVisible();

  /* One card per host, named after the host it runs on. */
  const card = page.locator("section").filter({ hasText: MAIL_HOST }).first();
  await expect(card).toBeVisible();

  /* Two axes, never collapsed: the host's own connection and health come
   * from the fleet, and the mail server carries Yunori's verdict as a
   * separate badge drawn from the check vocabulary. */
  const heading = card.getByRole("heading").first();
  await expect(heading).toContainText(MAIL_HOST);
  const verdict = heading.locator("span").filter({ hasText: VERDICT_WORDS }).last();
  await expect(verdict).toBeVisible();

  /* The install checklist is an ordered list the operator can follow. */
  const steps = card.getByRole("list", { name: "Install steps" });
  await expect(steps).toBeVisible();
  expect(await steps.getByRole("listitem").count()).toBeGreaterThan(0);
});

test("a failing DKIM record hands over the exact value to publish", async ({ page }) => {
  await page.goto("/email/domains");
  await expect(page.getByRole("heading", { level: 1, name: "Mail domains" })).toBeVisible();

  const table = page.getByRole("table", { name: "Mail domains" });
  const row = table.locator("tbody tr").filter({ hasText: DOMAIN }).first();
  await expect(row).toBeVisible();
  await row.click();

  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(DOMAIN);

  /* Anything failing is sorted to the top. The DKIM row is tagged by
   * purpose so an operator does not have to recognise `_domainkey`. */
  const records = drawer.getByRole("list", { name: "DNS records" });
  const dkim = records
    .getByRole("listitem")
    .filter({ hasText: "DKIM" })
    .filter({ hasText: "Fail" })
    .first();
  await expect(dkim).toBeVisible();

  /* The remedy is the record, not prose about it: a copy button whose
   * click puts exactly the expected value on the clipboard. */
  const expected = (await dkim.locator("code[data-record-expected]").textContent()) ?? "";
  expect(expected.length).toBeGreaterThan(0);

  await dkim.getByRole("button", { name: "Copy record value" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

  /* And the whole checklist is one click as a zone file. */
  await expect(drawer.getByRole("button", { name: "Copy zone file" })).toBeVisible();
});
