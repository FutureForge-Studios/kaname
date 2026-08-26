#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One command that proves the tree is green.
 *
 *   pnpm verify
 *
 * Runs, in order: the contract manifest emit (so the Go conformance
 * test compares against current schemas), typecheck for every TS
 * package, the Go build and tests, then every test suite. Prints a
 * summary rather than a wall of output, and exits non-zero on the first
 * category that fails.
 * ------------------------------------------------------------------ */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

const steps = [
  { name: "contract manifest", cwd: "packages/contract", cmd: bin("tsx"), args: ["scripts/emit-agent-manifest.ts"] },
  { name: "typecheck contract", cwd: "packages/contract", cmd: bin("tsc"), args: ["--noEmit"] },
  { name: "typecheck db", cwd: "packages/db", cmd: bin("tsc"), args: ["--noEmit"] },
  { name: "typecheck ui", cwd: "packages/ui", cmd: bin("tsc"), args: ["--noEmit"] },
  { name: "typecheck control-plane", cwd: "apps/control-plane", cmd: bin("tsc"), args: ["--noEmit"] },
  { name: "typecheck web", cwd: "apps/web", cmd: bin("tsc"), args: ["--noEmit"], optional: () => !existsSync(join(root, "apps/web/tsconfig.json")) },
  { name: "go vet", cwd: "agent", cmd: "go", args: ["vet", "./..."] },
  { name: "go build", cwd: "agent", cmd: "go", args: ["build", "./..."] },
  { name: "go build (linux/amd64)", cwd: "agent", cmd: "go", args: ["build", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "./cmd/kanamed"], env: { GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" } },
  { name: "test contract", cwd: "packages/contract", cmd: bin("vitest"), args: ["run"] },
  { name: "test ui", cwd: "packages/ui", cmd: bin("vitest"), args: ["run"] },
  { name: "test control-plane", cwd: "apps/control-plane", cmd: bin("vitest"), args: ["run"] },
  { name: "test agent", cwd: "agent", cmd: "go", args: ["test", "./..."] },
];

let failed = 0;
for (const step of steps) {
  if (step.optional?.()) {
    console.log(`  skip   ${step.name}`);
    continue;
  }
  const started = process.hrtime.bigint();
  const result = spawnSync(step.cmd, step.args, {
    cwd: join(root, step.cwd),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, ...step.env },
  });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);

  if (result.status === 0) {
    console.log(`  ok     ${step.name} ${dim(`${ms}ms`)}`);
  } else {
    failed += 1;
    console.log(`  FAIL   ${step.name} ${dim(`${ms}ms`)}`);
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    for (const line of output.split("\n").slice(-25)) console.log(`         ${line}`);
    break;
  }
}

console.log();
console.log(failed === 0 ? "everything green" : "verification failed");
process.exit(failed === 0 ? 0 : 1);

function dim(text) {
  return process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text;
}
