import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { and, createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { ipBlocks, servers, threatEvents } from "@kaname/db/schema";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { banHandler, markPending, unbanHandler } from "./jobs/threats.js";
import type { JobContext, JobHandler } from "./jobs/worker.js";

/* ------------------------------------------------------------------ *
 * A ban's disposition follows its job.
 *
 * "pending" from the moment it is asked for, "banned" only once the host
 * has done it, and back to what it was — with the host's reason — when
 * the host refuses. A wait (agent offline) or a retry keeps it pending,
 * because the request is still outstanding.
 * ------------------------------------------------------------------ */

type Answer = (params: Record<string, unknown>) => unknown;

class FakeHub {
  readonly connected = new Set<string>();
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  answer: Answer = () => ({ ok: true });

  isConnected(serverId: string): boolean {
    return this.connected.has(serverId);
  }

  connectedServerIds(): string[] {
    return [...this.connected];
  }

  async call(serverId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected.has(serverId)) throw new AgentOfflineError(serverId);
    this.calls.push({ method, params });
    return this.answer(params);
  }

  as(): AgentHub {
    return this as unknown as AgentHub;
  }
}

let handle: DbHandle;
let ctx: AppContext;
let hub: FakeHub;
let serverId: string;

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: "kaname-integration-test-password",
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);
  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await seedDemo(handle.db);

  const [server] = await handle.db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.name, "forge-01"));
  serverId = server!.id;
  hub = new FakeHub();
  hub.connected.add(serverId);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

/** A threat row of our own, so no seeded row's state leaks between cases. */
async function threat(ip: string, disposition: "observed" | "ignored" = "observed"): Promise<string> {
  const [row] = await handle.db
    .insert(threatEvents)
    .values({ serverId, kind: "ssh_bruteforce", sourceIp: ip, target: "sshd", disposition })
    .returning({ id: threatEvents.id });
  return row!.id;
}

async function state(id: string): Promise<{ disposition: string; error: string | null }> {
  const [row] = await handle.db
    .select({ disposition: threatEvents.disposition, error: threatEvents.dispositionError })
    .from(threatEvents)
    .where(eq(threatEvents.id, id));
  return { disposition: row!.disposition, error: row!.error };
}

/** What the route does: mark pending, then queue the job carrying the revert list. */
async function request(
  type: "fw.ban" | "fw.unban",
  target: string,
  extra: Record<string, unknown> = {},
): Promise<{ run: (signal?: AbortSignal) => Promise<unknown> }> {
  const revert = await markPending(ctx.db, serverId, target);
  const queued = await ctx.queue.enqueue({
    type,
    serverId,
    params: { target, ...extra, revert },
  });
  return {
    run: async (signal) => {
      const claimed = await ctx.queue.claim("test-worker", 60, [serverId]);
      if (!claimed || claimed.id !== queued.id) throw new Error("claimed the wrong job");
      const handler: JobHandler = type === "fw.ban" ? banHandler : unbanHandler;
      const jobCtx: JobContext = {
        ...ctx,
        hub: hub.as(),
        job: claimed,
        signal: signal ?? new AbortController().signal,
        log_: async () => undefined,
        progress: async () => undefined,
      };
      return handler(jobCtx);
    },
  };
}

