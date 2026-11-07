import { expect, test, type Page } from "@playwright/test";
import {
  FEED_VERSION,
  copyableValue,
  definition,
  fleetServer,
  kanameDomain,
  mailDomainNamed,
  mailServerOn,
  mailboxAt,
  noteSecret,
  owner,
  pickOption,
  serverCard,
  startFeed,
  stopFeed,
  type JobRow,
} from "../support/email.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Email — deploying Yunori Mail Server (KD-034, KD-035).
 *
 * A deploy is the longest mail journey and the one with the most ways to
 * go wrong, so it is walked end to end on hosts that start without
 * Yunori (only mail-01 plays a mail host in the simulated fleet):
 *
 *   - with the release feed down, the dialog and the route both say so,
 *     and a deploy queued anyway fails honestly and can be forgotten;
 *   - the form refuses what Yunori's installer would refuse, field by
 *     field, and the control plane refuses a second server on a host and
 *     a domain that already receives mail elsewhere;
 *   - a direct deploy lands, the host re-announces itself with the
 *     `yunori` capability and becomes manageable with nothing restarted,
 *     and the once-only secrets are shown once, survive a reload until
 *     revealed, and are gone on the second read and absent from the log;
 *   - a relay deploy carries the relay password to the host without it
 *     touching the job, its log or the audit trail.
 *
 * The feed is local (support/email.ts): the sandbox cannot reach
 * yunori.email, and a feed the suite controls is also the only way to
 * take it away on purpose.
 * ------------------------------------------------------------------ */

const DIRECT_HOST = "forge-01";
const DIRECT_DOMAIN = "docs.forgebase.dev";
const RELAY_HOST = "db-01";
const RELAY_DOMAIN = "shop.futureforge.dev";
const ADMIN_EMAIL = "postmaster-alerts@example.org";
const RELAY_PASSWORD = `relay-secret-${Math.random().toString(36).slice(2, 12)}`;

