import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { jobs, mailAuthChecks, mailDomains, mailboxes } from "@kaname/db/schema";
import { JOB_TYPES, type JobType } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { registerJobHandlers } from "./jobs/handlers.js";
import type { JobContext, JobHandler, JobWorker } from "./jobs/worker.js";
import { MailAuthChecker } from "./services/mail-auth.js";

/* ------------------------------------------------------------------ *
 * Job handlers, driven directly.
 *
 * The worker's own loop is exercised elsewhere; what these pin down is
 * what a handler writes back when the host answers in each of the ways
 * an agent can, because that write-back is the only place a stuck row
 * can come from. The agent is a stub that answers by method, so no
 * socket and no DNS is involved.
 * ------------------------------------------------------------------ */

const ZONE_SERVER_NAME = "mail-01";

/** Answers hub.call by method; anything not scripted is "unsupported". */
class FakeHub {
  readonly connected = new Set<string>();
  readonly calls: { method: string; params: unknown }[] = [];
  readonly answers = new Map<string, (params: never) => unknown>();

  isConnected(serverId: string): boolean {
    return this.connected.has(serverId);
  }

  capabilities(serverId: string): string[] {
    return this.connected.has(serverId) ? ["systemd", "mail"] : [];
  }

  connectedServerIds(): string[] {
    return [...this.connected];
  }

  async call(serverId: string, method: string, params: unknown): Promise<unknown> {
    if (!this.connected.has(serverId)) throw new AgentOfflineError(serverId);
    this.calls.push({ method, params });
    const answer = this.answers.get(method);
    if (!answer) throw new AgentRpcError({ code: "unsupported", message: `no ${method}` });
    return answer(params as never);
  }

  stream(): never {
    throw new Error("streams are not scripted here");
  }

  as(): AgentHub {
    return this as unknown as AgentHub;
  }
}

/** The sim's kind of zone: what the mail host's own resolver would say. */
function zone(entries: Record<string, string[]>) {
  return ({ name, type }: { name: string; type: string }) => {
    const values = entries[`${type.toUpperCase()} ${name.toLowerCase().replace(/\.$/, "")}`] ?? [];
    return {
      records: values.length ? [{ name, type, values, ttl: 300, resolver: "127.0.0.53" }] : [],
    };
  };
}

let handle: DbHandle;
let ctx: AppContext;
let hub: FakeHub;
let handlers: Map<JobType, JobHandler>;
let mailServerId: string;
let mailDomainId: string;

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

  hub = new FakeHub();
  handlers = new Map();
  registerJobHandlers({
    registerAll(map: Partial<Record<JobType, JobHandler>>) {
      for (const [type, handler] of Object.entries(map)) {
        if (handler) handlers.set(type as JobType, handler);
      }
    },
  } as unknown as JobWorker);

  const [domain] = await handle.db
    .select({ id: mailDomains.id, serverId: mailDomains.serverId })
    .from(mailDomains)
    .limit(1);
  mailDomainId = domain!.id;
  mailServerId = domain!.serverId;
  hub.connected.add(mailServerId);
}, 120_000);

afterAll(async () => {
  await handle?.close();
  resetConfigForTests();
});

/** Enqueues and claims a real row, so log lines have a job to hang off. */
async function run(
  type: JobType,
  params: Record<string, unknown>,
): Promise<{ result: Promise<unknown>; logs: string[]; jobId: string }> {
  const queued = await ctx.queue.enqueue({ type, serverId: mailServerId, params });
  const claimed = await ctx.queue.claim("test-worker", 60, [mailServerId]);
  if (!claimed || claimed.id !== queued.id) throw new Error("claimed the wrong job");

  const logs: string[] = [];
  const jobCtx: JobContext = {
    ...ctx,
    hub: hub.as(),
    job: claimed,
    signal: new AbortController().signal,
    log_: async (level, message) => {
      logs.push(`${level}: ${message}`);
      await ctx.queue.log(claimed.id, level, message);
    },
    progress: async () => undefined,
  };
  const handler = handlers.get(type);
  if (!handler) throw new Error(`no handler for ${type}`);
  return { result: handler(jobCtx), logs, jobId: claimed.id };
}

async function mailboxRow(address: string, status: "provisioning" | "active" = "provisioning") {
  const [row] = await handle.db
    .insert(mailboxes)
    .values({
      mailDomainId,
      serverId: mailServerId,
      address,
      localPart: address.split("@")[0]!,
      quotaBytes: 0,
      status,
    })
    .returning({ id: mailboxes.id });
  return row!.id;
}

