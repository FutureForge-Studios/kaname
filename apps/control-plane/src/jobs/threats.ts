import { and, eq, inArray, sql } from "@kaname/db";
import { ipBlocks, jobs, threatEvents } from "@kaname/db/schema";
import { JOB_SPECS, type ThreatDisposition } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError } from "../agent/hub.js";
import type { JobContext, JobHandler } from "./worker.js";

/* ------------------------------------------------------------------ *
 * fw.ban / fw.unban, and what they do to a threat's disposition.
 *
 * The route marks every matching threat row "pending" before the job is
 * queued and records, in the job's params, what each row said before.
 * The handler is then the only thing that decides the outcome: the
 * disposition becomes "banned" (or "observed") once the host has done
 * it, and goes back to what it was — with the host's reason — when the
 * host refuses. Before this the route wrote "banned" up front, so a
 * queued ban already read as done and a failed one never stopped
 * claiming it.
 * ------------------------------------------------------------------ */

/** What one threat row said before its ban or unban was requested. */
export interface DispositionRevert {
  id: string;
  disposition: ThreatDisposition;
}

export interface BanJobParams {
  target: string;
  duration_seconds: number;
  reason?: string;
  /** Control-plane bookkeeping only; never sent to the agent. */
  revert?: DispositionRevert[];
}

export interface UnbanJobParams {
  target: string;
  revert?: DispositionRevert[];
}

/** A range marks every observed address inside it; a /32 or /128 is one address. */
function coveredBy(cidr: string) {
  return sql`${threatEvents.sourceIp} <<= ${cidr}::inet`;
}

/**
 * Whether this failure is the end of the job. An offline agent is a wait
 * (KD-008), a worker shutting down hands the job back, and a transient
 * error on an idempotent job is retried — in all three the request is
 * still outstanding, so the row stays "pending". This mirrors the
 * worker's own retry decision rather than sharing it, because the
 * worker only decides after the handler has returned.
 */
function isFinalFailure(ctx: JobContext, err: unknown): boolean {
  if (err instanceof AgentOfflineError) return false;
  if (ctx.signal.aborted) return false;
  const code = err instanceof AgentRpcError ? err.agentError.code : "internal_error";
  const transient = code === "timeout" || code === "cancelled";
  const spec = JOB_SPECS[ctx.job.type];
  return !(spec.idempotent && ctx.job.attempt < ctx.job.maxAttempts && transient);
}

function failureMessage(err: unknown): string {
  if (err instanceof AgentRpcError) return err.agentError.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs the host call and settles the dispositions it was holding. Only
 * rows still "pending" are put back on failure, so a newer request for
 * the same address that has since landed is not undone by this one.
 */
async function settle<T>(
  ctx: JobContext,
  serverId: string,
  target: string,
  outcome: ThreatDisposition,
  revert: DispositionRevert[],
  work: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await work();
  } catch (err) {
    if (isFinalFailure(ctx, err)) {
      const message = failureMessage(err);
      const now = new Date();
      for (const row of revert) {
        await ctx.db
          .update(threatEvents)
          .set({ disposition: row.disposition, dispositionError: message, updatedAt: now })
          .where(and(eq(threatEvents.id, row.id), eq(threatEvents.disposition, "pending")));
      }
      ctx.events.publish(
        "threats",
        "ip.disposition_failed",
        { server_id: serverId, cidr: target, error: message },
        serverId,
      );
    }
    throw err;
  }

  await ctx.db
    .update(threatEvents)
    .set({ disposition: outcome, dispositionError: null, updatedAt: new Date() })
    .where(and(eq(threatEvents.serverId, serverId), coveredBy(target)));
  return result;
}

