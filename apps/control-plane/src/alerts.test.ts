import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, sql, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { alertRules, alerts, serverMetrics, servers } from "@kaname/db/schema";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { bootstrap } from "./bootstrap.js";
import { AlertEvaluator } from "./services/alerts.js";
import type { StreamEvent } from "./services/events.js";

/* ------------------------------------------------------------------ *
 * Alert rules fire on a sustained breach, not a spike, and resolve
 * when the latest sample is back inside the line.
 * ------------------------------------------------------------------ */

let handle: DbHandle;
let ctx: AppContext;
let serverId: string;
let evaluator: AlertEvaluator;
const seen: StreamEvent[] = [];

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-alerts-test-owner",
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);
  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);
  ctx.events.on("alerts", (event) => seen.push(event));
  evaluator = new AlertEvaluator(ctx);

  const [server] = await handle.db
    .insert(servers)
    .values({
      name: "hot-01",
      hostname: "hot-01.example.com",
      connection: "connected",
      enrolledAt: new Date(),
    })
    .returning({ id: servers.id });
  serverId = server!.id;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

/** One sample per 15 s going back `seconds`, all at the same CPU figure. */
async function samples(cpu: number, seconds: number, endOffsetS = 0) {
  for (let back = endOffsetS; back <= seconds; back += 15) {
    await handle.db.insert(serverMetrics).values({
      serverId,
      ts: new Date(Date.now() - back * 1000),
      cpuPercent: cpu,
      memoryUsed: 1,
      memoryTotal: 2,
      swapUsed: 0,
      swapTotal: 0,
      load1: 0.1,
      load5: 0.1,
      load15: 0.1,
      processes: 10,
      netRxRate: 0,
      netTxRate: 0,
      netRxBytes: 0,
      netTxBytes: 0,
      disks: [],
    });
  }
}

async function openAlerts() {
  return handle.db
    .select()
    .from(alerts)
    .where(sql`${alerts.resolvedAt} is null`);
}

describe("alert evaluator", () => {
  it("fires after a sustained breach, then resolves, and tells the bus both times", async () => {
    const [rule] = await handle.db
      .insert(alertRules)
      .values({
        name: "CPU pegged",
        metric: "cpu",
        comparator: "gt",
        threshold: 90,
        durationSeconds: 120,
        severity: "critical",
        scope: { kind: "fleet" },
        enabled: true,
        channels: [],
      })
      .returning({ id: alertRules.id });

    // Only a recent spike: over the line now, but not for the window.
    await samples(95, 30);
    await evaluator.evaluate();
    let open = await openAlerts();
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe("pending");
    expect(seen.filter((e) => e.type === "alert.firing")).toHaveLength(0);

    // The whole window is hot.
    await samples(95, 180, 45);
    await evaluator.evaluate();
    open = await openAlerts();
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe("firing");
    expect(open[0]!.value).toBeCloseTo(95, 1);
    const firing = seen.filter((e) => e.type === "alert.firing");
    expect(firing).toHaveLength(1);
    const payload = firing[0]!.data as { rule_name: string; server_name: string; message: string };
    expect(payload.rule_name).toBe("CPU pegged");
    expect(payload.server_name).toBe("hot-01");
    expect(payload.message).toContain("CPU 95.0% > 90.0% for 120s");

    // A second pass with nothing changed does not fire twice.
    await evaluator.evaluate();
    expect(seen.filter((e) => e.type === "alert.firing")).toHaveLength(1);

    // Back under the line: resolved once, with the recovery on the bus.
    await samples(12, 0);
    await evaluator.evaluate();
    expect(await openAlerts()).toHaveLength(0);
    const [resolved] = await handle.db.select().from(alerts).where(eq(alerts.ruleId, rule!.id));
    expect(resolved!.state).toBe("resolved");
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(seen.filter((e) => e.type === "alert.resolved")).toHaveLength(1);
  });

  it("ignores servers outside a rule's scope and rules that are disabled", async () => {
    seen.length = 0;
    await handle.db.delete(alerts);
    await handle.db.delete(alertRules);
    await handle.db.insert(alertRules).values([
      {
        name: "elsewhere",
        metric: "cpu",
        comparator: "gt",
        threshold: 1,
        durationSeconds: 15,
        severity: "warning",
        scope: { kind: "servers", server_ids: ["00000000-0000-0000-0000-000000000000"] },
        enabled: true,
        channels: [],
      },
      {
        name: "switched off",
        metric: "cpu",
        comparator: "gt",
        threshold: 1,
        durationSeconds: 15,
        severity: "warning",
        scope: { kind: "fleet" },
        enabled: false,
        channels: [],
      },
    ]);
    await samples(50, 60);
    await evaluator.evaluate();
    expect(await openAlerts()).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });
});
