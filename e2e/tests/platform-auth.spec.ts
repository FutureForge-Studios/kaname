import { expect, test, type Page } from "@playwright/test";
import { authStatePath, webUrl } from "../support/config.js";
import {
  accountWith,
  asOwner,
  call,
  contextCookie,
  data,
  freshIp,
  invite,
  login,
  roleBySlug,
  signInThroughForm,
  signedInContext,
  STRONG_PASSWORD,
  totp,
  uniqueEmail,
  wrongTotp,
  type ErrorBody,
} from "../support/platform.js";

/* ------------------------------------------------------------------ *
 * Platform — authentication.
 *
 * Every journey here runs as an account of its own, invited by the
 * owner and redeemed through the invitation token. The bootstrap
 * owner's session is the one every other spec rides on, so nothing in
 * this file changes its password, revokes its sessions or locks it out.
 *
 * Each browser context carries its own client address (the control
 * plane trusts X-Forwarded-For), so the per-address login limit is
 * exercised deliberately by one test rather than tripped by accident.
 * ------------------------------------------------------------------ */

test.use({ storageState: { cookies: [], origins: [] } });

const BAD_CREDENTIALS = "That email and password do not match an account.";

async function freshPage(browser: import("@playwright/test").Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: webUrl,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": freshIp() },
  });
  return context.newPage();
}

/* ------------------------------- sign in ------------------------------ */

