import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import { serverNamed } from "../support/api.js";
import { agentStateRoot } from "../support/config.js";
import { call, codeBlock, data, jobSucceeds, qs, settle, unique } from "../support/data.js";

/* ------------------------------------------------------------------ *
 * Files — FTP / SFTP transfer accounts.
 *
 * A transfer account is a real POSIX user on the host. Every job here is
 * one `ftp.account.*` call, and every assertion about it is checked on
 * the host itself through the file API: the user in /etc/passwd, a hash
 * (never the password) in /etc/shadow, the SFTP group and sshd chroot
 * drop-in, the vsftpd allowlist and per-user root, and the quota the
 * agent reports having set. The simulated fleet is shaped so each refusal
 * is reachable: forge-01 runs sshd and vsftpd with user quotas on /srv
 * only, db-01 runs sshd alone, and edge-01 runs no transfer daemon.
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

interface SettledJob {
  status: string;
  error: { code: string; message: string } | null;
  result: {
    uid?: number;
    quota?: string;
    quota_mount?: string | null;
    quota_bytes?: number;
    suspended?: boolean;
  } | null;
}

test.beforeAll(async () => {
  serverId = (await serverNamed(HOST)).id;
});

async function openFtp(page: Page): Promise<Locator> {
  await page.goto(`/files/ftp?${qs({ server_id: serverId })}`);
  await expect(page.getByRole("heading", { level: 1, name: "FTP / SFTP" })).toBeVisible();
  return page.getByRole("table", { name: "Transfer accounts" });
}

async function accountNamed(username: string, server = serverId): Promise<Account | undefined> {
  const rows = await data<Account[]>(
    "GET",
    `/ftp-accounts?${qs({ server_id: server, q: username, per_page: 50 })}`,
  );
  return rows.find((row) => row.username === username);
}

/** A file on the host as text, or null when it is not there. */
async function hostFile(path: string, server = serverId): Promise<string | null> {
  const res = await call<{ content: string }>(
    "GET",
    `/files/read?${qs({ server_id: server, path })}`,
  );
  return res.status === 200 ? (res.body.data?.content ?? null) : null;
}

async function entryOf(dir: string, name: string) {
  const listing = await data<{ entries: { name: string; owner: string; kind: string; mode: string }[] }>(
    "GET",
    `/files?${qs({ server_id: serverId, path: dir, show_hidden: true })}`,
  );
  return listing.entries.find((entry) => entry.name === name);
}

/** The shadow record's hash field, which is all that may stand for a password. */
function hashOf(shadow: string | null, username: string): string | undefined {
  return shadow
    ?.split("\n")
    .find((line) => line.startsWith(`${username}:`))
    ?.split(":")[1];
}

/** The FTP jobs that acted on one account, newest first. */
async function jobsFor(username: string, type?: string): Promise<{ id: string; type: string }[]> {
  const rows = await data<{ id: string; type: string; target_label: string | null }[]>(
    "GET",
    `/jobs?${qs({ server_id: serverId, q: "ftp.", type, per_page: 100 })}`,
  );
  return rows.filter((job) => job.target_label === username);
}

async function settled(jobId: string): Promise<SettledJob> {
  return (await settle(jobId)) as unknown as SettledJob;
}