describe("ban disposition", () => {
  it("is pending while queued and banned once the host has done it", async () => {
    hub.answer = () => ({ ok: true });
    const id = await threat("192.0.2.10");
    const job = await request("fw.ban", "192.0.2.10/32", { duration_seconds: 0, reason: "test" });

    expect(await state(id)).toEqual({ disposition: "pending", error: null });
    await job.run();
    expect(await state(id)).toEqual({ disposition: "banned", error: null });

    // The bookkeeping never reaches the host.
    const sent = hub.calls.at(-1)!;
    expect(sent.method).toBe("fw.ban");
    expect(Object.keys(sent.params).sort()).toEqual(["duration_seconds", "reason", "target"]);

    // And the Bans list now has it.
    const blocks = await handle.db
      .select()
      .from(ipBlocks)
      .where(and(eq(ipBlocks.serverId, serverId), eq(ipBlocks.cidr, "192.0.2.10/32")));
    expect(blocks).toHaveLength(1);
  });

  it("goes back to what it was, with the host's reason, when the host refuses", async () => {
    hub.answer = () => {
      throw new AgentRpcError({ code: "precondition_failed", message: "the host said no" });
    };
    const observed = await threat("192.0.2.20");
    const ignored = await threat("192.0.2.21", "ignored");
    const job = await request("fw.ban", "192.0.2.16/28", { duration_seconds: 0, reason: "test" });

    expect((await state(observed)).disposition).toBe("pending");
    expect((await state(ignored)).disposition).toBe("pending");
    await expect(job.run()).rejects.toThrow("the host said no");

    expect(await state(observed)).toEqual({ disposition: "observed", error: "the host said no" });
    expect(await state(ignored)).toEqual({ disposition: "ignored", error: "the host said no" });
    const blocks = await handle.db.select().from(ipBlocks).where(eq(ipBlocks.cidr, "192.0.2.16/28"));
    expect(blocks).toHaveLength(0);

    // The next success clears the error.
    hub.answer = () => ({ ok: true });
    await (await request("fw.ban", "192.0.2.20/32", { duration_seconds: 0, reason: "retry" })).run();
    expect(await state(observed)).toEqual({ disposition: "banned", error: null });
  });

  it("stays pending while a transient failure will be retried", async () => {
    const id = await threat("192.0.2.31");
    const job = await request("fw.ban", "192.0.2.31/32", { duration_seconds: 0, reason: "t" });
    hub.answer = () => {
      throw new AgentRpcError({ code: "timeout", message: "slow host" });
    };
    // fw.ban is idempotent with two attempts, so a first timeout is retried
    // by the worker: the request is still outstanding.
    await expect(job.run()).rejects.toThrow("slow host");
    expect(await state(id)).toEqual({ disposition: "pending", error: null });
    hub.answer = () => ({ ok: true });
  });

  it("an offline agent leaves the row pending rather than failing it", async () => {
    const id = await threat("192.0.2.40");
    const job = await request("fw.ban", "192.0.2.40/32", { duration_seconds: 0, reason: "t" });
    hub.answer = () => {
      throw new AgentOfflineError(serverId);
    };
    await expect(job.run()).rejects.toBeInstanceOf(AgentOfflineError);
    expect(await state(id)).toEqual({ disposition: "pending", error: null });
    hub.answer = () => ({ ok: true });
  });

  it("an unban settles to observed, or back to banned when the host refuses", async () => {
    hub.answer = () => ({ ok: true });
    const id = await threat("192.0.2.50");
    await (await request("fw.ban", "192.0.2.50/32", { duration_seconds: 0, reason: "t" })).run();
    expect((await state(id)).disposition).toBe("banned");

    hub.answer = () => {
      throw new AgentRpcError({ code: "not_found", message: "192.0.2.50/32 is not banned" });
    };
    await expect((await request("fw.unban", "192.0.2.50/32")).run()).rejects.toThrow();
    expect(await state(id)).toEqual({ disposition: "banned", error: "192.0.2.50/32 is not banned" });

    hub.answer = () => ({ ok: true });
    await (await request("fw.unban", "192.0.2.50/32")).run();
    expect(await state(id)).toEqual({ disposition: "observed", error: null });
  });

  it("does not record a row that is already pending as its own earlier state", async () => {
    const id = await threat("192.0.2.60");
    const first = await markPending(ctx.db, serverId, "192.0.2.60/32");
    const second = await markPending(ctx.db, serverId, "192.0.2.60/32");
    expect(first.map((r) => r.id)).toEqual([id]);
    expect(second).toEqual([]);
  });
});
