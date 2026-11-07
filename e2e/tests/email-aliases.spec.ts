import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import {
  aliasAt,
  closeJobDrawer,
  expectJobInDrawer,
  mailboxAt,
  owner,
  pickOption,
  rowAction,
  syncMail,
  tableRow,
  unique,
} from "../support/email.js";

/* ------------------------------------------------------------------ *
 * Email — aliases.
 *
 * An alias is one more address delivering into a mailbox on the same
 * server. The interesting cases are the ones Yunori refuses: an alias
 * that would shadow a mailbox, a second alias with the same address, a
 * local part that is not one. Creating and removing are jobs, and the
 * assertions are on what the host and the rows say afterwards.
 * ------------------------------------------------------------------ */

const DOMAIN = "futureforge.dev";
const TARGET = `hello@${DOMAIN}`;

test.describe.configure({ mode: "serial" });

const local = unique("e2e-alias");
const address = `${local}@${DOMAIN}`;

test.beforeAll(async () => {
  await syncMail(await owner(), "mail-01");
});

test("an alias is created as a job and delivers into the mailbox it names", async ({ page }) => {
  await page.goto("/email/aliases");
  await page.getByRole("button", { name: "Add alias" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an alias" });
  const add = dialog.getByRole("button", { name: "Add alias" });
  const target = dialog.getByRole("combobox", { name: "Target mailbox" });

  /* The target list follows the domain. */
  await expect(target).toBeDisabled();
  await pickOption(dialog, "Mail domain", DOMAIN);
  await expect(target).toBeEnabled();
  await dialog.getByLabel("Alias").fill(local);
  await expect(dialog).toContainText(address);
  await expect(add).toBeDisabled();
  await pickOption(dialog, "Target mailbox", TARGET);
  await add.click();
  await expect(dialog).toBeHidden();

  await expectJobInDrawer(page, "Add alias");
  await closeJobDrawer(page);

  const row = tableRow(page, "Aliases", address);
  await expect(row).toContainText(TARGET);
  await expect(row).toContainText("Active");

  const api = await owner();
  expect(await aliasAt(api, address)).toMatchObject({ status: "active", mailbox_address: TARGET });
  expect((await mailboxAt(api, TARGET))?.aliases).toContain(address);

  /* The host has it too: a sync keeps it active rather than marking it gone. */
  await syncMail(api, "mail-01");
  expect((await aliasAt(api, address))?.status).toBe("active");
});

test("an alias cannot shadow a mailbox, duplicate an alias, or be a bad local part", async ({ page }) => {
  await page.goto("/email/aliases?new=1");
  const dialog = page.getByRole("dialog", { name: "Add an alias" });
  const add = dialog.getByRole("button", { name: "Add alias" });
  await pickOption(dialog, "Mail domain", DOMAIN);
  await pickOption(dialog, "Target mailbox", TARGET);

  await dialog.getByLabel("Alias").fill("not valid");
  await expect(dialog).toContainText("Use letters, digits, dots, dashes or underscores.");
  await expect(add).toBeDisabled();

  /* ops@ is a mailbox on the host; an alias by that name would hide it. */
  await dialog.getByLabel("Alias").fill("ops");
  await add.click();
  await expect(dialog).toContainText(`ops@${DOMAIN} is already a mailbox.`);

  await dialog.getByLabel("Alias").fill(local);
  await add.click();
  await expect(dialog).toContainText(`${address} is already an alias.`);
  await expect(dialog).toContainText("Remove the alias first if this address should become a mailbox.");

  const api = await owner();
  const aliases = await api.data<{ address: string }[]>(`/mail-aliases?per_page=200&q=ops%40`);
  expect(aliases.map((a) => a.address)).not.toContain(`ops@${DOMAIN}`);
});

test("removing an alias runs as a job and leaves the mailbox alone", async ({ page }) => {
  const api = await owner();
  const alias = (await aliasAt(api, address))!;

  await page.goto("/email/aliases");
  await rowAction(page, tableRow(page, "Aliases", address), "Remove alias");
  const confirm = page.getByRole("dialog", { name: `Remove ${address}?` });
  await expect(confirm).toContainText(`${TARGET} and its mail are untouched.`);
  await confirm.getByRole("button", { name: "Remove alias" }).click();

  await expectJobInDrawer(page, "Remove alias");
  await closeJobDrawer(page);
  await expect(tableRow(page, "Aliases", address)).toHaveCount(0);
  expect((await api.get(`/mail-aliases/${alias.id}`)).status).toBe(404);

  const mailbox = (await mailboxAt(api, TARGET))!;
  expect(mailbox.status).toBe("active");
  expect(mailbox.aliases).not.toContain(address);

  await syncMail(api, "mail-01");
  expect(await aliasAt(api, address)).toBeUndefined();
});

test("an alias that does not exist answers 404, and so does a missing target", async () => {
  const api = await owner();
  expect((await api.get(`/mail-aliases/${missingId}`)).status).toBe(404);
  expect((await api.del(`/mail-aliases/${missingId}`)).status).toBe(404);

  const domain = (await mailboxAt(api, TARGET))!.mail_domain_id;
  const res = await api.post("/mail-aliases", { mail_domain_id: domain, local_part: "orphan", mailbox_id: missingId });
  expect(res.status).toBe(404);
  expect(res.body.error?.message).toContain("Mailbox");
});