async function createViaUi(page: Page, username: string, home?: string): Promise<string> {
  await page.getByRole("button", { name: "New account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New transfer account" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Username").fill(username);
  if (home) await dialog.getByLabel("Home directory").fill(home);
  const password = await dialog.getByRole("textbox", { name: /^Password/ }).inputValue();
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
  return password;
}

test("creates a real SFTP user: account record, hashed credential and a chroot sshd accepts", async ({
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
  const passwordField = dialog.getByRole("textbox", { name: /^Password/ });
  const first = await passwordField.inputValue();
  expect(first.length).toBeGreaterThanOrEqual(16);
  await expect(dialog.getByText("Kaname shows this once.")).toBeVisible();
  await dialog.getByRole("button", { name: "Generate a new password" }).click();
  await expect(passwordField).not.toHaveValue(first);
  const password = await passwordField.inputValue();

  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
  await jobSucceeds(page, "Create FTP account", username);

  const row = table.locator("tbody tr").filter({ hasText: username });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`/home/${username}`);
  await expect(row).toContainText(/active/i);
  const account = await accountNamed(username);
  expect(account?.status).toBe("active");

  /* The POSIX user, marked as Kaname's, with a shell that refuses logins. */
  const passwd = await hostFile("/etc/passwd");
  expect(passwd).toMatch(
    new RegExp(`^${username}:x:\\d+:\\d+:Kaname transfer account:/home/${username}:/usr/sbin/nologin$`, "m"),
  );
  /* In the group sshd's Match block confines, with the chroot drop-in in place. */
  expect(await hostFile("/etc/group")).toMatch(new RegExp(`^kaname-sftp:x:\\d+:.*\\b${username}\\b`, "m"));
  const dropIn = await hostFile("/etc/ssh/sshd_config.d/kaname-sftp.conf");
  expect(dropIn).toContain("Match Group kaname-sftp");
  expect(dropIn).toContain("ChrootDirectory %h");
  expect(dropIn).toContain("ForceCommand internal-sftp");

  /* A hash on the host, never the password, anywhere. */
  const shadow = await hostFile("/etc/shadow");
  expect(hashOf(shadow, username)).toMatch(/^\$6\$/);
  expect(shadow).not.toContain(password);

  /* sshd only chroots into a root-owned home; the account writes one level down. */
  expect(await entryOf("/home", username)).toMatchObject({ kind: "directory", owner: "root" });
  expect(await entryOf(`/home/${username}`, "files")).toMatchObject({
    kind: "directory",
    owner: username,
  });

  /* And the credential is never readable back from the API, the job or its result. */
  const detail = await call("GET", `/ftp-accounts/${account!.id}`);
  expect(JSON.stringify(detail.body)).not.toContain(password);
  const jobs = await jobsFor(username);
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) {
    expect(JSON.stringify(await data("GET", `/jobs/${job.id}`))).not.toContain(password);
  }
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
  await dialog.getByRole("textbox", { name: /^Password/ }).fill("a".repeat(15));
  await expect(dialog.getByText("15 characters")).toBeVisible();
  await expect(create).toBeDisabled();
  await dialog.getByRole("textbox", { name: /^Password/ }).fill("a".repeat(16));
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

  /* chpasswd reads `user:password` lines, so a line break would be a second record. */
  const injected = await call("POST", "/ftp-accounts", {
    server_id: serverId,
    username: unique("inj_"),
    password: "sixteen-chars-ok\nroot:owned-owned-owned",
    home_dir: "/home/x",
  });
  expect(injected.status).toBe(422);
  expect(injected.body.error?.fields?.["password"]).toBe("may not contain a line break or NUL");

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
  const firstJob = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username,
    password: "y".repeat(20),
    home_dir: `/home/${username}`,
  });
  expect((await settle(firstJob.job.id)).status).toBe("succeeded");

  await page.getByRole("button", { name: "New account" }).first().click();
  await dialog.getByLabel("Username").fill(username);
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    `${HOST} already has an account named "${username}".`,
  );
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

test("a transfer username that is already a real user on the host is refused, not taken over", async () => {
  const before = await hostFile("/etc/shadow");
  const res = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username: "deploy",
    password: "t".repeat(24),
    home_dir: "/srv/not-deploys-home",
  });
  const job = await settled(res.job.id);
  expect(job.status).toBe("failed");
  expect(job.error?.code).toBe("conflict");
  expect(job.error?.message).toMatch(/Kaname did not create/);
  /* deploy's password and record are exactly as they were. */
  expect(hashOf(await hostFile("/etc/shadow"), "deploy")).toBe(hashOf(before, "deploy"));
  const row = await accountNamed("deploy");
  expect(row?.status).toBe("error");

  /* Deleting that row forgets it in the panel and leaves the real user be. */
  const del = await data<{ job: { id: string } }>("DELETE", `/ftp-accounts/${row!.id}`);
  expect((await settle(del.job.id)).status).toBe("succeeded");
  expect(await accountNamed("deploy")).toBeUndefined();
  expect(await hostFile("/etc/passwd")).toMatch(/^deploy:x:1000:1000:Deploy,,,:\/home\/deploy:\/bin\/bash$/m);
});

