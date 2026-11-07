import { expect, test } from "@playwright/test";
import {
  aliasAt,
  closeJobDrawer,
  definition,
  expectJobInDrawer,
  kanameDomain,
  mailDomainNamed,
  mailServerOn,
  mailboxAt,
  owner,
  pickOption,
  serverCard,
  type JobRow,
  type MailDomainRow,
} from "../support/email.js";

/* ------------------------------------------------------------------ *
 * Email — the mail server card, from the seed to forget and adopt.
 *
 * The seed writes mail-01 the way an old sync would have (yunori-mail
 * 0.3.1, a hand-written checklist); the simulated host runs 0.1.0 with a
 * slightly different world. So "Check now" is provable: the version, the
 * counts and the domains on the card change to what the host says.
 * Forgetting drops Kaname's record only — the host keeps its mail — and
 * adopting it again reads everything back.
 * ------------------------------------------------------------------ */

const MAIL_HOST = "mail-01";
/** CHECK_META labels in apps/web/app/(panel)/email/_components/status.tsx. */
const VERDICT_WORDS = /^(Pass|Warn|Fail|Info|Unknown|Healthy|Not checked)$/;

test.describe.configure({ mode: "serial" });

test("the card keeps the host's connection and Yunori's verdict apart, with the install checklist", async ({
  page,
}) => {
  await page.goto("/email");
  await expect(page.getByRole("heading", { level: 1, name: "Mail servers" })).toBeVisible();
  const card = serverCard(page, MAIL_HOST);
  const heading = card.getByRole("heading", { level: 2 });
  await expect(heading).toContainText("Agent Connected");
  await expect(heading.locator("span").filter({ hasText: VERDICT_WORDS }).last()).toBeVisible();

  const steps = card.getByRole("list", { name: "Install steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(12);
  await expect(card.getByText("Waiting for you: Set reverse DNS")).toBeVisible();
  await expect(definition(card, "Services").getByRole("listitem")).toHaveCount(3);
});

test("Check now re-reads the host and the card shows what it said", async ({ page }) => {
  const api = await owner();
  const before = (await mailServerOn(api, MAIL_HOST))!;
  await page.goto("/email");
  const card = serverCard(page, MAIL_HOST);
  await card.getByRole("button", { name: "Check now" }).click();
  await expectJobInDrawer(page, "Check mail server");
  await closeJobDrawer(page);

  const row = (await mailServerOn(api, MAIL_HOST))!;
  expect(new Date(row.last_synced_at!).getTime()).toBeGreaterThan(
    new Date(before.last_synced_at ?? 0).getTime(),
  );
  /* The simulated host runs 0.1.0 and serves a second domain the seed
   * never had; both arrived through the sync. */
  expect(row.version).toBe("0.1.0");
  expect((await mailDomainNamed(api, "kaname.sh"))?.status).toBe("active");
  expect((await mailboxAt(api, "team@kaname.sh"))?.status).toBe("active");
  await expect(card.getByText("0.1.0", { exact: true })).toBeVisible();
  await expect(definition(card, "Hosting")).toContainText(`${row.domain_count} domains`);
  await expect(definition(card, "Synced")).toContainText(/just now|\ds ago/);

  /* A row the host no longer lists is marked, not silently deleted. */
  const detective = await mailboxAt(api, "detective@futureforge.dev");
  expect(detective?.status).toBe("error");
  const syncs = await api.data<JobRow[]>(
    `/jobs?type=mail.server.sync&server_id=${row.server_id}&per_page=50`,
  );
  expect(await api.jobLog(syncs[0]!.id)).toContain(
    `yunori-mail 0.1.0 on mail.futureforge.dev: ${row.checks.length} checks`,
  );
  /* Whichever sync first saw it gone said so in its log. */
  const logs = await Promise.all(syncs.map((job) => api.jobLog(job.id)));
  expect(logs.join("\n")).toContain(
    "detective@futureforge.dev is no longer on the host; marked error, not deleted",
  );
});

test("the verdict filter narrows the cards and says when none match", async ({ page }) => {
  await page.goto("/email");
  await page.getByRole("combobox", { name: "Verdict" }).selectOption("pass");
  await expect(serverCard(page, MAIL_HOST)).toHaveCount(0);
  await expect(page.getByText("No mail server matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(serverCard(page, MAIL_HOST)).toBeVisible();
  await page.getByRole("combobox", { name: "Verdict" }).selectOption("fail");
  await expect(serverCard(page, MAIL_HOST)).toBeVisible();
});

test("forgetting is refused while an added domain remains, then drops only Kaname's record", async ({
  page,
}) => {
  const api = await owner();
  const row = (await mailServerOn(api, MAIL_HOST))!;
  const extra = (await mailDomainNamed(api, "kaname.sh"))!;
  expect(extra.is_primary).toBe(false);

  /* An added domain blocks it, and the refusal says what to do. */
  await page.goto("/email");
  const card = serverCard(page, MAIL_HOST);
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Forget", exact: true }).click();
  let confirm = page.getByRole("dialog", { name: `Forget the mail server on ${MAIL_HOST}?` });
  await confirm.getByLabel(`Type ${MAIL_HOST} to confirm`).fill(MAIL_HOST);
  await confirm.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "besides its primary one" }),
  ).toBeVisible();
  expect((await mailServerOn(api, MAIL_HOST))?.id).toBe(row.id);
  await confirm.getByRole("button", { name: "Cancel" }).click();

  /* Empty kaname.sh on the host and remove it. */
  const team = (await mailboxAt(api, "team@kaname.sh"))!;
  const postmaster = await aliasAt(api, "postmaster@kaname.sh");
  if (postmaster) {
    const removeAlias = await api.del<{ job: JobRow }>(`/mail-aliases/${postmaster.id}`);
    expect((await api.job(removeAlias.body.data!.job.id)).status).toBe("succeeded");
  }
  const removeBox = await api.del<{ job: JobRow }>(`/mailboxes/${team.id}`);
  expect((await api.job(removeBox.body.data!.job.id)).status).toBe("succeeded");
  const removeDomain = await api.del<{ job: JobRow }>(`/mail-domains/${extra.id}`);
  expect(removeDomain.status, removeDomain.text).toBe(202);
  expect((await api.job(removeDomain.body.data!.job.id)).status).toBe("succeeded");

  /* Only the primary is left; it goes with the record. */
  await page.reload();
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Forget", exact: true }).click();
  confirm = page.getByRole("dialog", { name: `Forget the mail server on ${MAIL_HOST}?` });
  await confirm.getByLabel(`Type ${MAIL_HOST} to confirm`).fill(MAIL_HOST);
  await confirm.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(card).toHaveCount(0);

  expect(await mailServerOn(api, MAIL_HOST)).toBeUndefined();
  expect((await api.get(`/mail-servers/${row.id}`)).status).toBe(404);
  const left = await api.data<MailDomainRow[]>(`/mail-domains?server_id=${row.server_id}`);
  expect(left).toHaveLength(0);
  expect((await kanameDomain(api, "futureforge.dev")).has_mail).toBe(false);
  const trail = await api.auditTrail();
  expect(trail).toContain("mail_server.forgotten");
});

test("adopting the host again reads its server, domains and mailboxes back", async ({ page }) => {
  const api = await owner();
  await page.goto("/email?adopt=1");
  const dialog = page.getByRole("dialog", { name: "Adopt an existing Yunori Mail Server" });
  const adopt = dialog.getByRole("button", { name: "Adopt", exact: true });

  await pickOption(dialog, "Server", MAIL_HOST);
  await dialog.getByLabel("Mail hostname").fill("not a hostname");
  await expect(dialog).toContainText("Enter a fully qualified hostname.");
  await expect(adopt).toBeDisabled();
  await dialog.getByLabel("Mail hostname").fill("");
  await dialog.getByLabel("Admin email").fill("nope");
  await expect(dialog).toContainText("Enter a full email address.");
  await expect(adopt).toBeDisabled();
  await dialog.getByLabel("Admin email").fill("ops@example.org");
  await adopt.click();
  await expect(dialog).toBeHidden();

  await expectJobInDrawer(page, "Check mail server");
  await closeJobDrawer(page);

  const row = (await mailServerOn(api, MAIL_HOST))!;
  expect(row).toMatchObject({
    status: "installed",
    hostname: "mail.futureforge.dev",
    version: "0.1.0",
  });
  expect(row.primary_domain).toBe("futureforge.dev");
  const primary = (await mailDomainNamed(api, "futureforge.dev"))!;
  expect(primary).toMatchObject({ is_primary: true, status: "active" });
  expect((await mailboxAt(api, "hello@futureforge.dev"))?.status).toBe("active");
  expect((await kanameDomain(api, "futureforge.dev")).has_mail).toBe(true);

  const card = serverCard(page, MAIL_HOST);
  await expect(definition(card, "Primary domain")).toHaveText("futureforge.dev");
  await expect(card.getByText("0.1.0", { exact: true })).toBeVisible();

  /* A host that is already managed is not offered twice. */
  await page.goto("/email?adopt=1");
  const again = page.getByRole("dialog", { name: "Adopt an existing Yunori Mail Server" });
  await pickOption(again, "Server", MAIL_HOST);
  await expect(again).toContainText("Kaname already manages the mail server on this host.");
  await expect(again.getByRole("button", { name: "Adopt", exact: true })).toBeDisabled();
  const conflict = await api.post("/mail-servers/adopt", { server_id: row.server_id });
  expect(conflict.status).toBe(409);
  expect(conflict.body.error?.message).toBe(`${MAIL_HOST} already has a mail server (installed).`);
});
