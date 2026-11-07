import { readFileSync, existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { apiUrl, webUrl } from "../support/config.js";
import { call, freshIp, type ErrorBody } from "../support/platform.js";
import {
  hostQueueFile,
  pairSimulatedAgent,
  setupToken,
  wizardEnvFile,
} from "../support/wizard-stack.js";

/* ------------------------------------------------------------------ *
 * Platform — the setup wizard, on a fresh install.
 *
 * One instance, claimed once, so the journey is serial: each test picks
 * up where the previous one left the instance. The setup token is the
 * one the control plane logged on boot (wizard-stack.ts), read the way
 * the README tells an operator to recover it.
 *
 * What is asserted is what the server remembers, not what the browser
 * does: every resume is a reload, and every "skip" is checked against
 * the outcome GET /setup/state records for that step.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const OWNER = {
  name: "Wren Installer",
  email: "wren@fresh.example.com",
  password: "Copper-Harbour-Lantern-73",
};

interface SetupStateBody {
  needs_onboarding: boolean;
  step: string;
  has_owner: boolean;
  authorized: boolean;
  token_required: boolean;
  completed_at: string | null;
  instance_name: string | null;
  outcomes: Record<string, string | null>;
}

async function state(cookie?: string): Promise<SetupStateBody> {
  const res = await call<{ data: SetupStateBody }>("GET", "/setup/state", { cookie });
  expect(res.status).toBe(200);
  return res.body.data;
}

let page: Page;
let ownerCookie = "";

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: webUrl,
    extraHTTPHeaders: { "x-forwarded-for": freshIp() },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
});

async function cookieOf(): Promise<string> {
  const cookies = await page.context().cookies(webUrl);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/* ------------------------------- the token ------------------------------ */

test("a fresh install sends every entry point to setup and asks for the token", async () => {
  const fresh = await state();
  expect(fresh.needs_onboarding).toBe(true);
  expect(fresh.has_owner).toBe(false);
  expect(fresh.token_required).toBe(true);
  expect(fresh.authorized).toBe(false);

  for (const path of ["/", "/login"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/setup$/);
  }
  await expect(page.getByRole("heading", { name: "Enter your setup token" })).toBeVisible();

  /* Nothing past the gate answers without the token. */
  const owner = await call<ErrorBody>("POST", "/setup/owner", {
    ip: freshIp(),
    body: { ...OWNER, password_confirmation: OWNER.password },
  });
  expect(owner.status).toBeGreaterThanOrEqual(401);
  expect(owner.status).toBeLessThan(500);
  expect((await state()).has_owner).toBe(false);
});

test("an empty, short or wrong token is refused with the reason", async () => {
  const field = page.getByLabel("Setup token");
  const go = page.getByRole("button", { name: "Continue" });

  await go.click();
  await expect(page.getByText("Paste the token the installer printed.")).toBeVisible();

  await field.fill("kn_setup_");
  await go.click();
  await expect(page.getByText("That is too short to be a setup token.")).toBeVisible();

  await field.fill("kn_setup_0000000000000000000000000000");
  await go.click();
  const refused = page.getByRole("alert").first();
  await expect(refused).toBeVisible();
  await expect(page.getByRole("heading", { name: "Enter your setup token" })).toBeVisible();
  expect((await state(await cookieOf())).authorized).toBe(false);
});

test("the logged token opens the wizard, and a reload keeps it open", async () => {
  await page.getByLabel("Setup token").fill(setupToken());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Checking the install" })).toBeVisible();
  await expect(page.getByText("Control plane")).toBeVisible();

  /* Presented, not spent: a reload before the account exists is fine. */
  await page.reload();
  await expect(page.getByRole("heading", { name: "Checking the install" })).toBeVisible();
  expect((await state(await cookieOf())).authorized).toBe(true);

  /* Not an all-in-one install, so the check does not wait on an agent. */
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
});

/* ------------------------------- the owner ------------------------------ */

test("the account step names each problem and the server has the last word", async () => {
  const create = page.getByRole("button", { name: "Create account" });
  await create.click();
  await expect(page.getByText("Enter your name.")).toBeVisible();
  await expect(page.getByText("Enter a full email address, like you@example.com.")).toBeVisible();
  await expect(page.getByText("Choose a password.")).toBeVisible();
  await expect(page.getByText("Type the password again.")).toBeVisible();

  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill("wren-fresh-password-1");
  await page.getByLabel("Confirm password").fill("something else entirely");
  await create.click();
  await expect(page.getByText("Do not reuse your name or email in the password.").first()).toBeVisible();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();

  /* The browser's check is a courtesy; the control plane refuses too. */
  const weak = await call<ErrorBody>("POST", "/setup/owner", {
    cookie: await cookieOf(),
    ip: freshIp(),
    body: {
      name: OWNER.name,
      email: OWNER.email,
      password: "aaaaaaaaaaaa",
      password_confirmation: "aaaaaaaaaaaa",
    },
  });
  expect(weak.status).toBe(422);
  expect(weak.body.error.message).toBe("That password is not strong enough.");

  /* Reloading mid-form resumes on the same step. */
  await page.reload();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  await page.getByLabel("Name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await create.click();
  await expect(page.getByRole("heading", { name: "Name this instance" })).toBeVisible();
  ownerCookie = await cookieOf();
});

test("the setup token is retired the moment the owner exists", async ({ browser }) => {
  const again = await call<ErrorBody>("POST", "/setup/token", {
    ip: freshIp(),
    body: { token: setupToken() },
  });
  expect(again.status).toBe(409);

  const second = await call<ErrorBody>("POST", "/setup/owner", {
    ip: freshIp(),
    body: {
      name: "Mallory",
      email: "mallory@fresh.example.com",
      password: "Sable-Quarry-Window-58",
      password_confirmation: "Sable-Quarry-Window-58",
    },
  });
  expect(second.status).toBeGreaterThanOrEqual(401);
  expect(second.status).toBeLessThan(500);

  /* A stranger who still has the token lands on sign-in, never the wizard. */
  const stranger = await browser.newContext({ baseURL: webUrl });
  const strangerPage = await stranger.newPage();
  await strangerPage.goto("/setup");
  await expect(strangerPage).toHaveURL(/\/login\?next=%2Fsetup$/);
  await stranger.close();
});

/* ------------------------- instance and server -------------------------- */

test("the instance is named, and a reload resumes on the server step", async () => {
  const field = page.getByLabel("Name");
  await field.fill("");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Name this instance" })).toBeVisible();

  await field.fill("Harbour");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Your first server" })).toBeVisible();
  expect((await state(ownerCookie)).instance_name).toBe("Harbour");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your first server" })).toBeVisible();
});

test("pairing hands over a one-liner, and the step resolves when the agent dials in", async () => {
  await page.getByLabel("Server name").fill("bad name!");
  await page.getByRole("button", { name: "Get the pairing command" }).click();
  await expect(
    page.getByText("Use letters, digits, dots, dashes or underscores, starting with a letter or digit."),
  ).toBeVisible();

  await page.getByLabel("Server name").fill("harbour-01");
  await page.getByRole("button", { name: "Get the pairing command" }).click();

  const command = page.locator("code").filter({ hasText: "install.sh" }).first();
  await expect(command).toBeVisible();
  const text = (await command.textContent()) ?? "";
  expect(text).toContain(`--control-plane=${webUrl}`);
  const token = /--token=(\S+)/.exec(text)?.[1];
  expect(token).toBeTruthy();

  await page.getByRole("button", { name: "Copy the pairing command" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text.trim());

  /* Run what the operator would have run on the new host. */
  await pairSimulatedAgent("harbour-01", token!);

  /* The waiting state resolves on its own; nobody reloads. */
  await expect(page.getByText("harbour-01").first()).toBeVisible();
  const go = page.getByRole("button", { name: "Continue" });
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect
    .poll(async () => (await state(ownerCookie)).step, { timeout: 60_000 })
    .toBe("server");
  await go.click();
  await expect(page.getByRole("heading", { name: "Give the panel an address" })).toBeVisible();

  /* The pairing token was single-use. */
  const reuse = await fetch(`${apiUrl}/agent/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, csr: "x" }),
  });
  expect(reuse.status).toBeGreaterThanOrEqual(400);
});

/* ---------------------------- optional steps ---------------------------- */

const OPTIONAL: { step: string; heading: string }[] = [
  { step: "address", heading: "Give the panel an address" },
  { step: "website", heading: "Put your first website on it" },
  { step: "email", heading: "Give it email" },
  { step: "backups", heading: "Back it up every night" },
  { step: "notifications", heading: "Hear about it when something breaks" },
  { step: "team", heading: "Invite a teammate" },
];

/** The quiet "later" when a step offers one, otherwise Continue with nothing entered. */
async function skipCurrent(): Promise<void> {
  const later = page.getByRole("button", {
    name: /^(Set up later|Add a website later|Set up email later|Set up backups later|Use the defaults|Not now)$/,
  });
  if (await later.isVisible()) {
    await later.click();
    return;
  }
  await page.getByRole("button", { name: /^(Continue|Continue without email)$/ }).click();
}

test("each optional step can be skipped, is recorded as skipped, and a reload resumes", async () => {
  for (const [index, { step, heading }] of OPTIONAL.entries()) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();

    /* A reload mid-way lands on the same unanswered step. */
    if (index === 2) {
      await page.reload();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }

    /* Wait for the step's footer to settle before choosing. */
    await expect(
      page.getByRole("button", {
        name: /^(Continue|Continue without email|Save and continue|Add domain|Create website|Deploy mail server|Schedule backups|Send invitation)$/,
      }),
    ).toBeEnabled({ timeout: 30_000 });
    await skipCurrent();

    await expect
      .poll(async () => (await state(ownerCookie)).outcomes[step], {
        message: `${step} was never answered`,
      })
      .toBe("skipped");
  }
  const after = await state(ownerCookie);
  expect(after.step).toBe("done");
  expect(after.completed_at).toBeNull();
});

test("the last screen reads back the instance and opens the Command Center", async () => {
  await expect(page.getByRole("heading", { name: "Harbour is ready" })).toBeVisible();
  await page.getByRole("button", { name: "Open the Command Center" }).click();
  await expect(page).toHaveURL(`${webUrl}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Command Center" })).toBeVisible();

  const done = await state(ownerCookie);
  expect(done.needs_onboarding).toBe(false);
  expect(done.completed_at).not.toBeNull();
});

test("after completion /setup refuses and redirects, even for the owner", async () => {
  await page.goto("/setup");
  await expect(page).toHaveURL(`${webUrl}/`);

  for (const [path, body] of [
    ["/setup/instance", { instance_name: "Hijacked" }],
    ["/setup/complete", {}],
    ["/setup/steps/team", { outcome: "skipped" }],
  ] as const) {
    const res = await call<ErrorBody>("POST", path, { cookie: ownerCookie, body });
    expect(res.status, path).toBe(409);
  }
  expect((await state(ownerCookie)).instance_name).toBe("Harbour");
});

/* ---------------------- what the finished install is ---------------------- */

test("the only owner cannot be suspended, demoted or deleted", async () => {
  const me = (await call<{ data: { user: { id: string } } }>("GET", "/auth/session", {
    cookie: ownerCookie,
  })).body.data.user;
  const roles = (await call<{ data: { id: string; slug: string }[] }>("GET", "/roles", {
    cookie: ownerCookie,
  })).body.data;
  const viewer = roles.find((role) => role.slug === "viewer")!;

  const suspend = await call<ErrorBody>("POST", `/users/${me.id}/suspend`, { cookie: ownerCookie });
  expect(suspend.status).toBe(409);
  const demote = await call<ErrorBody>("POST", `/users/${me.id}/roles`, {
    cookie: ownerCookie,
    body: { role_ids: [viewer.id] },
  });
  expect(demote.status).toBe(409);
  expect(demote.body.error.message).toMatch(/owner/i);
});

test("an install.sh instance takes a domain: .env and the host queue are written", async () => {
  await page.goto("/administration/settings");
  const address = page.locator("section#address");
  const domain = address.getByPlaceholder("panel.example.com");
  await expect(domain).toBeVisible();

  await domain.fill("not a host");
  await domain.blur();
  await expect(address.getByRole("button", { name: "Save" })).toBeDisabled();

  await domain.fill("panel.harbour.example.com");
  await address.getByRole("button", { name: "Save" }).click();
  const confirm = page.getByRole("dialog", { name: "Serve this panel at panel.harbour.example.com" });
  await confirm.getByRole("textbox").fill("panel.harbour.example.com");
  await confirm.getByRole("button", { name: "Apply" }).click();
  await expect(address.getByRole("status")).toContainText("Applying https://panel.harbour.example.com");

  const env = readFileSync(wizardEnvFile, "utf8");
  expect(env).toContain("KANAME_DOMAIN=panel.harbour.example.com");
  expect(env).toContain("KANAME_PUBLIC_URL=https://panel.harbour.example.com");
  expect(existsSync(hostQueueFile)).toBe(true);
  expect(JSON.parse(readFileSync(hostQueueFile, "utf8")).kind).toBe("reconfigure");

  /* The IP the operator is on keeps working throughout. */
  expect((await call("GET", "/auth/session", { cookie: ownerCookie })).status).toBe(200);
});

/* ------------------------------ Getting Started ------------------------------ */

test("the Getting Started checklist reflects real progress", async () => {
  const before = await checklist();
  expect(before["two_factor_enabled"]).toBe(false);
  expect(before["teammate_invited"]).toBe(false);

  await page.goto("/");
  const card = page.locator("section, aside").filter({ hasText: "Getting started" }).first();
  await expect(card).toBeVisible();

  /* Invite somebody: the teammate item turns done. */
  const viewer = (await call<{ data: { id: string; slug: string }[] }>("GET", "/roles", {
    cookie: ownerCookie,
  })).body.data.find((role) => role.slug === "viewer")!;
  const invited = await call("POST", "/users", {
    cookie: ownerCookie,
    body: { email: "crew@fresh.example.com", name: "Crew", role_ids: [viewer.id], send_invite: false },
  });
  expect(invited.status).toBe(201);
  await expect.poll(async () => (await checklist())["teammate_invited"]).toBe(true);

  /* A notification channel: that item turns done. */
  const patch = await call("PATCH", "/settings", {
    cookie: ownerCookie,
    body: {
      notifications: {
        channels: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Ops hook",
            kind: "webhook",
            target: "https://hooks.example.com/kaname",
            events: ["job_failed"],
            enabled: true,
          },
        ],
      },
    },
  });
  expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  await expect.poll(async () => (await checklist())["notification_channel_added"]).toBe(true);

  await page.reload();
  await expect(card).toBeVisible();
});

async function checklist(): Promise<Record<string, boolean>> {
  const res = await call<{ data: { onboarding: { id: string; done: boolean }[] } }>(
    "GET",
    "/dashboard",
    { cookie: ownerCookie },
  );
  expect(res.status).toBe(200);
  const steps = res.body.data.onboarding;
  return Object.fromEntries(steps.map((step) => [step.id, step.done]));
}
