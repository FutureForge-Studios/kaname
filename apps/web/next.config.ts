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

  /* Both packages ship TypeScript source rather than a build artefact. */
  transpilePackages: ["@kaname/ui", "@kaname/contract"],

  poweredByHeader: false,

  experimental: {
    /* GET /api/v1/events is an SSE feed that stays open for hours. */
    proxyTimeout: 24 * 60 * 60 * 1000,
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
