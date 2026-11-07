import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { domains, jobs, mailAliases, mailDomains, mailServers, mailboxes } from "@kaname/db/schema";
import { JOB_TYPES, type JobType } from "@kaname/contract";
import { AgentOfflineError, AgentRpcError, type AgentHub } from "./agent/hub.js";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { registerJobHandlers } from "./jobs/handlers.js";
import { dnsStatusOf, redactInstallerLine, worstStatus } from "./jobs/mail.js";
import type { JobContext, JobHandler, JobWorker } from "./jobs/worker.js";

/* ------------------------------------------------------------------ *
 * Job handlers, driven directly.
 *
 * The worker's own loop is exercised elsewhere; what these pin down is
 * what a handler writes back when the host answers in each of the ways
 * an agent can, because that write-back is the only place a stuck row
 * can come from. The agent is a stub that answers by method, so no
 * socket and no DNS is involved.
 * ------------------------------------------------------------------ */

/** Answers hub.call by method; anything not scripted is "unsupported". */
class FakeHub {
  readonly connected = new Set<string>();
  readonly calls: { method: string; params: unknown }[] = [];
  readonly answers = new Map<string, (params: never) => unknown>();

  isConnected(serverId: string): boolean {
    return this.connected.has(serverId);
  }

  capabilities(serverId: string): string[] {
    return this.connected.has(serverId) ? ["systemd", "yunori"] : [];
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

let handle: DbHandle;
let ctx: AppContext;
let hub: FakeHub;
let handlers: Map<JobType, JobHandler>;
let mailServerId: string;
let mailServerRowId: string;
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
    .select({
      id: mailDomains.id,
      serverId: mailDomains.serverId,
      mailServerId: mailDomains.mailServerId,
    })
    .from(mailDomains)
    .limit(1);
  mailDomainId = domain!.id;
  mailServerId = domain!.serverId;
  mailServerRowId = domain!.mailServerId;
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

async function mailboxRow(address: string, status: "active" | "removing" = "active") {
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
    // with "No handler registered".
    for (const type of JOB_TYPES) {
      expect(handlers.has(type), `${type} has no handler`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe("mail helpers", () => {
  it("ranks verdicts worst-first and says unknown for nothing", () => {
    expect(worstStatus([])).toBe("unknown");
    expect(worstStatus(["pass", "info"])).toBe("info");
    expect(worstStatus(["pass", "warn", "fail", "pass"])).toBe("fail");
    expect(worstStatus(["pass", "unknown"])).toBe("unknown");
  });

  it("judges DNS on required records only, unless none are", () => {
    const rec = (status: "pass" | "fail" | "warn", required: boolean) => ({
      id: "x",
      type: "TXT",
      name: "x",
      expected: null,
      actual: [],
      status,
      required,
    });
    expect(dnsStatusOf([rec("pass", true), rec("fail", false)])).toBe("pass");
    expect(dnsStatusOf([rec("pass", true), rec("fail", true)])).toBe("fail");
    expect(dnsStatusOf([rec("warn", false)])).toBe("warn");
  });

  it("masks the setup token and any printed password before a line reaches the log", () => {
    expect(
      redactInstallerLine(
        "Open https://mail.example.com/console/setup#token=abc.DEF-123 to continue",
      ),
    ).toBe("Open https://mail.example.com/console/setup#token=[redacted] to continue");
    expect(redactInstallerLine("Password (shown once): Tr0ub4dor&3")).toBe(
      "Password (shown once): [redacted]",
    );
    expect(redactInstallerLine("relay password=hunter2 accepted")).toBe(
      "relay password=[redacted] accepted",
    );
    expect(redactInstallerLine("Generating a password for hello@example.com")).toBe(
      "Generating a password for hello@example.com",
    );
  });
});

/* ------------------------------------------------------------------ *
 * mail.server.sync: the host is the source of truth
 * ------------------------------------------------------------------ */

describe("mail.server.sync", () => {
  it("reads the host and reconciles domains, mailboxes and aliases it lists", async () => {
    hub.answers.set("mail.status", () => ({
      installed: true,
      version: "0.3.2",
      install_complete: true,
      steps: [{ title: "Finish", status: "done", detail: null }],
      services: [{ name: "stalwart", active: true }],
      hostnames: ["mail.futureforge.dev"],
      console_url: "https://mail.futureforge.dev/console",
    }));
    hub.answers.set("mail.doctor", () => ({
      checks: [
        {
          id: "services",
          label: "Services",
          status: "pass",
          detail: "ok",
          remedy: null,
          help_url: null,
        },
        {
          id: "ptr",
          label: "Reverse DNS",
          status: "warn",
          detail: "not set",
          remedy: "set it",
          help_url: null,
        },
      ],
    }));
    hub.answers.set("mail.certificate.status", () => ({
      state: "valid",
      covers: ["mail.futureforge.dev"],
      issuer: "Let's Encrypt",
      expires_at: "2027-01-01T00:00:00Z",
      days_left: 60,
      authority: null,
      renews_at: null,
      last_attempt: null,
      next_attempt: null,
    }));
    hub.answers.set("mail.domain.list", () => ({
      domains: [
        { name: "futureforge.dev", dns_status: "pass", mailbox_count: 5 },
        // Added in the Yunori console; Kaname has never heard of it.
        { name: "newbrand.example", dns_status: "warn", mailbox_count: 1 },
      ],
    }));
    hub.answers.set("mail.mailbox.list", () => ({
      mailboxes: [
        ...["hello", "detective", "billing", "noreply", "support"].map((local) => ({
          address: `${local}@futureforge.dev`,
          display_name: null,
          aliases: [],
        })),
        { address: "Ana@newbrand.example", display_name: "Ana", aliases: [] },
      ],
    }));
    // Only one of the four seeded aliases is still on the host.
    hub.answers.set("mail.alias.list", () => ({
      aliases: [{ address: "admin@futureforge.dev", mailbox: "detective@futureforge.dev" }],
    }));

    const { result, logs } = await run("mail.server.sync", { mail_server_id: mailServerRowId });
    await expect(result).resolves.toEqual({ ok: true });

    const [server] = await handle.db
      .select()
      .from(mailServers)
      .where(eq(mailServers.id, mailServerRowId));
    expect(server).toMatchObject({
      status: "installed",
      version: "0.3.2",
      installComplete: true,
      hostname: "mail.futureforge.dev",
      health: "warn",
    });
    expect(server!.certificate?.state).toBe("valid");
    expect(server!.lastSyncedAt).not.toBeNull();

    const [adopted] = await handle.db
      .select({ mailDomain: mailDomains, domain: domains })
      .from(mailDomains)
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .where(eq(domains.name, "newbrand.example"));
    expect(adopted).toBeDefined();
    expect(adopted!.mailDomain).toMatchObject({
      mailServerId: mailServerRowId,
      status: "active",
      dnsStatus: "warn",
      isPrimary: false,
    });
    // The Kaname domain was created for it, unverified: nobody here proved ownership.
    expect(adopted!.domain).toMatchObject({ verified: false, hasMail: true, status: "active" });
    expect(logs).toContain("info: adopted mail domain newbrand.example from the host");

    const [ana] = await handle.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.address, "ana@newbrand.example"));
    expect(ana).toMatchObject({
      mailDomainId: adopted!.mailDomain.id,
      displayName: "Ana",
      status: "active",
    });

    // Vanished objects are marked, not deleted.
    const [security] = await handle.db
      .select({ status: mailAliases.status })
      .from(mailAliases)
      .where(eq(mailAliases.address, "security@futureforge.dev"));
    expect(security?.status).toBe("error");
    const [admin] = await handle.db
      .select({ status: mailAliases.status })
      .from(mailAliases)
      .where(eq(mailAliases.address, "admin@futureforge.dev"));
    expect(admin?.status).toBe("active");
    expect(logs.some((l) => l.includes("security@futureforge.dev is no longer on the host"))).toBe(
      true,
    );
  });

  it("fails on an unreachable host without touching the rows", async () => {
    hub.connected.delete(mailServerId);
    try {
      const { result } = await run("mail.server.sync", { mail_server_id: mailServerRowId });
      await expect(result).rejects.toBeInstanceOf(AgentOfflineError);
    } finally {
      hub.connected.add(mailServerId);
    }
    const [server] = await handle.db
      .select({ status: mailServers.status })
      .from(mailServers)
      .where(eq(mailServers.id, mailServerRowId));
    expect(server?.status).toBe("installed");
  });
});

/* ------------------------------------------------------------------ *
 * Domains and DNS
 * ------------------------------------------------------------------ */

describe("mail.domain.dns_check", () => {
  it("stores the host's checklist and judges it on the required records", async () => {
    hub.answers.set("mail.domain.dns", () => ({
      records: [
        {
          id: "MX:futureforge.dev",
          type: "MX",
          name: "futureforge.dev",
          expected: "10 mail.futureforge.dev.",
          actual: ["10 mail.futureforge.dev."],
          status: "pass",
          required: true,
        },
        {
          id: "TXT:yunori._domainkey.futureforge.dev",
          type: "TXT",
          name: "yunori._domainkey.futureforge.dev",
          expected: "v=DKIM1; p=KEY",
          actual: [],
          status: "fail",
          required: true,
        },
        {
          id: "TXT:_smtp._tls.futureforge.dev",
          type: "TXT",
          name: "_smtp._tls.futureforge.dev",
          expected: "v=TLSRPTv1",
          actual: [],
          status: "warn",
          required: false,
        },
      ],
      zone_file: "futureforge.dev. IN MX 10 mail.futureforge.dev.",
    }));

    const { result, logs } = await run("mail.domain.dns_check", {
      mail_domain_id: mailDomainId,
      name: "futureforge.dev",
    });
    await expect(result).resolves.toMatchObject({ overall: "fail", records: 3 });

    const [row] = await handle.db
      .select()
      .from(mailDomains)
      .where(eq(mailDomains.id, mailDomainId));
    expect(row!.dnsStatus).toBe("fail");
    expect(row!.dnsRecords).toHaveLength(3);
    expect(row!.zoneFile).toContain("IN MX");
    expect(row!.dnsCheckedAt).not.toBeNull();
    // One log line per record, levelled like the verdict.
    expect(logs.filter((l) => l.startsWith("error: TXT yunori._domainkey"))).toHaveLength(1);
    expect(logs.some((l) => l.includes("(optional)"))).toBe(true);
  });
});

describe("mail.domain.remove", () => {
  it("removes the record and clears has_mail when the host never had the domain", async () => {
    const [kanameDomain] = await handle.db
      .insert(domains)
      .values({ name: "gone.example", status: "active", hasMail: true })
      .returning({ id: domains.id });
    const [row] = await handle.db
      .insert(mailDomains)
      .values({
        domainId: kanameDomain!.id,
        serverId: mailServerId,
        mailServerId: mailServerRowId,
        status: "removing",
      })
      .returning({ id: mailDomains.id });
    hub.answers.set("mail.domain.remove", () => {
      throw new AgentRpcError({ code: "not_found", message: "no such domain" });
    });

    const { result, logs } = await run("mail.domain.remove", {
      mail_domain_id: row!.id,
      domain_id: kanameDomain!.id,
      name: "gone.example",
    });
    await expect(result).resolves.toEqual({ ok: true });
    expect(
      await handle.db.select().from(mailDomains).where(eq(mailDomains.id, row!.id)),
    ).toHaveLength(0);
    const [after] = await handle.db
      .select({ hasMail: domains.hasMail })
      .from(domains)
      .where(eq(domains.id, kanameDomain!.id));
    expect(after?.hasMail).toBe(false);
    expect(logs.some((l) => l.includes("was not on the host"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Mailboxes
 * ------------------------------------------------------------------ */

describe("mail.mailbox.remove", () => {
  it("removes the record when the host never had the account", async () => {
    hub.answers.set("mail.mailbox.remove", () => {
      throw new AgentRpcError({ code: "not_found", message: "mailbox ghost@futureforge.dev" });
    });
    const id = await mailboxRow("ghost@futureforge.dev", "removing");

    const { result, logs } = await run("mail.mailbox.remove", {
      mailbox_id: id,
      address: "ghost@futureforge.dev",
    });
    await expect(result).resolves.toEqual({ ok: true });
    expect(await mailboxStatus(id)).toBeNull();
    expect(logs.some((line) => line.includes("not present on the host"))).toBe(true);
  });

  it("keeps the record, marked, when the host fails for any other reason", async () => {
    hub.answers.set("mail.mailbox.remove", () => {
      throw new AgentRpcError({ code: "permission_denied", message: "engine refused" });
    });
    const id = await mailboxRow("stuck@futureforge.dev", "removing");

    const { result } = await run("mail.mailbox.remove", {
      mailbox_id: id,
      address: "stuck@futureforge.dev",
    });
    await expect(result).rejects.toBeInstanceOf(AgentRpcError);
    expect(await mailboxStatus(id)).toBe("error");
  });

  it("leaves the row alone when the host is merely unreachable", async () => {
    const id = await mailboxRow("offline@futureforge.dev", "removing");
    hub.connected.delete(mailServerId);
    try {
      const { result } = await run("mail.mailbox.remove", {
        mailbox_id: id,
        address: "offline@futureforge.dev",
      });
      await expect(result).rejects.toBeInstanceOf(AgentOfflineError);
    } finally {
      hub.connected.add(mailServerId);
    }
    // The worker will park and retry this one; "error" would be a lie.
    expect(await mailboxStatus(id)).toBe("removing");
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
      type: "mail.alias.add",
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
      type: "mail.alias.add",
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
