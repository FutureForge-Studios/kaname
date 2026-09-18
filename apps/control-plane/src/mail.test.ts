import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import type { WebSocket } from "ws";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { mailAliases, mailForwarders, mailboxes } from "@kaname/db/schema";
import type { Job, MailAlias, MailDomain, MailForwarder, Mailbox } from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import { isUniqueViolation } from "./routes/mail.js";

/* ------------------------------------------------------------------ *
 * The Email routes.
 *
 * What is pinned here is the control plane's side of the bargain with
 * the mail stack: addresses are folded the way Postfix and Dovecot fold
 * them, an edit obeys the same rules as a create, a row that never
 * reached the host can still be removed, and the live tail refuses in
 * JSON while it still can and in its own frames once it cannot.
 * ------------------------------------------------------------------ */

const PASSWORD = "kaname-integration-test-password";
const MAILBOX_PASSWORD = "a-mailbox-password-long-enough";

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let cookie: string;
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

  const domains = await get("/api/v1/mail-domains");
  domain = data<MailDomain[]>(domains)[0]!;
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

function send(method: "POST" | "PATCH" | "DELETE", url: string, payload: unknown) {
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

/* ------------------------------- mailboxes ------------------------------ */

describe("mailboxes", () => {
  let created: string;

  it("folds the local part to lower case, as the host will", async () => {
    const res = await send("POST", "/api/v1/mailboxes", {
      mail_domain_id: domain.id,
      local_part: "Sales.Team",
      password: MAILBOX_PASSWORD,
    });
    expect(res.statusCode, res.body).toBe(202);
    const { job } = data<{ job: Job }>(res);
    expect(job.target_label).toBe("sales.team@futureforge.dev");
    created = job.target_id!;

    const row = data<Mailbox>(await get(`/api/v1/mailboxes/${created}`));
    expect(row.address).toBe("sales.team@futureforge.dev");
    expect(row.local_part).toBe("sales.team");
    expect(row.status).toBe("provisioning");
  });

  it("refuses the same address in a different case, and says what to do about a stuck one", async () => {
    const res = await send("POST", "/api/v1/mailboxes", {
      mail_domain_id: domain.id,
      local_part: "SALES.TEAM",
      password: MAILBOX_PASSWORD,
    });
    expect(res.statusCode).toBe(409);
    const err = error(res);
    expect(err.code).toBe("conflict");
    // The existing row never reached the host, so "reset its password"
    // would be the wrong advice.
    expect(err.remediation?.summary).toContain("never finished provisioning");
  });

  it("removes a never-provisioned row directly while the agent is away", async () => {
    const res = await send("DELETE", `/api/v1/mailboxes/${created}`, { delete_maildir: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ job: Job | null; removed: boolean }>(res)).toEqual({ job: null, removed: true });

    const rows = await handle.db.select().from(mailboxes).where(eq(mailboxes.id, created));
    expect(rows).toHaveLength(0);
  });

  it("still queues a job for a mailbox the host actually has", async () => {
    const list = data<Mailbox[]>(await get("/api/v1/mailboxes?per_page=1&sort=address&order=asc"));
    const active = list[0]!;
    expect(active.status).toBe("active");

    const res = await send("DELETE", `/api/v1/mailboxes/${active.id}`, { delete_maildir: false });
    expect(res.statusCode, res.body).toBe(202);
    expect(data<{ job: Job }>(res).job.type).toBe("mail.mailbox.delete");
    // Queued, not removed: the record goes once the host confirms.
    expect(
      await handle.db.select().from(mailboxes).where(eq(mailboxes.id, active.id)),
    ).toHaveLength(1);
  });
});

/* -------------------------------- aliases ------------------------------- */

describe("aliases", () => {
  let alias: MailAlias;

  it("stores the address lower-cased", async () => {
    const res = await send("POST", "/api/v1/mail-aliases", {
      mail_domain_id: domain.id,
      address: "Team@FutureForge.dev",
      destinations: ["Hello@futureforge.dev"],
    });
    expect(res.statusCode, res.body).toBe(202);
    const list = data<MailAlias[]>(await get("/api/v1/mail-aliases?q=team"));
    alias = list.find((row) => row.address === "team@futureforge.dev")!;
    expect(alias).toBeDefined();
    expect(alias.destinations).toEqual(["hello@futureforge.dev"]);
  });

  it("refuses to create or edit an alias out of its domain", async () => {
    const created = await send("POST", "/api/v1/mail-aliases", {
      mail_domain_id: domain.id,
      address: "ceo@other-domain.example",
      destinations: ["hello@futureforge.dev"],
    });
    expect(created.statusCode).toBe(409);
    expect(error(created).message).toContain("is not an address in futureforge.dev");

    const edited = await send("PATCH", `/api/v1/mail-aliases/${alias.id}`, {
      address: "ceo@other-domain.example",
    });
    expect(edited.statusCode).toBe(409);
    expect(error(edited).message).toContain("is not an address in futureforge.dev");
  });

  it("refuses an edit onto an address that is already aliased, in any case", async () => {
    const res = await send("PATCH", `/api/v1/mail-aliases/${alias.id}`, {
      address: "Admin@futureforge.dev",
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(error(res).message).toContain("already aliased");
  });

  it("lets an alias keep its own address on an edit", async () => {
    const res = await send("PATCH", `/api/v1/mail-aliases/${alias.id}`, {
      address: alias.address,
      enabled: false,
    });
    expect(res.statusCode, res.body).toBe(202);
  });

  it("recognises the database's own duplicate refusal", async () => {
    // The route's check runs first, so the index only fires on a race;
    // this is the detector that turns that race into a 409.
    let caught: unknown = null;
    try {
      await handle.db
        .insert(mailAliases)
        .values({ mailDomainId: domain.id, address: alias.address, destinations: ["x@y.z"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isUniqueViolation(new Error("something else"))).toBe(false);
  });
});

/* ------------------------------- forwarders ----------------------------- */

describe("forwarders", () => {
  let forwarder: MailForwarder;

  it("stores both ends lower-cased", async () => {
    const res = await send("POST", "/api/v1/mail-forwarders", {
      mail_domain_id: domain.id,
      source: "Press@futureforge.dev",
      destination: "PR@agency.example",
    });
    expect(res.statusCode, res.body).toBe(202);
    const list = data<MailForwarder[]>(await get("/api/v1/mail-forwarders?q=press"));
    forwarder = list.find((row) => row.source === "press@futureforge.dev")!;
    expect(forwarder.destination).toBe("pr@agency.example");
  });

  it("refuses a loop and a duplicate pair on create and on edit alike", async () => {
    const loop = await send("POST", "/api/v1/mail-forwarders", {
      mail_domain_id: domain.id,
      source: "loop@futureforge.dev",
      destination: "Loop@futureforge.dev",
    });
    expect(loop.statusCode).toBe(409);
    expect(error(loop).message).toContain("forwards to itself");

    const editedLoop = await send("PATCH", `/api/v1/mail-forwarders/${forwarder.id}`, {
      destination: forwarder.source,
    });
    expect(editedLoop.statusCode).toBe(409);
    expect(error(editedLoop).message).toContain("forwards to itself");

    // Seeded: invoices@futureforge.dev -> billing@futureforge.dev.
    const duplicate = await send("PATCH", `/api/v1/mail-forwarders/${forwarder.id}`, {
      source: "invoices@futureforge.dev",
      destination: "billing@futureforge.dev",
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(error(duplicate).message).toContain("already forwards to");

    const outside = await send("PATCH", `/api/v1/mail-forwarders/${forwarder.id}`, {
      source: "press@elsewhere.example",
    });
    expect(outside.statusCode).toBe(409);

    const unchanged = await handle.db
      .select({ source: mailForwarders.source })
      .from(mailForwarders)
      .where(eq(mailForwarders.id, forwarder.id));
    expect(unchanged[0]?.source).toBe("press@futureforge.dev");
  });
});

/* ---------------------------- DNS authentication ------------------------ */

describe("mail-auth", () => {
  it("only accepts an IP address as the resolver", async () => {
    const bad = await send("POST", "/api/v1/mail-auth/check", {
      mail_domain_id: domain.id,
      resolver: "dns.example.com",
    });
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.body).error.fields.resolver).toBeTruthy();

    const ok = await send("POST", "/api/v1/mail-auth/check", {
      mail_domain_id: domain.id,
      resolver: "1.1.1.1",
    });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(data<{ job: Job }>(ok).job.type).toBe("mail.auth.check");
  });
});

/* -------------------------------- live tail ----------------------------- */

/** Stands in for the agent's socket and answers a mail.logs request as scripted. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  script: ((frame: Record<string, unknown>) => void) | null = null;

  send(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.t === "req") queueMicrotask(() => this.script?.(frame));
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.emit("close");
  }

  receive(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

function hello(capabilities: string[]) {
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
      arch: "x86_64",
      kernel: "6.1.0",
      boot_time: "2026-01-01T00:00:00Z",
      simulated: true,
    },
  };
}

function connect(capabilities: string[]): FakeSocket {
  const socket = new FakeSocket();
  ctx.hub.register(domain.server_id, socket as unknown as WebSocket, null);
  socket.receive(hello(capabilities));
  return socket;
}

describe("mail log tail", () => {
  const tailUrl = () => `/api/v1/mail-logs/tail?server_id=${domain.server_id}&lines=5`;

  it("answers agent_offline as JSON when no agent is connected", async () => {
    const res = await get(tailUrl());
    expect(res.statusCode).toBe(503);
    expect(error(res).code).toBe("agent_offline");
  });

  it("refuses a host without a mail stack before the stream opens", async () => {
    connect(["systemd"]);
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(501);
      expect(error(res).code).toBe("agent_unsupported");
      expect(error(res).remediation?.summary).toBeTruthy();
    } finally {
      ctx.hub.disconnect(domain.server_id, "test over");
    }
  });

  it("streams lines and ends cleanly when the host does", async () => {
    const socket = connect(["systemd", "mail"]);
    socket.script = (frame) => {
      expect(frame.method).toBe("mail.logs");
      expect(frame.params).toMatchObject({ lines: 5, follow: true });
      const id = String(frame.id);
      socket.receive({ t: "chk", id, seq: 0, data: "postfix/smtp[1]: status=sent\n" });
      socket.receive({ t: "res", id, ok: true, result: { records: [] } });
      socket.receive({ t: "end", id, ok: true });
    };
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body).toContain("event: mail.log");
      expect(res.body).toContain("status=sent");
      expect(res.body).not.toContain("event: error");
    } finally {
      ctx.hub.disconnect(domain.server_id, "test over");
    }
  });

  it("treats the per-follow deadline as a rotation, not a failure", async () => {
    const socket = connect(["systemd", "mail"]);
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
      ctx.hub.disconnect(domain.server_id, "test over");
    }
  });

  it("names a real failure in an error frame with its code", async () => {
    const socket = connect(["systemd", "mail"]);
    socket.script = (frame) => {
      socket.receive({
        t: "res",
        id: String(frame.id),
        ok: false,
        error: { code: "not_found", message: "no mail log on this host" },
      });
    };
    try {
      const res = await get(tailUrl());
      expect(res.statusCode).toBe(200);
      const frame = /event: error\ndata: (.*)\n/.exec(res.body);
      expect(frame).not.toBeNull();
      expect(JSON.parse(frame![1]!)).toEqual({
        code: "agent_error",
        message: "no mail log on this host",
      });
    } finally {
      ctx.hub.disconnect(domain.server_id, "test over");
    }
  });
});
