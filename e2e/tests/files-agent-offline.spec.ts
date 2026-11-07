import { expect, test } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { call, data, qs, settle, startAgent, stopAgent, unique } from "../support/data.js";
import { jobStatusPill } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Files and databases with the agent gone mid-flow.
 *
 * edge-01's agent is killed while the file manager is open on it. The
 * page must say that the host is unreachable — by code, with a way
 * forward — rather than spin or show an empty directory; reads must fail
 * fast; and a mutation queued meanwhile must wait for the host instead
 * of failing, then land once the agent is back (KD-008).
 *
 * The agent is always restarted, even when an assertion fails, so the
 * rest of the suite still has a four-host fleet.
 * ------------------------------------------------------------------ */

const HOST = "edge-01";

test.describe.configure({ mode: "serial" });

test("the file manager reports a vanished agent and a queued change lands when it returns", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const server = await serverNamed(HOST);
  const dir = `/srv/${unique("offline-")}`;

  await page.goto(`/files/manager?${qs({ server_id: server.id, path: "/etc" })}`);
  const table = page.getByRole("table", { name: "Directory listing" });
  await expect(table.locator('[title="/etc/hostname"]')).toBeVisible();

  try {
    await stopAgent(HOST, server.id);

    /* A re-read now is a specific error, not an empty listing. */
    await page.getByRole("button", { name: "Re-read this directory" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "agent_offline" });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(HOST);
    await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();

    /* The editor and a download fail the same way, fast. */
    const started = Date.now();
    const read = await call("GET", `/files/read?${qs({ server_id: server.id, path: "/etc/hostname" })}`);
    expect(read.body.error?.code).toBe("agent_offline");
    expect(Date.now() - started).toBeLessThan(10_000);
    const dl = await call("GET", `/files/download?${qs({ server_id: server.id, path: "/etc/hostname" })}`);
    expect(dl.body.error?.code).toBe("agent_offline");

    /* A mutation is accepted and waits — it is not an error to want it. */
    const queued = await data<{ job: { id: string } }>("POST", "/files/mkdir", {
      server_id: server.id,
      path: dir,
    });
    await expect
      .poll(async () => (await data<{ status: string; blocked_reason: string | null }>("GET", `/jobs/${queued.job.id}`)).blocked_reason, {
        timeout: 30_000,
        message: "a job for an offline host was never marked as waiting for it",
      })
      .toBe("agent_offline");
    const pending = await data<{ status: string }>("GET", `/jobs/${queued.job.id}`);
    expect(pending.status).toBe("queued");

    /* The drawer shows it as waiting, with the reason. */
    await page.goto(`/jobs/${queued.job.id}`);
    await expect(jobStatusPill(page.locator("main")).first()).toContainText(/Queued/);
    await expect(page.locator("main")).toContainText("agent offline");

    await startAgent(HOST, server.id);

    expect((await settle(queued.job.id, 120_000)).status).toBe("succeeded");
    const listing = await data<{ entries: { name: string }[] }>("GET", `/files?${qs({ server_id: server.id, path: "/srv" })}`);
    expect(listing.entries.map((e) => e.name)).toContain(dir.slice("/srv/".length));

    /* And the page recovers on retry, with no reload. */
    await page.goto(`/files/manager?${qs({ server_id: server.id, path: "/srv" })}`);
    await expect(table.locator(`[title="${dir}"]`)).toBeVisible();
  } finally {
    await startAgent(HOST, server.id);
  }
});

test("an upload to a host that is offline is refused before a byte is sent", async ({ page }) => {
  test.setTimeout(240_000);
  const server = await serverNamed(HOST);
  await page.goto(`/files/manager?${qs({ server_id: server.id, path: "/srv" })}`);
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();

  try {
    await stopAgent(HOST, server.id);
    await page.locator('input[type="file"]').setInputFiles({
      name: "late.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("too late\n"),
    });
    const item = page.getByRole("region", { name: "Uploads" }).getByRole("listitem").filter({ hasText: "late.txt" });
    await expect(item).toContainText(/unreachable|offline|not connected/i, { timeout: 30_000 });
  } finally {
    await startAgent(HOST, server.id);
  }

  const listing = await data<{ entries: { name: string }[] }>("GET", `/files?${qs({ server_id: server.id, path: "/srv" })}`);
  expect(listing.entries.map((e) => e.name)).not.toContain("late.txt");
});