test.describe("sign in", () => {
  test("a wrong password and an unknown address are refused identically", async ({ browser }) => {
    const account = await accountWith("wrongpw", ["viewer"]);
    const page = await freshPage(browser);

    await signInThroughForm(page, account.email, "not-the-password-at-all");
    const alert = page.getByText(BAD_CREDENTIALS);
    await expect(alert).toBeVisible();
    await expect(page.getByText(/Repeated failures lock the account for a while/)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    /* The address survives the failure; the password does not. */
    await expect(page.getByLabel("Email")).toHaveValue(account.email);
    await expect(page.getByLabel("Password")).toHaveValue("not-the-password-at-all");

    /* An address nobody has gets exactly the same words — no enumeration. */
    await page.getByLabel("Email").fill(uniqueEmail("nobody"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(BAD_CREDENTIALS)).toBeVisible();

    /* And the API agrees, with the same code for both. */
    const wrong = await call<ErrorBody>("POST", "/auth/login", {
      ip: freshIp(),
      body: { email: account.email, password: "nope-nope-nope" },
    });
    const unknown = await call<ErrorBody>("POST", "/auth/login", {
      ip: freshIp(),
      body: { email: uniqueEmail("ghost"), password: "nope-nope-nope" },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe("unauthenticated");
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  test("an unaccepted invitation is not given away at the sign-in form", async ({ browser }) => {
    const NOT_ACCEPTED = "This invitation hasn't been accepted yet.";
    /*
     * The invitee has no password yet, so anything they type is wrong.
     * Saying "this invitation hasn't been accepted yet" here would tell
     * anyone which addresses have been invited, so it is the generic
     * answer, word for word the one an unknown address gets.
     */
    const { user } = await invite("pending", [(await roleBySlug("viewer")).id]);
    const pending = await call<ErrorBody>("POST", "/auth/login", {
      ip: freshIp(),
      body: { email: user.email, password: STRONG_PASSWORD },
    });
    const unknown = await call<ErrorBody>("POST", "/auth/login", {
      ip: freshIp(),
      body: { email: uniqueEmail("ghost"), password: STRONG_PASSWORD },
    });
    expect(pending.status).toBe(401);
    // Everything but the per-request id is identical.
    const { request_id: _a, ...pendingError } = pending.body.error as ErrorBody["error"] & { request_id?: string };
    const { request_id: _b, ...unknownError } = unknown.body.error as ErrorBody["error"] & { request_id?: string };
    expect(pendingError).toEqual(unknownError);

    const page = await freshPage(browser);
    await signInThroughForm(page, user.email, STRONG_PASSWORD);
    await expect(page.getByText(BAD_CREDENTIALS)).toBeVisible();
    await expect(page.getByText(NOT_ACCEPTED, { exact: true })).toHaveCount(0);
    await page.context().close();

    /*
     * Only a caller who presents the account's real password — which an
     * account moved back to "invited" still has — learns the specific
     * reason, because they plainly already know the account exists.
     */
    const account = await accountWith("reinvited", ["viewer"]);
    data(await asOwner("PATCH", `/users/${account.id}`, { status: "invited" }), "move back");
    // A fresh page, so the generic error from the first attempt cannot linger.
    const second = await freshPage(browser);
    await signInThroughForm(second, account.email, account.password);
    await expect(second.getByText(NOT_ACCEPTED, { exact: true })).toBeVisible();
    await expect(second.getByText(BAD_CREDENTIALS, { exact: true })).toHaveCount(0);
    await second.context().close();
  });

  test("an empty form and a malformed address are named under their fields", async ({
    browser,
  }) => {
    const page = await freshPage(browser);
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.getByText("This field is required.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Email").fill("not-an-address");
    await page.getByLabel("Password").fill("something");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(page.getByText("This field is required.")).toHaveCount(0);
  });

  test("a deep link survives the sign-in it was interrupted by", async ({ browser }) => {
    const account = await accountWith("deeplink", ["owner"]);
    const page = await freshPage(browser);

    await page.goto("/administration/roles");
    await expect(page).toHaveURL(/\/login\?next=%2Fadministration%2Froles$/);

    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/administration\/roles$/);
    await expect(page.getByRole("heading", { level: 1, name: "Roles" })).toBeVisible();
  });

  test("next= cannot send a signed-in operator off-site", async ({ browser }) => {
    const account = await accountWith("opennext", ["owner"]);
    const page = await freshPage(browser);
    await page.goto("/login?next=%2F%2Fevil.example.com%2Fsteal");
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${webUrl}/`);
  });

  test("signing out ends the session everywhere it was valid", async ({ browser }) => {
    const account = await accountWith("signout", ["owner"]);
    const { context, page } = await signedInContext(browser, account);
    const cookie = await contextCookie(context);
    expect((await call("GET", "/auth/session", { cookie })).status).toBe(200);

    await page.goto("/infrastructure/servers");
    await page.getByRole("button", { name: /^Account — / }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    /* The cookie a thief copied before sign-out is worthless now. */
    const after = await call<ErrorBody>("GET", "/auth/session", { cookie });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("unauthenticated");

    /* Back does not resurrect the panel: it resolves to the sign-in form. */
    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});

/* ---------------------------- rate limiting ---------------------------- */

test("ten sign-ins a minute per address, then 429 — and only for that address", async ({
  browser,
}) => {
  const account = await accountWith("ratelimit", ["viewer"]);
  const ip = freshIp();

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const res = await call<ErrorBody>("POST", "/auth/login", {
      ip,
      body: { email: uniqueEmail("flood"), password: "wrong-wrong-wrong" },
    });
    expect(res.status, `attempt ${attempt}`).toBe(401);
  }

  /* The eleventh is refused before the password is even looked at —
   * the right password does not get through either. */
  const limited = await call<ErrorBody>("POST", "/auth/login", {
    ip,
    body: { email: account.email, password: account.password },
  });
  expect(limited.status).toBe(429);
  expect(limited.body.error.code).toBe("rate_limited");

  /* The limit is per address: the same account from elsewhere is fine. */
  const elsewhere = await call("POST", "/auth/login", {
    ip: freshIp(),
    body: { email: account.email, password: account.password },
  });
  expect(elsewhere.status).toBe(200);

  /* The form shows the limit rather than a generic failure. */
  const context = await browser.newContext({
    baseURL: webUrl,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": ip },
  });
  const page = await context.newPage();
  await signInThroughForm(page, account.email, account.password);
  await expect(page.getByText(/rate limit/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

/* ------------------------------- lockout ------------------------------- */

test.describe("account lockout", () => {
  test.afterEach(async () => {
    /* Restore the shipped policy for everything that runs after. */
    data(
      await asOwner("PATCH", "/settings", {
        security: {
          failed_login_lockout: { enabled: true, threshold: 8, lockout_minutes: 15 },
        },
      }),
      "restore lockout policy",
    );
  });

  test("repeated failures lock the account for the configured duration", async ({ browser }) => {
    data(
      await asOwner("PATCH", "/settings", {
        security: { failed_login_lockout: { enabled: true, threshold: 3, lockout_minutes: 2 } },
      }),
      "tighten lockout policy",
    );
    const account = await accountWith("lockout", ["viewer"]);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await call("POST", "/auth/login", {
        ip: freshIp(),
        body: { email: account.email, password: "wrong-wrong-wrong" },
      });
      expect(res.status, `failure ${attempt}`).toBe(401);
    }

    /* Now even the right password is refused, and says until when. */
    const started = Date.now();
    const locked = await call<ErrorBody>("POST", "/auth/login", {
      ip: freshIp(),
      body: { email: account.email, password: account.password },
    });
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toBe(
      "This account is locked after too many failed sign-ins.",
    );
    const until = Date.parse((locked.body.error.detail as { locked_until: string }).locked_until);
    /* Settings → Security → Lockout duration said two minutes, not fifteen. */
    expect(until - started).toBeGreaterThan(60_000);
    expect(until - started).toBeLessThanOrEqual(2 * 60_000 + 5_000);

    /* The form says the same thing to the person locked out. */
    const page = await freshPage(browser);
    await signInThroughForm(page, account.email, account.password);
    await expect(
      page.getByText("This account is locked after too many failed sign-ins."),
    ).toBeVisible();

    /* The way out it names is one that exists: Unlock, not "reactivate". */
    await expect(
      page.getByText(/An owner can lift it sooner with Unlock in Administration > Users\./),
    ).toBeVisible();

    /*
     * A locked account is still active, so the users page used to offer
     * only Suspend for it. The owner sees it marked locked and unlocks it
     * from the row menu; the unlock is audited on its own.
     */
    const ownerContext = await browser.newContext({ baseURL: webUrl, storageState: authStatePath });
    const admin = await ownerContext.newPage();
    await admin.goto(`/administration/users?q=${encodeURIComponent(account.email)}`);
    const row = admin.getByRole("table", { name: "Users" }).locator("tbody tr").filter({
      hasText: account.email,
    });
    await expect(row).toContainText("active");
    await expect(row).toContainText("locked");
    await row.getByRole("button", { name: "Row actions" }).click();
    await expect(admin.getByRole("menuitem", { name: "Suspend" })).toBeVisible();
    await admin.getByRole("menuitem", { name: "Unlock" }).click();
    await expect(admin.getByText(`${account.email} unlocked.`)).toBeVisible();
    await expect(row).not.toContainText("locked");
    await row.getByRole("button", { name: "Row actions" }).click();
    await expect(admin.getByRole("menuitem", { name: "Unlock" })).toHaveCount(0);
    await admin.keyboard.press("Escape");
    await ownerContext.close();

    const audit = data<{ action: string }[]>(
      await asOwner("GET", `/audit?action=user.unlocked&target_id=${account.id}`),
      "audit",
    );
    expect(audit.map((entry) => entry.action)).toEqual(["user.unlocked"]);

    /* And the person locked out signs straight in. */
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("with lockout off, failures never lock the account", async () => {
    data(
      await asOwner("PATCH", "/settings", {
        security: { failed_login_lockout: { enabled: false, threshold: 3 } },
      }),
      "disable lockout",
    );
    const account = await accountWith("nolock", ["viewer"]);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await call("POST", "/auth/login", {
        ip: freshIp(),
        body: { email: account.email, password: "wrong-wrong-wrong" },
      });
    }
    expect((await login(account.email, account.password)).length).toBeGreaterThan(0);
  });
});

/* ------------------------- suspended accounts -------------------------- */

test("a suspended account is refused at the door and cut off mid-session", async ({ browser }) => {
  const account = await accountWith("suspend", ["operator"]);
  const { context, page } = await signedInContext(browser, account);
  const cookie = await contextCookie(context);

  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("heading", { level: 1, name: "Servers" })).toBeVisible();

  data(await asOwner("POST", `/users/${account.id}/suspend`), "suspend");

  /* The session it already held stops working on the very next request. */
  expect((await call("GET", "/servers", { cookie })).status).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/login\?next=%2Finfrastructure%2Fservers$/);

  /* And signing in again says why, with the way back. */
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This account is suspended.")).toBeVisible();
  await expect(
    page.getByText("An owner can reactivate it from Administration > Users."),
  ).toBeVisible();

  /* Reactivated, the same password works and lands where it was going. */
  data(await asOwner("POST", `/users/${account.id}/activate`), "activate");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/infrastructure\/servers$/);
});

/* ------------------------------ two-factor ----------------------------- */

test.describe.serial("two-factor authentication", () => {
  let account: Awaited<ReturnType<typeof accountWith>>;
  let secret = "";
  let recovery: string[] = [];

  /*
   * Each 30-second step is accepted once (replay protection), and these
   * tests sign in three times, often inside one step — so the same
   * current code was refused the second time, depending on timing. This
   * hands out a code for a step not used yet: the current one, or the
   * next (the server allows one step of skew), and when both are spent
   * it waits for the authenticator to move on, a real condition.
   */
  let lastStep = -Infinity;
  async function unusedTotp(): Promise<string> {
    await expect
      .poll(() => Math.floor(Date.now() / 30_000) + 1 > lastStep, {
        timeout: 60_000,
        message: "the authenticator to issue an unused code",
      })
      .toBe(true);
    const step = Math.max(Math.floor(Date.now() / 30_000), lastStep + 1);
    lastStep = step;
    return totp(secret, step * 30_000);
  }

  test.beforeAll(async () => {
    account = await accountWith("totp", ["owner"]);
  });

  test("enrolment shows the secret once and refuses a wrong code", async ({ browser }) => {
    const { page } = await signedInContext(browser, account);
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();

    const card = page.locator("#two-factor");
    await expect(card.getByText("not enrolled")).toBeVisible();
    await card.getByRole("button", { name: "Set up" }).click();

    await expect(
      card.getByRole("img", { name: "Scan this code with an authenticator app" }),
    ).toBeVisible();
    secret = (
      (await card
        .getByText(/^[A-Z2-7]{16,}$/)
        .first()
        .textContent()) ?? ""
    ).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    recovery = (await card.locator("ul li").allInnerTexts()).map((code) => code.trim());
    expect(recovery).toHaveLength(10);

    /* Turn on stays disabled until six digits are typed. */
    const turnOn = card.getByRole("button", { name: "Turn on" });
    await expect(turnOn).toBeDisabled();

    const field = card.getByLabel("3. Enter the code your app shows");
    await field.fill(wrongTotp(secret));
    await turnOn.click();
    await expect(card.getByText("That authentication code is not valid.")).toBeVisible();
    await expect(card.getByText("not enrolled")).toBeVisible();

    await field.fill(await unusedTotp());
    await turnOn.click();
    await expect(page.getByText("Two-factor authentication is on.")).toBeVisible();
    await expect(card.getByText("enabled", { exact: true })).toBeVisible();
    /* The secret and the codes are gone from the screen for good. */
    await expect(card.getByText(secret)).toHaveCount(0);
    await page.reload();
    await expect(card.getByRole("button", { name: "Set up" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Turn off" })).toBeVisible();
  });

  test("sign-in asks for the code, refuses a wrong one and accepts the right one", async ({
    browser,
  }) => {
    const page = await freshPage(browser);
    await signInThroughForm(page, account.email, account.password);

    await expect(page.getByRole("heading", { name: "Two-factor code" })).toBeVisible();
    /* Past the password but not in: the API agrees. */
    expect(await page.context().cookies()).toHaveLength(0);

    await page.getByLabel("Code").fill(wrongTotp(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("That authentication code is not valid.")).toBeVisible();
    await expect(page.getByLabel("Code")).toHaveValue("");

    await page.getByLabel("Code").fill(await unusedTotp());
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(`${webUrl}/`);
  });

  test("a recovery code signs in exactly once", async ({ browser }) => {
    const code = recovery[0]!;
    const page = await freshPage(browser);
    await signInThroughForm(page, account.email, account.password);
    await page.getByLabel("Code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(`${webUrl}/`);

    const again = await freshPage(browser);
    await signInThroughForm(again, account.email, account.password);
    await again.getByLabel("Code").fill(code);
    await again.getByRole("button", { name: "Verify" }).click();
    await expect(again.getByText("That authentication code is not valid.")).toBeVisible();
  });

  test("a forged challenge is refused and sends the operator back to the password", async () => {
    const res = await call<ErrorBody>("POST", "/auth/totp", {
      ip: freshIp(),
      body: { challenge: "Zm9yZ2Vk.c2lnbmF0dXJl", code: totp(secret) },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("This sign-in attempt has expired.");
  });

  test("a challenge cannot be redeemed from a different address", async () => {
    const first = await call<{ data: { status: string; challenge: string } }>(
      "POST",
      "/auth/login",
      { ip: freshIp(), body: { email: account.email, password: account.password } },
    );
    expect(first.body.data.status).toBe("totp_required");
    const stolen = await call<ErrorBody>("POST", "/auth/totp", {
      ip: freshIp(),
      body: { challenge: first.body.data.challenge, code: totp(secret) },
    });
    expect(stolen.status).toBe(401);
    expect(stolen.body.error.message).toBe("This sign-in attempt has expired.");
  });

  test("turning it off needs the password, then sign-in is one step again", async ({ browser }) => {
    const page = await freshPage(browser);
    await signInThroughForm(page, account.email, account.password);
    await page.getByLabel("Code").fill(await unusedTotp());
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(`${webUrl}/`);

    await page.goto("/account");
    const card = page.locator("#two-factor");
    await card.getByRole("button", { name: "Turn off" }).click();

    const dialog = page.getByRole("dialog", { name: "Turn off two-factor authentication?" });
    await dialog.getByLabel("Confirm with your password").fill("not-my-password");
    await dialog.getByRole("button", { name: "Turn it off" }).click();
    await expect(dialog.getByText("does not match")).toBeVisible();

    await dialog.getByLabel("Confirm with your password").fill(account.password);
    await dialog.getByRole("button", { name: "Turn it off" }).click();
    await expect(page.getByText("Two-factor authentication is off.")).toBeVisible();
    await expect(card.getByText("not enrolled")).toBeVisible();

    const plain = await call<{ data: { status: string } }>("POST", "/auth/login", {
      ip: freshIp(),
      body: { email: account.email, password: account.password },
    });
    expect(plain.body.data.status).toBe("ok");
  });
});

/* ------------------------------- sessions ------------------------------ */

test("the session list shows every browser and revokes one without touching this one", async ({
  browser,
}) => {
  const account = await accountWith("sessions", ["viewer"]);
  const here = await signedInContext(browser, account);
  const there = await signedInContext(browser, account);
  const thereCookie = await contextCookie(there.context);

  /* Reached from the account menu, as a person would find it. */
  await here.page.goto("/");
  await here.page.getByRole("button", { name: /^Account — / }).click();
  await here.page.getByRole("menuitem", { name: "Your profile and sessions" }).click();
  await expect(here.page).toHaveURL(/\/account$/);

  const table = here.page.getByRole("table", { name: "Active sessions" });
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "this device" })).toHaveCount(1);

  const other = rows.filter({ hasNotText: "this device" });
  await other.getByRole("button", { name: "Row actions" }).click();
  await here.page.getByRole("menuitem", { name: "Revoke" }).click();
  const confirm = here.page.getByRole("dialog", { name: "Revoke this session?" });
  await confirm.getByRole("button", { name: "Revoke session" }).click();
  await expect(here.page.getByText("Session revoked.")).toBeVisible();
  await expect(rows).toHaveCount(1);

  /* The other browser is out on its next request; this one is not. */
  expect((await call("GET", "/auth/session", { cookie: thereCookie })).status).toBe(401);
  await there.page.goto("/infrastructure/servers");
  await expect(there.page).toHaveURL(/\/login/);
  await here.page.reload();
  await expect(rows).toHaveCount(1);
  await expect(here.page.getByRole("button", { name: "Sign out everywhere else" })).toBeDisabled();
});

test("sign out everywhere else keeps exactly this browser", async ({ browser }) => {
  const account = await accountWith("everywhere", ["viewer"]);
  const here = await signedInContext(browser, account);
  const others = [
    await login(account.email, account.password),
    await login(account.email, account.password),
  ];

  await here.page.goto("/account");
  const rows = here.page.getByRole("table", { name: "Active sessions" }).locator("tbody tr");
  await expect(rows).toHaveCount(3);

  await here.page.getByRole("button", { name: "Sign out everywhere else" }).click();
  const confirm = here.page.getByRole("dialog", { name: "Sign out everywhere else?" });
  await confirm.getByRole("button", { name: "Sign out other sessions" }).click();
  await expect(here.page.getByText("2 other sessions signed out.")).toBeVisible();
  await expect(rows).toHaveCount(1);

  for (const cookie of others) {
    expect((await call("GET", "/auth/session", { cookie })).status).toBe(401);
  }
  expect(
    (await call("GET", "/auth/session", { cookie: await contextCookie(here.context) })).status,
  ).toBe(200);
});

test("signing out this device from the list is a sign-out", async ({ browser }) => {
  const account = await accountWith("selfrevoke", ["viewer"]);
  const { context, page } = await signedInContext(browser, account);
  const cookie = await contextCookie(context);

  await page.goto("/account");
  const mine = page.getByRole("table", { name: "Active sessions" }).locator("tbody tr");
  await mine.first().getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Sign out this device" }).click();
  const confirm = page.getByRole("dialog", { name: "Sign out of this device?" });
  await confirm.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login/);
  expect((await call("GET", "/auth/session", { cookie })).status).toBe(401);
});

test("an API key has no session to list or sign out", async () => {
  const created = data<{ token: string }>(
    await asOwner("POST", "/api-keys", { name: "no-session", scopes: ["infra.servers:read"] }),
    "mint key",
  );
  const listed = await call<ErrorBody>("GET", "/me/sessions", { bearer: created.token });
  expect(listed.status).toBe(400);
  const out = await call<ErrorBody>("POST", "/auth/logout", { bearer: created.token });
  expect(out.status).toBe(400);
  expect(out.body.error.message).toBe("API keys do not hold a browser session.");
});

/* --------------------------- password change --------------------------- */

test("changing the password validates each field and ends every other session", async ({
  browser,
}) => {
  const account = await accountWith("password", ["viewer"]);
  const here = await signedInContext(browser, account);
  const elsewhere = await login(account.email, account.password);
  const page = here.page;

  await page.goto("/account");
  const current = page.getByLabel("Current password");
  const next = page.getByLabel("New password");
  const repeat = page.getByLabel("Repeat it");
  const submit = page.getByRole("button", { name: "Change password" });

  await expect(submit).toBeDisabled();

  /* The repeat check is the browser's; it names the field it is about. */
  await current.fill(account.password);
  await next.fill("Granite-Lantern-Meadow-91");
  await repeat.fill("Granite-Lantern-Meadow-19");
  await expect(page.getByText("The two entries do not match.")).toBeVisible();
  await expect(submit).toBeDisabled();

  /* A wrong current password is named under that field. */
  await current.fill("definitely-not-it");
  await repeat.fill("Granite-Lantern-Meadow-91");
  await submit.click();
  await expect(page.getByText("does not match")).toBeVisible();

  /* Too short, under the new-password field. */
  await current.fill(account.password);
  await next.fill("short");
  await repeat.fill("short");
  await submit.click();
  await expect(page.getByText("Must be at least 12 characters.")).toBeVisible();

  /* The same password again is not a change. */
  await next.fill(account.password);
  await repeat.fill(account.password);
  await submit.click();
  await expect(page.getByText("must differ from the current password")).toBeVisible();

  /* Strength is enforced here as it is when the account is created. */
  await next.fill("aaaaaaaaaaaaaaaa");
  await repeat.fill("aaaaaaaaaaaaaaaa");
  await submit.click();
  await expect(page.getByText(/Mix upper and lower case/)).toBeVisible();

  await next.fill("Granite-Lantern-Meadow-91");
  await repeat.fill("Granite-Lantern-Meadow-91");
  await submit.click();
  await expect(
    page.getByText("Password changed. Every other session was signed out."),
  ).toBeVisible();
  await expect(current).toHaveValue("");

  /* This tab keeps working on its fresh cookie; the other one is dead. */
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  expect((await call("GET", "/auth/session", { cookie: elsewhere })).status).toBe(401);
  await expect(
    page.getByRole("table", { name: "Active sessions" }).locator("tbody tr"),
  ).toHaveCount(1);

  /* The old password is gone, the new one works. */
  const old = await call("POST", "/auth/login", {
    ip: freshIp(),
    body: { email: account.email, password: account.password },
  });
  expect(old.status).toBe(401);
  expect((await login(account.email, "Granite-Lantern-Meadow-91")).length).toBeGreaterThan(0);
  expect(STRONG_PASSWORD).not.toBe("Granite-Lantern-Meadow-91");
});
