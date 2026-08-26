import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ *
 * Column builders shared by every table.
 *
 * gen_random_uuid() is in core Postgres since 13, so it works
 * identically under PGlite in development and Postgres in production
 * (KD-004) with no extension to install.
 * ------------------------------------------------------------------ */

export const pk = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Every table gets these two, so put them in one place. */
export const timestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};
