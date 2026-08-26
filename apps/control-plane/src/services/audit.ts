import { asc, desc, eq, sql, type Database } from "@kaname/db";
import { auditEvents } from "@kaname/db/schema";
import type { AuditActorType } from "@kaname/contract";
import { AUDIT_GENESIS, auditHash, redact } from "../lib/crypto.js";

/* ------------------------------------------------------------------ *
 * Audit (KD-009).
 *
 * Append-only and hash-chained. Every mutation from every surface —
 * UI session, API key, terminal, agent-pushed event — lands here.
 * The chain makes selective deletion detectable; the DB rules make it
 * hard in the first place.
 * ------------------------------------------------------------------ */

export interface Actor {
  type: AuditActorType;
  id: string | null;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditInput {
  actor: Actor;
  /** Dotted verb, e.g. "service.restart" or "user.role.granted". */
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string;
  serverId?: string | null;
  metadata?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  jobId?: string | null;
}

export class AuditService {
  /**
   * Serialised because the chain is inherently sequential: two
   * concurrent writes reading the same tip would fork it. At the write
   * volume of a server panel this queue is never the bottleneck.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database) {}

  record(input: AuditInput): Promise<string> {
    const run = this.tail.then(() => this.write(input));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async write(input: AuditInput): Promise<string> {
    const prev = await this.db
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1);

    const prevHash = prev[0]?.hash ?? AUDIT_GENESIS;
    const ts = new Date();

    const diff =
      input.before !== undefined || input.after !== undefined
        ? { before: redact(input.before ?? null), after: redact(input.after ?? null) }
        : null;

    const payload = {
      ts: ts.toISOString(),
      actor_type: input.actor.type,
      actor_id: input.actor.id,
      actor_name: input.actor.name,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      target_label: input.targetLabel ?? "",
      server_id: input.serverId ?? null,
      ip: input.actor.ip ?? null,
      metadata: redact(input.metadata ?? {}),
      diff,
      job_id: input.jobId ?? null,
    };

    const hash = auditHash(prevHash, payload);

    const [row] = await this.db
      .insert(auditEvents)
      .values({
        ts,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorName: input.actor.name,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? "",
        serverId: input.serverId ?? null,
        ip: input.actor.ip ?? null,
        userAgent: input.actor.userAgent ?? null,
        metadata: payload.metadata as Record<string, unknown>,
        diff,
        jobId: input.jobId ?? null,
        prevHash,
        hash,
      })
      .returning({ id: auditEvents.id });

    return row!.id;
  }

  /**
   * Walks the chain from the genesis hash. Returns the first row whose
   * recomputed hash does not match, which is the point of tampering.
   */
  async verify(limit = 100_000): Promise<{
    verified: boolean;
    eventsChecked: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    brokenAt: string | null;
    checkedAt: string;
  }> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .orderBy(asc(auditEvents.seq))
      .limit(limit);

    let prevHash = AUDIT_GENESIS;
    let brokenAt: string | null = null;

    for (const row of rows) {
      const payload = {
        ts: row.ts.toISOString(),
        actor_type: row.actorType,
        actor_id: row.actorId,
        actor_name: row.actorName,
        action: row.action,
        target_type: row.targetType,
        target_id: row.targetId,
        target_label: row.targetLabel,
        server_id: row.serverId,
        ip: row.ip,
        metadata: row.metadata,
        diff: row.diff ?? null,
        job_id: row.jobId,
      };
      if (row.prevHash !== prevHash || auditHash(prevHash, payload) !== row.hash) {
        brokenAt = row.id;
        break;
      }
      prevHash = row.hash;
    }

    return {
      verified: brokenAt === null,
      eventsChecked: rows.length,
      firstEventAt: rows[0]?.ts.toISOString() ?? null,
      lastEventAt: rows[rows.length - 1]?.ts.toISOString() ?? null,
      brokenAt,
      checkedAt: new Date().toISOString(),
    };
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(auditEvents);
    return row?.n ?? 0;
  }
}
