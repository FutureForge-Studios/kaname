import { expect, test, type Page } from "@playwright/test";
import { missingId } from "../support/config.js";
import { sectionNamed } from "../support/ui.js";
import {
  agentPids,
  connectionLabel,
  enrollAgent,
  killAgent,
  ownerCall,
  server,
  startAgent,
  tableRow,
  waitForConnection,
  type ServerRow,
} from "../support/fleet.js";
import type { Managed } from "../support/processes.js";

/* ------------------------------------------------------------------ *
 * Servers: the whole life of a host, from a name in a form to a row
 * that is gone.
 *
 * PLAN.md 2.3 makes enrollment a single pasted line, and KD-026 makes
 * that line the only way a host ever joins. So the journey here runs the
 * real thing: the token is read off the dialog the operator sees, handed
 * to a real `kanamed enroll`, and the dialog is expected to notice the
 * agent dialling in without anyone touching the page. A server that has
 * to be refreshed into "connected" is a server an operator will re-enroll
 * twice.
 *
 * Then the two ways a host stops talking — it dies, or we revoke it —
 * are kept apart, because they mean opposite things: one comes back on
 * its own, the other must not be able to.
 * ------------------------------------------------------------------ */

test.describe.configure({ mode: "serial" });

const NEW_HOST = "e2e-node-01";
const NEW_HOSTNAME = "e2e-node-01.fleet.test";
/** The seeded host whose agent is killed and brought back. */
const CRASH_HOST = "edge-01";

const HEALTH_WORD = /^(Healthy|Warning|Critical|Unknown)$/;

let newAgent: Managed | null = null;

function header(page: Page) {
  return page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
}

test.afterAll(() => {
  // Whatever a failure left behind, the seeded host must be running for
  // the specs after this one, and the enrolled extra must not be.
  if (agentPids(CRASH_HOST).length === 0) startAgent(CRASH_HOST);
  for (const pid of agentPids(NEW_HOST)) process.kill(pid, "SIGKILL");
});

