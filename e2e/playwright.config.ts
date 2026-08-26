import { defineConfig, devices } from "@playwright/test";
import { artifactsDir, authStatePath, webUrl } from "./support/config.js";

/* ------------------------------------------------------------------ *
 * Phase 5: end-to-end over the simulated fleet.
 *
 * One worker and no parallelism, deliberately. These tests restart real
 * units on real (simulated) hosts and read the result back out of the
 * control plane's cache; two of them running at once would be testing
 * each other. The suite is small and the stack is shared, so serial is
 * both correct and barely slower.
 *
 * `signin` runs first and leaves a session behind for everything else.
 * It is a real test, not a fixture: signing in and landing on a Command
 * Center with a live fleet on it is the first journey worth covering.
 * ------------------------------------------------------------------ */

export default defineConfig({
  testDir: "./tests",
  outputDir: `${artifactsDir}/test-results`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  reporter: [["list"], ["html", { outputFolder: `${artifactsDir}/report`, open: "never" }]],

  use: {
    baseURL: webUrl,
    actionTimeout: 25_000,
    navigationTimeout: 120_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "signin",
      testMatch: /sign-in\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "panel",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["signin"],
      use: { ...devices["Desktop Chrome"], storageState: authStatePath },
    },
  ],
});
