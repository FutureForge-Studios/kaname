import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { serverNamed } from "../support/api.js";
import { agentStateRoot } from "../support/config.js";
import { call, codeBlock, data, jobSucceeds, qs, settle, unique } from "../support/data.js";

/* ------------------------------------------------------------------ *
 * Files — FTP / SFTP transfer accounts.
 *
 * README is explicit that FTP is panel-side only: the agent has no FTP
 * verb, so no POSIX user or credential is ever created on the host. What
 * IS real, and what this checks against the host, is the home directory:
 * account creation is a job that makes it and hands it to the username.
 * Everything else asserted here is what the panel promises about its own
 * state — the password shown once, the row lifecycle, the refusals.
 * ------------------------------------------------------------------ */

const HOST = "forge-01";
let serverId = "";

interface Account {
  id: string;
  username: string;
  home_dir: string;
  status: string;
  protocol: string;
  quota_bytes: number;
}

test.beforeAll(async () => {
  serverId = (await serverNamed(HOST)).id;
});

async function openFtp(page: Page): Promise<Locator> {
  await page.goto(`/files/ftp?${qs({ server_id: serverId })}`);
  await expect(page.getByRole("heading", { level: 1, name: "FTP / SFTP" })).toBeVisible();
  return page.getByRole("table", { name: "Transfer accounts" });
}

async function accountNamed(username: string): Promise<Account | undefined> {
  const rows = await data<Account[]>("GET", `/ftp-accounts?${qs({ server_id: serverId, q: username, per_page: 50 })}`);
  return rows.find((row) => row.username === username);
}

async function createViaUi(page: Page, username: string, home?: string): Promise<string> {
  await page.getByRole("button", { name: "New account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New transfer account" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Username").fill(username);
  if (home) await dialog.getByLabel("Home directory").fill(home);
  const password = await dialog.getByLabel(/^Password( \(required\))?$/).inputValue();
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
  return password;
}

test("creates an account whose home directory really appears on the host, owned by it", async ({
  page,
}) => {
  const table = await openFtp(page);
  const username = unique("sftp_");

  await page.getByRole("button", { name: "New account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New transfer account" });

  /* The home directory follows the username until it is edited. */
  await dialog.getByLabel("Username").fill(username);
  await expect(dialog.getByLabel("Home directory")).toHaveValue(`/home/${username}`);

  /* A generated credential, shown in full while it can still be copied. */
  const passwordField = dialog.getByLabel(/^Password( \(required\))?$/);
  const password = await passwordField.inputValue();
  expect(password.length).toBeGreaterThanOrEqual(16);
  await expect(dialog.getByText("Kaname shows this once.")).toBeVisible();
  await dialog.getByRole("button", { name: "Generate a new password" }).click();
  await expect(passwordField).not.toHaveValue(password);

  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
  await jobSucceeds(page, "Create FTP account", username);

  const row = table.locator("tbody tr").filter({ hasText: username });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`/home/${username}`);
  await expect(row).toContainText(/active/i);

  const account = await accountNamed(username);
  expect(account?.status).toBe("active");

  /* The part that is real: the directory exists on forge-01 and is the account's. */
  const home = await data<{ entries: { name: string; owner: string; kind: string }[] }>(
    "GET",
    `/files?${qs({ server_id: serverId, path: "/home" })}`,
  );
  const dir = home.entries.find((entry) => entry.name === username);
  expect(dir?.kind).toBe("directory");
  expect(dir?.owner).toBe(username);

  /* And the credential is never readable back from the API. */
  const detail = await call("GET", `/ftp-accounts/${account!.id}`);
  expect(JSON.stringify(detail.body)).not.toContain(password);
});

test("validates the username, the password floor, duplicates and SSH keys by field", async ({
  page,
}) => {
  await openFtp(page);
  await page.getByRole("button", { name: "New account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New transfer account" });
  const create = dialog.getByRole("button", { name: "Create account" });

  await dialog.getByLabel("Username").fill("9lives");
  await expect(
    dialog.getByText(
      "A POSIX user name starts with a letter or underscore and holds letters, digits, dashes and underscores.",
    ),
  ).toBeVisible();
  await expect(create).toBeDisabled();

  await dialog.getByLabel("Username").fill(unique("ok_"));
  await dialog.getByLabel("Home directory").fill("relative/home");
  await expect(dialog.getByText("Give an absolute path.")).toBeVisible();
  await expect(create).toBeDisabled();
  await dialog.getByLabel("Home directory").fill("/home/somewhere");

  /* Fifteen characters is one short of the contract's floor. */
  await dialog.getByLabel(/^Password( \(required\))?$/).fill("a".repeat(15));
  await expect(dialog.getByText("15 characters")).toBeVisible();
  await expect(create).toBeDisabled();
  await dialog.getByLabel(/^Password( \(required\))?$/).fill("a".repeat(16));
  await expect(create).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* The API holds the same lines, by field. */
  const short = await call("POST", "/ftp-accounts", {
    server_id: serverId,
    username: unique("short_"),
    password: "x".repeat(15),
    home_dir: "/home/x",
  });
  expect(short.status).toBe(422);
  expect(short.body.error?.fields?.["password"]).toMatch(/at least 16/);

  const badName = await call("POST", "/ftp-accounts", {
    server_id: serverId,
    username: "has space",
    password: "x".repeat(20),
    home_dir: "/home/x",
  });
  expect(badName.status).toBe(422);
  expect(badName.body.error?.fields?.["username"]).toBe("must start with a letter or underscore");

  const traversal = await call("POST", "/ftp-accounts", {
    server_id: serverId,
    username: unique("trav_"),
    password: "x".repeat(20),
    home_dir: "/home/../etc",
  });
  expect(traversal.status).toBe(422);
  expect(traversal.body.error?.fields?.["home_dir"]).toBe("path traversal is not allowed");

  /* A second account with the same name on the same host is a conflict. */
  const username = unique("dup_");
  const first = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username,
    password: "y".repeat(20),
    home_dir: `/home/${username}`,
  });
  expect((await settle(first.job.id)).status).toBe("succeeded");

  await page.getByRole("button", { name: "New account" }).first().click();
  await dialog.getByLabel("Username").fill(username);
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog.getByRole("alert")).toContainText(`${HOST} already has an account named "${username}".`);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* An SSH key that is not one is refused before anything is created. */
  const keyed = unique("key_");
  const badKey = await call("POST", "/ftp-accounts", {
    server_id: serverId,
    username: keyed,
    password: "z".repeat(20),
    home_dir: `/home/${keyed}`,
    ssh_public_key: "not-a-key at all",
  });
  expect(badKey.status).toBeGreaterThanOrEqual(400);
  expect(badKey.status).toBeLessThan(500);
  expect(await accountNamed(keyed)).toBeUndefined();
});

