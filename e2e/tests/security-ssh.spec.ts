import { generateKeyPairSync, createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { missingId } from "../support/config.js";
import { auditRows, hostFile, owner, server, settled, type JobRow } from "../support/secops.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * SSH — authorized keys, sshd configuration, live sessions.
 *
 * Keys are the one thing here that Kaname writes into a file a human
 * logs in with, so a key test is only finished when the host's
 * authorized_keys says so. sshd changes ride the same rollback window as
 * the firewall; both halves — kept by a confirm, undone by a lapse — are
 * checked against /etc/ssh/sshd_config on the simulated host.
 * ------------------------------------------------------------------ */

const AUTHORIZED = "/root/.ssh/authorized_keys";
const SSHD = "/etc/ssh/sshd_config";
const WINDOW_S = 30;

interface ConfigRead {
  allow_users: string[];
  pending_rollback: { expires_at: string; seconds: number; job_id: string | null; changes: string[] } | null;
}

function rollbackBanner(page: Page, serverName: string) {
  return page.getByRole("status").filter({ hasText: `${serverName} reverts its sshd configuration in` });
}

/** A real OpenSSH ed25519 public key line, and its SHA256 fingerprint. */
function freshKey(comment: string): { line: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const field = (buf: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    return Buffer.concat([len, buf]);
  };
  const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(raw)]);
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  return { line: `ssh-ed25519 ${blob.toString("base64")} ${comment}`, fingerprint };
}

async function drawerJob(page: Page, text: string): Promise<string> {
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  await expect(drawer).toBeVisible();
  const job = drawer.getByRole("listitem").filter({ hasText: text }).first();
  const pill = jobStatusPill(job);
  await expect(pill).toHaveText(/Succeeded|Failed|Cancelled|Timed out/, { timeout: 60_000 });
  const status = (await pill.innerText()).trim();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  return status;
}

async function openConfig(page: Page, serverName: string): Promise<void> {
  const target = await server(serverName);
  await page.goto(`/security/ssh?panel=config&server_id=${target.id}`);
  await expect(page.getByRole("heading", { name: "Applied state" })).toBeVisible();
}

function appliedRow(page: Page, label: string) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Applied state" }) }).getByText(label, { exact: true }).locator("xpath=..");
}

