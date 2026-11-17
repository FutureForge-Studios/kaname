import { readFileSync } from "node:fs";
import pino from "pino";
import { createDb } from "@kaname/db";
import { releaseManifest, type ReleaseManifest } from "@kaname/contract";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { EXIT, consoleStatus, consoleUpdate, type ConsoleResult } from "./server-console.js";

/* ------------------------------------------------------------------ *
 * dist/cli.js — the server console's entry, run inside the control-plane
 * container by infra/kaname.sh:
 *
 *   docker compose exec -T control-plane node dist/cli.js \
 *     update --to=0.3.0 [--confirm-breaking] [--skip-backup] --actor=host --manifest=- <versions.json
 *   docker compose exec -T control-plane node dist/cli.js status --run=<id>
 *
 * Exactly one line of JSON goes to stdout; diagnostics go to stderr.
 * After `update` hands over it stays and follows the host helper, the
 * way the panel's own process does, so a pull that fails (nothing is
 * restarted, so nothing else would notice) still ends the run. The
 * restart that replaces this container ends this process with it, and
 * the build that boots next takes the run over.
 * ------------------------------------------------------------------ */

const USAGE = `usage: node dist/cli.js update --to=<version> [--confirm-breaking] [--skip-backup]
                              [--actor=host] [--manifest=-|<file>] [--no-follow]
       node dist/cli.js status --run=<id>`;

interface Args {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (const arg of rest) {
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq === -1) flags.set(arg.slice(2), true);
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return { command, flags };
}

function emit(result: ConsoleResult): void {
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
}

function usage(message: string): never {
  emit({ exitCode: EXIT.usage, output: { ok: false, code: "usage", message } });
  process.stderr.write(`${USAGE}\n`);
  process.exit(EXIT.usage);
}

function readManifest(source: string): ReleaseManifest {
  const text = readFileSync(source === "-" ? 0 : source, "utf8");
  const parsed = releaseManifest.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error("the release manifest is not in a shape this version understands");
  return parsed.data;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    usage((err as Error).message);
  }
  const { command, flags } = args;
  if (command !== "update" && command !== "status")
    usage(`unknown command: ${command || "(none)"}`);

  const actor = flags.get("actor");
  if (actor !== undefined && actor !== "host") usage(`unknown actor: ${String(actor)}`);

  let manifest: ReleaseManifest | undefined;
  const manifestSource = flags.get("manifest");
  if (typeof manifestSource === "string") {
    try {
      manifest = readManifest(manifestSource);
    } catch (err) {
      usage(`could not read the manifest: ${(err as Error).message}`);
    }
  }

  const config = loadConfig();
  const log = pino({ level: "warn" }, pino.destination(2));
  const dbHandle = await createDb(config.DATABASE_URL);
  const ctx = createContext({ config, log, dbHandle }, manifest ? { manifest } : {});

  let result: ConsoleResult;
  if (command === "status") {
    const run = flags.get("run");
    if (typeof run !== "string" || !run) usage("status needs --run=<id>");
    result = await consoleStatus(ctx, run);
    emit(result);
  } else {
    const to = flags.get("to");
    if (typeof to !== "string" || !to) usage("update needs --to=<version>");
    result = await consoleUpdate(ctx, {
      toVersion: to,
      confirmBreaking: flags.get("confirm-breaking") === true,
      skipBackupCheck: flags.get("skip-backup") === true,
    });
    emit(result);

    // Follow until the run is settled here or the restart ends this
    // process. Polled by the service's own timer; this only keeps the
    // process alive while it has something to watch.
    if (result.output.code === "handed_over" && !flags.has("no-follow")) {
      while (ctx.updates.following()) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  ctx.updates.stop();
  await dbHandle.close();
  process.exit(result.exitCode);
}

main().catch((err) => {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: "error", message: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(EXIT.error);
});