test("resets a password, showing the new one exactly once, then deletes the account", async ({
  page,
}) => {
  const table = await openFtp(page);
  const username = unique("reset_");
  await createViaUi(page, username);
  await jobSucceeds(page, "Create FTP account", username);

  const row = table.locator("tbody tr").filter({ hasText: username });
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Reset password" }).click();

  const reset = page.getByRole("dialog", { name: "Reset password" });
  await expect(reset).toBeVisible();
  const shown = codeBlock(reset, `New password for ${username}`);
  const first = (await shown.textContent())?.trim() ?? "";
  expect(first.length).toBeGreaterThanOrEqual(16);
  await reset.getByRole("button", { name: "Generate a different one" }).click();
  const password = (await shown.textContent())?.trim() ?? "";
  expect(password).not.toBe(first);
  await expect(reset.getByText("This is the only time this password is shown.")).toBeVisible();

  await reset.getByRole("button", { name: "Reset password" }).click();
  const queued = page.getByRole("dialog", { name: "Password reset queued" });
  await expect(queued).toBeVisible();
  /* Still on screen while the job runs: closing is the only way to lose it. */
  await expect(codeBlock(queued, `New password for ${username}`)).toHaveText(password);
  await page.keyboard.press("Escape");

  /* Reopening never shows the old one again — it mints a new candidate. */
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Reset password" }).click();
  await expect(codeBlock(reset, `New password for ${username}`)).not.toHaveText(password);
  await reset.getByRole("button", { name: "Cancel" }).click();

  /* Delete needs the username typed, and the home directory is left in place. */
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: `Delete ${username}?` });
  await expect(confirm).toContainText(`${username} — /home/${username}`);
  const deleteButton = confirm.getByRole("button", { name: "Delete" });
  await expect(deleteButton).toBeDisabled();
  await confirm.getByLabel(/Type .* to confirm/).fill(username);
  await deleteButton.click();
  await jobSucceeds(page, "Delete FTP account", username);

  await expect(table.locator("tbody tr").filter({ hasText: username })).toHaveCount(0);
  expect(await accountNamed(username)).toBeUndefined();
  const home = await data<{ entries: { name: string }[] }>("GET", `/files?${qs({ server_id: serverId, path: "/home" })}`);
  expect(home.entries.map((entry) => entry.name)).toContain(username);
});

test("editing an account changes its quota and protocol in the list", async ({ page }) => {
  const table = await openFtp(page);
  const username = unique("edit_");
  await createViaUi(page, username);
  await jobSucceeds(page, "Create FTP account", username);

  const row = table.locator("tbody tr").filter({ hasText: username });
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: `Edit ${username}` });
  await dialog.getByLabel("Protocol").selectOption("ftps");
  await dialog.getByLabel("Quota").fill("2");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await jobSucceeds(page, "Update FTP account", username);

  await expect(row).toContainText(/FTPS/i);
  const account = await accountNamed(username);
  expect(account?.protocol).toBe("ftps");
  expect(account?.quota_bytes).toBe(2 * 1024 ** 3);

  /* FTPS sessions are not enumerable, and the panel says why. */
  const sessions = await call("GET", `/ftp-accounts/${account!.id}/sessions`);
  expect(sessions.body.error?.code).toBe("agent_unsupported");
});

test("an account whose home directory the agent refuses does not sit in provisioning forever", async () => {
  const username = unique("refused_");
  const res = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username,
    password: "q".repeat(20),
    /* The agent's own state directory: its path guard refuses the mkdir. */
    home_dir: join(agentStateRoot, HOST, username),
  });
  expect((await settle(res.job.id)).status).toBe("failed");
  const account = await accountNamed(username);
  /* The job failed, so the row has to say so. "provisioning" after the
   * job is over is a state nothing will ever move it out of. */
  expect(account?.status).toBe("error");
});
