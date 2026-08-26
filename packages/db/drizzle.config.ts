import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "pglite://./.data/kaname";
const isPglite = url.startsWith("pglite://") || url.startsWith("file://");

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(isPglite
    ? { driver: "pglite" as const, dbCredentials: { url: url.replace(/^(pglite|file):\/\//, "") } }
    : { dbCredentials: { url } }),
  strict: true,
  verbose: true,
});
