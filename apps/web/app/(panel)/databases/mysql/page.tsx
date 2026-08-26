"use client";

import { DatabaseSection } from "@/components/DatabaseSection";

/*
 * MySQL and MariaDB are one page and one permission set. Both engines
 * render from the shared section so this leaf and the PostgreSQL leaf
 * cannot drift apart.
 */
export default function MysqlPage() {
  return <DatabaseSection engine="mysql" />;
}
