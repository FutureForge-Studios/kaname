import { expect, test } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { authStatePath } from "../support/config.js";
import {
  accountWith,
  accountWithRoleIds,
  asOwner,
  call,
  contextCookie,
  createRole,
  data,
  login,
  roleBySlug,
  sidebarEntries,
  signedInContext,
  type ErrorBody,
} from "../support/platform.js";

/* ------------------------------------------------------------------ *
 * Platform — the RBAC matrix, end to end.
 *
 * For each system role a real account is invited, redeems its
 * invitation and signs in through the form. Three things are then
 * checked from that account's own browser and cookie:
 *
 *   1. the sidebar lists exactly the sections the role may read —
 *      written out here by hand from the role definitions, so a drift
 *      in either the roles or the navigation is caught rather than
 *      re-derived;
 *   2. a deep link to a page it may not read shows the forbidden state,
 *      naming the permission, with the shell intact;
 *   3. a mutation it may not perform is refused by the API with 403 and
 *      the permission named — the UI hiding a button is not the control.
 * ------------------------------------------------------------------ */

test.use({ storageState: { cookies: [], origins: [] } });

const EVERYTHING = [
  "Command Center",
  "Apps",
  "Infrastructure › Servers",
  "Infrastructure › Services",
  "Infrastructure › Processes",
  "Infrastructure › Containers",
  "Websites › Sites",
  "Websites › Domains",
  "Websites › DNS",
  "Websites › SSL / TLS",
  "Websites › Deployments",
  "Files › File Manager",
  "Files › FTP / SFTP",
  "Files › Storage",
  "Email › Mail servers",
  "Email › Domains",
  "Email › Mailboxes",
  "Email › Aliases",
  "Email › Health",
  "Email › Mail Logs",
  "Databases › MySQL / MariaDB",
  "Databases › PostgreSQL",
  "Security › Firewall",
  "Security › Threat Protection",
  "Security › SSH Security",
  "Security › Audit",
  "Backups",
  "Monitoring",
  "Logs",
  "Terminal",
  "Administration › Users",
  "Administration › Roles",
  "Administration › API",
  "Administration › Updates",
  "Administration › Settings",
];

interface RoleCase {
  slug: "owner" | "operator" | "developer" | "auditor" | "viewer";
  sidebar: string[];
  /** A page this role may not read, and the permission it lacks. */
  forbiddenPage?: { path: string; permission: string };
  /** A page it may read, as proof the deep link itself is fine. */
  allowedPage: { path: string; heading: string };
  /** A mutation it may not perform. */
  forbiddenCall?: {
    method: string;
    path: (ids: Ids) => string;
    body?: unknown;
    permission: string;
  };
}

interface Ids {
  server: string;
  ownerRole: string;
}

const CASES: RoleCase[] = [
  {
    slug: "owner",
    sidebar: EVERYTHING,
    allowedPage: { path: "/administration/settings", heading: "Settings" },
  },
  {
    slug: "operator",
    sidebar: EVERYTHING.filter((entry) => !entry.startsWith("Administration")),
    forbiddenPage: { path: "/administration/users", permission: "admin.users:read" },
    allowedPage: { path: "/security/firewall", heading: "Firewall" },
    forbiddenCall: {
      method: "POST",
      path: () => "/roles",
      body: { name: "Escalation", grants: [] },
      permission: "admin.roles:write",
    },
  },
  {
    slug: "developer",
    sidebar: [
      "Command Center",
      "Infrastructure › Servers",
      "Infrastructure › Services",
      "Infrastructure › Processes",
      "Infrastructure › Containers",
      "Websites › Sites",
      "Websites › Domains",
      "Websites › DNS",
      "Websites › SSL / TLS",
      "Websites › Deployments",
      "Files › File Manager",
      "Files › Storage",
      "Databases › MySQL / MariaDB",
      "Databases › PostgreSQL",
      "Monitoring",
      "Logs",
    ],
    forbiddenPage: { path: "/security/audit", permission: "security.audit:read" },
    allowedPage: { path: "/websites/sites", heading: "Sites" },
    forbiddenCall: {
      method: "POST",
      path: (ids) => `/servers/${ids.server}/enroll-token`,
      body: {},
      permission: "infra.servers:write",
    },
  },
  {
    slug: "auditor",
    sidebar: EVERYTHING.filter((entry) => entry !== "Terminal"),
    allowedPage: { path: "/security/audit", heading: "Audit" },
    forbiddenCall: {
      method: "PATCH",
      path: () => "/settings",
      body: { panel: { name: "Audited" } },
      permission: "admin.settings:write",
    },
  },
  {
    slug: "viewer",
    sidebar: [
      "Command Center",
      "Infrastructure › Servers",
      "Infrastructure › Services",
      "Infrastructure › Containers",
      "Monitoring",
    ],
    forbiddenPage: { path: "/websites/sites", permission: "websites.sites:read" },
    allowedPage: { path: "/monitoring", heading: "Monitoring" },
    forbiddenCall: {
      method: "POST",
      path: () => "/users",
      body: {
        email: "x@example.com",
        name: "X",
        role_ids: ["00000000-0000-4000-8000-000000000000"],
      },
      permission: "admin.users:write",
    },
  },
];

