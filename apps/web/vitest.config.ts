import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the panel's plumbing (the SSE client, the query-key
 * routing) run in jsdom, the same way the component kit's do. Pages
 * are covered end to end by Playwright instead.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.ts"],
    restoreMocks: true,
  },
});
