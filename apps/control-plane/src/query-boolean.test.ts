import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ *
 * The control plane's own inline query schemas use queryBoolean too:
 * `z.coerce.boolean()` reads "false" as true (`?overwrite=false`
 * overwrote, `?acknowledged=false` listed the acknowledged alerts).
 * The contract has the same scan for its schemas.
 * ------------------------------------------------------------------ */

describe("query booleans", () => {
  it("never coerce", () => {
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
