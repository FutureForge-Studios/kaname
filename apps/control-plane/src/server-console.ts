import { join } from "node:path";
import { eq } from "@kaname/db";
import { updateRuns } from "@kaname/db/schema";
import { compareVersions } from "@kaname/contract";
import { ApiException } from "./lib/errors.js";
import type { AppContext } from "./context.js";
import { HOST_ACTOR_NAME } from "./services/updates.js";

/* ------------------------------------------------------------------ *
 * The server console.
 *
 * What `sudo kaname update` on the host asks the running control plane
 * to do, through `docker compose exec` rather than over HTTP: root on
 * the host is the authority, so there is no endpoint, no token and
 * nothing new listening. It calls the same apply the Updates page calls
 * — the same in-flight lock, the same refusals, the same run row and
 * snapshot — and answers with one line of JSON and an exit status the
 * host script branches on.
 * ------------------------------------------------------------------ */

/** Exit statuses, shared with infra/kaname.sh. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** Needs confirmation, a step-through release, or a backup. */
  refused: 3,
  /** Another update is in flight. */
  busy: 4,
} as const;

export interface ConsoleResult {
  exitCode: number;
  /** Printed as one line of JSON on stdout. */
  output: Record<string, unknown>;
}

const ACTOR = { type: "system" as const, id: null, name: HOST_ACTOR_NAME };

/**
 * Starts a control-plane update and resolves once it has been handed to
 * the host, or has failed before it could be.
 */
export async function consoleUpdate(
  ctx: AppContext,
  input: { toVersion: string; confirmBreaking: boolean; skipBackupCheck: boolean },
): Promise<ConsoleResult> {
  let runId: string;
  try {
    const run = await ctx.updates.applyControlPlane({
      toVersion: input.toVersion,
      confirmBreaking: input.confirmBreaking,
      skipBackupCheck: input.skipBackupCheck,
      trigger: "manual",
      actor: { id: null, name: HOST_ACTOR_NAME },
    });
    runId = run.id;

    // The same entry the Updates page writes, by the console instead of a user.
    await ctx.audit.record({
      actor: ACTOR,
      action: "update.control_plane_started",
      targetType: "update_run",
      targetId: run.id,
      targetLabel: run.to_version,
      metadata: {
        from: run.from_version,
        to: run.to_version,
        confirmed_breaking: input.confirmBreaking,
        skipped_backup_check: input.skipBackupCheck,
        via: HOST_ACTOR_NAME,
      },
    });
  } catch (err) {
    return refusal(ctx, input.toVersion, err);
  }

  await ctx.updates.handover(runId);

  const run = await readRun(ctx, runId);
  if (!run || run.status !== "running") {
    return {
      exitCode: EXIT.error,
      output: {
        ok: false,
        code: "failed",
        run_id: runId,
        status: run?.status ?? "missing",
        message: run?.error ?? "The update ended before it reached the host.",
      },
    };
  }

  const logFile = join(ctx.config.dataDir, "updates", `${runId}.log`);
  return {
    exitCode: EXIT.ok,
    output: {
      ok: true,
      code: "handed_over",
      run_id: runId,
      from_version: run.fromVersion,
      to_version: run.toVersion,
      log_file: logFile,
      result_file: join(ctx.config.dataDir, "updates", `${runId}.result`),
    },
  };
}

/** Where a run stands, for a command that lost sight of the host's files. */
export async function consoleStatus(ctx: AppContext, runId: string): Promise<ConsoleResult> {
  const run = /^[0-9a-f-]{36}$/i.test(runId) ? await readRun(ctx, runId) : null;
  if (!run) {
    return {
      exitCode: EXIT.error,
      output: { ok: false, code: "not_found", message: `No update run ${runId}.` },
    };
  }
  return {
    exitCode: EXIT.ok,
    output: {
      ok: true,
      run_id: run.id,
      status: run.status,
      from_version: run.fromVersion,
      to_version: run.toVersion,
      error: run.error,
    },
  };
}

function refusal(ctx: AppContext, toVersion: string, err: unknown): ConsoleResult {
  if (!(err instanceof ApiException)) {
    return {
      exitCode: EXIT.error,
      output: {
        ok: false,
        code: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const detail = {
    message: err.message,
    ...(err.remediation?.summary ? { remediation: err.remediation.summary } : {}),
  };

  switch (err.code) {
    case "conflict":
      // The apply says "already running" and "already in progress" with
      // the same code; only one of them is a reason to stop and wait.
      if (compareVersions(ctx.updates.currentVersion, toVersion) >= 0) {
        return { exitCode: EXIT.ok, output: { ok: true, code: "up_to_date", ...detail } };
      }
      return { exitCode: EXIT.busy, output: { ok: false, code: "busy", ...detail } };
    case "precondition_failed":
      return { exitCode: EXIT.refused, output: { ok: false, code: "refused", ...detail } };
    case "not_found":
      return { exitCode: EXIT.error, output: { ok: false, code: "unknown_release", ...detail } };
    default:
      return { exitCode: EXIT.error, output: { ok: false, code: err.code, ...detail } };
  }
}

async function readRun(ctx: AppContext, runId: string) {
  const [row] = await ctx.db.select().from(updateRuns).where(eq(updateRuns.id, runId)).limit(1);
  return row ?? null;
}