test.describe("ssh", () => {
  test("a key is validated, installed on the host, and removed from it", async ({ page }) => {
    const forge = await server("forge-01");
    const key = freshKey("e2e@laptop");

    await page.goto("/security/ssh");
    const table = page.getByRole("table", { name: "Authorized keys" });
    await expect(table.locator("tbody tr").filter({ hasText: "detective@workstation" })).toBeVisible();

    await page.getByRole("button", { name: "Add key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add an authorized key" });
    const add = dialog.getByRole("button", { name: "Add key" });
    const message = 'must be an OpenSSH public key, e.g. "ssh-ed25519 AAAAC3Nza... you@laptop"';

    await dialog.getByLabel("Name").fill("e2e laptop");
    for (const bad of [
      "ssh-ed25519",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP1/U4EddRIpUt9KnC7s5Of2EbdSPO9EAMMeP4C2USZpRV1AIlH7WT2NWPq/xfW6MPbLm1Vs14E7 x",
      `ssh-ed25519 ${"!".repeat(80)}`,
      "not a key at all, but long enough to pass the length check of eighty characters total",
    ]) {
      await dialog.getByLabel("Public key").fill(bad);
      await expect(dialog.getByText(message)).toBeVisible();
      await expect(add).toBeDisabled();
    }

    await dialog.getByLabel("Public key").fill(key.line);
    await expect(dialog.getByText(message)).toBeHidden();
    await dialog.getByRole("combobox").click();
    await page.getByRole("listbox").getByRole("option", { name: /forge-01/ }).click();
    await page.keyboard.press("Escape");
    await add.click();

    expect(await drawerJob(page, "forge-01")).toContain("Succeeded");
    const row = table.locator("tbody tr").filter({ hasText: "e2e laptop" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("forge-01");
    await expect(row).toContainText("ssh-ed25519");

    /* On the host, and with the fingerprint ssh-keygen would print. */
    await expect.poll(() => hostFile(forge.id, AUTHORIZED)).toContain(key.line.split(" ")[1]!);
    const api = await owner();
    const listed = await api.get<{ name: string; fingerprint: string }[]>(
      `/ssh/keys?q=${encodeURIComponent("e2e laptop")}`,
    );
    expect(listed[0]?.fingerprint).toBe(key.fingerprint);

    /* The same key twice is one key. */
    const twice = await api.call("POST", "/ssh/keys", { name: "dup", public_key: key.line });
    expect(twice.status).toBe(409);
    expect(twice.error?.message).toBe('That key is already registered as "e2e laptop".');

    /* Remove: the confirm wants the key's name typed. */
    await row.getByRole("button", { name: "Row actions" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Remove key" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove e2e laptop?" });
    await expect(confirm).toContainText(key.fingerprint);
    const remove = confirm.getByRole("button", { name: "Remove" });
    await expect(remove).toBeDisabled();
    await confirm.getByRole("textbox").fill("e2e laptop");
    await remove.click();

    expect(await drawerJob(page, "forge-01")).toContain("Succeeded");
    await expect(row).toHaveCount(0);
    await expect.poll(() => hostFile(forge.id, AUTHORIZED)).not.toContain(key.line.split(" ")[1]!);
    /* The keys that were already there stay. */
    expect(await hostFile(forge.id, AUTHORIZED)).toContain("detective@workstation");

    const actions = (await auditRows("ssh_key.", 5)).map((r) => `${r.action} ${r.target_label}`);
    expect(actions[0]).toBe(`ssh_key.deleted e2e laptop (${key.fingerprint})`);
    expect(actions[1]).toBe(`ssh_key.created e2e laptop (${key.fingerprint})`);
  });

  test("the API holds the key contract for callers that skip the form", async () => {
    const api = await owner();
    const short = await api.call("POST", "/ssh/keys", { name: "x", public_key: "ssh-ed25519 AAAA" });
    expect(short.status).toBe(422);
    expect(short.error?.fields?.["public_key"]).toBeTruthy();

    const noName = await api.call("POST", "/ssh/keys", { name: "", public_key: freshKey("a").line });
    expect(noName.status).toBe(422);
    expect(Object.keys(noName.error?.fields ?? {})).toContain("name");

    const nowhere = await api.call("POST", "/ssh/keys", {
      name: "ghost-host",
      public_key: freshKey("b").line,
      server_ids: [missingId],
    });
    expect(nowhere.status).toBe(404);
    /* Refused before the row existed: nothing to clean up. */
    const left = await api.get<unknown[]>("/ssh/keys?q=ghost-host");
    expect(left).toHaveLength(0);

    const gone = await api.call("DELETE", `/ssh/keys/${missingId}`);
    expect(gone.status).toBe(404);
    expect(gone.error?.message).toBe(`SSH key ${missingId} not found.`);
  });

  test("an sshd change is kept on the host when it is confirmed inside the window", async ({ page }) => {
    const forge = await server("forge-01");
    await openConfig(page, "forge-01");
    await expect(appliedRow(page, "Port")).toContainText("22");

    await page.getByLabel("MaxAuthTries").fill("6");
    await expect(page.getByText("1 unapplied change.")).toBeVisible();
    await page.getByRole("button", { name: "Review and apply" }).click();

    const dialog = page.getByRole("dialog", { name: "Apply sshd configuration to forge-01" });
    await expect(dialog).toContainText("MaxAuthTries");
    await dialog.getByLabel("Rollback window").selectOption(String(WINDOW_S));
    await dialog.getByRole("button", { name: "Apply" }).click();

    expect(await drawerJob(page, "forge-01")).toContain("Succeeded");
    const appliedAt = Date.now();
    await expect.poll(() => hostFile(forge.id, SSHD)).toContain("MaxAuthTries 6");

    /* The window is in the config read, with what would revert... */
    const api = await owner();
    const during = await api.get<ConfigRead>(`/ssh/config?server_id=${forge.id}`);
    expect(during.pending_rollback, "no pending window in the config read").not.toBeNull();
    expect(during.pending_rollback!.seconds).toBe(WINDOW_S);
    expect(Date.parse(during.pending_rollback!.expires_at)).toBeGreaterThan(Date.now());
    expect(during.pending_rollback!.changes).toContain("MaxAuthTries 6");

    /* ...so reloading inside it keeps the banner and a Confirm that works. */
    await page.reload();
    const banner = rollbackBanner(page, "forge-01");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("list", { name: "Waiting to be confirmed" })).toContainText("MaxAuthTries 6");
    await banner.getByRole("button", { name: "Confirm — keep these changes" }).click();
    await expect(banner).toBeHidden();
    expect((await api.get<ConfigRead>(`/ssh/config?server_id=${forge.id}`)).pending_rollback).toBeNull();

    /* Past the window, sshd still has it. */
    await expect
      .poll(
        async () => {
          const content = await hostFile(forge.id, SSHD);
          if (!content.includes("MaxAuthTries 6")) return "reverted";
          return Date.now() > appliedAt + (WINDOW_S + 5) * 1000 ? "held" : "waiting";
        },
        { timeout: (WINDOW_S + 30) * 1000, intervals: [2000] },
      )
      .toBe("held");

    await page.reload();
    await expect(page.getByLabel("MaxAuthTries")).toHaveValue("6");
    const audit = (await auditRows("ssh.config", 5)).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(["ssh.config_confirmed", "ssh.config_apply_requested"]));
  });

  test("an unconfirmed sshd change reverts on the host and the panel says so", async ({ page }) => {
    const edge = await server("edge-01");
    await openConfig(page, "edge-01");
    const before = await page.getByLabel("MaxAuthTries").inputValue();

    await page.getByLabel("MaxAuthTries").fill("9");
    await page.getByRole("button", { name: "Review and apply" }).click();
    const dialog = page.getByRole("dialog", { name: "Apply sshd configuration to edge-01" });
    await dialog.getByLabel("Rollback window").selectOption(String(WINDOW_S));
    await dialog.getByRole("button", { name: "Apply" }).click();
    expect(await drawerJob(page, "edge-01")).toContain("Succeeded");
    await expect.poll(() => hostFile(edge.id, SSHD)).toContain("MaxAuthTries 9");

    await expect(
      page.getByRole("status").filter({ hasText: "The rollback window on edge-01 has closed." }),
    ).toBeVisible({ timeout: (WINDOW_S + 15) * 1000 });
    await expect.poll(() => hostFile(edge.id, SSHD), { timeout: 20_000 }).toContain(`MaxAuthTries ${before}`);

    /* A fresh look at the page reads the reverted host, not the stale cache,
     * and offers no window that has already closed. */
    await page.reload();
    await expect(page.getByLabel("MaxAuthTries")).toHaveValue(before);
    await expect(rollbackBanner(page, "edge-01")).toHaveCount(0);

    const api = await owner();
    expect((await api.get<ConfigRead>(`/ssh/config?server_id=${edge.id}`)).pending_rollback).toBeNull();
    const late = await api.call("POST", "/ssh/config/confirm", { server_id: edge.id });
    expect(late.status).toBe(409);
  });

  test("a key goes to the POSIX account it names, and only to that one", async ({ page }) => {
    const forge = await server("forge-01");
    const key = freshKey("e2e@alice");
    const blob = key.line.split(" ")[1]!;
    const ALICE = "/home/alice/.ssh/authorized_keys";
    const rootBefore = await hostFile(forge.id, AUTHORIZED);

    await page.goto("/security/ssh");
    const table = page.getByRole("table", { name: "Authorized keys" });
    await expect(table.locator("tbody tr").filter({ hasText: "detective@workstation" })).toBeVisible();
    /* Every key says whose file it is in. */
    await expect(table.locator("tbody tr").filter({ hasText: "ci-deploy" })).toContainText("deploy");

    await page.getByRole("button", { name: "Add key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add an authorized key" });
    const add = dialog.getByRole("button", { name: "Add key" });
    await dialog.getByLabel("Name").fill("e2e alice laptop");
    await dialog.getByLabel("Public key").fill(key.line);
    const account = dialog.getByLabel("Account on the host");
    await expect(account).toHaveValue("root");

    /* The account name is validated before anything is sent. */
    for (const bad of ["-alice", "al ice", "../root"]) {
      await account.fill(bad);
      await expect(dialog.getByText("must start with a letter or underscore")).toBeVisible();
      await expect(add).toBeDisabled();
    }
    await account.fill("");
    await expect(dialog.getByText("an account name is required")).toBeVisible();
    await expect(add).toBeDisabled();
    await account.fill("alice");
    await expect(add).toBeEnabled();

    await dialog.getByRole("combobox").click();
    await page.getByRole("listbox").getByRole("option", { name: /forge-01/ }).click();
    await page.keyboard.press("Escape");
    await add.click();
    expect(await drawerJob(page, "alice@forge-01")).toContain("Succeeded");

    const row = table.locator("tbody tr").filter({ hasText: "e2e alice laptop" });
    await expect(row).toContainText("alice");

    /* In alice's own file, owned by alice, and nowhere near root's. */
    await expect.poll(() => hostFile(forge.id, ALICE)).toContain(blob);
    expect(await hostFile(forge.id, AUTHORIZED)).toBe(rootBefore);
    const api = await owner();
    const stat = await api.get<{ owner: string; mode: string }>(
      `/files/stat?server_id=${forge.id}&path=${encodeURIComponent(ALICE)}`,
    );
    expect(stat.owner).toBe("alice");
    expect(stat.mode).toBe("0600");

    /* Removing alice's only key empties her file: she is not on any other
     * key, so the rewrite has to name her explicitly. */
    const [created] = await api.get<{ id: string }[]>(`/ssh/keys?q=${encodeURIComponent("e2e alice laptop")}`);
    const removed = await api.call<{ jobs: JobRow[] }>("DELETE", `/ssh/keys/${created!.id}`);
    expect(removed.status).toBe(202);
    for (const job of removed.data.jobs) expect((await settled(job.id)).status).toBe("succeeded");
    await expect.poll(() => hostFile(forge.id, ALICE)).not.toContain(blob);
  });

  test("a key for an account the host does not have fails its job by name", async () => {
    const api = await owner();
    const forge = await server("forge-01");
    const key = freshKey("e2e@ghost");

    const created = await api.call<{ jobs: JobRow[]; ssh_key: { id: string; posix_user: string } }>(
      "POST",
      "/ssh/keys",
      { name: "e2e ghost account", public_key: key.line, posix_user: "mallory", server_ids: [forge.id] },
    );
    expect(created.status, JSON.stringify(created.error)).toBe(202);
    expect(created.data.ssh_key.posix_user).toBe("mallory");
    // One job per account on the server; mallory's is the one that must fail.
    const mine = created.data.jobs.find((j) =>
      (j as unknown as { target_label: string }).target_label.endsWith("for mallory@forge-01"),
    );
    expect(mine, "no key job for mallory").toBeTruthy();
    const job = await settled(mine!.id);
    expect(job.status).toBe("failed");
    expect(job.error?.message).toBe("no POSIX account named mallory on this host");
    expect(await hostFile(forge.id, "/home/mallory/.ssh/authorized_keys")).toMatch(/^<unreadable: 404/);

    /* The API applies the same name rule as the form and the agent. */
    for (const bad of ["../etc", "root;id", ""]) {
      const refused = await api.call("POST", "/ssh/keys", {
        name: "bad account",
        public_key: freshKey("x").line,
        posix_user: bad,
      });
      expect(refused.status, bad).toBe(422);
      expect(refused.error?.fields?.["posix_user"], bad).toBeTruthy();
    }

    const cleanup = await api.call<{ jobs: JobRow[] }>("DELETE", `/ssh/keys/${created.data.ssh_key.id}`);
    expect(cleanup.status).toBe(202);
  });

  test("clearing AllowUsers removes the directive on the host", async ({ page }) => {
    const mail = await server("mail-01");
    const api = await owner();
    await openConfig(page, "mail-01");
    const field = page.getByLabel("AllowUsers");
    await expect(field).not.toHaveValue("");
    expect(await hostFile(mail.id, SSHD)).toMatch(/^AllowUsers \S/m);

    await field.fill("");
    await page.getByRole("button", { name: "Review and apply" }).click();
    const dialog = page.getByRole("dialog", { name: "Apply sshd configuration to mail-01" });
    await expect(dialog).toContainText("(unset — every account)");
    await dialog.getByLabel("Rollback window").selectOption(String(WINDOW_S));
    await dialog.getByRole("button", { name: "Apply" }).click();
    expect(await drawerJob(page, "mail-01")).toContain("Succeeded");

    /* Empty means "clear the directive", not "leave it alone". */
    await expect.poll(() => hostFile(mail.id, SSHD)).not.toMatch(/^AllowUsers/m);
    const during = await api.get<ConfigRead>(`/ssh/config?server_id=${mail.id}`);
    expect(during.allow_users).toEqual([]);
    expect(during.pending_rollback?.changes).toContain("AllowUsers (cleared)");

    await rollbackBanner(page, "mail-01").getByRole("button", { name: "Confirm — keep these changes" }).click();
    await expect(rollbackBanner(page, "mail-01")).toBeHidden();
    await page.reload();
    await expect(page.getByLabel("AllowUsers")).toHaveValue("");
    const live = await api.get<ConfigRead>(`/ssh/config?server_id=${mail.id}&refresh=true`);
    expect(live.allow_users).toEqual([]);
  });

  test("a change that would end SSH access is refused without a window", async ({ page }) => {
    const db = await server("db-01");
    await openConfig(page, "db-01");
    const before = await hostFile(db.id, SSHD);

    /* The firewall only allows 22 from 10/8; this browser is on 127.0.0.1. */
    await page.getByRole("spinbutton", { name: /^Port/ }).fill("2222");
    await page.getByRole("button", { name: "Review and apply" }).click();
    const dialog = page.getByRole("dialog", { name: "Apply sshd configuration to db-01" });
    await dialog.getByLabel("Rollback window").selectOption("0");
    await expect(dialog.getByText(/With no rollback window/)).toBeVisible();
    await dialog.getByRole("button", { name: "Apply" }).click();

    await expect(
      page.getByText(
        "Apply sshd configuration: This sshd configuration would end SSH access to db-01 and you asked for no rollback window.",
      ),
    ).toBeVisible();
    expect(await hostFile(db.id, SSHD)).toBe(before);
    const api = await owner();
    const jobs = await api.get<JobRow[]>(`/jobs?server_id=${db.id}&type=ssh.config.apply&per_page=5`);
    expect(jobs).toHaveLength(0);

    /* Out-of-range values are refused by name. */
    const bad = await api.call("PUT", `/ssh/config?server_id=${db.id}`, {
      port: 70000,
      max_auth_tries: 0,
      rollback_seconds: 301,
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.error?.fields ?? {}).sort()).toEqual([
      "max_auth_tries",
      "port",
      "rollback_seconds",
    ]);
  });

  test("active sessions are read live from the host", async ({ page }) => {
    const mail = await server("mail-01");
    await page.goto(`/security/ssh?panel=sessions&server_id=${mail.id}`);
    const table = page.getByRole("table", { name: "Active SSH sessions" });
    await expect(table.locator("tbody tr").filter({ hasText: "deploy" }).first()).toBeVisible();
    await expect(table).toContainText("pts/");

    await page.getByLabel("Search active sessions").fill("no-such-user");
    await expect(page.getByText("No open SSH session")).toBeVisible();

    /* Refresh is a real re-read, answered by the agent. */
    const api = await owner();
    const live = await api.get<{ user: string; pid: number }[]>(`/ssh/sessions?server_id=${mail.id}`);
    expect(live.length).toBeGreaterThan(0);
    const reread = page.waitForResponse((r) => r.url().includes("/ssh/sessions") && r.ok());
    await page.getByRole("button", { name: "Refresh sessions" }).click();
    await reread;
  });

  test("sessions on a host whose agent is gone are an error, not an empty list", async () => {
    const api = await owner();
    const missing = await api.call("GET", `/ssh/sessions?server_id=${missingId}`);
    expect(missing.status).toBe(404);
    const noServer = await api.call("GET", "/ssh/sessions");
    expect(noServer.status).toBeGreaterThanOrEqual(400);
  });
});

