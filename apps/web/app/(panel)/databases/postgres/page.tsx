"use client";

import { DatabaseSection } from "@/components/DatabaseSection";

/*
 * PostgreSQL has its own permission set so a role can hold one engine
 * without the other, but the screen is the same one MySQL renders.
 */
export default function PostgresPage() {
  return <DatabaseSection engine="postgres" />;
}