async function mailboxStatus(id: string): Promise<string | null> {
  const rows = await handle.db
    .select({ status: mailboxes.status })
    .from(mailboxes)
    .where(eq(mailboxes.id, id));
  return rows[0]?.status ?? null;
}

describe("registration", () => {
  it("has a handler for every job type the contract can enqueue", () => {
    // A job type without a handler fails every operator who reaches it
    // with "No handler registered" — this is the check that used to be
    // missing for mail.auth.check.
    for (const type of JOB_TYPES) {
      expect(handlers.has(type), `${type} has no handler`).toBe(true);
    }
  });
});

describe("mail.mailbox.create", () => {
  it("marks the row error when the host refuses, so it can be deleted and retried", async () => {
    hub.answers.set("mail.mailbox.create", () => {
      throw new AgentRpcError({ code: "internal", message: "doveadm pw failed" });
    });
    const id = await mailboxRow("broken@futureforge.dev");

    const { result } = await run("mail.mailbox.create", {
      mailbox_id: id,
      address: "broken@futureforge.dev",
      password: "a-long-enough-password-1",
      quota_bytes: 0,
    });
    await expect(result).rejects.toBeInstanceOf(AgentRpcError);
    expect(await mailboxStatus(id)).toBe("error");
  });

  it("adopts a mailbox the host already has instead of failing", async () => {
    hub.answers.set("mail.mailbox.create", () => {
      throw new AgentRpcError({ code: "conflict", message: "mailbox already exists" });
    });
    const id = await mailboxRow("existing@futureforge.dev");

    const { result, logs } = await run("mail.mailbox.create", {
      mailbox_id: id,
      address: "existing@futureforge.dev",
      password: "a-long-enough-password-1",
      quota_bytes: 0,
    });
    await expect(result).resolves.toEqual({ ok: true });
    expect(await mailboxStatus(id)).toBe("active");
    expect(logs.some((line) => line.includes("already existed on the host"))).toBe(true);
  });

  it("leaves a provisioning row alone when the agent drops mid-job", async () => {
    const id = await mailboxRow("offline@futureforge.dev");
    hub.connected.delete(mailServerId);
    try {
      const { result } = await run("mail.mailbox.create", {
        mailbox_id: id,
        address: "offline@futureforge.dev",
        password: "a-long-enough-password-1",
        quota_bytes: 0,
      });
      await expect(result).rejects.toBeInstanceOf(AgentOfflineError);
    } finally {
      hub.connected.add(mailServerId);
    }
    // The worker will park and retry this one; "error" would be a lie.
    expect(await mailboxStatus(id)).toBe("provisioning");
  });
});

describe("mail.mailbox.delete", () => {
  it("removes the record when the host never had the account", async () => {
    hub.answers.set("mail.mailbox.delete", () => {
      throw new AgentRpcError({ code: "not_found", message: "mailbox ghost@futureforge.dev" });
    });
    const id = await mailboxRow("ghost@futureforge.dev", "provisioning");

    const { result, logs } = await run("mail.mailbox.delete", {
      mailbox_id: id,
      address: "ghost@futureforge.dev",
      delete_maildir: false,
    });
    await expect(result).resolves.toEqual({ ok: true });
    expect(await mailboxStatus(id)).toBeNull();
    expect(logs.some((line) => line.includes("not present on the host"))).toBe(true);
  });

  it("keeps the record when the host fails for any other reason", async () => {
    hub.answers.set("mail.mailbox.delete", () => {
      throw new AgentRpcError({ code: "permission_denied", message: "read-only userdb" });
    });
    const id = await mailboxRow("stuck@futureforge.dev", "active");

    const { result } = await run("mail.mailbox.delete", {
      mailbox_id: id,
      address: "stuck@futureforge.dev",
      delete_maildir: false,
    });
    await expect(result).rejects.toBeInstanceOf(AgentRpcError);
    expect(await mailboxStatus(id)).toBe("active");
  });
});

