import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import {
  closeJobDrawer,
  expectJobInDrawer,
  kanameDomain,
  mailDomainNamed,
  mailServerOn,
  owner,
  pickOption,
  rowAction,
  tableRow,
  type JobRow,
  type MailDomainRow,
} from "../support/email.js";

/* ------------------------------------------------------------------ *
 * Email — mail domains and their DNS checklist.
 *
 * The DNS drawer is where real mail setups break, so the assertions are
 * about bytes: the copy buttons put exactly the published value on the
 * clipboard, the zone file is the host's, and "Check DNS now" really
 * re-reads the host (the seed's DKIM selector is replaced by the one the
 * simulated Yunori reports). Then the lifecycle: add a domain and watch
 * the job land; try to remove it while it still has a mailbox and be
 * stopped, with a way forward; empty it and remove it behind a typed
 * confirmation; and the primary domain cannot be removed at all.
 * ------------------------------------------------------------------ */

const MAIL_HOST = "mail-01";
const PRIMARY = "futureforge.dev";
const EXTRA = "panel.futureforge.dev";

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("the DNS drawer copies each record and the zone file byte for byte", async ({ page }) => {
  const api = await owner();
  const domain = (await mailDomainNamed(api, PRIMARY))!;
  const report = await api.data<{ zone_file: string; records: { name: string; expected: string | null }[] }>(
    `/mail-domains/${domain.id}/dns`,
  );

  await page.goto("/email/domains");
  await tableRow(page, "Mail domains", PRIMARY).click();
  const drawer = page.getByRole("dialog").filter({ hasText: "DNS records for" });
  await expect(drawer).toContainText(PRIMARY);

  const records = drawer.getByRole("list", { name: "DNS records" });
  await expect(records.getByRole("listitem")).toHaveCount(report.records.length);

  /* Failing records first, the DKIM one tagged by purpose. */
  const first = records.getByRole("listitem").first();
  await expect(first).toHaveAttribute("data-record-status", "fail");
  const dkim = records.getByRole("listitem").filter({ hasText: "DKIM" }).first();
  await expect(dkim).toHaveAttribute("data-record-status", "fail");
  await expect(dkim).toContainText("found: nothing — public resolvers return no record.");

  const expected = (await dkim.locator("code[data-record-expected]").textContent()) ?? "";
  const dkimRecord = report.records.find((r) => r.name.includes("_domainkey"))!;
  expect(expected).toBe(dkimRecord.expected);
  await dkim.getByRole("button", { name: "Copy record value" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

  await dkim.getByRole("button", { name: `Copy name ${dkimRecord.name}` }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(dkimRecord.name);

  await drawer.getByRole("button", { name: "Copy zone file" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(report.zone_file);
});

test("Check DNS now re-reads the host and the drawer shows its answer", async ({ page }) => {
  const api = await owner();
  const before = (await mailDomainNamed(api, PRIMARY))!;

  await page.goto("/email/domains");
  await tableRow(page, "Mail domains", PRIMARY).click();
  const drawer = page.getByRole("dialog").filter({ hasText: "DNS records for" });
  await drawer.getByRole("button", { name: "Check now" }).click();
  await expectJobInDrawer(page, "Check mail DNS records");
  await closeJobDrawer(page);
  /* The DNS drawer stays open under the job drawer. */
  await expect(drawer).toBeVisible();

  /* What the simulated Yunori publishes: its own DKIM selector (ym1), the
   * full checklist with the optional records, and a zone file it wrote. */
  const after = (await mailDomainNamed(api, PRIMARY))!;
  expect(new Date(after.dns_checked_at!).getTime()).toBeGreaterThan(new Date(before.dns_checked_at!).getTime());
  const report = await api.data<{ zone_file: string; records: { name: string; status: string }[] }>(
    `/mail-domains/${after.id}/dns`,
  );
  expect(report.records.map((r) => r.name)).toContain(`ym1._domainkey.${PRIMARY}`);
  expect(report.zone_file).toContain(`; Yunori Mail Server records for ${PRIMARY}`);

  /* The drawer that was open the whole time refreshed by itself when the
   * job landed; nothing was reopened to see the host's answer. */
  const records = drawer.getByRole("list", { name: "DNS records" });
  await expect(records.getByRole("listitem").filter({ hasText: `ym1._domainkey.${PRIMARY}` })).toHaveAttribute(
    "data-record-status",
    "fail",
  );
  await expect(records.getByRole("listitem")).toHaveCount(report.records.length);
});

test("a domain is added to a mail server and shows the records it still needs", async ({ page }) => {
  const api = await owner();
  expect((await kanameDomain(api, EXTRA)).has_mail).toBe(false);

  await page.goto("/email/domains?new=1");
  const dialog = page.getByRole("dialog", { name: "Add a mail domain" });
  const add = dialog.getByRole("button", { name: "Add domain" });
  await expect(add).toBeDisabled();

  await pickOption(dialog, "Mail server", MAIL_HOST);
  /* A domain that already receives mail cannot be picked twice. */
  await dialog.getByRole("combobox", { name: "Domain", exact: true }).click();
  const taken = page
    .getByRole("listbox", { name: "Domain" })
    .getByRole("option")
    .filter({ has: page.getByText(PRIMARY, { exact: true }) });
  await expect(taken).toHaveAttribute("aria-disabled", "true");
  await expect(taken).toContainText("Already hosts mail");
  await page.keyboard.press("Escape");

  await pickOption(dialog, "Domain", EXTRA);
  await add.click();
  await expect(dialog).toBeHidden();
  await expectJobInDrawer(page, "Add mail domain");
  await closeJobDrawer(page);

  const row = tableRow(page, "Mail domains", EXTRA);
  await expect(row).toContainText("Active");
  await expect(row).toContainText("Fail");
  await expect(row).not.toContainText("Primary");

  const added = (await mailDomainNamed(api, EXTRA))!;
  expect(added).toMatchObject({ status: "active", dns_status: "fail", is_primary: false, server_name: MAIL_HOST });
  expect((await kanameDomain(api, EXTRA)).has_mail).toBe(true);

  /* Nothing is published yet for a brand-new domain. */
  await row.click();
  const drawer = page.getByRole("dialog").filter({ hasText: "DNS records for" });
  await expect(drawer).toContainText("required records are still missing");
  await expect(drawer.getByRole("list", { name: "DNS records" }).getByRole("listitem").first()).toHaveAttribute(
    "data-record-status",
    "fail",
  );
  await page.keyboard.press("Escape");

  /* Adding it twice is refused by the control plane, not only the picker. */
  const again = await api.post("/mail-domains", {
    domain_id: added.domain_id,
    server_id: added.server_id,
  });
  expect(again.status).toBe(409);
  expect(again.body.error?.message).toBe(`${EXTRA} already hosts mail.`);
});

test("removing a domain is refused while it has mailboxes, then works behind a typed confirmation", async ({
  page,
}) => {
  const api = await owner();
  const domain = (await mailDomainNamed(api, EXTRA))!;

  const created = await api.post<{ mailbox: { id: string; address: string } }>("/mailboxes", {
    mail_domain_id: domain.id,
    local_part: "blocker",
  });
  expect(created.status, created.text).toBe(201);
  const blocker = created.body.data!.mailbox;

  /* The API refuses and says what to delete. */
  const refused = await api.del(`/mail-domains/${domain.id}`);
  expect(refused.status).toBe(409);
  expect(refused.body.error?.message).toBe(`${EXTRA} still has 1 mailbox(es) and 0 alias(es).`);
  expect((await mailDomainNamed(api, EXTRA))?.status).toBe("active");

  /* The dialog says the same and offers the way forward, not a removal. */
  await page.goto("/email/domains");
  const row = tableRow(page, "Mail domains", EXTRA);
  await rowAction(page, row, "Remove from server");
  const blocked = page.getByRole("dialog", { name: `Remove ${EXTRA} from ${MAIL_HOST}?` });
  await expect(blocked).toContainText(`${EXTRA} still has 1 mailbox and 0 aliases. Delete them first`);
  await expect(blocked.getByRole("textbox")).toHaveCount(0);
  await blocked.getByRole("button", { name: "Open its mailboxes" }).click();
  await expect(page).toHaveURL(new RegExp(`/email/mailboxes\\?mail_domain_id=${domain.id}`));
  const mailboxes = page.getByRole("table", { name: "Mailboxes" }).locator("tbody tr");
  await expect(mailboxes).toHaveCount(1);
  await expect(mailboxes.first()).toContainText(blocker.address);

  /* Empty it. */
  const removal = await api.del<{ job: JobRow }>(`/mailboxes/${blocker.id}`);
  expect((await api.job(removal.body.data!.job.id)).status).toBe("succeeded");

  /* Now the removal is armed only by the exact name. */
  await page.goto("/email/domains");
  await rowAction(page, tableRow(page, "Mail domains", EXTRA), "Remove from server");
  const confirm = page.getByRole("dialog", { name: `Remove ${EXTRA} from ${MAIL_HOST}?` });
  const remove = confirm.getByRole("button", { name: "Remove domain" });
  await expect(remove).toBeDisabled();
  await confirm.getByLabel(`Type ${EXTRA} to confirm`).fill(PRIMARY);
  await expect(remove).toBeDisabled();
  await confirm.getByLabel(`Type ${EXTRA} to confirm`).fill(EXTRA);
  await remove.click();
  await expectJobInDrawer(page, "Remove mail domain");
  await closeJobDrawer(page);

  await expect(tableRow(page, "Mail domains", EXTRA)).toHaveCount(0);
  expect(await mailDomainNamed(api, EXTRA)).toBeUndefined();
  expect((await api.get(`/mail-domains/${domain.id}`)).status).toBe(404);
  /* The Kaname domain stays; it just no longer hosts mail. */
  expect((await kanameDomain(api, EXTRA)).has_mail).toBe(false);
});

test("the primary domain cannot be removed", async ({ page }) => {
  const api = await owner();
  const primary = (await mailDomainNamed(api, PRIMARY))!;
  expect(primary.is_primary).toBe(true);

  await page.goto("/email/domains");
  const row = tableRow(page, "Mail domains", PRIMARY);
  await expect(row).toContainText("Primary");
  await row.getByRole("button", { name: "Row actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove from server" })).toBeDisabled();
  await page.keyboard.press("Escape");

  const refused = await api.del(`/mail-domains/${primary.id}`);
  expect(refused.status).toBe(409);
  expect(refused.body.error?.message).toBe(`${PRIMARY} is the domain this mail server was installed with.`);
  expect((await mailDomainNamed(api, PRIMARY))?.status).toBe("active");
});

test("filters live in the URL, survive a reload and come back with Back", async ({ page }) => {
  const api = await owner();
  const mail = (await mailServerOn(api, MAIL_HOST))!;

  await page.goto("/email/domains");
  await page.getByRole("combobox", { name: "DNS" }).selectOption("pass");
  await expect(page).toHaveURL(/dns_status=pass/);
  const listed = await api.data<MailDomainRow[]>("/mail-domains?dns_status=pass&per_page=100");
  const rows = page.getByRole("table", { name: "Mail domains" }).locator("tbody tr");
  if (listed.length > 0) await expect(rows).toHaveCount(listed.length);
  else await expect(page.getByRole("table", { name: "Mail domains" })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "DNS" })).toHaveValue("pass");

  await page.goto(`/email/domains?server_id=${mail.server_id}`);
  await expect(page.getByText(mail.hostname!, { exact: true }).first()).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/dns_status=pass/);
  await expect(page.getByRole("combobox", { name: "DNS" })).toHaveValue("pass");
});

test("a mail domain that does not exist answers 404 everywhere", async () => {
  const api = await owner();
  for (const path of [`/mail-domains/${missingId}`, `/mail-domains/${missingId}/dns`]) {
    const res = await api.get(path);
    expect(res.status, path).toBe(404);
    expect(res.body.error?.code).toBe("not_found");
  }
  expect((await api.post(`/mail-domains/${missingId}/dns/check`)).status).toBe(404);
  expect((await api.del(`/mail-domains/${missingId}`)).status).toBe(404);
});