export const banHandler: JobHandler = async (ctx) => {
  const serverId = ctx.job.serverId;
  if (!serverId) throw new Error("fw.ban requires a server");
  const { revert = [], ...p } = ctx.job.params as unknown as BanJobParams;

  const result = await settle(ctx, serverId, p.target, "banned", revert, () =>
    ctx.hub.call(
      serverId,
      "fw.ban",
      { target: p.target, duration_seconds: p.duration_seconds, reason: p.reason },
      { signal: ctx.signal },
    ),
  );

  // Re-banning an address replaces its reason and expiry: the Bans list
  // must show the ban the host now holds, not the first one ever made.
  const expiresAt = p.duration_seconds ? new Date(Date.now() + p.duration_seconds * 1000) : null;
  await ctx.db
    .insert(ipBlocks)
    .values({
      serverId,
      cidr: p.target,
      reason: p.reason ?? "",
      source: "manual",
      expiresAt,
      createdBy: ctx.job.createdBy,
    })
    .onConflictDoUpdate({
      target: [ipBlocks.serverId, ipBlocks.cidr],
      set: { reason: p.reason ?? "", expiresAt, createdBy: ctx.job.createdBy },
    });
  ctx.events.publish("threats", "ip.banned", { server_id: serverId, cidr: p.target }, serverId);
  return result;
};

export const unbanHandler: JobHandler = async (ctx) => {
  const serverId = ctx.job.serverId;
  if (!serverId) throw new Error("fw.unban requires a server");
  const { revert = [], ...p } = ctx.job.params as unknown as UnbanJobParams;

  const result = await settle(ctx, serverId, p.target, "observed", revert, () =>
    ctx.hub.call(serverId, "fw.unban", { target: p.target }, { signal: ctx.signal }),
  );
  await ctx.db
    .delete(ipBlocks)
    .where(and(eq(ipBlocks.serverId, serverId), eq(ipBlocks.cidr, p.target)));
  ctx.events.publish("threats", "ip.unbanned", { server_id: serverId, cidr: p.target }, serverId);
  return result;
};

/**
 * Marks the rows a ban or unban will touch as "pending" and returns what
 * they said before, for the job to put back if the host refuses. A row
 * already pending belongs to a request still in flight, which carries
 * its own record of the earlier state, so it is left out here.
 */
export async function markPending(
  db: JobContext["db"],
  serverId: string,
  cidr: string,
): Promise<DispositionRevert[]> {
  const rows = await db
    .select({ id: threatEvents.id, disposition: threatEvents.disposition })
    .from(threatEvents)
    .where(and(eq(threatEvents.serverId, serverId), coveredBy(cidr)));
  const revert = rows.filter((row) => row.disposition !== "pending");
  if (revert.length > 0) {
    await db
      .update(threatEvents)
      .set({ disposition: "pending", updatedAt: new Date() })
      .where(
        inArray(
          threatEvents.id,
          revert.map((row) => row.id),
        ),
      );
  }
  return revert;
}

/** Puts rows back when the job that would have settled them was never queued. */
export async function restorePending(
  db: JobContext["db"],
  revert: DispositionRevert[],
): Promise<void> {
  for (const row of revert) {
    await db
      .update(threatEvents)
      .set({ disposition: row.disposition })
      .where(and(eq(threatEvents.id, row.id), eq(threatEvents.disposition, "pending")));
  }
}

/**
 * Settles the rows held by ban and unban jobs that ended without their
 * handler deciding: a lease that lapsed with its worker, a job that
 * expired waiting for an offline agent, or one an operator cancelled.
 * The handler treats those as "still outstanding", so without this the
 * rows would read "pending" for ever. Only rows still pending are put
 * back, so a later request that has since settled them is left alone.
 */
export async function releaseAbandoned(
  db: JobContext["db"],
  ended: ReadonlyArray<{ id: string; reason: string }>,
): Promise<void> {
  if (ended.length === 0) return;
  const rows = await db
    .select({ id: jobs.id, type: jobs.type, params: jobs.params })
    .from(jobs)
    .where(
      and(
        inArray(
          jobs.id,
          ended.map((e) => e.id),
        ),
        inArray(jobs.type, ["fw.ban", "fw.unban"]),
      ),
    );
  const now = new Date();
  for (const job of rows) {
    const revert = (job.params as { revert?: DispositionRevert[] } | null)?.revert ?? [];
    const reason = ended.find((e) => e.id === job.id)?.reason ?? "the request did not complete";
    for (const row of revert) {
      await db
        .update(threatEvents)
        .set({ disposition: row.disposition, dispositionError: reason, updatedAt: now })
        .where(and(eq(threatEvents.id, row.id), eq(threatEvents.disposition, "pending")));
    }
  }
}
