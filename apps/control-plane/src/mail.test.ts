import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import type { WebSocket } from "ws";
import { createDb, eq, sql, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import {
  auditEvents,
  jobs,
  mailAliases,
  mailDomains,
  mailServers,
  mailboxes,
} from "@kaname/db/schema";
import type {
  Domain,
  Job,
  MailDeploySecrets,
  MailDomain,
  MailServer,
  Mailbox,
  MailboxCredential,
  Server,
} from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import { isUniqueViolation } from "./routes/mail.js";
import {
  DEPLOY_SECRETS_TTL_MS,
  deploySecretsKey,
  relayPasswordKey,
} from "./services/mail-secrets.js";

/* ------------------------------------------------------------------ *
 * The Email routes against Yunori Mail Server.
 *
 * What is pinned here is the control plane's side of the bargain with
 * the host: a deploy is a row and a job and never a second one for the
 * same host, the relay password rides along as a reference and not a
 * value, a mailbox's password is returned exactly once and written
 * nowhere, a domain with mailboxes cannot be removed, and the live tail
 * refuses in JSON while it still can and in its own frames once it
 * cannot.
 * ------------------------------------------------------------------ */

const PASSWORD = "kaname-integration-test-password";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let cookie: string;
let mailServer: MailServer;
let domain: MailDomain;

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: PASSWORD,
    JOB_WORKER_ENABLED: "false",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);

  ctx = createContext({ config, log: pino({ level: "fatal" }), dbHandle: handle });
  await ctx.ca.load();
  await bootstrap(ctx);
  await seedDemo(handle.db);

  app = await buildServer(ctx);
  await app.ready();

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@kaname.test", password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  mailServer = data<MailServer[]>(await get("/api/v1/mail-servers"))[0]!;
  expect(mailServer.primary_domain).toBe("futureforge.dev");
  domain = data<MailDomain[]>(await get("/api/v1/mail-domains"))[0]!;
  expect(domain.domain_name).toBe("futureforge.dev");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

function get(url: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

function send(method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie }, payload: payload as object });
}

function data<T>(res: LightMyRequestResponse): T {
  return (JSON.parse(res.body) as { data: T }).data;
}

function error(res: LightMyRequestResponse) {
  return (
    JSON.parse(res.body) as {
      error: { code: string; message: string; remediation?: { summary: string } };
    }
  ).error;
}

/* ------------------------------ fake agent ------------------------------ */

/** Stands in for the agent's socket and answers requests as scripted. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  readonly requests: { method: string; params: unknown }[] = [];
  script: ((frame: Record<string, unknown>) => void) | null = null;

  send(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.t === "req") {
      this.requests.push({ method: String(frame.method), params: frame.params });
      queueMicrotask(() => this.script?.(frame));
    }
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  receive(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }

  /** Answers every request by method; anything unscripted is "unsupported". */
  answer(answers: Record<string, (params: never) => unknown>): void {
    this.script = (frame) => {
      const method = String(frame.method);
      const id = String(frame.id);
      const fn = answers[method];
      if (!fn) {
        this.receive({
          t: "res",
          id,
          ok: false,
          error: { code: "unsupported", message: `no ${method}` },
        });
        return;
      }
      try {
        this.receive({ t: "res", id, ok: true, result: fn(frame.params as never) });
      } catch (err) {
        const e = err as { code?: string; message: string };
        this.receive({
          t: "res",
          id,
          ok: false,
          error: { code: e.code ?? "internal", message: e.message },
        });
      }
    };
  }
}

function hello(capabilities: string[], arch = "x86_64") {
  return {
    t: "hlo",
    proto: 1,
    agent_version: "0.0.0-test",
    capabilities,
    host: {
      hostname: "mail-01",
      machine_id: "m-1",
      os: "linux",
      os_version: "12",
      arch,
      kernel: "6.1.0",
      boot_time: "2026-01-01T00:00:00Z",
      simulated: true,
    },
  };
}