describe("mail.mailbox.reset_password", () => {
  it("passes revoke_sessions to the host and says so in the job log", async () => {
    hub.answers.set("mail.mailbox.password", () => ({ ok: true }));

    const revoked = await run("mail.mailbox.reset_password", {
      address: "hello@futureforge.dev",
      password: "a-long-enough-password-1",
      revoke_sessions: true,
    });
    await expect(revoked.result).resolves.toMatchObject({ sessions_revoked: true });
    expect(hub.calls.at(-1)).toMatchObject({
      method: "mail.mailbox.password",
      params: { address: "hello@futureforge.dev", revoke_sessions: true },
    });
    expect(revoked.logs.at(-1)).toContain("sessions revoked");

    const kept = await run("mail.mailbox.reset_password", {
      address: "hello@futureforge.dev",
      password: "a-long-enough-password-1",
      revoke_sessions: false,
    });
    await expect(kept.result).resolves.toMatchObject({ sessions_revoked: false });
    expect(hub.calls.at(-1)).toMatchObject({ params: { revoke_sessions: false } });
    expect(kept.logs.at(-1)).toContain("left open");
  });
});

describe("mail.domain.provision", () => {
  async function domainState() {
    const rows = await handle.db
      .select({ status: mailDomains.status, key: mailDomains.dkimPublicKey })
      .from(mailDomains)
      .where(eq(mailDomains.id, mailDomainId));
    return rows[0]!;
  }

  it("reads the host's DKIM key and settles a provisioning row to active", async () => {
    await handle.db
      .update(mailDomains)
      .set({ status: "provisioning", dkimPublicKey: null })
      .where(eq(mailDomains.id, mailDomainId));
    hub.answers.set("mail.dkim.read", () => ({
      selector: "kaname",
      public_key: "HOSTKEY",
      key_bits: 2048,
      txt_value: "v=DKIM1; k=rsa; p=HOSTKEY",
    }));

    const { result, logs } = await run("mail.domain.provision", {
      mail_domain_id: mailDomainId,
      domain: "futureforge.dev",
    });
    await expect(result).resolves.toMatchObject({ dkim_read: true });
    expect(await domainState()).toEqual({ status: "active", key: "HOSTKEY" });
    expect(logs.some((line) => line.includes("DKIM selector kaname"))).toBe(true);
  });

  it("still marks the domain active when the host has no key yet", async () => {
    await handle.db
      .update(mailDomains)
      .set({ status: "error", dkimPublicKey: null })
      .where(eq(mailDomains.id, mailDomainId));
    hub.answers.set("mail.dkim.read", () => {
      throw new AgentRpcError({ code: "not_found", message: "no DKIM key for futureforge.dev" });
    });

    const { result, logs } = await run("mail.domain.provision", {
      mail_domain_id: mailDomainId,
      domain: "futureforge.dev",
    });
    await expect(result).resolves.toMatchObject({ dkim_read: false });
    expect(await domainState()).toEqual({ status: "active", key: null });
    expect(logs.some((line) => line.startsWith("warn: no DKIM key"))).toBe(true);
  });

  it("does not override a status the operator chose", async () => {
    await handle.db
      .update(mailDomains)
      .set({ status: "disabled" })
      .where(eq(mailDomains.id, mailDomainId));

    const { result } = await run("mail.domain.provision", {
      mail_domain_id: mailDomainId,
      domain: "futureforge.dev",
    });
    await result;
    expect((await domainState()).status).toBe("disabled");

    await handle.db
      .update(mailDomains)
      .set({ status: "active" })
      .where(eq(mailDomains.id, mailDomainId));
  });
});

/* ------------------------------------------------------------------ *
 * The DNS-authentication engine, resolving through the host
 * ------------------------------------------------------------------ */

const SIM_ZONE = {
  "MX futureforge.dev": ["10 mail.futureforge.dev."],
  "A mail.futureforge.dev": ["198.51.100.42"],
  // Quoted as a host hands them back; the engine has to unquote.
  "TXT futureforge.dev": ['"v=spf1 mx -all"'],
  "TXT kaname._domainkey.futureforge.dev": ["v=DKIM1; k=rsa; p=HOSTKEY"],
  "TXT _dmarc.futureforge.dev": ["v=DMARC1; p=quarantine; rua=mailto:dmarc@futureforge.dev"],
  "PTR 42.100.51.198.in-addr.arpa": ["mail.futureforge.dev."],
};

