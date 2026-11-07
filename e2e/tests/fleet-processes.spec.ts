import { expect, test } from "@playwright/test";
import { cellAt, columnIndex, jobStatusPill } from "../support/ui.js";
import {
  drawerJob,
  openRowActions,
  ownerCall,
  server,
  service,
  serviceVerb,
  settledJob,
  tableRow,
  type JobRow,
} from "../support/fleet.js";

/* ------------------------------------------------------------------ *
 * Processes: read live, never cached (KD-012), and signalled only
 * through a confirmation that says what the signal does.
 *
 * Signalling is the one verb here that cannot be undone and is never
 * retried, so the journeys check both ends of it: the confirmation is
 * honest about SIGKILL (typed pid, no catching it), and the outcome is
 * visible on the host — the process leaves the table and the unit that
 * owned it drops to failed, exactly as systemd would report it.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const HOST = "edge-01";

test.afterAll(async () => {
  // cron is killed below; bring it back for anything after this file.
  const cron = await service(HOST, "cron.service");
  if (cron.active_state !== "active") await serviceVerb(HOST, "cron.service", "start");
});

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
  user: string;
  state: string;
  depth?: number;
}

/** How the PID column renders a pid: grouped, like every count in the panel. */
const shown = (pid: number) => pid.toLocaleString("en-US");

async function processes(query: string): Promise<ProcessRow[]> {
  const host = await server(HOST);
  return ownerCall<ProcessRow[]>("GET", `/processes?server_id=${host.id}&${query}`);
}