function connect(serverId: string, capabilities: string[]): FakeSocket {
  const socket = new FakeSocket();
  ctx.hub.register(serverId, socket as unknown as WebSocket, null);
  socket.receive(hello(capabilities));
  return socket;
}

/* ------------------------------- servers -------------------------------- */

describe("mail servers", () => {
  it("lists the seeded server with its counts and the worst doctor verdict", () => {
    expect(mailServer.server_name).toBe("mail-01");
    expect(mailServer.status).toBe("installed");
    expect(mailServer.health).toBe("fail");
    expect(mailServer.domain_count).toBe(1);
    expect(mailServer.mailbox_count).toBe(5);
    expect(mailServer.checks.some((c) => c.id === "blocklists" && c.status === "fail")).toBe(true);
  });

  it("hands the deploy secrets out exactly once", async () => {
    const secrets: MailDeploySecrets = {
      setup_url: "https://mail.futureforge.dev/console/setup#token=abc",
      first_mailbox: "hello@futureforge.dev",
      first_mailbox_password: "first-password-once",
    };
    ctx.mailSecrets.put(deploySecretsKey(mailServer.id), secrets, DEPLOY_SECRETS_TTL_MS);

    const first = await get(`/api/v1/mail-servers/${mailServer.id}/deploy-secrets`);
    expect(first.statusCode, first.body).toBe(200);
    expect(data<MailDeploySecrets>(first)).toEqual(secrets);

    const second = await get(`/api/v1/mail-servers/${mailServer.id}/deploy-secrets`);
    expect(second.statusCode).toBe(404);
    expect(error(second).message).toContain("shown once");

    // That they were read is on the record; what they were is not.
    const trail = await handle.db.select().from(auditEvents);
    const dump = JSON.stringify(trail);
    expect(dump).toContain("mail_server.deploy_secrets_viewed");
    expect(dump).not.toContain("first-password-once");
    expect(dump).not.toContain("token=abc");
  });

  it("refuses to forget a server that still hosts domains besides its primary, and never uninstalls", async () => {
    // The primary domain goes with the record (it cannot be removed on its
    // own); a domain an operator added is what makes forgetting refuse.
    const extra = data<Domain[]>(await get("/api/v1/domains?per_page=50")).find((d) => !d.has_mail)!;
    const [added] = await handle.db
      .insert(mailDomains)
      .values({
        domainId: extra.id,
        serverId: mailServer.server_id,
        mailServerId: mailServer.id,
        isPrimary: false,
        status: "active",
      })
      .returning({ id: mailDomains.id });
    try {
      const res = await send("DELETE", `/api/v1/mail-servers/${mailServer.id}`);
      expect(res.statusCode).toBe(409);
      expect(error(res).message).toContain("besides its primary");
      expect(error(res).remediation?.summary).toContain("never uninstalls");
    } finally {
      await handle.db.delete(mailDomains).where(eq(mailDomains.id, added!.id));
    }
  });
});

