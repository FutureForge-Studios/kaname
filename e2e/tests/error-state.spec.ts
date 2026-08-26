import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";

/* ------------------------------------------------------------------ *
 * Journey 7 — an error that says what is wrong.
 *
 * The API contract guarantees a machine `code` and a remediation beside
 * every message (PLAN.md 4), and the panel has exactly one error
 * surface so that guarantee reaches the screen. "Something went wrong"
 * is the failure this is written to catch: an operator staring at a
 * resource that is not there should be told which resource, by which
 * code, with the shell still usable around it.
 * ------------------------------------------------------------------ */

test("a resource that does not exist reports itself specifically", async ({ page }) => {
  await page.goto(`/infrastructure/servers/${missingId}`);

  const error = page.getByRole("alert").filter({ hasText: "not_found" });
  await expect(error).toBeVisible();

  /* The id that was asked for, not a generic apology. */
  await expect(error).toContainText(`Server ${missingId} not found.`);
  await expect(error).not.toContainText(/something went wrong/i);

  /* And a way forward, rather than a dead end. */
  await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();

  /* The shell survives: the palette and the navigation are still there,
   * because a 404 on one resource is not a broken app. */
  await expect(page.getByRole("navigation", { name: "Primary" }).first()).toBeVisible();

  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();
});
