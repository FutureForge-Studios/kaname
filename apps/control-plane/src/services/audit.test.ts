import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@kaname/db";
import { createDb, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { auditEvents } from "@kaname/db/schema";
import { AuditService, type Actor } from "./audit.js";

/* ------------------------------------------------------------------ *
 * The audit trail is only worth having if tampering is detectable
 * (KD-009). These tests are the proof of that claim.
 * ------------------------------------------------------------------ */

const ACTOR: Actor = { type: "user", id: null, name: "Test Operator", ip: "203.0.113.9" };

let handle: DbHandle;
let audit: AuditService;

beforeEach(async () => {
  handle = await createDb("pglite://:memory:");
  await migrateHandle(handle);
  audit = new AuditService(handle.db);
});

afterEach(async () => {
  await handle.close();
});

async function writeSome(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await audit.record({
      actor: ACTOR,
      action: "service.restart",
      targetType: "service",
      targetId: `unit-${i}`,
      targetLabel: `nginx-${i}.service`,
      metadata: { attempt: i },
    });
  }
}

describe("audit chain", () => {
  it("chains every event from the genesis hash", async () => {
    await writeSome(5);
    const result = await audit.verify();

    expect(result.verified).toBe(true);
    expect(result.eventsChecked).toBe(5);
    expect(result.brokenAt).toBeNull();
  });

  it("verifies an empty trail", async () => {
    const result = await audit.verify();
    expect(result.verified).toBe(true);
    expect(result.eventsChecked).toBe(0);
    expect(result.firstEventAt).toBeNull();
  });

  it("detects an edited event", async () => {
    await writeSome(4);

    const rows = await handle.db.select().from(auditEvents).orderBy(auditEvents.seq);
    const victim = rows[2]!;

    // The DB rule blocks UPDATE, so simulate an attacker with more access
    // than the application role has.
    await handle.db.execute(sql`drop rule audit_events_no_update on audit_events;`);
    await handle.db.execute(
      sql`update audit_events set action = 'service.stop' where id = ${victim.id};`,
    );

    const result = await audit.verify();
    expect(result.verified).toBe(false);
    expect(result.brokenAt).toBe(victim.id);
  });

  it("detects a removed event", async () => {
    await writeSome(4);
    const rows = await handle.db.select().from(auditEvents).orderBy(auditEvents.seq);

    await handle.db.execute(sql`drop rule audit_events_no_delete on audit_events;`);
    await handle.db.execute(sql`delete from audit_events where id = ${rows[1]!.id};`);

    const result = await audit.verify();
    expect(result.verified).toBe(false);
    // The break shows at the first row whose prev_hash no longer matches.
    expect(result.brokenAt).toBe(rows[2]!.id);
  });

  it("refuses UPDATE and DELETE through the application role", async () => {
    await writeSome(2);
    const before = await handle.db.select().from(auditEvents);

    await handle.db.execute(sql`update audit_events set action = 'tampered';`);
    await handle.db.execute(sql`delete from audit_events;`);

    const after = await handle.db.select().from(auditEvents);
    expect(after).toHaveLength(before.length);
    expect(after.every((r) => r.action === "service.restart")).toBe(true);
  });

  it("redacts secrets out of diffs before they are stored", async () => {
    await audit.record({
      actor: ACTOR,
      action: "mailbox.created",
      targetType: "mailbox",
      targetId: "abc",
      before: null,
      after: { address: "a@example.com", password: "hunter2", quota_bytes: 1024 },
      metadata: { api_key: "kn_live_secret", note: "fine" },
    });

    const [row] = await handle.db.select().from(auditEvents);
    const diff = row!.diff as { after: Record<string, unknown> };
    expect(diff.after.password).toBe("[redacted]");
    expect(diff.after.address).toBe("a@example.com");
    expect((row!.metadata as Record<string, unknown>).api_key).toBe("[redacted]");
    expect((row!.metadata as Record<string, unknown>).note).toBe("fine");
  });

  it("keeps the chain intact under concurrent writers", async () => {
    // Serialisation is the whole reason AuditService queues writes; if it
    // did not, two concurrent records would read the same tip and fork.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        audit.record({
          actor: ACTOR,
          action: "container.restart",
          targetType: "container",
          targetId: String(i),
        }),
      ),
    );

    const result = await audit.verify();
    expect(result.verified).toBe(true);
    expect(result.eventsChecked).toBe(25);
  });
});
