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
 * ------------------------------------------------------------------ */

const HOST_SPF_RECORD = 'mail.futureforge.dev. 3600 IN TXT "v=spf1 a -all"';
const PROXY_RECORD = "mail.futureforge.dev.\t300\tIN\tA\t198.51.100.42";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("the failing checks explain themselves and hand over the record", async ({ page }) => {
  await page.goto("/email/authentication");
  await expect(page.getByRole("heading", { level: 1, name: "DNS Authentication" })).toBeVisible();

  /* Anything not passing opens itself — the operator came here because
   * something is wrong, not to admire the green rows. */
  const hostSpf = page.locator("#check-host_spf");
  await expect(hostSpf).toBeVisible();
  await expect(hostSpf).toContainText("Fail");
  await expect(hostSpf).toContainText("Mail host has no SPF record of its own");
  await expect(hostSpf).toContainText("Receivers check the HELO name");
  await expect(hostSpf).toContainText(HOST_SPF_RECORD);

  const proxy = page.locator("#check-proxy_exposure");
  await expect(proxy).toBeVisible();
  await expect(proxy).toContainText("Fail");
  await expect(proxy).toContainText("Mail host is behind a proxy");
  await expect(proxy).toContainText("Cloudflare proxy");
  await expect(proxy).toContainText("198.51.100.42");
  await expect(proxy).toContainText("The mail hostname must be DNS-only");

  /* The remediation is not prose about what to do — it is the record,
   * one click from the clipboard, byte for byte including the tabs a
   * zone file wants. */
  await hostSpf.getByRole("button", { name: "Copy Copy record" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(HOST_SPF_RECORD);

  await proxy.getByRole("button", { name: "Copy Copy record" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROXY_RECORD);

  /* The rollup counts the same two failures the rows show. */
  const failures = page.locator("dl > div").filter({ hasText: /^Fail/ }).first();
  await expect(failures.locator("dd")).toHaveText("2");
});
