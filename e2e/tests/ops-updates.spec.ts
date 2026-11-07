import { expect, test } from "@playwright/test";
import { closedPort, endpoint, owner, type Endpoint } from "../support/secops.js";

/* ------------------------------------------------------------------ *
 * Updates — what is running, and a check that tells the truth.
 *
 * The manifest is served from loopback by the test, so "an update is
 * available" and "the check failed" are both real outcomes of a real
 * fetch rather than whatever the internet says today. Nothing here
 * applies an update: that restarts the control plane under the suite.
 * ------------------------------------------------------------------ */

interface Overview {
  control_plane: { current_version: string; latest_version: string | null; update_available: boolean };
  agents: { server_name: string }[];
  settings: { manifest_url: string; last_check_error: string | null };
}

let manifest: Endpoint;
let originalUrl: string;

test.beforeAll(async () => {
  manifest = await endpoint();
  originalUrl = (await (await owner()).get<Overview>("/updates")).settings.manifest_url;
});
test.afterAll(async () => {
  await (await owner()).call("PATCH", "/updates/policy", { manifest_url: originalUrl });
  await manifest.close();
});

test("the page shows the running versions and a newer release from the manifest", async ({ page }) => {
  const api = await owner();
  const overview = await api.get<Overview>("/updates");

  manifest.respond.status = 200;
  manifest.respond.body = JSON.stringify({
    schema: 1,
    releases: [
      {
        version: "99.1.0",
        channel: "stable",
        released_at: new Date().toISOString(),
        summary: "e2e: a release that only exists on loopback",
        artifacts: {
          control_plane: "ghcr.io/example/kaname-control-plane:99.1.0",
          web: "ghcr.io/example/kaname-web:99.1.0",
          agent: {},
        },
      },
    ],
  });
  await api.ok("PATCH", "/updates/policy", { manifest_url: `${manifest.url}/manifest.json` });

  await page.goto("/administration/updates");
  await expect(page.getByRole("heading", { level: 1, name: "Updates" })).toBeVisible();
  await expect(page.getByText(`Control plane ${overview.control_plane.current_version}`)).toBeVisible();
  const agents = page.getByRole("table", { name: "Agent versions" });
  await expect(agents.locator("tbody tr")).toHaveCount(4);

  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("e2e: a release that only exists on loopback")).toBeVisible();
  await expect(page.getByText("99.1.0").first()).toBeVisible();
  expect(manifest.received.some((r) => r.path === "/manifest.json")).toBe(true);
  const after = await api.get<Overview>("/updates");
  expect(after.control_plane).toMatchObject({ latest_version: "99.1.0", update_available: true });
});

test("a check that cannot reach the manifest says why, instead of 'up to date'", async ({ page }) => {
  const api = await owner();
  const port = await closedPort();
  await api.ok("PATCH", "/updates/policy", { manifest_url: `http://127.0.0.1:${port}/manifest.json` });

  await page.goto("/administration/updates");
  await page.getByRole("button", { name: "Check for updates" }).click();
  const notice = page.getByText(/^The last check failed: /);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(`ECONNREFUSED 127.0.0.1:${port}`);
  await expect(page.getByText("Already on the newest release.")).toHaveCount(0);

  /* A manifest that answers, but with garbage, is a different failure. */
  manifest.respond.status = 200;
  manifest.respond.body = JSON.stringify({ schema: 7 });
  await api.ok("PATCH", "/updates/policy", { manifest_url: `${manifest.url}/bad.json` });
  const checked = await api.ok<Overview>("POST", "/updates/check");
  expect(checked.settings.last_check_error).toBe(
    `the release manifest at ${manifest.url}/bad.json is not in a shape this version understands`,
  );

  const bad = await api.call("PATCH", "/updates/policy", { manifest_url: "not a url" });
  expect(bad.status).toBe(422);
});
