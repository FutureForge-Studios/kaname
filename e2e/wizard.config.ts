import { defineConfig, devices } from "@playwright/test";
import { artifactsDir, webUrl } from "./support/config.js";

/* ------------------------------------------------------------------ *
 * The setup wizard, on a fresh install.
 *
 * A separate config rather than a project in playwright.config.ts,
 * because the stack under it is different in kind: no seed, no
 * bootstrap owner, and the setup token read out of the control-plane
 * log (support/wizard-stack.ts). The default suite boots exactly as
 * before. Run it on its own ports and database, e.g.
 *
 *   KANAME_E2E_API_PORT=4217 KANAME_E2E_WEB_PORT=3217 \
 *   KANAME_E2E_DATABASE_URL=pglite://./.data/e2e-wizard \
 *   KANAME_E2E_ARTIFACTS_DIR=$PWD/e2e/.artifacts-wizard \
 *   KANAME_E2E_NEXT_DIST_DIR=.next-e2e-wizard \
 *   playwright test -c wizard.config.ts
 *
 * Serial by necessity: the journey claims the instance once, and every
 * later test is about what that left behind.
 * ------------------------------------------------------------------ */

export default defineConfig({
  testDir: "./wizard",
  outputDir: `${artifactsDir}/test-results`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalSetup: "./wizard-setup.ts",
  globalTeardown: "./global-teardown.ts",
  reporter: [["list"], ["html", { outputFolder: `${artifactsDir}/report`, open: "never" }]],
  use: {
    baseURL: webUrl,
    actionTimeout: 25_000,
    navigationTimeout: 120_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...devices["Desktop Chrome"],
  },
});