test.describe.configure({ mode: "serial" });
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function openDeployDialog(page: Page) {
  await page.goto("/email");
  await page.getByRole("button", { name: "Deploy Yunori Mail Server" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Deploy Yunori Mail Server" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.afterAll(async () => {
  await stopFeed().catch(() => undefined);
});

test("with the release feed unreachable, the dialog and the route say so and a deploy fails honestly", async ({
  page,
}) => {
  await stopFeed();
  const api = await owner();

  /* The route: an upstream error naming the feed it tried, with a remedy. */
  const latest = await api.get("/mail-releases/latest");
  expect(latest.status).toBe(502);
  expect(latest.body.error?.code).toBe("upstream_error");
  expect(latest.body.error?.message).toContain(
    `Could not read the yunori-mail release feed at ${process.env["KANAME_YUNORI_FEED"]}/latest.json`,
  );
  expect(latest.body.error?.remediation?.summary).toContain("KANAME_YUNORI_VERSION");

  /* The dialog: says the deploy cannot start, and does not let it. */
  const dialog = await openDeployDialog(page);
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText(
    "The yunori-mail release feed could not be read, so a deploy cannot start:",
  );
  await expect(alert).toContainText("Could not read the yunori-mail release feed at");
  await pickOption(dialog, "Server", DIRECT_HOST);
  await pickOption(dialog, "Domain", DIRECT_DOMAIN);
  await dialog.getByLabel("Admin email").fill(ADMIN_EMAIL);
  await expect(dialog.getByRole("button", { name: "Deploy", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* Through the API anyway: the job resolves the same feed and fails,
   * and the record says why instead of sitting at "deploying". */
  const forge = await fleetServer(api, DIRECT_HOST);
  const domain = await kanameDomain(api, DIRECT_DOMAIN);
  const queued = await api.post<{ job: JobRow }>("/mail-servers", {
    server_id: forge.id,
    domain_id: domain.id,
    admin_email: ADMIN_EMAIL,
  });
  expect(queued.status, queued.text).toBe(202);
  const job = await api.job(queued.body.data!.job.id);
  expect(job.status).toBe("failed");
  expect(job.error?.message).toContain("Could not read the yunori-mail release feed");

  const row = await mailServerOn(api, DIRECT_HOST);
  expect(row?.status).toBe("error");
  expect(row?.last_error).toContain("Could not read the yunori-mail release feed");
  expect((await kanameDomain(api, DIRECT_DOMAIN)).has_mail).toBe(false);

  /* The card shows the failure, and forgetting the dead record is the way
   * to try again: typed confirmation, then it is gone. */
  await page.goto("/email");
  const card = serverCard(page, DIRECT_HOST);
  await expect(card).toContainText("Could not read the yunori-mail release feed");
  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Forget", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: `Forget the mail server on ${DIRECT_HOST}?` });
  const forgetButton = confirm.getByRole("button", { name: "Forget", exact: true });
  await expect(forgetButton).toBeDisabled();
  await confirm.getByLabel(`Type ${DIRECT_HOST} to confirm`).fill("forge-0");
  await expect(forgetButton).toBeDisabled();
  await confirm.getByLabel(`Type ${DIRECT_HOST} to confirm`).fill(DIRECT_HOST);
  await forgetButton.click();
  await expect(card).toHaveCount(0);
  expect(await mailServerOn(api, DIRECT_HOST)).toBeUndefined();
});

test("the deploy form refuses bad input field by field, and the control plane refuses conflicts", async ({
  page,
}) => {
  await startFeed();
  const dialog = await openDeployDialog(page);
  await expect(dialog).toContainText(`Installs yunori-mail ${FEED_VERSION}`);

  const deploy = dialog.getByRole("button", { name: "Deploy", exact: true });
  const hostname = dialog.getByLabel("Mail hostname");
  const admin = dialog.getByLabel("Admin email");
  const firstMailbox = dialog.getByLabel("First mailbox");

  await pickOption(dialog, "Server", DIRECT_HOST);
  await pickOption(dialog, "Domain", DIRECT_DOMAIN);
  /* Yunori's own suggestion, until the operator types something else. */
  await expect(hostname).toHaveValue(`mail.${DIRECT_DOMAIN}`);
  await expect(deploy).toBeDisabled();

  /* The alerts address must live somewhere else. */
  await admin.fill(`ops@${DIRECT_DOMAIN}`);
  await expect(dialog).toContainText(
    `That address is on ${DIRECT_DOMAIN}, the domain this server will host. Use one elsewhere.`,
  );
  await expect(deploy).toBeDisabled();
  await admin.fill("not-an-address");
  await expect(dialog).toContainText("Enter a full email address.");
  await expect(deploy).toBeDisabled();
  await admin.fill(ADMIN_EMAIL);
  await expect(deploy).toBeEnabled();

  await hostname.fill("mail_host");
  await expect(dialog).toContainText("Enter a fully qualified hostname.");
  await expect(deploy).toBeDisabled();
  await hostname.fill(`mail.${DIRECT_DOMAIN}`);

  await firstMailbox.fill("first box");
  await expect(dialog).toContainText("Use letters, digits, dots, dashes or underscores.");
  await expect(deploy).toBeDisabled();

  /* One past the contract's 64-character limit: the browser lets it
   * through and the control plane names the field. */
  await firstMailbox.fill("a".repeat(65));
  await expect(deploy).toBeEnabled();
  await deploy.click();
  await expect(dialog.getByText("String must contain at most 64 character(s)")).toBeVisible();
  expect(await mailServerOn(await owner(), DIRECT_HOST)).toBeUndefined();
  await firstMailbox.fill("postbox");

  /* One mail server per host. */
  await pickOption(dialog, "Server", "mail-01");
  await deploy.click();
  await expect(dialog).toContainText("mail-01 already has a mail server (installed).");

  /* One mail server per domain. */
  await pickOption(dialog, "Server", DIRECT_HOST);
  await pickOption(dialog, "Domain", "futureforge.dev");
  await admin.fill(ADMIN_EMAIL);
  await deploy.click();
  await expect(dialog).toContainText("futureforge.dev already hosts mail.");

  /* Neither refusal left a record behind on the host it named. */
  expect(await mailServerOn(await owner(), DIRECT_HOST)).toBeUndefined();
});

test("a direct deploy lands, the host re-announces Yunori, and the setup secrets are shown exactly once", async ({
  page,
}) => {
  const api = await owner();
  expect((await fleetServer(api, DIRECT_HOST)).capabilities).not.toContain("yunori");

  const dialog = await openDeployDialog(page);
  await expect(dialog).toContainText(`Installs yunori-mail ${FEED_VERSION}`);
  await pickOption(dialog, "Server", DIRECT_HOST);
  await pickOption(dialog, "Domain", DIRECT_DOMAIN);
  await dialog.getByLabel("Admin email").fill(ADMIN_EMAIL);
  await dialog.getByLabel("First mailbox").fill("postbox");
  await dialog.getByRole("button", { name: "Deploy", exact: true }).click();
  await expect(dialog).toBeHidden();

  /* The Finish setup panel follows the job to the end. */
  const finish = page.locator("section").filter({ has: page.getByRole("heading", { name: "Finish setup" }) });
  await expect(finish).toBeVisible();
  await expect(jobStatusPill(finish)).toContainText("Succeeded", { timeout: 60_000 });
  await expect(finish).toContainText("The install finished.");

  const row = (await mailServerOn(api, DIRECT_HOST))!;
  const jobs = await api.data<JobRow[]>(`/jobs?type=mail.server.deploy&server_id=${row.server_id}&per_page=5`);
  const job = jobs.find((candidate) => candidate.status === "succeeded")!;
  expect(job.params).toMatchObject({ domain: DIRECT_DOMAIN, hostname: `mail.${DIRECT_DOMAIN}`, sending: "direct" });

  /* The agent re-announced itself: the capability arrived over a fresh
   * hello, nothing was restarted, and the reconciler read the new server. */
  await expect
    .poll(async () => (await fleetServer(api, DIRECT_HOST)).capabilities, { timeout: 30_000 })
    .toContain("yunori");
  await expect
    .poll(async () => (await mailServerOn(api, DIRECT_HOST))?.last_synced_at ?? null, { timeout: 30_000 })
    .not.toBeNull();

  const card = serverCard(page, DIRECT_HOST);
  await expect(card).toContainText("Installed");
  await expect(card.getByText(FEED_VERSION, { exact: true })).toBeVisible();
  await expect(definition(card, "Primary domain")).toHaveText(DIRECT_DOMAIN);
  await expect(definition(card, "Hostname")).toContainText(`mail.${DIRECT_DOMAIN}`);
  await expect(definition(card, "Sending")).toHaveText("Direct, over port 25");
  await expect(card.getByText("Waiting for you: Set reverse DNS")).toBeVisible();
  await expect(card.getByRole("list", { name: "Install steps" })).toContainText(
    `Set the PTR for 198.51.100.42 to mail.${DIRECT_DOMAIN} at your provider.`,
  );

  /* The job log says where the secrets are and never what they are. */
  const before = await api.jobLog(job.id);
  expect(before).toContain("available once from the panel for 15 minutes");
  expect(before).not.toMatch(/#token=sim-/);

  /* The secrets wait across a reload until revealed. */
  await page.reload();
  await expect(finish).toBeVisible();
  await expect(jobStatusPill(finish)).toContainText("Succeeded");
  await finish.getByRole("button", { name: "Reveal setup link and password" }).click();

  const setupUrl = (await copyableValue(finish, "Console setup link").innerText()).trim();
  expect(setupUrl).toMatch(
    new RegExp(`^https://mail\\.${DIRECT_DOMAIN.replace(/\./g, "\\.")}/console/setup#token=sim-[0-9a-f]{16}$`),
  );
  await expect(copyableValue(finish, "First mailbox")).toHaveText(`postbox@${DIRECT_DOMAIN}`);
  const password = (await copyableValue(finish, `Password for postbox@${DIRECT_DOMAIN}`).innerText()).trim();
  expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/);
  noteSecret("setup_url", setupUrl);
  noteSecret("first_mailbox_password", password);

  /* Copy hands over exactly what is shown. */
  await finish.getByRole("button", { name: `Copy Password for postbox@${DIRECT_DOMAIN}` }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(password);

  /* Second read: gone, with the way to get a new link. */
  const again = await api.get(`/mail-servers/${row.id}/deploy-secrets`);
  expect(again.status).toBe(404);
  expect(again.body.error?.message).toBe("The deploy secrets are not available (shown once, or expired).");
  expect(again.body.error?.remediation?.summary).toContain("yunori-mail setup-token");

  /* Nothing about them in the job, its log or the audit trail; that they
   * were read, by whom, is on the record. */
  const after = await api.data<JobRow>(`/jobs/${job.id}`);
  const log = await api.jobLog(job.id);
  const trail = await api.auditTrail();
  for (const secret of [password, setupUrl, setupUrl.split("#token=")[1]!]) {
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(log).not.toContain(secret);
    expect(trail).not.toContain(secret);
  }
  expect(trail).toContain("mail_server.deploy_secrets_viewed");

  /* Dismissed, the panel stays gone. */
  await finish.getByRole("button", { name: "Done" }).click();
  await expect(finish).toHaveCount(0);
  await page.reload();
  await expect(serverCard(page, DIRECT_HOST)).toBeVisible();
  await expect(finish).toHaveCount(0);

  /* The deploy wrote the rows the page needs at once. */
  const domain = (await mailDomainNamed(api, DIRECT_DOMAIN))!;
  expect(domain).toMatchObject({ is_primary: true, status: "active", server_name: DIRECT_HOST });
  expect((await kanameDomain(api, DIRECT_DOMAIN)).has_mail).toBe(true);
  expect((await mailboxAt(api, `postbox@${DIRECT_DOMAIN}`))?.status).toBe("active");
});

test("the freshly deployed host is manageable at once: a mailbox, the live tail, and same-server aliases only", async ({
  page,
}) => {
  const api = await owner();

  await page.goto("/email/mailboxes?new=1");
  const dialog = page.getByRole("dialog", { name: "Create a mailbox" });
  await pickOption(dialog, "Mail domain", DIRECT_DOMAIN);
  await dialog.getByLabel("Address").fill("second");
  await dialog.getByRole("button", { name: "Create mailbox" }).click();

  const credential = page.getByRole("dialog", { name: "Mailbox created" });
  await expect(copyableValue(credential, "Address")).toHaveText(`second@${DIRECT_DOMAIN}`);
  const password = (await copyableValue(credential, "Password").innerText()).trim();
  expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/);
  noteSecret("mailbox_password", password);
  await credential.getByRole("button", { name: "I have stored it" }).click();
  await expect(credential).toBeHidden();
  expect((await mailboxAt(api, `second@${DIRECT_DOMAIN}`))?.status).toBe("active");

  /* The live tail offers the new host and reads its journal. */
  const forge = await fleetServer(api, DIRECT_HOST);
  await page.goto(`/email/logs?server_id=${forge.id}`);
  await expect(page.getByRole("combobox", { name: "Mail server" })).toHaveValue(DIRECT_HOST);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: `Mail log on ${DIRECT_HOST}` })).toContainText("stalwart-mail");

  /* An alias delivers to a mailbox on the same server; the new host's
   * mailbox is not a target for a domain on mail-01. */
  const primary = (await mailDomainNamed(api, "futureforge.dev"))!;
  const postbox = (await mailboxAt(api, `postbox@${DIRECT_DOMAIN}`))!;
  const refused = await api.post("/mail-aliases", {
    mail_domain_id: primary.id,
    local_part: "cross-server",
    mailbox_id: postbox.id,
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error?.message).toBe(`postbox@${DIRECT_DOMAIN} is not hosted on mail-01.`);
});

test("a relay deploy carries its password to the host and nowhere else", async ({ page }) => {
  const api = await owner();
  const dialog = await openDeployDialog(page);
  await pickOption(dialog, "Server", RELAY_HOST);
  await pickOption(dialog, "Domain", RELAY_DOMAIN);
  await dialog.getByLabel("Admin email").fill(ADMIN_EMAIL);
  await dialog.getByRole("radio", { name: /^Through a relay/ }).check();

  const relay = dialog.locator("fieldset").filter({ hasText: "Relay" });
  const deploy = dialog.getByRole("button", { name: "Deploy", exact: true });
  await expect(relay.getByRole("combobox", { name: "Provider" })).toBeVisible();

  /* SES needs a region and a password; the port must be a port. */
  await expect(deploy).toBeDisabled();
  await relay.getByLabel("Region").fill("eu-west-1");
  await relay.getByLabel("Username").fill("AKIAE2EEXAMPLE");
  await expect(deploy).toBeDisabled();
  await relay.getByLabel("Password", { exact: true }).fill(RELAY_PASSWORD);
  await expect(deploy).toBeEnabled();
  await relay.getByLabel("Port").fill("65536");
  await expect(deploy).toBeDisabled();
  await relay.getByLabel("Port").fill("587");
  await expect(deploy).toBeEnabled();
  noteSecret("relay_password", RELAY_PASSWORD);

  await deploy.click();
  const finish = page.locator("section").filter({ has: page.getByRole("heading", { name: "Finish setup" }) });
  await expect(jobStatusPill(finish)).toContainText("Succeeded", { timeout: 60_000 });

  const row = (await mailServerOn(api, RELAY_HOST))!;
  expect(row).toMatchObject({ status: "installed", sending_mode: "relay", relay_provider: "ses" });
  await expect(definition(serverCard(page, RELAY_HOST), "Sending")).toHaveText("Through a relay (ses)");

  const job = (await api.data<JobRow[]>(`/jobs?type=mail.server.deploy&server_id=${row.server_id}&per_page=5`))[0]!;
  expect(job.status).toBe("succeeded");
  const relayParams = job.params["relay"] as Record<string, unknown>;
  expect(relayParams).toMatchObject({ provider: "ses", region: "eu-west-1", username: "AKIAE2EEXAMPLE", port: 587 });
  expect(relayParams["password_ref"]).toEqual(expect.any(String));
  expect(relayParams).not.toHaveProperty("password");

  const everything = [JSON.stringify(job), await api.jobLog(job.id), await api.auditTrail()];
  for (const text of everything) expect(text).not.toContain(RELAY_PASSWORD);

  /* Its own secrets, once. */
  await finish.getByRole("button", { name: "Reveal setup link and password" }).click();
  noteSecret("setup_url", (await copyableValue(finish, "Console setup link").innerText()).trim());
  noteSecret(
    "first_mailbox_password",
    (await copyableValue(finish, `Password for hello@${RELAY_DOMAIN}`).innerText()).trim(),
  );
  await expect
    .poll(async () => (await fleetServer(api, RELAY_HOST)).capabilities, { timeout: 30_000 })
    .toContain("yunori");
});
