import { expect, test, type Browser, type Page } from "@playwright/test";
import { SYSTEM_ROLES, type Permission, type SystemRoleSlug } from "@kaname/contract";
import { missingId } from "../support/config.js";
import {
  Api,
  argon2Hash,
  mailDomainNamed,
  mailServerOn,
  mailboxAt,
  openDatabase,
  owner,
  rowAction,
  syncMail,
  tableRow,
  unique,
  withControlPlaneStopped,
} from "../support/email.js";

/* ------------------------------------------------------------------ *
 * Email — who may do what (packages/contract/src/rbac.ts).
 *
 * One user per system role is created through the admin API exactly as
 * an owner would invite them. Accepting an invitation has no route yet
 * (an invited account cannot set a password anywhere: see the report),
 * so the spec stops the control plane for a moment and activates the
 * invited rows with a known password, then signs in as each.
 *
 * The API matrix probes every Email route with an id that does not
 * exist, which separates the two answers that matter: 403 when the
 * permission is missing, 404 when it is held and the row simply is not
 * there. Then each role is walked through the panel: owners and
 * operators get the buttons, an auditor reads everything and changes
 * nothing, and a developer or a viewer has no Email at all.
 * ------------------------------------------------------------------ */

const ROLES: SystemRoleSlug[] = ["owner", "operator", "developer", "auditor", "viewer"];
const PASSWORD = "rbac-e2e-passphrase-1!";
const stamp = Math.random().toString(36).slice(2, 7);
const emailFor = (role: SystemRoleSlug) => `rbac-${role}-${stamp}@kaname.test`;

const can = (role: SystemRoleSlug, permission: Permission) =>
  (SYSTEM_ROLES[role].permissions as readonly Permission[]).includes(permission);

const apis = new Map<SystemRoleSlug, Api>();

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const admin = await owner();
  const roles = await admin.data<{ id: string; slug: string }[]>("/roles?per_page=100");
  for (const role of ROLES) {
    const id = roles.find((r) => r.slug === role)?.id;
    expect(id, `system role ${role}`).toBeTruthy();
    const res = await admin.post("/users", {
      email: emailFor(role),
      name: `RBAC ${role}`,
      role_ids: [id],
      send_invite: false,
    });
    expect(res.status, res.text).toBe(201);
  }

  const hash = await argon2Hash(PASSWORD);
  await withControlPlaneStopped(async () => {
    const db = await openDatabase();
    try {
      const updated = await db.query(
        `update users set password_hash = $1, status = 'active', invite_token_hash = null
          where email = any($2::text[]) returning email`,
        [hash, ROLES.map(emailFor)],
      );
      expect(updated.rows).toHaveLength(ROLES.length);
    } finally {
      await db.close();
    }
  });

  for (const role of ROLES) apis.set(role, await Api.signIn(emailFor(role), PASSWORD));
  await syncMail(await owner(), "mail-01");
});

interface Probe {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  permission: Permission;
}

