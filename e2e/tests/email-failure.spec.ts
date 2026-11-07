import { expect, test } from "@playwright/test";
import {
  aliasAt,
  closeJobDrawer,
  expectJobInDrawer,
  mailDomainNamed,
  mailServerOn,
  mailboxAt,
  owner,
  pickOption,
  rowAction,
  serverCard,
  startAgent,
  stopAgent,
  syncMail,
  tableRow,
  unique,
  type JobRow,
} from "../support/email.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Email — when the host is not there, and when the host says no.
 *
 * With mail-01's agent stopped, every surface that needs the live host
 * has to say so plainly instead of hanging or pretending: the card keeps
 * Yunori's last verdict but shows the host as disconnected, the inline
 * mailbox calls refuse with the agent's state, a check is queued as
 * blocked and runs by itself once the agent is back, and the tail and
 * preflight report the outage. Then a job the host refuses (an alias for
 * a mailbox the host does not have) fails visibly and marks its row.
 *
 * Restarting a simulated agent rebuilds its world from scratch, so the
 * spec resyncs afterwards and leaves mail-01 as the next spec expects.
 * ------------------------------------------------------------------ */

const MAIL_HOST = "mail-01";
const DOMAIN = "futureforge.dev";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await startAgent(MAIL_HOST);
});

test("with the mail host's agent gone, every live surface says so and a check waits for it", async ({ page }) => {
  test.setTimeout(240_000);
  const api = await owner();
  await syncMail(api, MAIL_HOST);
  const row = (await mailServerOn(api, MAIL_HOST))!;
  const hello = (await mailboxAt(api, `hello@${DOMAIN}`))!;
  const domain = (await mailDomainNamed(api, DOMAIN))!;

  await stopAgent(MAIL_HOST);

  /* Two axes: the host is disconnected, Yunori's last verdict stands. */
  await page.goto("/email");
  const card = serverCard(page, MAIL_HOST);
  const heading = card.getByRole("heading", { level: 2 });
  await expect(heading).not.toContainText("Agent Connected");
  await expect(heading).toContainText("Fail");

  /* Inline mailbox calls refuse with the agent's state, not a timeout. */
  const create = await api.post("/mailboxes", { mail_domain_id: domain.id, local_part: unique("offline") });
  expect(create.status).toBe(503);
  expect(create.body.error?.code).toBe("agent_offline");
  const reset = await api.post(`/mailboxes/${hello.id}/reset-password`);
  expect(reset.status).toBe(503);
  expect(reset.body.error?.code).toBe("agent_offline");

  await page.goto("/email/mailboxes?new=1");
  const dialog = page.getByRole("dialog", { name: "Create a mailbox" });
  await pickOption(dialog, "Mail domain", DOMAIN);
  await dialog.getByLabel("Address").fill(unique("offline"));
  await dialog.getByRole("button", { name: "Create mailbox" }).click();
  await expect(dialog).toContainText(create.body.error!.message);
  await expect(page.getByRole("dialog", { name: "Mailbox created" })).toHaveCount(0);

  /* Preflight and the tail need the live host and say it is away. */
  const preflight = await api.get(`/mail-servers/${row.id}/preflight`);
  expect(preflight.status).toBe(503);
  const tail = await api.get(`/mail-logs/tail?server_id=${row.server_id}`);
  expect(tail.status).toBe(503);
  expect(tail.body.error?.code).toBe("agent_offline");
  await page.goto(`/email/logs?server_id=${row.server_id}`);
  await expect(page.getByRole("main")).toContainText(tail.body.error!.message);

  /* A check is accepted, marked as waiting on the agent, and runs by
   * itself when the agent dials back in. */
  await page.goto("/email");
  await card.getByRole("button", { name: "Check now" }).click();
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  const entry = drawer.getByRole("listitem").filter({ hasText: "Check mail server" }).first();
  await expect(jobStatusPill(entry)).toContainText("Queued");
  const queued = (await api.data<JobRow[]>(`/jobs?type=mail.server.sync&server_id=${row.server_id}&per_page=1`))[0]!;
  expect(queued.status).toBe("queued");
  expect((queued as unknown as { blocked_reason: string | null }).blocked_reason).toBe("agent_offline");

  await startAgent(MAIL_HOST);
  expect((await api.job(queued.id, 90_000)).status).toBe("succeeded");
  await expect(jobStatusPill(entry)).toContainText("Succeeded", { timeout: 30_000 });
  await closeJobDrawer(page);
  await expect(card.getByRole("heading", { level: 2 })).toContainText("Agent Connected");
});

test("a job the host refuses fails visibly and marks its row", async ({ page }) => {
  const api = await owner();
  await syncMail(api, MAIL_HOST);
  const domain = (await mailDomainNamed(api, DOMAIN))!;
  /* detective@ is a seeded row the simulated host never had: the sync
   * marked it error rather than deleting it, which leaves a mailbox
   * Kaname knows and the host does not. */
  const ghost = (await mailboxAt(api, `detective@${DOMAIN}`))!;
  expect(ghost.status).toBe("error");

  const local = unique("ghost-alias");
  const created = await api.post<{ job: JobRow }>("/mail-aliases", {
    mail_domain_id: domain.id,
    local_part: local,
    mailbox_id: ghost.id,
  });
  expect(created.status, created.text).toBe(202);
  const job = await api.job(created.body.data!.job.id);
  expect(job.status).toBe("failed");
  expect(job.error?.message).toContain(`mailbox detective@${DOMAIN}`);
  expect((await aliasAt(api, `${local}@${DOMAIN}`))?.status).toBe("error");

  await page.goto("/email/aliases");
  const row = tableRow(page, "Aliases", `${local}@${DOMAIN}`);
  await expect(row).toContainText("Error");

  /* The way out works on a row the host never had. */
  await rowAction(page, row, "Remove alias");
  await page.getByRole("dialog", { name: `Remove ${local}@${DOMAIN}?` }).getByRole("button", { name: "Remove alias" }).click();
  await expectJobInDrawer(page, "Remove alias");
  await closeJobDrawer(page);
  await expect(row).toHaveCount(0);
});

test("the deploy dialog does not offer a host whose agent is away", async ({ page }) => {
  await stopAgent("edge-01");
  try {
    await page.goto("/email?deploy=1");
    const dialog = page.getByRole("dialog", { name: "Deploy Yunori Mail Server" });
    await dialog.getByRole("combobox", { name: "Server", exact: true }).click();
    const options = page.getByRole("listbox", { name: "Server" }).getByRole("option");
    await expect(options.filter({ hasText: "forge-01" })).toHaveCount(1);
    await expect(options.filter({ hasText: "edge-01" })).toHaveCount(0);

    const api = await owner();
    const edge = (await api.data<{ id: string; name: string }[]>("/servers?per_page=100")).find((s) => s.name === "edge-01")!;
    const domain = (await api.data<{ id: string; name: string }[]>("/domains?per_page=100")).find(
      (d) => d.name === "panel.futureforge.dev",
    )!;
    const refused = await api.post("/mail-servers", {
      server_id: edge.id,
      domain_id: domain.id,
      admin_email: "ops@example.org",
    });
    expect(refused.status).toBe(503);
    expect(refused.body.error?.code).toBe("agent_offline");
    expect(await mailServerOn(api, "edge-01")).toBeUndefined();
  } finally {
    await startAgent("edge-01");
  }
});
