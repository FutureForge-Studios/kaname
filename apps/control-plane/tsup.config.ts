import { defineConfig } from "tsup";

/**
 * Bundled rather than emitted file-by-file so the runtime image needs no
 * workspace symlinks and no TypeScript toolchain (KD-016). Native and
 * WASM-backed dependencies stay external because they cannot be bundled.
 */
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  external: ["@node-rs/argon2", "@electric-sql/pglite", "pg", "pino", "pino-pretty", "nodemailer"],
  noExternal: [/^@kaname\//],
  banner: {
    js: "import { createRequire as __kanameCreateRequire } from 'node:module'; const require = __kanameCreateRequire(import.meta.url);",
  },
});