const PROBES: Probe[] = [
  { method: "GET", path: `/mail-servers/${missingId}`, permission: "email.servers:read" },
  { method: "POST", path: `/mail-servers/${missingId}/sync`, permission: "email.servers:read" },
  { method: "GET", path: `/mail-servers/${missingId}/preflight`, permission: "email.servers:read" },
  { method: "POST", path: `/mail-servers/${missingId}/update`, permission: "email.servers:exec" },
  { method: "POST", path: `/mail-servers/${missingId}/certificate/renew`, permission: "email.servers:exec" },
  { method: "GET", path: `/mail-servers/${missingId}/deploy-secrets`, permission: "email.servers:write" },
  { method: "DELETE", path: `/mail-servers/${missingId}`, permission: "email.servers:write" },
  {
    method: "POST",
    path: "/mail-servers",
    body: { server_id: missingId, domain_id: missingId, admin_email: "ops@example.org" },
    permission: "email.servers:write",
  },
  { method: "POST", path: "/mail-servers/adopt", body: { server_id: missingId }, permission: "email.servers:write" },
  { method: "GET", path: `/mail-domains/${missingId}`, permission: "email.mailboxes:read" },
  { method: "GET", path: `/mail-domains/${missingId}/dns`, permission: "email.mailboxes:read" },
  { method: "POST", path: `/mail-domains/${missingId}/dns/check`, permission: "email.servers:exec" },
  { method: "DELETE", path: `/mail-domains/${missingId}`, permission: "email.mailboxes:delete" },
  {
    method: "POST",
    path: "/mail-domains",
    body: { domain_id: missingId, server_id: missingId },
    permission: "email.mailboxes:write",
  },
  { method: "GET", path: `/mailboxes/${missingId}`, permission: "email.mailboxes:read" },
  {
    method: "POST",
    path: "/mailboxes",
    body: { mail_domain_id: missingId, local_part: "probe" },
    permission: "email.mailboxes:write",
  },
  { method: "POST", path: `/mailboxes/${missingId}/reset-password`, permission: "email.mailboxes:write" },
  { method: "DELETE", path: `/mailboxes/${missingId}`, permission: "email.mailboxes:delete" },
  { method: "GET", path: `/mail-aliases/${missingId}`, permission: "email.routing:read" },
  {
    method: "POST",
    path: "/mail-aliases",
    body: { mail_domain_id: missingId, local_part: "probe", mailbox_id: missingId },
    permission: "email.routing:write",
  },
  { method: "DELETE", path: `/mail-aliases/${missingId}`, permission: "email.routing:delete" },
  { method: "GET", path: `/mail-logs/tail?server_id=${missingId}`, permission: "email.logs:read" },
];

const LISTS: { path: string; permission: Permission }[] = [
  { path: "/mail-servers", permission: "email.servers:read" },
  { path: "/mail-domains", permission: "email.mailboxes:read" },
  { path: "/mailboxes", permission: "email.mailboxes:read" },
  { path: "/mail-aliases", permission: "email.routing:read" },
];

for (const role of ROLES) {
  test(`${role}: every Email route answers 403 without the permission and 404 with it`, async () => {
    const api = apis.get(role)!;
    for (const list of LISTS) {
      const res = await api.get(list.path);
      expect(res.status, `${role} GET ${list.path}`).toBe(can(role, list.permission) ? 200 : 403);
      if (!can(role, list.permission)) {
        expect(res.body.error?.message).toBe(`You do not have ${list.permission}.`);
      }
    }
    for (const probe of PROBES) {
      const res = await api.request(probe.method, probe.path, probe.body);
      const label = `${role} ${probe.method} ${probe.path} (${probe.permission})`;
      if (can(role, probe.permission)) {
        expect(res.status, `${label}: ${res.text}`).toBe(404);
      } else {
        expect(res.status, `${label}: ${res.text}`).toBe(403);
        expect(res.body.error?.code).toBe("forbidden");
      }
    }
  });
}

test("refusals change nothing: an auditor cannot create, reset or delete a real mailbox", async () => {
  const auditor = apis.get("auditor")!;
  const admin = await owner();
  const domain = (await mailDomainNamed(admin, "futureforge.dev"))!;
  const hello = (await mailboxAt(admin, "hello@futureforge.dev"))!;
  const local = unique("audited");

  const create = await auditor.post("/mailboxes", { mail_domain_id: domain.id, local_part: local });
  expect(create.status).toBe(403);
  expect(create.text).not.toMatch(/"password"/);
  expect(await mailboxAt(admin, `${local}@futureforge.dev`)).toBeUndefined();

  const reset = await auditor.post(`/mailboxes/${hello.id}/reset-password`);
  expect(reset.status).toBe(403);
  expect(reset.text).not.toMatch(/"password"/);

  const remove = await auditor.del(`/mailboxes/${hello.id}`);
  expect(remove.status).toBe(403);
  expect((await mailboxAt(admin, "hello@futureforge.dev"))?.status).toBe("active");

  /* An operator holds the permission and really gets a credential. */
  const operator = apis.get("operator")!;
  const made = await operator.post<{ mailbox: { id: string }; password: string }>("/mailboxes", {
    mail_domain_id: domain.id,
    local_part: local,
  });
  expect(made.status, made.text).toBe(201);
  expect(made.body.data!.password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/);
  /* The secret is the operator's alone: nobody else can read it back. */
  const asOwner = await admin.get(`/mailboxes/${made.body.data!.mailbox.id}`);
  expect(asOwner.text).not.toContain(made.body.data!.password);
  const cleanup = await admin.del<{ job: { id: string } }>(`/mailboxes/${made.body.data!.mailbox.id}`);
  expect((await admin.job(cleanup.body.data!.job.id)).status).toBe("succeeded");
});