test("the add-server form names the field that is wrong, before and after the API", async ({
  page,
}) => {
  await page.goto("/infrastructure/servers");
  await expect(page.getByRole("table", { name: "Servers" })).toBeVisible();

  await page.getByRole("button", { name: "Add server" }).click();
  const dialog = page.getByRole("dialog", { name: "Add server" });
  await expect(dialog).toBeVisible();

  const name = dialog.getByRole("textbox", { name: /^Name/ });
  const hostname = dialog.getByRole("textbox", { name: /^Hostname/ });
  const submit = dialog.getByRole("button", { name: "Create and enroll" });

  /* Nothing typed: the browser's own required check stops the submit,
   * so not even a request is spent on it. */
  await submit.click();
  await expect(dialog).toBeVisible();
  expect(await name.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  expect(await hostname.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);

  /* Whitespace gets past `required` but not the contract: the name is
   * trimmed before it is checked, and the error sits on that field. */
  await name.fill("   ");
  await hostname.fill("ok.example.com");
  await submit.click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription(/String must contain at least 1 character\(s\)/);
  await expect(hostname).not.toHaveAttribute("aria-invalid", "true");

  /* A hostname that cannot be one, and a name one character too long. */
  await name.fill("x".repeat(65));
  await hostname.fill("not a host!");
  await submit.click();
  await expect(name).toHaveAccessibleDescription(/String must contain at most 64 character\(s\)/);
  await expect(hostname).toHaveAccessibleDescription(/must be a valid hostname/);

  /* The boundary itself is fine: 64 characters clears the name error. */
  await name.fill("x".repeat(64));
  await hostname.fill("-leading-dash.example.com");
  await submit.click();
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await expect(hostname).toHaveAccessibleDescription(/must be a valid hostname/);

  /* Valid locally, refused by the API: names are unique across the
   * fleet, and the refusal is the API's own words, not a generic toast. */
  await name.fill("forge-01");
  await hostname.fill("forge-01-again.example.com");
  await submit.click();
  await expect(dialog.getByRole("alert")).toContainText('A server named "forge-01" already exists.');
  await expect(dialog.getByRole("alert")).toContainText("conflict");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  /* And nothing was created by any of it. */
  const names = (await ownerCall<ServerRow[]>("GET", "/servers?per_page=100")).map((s) => s.name);
  expect(names.filter((n) => n === "forge-01")).toHaveLength(1);
  expect(names).not.toContain("x".repeat(64));
});

test("a new server enrolls with the command the dialog prints and connects on its own", async ({
  page,
}) => {
  await page.goto("/infrastructure/servers");
  await page.getByRole("button", { name: "Add server" }).click();
  const form = page.getByRole("dialog", { name: "Add server" });
  await form.getByRole("textbox", { name: /^Name/ }).fill(NEW_HOST);
  await form.getByRole("textbox", { name: /^Hostname/ }).fill(NEW_HOSTNAME);
  await form.getByRole("button", { name: "Create and enroll" }).click();

  /* The dialog does not close on save: it becomes the enrollment step. */
  const enroll = page.getByRole("dialog", { name: `Enroll ${NEW_HOST}` });
  await expect(enroll).toBeVisible();
  await expect(connectionLabel(enroll)).toHaveText("Never enrolled");
  await expect(enroll.locator("p", { hasText: "Waiting for the agent to connect" })).toBeVisible();

  /* The one-liner, read off the screen exactly as an operator would copy it. */
  const command = enroll.locator("code").filter({ hasText: "--token=" }).first();
  await expect(command).toBeVisible();
  const text = (await command.textContent()) ?? "";
  const token = /--token=(\S+)/.exec(text)?.[1];
  const url = /--control-plane=(\S+)/.exec(text)?.[1];
  expect(token, `no token in "${text}"`).toMatch(/^kn_enroll_/);
  expect(url, `no control-plane URL in "${text}"`).toBeTruthy();

  /* What install.sh does on the box: enroll, then run the agent. */
  await enrollAgent(NEW_HOST, url!, token!);
  newAgent = startAgent(NEW_HOST);

  /* Resolved on its own, in the dialog that was left open. */
  await expect(enroll.locator("p", { hasText: "Agent connected" })).toBeVisible({ timeout: 30_000 });
  await expect(connectionLabel(enroll)).toHaveText("Connected");

  /* The token was spent by that enrollment: a second box cannot reuse it. */
  await expect(enrollAgent(`${NEW_HOST}-replay`, url!, token!)).rejects.toThrow(
    /Enrollment token is invalid, used or expired/,
  );

  await enroll.getByRole("button", { name: "Open server" }).click();
  await expect(page).toHaveURL(/\/infrastructure\/servers\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: NEW_HOST })).toBeVisible();
  await expect(connectionLabel(header(page))).toHaveText("Connected");
  /* The host's own report replaces what was typed into the form. */
  await expect(header(page).getByText("simulated", { exact: true })).toBeVisible();
});