test("resets a password, showing the new one exactly once, then deletes the account", async ({
  page,
}) => {
  const table = await openFtp(page);
  const username = unique("reset_");
  const initial = await createViaUi(page, username);
  await jobSucceeds(page, "Create FTP account", username);
  const hashBefore = hashOf(await hostFile("/etc/shadow"), username);
  expect(hashBefore).toMatch(/^\$6\$/);

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
  await jobSucceeds(page, "Reset FTP password", username);
  const queued = page.getByRole("dialog", { name: "Password reset queued" });
  await expect(queued).toBeVisible();
  /* Still on screen after the job: closing is the only way to lose it. */
  await expect(codeBlock(queued, `New password for ${username}`)).toHaveText(password);
  await expect(queued.locator('span[title^="Succeeded."]')).toBeVisible();
  await queued.getByRole("button", { name: "Done" }).click();
  await expect(queued).toBeHidden();

  /* The reset reached the host: a new hash, and neither password in its files. */
  const shadow = await hostFile("/etc/shadow");
  const hashAfter = hashOf(shadow, username);
  expect(hashAfter).toMatch(/^\$6\$/);
  expect(hashAfter).not.toBe(hashBefore);
  expect(shadow).not.toContain(password);
  expect(shadow).not.toContain(initial);

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
  /* The user, its group membership and its hash are gone from the host... */
  expect(await hostFile("/etc/passwd")).not.toMatch(new RegExp(`^${username}:`, "m"));
  expect(hashOf(await hostFile("/etc/shadow"), username)).toBeUndefined();
  expect(await hostFile("/etc/group")).not.toMatch(new RegExp(`\\b${username}\\b`));
  /* ...and its files are not. */
  expect(await entryOf("/home", username)).toBeDefined();
});

test("editing moves an account to FTPS under vsftpd and sets a real quota on /srv", async ({
  page,
}) => {
  const table = await openFtp(page);
  const username = unique("edit_");
  const home = `/srv/ftp/${username}`;
  await createViaUi(page, username, home);
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

  /* The host agrees: vsftpd lists the user, roots it in its home, and the
   * SFTP group no longer holds it. */
  expect(await hostFile("/etc/vsftpd/kaname.users")).toMatch(new RegExp(`^${username}$`, "m"));
  expect(await hostFile(`/etc/vsftpd/kaname.d/${username}`)).toContain(`local_root=${home}`);
  expect(await hostFile("/etc/vsftpd.conf")).toContain("userlist_deny=NO");
  expect(await hostFile("/etc/group")).not.toMatch(
    new RegExp(`^kaname-sftp:.*\\b${username}\\b`, "m"),
  );
  /* vsftpd's allow_writeable_chroot lets an FTPS account own its home. */
  expect(await entryOf("/srv/ftp", username)).toMatchObject({ owner: username });

  /* The limit the agent reports having set, on the quota-enabled mount. */
  const [update] = await jobsFor(username, "ftp.update");
  const result = (await settled(update!.id)).result;
  expect(result).toMatchObject({ quota: "applied", quota_mount: "/srv", quota_bytes: 2 * 1024 ** 3 });

  /* FTPS sessions are not enumerable, and the panel says why. */
  const sessions = await call("GET", `/ftp-accounts/${account!.id}/sessions`);
  expect(sessions.body.error?.code).toBe("agent_unsupported");
});

test("a quota the filesystem cannot enforce is refused as unsupported and the row keeps the truth", async () => {
  const username = unique("noquota_");
  const created = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username,
    password: "u".repeat(20),
    home_dir: `/home/${username}`,
  });
  expect((await settle(created.job.id)).status).toBe("succeeded");
  const account = (await accountNamed(username))!;

  /* / is not mounted with usrquota on the simulated host. */
  const edit = await data<{ job: { id: string } }>("PATCH", `/ftp-accounts/${account.id}`, {
    quota_bytes: 1024 ** 3,
    protocol: "ftps",
  });
  const job = await settled(edit.job.id);
  expect(job.status).toBe("failed");
  expect(job.error?.code).toBe("unsupported");
  expect(job.error?.message).toMatch(/usrquota/);

  /* The row was rolled back to what the host still has. */
  const after = await accountNamed(username);
  expect(after).toMatchObject({ quota_bytes: 0, protocol: "sftp", status: "active" });
  /* And nothing on the host moved: still SFTP, never listed for vsftpd. */
  expect((await hostFile("/etc/vsftpd/kaname.users")) ?? "").not.toContain(username);

  /* Creating with a limit there is refused the same way, with nothing left behind. */
  const limited = unique("limited_");
  const res = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username: limited,
    password: "v".repeat(20),
    home_dir: `/home/${limited}`,
    quota_bytes: 1024 ** 3,
  });
  const refused = await settled(res.job.id);
  expect(refused.error?.code).toBe("unsupported");
  expect((await accountNamed(limited))?.status).toBe("error");
  expect(await hostFile("/etc/passwd")).not.toMatch(new RegExp(`^${limited}:`, "m"));
});