for (const role of CASES) {
  test(`${role.slug}: sidebar, forbidden deep link and forbidden mutation`, async ({ browser }) => {
    const account = await accountWith(`rbac-${role.slug}`, [role.slug]);
    const { context, page } = await signedInContext(browser, account);
    const cookie = await contextCookie(context);

    /* 1. The sidebar is exactly what the role may read, in order. */
    await page.goto(role.allowedPage.path);
    await expect(
      page.getByRole("heading", { level: 1, name: role.allowedPage.heading }),
    ).toBeVisible();
    expect(await sidebarEntries(page)).toEqual(role.sidebar);

    /* And the session the panel read it from agrees, grant for grant. */
    const session = data<{ permissions: { permission: string }[] }>(
      await call("GET", "/auth/session", { cookie }),
      "session",
    );
    const expected = (await roleGrants(role.slug)).sort();
    expect(session.permissions.map((grant) => grant.permission).sort()).toEqual(expected);

    /* 2. A deep link it may not read shows the forbidden state. */
    if (role.forbiddenPage) {
      await page.goto(role.forbiddenPage.path);
      const error = page.getByRole("alert").filter({ hasText: "forbidden" }).first();
      await expect(error).toBeVisible();
      await expect(error).toContainText(`You do not have ${role.forbiddenPage.permission}.`);
      await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible();
      /* No sidebar entry points at it. */
      await expect(
        page
          .getByRole("navigation", { name: "Primary" })
          .first()
          .locator(`a[href="${role.forbiddenPage.path}"]`),
      ).toHaveCount(0);
    }

    /* 3. A mutation it may not perform is refused by the API itself. */
    if (role.forbiddenCall) {
      const server = (await serverNamed("forge-01")).id;
      const ownerRole = (await roleBySlug("owner")).id;
      const res = await call<ErrorBody>(
        role.forbiddenCall.method,
        role.forbiddenCall.path({ server, ownerRole }),
        {
          cookie,
          body: role.forbiddenCall.body,
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(res.body.error.message).toBe(`You do not have ${role.forbiddenCall.permission}.`);
      expect(res.body.error.remediation?.summary).toContain(
        "Ask an owner to grant this permission",
      );
    }
  });
}

/** The grants a system role carries, read from the API rather than restated. */
async function roleGrants(slug: string): Promise<string[]> {
  const role = data<{ grants: { permission: string }[] }>(
    await asOwner("GET", `/roles/${(await roleBySlug(slug)).id}`),
    `role ${slug}`,
  );
  return role.grants.map((grant) => grant.permission);
}

test("nobody can promote themselves: an operator editing its own roles is refused", async () => {
  const account = await accountWith("selfpromote", ["operator"]);
  const cookie = await login(account.email, account.password);
  const ownerRole = await roleBySlug("owner");
  const res = await call<ErrorBody>("POST", `/users/${account.id}/roles`, {
    cookie,
    body: { role_ids: [ownerRole.id] },
  });
  expect(res.status).toBe(403);
  expect(res.body.error.message).toBe("You do not have admin.users:write.");
  /* And the account is still an operator, not an owner. */
  const user = data<{ roles: { slug: string }[] }>(
    await asOwner("GET", `/users/${account.id}`),
    "user",
  );
  expect(user.roles.map((role) => role.slug)).toEqual(["operator"]);
});

/* --------------------------- per-server scope --------------------------- */

test("a role scoped to one server sees that server and is refused the rest", async ({
  browser,
}) => {
  const forge = await serverNamed("forge-01");
  const mail = await serverNamed("mail-01");
  const role = await createRole(`Forge only ${Date.now().toString(36)}`, [
    { permission: "infra.servers:read", scope: { kind: "servers", server_ids: [forge.id] } },
    { permission: "infra.services:read", scope: { kind: "servers", server_ids: [forge.id] } },
    { permission: "infra.servers:write", scope: { kind: "servers", server_ids: [forge.id] } },
  ]);
  const account = await accountWithRoleIds("scoped", [role.id]);
  const { context, page } = await signedInContext(browser, account);
  const cookie = await contextCookie(context);

  /* The fleet list is the scope, not the fleet. */
  await page.goto("/infrastructure/servers");
  const table = page.getByRole("table", { name: "Servers" });
  await expect(table.locator("tbody tr").filter({ hasText: "forge-01" })).toHaveCount(1);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  expect(await sidebarEntries(page)).toEqual([
    "Command Center",
    "Infrastructure › Servers",
    "Infrastructure › Services",
  ]);

  const listed = data<{ name: string }[]>(
    await call("GET", "/servers?per_page=100", { cookie }),
    "list",
  );
  expect(listed.map((server) => server.name)).toEqual(["forge-01"]);

  /* In scope: the detail page opens. */
  await page.goto(`/infrastructure/servers/${forge.id}`);
  await expect(
    page.getByRole("heading", { level: 1 }).filter({ hasText: "forge-01" }),
  ).toBeVisible();

  /* Out of scope: the deep link is forbidden, never a silent empty page. */
  await page.goto(`/infrastructure/servers/${mail.id}`);
  const error = page.getByRole("alert").filter({ hasText: "forbidden" }).first();
  await expect(error).toBeVisible();
  await expect(error).toContainText("You do not have infra.servers:read.");

  /* And a write scoped to forge-01 does not reach mail-01. */
  const allowed = await call("POST", `/servers/${forge.id}/enroll-token`, { cookie, body: {} });
  expect(allowed.status).toBeLessThan(300);
  const refused = await call<ErrorBody>("POST", `/servers/${mail.id}/enroll-token`, {
    cookie,
    body: {},
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error.message).toBe("You do not have infra.servers:write.");
});

/* ----------------------------- custom roles ----------------------------- */

test.describe("as the owner", () => {
  test.use({ storageState: authStatePath });

  test("a custom role is built in the editor, granted, and becomes the account's panel", async ({
    page,
    browser,
  }) => {
    const roleName = `Mail desk ${Date.now().toString(36)}`;
    await page.goto("/administration/roles");
    await page.getByRole("button", { name: "New role" }).click();
    await expect(page).toHaveURL(/\/administration\/roles\/new$/);

    const create = page.getByRole("button", { name: "Create role" });
    await expect(create).toBeDisabled();

    await page.getByRole("textbox", { name: /^Name/ }).fill(roleName);
    await page.getByLabel("Read Mailboxes").check();
    await page.getByLabel("Read Mail servers & DNS").check();
    await create.click();

    await expect(page.getByText(`Role "${roleName}" created.`)).toBeVisible();
    await expect(page).toHaveURL(/\/administration\/roles\/[0-9a-f-]{36}$/);
    await expect(page.getByText("custom", { exact: true })).toBeVisible();
    const roleId = page.url().split("/").pop()!;

    /* Granted to a fresh account, it is exactly that account's sidebar. */
    const account = await accountWithRoleIds("custom", [roleId]);
    const member = await signedInContext(browser, account);
    await member.page.goto("/email");
    expect(await sidebarEntries(member.page)).toEqual([
      "Email › Mail servers",
      "Email › Domains",
      "Email › Mailboxes",
      "Email › Health",
    ]);

    /* An assigned role cannot be deleted out from under its holders. */
    const refused = await asOwner<ErrorBody>("DELETE", `/roles/${roleId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(`${roleName} is still assigned to 1 user(s).`);

    /* Editing it takes effect on the member's next request. */
    data(
      await asOwner("PATCH", `/roles/${roleId}`, {
        grants: [{ permission: "email.mailboxes:read", scope: { kind: "global" } }],
      }),
      "narrow role",
    );
    await member.page.reload();
    expect(await sidebarEntries(member.page)).toEqual(["Email › Domains", "Email › Mailboxes"]);
  });

  test("system roles are read-only and cannot be deleted or shadowed", async ({ page }) => {
    const viewer = await roleBySlug("viewer");
    await page.goto(`/administration/roles/${viewer.id}`);
    await expect(page.getByText("system role", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByLabel("Read Servers")).toBeDisabled();

    const patched = await asOwner<ErrorBody>("PATCH", `/roles/${viewer.id}`, { name: "Renamed" });
    expect(patched.status).toBe(409);
    const deleted = await asOwner<ErrorBody>("DELETE", `/roles/${viewer.id}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error.message).toBe("Viewer is a system role and cannot be deleted.");
    const shadow = await asOwner<ErrorBody>("POST", "/roles", { name: "Owner", grants: [] });
    expect(shadow.status).toBe(409);
    expect(shadow.body.error.message).toBe('"owner" is reserved for a system role.');

    /* A role id that does not exist is a not-found page, not a blank editor. */
    await page.goto("/administration/roles/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("alert").filter({ hasText: "not_found" }).first()).toBeVisible();
  });
});