test("asks for a host first, then reads it live and sorts on the host's terms", async ({
  page,
}) => {
  await page.goto("/infrastructure/processes");
  /* No host, no guess: the page says what it needs. */
  await expect(page.getByText("No server selected")).toBeVisible();

  const host = await server(HOST);
  await page.goto(`/infrastructure/processes?server_id=${host.id}`);
  const table = page.getByRole("table", { name: "Processes" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await expect(page.getByText(/Read live from .*refreshing every \d+s/)).toBeVisible();

  /* Sort by PID: the host returns ascending pids, so systemd is first. */
  await table.getByRole("columnheader", { name: /PID/ }).click();
  await expect(page).toHaveURL(/sort=pid/);
  const pid = await columnIndex(table, "PID");
  await expect(cellAt(table.locator("tbody tr").first(), pid)).toHaveText("1");
  const pids = (await table.locator(`tbody tr td:nth-child(${pid + 1})`).allInnerTexts()).map(
    (t) => Number(t.replace(/,/g, "")),
  );
  expect(pids).toEqual([...pids].sort((a, b) => a - b));

  /* And by memory, largest first, as the API says it returns it. */
  await table.getByRole("columnheader", { name: /Memory/ }).click();
  await expect(page).toHaveURL(/sort=memory/);
  const top = await processes("sort=memory&limit=1");
  await expect(tableRow(table, shown(top[0]!.pid)).first()).toBeVisible();

  /* Pausing the refresh is the operator's choice, and it is kept. */
  const auto = page.getByRole("switch", { name: "Auto-refresh" });
  await auto.click();
  await expect(auto).not.toBeChecked();
  await expect(page.getByText(/refreshing every/)).toHaveCount(0);

  /* Filter by user narrows to that user's processes only. */
  await page.getByLabel("Filter by user").selectOption("www-data");
  await expect(page).toHaveURL(/user=www-data/);
  const user = await columnIndex(table, "User");
  await expect
    .poll(async () => {
      const users = await table.locator(`tbody tr td:nth-child(${user + 1})`).allInnerTexts();
      return users.length > 0 && users.every((u) => u.trim() === "www-data");
    })
    .toBe(true);
});

test("the tree view nests children under their parent", async ({ page }) => {
  const host = await server(HOST);
  await page.goto(`/infrastructure/processes?server_id=${host.id}`);
  await page.getByLabel("Process view").selectOption("tree");
  await expect(page).toHaveURL(/view=tree/);

  const table = page.getByRole("table", { name: "Processes" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  const pid = await columnIndex(table, "PID");
  /* The root of the tree is init, unindented. */
  const first = table.locator("tbody tr").first();
  await expect(cellAt(first, pid)).toHaveText("1");

  /* A child of pid 1 is indented one level deeper than pid 1 is. */
  const tree = await processes("view=tree&limit=50");
  const child = tree.find((p) => p.ppid === 1 && p.depth === 1)!;
  expect(child).toBeTruthy();
  const childRow = table.locator("tbody tr").filter({
    has: page.locator(`td:nth-child(${pid + 1})`, { hasText: new RegExp(`^${shown(child.pid)}$`) }),
  });
  const indent = async (row: typeof first) =>
    Number.parseFloat(
      await row
        .locator('span[style*="padding-left"]')
        .first()
        .evaluate((el) => (el as HTMLElement).style.paddingLeft || "0"),
    );
  expect(await indent(childRow.first())).toBeGreaterThan(await indent(first));
});

test("pid 1 cannot be signalled from the table, and the API refuses it too", async ({ page }) => {
  const host = await server(HOST);
  await page.goto(`/infrastructure/processes?server_id=${host.id}&sort=pid`);
  const table = page.getByRole("table", { name: "Processes" });
  await expect(table.locator("tbody tr").first()).toBeVisible();
  const pid = await columnIndex(table, "PID");
  const init = table.locator("tbody tr").first();
  await expect(cellAt(init, pid)).toHaveText("1");
  const menu = await openRowActions(page, init);
  await expect(menu.getByRole("menuitem", { name: "Send signal" })).toBeDisabled();
  await page.keyboard.press("Escape");

  const refused = await page.request.post("/api/v1/processes/1/signal", {
    data: { server_id: host.id, signal: "SIGTERM" },
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
    "pid 1 is the init system",
  );
});

test("SIGSTOP and SIGCONT pause and resume a process without killing it", async ({ page }) => {
  const host = await server(HOST);
  const target = (await processes("q=rsyslogd")).find((p) => p.command === "rsyslogd")!;
  expect(target).toBeTruthy();

  await page.goto(`/infrastructure/processes?server_id=${host.id}&q=rsyslogd`);
  const table = page.getByRole("table", { name: "Processes" });
  const row = tableRow(table, shown(target.pid)).first();
  await (await openRowActions(page, row)).getByRole("menuitem", { name: "Send signal" }).click();

  const dialog = page.getByRole("dialog", { name: /^Send SIGTERM to rsyslogd\?/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").selectOption("SIGSTOP");
  await expect(page.getByRole("dialog", { name: "Send SIGSTOP to rsyslogd?" })).toBeVisible();
  await page.getByRole("button", { name: "Send signal" }).click();

  await expect(jobStatusPill(drawerJob(page, `pid ${target.pid}`))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");
  const state = await columnIndex(table, "State");
  await expect(cellAt(row, state)).toHaveText("stopped", { timeout: 30_000 });

  await (await openRowActions(page, row)).getByRole("menuitem", { name: "Send signal" }).click();
  await page.getByRole("dialog").getByRole("combobox").selectOption("SIGCONT");
  await page.getByRole("button", { name: "Send signal" }).click();
  await expect(cellAt(row, state)).not.toHaveText("stopped", { timeout: 30_000 });
});

test("SIGKILL needs the pid typed, and kills the unit's main process for real", async ({
  page,
}) => {
  const host = await server(HOST);
  const cron = await service(HOST, "cron.service");
  expect(cron.active_state).toBe("active");
  const pid = cron.main_pid!;

  await page.goto(`/infrastructure/processes?server_id=${host.id}&q=cron`);
  const table = page.getByRole("table", { name: "Processes" });
  const row = tableRow(table, shown(pid)).first();
  await (await openRowActions(page, row)).getByRole("menuitem", { name: "Send signal" }).click();
  await page.getByRole("dialog").getByRole("combobox").selectOption("SIGKILL");

  const dialog = page.getByRole("dialog", { name: "Send SIGKILL to cron?" });
  await expect(dialog).toContainText("cannot be caught or ignored");
  const send = dialog.getByRole("button", { name: "Send signal" });
  await expect(send).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill(String(pid + 1));
  await expect(send).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill(String(pid));
  await send.click();

  await expect(jobStatusPill(drawerJob(page, `pid ${pid}`))).toContainText("Succeeded", {
    timeout: 60_000,
  });
  await page.keyboard.press("Escape");

  /* Gone from the live table, and its unit reports what systemd would. */
  await expect(tableRow(table, shown(pid))).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => (await service(HOST, "cron.service")).active_state, { timeout: 30_000 })
    .toBe("failed");
});

test("signalling a process that has already gone fails the job and is not retried", async () => {
  /* The pid was valid when the dialog opened; by the time the job runs,
   * it is not. The host's answer is the job's error. */
  const host = await server(HOST);
  const gone = Math.max(...(await processes("sort=pid&limit=500")).map((p) => p.pid)) + 5000;
  const { job } = await ownerCall<{ job: JobRow }>("POST", `/processes/${gone}/signal`, {
    server_id: host.id,
    signal: "SIGTERM",
  });
  const settled = await settledJob(job.id);
  expect(settled.status).toBe("failed");
  expect(settled.error?.code).toBe("not_found");
  expect(settled.attempt).toBe(1);
});
