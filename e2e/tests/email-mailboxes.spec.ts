import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import {
  aliasAt,
  closeJobDrawer,
  copyableValue,
  expectJobInDrawer,
  mailboxAt,
  noteSecret,
  owner,
  pickOption,
  rowAction,
  syncMail,
  tableRow,
  unique,
} from "../support/email.js";

/* ------------------------------------------------------------------ *
 * Email — mailboxes (KD-035).
 *
 * Creating a mailbox and resetting its password are the two host
 * mutations that answer inline, because the host generates the password
 * and it may cross exactly one response. So the journeys here are about
 * that one response: the credential dialog cannot be dismissed by
 * accident, the password is not in the list, the row or the page after
 * a reload, and a reset produces a different one. Then the guard rails:
 * field validation with the exact message, addresses already taken by a
 * mailbox or an alias, and deletion behind the typed address.
 * ------------------------------------------------------------------ */

const DOMAIN = "futureforge.dev";
const PASSWORD_SHAPE = /^[a-km-zA-HJ-NP-Z2-9]{20}$/;

test.describe.configure({ mode: "serial" });

const local = unique("e2e-box");
const address = `${local}@${DOMAIN}`;
let firstPassword = "";

test.beforeAll(async () => {
  /* Start from what the host says, so "taken" means taken on both sides. */
  await syncMail(await owner(), "mail-01");
});