describe("deploy", () => {
  let target: Server;
  let targetDomain: Domain;
  let socket: FakeSocket;

  beforeAll(async () => {
    const all = data<Server[]>(await get("/api/v1/servers?per_page=50"));
    target = all.find((s) => s.id !== mailServer.server_id)!;
    expect(target).toBeDefined();
    targetDomain = data<Domain[]>(await get("/api/v1/domains?per_page=50")).find(
      (d) => !d.has_mail,
    )!;
    expect(targetDomain).toBeDefined();
  });

  afterAll(() => {
    ctx.hub.disconnect(target.id, "test over");
  });

  it("needs a connected agent", async () => {
    const res = await send("POST", "/api/v1/mail-servers", {
      server_id: target.id,
      domain_id: targetDomain.id,
      admin_email: "ops@elsewhere.example",
    });
    expect(res.statusCode).toBe(503);
    expect(error(res).code).toBe("agent_offline");
  });

  it("creates the record and the job, and keeps the relay password out of both", async () => {
    socket = connect(target.id, ["systemd"]);
    const res = await send("POST", "/api/v1/mail-servers", {
      server_id: target.id,
      domain_id: targetDomain.id,
      admin_email: "ops@elsewhere.example",
      first_mailbox: "Hello",
      sending: "relay",
      relay: { provider: "postmark", username: "pm-token", password: "relay-secret-value" },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { job } = data<{ job: Job }>(res);
    expect(job.type).toBe("mail.server.deploy");
    expect(job.target_label).toBe(`mail.${targetDomain.name}`);

    const rows = await handle.db
      .select()
      .from(mailServers)
      .where(eq(mailServers.serverId, target.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "deploying",
      hostname: `mail.${targetDomain.name}`,
      primaryDomain: targetDomain.name,
      sendingMode: "relay",
      relayProvider: "postmark",
    });

    const [stored] = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    const params = stored!.params as {
      first_mailbox: string;
      relay: { password?: string; password_ref?: string; username: string };
    };
    expect(params.first_mailbox).toBe("hello");
    expect(params.relay.username).toBe("pm-token");
    expect(params.relay.password).toBeUndefined();
    expect(params.relay.password_ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(stored)).not.toContain("relay-secret-value");
    expect(ctx.mailSecrets.has(relayPasswordKey(params.relay.password_ref!))).toBe(true);
    // Nothing reached the host: the job does that, not the route (KD-008).
    expect(socket.requests).toHaveLength(0);
  });

  it("refuses a second mail server on the same host", async () => {
    const res = await send("POST", "/api/v1/mail-servers", {
      server_id: target.id,
      domain_id: targetDomain.id,
      admin_email: "ops@elsewhere.example",
    });
    expect(res.statusCode).toBe(409);
    expect(error(res).message).toContain("already has a mail server");

    // Adopting needs the host to advertise yunori, which this one does not.
    const adopt = await send("POST", "/api/v1/mail-servers/adopt", { server_id: target.id });
    expect(adopt.statusCode).toBe(501);
    expect(error(adopt).code).toBe("agent_unsupported");
  });

  it("forgets a record that hosts nothing", async () => {
    const [row] = await handle.db
      .select({ id: mailServers.id })
      .from(mailServers)
      .where(eq(mailServers.serverId, target.id));
    const res = await send("DELETE", `/api/v1/mail-servers/${row!.id}`);
    expect(res.statusCode, res.body).toBe(204);
  });
});

/* ------------------------------- mailboxes ------------------------------ */

describe("mailboxes", () => {
  let socket: FakeSocket;
  let created: MailboxCredential;

  beforeAll(() => {
    socket = connect(mailServer.server_id, ["systemd", "yunori"]);
    socket.answer({
      "mail.mailbox.add": () => ({ password: "generated-on-the-host-once" }),
      "mail.mailbox.passwd": () => ({ password: "reset-on-the-host-once" }),
    });
  });

  afterAll(() => {
    ctx.hub.disconnect(mailServer.server_id, "test over");
  });

  it("creates the mailbox on the host inline and returns the password once (KD-024)", async () => {
    const res = await send("POST", "/api/v1/mailboxes", {
      mail_domain_id: domain.id,
      local_part: "Sales.Team",
      display_name: "Sales",
      quota_mb: 2048,
    });
    expect(res.statusCode, res.body).toBe(201);
    created = data<MailboxCredential>(res);
    expect(created.password).toBe("generated-on-the-host-once");
    expect(created.mailbox.address).toBe("sales.team@futureforge.dev");
    expect(created.mailbox.local_part).toBe("sales.team");
    expect(created.mailbox.status).toBe("active");
    expect(created.mailbox.quota_bytes).toBe(2048 * 1024 * 1024);

    expect(socket.requests.at(-1)).toMatchObject({
      method: "mail.mailbox.add",
      params: { address: "sales.team@futureforge.dev", display_name: "Sales", quota_mb: 2048 },
    });
  });

  it("stores the password nowhere: not the row, not a job, not the audit trail", async () => {
    const needle = "generated-on-the-host-once";
    const rows = await handle.db.select().from(mailboxes);
    expect(JSON.stringify(rows)).not.toContain(needle);
    const queued = await handle.db.select().from(jobs);
    expect(JSON.stringify(queued)).not.toContain(needle);
    const trail = await handle.db.select().from(auditEvents);
    const dump = JSON.stringify(trail);
    expect(dump).toContain("mailbox.created");
    expect(dump).not.toContain(needle);
    // Belt and braces: the whole database, as text.
    const everything = (await handle.db.execute(
      sql`select count(*)::int as hits from (
        select params::text as t from jobs
        union all select result::text from jobs
        union all select coalesce(diff::text, '') || coalesce(metadata::text, '') from audit_events
      ) x where t like ${"%" + needle + "%"}`,
    )) as unknown as { rows: { hits: number }[] };
    expect(everything.rows[0]!.hits).toBe(0);
  });

  it("refuses the same address in a different case before asking the host", async () => {
    const before = socket.requests.length;
    const res = await send("POST", "/api/v1/mailboxes", {
      mail_domain_id: domain.id,
      local_part: "SALES.TEAM",
    });
    expect(res.statusCode).toBe(409);
    expect(error(res).message).toContain("already a mailbox");
    expect(socket.requests).toHaveLength(before);
  });

  it("refuses an address an alias already owns", async () => {
    const res = await send("POST", "/api/v1/mailboxes", {
      mail_domain_id: domain.id,
      local_part: "admin",
    });
    expect(res.statusCode).toBe(409);
    expect(error(res).message).toContain("already an alias");
  });

  it("resets a password inline and returns the new one once", async () => {
    const res = await send("POST", `/api/v1/mailboxes/${created.mailbox.id}/reset-password`);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ address: string; password: string }>(res)).toEqual({
      address: "sales.team@futureforge.dev",
      password: "reset-on-the-host-once",
    });
    const trail = await handle.db.select().from(auditEvents);
    expect(JSON.stringify(trail)).toContain("mailbox.password_reset");
    expect(JSON.stringify(trail)).not.toContain("reset-on-the-host-once");
  });

  it("translates the host's refusal into the API's vocabulary", async () => {
    socket.answer({
      "mail.mailbox.add": () => {
        throw Object.assign(new Error("mailbox exists in the engine"), { code: "conflict" });
      },
    });
    const res = await send("POST", "/api/v1/mailboxes", {
      mail_domain_id: domain.id,
      local_part: "ghost",
    });
    expect(res.statusCode).toBe(409);
    expect(error(res).message).toContain("mailbox exists in the engine");
    // Nothing was written for a mailbox the host refused.
    expect(
      await handle.db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.address, "ghost@futureforge.dev")),
    ).toHaveLength(0);
  });

  it("lists aliases on each mailbox", async () => {
    const rows = data<Mailbox[]>(await get("/api/v1/mailboxes?q=detective"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aliases).toEqual(["admin@futureforge.dev", "security@futureforge.dev"]);
  });

  it("removes a mailbox through a job and marks the row on the way", async () => {
    const res = await send("DELETE", `/api/v1/mailboxes/${created.mailbox.id}`);
    expect(res.statusCode, res.body).toBe(202);
    expect(data<{ job: Job }>(res).job.type).toBe("mail.mailbox.remove");
    const [row] = await handle.db
      .select({ status: mailboxes.status })
      .from(mailboxes)
      .where(eq(mailboxes.id, created.mailbox.id));
    expect(row?.status).toBe("removing");
  });
});

