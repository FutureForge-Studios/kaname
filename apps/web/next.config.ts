import { join } from "node:path";
import type { NextConfig } from "next";

/* ------------------------------------------------------------------ *
 * The browser must see exactly one origin (KD-011).
 *
 * Next and the control plane are separate processes, so everything the
 * page calls — /api/v1 and the agent distribution endpoints — is
 * rewritten to the control plane rather than fetched cross-origin. A
 * plain session cookie then works with no CORS, no token relay and no
 * BFF layer. In production the reverse proxy does the same thing, so
 * dev and prod agree on what the browser sees.
 * ------------------------------------------------------------------ */

const CONTROL_PLANE = process.env.KANAME_CONTROL_PLANE_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /*
   * Overridable so an e2e stack can build and serve its own copy beside a
   * running `next dev` (and beside other e2e stacks) without the two
   * overwriting each other's output.
   */
  distDir: process.env.KANAME_NEXT_DIST_DIR ?? ".next",

  /*
   * `next build` rewrites the tsconfig it type-checks with, adding its
   * distDir's generated types. A per-stack build points this at a
   * throwaway, gitignored copy so tsconfig.json itself is never touched.
   */
  typescript: { tsconfigPath: process.env.KANAME_NEXT_TSCONFIG ?? "tsconfig.json" },

  /*
   * The runtime image copies `.next/standalone` and runs it directly, so
   * it carries no pnpm store and no workspace symlinks. Next has to be
   * told to emit it, and — in a workspace — told where the root is, or
   * it traces from apps/web and leaves the shared packages behind.
   */
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),

  /* Both packages ship TypeScript source rather than a build artefact. */
  transpilePackages: ["@kaname/ui", "@kaname/contract"],

  poweredByHeader: false,

  experimental: {
    /* GET /api/v1/events is an SSE feed that stays open for hours. */
    proxyTimeout: 24 * 60 * 60 * 1000,
    /*
     * Because middleware.ts exists, Next tees every request body through
     * a clone capped at 10 MB by default — including the /api rewrite.
     * A file upload past that was cut off mid-stream ("Premature close"
     * on the control plane, a progress bar stuck at 100% in the panel).
     * Match the control plane's own multipart limit (server.ts) so the
     * rewrite never truncates what the API would have accepted. In
     * production Caddy sends /api straight to the control plane.
     */
    middlewareClientMaxBodySize: "2gb",
  },

  /*
   * The workspace packages are ESM-correct TypeScript: `./enums.js`
   * resolving to `./enums.ts`. Node, tsx, vitest and esbuild all do that
   * already; webpack needs to be told. Cheaper than degrading the
   * source to extensionless imports (see KD-016 for where we did).
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  },

  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${CONTROL_PLANE}/api/:path*` },
      { source: "/agent/:path*", destination: `${CONTROL_PLANE}/agent/:path*` },
      { source: "/install.sh", destination: `${CONTROL_PLANE}/install.sh` },
    ];
  },
};

export default nextConfig;