test("re-issuing the enrollment command supersedes the token printed before it", async ({
  page,
}) => {
  const target = await server(NEW_HOST);
  const first = await ownerCall<{ token: string; control_plane_url: string }>(
    "POST",
    `/servers/${target.id}/enroll-token`,
    {},
  );

  /* The menu entry mints a fresh one, which is the only one live after. */
  await page.goto(`/infrastructure/servers/${target.id}`);
  await page.getByRole("button", { name: "Server actions" }).click();
  const minted = page.waitForResponse(
    (response) => response.url().endsWith("/enroll-token") && response.status() === 200,
  );
  await page.getByRole("menuitem", { name: "Enrollment command" }).click();
  await minted;
  const dialog = page.getByRole("dialog", { name: `Enroll ${NEW_HOST}` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Any previously issued token is superseded.");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dialog).toBeHidden();

  await expect(enrollAgent(`${NEW_HOST}-stale`, first.control_plane_url, first.token)).rejects.toThrow(
    /Enrollment token is invalid, used or expired/,
  );
});

test("an agent that dies reads as disconnected everywhere, and recovers on its own", async ({
  page,
}) => {
  const host = await server(CRASH_HOST);
  await page.goto(`/infrastructure/servers/${host.id}`);
  await expect(connectionLabel(header(page))).toHaveText("Connected");
  await expect(header(page).getByRole("button", { name: "Terminal" })).toBeEnabled();

  killAgent(CRASH_HOST);

  /* The page learns it from the socket closing, not from a reload. */
  await expect(connectionLabel(header(page))).toHaveText("Disconnected");
  /* The other axis is not left claiming a verdict nobody can make. */
  await expect(header(page).getByText(HEALTH_WORD)).toHaveText("Unknown", { timeout: 30_000 });
  /* What needs a live agent says so by being unavailable. */
  await expect(header(page).getByRole("button", { name: "Terminal" })).toBeDisabled();
  await expect(header(page).getByRole("button", { name: "Sync" })).toBeDisabled();

  /* The fleet table can narrow to exactly the hosts that are down. */
  await page.goto("/infrastructure/servers");
  const table = page.getByRole("table", { name: "Servers" });
  await page.getByLabel("Filter by agent state").selectOption("disconnected");
  await expect(page).toHaveURL(/connection=disconnected/);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(tableRow(table, CRASH_HOST)).toBeVisible();

  /* The Command Center puts it at the top of what needs attention. */
  await page.goto("/");
  const attention = sectionNamed(page, "Needs attention");
  const item = attention.getByRole("link").filter({ hasText: `${CRASH_HOST} is disconnected` });
  await expect(item).toBeVisible();
  await expect(page.getByText(/^3\/\d+ agents connected$/)).toBeVisible();

  /* And it links to the host, not to a list. */
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/infrastructure/servers/${host.id}$`));

  /* Bring the box back; the panel needs nothing from the operator. */
  startAgent(CRASH_HOST);
  await expect(connectionLabel(header(page))).toHaveText("Connected", { timeout: 60_000 });
  await expect(header(page).getByRole("button", { name: "Terminal" })).toBeEnabled();

  await page.goto("/");
  await expect(
    sectionNamed(page, "Needs attention").getByText(`${CRASH_HOST} is disconnected`),
  ).toHaveCount(0);
});

test("revoking drops the socket and the agent cannot dial back in", async ({ page }) => {
  expect(newAgent, "the enrollment journey did not start an agent").not.toBeNull();
  const target = await server(NEW_HOST);
  await page.goto(`/infrastructure/servers/${target.id}`);
  await expect(connectionLabel(header(page))).toHaveText("Connected");

  await page.getByRole("button", { name: "Server actions" }).click();
  await page.getByRole("menuitem", { name: "Revoke certificate" }).click();

  const confirm = page.getByRole("dialog", { name: `Revoke ${NEW_HOST}'s certificate?` });
  const revoke = confirm.getByRole("button", { name: "Revoke" });
  /* Typed confirmation, and a near miss does not count. */
  await expect(revoke).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill(NEW_HOST.slice(0, -1));
  await expect(revoke).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill(NEW_HOST);
  await revoke.click();

  await expect(connectionLabel(header(page))).toHaveText("Revoked");

  /* The agent is still running and still trying. Wait for the control
   * plane to have refused it at least once, then check nothing let it in. */
  await expect
    .poll(() => newAgent!.tail(), { message: "the agent never retried after revocation" })
    .toContain("certificate has been revoked");
  await expect.poll(async () => (await server(NEW_HOST)).connection).toBe("revoked");
  await page.reload();
  await expect(connectionLabel(header(page))).toHaveText("Revoked");

  /* Revoking twice is not offered. */
  await page.getByRole("button", { name: "Server actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Revoke certificate" })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("removing a server forgets it, and its old address answers not found", async ({ page }) => {
  const target = await server(NEW_HOST);
  await page.goto(`/infrastructure/servers/${target.id}`);

  await page.getByRole("button", { name: "Server actions" }).click();
  await page.getByRole("menuitem", { name: "Remove from Kaname" }).click();
  const confirm = page.getByRole("dialog", { name: `Remove ${NEW_HOST} from Kaname?` });
  await confirm.getByLabel(/to confirm/).fill(NEW_HOST);
  await confirm.getByRole("button", { name: "Remove" }).click();

  /* Off a page it no longer has a row for, onto the list without it. */
  await expect(page).toHaveURL(/\/infrastructure\/servers$/);
  const table = page.getByRole("table", { name: "Servers" });
  await expect(tableRow(table, "forge-01")).toBeVisible();
  await expect(tableRow(table, NEW_HOST)).toHaveCount(0);

  /* The bookmark someone kept now says exactly what is missing. */
  await page.goto(`/infrastructure/servers/${target.id}`);
  const error = page.getByRole("alert").filter({ hasText: "not_found" });
  await expect(error).toContainText(`Server ${target.id} not found.`);

  for (const pid of agentPids(NEW_HOST)) process.kill(pid, "SIGKILL");
});

test("filters, tabs and the back button keep the operator where they were", async ({ page }) => {
  await page.goto("/infrastructure/servers");
  const table = page.getByRole("table", { name: "Servers" });
  await expect(tableRow(table, "forge-01")).toBeVisible();

  /* Filter state lives in the URL, so a reload is not a reset. */
  await page.getByLabel("Filter by capability").selectOption("docker");
  await expect(page).toHaveURL(/capability=docker/);
  await expect(table.locator("tbody tr")).toHaveCount(2); // forge-01 and mail-01
  await page.reload();
  await expect(page.getByLabel("Filter by capability")).toHaveValue("docker");
  await expect(table.locator("tbody tr")).toHaveCount(2);

  /* Into a host, onto a tab — the tab is part of the address too. */
  await tableRow(table, "forge-01").getByText("forge-01", { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "forge-01" })).toBeVisible();
  await page.getByRole("tab", { name: /Containers/ }).click();
  await expect(page).toHaveURL(/tab=containers/);
  await page.reload();
  await expect(page.getByRole("tab", { name: /Containers/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  /* Back lands on the filtered list, not on an unfiltered one. */
  await page.goBack();
  await expect(page).toHaveURL(/\/infrastructure\/servers\?.*capability=docker/);
  await expect(page.getByLabel("Filter by capability")).toHaveValue("docker");
  await expect(table.locator("tbody tr")).toHaveCount(2);

  /* A search that matches nothing says so, and offers the way out. */
  await page.getByLabel("Search servers").fill("no-such-host-anywhere");
  await expect(page.getByText("No matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(page.getByLabel("Filter by capability")).toHaveValue("");
  await expect(table.locator("tbody tr")).toHaveCount(4);
});

test("an address that is not a server id is refused as malformed, not as missing", async ({
  page,
}) => {
  await page.goto("/infrastructure/servers/not-a-uuid");
  const error = page.getByRole("alert").filter({ hasText: "validation_failed" });
  await expect(error).toBeVisible();
  await expect(error).not.toContainText(/something went wrong/i);

  await page.goto(`/infrastructure/servers/${missingId}`);
  await expect(page.getByRole("alert").filter({ hasText: "not_found" })).toBeVisible();
});

test("the sign-in fleet is whole again once this file is done", async () => {
  /* Specs after this one assume four connected hosts and nothing else. */
  await waitForConnection(CRASH_HOST, "connected");
  const fleet = await ownerCall<ServerRow[]>("GET", "/servers?per_page=100");
  expect(fleet.map((s) => s.name).sort()).toEqual(["db-01", "edge-01", "forge-01", "mail-01"]);
});