test("suspending locks the credential and drops the account from vsftpd; resuming restores both", async () => {
  const username = unique("susp_");
  const created = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username,
    password: "w".repeat(20),
    protocol: "ftps",
    home_dir: `/srv/ftp/${username}`,
  });
  expect((await settle(created.job.id)).status).toBe("succeeded");
  const account = (await accountNamed(username))!;
  expect(await hostFile("/etc/vsftpd/kaname.users")).toMatch(new RegExp(`^${username}$`, "m"));

  const suspend = await data<{ job: { id: string } }>("PATCH", `/ftp-accounts/${account.id}`, {
    status: "suspended",
  });
  expect((await settled(suspend.job.id)).result).toMatchObject({ suspended: true });
  expect(hashOf(await hostFile("/etc/shadow"), username)).toMatch(/^!\$6\$/);
  expect(await hostFile("/etc/vsftpd/kaname.users")).not.toMatch(new RegExp(`^${username}$`, "m"));

  const resume = await data<{ job: { id: string } }>("PATCH", `/ftp-accounts/${account.id}`, {
    status: "active",
  });
  expect((await settle(resume.job.id)).status).toBe("succeeded");
  expect(hashOf(await hostFile("/etc/shadow"), username)).toMatch(/^\$6\$/);
  expect(await hostFile("/etc/vsftpd/kaname.users")).toMatch(new RegExp(`^${username}$`, "m"));
});

test("a host without the protocol's daemon refuses at once, before any account exists", async () => {
  /* edge-01 runs neither sshd's SFTP nor vsftpd. */
  const edge = (await serverNamed("edge-01")).id;
  const username = unique("edge_");
  const res = await call("POST", "/ftp-accounts", {
    server_id: edge,
    username,
    password: "e".repeat(20),
    home_dir: `/home/${username}`,
  });
  expect(res.status).toBe(501);
  expect(res.body.error?.code).toBe("agent_unsupported");
  expect(res.body.error?.message).toContain("sshd (SFTP)");
  expect(await accountNamed(username, edge)).toBeUndefined();

  /* db-01 has sshd but no vsftpd: SFTP works there, FTPS does not. */
  const db = (await serverNamed("db-01")).id;
  const ftps = await call("POST", "/ftp-accounts", {
    server_id: db,
    username: unique("dbftps_"),
    password: "f".repeat(20),
    protocol: "ftps",
    home_dir: "/srv/dbftps",
  });
  expect(ftps.status).toBe(501);
  expect(ftps.body.error?.message).toContain("vsftpd (FTPS)");
  const sftpUser = unique("dbsftp_");
  const sftp = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: db,
    username: sftpUser,
    password: "g".repeat(20),
    home_dir: `/srv/${sftpUser}`,
  });
  expect((await settle(sftp.job.id)).status).toBe("succeeded");
  expect(await hostFile("/etc/passwd", db)).toMatch(new RegExp(`^${sftpUser}:`, "m"));
});

test("an account whose home directory the agent refuses does not sit in provisioning forever", async () => {
  const username = unique("refused_");
  const res = await data<{ job: { id: string } }>("POST", "/ftp-accounts", {
    server_id: serverId,
    username,
    password: "q".repeat(20),
    /* The agent's own state directory: its path guard refuses it. */
    home_dir: join(agentStateRoot, HOST, username),
  });
  expect((await settle(res.job.id)).status).toBe("failed");
  const account = await accountNamed(username);
  /* The job failed, so the row has to say so. "provisioning" after the
   * job is over is a state nothing will ever move it out of. */
  expect(account?.status).toBe("error");
  expect(await hostFile("/etc/passwd")).not.toMatch(new RegExp(`^${username}:`, "m"));
});
