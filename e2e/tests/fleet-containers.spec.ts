import { expect, test } from "@playwright/test";
import { cellAt, columnIndex, jobStatusPill } from "../support/ui.js";
import {
  call,
  container,
  drawerJob,
  openRowActions,
  ownerApi,
  ownerCall,
  server,
  signedInAs,
  tableRow,
  terminalSessionsFor,
} from "../support/fleet.js";

/* ------------------------------------------------------------------ *
 * Containers: the same contract as units — every verb a job, the
 * cached row the proof — plus the one verb that destroys data.
 *
 * Removal discards a writable layer, so it is typed-confirmed, and a
 * running container is refused unless force is chosen. That refusal is
 * the control plane's, not the dialog's; the dialog only pre-ticks
 * force so the operator is not sent on a round trip to learn it. Both
 * halves are exercised here.
 *
 * Everything runs on mail-01 so the suite's other journeys keep the
 * containers they expect on forge-01.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const HOST = "mail-01";

async function openFleetFilteredTo(page: import("@playwright/test").Page, name: string) {
  const host = await server(HOST);
  await page.goto(`/infrastructure/containers?server_id=${host.id}`);
  await page.getByLabel("Search containers").fill(name);
  const table = page.getByRole("table", { name: "Containers" });
  const row = tableRow(table, name).first();
  await expect(row).toBeVisible();
  return { table, row };
}

test("the state filter narrows the fleet, and each row says which host it is on", async ({
  page,
}) => {
  await page.goto("/infrastructure/containers");
  const table = page.getByRole("table", { name: "Containers" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await page.getByLabel("Filter by container state").selectOption("exited");
  await expect(page).toHaveURL(/state=exited/);

  const state = await columnIndex(table, "State");
  await expect
    .poll(async () => {
      const cells = await table.locator(`tbody tr td:nth-child(${state + 1})`).allInnerTexts();
      return cells.length > 0 && cells.every((text) => text.startsWith("exited"));
    })
    .toBe(true);
  await expect(tableRow(table, "n8n").filter({ hasText: HOST })).toBeVisible();
});

test("start, restart and stop each run as a job and the row follows the host", async ({ page }) => {
  const { table, row } = await openFleetFilteredTo(page, "n8n");
  const state = await columnIndex(table, "State");
  await expect(cellAt(row, state)).toContainText("exited");

  /* Stopped containers offer Start and nothing that needs them running. */
  let menu = await openRowActions(page, row);
  await expect(menu.getByRole("menuitem", { name: "Stop", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Restart", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Start", exact: true }).click();
  await expect(jobStatusPill(drawerJob(page, "n8n"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(cellAt(row, state)).toContainText("running", { timeout: 30_000 });

  /* Restart counts on the host, not in the browser. */
  const before = (await container(HOST, "n8n")).restart_count;
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Restart", exact: true }).click();
  await expect(jobStatusPill(drawerJob(page, "Restart container"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await container(HOST, "n8n")).restart_count, { timeout: 60_000 })
    .toBe(before + 1);

  /* Stop is confirmed; then the row goes back to exited. */
  menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Stop", exact: true }).click();
  await page.getByRole("dialog", { name: "Stop n8n?" }).getByRole("button", { name: "Stop" }).click();
  await expect(cellAt(row, state)).toContainText("exited", { timeout: 60_000 });
  expect((await container(HOST, "n8n")).state).toBe("exited");
});

test("removing a running container without force is refused by the control plane", async ({
  page,
}) => {
  const { row } = await openFleetFilteredTo(page, "uptime-kuma");
  const menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Remove uptime-kuma?" });
  await expect(dialog).toContainText("still running");
  const force = dialog.getByRole("checkbox", { name: /Force removal/ });
  /* Pre-ticked for a running container, and the operator can untick it. */
  await expect(force).toBeChecked();
  await force.uncheck();
  await dialog.getByLabel(/to confirm/).fill("uptime-kuma");
  await dialog.getByRole("button", { name: "Remove" }).click();

  /* The refusal is the API's own sentence, and nothing was removed. */
  await expect(page.getByText(`uptime-kuma is still running on ${HOST}.`).first()).toBeVisible();
  expect((await container(HOST, "uptime-kuma")).state).toBe("running");
});

test("removing a container is typed-confirmed and the row leaves the table", async ({ page }) => {
  const { table, row } = await openFleetFilteredTo(page, "watchtower");
  const menu = await openRowActions(page, row);
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Remove watchtower?" });
  const remove = dialog.getByRole("button", { name: "Remove" });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill("watchtowe");
  await expect(remove).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill("watchtower");
  await remove.click();

  await expect(jobStatusPill(drawerJob(page, "watchtower"))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  await expect(tableRow(table, "watchtower")).toHaveCount(0, { timeout: 30_000 });
  await expect(container(HOST, "watchtower")).rejects.toThrow(/no container watchtower/);
});

test("a container's logs stream from the host", async ({ page }) => {
  const redis = await container(HOST, "kaname-redis");
  await page.goto(`/infrastructure/containers/${redis.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "kaname-redis" })).toBeVisible();

  await page.getByRole("tab", { name: /Logs/ }).click();
  await expect(page).toHaveURL(/tab=logs/);
  const output = page.getByRole("log", { name: "Output from kaname-redis" });
  await expect
    .poll(async () => (await output.innerText()).trim().length, { message: "no container output" })
    .toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ *
 * Exec is `container.exec`, opened from the tab itself over the
 * terminal's path (KD-013): a ticket from POST /terminal/sessions, an
 * audit entry on open and on close, and a recording. What is typed has
 * to land inside the container — its hostname, its filesystem — not on
 * the host it runs on.
 * ------------------------------------------------------------------ */

test("exec opens a shell inside the container, and it is audited and recorded", async ({
  page,
}) => {
  const redis = await container(HOST, "kaname-redis");
  const host = await server(HOST);
  const short = redis.container_id.slice(0, 12);
  await page.goto(`/infrastructure/containers/${redis.id}?tab=exec`);

  await page.getByRole("button", { name: "Open shell in kaname-redis" }).click();
  const screen = page.locator(".xterm-rows");
  await expect(screen).toContainText("Inside container kaname-redis", { timeout: 30_000 });
  await expect(page.getByText("This session is being recorded.")).toBeVisible();

  await page.locator(".xterm-screen").click();
  await page.keyboard.type("hostname");
  await page.keyboard.press("Enter");
  /* The container's own name for itself, which is not the host's. */
  await expect(screen).toContainText(`root@${short}`);
  await expect
    .poll(async () => (await screen.innerText()).split("\n").map((line) => line.trim()))
    .toContain(short);
  /* (The banner names the host it runs on; no line answers with it.) */
  const lines = (await screen.innerText()).split("\n").map((line) => line.trim());
  expect(lines).not.toContain(host.hostname);

  await page.keyboard.type("cat /etc/os-release");
  await page.keyboard.press("Enter");
  await expect(screen).toContainText("Alpine Linux");

  /* Listed with the host terminal's sessions, naming the container. */
  const sessions = await terminalSessionsFor(host.id);
  const open = sessions.find((s) => s.ended_at === null && s.container_name === "kaname-redis");
  expect(open, "the exec session is not listed as an open session").toBeTruthy();
  /* Recording is written in batches, so "available" waits on the first. */
  await expect
    .poll(
      async () =>
        (await terminalSessionsFor(host.id)).find((s) => s.id === open!.id)?.recording_available,
    )
    .toBe(true);

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect
    .poll(async () => (await terminalSessionsFor(host.id)).find((s) => s.id === open!.id)?.ended_at)
    .not.toBeNull();

  /* Audited on open and on close, against the container on its host. */
  for (const action of ["terminal.session.opened", "terminal.session.closed"]) {
    const [event] = await ownerCall<
      { target_id: string; target_label: string; metadata: Record<string, unknown> }[]
    >("GET", `/audit?action=${action}&target_id=${open!.id}&per_page=1`);
    expect(event, `no ${action} for the exec session`).toBeTruthy();
    expect(event!.target_label).toBe(`kaname-redis on ${HOST}`);
  }

  /* And the recording holds what was typed inside it. */
  const recording = await ownerCall<{ frames: { direction: string; data: string }[] }>(
    "GET",
    `/terminal/sessions/${open!.id}/recording`,
  );
  const typed = recording.frames
    .filter((f) => f.direction === "in")
    .map((f) => Buffer.from(f.data, "base64").toString("utf8"))
    .join("");
  expect(typed).toContain("hostname");
  const printed = recording.frames
    .filter((f) => f.direction === "out")
    .map((f) => Buffer.from(f.data, "base64").toString("utf8"))
    .join("");
  expect(printed).toContain("Alpine Linux");
});

test("exec is the terminal's permission, and the API holds the line", async ({ browser }) => {
  const redis = await container(HOST, "kaname-redis");
  const host = await server(HOST);

  /* A Developer manages containers but holds no shell (rbac.ts). */
  const context = await signedInAs(browser, "developer");
  try {
    const page = await context.newPage();
    await page.goto(`/infrastructure/containers/${redis.id}?tab=exec`);
    await expect(page.getByRole("button", { name: "Open shell in kaname-redis" })).toBeDisabled();
    await expect(page.getByText(/does not hold terminal\.session:exec/)).toBeVisible();

    const refused = await call(page.context().request, "POST", "/terminal/sessions", {
      server_id: host.id,
      container_id: redis.id,
      cols: 80,
      rows: 24,
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.message).toContain("terminal.session:exec");
  } finally {
    await context.close();
  }

  /* A container on another host is not reachable by naming this one. */
  const forge = await server("forge-01");
  const elsewhere = await call(await ownerApi(), "POST", "/terminal/sessions", {
    server_id: forge.id,
    container_id: redis.id,
    cols: 80,
    rows: 24,
  });
  expect(elsewhere.status).toBe(404);

  /* A stopped container has nothing to exec into, and says so up front. */
  const n8n = await container(HOST, "n8n");
  expect(n8n.state).not.toBe("running");
  const stopped = await call(await ownerApi(), "POST", "/terminal/sessions", {
    server_id: host.id,
    container_id: n8n.id,
    cols: 80,
    rows: 24,
  });
  expect(stopped.status).toBe(412);
  expect(stopped.error?.message).toContain("n8n is exited");
});
