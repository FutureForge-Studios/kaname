import { expect, test, type Locator, type Page } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { webUrl } from "../support/config.js";
import {
  acceptInvite,
  accountWith,
  asOwner,
  call,
  contextCookie,
  createRole,
  data,
  invite,
  login,
  roleBySlug,
  sidebarEntries,
  signedInContext,
  STRONG_PASSWORD,
  uniqueEmail,
  accountWithRoleIds,
  type ErrorBody,
} from "../support/platform.js";
import { startSmtpSink } from "../support/smtp-sink.js";

/* ------------------------------------------------------------------ *
 * Platform — administration: users, API keys and settings.
 *
 * Driven from the owner's browser, with every outcome checked where it
 * matters: an invitation is redeemed, a role change is a different
 * sidebar for the person it was made to, a revoked key is a 401 on the
 * next request, and a test email arrives at a mail server.
 * ------------------------------------------------------------------ */

function dialogNamed(page: Page, name: string | RegExp): Locator {
  return page.getByRole("dialog", { name });
}

async function chooseOption(page: Page, field: Locator, option: string): Promise<void> {
  await field.click();
  await field.fill(option);
  await page.getByRole("option", { name: new RegExp(`^${option}`) }).click();
  await page.keyboard.press("Escape");
}

function usersTable(page: Page): Locator {
  return page.getByRole("table", { name: "Users" });
}

function rowFor(table: Locator, text: string): Locator {
  return table.locator("tbody tr").filter({ hasText: text });
}

async function rowAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

/* -------------------------------- users -------------------------------- */

