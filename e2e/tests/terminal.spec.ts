import { expect, test } from "@playwright/test";
import { serverNamed, terminalSessions } from "../support/api.js";

/* ------------------------------------------------------------------ *
 * Journey 5 — a shell on a simulated host.
 *
 * The terminal is the one place the "no shell strings" rule cannot hold
 * (KD-013), so what is asserted is both halves of that bargain: the
 * session really works — keystrokes reach the far end and its output
 * comes back — and the operator is told, on screen, that it is being
 * recorded. A recorded root shell that does not say so would be worse
 * than an unrecorded one.
 *
 * The token is echoed twice: once as the shell echoes the keystrokes,
 * once as the output of the command. One occurrence would mean the
 * socket carried input but nothing ran.
 * ------------------------------------------------------------------ */

test("opens a recorded session and runs a command on the far end", async ({ page }) => {
  const forge = await serverNamed("forge-01");
  await page.goto(`/terminal?server_id=${forge.id}`);

  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(page.getByText("This session is being recorded.")).toBeVisible();
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();

  const screen = page.locator(".xterm-rows");
  await expect(screen).toContainText("This is a simulated host", { timeout: 30_000 });

  const token = `kaname-e2e-${Date.now().toString(36)}`;
  await page.locator(".xterm-screen").click();
  await page.keyboard.type(`echo ${token}`);
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => (await screen.innerText()).split(token).length - 1, {
      message: "the command echoed but produced no output",
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(2);

  /* And "recorded" is not just a banner: the control plane really did
   * store the stream, so the claim on screen is checkable. */
  await expect
    .poll(async () => (await terminalSessions(forge.id)).some((s) => s.recording_available), {
      message: "the session said it was recorded but nothing was stored",
      timeout: 30_000,
    })
    .toBe(true);
});