/**
 * The auditor signs in through the form like a person would. The others
 * carry the session their API sign-in already made: the login route
 * allows ten attempts a minute, and this spec would otherwise spend them.
 */
async function signedInPage(browser: Browser, role: SystemRoleSlug): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  if (role === "auditor") {
    await page.goto("/login");
    await page.getByLabel("Email").fill(emailFor(role));
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    return page;
  }
  const [name, ...rest] = apis.get(role)!.cookie.split("=");
  await context.addCookies([{ name: name!, value: rest.join("="), domain: "127.0.0.1", path: "/" }]);
  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

for (const role of ["owner", "operator"] as const) {
  test(`${role}: the panel offers every Email action`, async ({ browser }) => {
    const page = await signedInPage(browser, role);
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Mail servers" })).toBeVisible();

    await page.goto("/email");
    await expect(page.getByRole("button", { name: "Deploy Yunori Mail Server" }).first()).toBeEnabled();
    await expect(page.getByRole("button", { name: "Adopt existing" })).toBeEnabled();

    await page.goto("/email/mailboxes");
    await expect(page.getByRole("button", { name: "Create mailbox" })).toBeEnabled();
    const row = tableRow(page, "Mailboxes", "hello@futureforge.dev");
    await row.getByRole("button", { name: "Row actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Reset password" })).toBeEnabled();
    await expect(page.getByRole("menuitem", { name: "Delete mailbox" })).toBeEnabled();
    await page.keyboard.press("Escape");

    await page.goto("/email/aliases");
    await expect(page.getByRole("button", { name: "Add alias" })).toBeEnabled();
    await page.context().close();
  });
}

test("auditor: reads every Email page and every mutation is disabled", async ({ browser }) => {
  const page = await signedInPage(browser, "auditor");
  const admin = await owner();
  const mail = (await mailServerOn(admin, "mail-01"))!;

  await page.goto("/email");
  await expect(page.getByRole("button", { name: "Deploy Yunori Mail Server" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Adopt existing" })).toBeDisabled();
  const card = page.getByRole("main").getByRole("listitem").filter({ hasText: "mail-01" }).first();
  await card.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Update yunori-mail" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Renew certificate" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Forget", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto("/email/domains");
  await expect(page.getByRole("button", { name: "Add domain" })).toBeDisabled();
  await rowAction(page, tableRow(page, "Mail domains", "futureforge.dev"), "DNS records");
  const drawer = page.getByRole("dialog").filter({ hasText: "DNS records for" });
  await expect(drawer.getByRole("list", { name: "DNS records" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Check now" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto("/email/mailboxes");
  await expect(page.getByRole("button", { name: "Create mailbox" })).toBeDisabled();
  await tableRow(page, "Mailboxes", "hello@futureforge.dev").getByRole("button", { name: "Row actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Reset password" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete mailbox" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto("/email/aliases");
  await expect(page.getByRole("button", { name: "Add alias" })).toBeDisabled();

  await page.goto(`/email/health?server_id=${mail.server_id}`);
  await expect(page.getByRole("button", { name: "Renew certificate" })).toBeDisabled();
  await page.goto(`/email/logs?server_id=${mail.server_id}`);
  await expect(page.getByRole("log", { name: "Mail log on mail-01" })).toContainText("stalwart-mail");
  await page.context().close();
});

for (const role of ["developer", "viewer"] as const) {
  test(`${role}: has no Email in the panel, and a deep link is refused plainly`, async ({ browser }) => {
    const page = await signedInPage(browser, role);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Command Center" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Mail servers" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: /^Mailboxes/ })).toHaveCount(0);

    await page.goto("/email/mailboxes");
    await expect(page.getByRole("main")).toContainText("You do not have email.mailboxes:read.");
    await expect(page.getByRole("table", { name: "Mailboxes" })).toHaveCount(0);
    await page.goto("/email");
    await expect(page.getByRole("main")).toContainText("You do not have email.servers:read.");
    await page.context().close();
  });
}
