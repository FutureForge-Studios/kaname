import { defineConfig } from "vitest/config";

/**
 * Component tests run in jsdom. Every list page in the product is a
 * DataTable and every log surface a LogViewer, so a regression in the
 * kit is a regression in thirty pages at once — these run in `pnpm
 * verify` alongside the contract and control-plane suites.
 *
 * No React plugin: esbuild reads `jsx: "react-jsx"` from tsconfig.json,
 * and fast refresh is meaningless in a test process.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    restoreMocks: true,
  },
});
