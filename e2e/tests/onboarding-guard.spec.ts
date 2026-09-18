import { expect, test } from "@playwright/test";

/* ------------------------------------------------------------------ *
 * Journey 9 — onboarding is a one-way door.
 *
 * This stack has an owner account. From that moment, the setup flow is
 * over for anyone who is not signed in: a stranger who navigates
 * straight to /setup must land on the login form, never on a screen
 * that would let them create a second owner. The control plane refuses
 * the endpoints regardless (setup.test.ts proves that); this covers the
 * routing, so the refusal is never what an operator sees.
 * ------------------------------------------------------------------ */

test.use({ storageState: { cookies: [], origins: [] } });

test("an anonymous visitor cannot walk back into setup", async ({ page }) => {
  await page.goto("/setup");
  /* The way back is kept: signing in returns to the wizard, not to "/". */
  await expect(page).toHaveURL(/\/login\?next=%2Fsetup$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  /* And the API says the same thing to the same caller. */
  const state = await page.request.get("/api/v1/setup/state");
  expect(state.ok()).toBe(true);
  const body = (await state.json()) as { data: { has_owner: boolean; authorized: boolean } };
  expect(body.data.has_owner).toBe(true);
  expect(body.data.authorized).toBe(false);

  const claim = await page.request.post("/api/v1/setup/owner", {
    data: {
      name: "Mallory",
      email: "mallory@example.com",
      password: "a-perfectly-good-passphrase-1!",
      password_confirmation: "a-perfectly-good-passphrase-1!",
    },
  });

  /*
   * 401, not 409: an anonymous caller is refused before the control
   * plane says anything about whether this instance already has an
   * owner. Signed in, the same call answers 409 — setup.test.ts covers
   * that half.
   */
  expect(claim.status()).toBe(401);
});