test.describe("users", () => {
  test("inviting validates each field, refuses a duplicate and hands over the link once", async ({
    page,
  }) => {
    await page.goto("/administration/users");
    await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
    await page.getByRole("button", { name: "Invite user" }).first().click();

    const dialog = dialogNamed(page, "Invite a user");
    /* Empty, the browser's own required-field check stops the submit. */
    await dialog.getByRole("button", { name: "Send invitation" }).click();
    const emailField = dialog.getByRole("textbox", { name: /^Email/ });
    expect(await emailField.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await expect(dialog).toBeVisible();

    /* Past the browser, the control plane names each field it refuses. */
    await emailField.fill("ines@localhost");
    await dialog.getByRole("textbox", { name: /^Name/ }).fill("Ines Invitee");
    await dialog.getByRole("button", { name: "Send invitation" }).click();
    await expect(dialog.getByText("Invalid email")).toBeVisible();
    await expect(dialog.getByText("Array must contain at least 1 element(s)")).toBeVisible();

    const email = uniqueEmail("invitee");
    await dialog.getByRole("textbox", { name: /^Email/ }).fill(email);
    await dialog.getByRole("textbox", { name: /^Name/ }).fill("Ines Invitee");
    await chooseOption(page, dialog.getByRole("combobox", { name: /^Roles/ }), "Viewer");
    await dialog.getByRole("button", { name: "Send invitation" }).click();

    const issued = dialogNamed(page, `${email} is invited`);
    await expect(issued).toBeVisible();
    const link = (await issued.getByText(/\/invite\//).first().textContent())!.trim();
    expect(link.startsWith(`${webUrl}/invite/kn_invite`)).toBe(true);
    await issued.getByRole("button", { name: "Done" }).click();
    await expect(issued).toHaveCount(0);

    const row = rowFor(usersTable(page), email);
    await expect(row).toContainText("invited");
    await expect(row).toContainText("Viewer");
    await expect(row).toContainText("never");

    /* The same address again is a conflict, with the way to the original. */
    await page.getByRole("button", { name: "Invite user" }).first().click();
    const again = dialogNamed(page, "Invite a user");
    await again.getByRole("textbox", { name: /^Email/ }).fill(email.toUpperCase());
    await again.getByRole("textbox", { name: /^Name/ }).fill("Ines Again");
    await chooseOption(page, again.getByRole("combobox", { name: /^Roles/ }), "Viewer");
    await again.getByRole("button", { name: "Send invitation" }).click();
    await expect(again.getByText(`${email} already has an account.`)).toBeVisible();
    await again.getByRole("button", { name: "Cancel" }).click();

    /* An invited account has no password yet, so it cannot sign in. */
    const early = await call<ErrorBody>("POST", "/auth/login", {
      body: { email, password: STRONG_PASSWORD },
    });
    expect(early.status).toBe(401);

    /* Redeemed once, the account is active and the link is spent. */
    const token = decodeURIComponent(link.split("/invite/")[1]!);
    expect((await acceptInvite(token, STRONG_PASSWORD)).status).toBe(200);
    const reused = await acceptInvite(token, "Another-Strong-Passphrase-88");
    expect(reused.status).toBe(401);
    expect((await login(email, STRONG_PASSWORD)).length).toBeGreaterThan(0);

    await page.reload();
    await expect(rowFor(usersTable(page), email)).toContainText("active");
  });

  test("the invitation link opens a page that sets the first password", async ({ browser }) => {
    const { user } = await invite("invitepage", [(await roleBySlug("viewer")).id]);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(user.invite.url);

    /* The link an owner was told to send has to lead somewhere. */
    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
    const submit = page.getByRole("button", { name: "Set password and sign in" });

    await submit.click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await expect(page.getByText("Type the password again.")).toBeVisible();

    /* Strength is the server's call, shown under the field. */
    await page.getByLabel("Password", { exact: true }).fill("aaaaaaaaaaaaaa");
    await page.getByLabel("Confirm password").fill("aaaaaaaaaaaaaa");
    await submit.click();
    await expect(page.getByText(/Mix upper and lower case\./)).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill(STRONG_PASSWORD);
    await page.getByLabel("Confirm password").fill("Something-Else-Entirely-1");
    await submit.click();
    await expect(page.getByText("The two passwords do not match.")).toBeVisible();

    await page.getByLabel("Confirm password").fill(STRONG_PASSWORD);
    await submit.click();
    /* Signed straight in, as a viewer: the Command Center, not admin. */
    await expect(page).toHaveURL(`${webUrl}/`);
    await expect(page.getByRole("heading", { level: 1, name: "Command Center" })).toBeVisible();
    expect(await sidebarEntries(page)).not.toContain("Administration › Users");

    /* The same link a second time is spent, and says so. */
    const again = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
    await again.goto(user.invite.url);
    await again.getByLabel("Password", { exact: true }).fill("Another-Strong-Passphrase-88");
    await again.getByLabel("Confirm password").fill("Another-Strong-Passphrase-88");
    await again.getByRole("button", { name: "Set password and sign in" }).click();
    await expect(again.getByText("This invitation is not valid any more.")).toBeVisible();
    await expect(again).toHaveURL(/\/invite\//);
  });

  test("a weak or spent invitation is refused with a reason", async () => {
    const { token } = await invite("weakinvite", [(await roleBySlug("viewer")).id]);
    const weak = await acceptInvite(token, "aaaaaaaaaaaa");
    expect(weak.status).toBe(422);
    const bogus = await acceptInvite("kn_invite_not-a-real-token", STRONG_PASSWORD);
    expect(bogus.status).toBe(401);
  });

  test("a role change is a different panel on the member's next request", async ({
    page,
    browser,
  }) => {
    const account = await accountWith("rolechange", ["viewer"]);
    const member = await signedInContext(browser, account);
    await member.page.goto("/monitoring");
    expect(await sidebarEntries(member.page)).not.toContain("Security › Firewall");

    await page.goto("/administration/users");
    const row = rowFor(usersTable(page), account.email);
    await row.click();
    const dialog = dialogNamed(page, account.email);
    await dialog.getByRole("button", { name: "Remove Viewer" }).click();
    await chooseOption(page, dialog.getByRole("combobox", { name: /^Roles/ }), "Operator");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(`${account.email} updated.`)).toBeVisible();
    await expect(row).toContainText("Operator");
    await expect(row).not.toContainText("Viewer");

    await member.page.reload();
    const entries = await sidebarEntries(member.page);
    expect(entries).toContain("Security › Firewall");
    expect(entries).toContain("Terminal");
    expect(entries.some((entry) => entry.startsWith("Administration"))).toBe(false);

    /* A role list cannot be emptied: every account has to hold one. */
    await row.click();
    await dialog.getByRole("button", { name: "Remove Operator" }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByText("Array must contain at least 1 element(s)")).toBeVisible();
  });

  test("suspend and activate from the row menu bite immediately", async ({ page, browser }) => {
    const account = await accountWith("suspendrow", ["viewer"]);
    const member = await signedInContext(browser, account);
    const cookie = await contextCookie(member.context);

    await page.goto("/administration/users");
    const row = rowFor(usersTable(page), account.email);
    await rowAction(page, row, "Suspend");
    await expect(page.getByText("1 account suspended.")).toBeVisible();
    await expect(row).toContainText("suspended");
    expect((await call("GET", "/auth/session", { cookie })).status).toBe(401);

    await rowAction(page, row, "Activate");
    await expect(page.getByText("1 account activated.")).toBeVisible();
    await expect(row).toContainText("active");
    /* Suspension ended the old session; a new sign-in works. */
    expect((await login(account.email, account.password)).length).toBeGreaterThan(0);
  });

  test("deleting an account needs its address typed and takes its keys with it", async ({
    page,
  }) => {
    const account = await accountWith("deleteme", ["owner"]);
    const cookie = await login(account.email, account.password);
    const key = data<{ token: string }>(
      await call("POST", "/api-keys", {
        cookie,
        body: { name: "outlives-me", scopes: ["infra.servers:read"] },
      }),
      "mint key",
    );
    expect((await call("GET", "/servers", { bearer: key.token })).status).toBe(200);

    await page.goto("/administration/users");
    const row = rowFor(usersTable(page), account.email);
    await rowAction(page, row, "Delete");
    const confirm = dialogNamed(page, `Delete ${account.email}?`);
    const go = confirm.getByRole("button", { name: "Delete account" });
    await expect(go).toBeDisabled();
    await confirm.getByRole("textbox").fill("not the address");
    await expect(go).toBeDisabled();
    await confirm.getByRole("textbox").fill(account.email);
    await go.click();
    await expect(page.getByText(`${account.email} deleted.`)).toBeVisible();
    await expect(row).toHaveCount(0);

    expect((await call("GET", "/auth/session", { cookie })).status).toBe(401);
    expect((await call("GET", "/servers", { bearer: key.token })).status).toBe(401);
    expect((await asOwner("GET", `/users/${account.id}`)).status).toBe(404);
  });

  test("an owner cannot delete their own account", async ({ page }) => {
    await page.goto("/administration/users");
    const me = usersTable(page).locator("tbody tr").filter({ hasText: "you" }).first();
    await me.getByRole("button", { name: "Row actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    await page.keyboard.press("Escape");

    const session = data<{ user: { id: string } }>(await asOwner("GET", "/auth/session"), "me");
    const res = await asOwner<ErrorBody>("DELETE", `/users/${session.user.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("You cannot delete your own account.");
  });

  test("a user id that does not exist is not found, not an empty record", async () => {
    const res = await asOwner<ErrorBody>("GET", "/users/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

/* ------------------------------- API keys ------------------------------ */

test.describe("API keys", () => {
  test("a key is shown once, does exactly what it was given, and dies on revoke", async ({
    page,
  }) => {
    await page.goto("/administration/api");
    await expect(page.getByRole("heading", { level: 1, name: "API" })).toBeVisible();
    await page.getByRole("button", { name: "New API key" }).first().click();

    const dialog = dialogNamed(page, "New API key");
    const create = dialog.getByRole("button", { name: "Create key" });
    await expect(create).toBeDisabled();
    const name = `ci-read-${Date.now().toString(36)}`;
    await dialog.getByRole("textbox", { name: /^Name/ }).fill(name);
    await expect(create).toBeDisabled();
    await dialog.getByLabel("Read Servers").check();
    await create.click();

    const issued = dialogNamed(page, `${name} is ready`);
    await expect(issued.getByText("This will not be shown again.")).toBeVisible();
    const token = ((await issued.getByText(/^kn_live_/).first().textContent()) ?? "").trim();
    expect(token).toMatch(/^kn_live_[0-9a-f]{8}_.+/);
    await expect(issued).toContainText("1 permissions · whole fleet");
    await issued.getByRole("button", { name: "I have copied it" }).click();
    await expect(issued).toHaveCount(0);

    /* Nowhere on the page, and nowhere in the API, is the secret again. */
    await expect(page.getByText(token)).toHaveCount(0);
    const table = page.getByRole("table", { name: "API keys" });
    const row = rowFor(table, name);
    await expect(row).toContainText("active");
    await expect(row).toContainText("never");
    const listed = await asOwner("GET", "/api-keys?per_page=200");
    expect(JSON.stringify(listed.body)).not.toContain(token.split("_").slice(3).join("_"));

    /* What it was given works; nothing else does. */
    const servers = data<unknown[]>(await call("GET", "/servers", { bearer: token }), "servers");
    expect(servers).toHaveLength(4);
    const users = await call<ErrorBody>("GET", "/users", { bearer: token });
    expect(users.status).toBe(403);
    expect(users.body.error.message).toBe("You do not have admin.users:read.");
    const forge = await serverNamed("forge-01");
    const write = await call<ErrorBody>("POST", `/servers/${forge.id}/enroll-token`, {
      bearer: token,
      body: {},
    });
    expect(write.status).toBe(403);
    expect(write.body.error.message).toBe("You do not have infra.servers:write.");

    /* The key is a principal of its own: the session probe says so. */
    const probe = data<{ user: null; api_key: { name: string } }>(
      await call("GET", "/auth/session", { bearer: token }),
      "probe",
    );
    expect(probe.user).toBeNull();
    expect(probe.api_key.name).toBe(name);

    await page.reload();
    await expect(row).not.toContainText("never");

    /* Revoking needs the prefix typed, and the next request is refused. */
    await rowAction(page, row, "Revoke");
    const confirm = dialogNamed(page, `Revoke ${name}?`);
    const prefix = token.split("_").slice(0, 3).join("_");
    await confirm.getByRole("textbox").fill(prefix);
    await confirm.getByRole("button", { name: "Revoke key" }).click();
    await expect(page.getByText("1 key revoked.")).toBeVisible();
    await expect(row).toContainText("revoked");

    const after = await call<ErrorBody>("GET", "/servers", { bearer: token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("unauthenticated");

    /* Revoked keys stay listed, and revoking twice is a conflict. */
    const keyId = (listed.body as { data: { id: string; name: string }[] }).data.find(
      (key) => key.name === name,
    )!.id;
    const twice = await asOwner<ErrorBody>("POST", `/api-keys/${keyId}/revoke`);
    expect(twice.status).toBe(409);
    await expect(row.getByRole("button", { name: "Row actions" })).toBeVisible();
  });

  test("a tampered or unknown token is refused, not half-accepted", async () => {
    const minted = data<{ token: string }>(
      await asOwner("POST", "/api-keys", { name: "tamper", scopes: ["infra.servers:read"] }),
      "mint",
    );
    const tampered = `${minted.token.slice(0, -2)}xx`;
    expect((await call("GET", "/servers", { bearer: tampered })).status).toBe(401);
    expect((await call("GET", "/servers", { bearer: "kn_live_deadbeef_nope" })).status).toBe(401);
    expect((await call("GET", "/servers", { bearer: "garbage" })).status).toBe(401);
  });

  test("a key cannot mint keys, and cannot exceed the person who made it", async () => {
    const powerful = data<{ token: string }>(
      await asOwner("POST", "/api-keys", { name: "would-mint", scopes: ["admin.api_keys:write"] }),
      "mint",
    );
    const nested = await call<ErrorBody>("POST", "/api-keys", {
      bearer: powerful.token,
      body: { name: "child", scopes: ["infra.servers:read"] },
    });
    expect(nested.status).toBe(403);
    expect(nested.body.error.message).toBe("An API key cannot create another API key.");

    const forge = await serverNamed("forge-01");
    const mail = await serverNamed("mail-01");
    const role = await createRole(`Key maker ${Date.now().toString(36)}`, [
      { permission: "admin.api_keys:write", scope: { kind: "global" } },
      { permission: "infra.servers:read", scope: { kind: "servers", server_ids: [forge.id] } },
    ]);
    const maker = await accountWithRoleIds("keymaker", [role.id]);
    const cookie = await login(maker.email, maker.password);

    const global = await call<ErrorBody>("POST", "/api-keys", {
      cookie,
      body: { name: "too-wide", scopes: ["infra.servers:read"], scope_kind: "global" },
    });
    expect(global.status).toBe(403);
    expect(global.body.error.message).toContain("infra.servers:read");

    const wrongServer = await call<ErrorBody>("POST", "/api-keys", {
      cookie,
      body: {
        name: "wrong-server",
        scopes: ["infra.servers:read"],
        scope_kind: "servers",
        scope_server_ids: [mail.id],
      },
    });
    expect(wrongServer.status).toBe(403);

    const scoped = data<{ token: string }>(
      await call("POST", "/api-keys", {
        cookie,
        body: {
          name: "forge-only",
          scopes: ["infra.servers:read"],
          scope_kind: "servers",
          scope_server_ids: [forge.id],
        },
      }),
      "scoped key",
    );
    const seen = data<{ name: string }[]>(await call("GET", "/servers", { bearer: scoped.token }), "list");
    expect(seen.map((server) => server.name)).toEqual(["forge-01"]);
    const other = await call<ErrorBody>("GET", `/servers/${mail.id}`, { bearer: scoped.token });
    expect(other.status).toBe(403);

    /* No server named is a field error, not a fleet-wide key. */
    const none = await call<ErrorBody>("POST", "/api-keys", {
      cookie,
      body: { name: "none", scopes: ["infra.servers:read"], scope_kind: "servers" },
    });
    expect(none.status).toBe(422);
    expect(none.body.error.fields?.["scope_server_ids"]).toBe("select at least one server");
  });

  test("the key grid will not offer what the creator does not hold", async ({ browser }) => {
    const role = await createRole(`Grid ${Date.now().toString(36)}`, [
      { permission: "admin.api_keys:read", scope: { kind: "global" } },
      { permission: "admin.api_keys:write", scope: { kind: "global" } },
      { permission: "infra.servers:read", scope: { kind: "global" } },
    ]);
    const account = await accountWithRoleIds("grid", [role.id]);
    const { page } = await signedInContext(browser, account);
    await page.goto("/administration/api");
    await page.getByRole("button", { name: "New API key" }).first().click();
    const dialog = dialogNamed(page, "New API key");
    await expect(dialog.getByLabel("Read Servers")).toBeEnabled();
    const blocked = dialog.getByLabel("Write Servers");
    await expect(blocked).toBeDisabled();
    await expect(blocked).toHaveAttribute(
      "title",
      "You do not hold infra.servers:write, so you cannot delegate it.",
    );
  });

  test("a key stops working when its creator is suspended or loses the permission", async () => {
    const account = await accountWith("keyowner", ["owner"]);
    const cookie = await login(account.email, account.password);
    const key = data<{ token: string }>(
      await call("POST", "/api-keys", {
        cookie,
        body: { name: "creator-bound", scopes: ["admin.users:read", "infra.servers:read"] },
      }),
      "mint",
    );
    expect((await call("GET", "/users", { bearer: key.token })).status).toBe(200);

    /* Demoted to viewer: the key may no longer read users either. */
    const viewer = await roleBySlug("viewer");
    data(await asOwner("POST", `/users/${account.id}/roles`, { role_ids: [viewer.id] }), "demote");
    const demoted = await call<ErrorBody>("GET", "/users", { bearer: key.token });
    expect(demoted.status).toBe(403);
    expect(demoted.body.error.message).toBe("You do not have admin.users:read.");
    expect((await call("GET", "/servers", { bearer: key.token })).status).toBe(200);

    /* Suspended: the key is refused outright, like the account's sessions. */
    data(await asOwner("POST", `/users/${account.id}/suspend`), "suspend");
    expect((await call("GET", "/servers", { bearer: key.token })).status).toBe(401);

    data(await asOwner("POST", `/users/${account.id}/activate`), "activate");
    expect((await call("GET", "/servers", { bearer: key.token })).status).toBe(200);
  });
});

/* ------------------------------- settings ------------------------------ */

test.describe.serial("settings", () => {
  test("the panel name saves, survives a reload and is audited", async ({ page }) => {
    await page.goto("/administration/settings");
    const panel = page.locator("section#panel");
    const name = panel.getByRole("textbox").first();
    await expect(name).toHaveValue("Kaname");
    const save = panel.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();

    await name.fill("Forge Fleet");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Panel saved.")).toBeVisible();
    await page.reload();
    await expect(page.locator("section#panel").getByRole("textbox").first()).toHaveValue("Forge Fleet");

    /* Empty is refused, with the field named. */
    await page.locator("section#panel").getByRole("textbox").first().fill("");
    await page.locator("section#panel").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("section#panel").getByRole("list", { name: "Panel problems" })).toHaveText(
      "panel.name: String must contain at least 1 character(s)",
    );

    const audit = data<{ action: string }[]>(
      await asOwner("GET", "/audit?per_page=20&q=settings"),
      "audit",
    ).map((entry) => entry.action);
    expect(audit).toContain("settings.updated");

    data(await asOwner("PATCH", "/settings", { panel: { name: "Kaname" } }), "restore name");
  });

  test("the address cannot be changed on an instance install.sh did not set up", async ({
    page,
  }) => {
    await page.goto("/administration/settings");
    const address = page.locator("section#address");
    await expect(address.getByText(`${webUrl}`)).toBeVisible();
    await expect(address.getByText(/was not installed by/)).toBeVisible();
    await expect(address.getByRole("button", { name: "Save" })).toHaveCount(0);

    const refused = await asOwner<ErrorBody>("POST", "/settings/address", {
      domain: "panel.example.com",
    });
    expect(refused.status).toBe(412);
    expect(refused.body.error.message).toBe("This instance does not manage its own address.");

    const invalid = await asOwner<ErrorBody>("POST", "/settings/address", { domain: "not a host" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.fields?.["domain"]).toBe(
      "Enter a hostname like panel.example.com, or leave it empty to use the IP address.",
    );
  });

  test("outgoing mail is saved with a sealed password and a test email really arrives", async ({
    page,
  }) => {
    const sink = await startSmtpSink();
    try {
      await page.goto("/administration/settings");
      const smtp = page.locator("section#outgoing-mail");
      await smtp.getByPlaceholder("smtp.example.com").fill("127.0.0.1");
      await smtp.getByLabel("SMTP port").fill(String(sink.port));
      await smtp.getByLabel("Connection security").selectOption("none");
      await smtp.getByPlaceholder("username").fill("relay-user");
      await smtp.getByPlaceholder("password").fill("relay-secret-1234");
      await smtp.getByPlaceholder("Kaname").fill("Forge alerts");

      /* A sender that is not an address is named before anything is stored. */
      await smtp.getByPlaceholder("kaname@example.com").fill("not-an-address");
      await smtp.getByRole("button", { name: "Save" }).click();
      await expect(smtp.getByText(/The sender must be an email address\./)).toBeVisible();

      await smtp.getByPlaceholder("kaname@example.com").fill("alerts@forge.example.com");
      await smtp.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Outgoing mail saved.")).toBeVisible();

      /* The password never comes back: not to the form, not to the API. */
      await page.reload();
      const reloaded = page.locator("section#outgoing-mail");
      await expect(reloaded.getByPlaceholder("smtp.example.com")).toHaveValue("127.0.0.1");
      await expect(reloaded.getByPlaceholder("•••••••• (unchanged)")).toHaveValue("");
      const stored = await asOwner("GET", "/settings");
      expect(JSON.stringify(stored.body)).not.toContain("relay-secret-1234");
      expect(
        (stored.body as { data: { notifications: { smtp: { password_set: boolean } } } }).data
          .notifications.smtp.password_set,
      ).toBe(true);

      /* The test goes through the stored password, to a real server. */
      const to = "ops@forge.example.com";
      await reloaded.getByPlaceholder("you@example.com").fill(to);
      await reloaded.getByRole("button", { name: "Send test email" }).click();
      await expect(reloaded.getByText(/^Delivered in \d+ ms\.$/)).toBeVisible();
      expect(sink.received).toHaveLength(1);
      const mail = sink.received[0]!;
      expect(mail.to).toEqual([to]);
      expect(mail.from).toBe("alerts@forge.example.com");
      expect(mail.auth).toEqual({ user: "relay-user", pass: "relay-secret-1234" });
      expect(mail.data).toContain("Test email from Kaname");

      /* A server that is not there is reported as exactly that. */
      await reloaded.getByLabel("SMTP port").fill("1");
      await reloaded.getByRole("button", { name: "Send test email" }).click();
      await expect(reloaded.getByText(/ECONNREFUSED|refused|connect/i)).toBeVisible();
      await reloaded.getByRole("button", { name: "Discard" }).click();
    } finally {
      await sink.close();
    }
  });

  test("an auditor reads settings but every control is read only", async ({ browser }) => {
    const account = await accountWith("readonly", ["auditor"]);
    const { page, context } = await signedInContext(browser, account);
    await page.goto("/administration/settings");
    await expect(page.getByText("read only", { exact: true })).toBeVisible();
    await expect(page.locator("section#panel").getByRole("textbox").first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send test email" })).toBeDisabled();

    const cookie = await contextCookie(context);
    const patch = await call<ErrorBody>("PATCH", "/settings", {
      cookie,
      body: { panel: { name: "Mine now" } },
    });
    expect(patch.status).toBe(403);
    expect(patch.body.error.message).toBe("You do not have admin.settings:write.");
    const smtp = await call<ErrorBody>("POST", "/settings/notifications/smtp/test", {
      cookie,
      body: { to: "x@example.com" },
    });
    expect(smtp.status).toBe(403);
  });
});