describe("mail.auth.check", () => {
  it("asks the host's resolver and records which vantage point answered", async () => {
    hub.answers.set("dns.resolve", zone(SIM_ZONE));
    hub.answers.set("mail.dkim.read", () => ({
      selector: "kaname",
      public_key: "HOSTKEY",
      key_bits: 2048,
      txt_value: "v=DKIM1; k=rsa; p=HOSTKEY",
    }));

    const { result, logs } = await run("mail.auth.check", { mail_domain_id: mailDomainId });
    const summary = (await result) as { overall: string; resolver_used: string };
    expect(summary.resolver_used).toBe(`host:${ZONE_SERVER_NAME}`);
    // One log line per verdict, so the drawer reads like the page.
    expect(
      logs.filter((line) => /^(info|warn|error): \w+: (pass|warn|fail|unknown) — /.test(line)),
    ).toHaveLength(8);

    const rows = await handle.db
      .select()
      .from(mailAuthChecks)
      .where(eq(mailAuthChecks.mailDomainId, mailDomainId));
    const byCheck = new Map(rows.map((row) => [row.check, row]));

    // The sim zone: the mail host is DNS-only with no SPF of its own.
    expect(byCheck.get("mx")?.status).toBe("pass");
    expect(byCheck.get("spf")?.status).toBe("pass");
    expect(byCheck.get("dkim")?.status).toBe("pass");
    expect(byCheck.get("dmarc")?.status).toBe("pass");
    expect(byCheck.get("ptr")?.status).toBe("pass");
    expect(byCheck.get("proxy_exposure")?.status).toBe("pass");
    expect(byCheck.get("host_spf")?.status).toBe("fail");
    expect(byCheck.get("host_spf")?.expected).toBe(
      'mail.futureforge.dev.\t3600\tIN\tTXT\t"v=spf1 a -all"',
    );
    expect(rows.every((row) => row.resolverUsed === `host:${ZONE_SERVER_NAME}`)).toBe(true);

    // Every lookup went to the host; nothing was asked of this process's resolver.
    expect(hub.calls.some((call) => call.method === "dns.resolve")).toBe(true);
    const asked = hub.calls
      .filter((call) => call.method === "dns.resolve")
      .map((call) => call.params as { name: string; type: string });
    expect(asked).toContainEqual({ name: "42.100.51.198.in-addr.arpa", type: "PTR" });
  });

  it("turns an unusable resolver into a report rather than a crash", async () => {
    const checker = new MailAuthChecker({ db: ctx.db, hub: hub.as() });
    hub.connected.delete(mailServerId);
    try {
      const report = await checker.run(mailDomainId, {
        checks: ["mx", "host_spf"],
        resolver: "not-an-address",
      });
      // The report carries every stored verdict; only the two asked for
      // were re-run, and both say why they could not be.
      const rerun = report.checks.filter((c) => c.check === "mx" || c.check === "host_spf");
      expect(rerun.map((c) => c.status)).toEqual(["unknown", "unknown"]);
      expect(rerun[0]?.detail).toContain("could not complete this check");

      const [stored] = await handle.db
        .select({ resolver: mailAuthChecks.resolverUsed })
        .from(mailAuthChecks)
        .where(eq(mailAuthChecks.mailDomainId, mailDomainId))
        .then((rows) => rows.filter((row) => row.resolver?.includes("unusable resolver")));
      expect(stored?.resolver).toBe("unusable resolver not-an-address");
    } finally {
      hub.connected.add(mailServerId);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Finished jobs keep no secrets
 * ------------------------------------------------------------------ */

describe("job params after completion", () => {
  async function paramsOf(id: string): Promise<Record<string, unknown>> {
    const rows = await handle.db.select({ params: jobs.params }).from(jobs).where(eq(jobs.id, id));
    return rows[0]!.params as Record<string, unknown>;
  }

  const secret = { address: "hello@futureforge.dev", password: "hunter2-hunter2-hunter2" };

  it("redacts secret-looking keys once a job succeeds", async () => {
    const job = await ctx.queue.enqueue({
      type: "mail.mailbox.reset_password",
      serverId: mailServerId,
      params: secret,
    });
    await ctx.queue.claim("test-worker", 60, [mailServerId]);
    await ctx.queue.complete(job.id, { ok: true });
    expect(await paramsOf(job.id)).toEqual({
      address: "hello@futureforge.dev",
      password: "[redacted]",
    });
  });

  it("keeps them while a retry is still coming, and redacts on the final failure", async () => {
    const job = await ctx.queue.enqueue({
      type: "mail.mailbox.reset_password",
      serverId: mailServerId,
      params: secret,
    });
    await ctx.queue.claim("test-worker", 60, [mailServerId]);

    // The next attempt has to send the same credential, so it stays.
    await ctx.queue.fail(job.id, { code: "timeout", message: "slow" }, { retry: true });
    expect((await paramsOf(job.id)).password).toBe(secret.password);

    await ctx.queue.fail(job.id, { code: "timeout", message: "slow" }, { retry: false });
    expect((await paramsOf(job.id)).password).toBe("[redacted]");
  });
});
