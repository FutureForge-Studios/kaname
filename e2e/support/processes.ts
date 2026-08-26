import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logsDir } from "./config.js";

/* ------------------------------------------------------------------ *
 * Child processes.
 *
 * Three rules, all learned the hard way on Windows:
 *
 * 1. Spawn node and the agent binary directly — never through a .cmd
 *    shim — so the pid we hold is the pid that has to die.
 * 2. Kill the whole tree. `child.kill()` on Windows leaves grandchildren
 *    holding port 4100, and the next run then fails for a reason that
 *    has nothing to do with the change under test.
 * 3. Keep every child's output. A stack that fails to boot has to say
 *    why, and "timed out waiting for the control plane" does not.
 * ------------------------------------------------------------------ */

const TAIL_LINES = 40;

export interface Managed {
  readonly name: string;
  readonly pid: number;
  readonly child: ChildProcess;
  /** The last lines this process printed, for a wait that ran out. */
  tail(): string;
}

export interface LaunchOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function launch(
  name: string,
  command: string,
  args: readonly string[],
  options: LaunchOptions,
): Managed {
  mkdirSync(logsDir, { recursive: true });
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // Its own process group, so killTree can take the group down.
    detached: process.platform !== "win32",
  });

  if (!child.pid) throw new Error(`${name}: could not start ${command}`);

  const log = createWriteStream(join(logsDir, `${name}.log`), { flags: "w" });
  const recent: string[] = [];

  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    log.write(text);
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      recent.push(line);
      if (recent.length > TAIL_LINES) recent.shift();
    }
    if (process.env["KANAME_E2E_VERBOSE"]) process.stdout.write(`${name} │ ${text}`);
  };

  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  return { name, pid: child.pid, child, tail: () => recent.join("\n") };
}

/** Runs a command to completion, rejecting with whatever it printed. */
export function run(
  name: string,
  command: string,
  args: readonly string[],
  options: LaunchOptions,
): Promise<void> {
  return new Promise((settle, reject) => {
    const managed = launch(name, command, args, options);
    managed.child.on("error", reject);
    managed.child.on("exit", (code) => {
      if (code === 0) settle();
      else reject(new Error(`${name} exited with ${code}\n${managed.tail()}`));
    });
  });
}

/**
 * Kills a process and everything it started. Never throws: teardown runs
 * after failures, and a pid that has already gone is a success.
 */
export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Printed when the wait runs out, e.g. the child's last output. */
  detail?: () => string;
}

/** Polls `probe` until it is true, or fails with what the wait was for. */
export async function waitUntil(
  what: string,
  probe: () => Promise<boolean>,
  options: WaitOptions,
): Promise<void> {
  const { timeoutMs, intervalMs = 500, detail } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() >= deadline) {
      const extra = detail?.() ?? "";
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}` +
          (extra ? `\n${extra}` : ""),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
