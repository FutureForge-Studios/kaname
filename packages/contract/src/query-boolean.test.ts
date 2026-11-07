import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  apiKeyListQuery,
  backupScheduleListQuery,
  browseQuery,
  dbUserListQuery,
  firewallRuleListQuery,
  ftpAccountListQuery,
  ipBlockListQuery,
  logQuery,
  queryBoolean,
  restorePointListQuery,
  roleListQuery,
  storageQuery,
  userListQuery,
} from "./index.js";

/* ------------------------------------------------------------------ *
 * Query-string booleans.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so `?follow=false` arrived
 * as true and every "false" filter returned exactly the rows it meant to
 * exclude. These pin each formerly coerced field to queryBoolean, and a
 * source scan keeps the coercion from coming back.
 * ------------------------------------------------------------------ */

const SERVER = "11111111-1111-4111-8111-111111111111";

const FIELDS: Array<[string, ZodTypeAny, string, Record<string, unknown>]> = [
  ["logQuery", logQuery, "follow", { server_id: SERVER }],
  ["userListQuery", userListQuery, "totp_enabled", {}],
  ["roleListQuery", roleListQuery, "is_system", {}],
  ["apiKeyListQuery", apiKeyListQuery, "revoked", {}],
  ["backupScheduleListQuery", backupScheduleListQuery, "enabled", {}],
  ["restorePointListQuery", restorePointListQuery, "verified", {}],
  ["dbUserListQuery", dbUserListQuery, "can_login", {}],
  ["browseQuery", browseQuery, "show_hidden", { server_id: SERVER }],
  ["ftpAccountListQuery", ftpAccountListQuery, "over_quota", {}],
  ["storageQuery", storageQuery, "refresh", { server_id: SERVER }],
  ["firewallRuleListQuery", firewallRuleListQuery, "enabled", {}],
  ["ipBlockListQuery", ipBlockListQuery, "include_expired", {}],
];

describe("queryBoolean", () => {
  it("reads the two spellings a URL carries, and nothing else", () => {
    expect(queryBoolean.parse("true")).toBe(true);
    expect(queryBoolean.parse("false")).toBe(false);
    expect(queryBoolean.parse(true)).toBe(true);
    expect(queryBoolean.parse(false)).toBe(false);
    expect(queryBoolean.safeParse("yes").success).toBe(false);
    expect(queryBoolean.safeParse("").success).toBe(false);
  });

  it.each(FIELDS)("%s.%s reads 'false' as false", (_name, schema, field, base) => {
    expect(schema.parse({ ...base, [field]: "false" })[field]).toBe(false);
    expect(schema.parse({ ...base, [field]: "true" })[field]).toBe(true);
  });

  it("is used for every boolean in the contract; z.coerce.boolean() is gone", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, index) => {
              // Comments may name it to explain why it is not used.
              if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
              if (line.includes("z.coerce.boolean(")) offenders.push(`${path}:${index + 1}`);
            });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