test("creating a mailbox shows its password once, in a dialog that cannot be dismissed by accident", async ({
  page,
}) => {
  await page.goto("/email/mailboxes");
  await page.getByRole("button", { name: "Create mailbox" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a mailbox" });
  const create = dialog.getByRole("button", { name: "Create mailbox" });
  await expect(create).toBeDisabled();

  await pickOption(dialog, "Mail domain", DOMAIN);
  await dialog.getByLabel("Address").fill(local.toUpperCase());
  await expect(dialog).toContainText(`${local.toUpperCase()}@${DOMAIN}`);
  await dialog.getByLabel("Display name").fill("E2E Box");
  await dialog.getByLabel("Quota").fill("50");
  await create.click();

  const credential = page.getByRole("dialog", { name: "Mailbox created" });
  await expect(credential).toBeVisible();
  /* Lower-cased on the way in, as the contract says. */
  await expect(copyableValue(credential, "Address")).toHaveText(address);
  firstPassword = (await copyableValue(credential, "Password").innerText()).trim();
  expect(firstPassword).toMatch(PASSWORD_SHAPE);
  noteSecret("mailbox_password", firstPassword);
  await expect(credential).toContainText("This is the only time this password is shown.");

  /* Escape does not throw it away. */
  await page.keyboard.press("Escape");
  await expect(credential).toBeVisible();
  await credential.getByRole("button", { name: "I have stored it" }).click();
  await expect(credential).toBeHidden();

  const row = tableRow(page, "Mailboxes", address);
  await expect(row).toContainText("E2E Box");
  await expect(row).toContainText("50.0 MiB");
  await expect(row).toContainText("Active");

  /* Nowhere to be found afterwards: not in the row, not in the list,
   * not on the page after a reload. */
  const api = await owner();
  const created = (await mailboxAt(api, address))!;
  expect(created).toMatchObject({
    status: "active",
    display_name: "E2E Box",
    quota_bytes: 50 * 1024 * 1024,
  });
  const one = await api.get(`/mailboxes/${created.id}`);
  const all = await api.get("/mailboxes?per_page=200");
  expect(one.text).not.toContain(firstPassword);
  expect(all.text).not.toContain(firstPassword);
  expect(one.text).not.toMatch(/"password"/);

  await page.reload();
  await expect(tableRow(page, "Mailboxes", address)).toBeVisible();
  expect(await page.content()).not.toContain(firstPassword);
});

test("the create form names what is wrong, field by field", async ({ page }) => {
  const api = await owner();
  await page.goto("/email/mailboxes?new=1");
  const dialog = page.getByRole("dialog", { name: "Create a mailbox" });
  const create = dialog.getByRole("button", { name: "Create mailbox" });
  await pickOption(dialog, "Mail domain", DOMAIN);

  const addressField = dialog.getByLabel("Address");
  await addressField.fill("two words");
  await expect(dialog).toContainText("Use letters, digits, dots, dashes or underscores.");
  await expect(create).toBeDisabled();
  await addressField.fill("ünïcode");
  await expect(create).toBeDisabled();

  await addressField.fill("quota-check");
  await dialog.getByLabel("Quota").fill("-1");
  await expect(dialog).toContainText("Enter a whole number of megabytes, or 0.");
  await expect(create).toBeDisabled();
  await dialog.getByLabel("Quota").fill("abc");
  await expect(create).toBeDisabled();
  await dialog.getByLabel("Quota").fill("0");
  await expect(create).toBeEnabled();

  /* 64 is the limit; 65 gets past the browser and the control plane
   * names the field. Nothing reaches the host. */
  await addressField.fill("x".repeat(65));
  await create.click();
  await expect(dialog.getByText("Must be 64 characters or fewer.")).toBeVisible();
  expect(await mailboxAt(api, `${"x".repeat(65)}@${DOMAIN}`)).toBeUndefined();

  const direct = await api.post("/mailboxes", {
    mail_domain_id: (await mailboxAt(api, address))!.mail_domain_id,
    local_part: "x".repeat(65),
  });
  expect(direct.status).toBe(422);
  expect(direct.body.error?.fields?.["local_part"]).toBe("Must be 64 characters or fewer.");
});

test("an address already taken by a mailbox or an alias is refused before the host is asked", async ({
  page,
}) => {
  const api = await owner();
  const postmaster = await aliasAt(api, `postmaster@${DOMAIN}`);
  expect(postmaster?.status, "the host's postmaster alias should be synced").toBe("active");

  await page.goto("/email/mailboxes?new=1");
  const dialog = page.getByRole("dialog", { name: "Create a mailbox" });
  await pickOption(dialog, "Mail domain", DOMAIN);

  /* Case does not make it a different address. */
  await dialog.getByLabel("Address").fill("HELLO");
  await dialog.getByRole("button", { name: "Create mailbox" }).click();
  await expect(dialog).toContainText(`hello@${DOMAIN} is already a mailbox.`);
  await expect(dialog).toContainText("Pick another local part, or open the existing mailbox.");

  await dialog.getByLabel("Address").fill("postmaster");
  await dialog.getByRole("button", { name: "Create mailbox" }).click();
  await expect(dialog).toContainText(`postmaster@${DOMAIN} is already an alias.`);
  await expect(page.getByRole("dialog", { name: "Mailbox created" })).toHaveCount(0);
});

test("resetting a password hands over a new one, once", async ({ page }) => {
  await page.goto("/email/mailboxes");
  await rowAction(page, tableRow(page, "Mailboxes", address), "Reset password");
  const confirm = page.getByRole("dialog", { name: `Reset the password for ${address}?` });
  await confirm.getByRole("button", { name: "Reset password" }).click();

  const credential = page.getByRole("dialog", { name: "Password reset" });
  await expect(credential).toContainText(`The old password for ${address} stopped working`);
  await expect(copyableValue(credential, "Address")).toHaveText(address);
  const second = (await copyableValue(credential, "Password").innerText()).trim();
  expect(second).toMatch(PASSWORD_SHAPE);
  expect(second).not.toBe(firstPassword);
  noteSecret("mailbox_password", second);
  await credential.getByRole("button", { name: "I have stored it" }).click();

  const api = await owner();
  const row = (await mailboxAt(api, address))!;
  expect((await api.get(`/mailboxes/${row.id}`)).text).not.toContain(second);
  const trail = await api.auditTrail();
  expect(trail).toContain("mailbox.password_reset");
  expect(trail).not.toContain(second);
  expect(trail).not.toContain(firstPassword);
});

test("deleting a mailbox needs its exact address typed, and runs as a job", async ({ page }) => {
  const api = await owner();
  const row = (await mailboxAt(api, address))!;

  await page.goto("/email/mailboxes");
  await rowAction(page, tableRow(page, "Mailboxes", address), "Delete mailbox");
  const confirm = page.getByRole("dialog", { name: `Delete ${address}?` });
  await expect(confirm).toContainText("Its mail is removed from the host");
  const remove = confirm.getByRole("button", { name: "Delete mailbox" });
  await expect(remove).toBeDisabled();
  await confirm.getByLabel(`Type ${address} to confirm`).fill(local);
  await expect(remove).toBeDisabled();
  await confirm.getByLabel(`Type ${address} to confirm`).fill(address);
  await remove.click();

  await expectJobInDrawer(page, `Delete mailbox`);
  await closeJobDrawer(page);
  await expect(tableRow(page, "Mailboxes", address)).toHaveCount(0);
  expect((await api.get(`/mailboxes/${row.id}`)).status).toBe(404);

  /* And the host agrees: a sync does not bring it back. */
  await syncMail(api, "mail-01");
  expect(await mailboxAt(api, address)).toBeUndefined();
});

test("a mailbox that does not exist answers 404 to every verb", async () => {
  const api = await owner();
  expect((await api.get(`/mailboxes/${missingId}`)).status).toBe(404);
  expect((await api.post(`/mailboxes/${missingId}/reset-password`)).status).toBe(404);
  expect((await api.del(`/mailboxes/${missingId}`)).status).toBe(404);
  const create = await api.post("/mailboxes", { mail_domain_id: missingId, local_part: "nobody" });
  expect(create.status).toBe(404);
  expect(create.body.error?.message).toContain("Mail domain");
});
