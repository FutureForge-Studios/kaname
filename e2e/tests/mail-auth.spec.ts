import { expect, test } from "@playwright/test";

/* ------------------------------------------------------------------ *
 * Journey 6 — mail DNS authentication.
 *
 * PLAN.md 7 calls this out as the place real setups break, and names
 * the two failures that cost people weeks: the mail hostname has no SPF
 * record of its own, and it resolves into a CDN proxy range so SMTP
 * never arrives. Both are seeded failing, and both have to arrive with
 * the exact record to publish, on the clipboard — a raw zone dump tells
 * an operator nothing `dig` would not.
 *
 * What is asserted is the engine's own vocabulary — the titles in
 * MAIL_AUTH_CHECK_META and the zone-file record shape MailAuthChecker
 * emits — not prose that only the seed knows. The seed is written in
 * that vocabulary on purpose, so a change to the engine's output that
 * the seed does not follow shows up here. (This package does not depend
 * on @kaname/contract, so the titles are repeated rather than imported.)
 * ------------------------------------------------------------------ */

const MAIL_HOST = "mail.futureforge.dev";
/** MAIL_AUTH_CHECK_META.host_spf.title and .proxy_exposure.title. */
const HOST_SPF_TITLE = "Mail host SPF";
const PROXY_TITLE = "Proxy exposure";
/** The engine's `record()` shape: name, TTL, class, type, value — tab separated. */
const HOST_SPF_EXPECTED = `${MAIL_HOST}.\t3600\tIN\tTXT\t"v=spf1 a -all"`;
/** The host SPF fix is copied as the bare value: it goes in a TXT field, not a zone file. */
const HOST_SPF_COPY = "v=spf1 a -all";
const PROXY_RECORD = `${MAIL_HOST}.\t3600\tIN\tA\t198.51.100.42   ; DNS only, never proxied`;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("the failing checks explain themselves and hand over the record", async ({ page }) => {
  await page.goto("/email/authentication");
  await expect(page.getByRole("heading", { level: 1, name: "DNS Authentication" })).toBeVisible();

  /* The report names the vantage point that answered: the mail host's
   * own resolver, which is the one Postfix will act on. */
  await expect(page.getByText("host:mail-01")).toBeVisible();

  /* Anything not passing opens itself — the operator came here because
   * something is wrong, not to admire the green rows. */
  const hostSpf = page.locator("#check-host_spf");
  await expect(hostSpf).toBeVisible();
  await expect(hostSpf).toContainText("Fail");
  await expect(hostSpf).toContainText(HOST_SPF_TITLE);
  await expect(hostSpf).toContainText(`${MAIL_HOST} publishes no SPF record of its own`);
  await expect(hostSpf).toContainText("falls back to the HELO identity");
  await expect(hostSpf).toContainText(HOST_SPF_EXPECTED);

  const proxy = page.locator("#check-proxy_exposure");
  await expect(proxy).toBeVisible();
  await expect(proxy).toContainText("Fail");
  await expect(proxy).toContainText(PROXY_TITLE);
  await expect(proxy).toContainText("belongs to Cloudflare's proxy network");
  await expect(proxy).toContainText("104.21.34.12");
  await expect(proxy).toContainText("so it goes DNS-only");

  /* The remediation is not prose about what to do — it is the record,
   * one click from the clipboard, byte for byte including the tabs a
   * zone file wants. */
  await hostSpf.getByRole("button", { name: "Copy Copy record" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(HOST_SPF_COPY);

  await proxy.getByRole("button", { name: "Copy Copy record" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROXY_RECORD);

  /* The rollup counts the same two failures the rows show. */
  const failures = page.locator("dl > div").filter({ hasText: /^Fail/ }).first();
  await expect(failures.locator("dd")).toHaveText("2");
});