/* -------------------------------- domains ------------------------------- */

describe("mail domains", () => {
  let added: MailDomain;

  it("refuses to remove the domain the server was installed with", async () => {
    const res = await send("DELETE", `/api/v1/mail-domains/${domain.id}`);
    expect(res.statusCode).toBe(409);
    expect(error(res).message).toContain("installed with");
  });

  it("adds a domain as a job and marks the Kaname domain as receiving mail", async () => {
    const candidate = data<Domain[]>(await get("/api/v1/domains?per_page=50")).find(
      (d) => !d.has_mail,
    )!;
    const res = await send("POST", "/api/v1/mail-domains", {
      domain_id: candidate.id,
      server_id: mailServer.server_id,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(data<{ job: Job }>(res).job.type).toBe("mail.domain.add");

    const list = data<MailDomain[]>(
      await get(`/api/v1/mail-domains?server_id=${mailServer.server_id}`),
    );
    added = list.find((d) => d.domain_id === candidate.id)!;
    expect(added.status).toBe("provisioning");
    expect(added.is_primary).toBe(false);
    expect(data<Domain>(await get(`/api/v1/domains/${candidate.id}`)).has_mail).toBe(true);

    const again = await send("POST", "/api/v1/mail-domains", {
      domain_id: candidate.id,
      server_id: mailServer.server_id,
    });
    expect(again.statusCode).toBe(409);
  });

  it("conflicts on delete while mailboxes exist, then queues the removal", async () => {
    await handle.db.insert(mailboxes).values({
      mailDomainId: added.id,
      serverId: mailServer.server_id,
      address: `someone@${added.domain_name}`,
      localPart: "someone",
      status: "active",
    });
    const blocked = await send("DELETE", `/api/v1/mail-domains/${added.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(error(blocked).message).toContain("1 mailbox(es)");

    await handle.db.delete(mailboxes).where(eq(mailboxes.mailDomainId, added.id));
    const res = await send("DELETE", `/api/v1/mail-domains/${added.id}`);
    expect(res.statusCode, res.body).toBe(202);
    expect(data<{ job: Job }>(res).job.type).toBe("mail.domain.remove");
    const [row] = await handle.db
      .select({ status: mailDomains.status })
      .from(mailDomains)
      .where(eq(mailDomains.id, added.id));
    expect(row?.status).toBe("removing");
  });

  it("serves the cached DNS report with the record the UI offers to copy", async () => {
    const res = await get(`/api/v1/mail-domains/${domain.id}/dns`);
    expect(res.statusCode).toBe(200);
    const report = data<{
      overall: string;
      records: { type: string; status: string; expected: string | null }[];
    }>(res);
    expect(report.overall).toBe("fail");
    const dkim = report.records.find((r) => r.status === "fail");
    expect(dkim?.type).toBe("TXT");
    expect(dkim?.expected).toContain("v=DKIM1");
  });

  it("recognises the database's own duplicate refusal", async () => {
    let caught: unknown = null;
    try {
      await handle.db.insert(mailAliases).values({
        mailDomainId: domain.id,
        serverId: mailServer.server_id,
        address: "admin@futureforge.dev",
        mailboxAddress: "hello@futureforge.dev",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
  });
});

/* -------------------------------- aliases ------------------------------- */

describe("aliases", () => {
  it("builds the address from the local part and refuses to shadow a mailbox", async () => {
    const [hello] = await handle.db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.address, "hello@futureforge.dev"));

    const shadow = await send("POST", "/api/v1/mail-aliases", {
      mail_domain_id: domain.id,
      local_part: "Billing",
      mailbox_id: hello!.id,
    });
    expect(shadow.statusCode).toBe(409);
    expect(error(shadow).message).toContain("already a mailbox");

    const res = await send("POST", "/api/v1/mail-aliases", {
      mail_domain_id: domain.id,
      local_part: "Team",
      mailbox_id: hello!.id,
    });
    expect(res.statusCode, res.body).toBe(202);
    const { job } = data<{ job: Job }>(res);
    expect(job.type).toBe("mail.alias.add");
    expect(job.target_label).toBe("team@futureforge.dev");
    const [stored] = await handle.db
      .select({ params: jobs.params })
      .from(jobs)
      .where(eq(jobs.id, job.id));
    expect(stored!.params).toMatchObject({
      alias: "team@futureforge.dev",
      mailbox: "hello@futureforge.dev",
    });
  });
});

/* -------------------------------- live tail ----------------------------- */

describe("mail log tail", () => {
  const tailUrl = () => `/api/v1/mail-logs/tail?server_id=${mailServer.server_id}&lines=5`;

  it("answers agent_offline as JSON when no agent is connected", async () => {
    const res = await get(tailUrl());
    expect(res.statusCode).toBe(503);
    expect(error(res).code).toBe("agent_offline");
  });

  it("refuses a host without Yunori Mail Server before the stream opens", async () => {
    connect(mailServer.server_id, ["systemd"]);
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(501);
      expect(error(res).code).toBe("agent_unsupported");
      expect(error(res).remediation?.summary).toBeTruthy();
    } finally {
      ctx.hub.disconnect(mailServer.server_id, "test over");
    }
  });

  it("streams lines and ends cleanly when the host does", async () => {
    const socket = connect(mailServer.server_id, ["systemd", "yunori"]);
    socket.script = (frame) => {
      expect(frame.method).toBe("mail.logs");
      expect(frame.params).toMatchObject({ lines: 5, follow: true });
      const id = String(frame.id);
      socket.receive({
        t: "chk",
        id,
        seq: 0,
        data: "stalwart[1]: delivered to hello@futureforge.dev\n",
      });
      socket.receive({ t: "res", id, ok: true, result: { records: [] } });
      socket.receive({ t: "end", id, ok: true });
    };
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body).toContain("event: mail.log");
      expect(res.body).toContain("delivered to");
      expect(res.body).not.toContain("event: error");
    } finally {
      ctx.hub.disconnect(mailServer.server_id, "test over");
    }
  });

  it("unwraps the JSON records the agent streams, even split across chunks", async () => {
    const socket = connect(mailServer.server_id, ["systemd", "yunori"]);
    const record = JSON.stringify({
      ts: "2026-11-07T06:59:31.099Z",
      level: "info",
      source: "mail",
      message: "stalwart-mail[1181]: INFO Message delivered to hello@futureforge.dev",
      cursor: "mail:1",
    });
    socket.script = (frame) => {
      const id = String(frame.id);
      socket.receive({ t: "chk", id, seq: 0, data: record.slice(0, 40) });
      socket.receive({ t: "chk", id, seq: 1, data: `${record.slice(40)}\n` });
      socket.receive({ t: "res", id, ok: true, result: { records: [] } });
      socket.receive({ t: "end", id, ok: true });
    };
    try {
      const res = await get(tailUrl());
      const frames = res.body
        .split("\n\n")
        .filter((f) => f.startsWith("event: mail.log"))
        .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)) as { ts: string; line: string });
      expect(frames).toEqual([
        expect.objectContaining({
          ts: "2026-11-07T06:59:31.099Z",
          line: "stalwart-mail[1181]: INFO Message delivered to hello@futureforge.dev",
        }),
      ]);
    } finally {
      ctx.hub.disconnect(mailServer.server_id, "test over");
    }
  });

  it("treats the per-follow deadline as a rotation, not a failure", async () => {
    const socket = connect(mailServer.server_id, ["systemd", "yunori"]);
    socket.script = (frame) => {
      socket.receive({
        t: "res",
        id: String(frame.id),
        ok: false,
        error: { code: "timeout", message: "mail.logs timed out after 1800000ms" },
      });
    };
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("event: rotate");
      expect(res.body).not.toContain("event: error");
    } finally {
      ctx.hub.disconnect(mailServer.server_id, "test over");
    }
  });

  it("names a real failure in an error frame with its code", async () => {
    const socket = connect(mailServer.server_id, ["systemd", "yunori"]);
    socket.script = (frame) => {
      socket.receive({
        t: "res",
        id: String(frame.id),
        ok: false,
        error: { code: "not_found", message: "no mail journal on this host" },
      });
    };
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(200);
      const frame = /event: error\ndata: (.*)\n/.exec(res.body);
      expect(frame).not.toBeNull();
      expect(JSON.parse(frame![1]!)).toEqual({
        code: "agent_error",
        message: "no mail journal on this host",
      });
    } finally {
      ctx.hub.disconnect(mailServer.server_id, "test over");
    }
  });
});
