import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { createDb, eq, type DbHandle } from "@kaname/db";
import { migrateHandle } from "@kaname/db/migrate";
import { seedDemo } from "@kaname/db/seed";
import { notificationChannels, secrets, servers, settings } from "@kaname/db/schema";
import type { SettingsDocument } from "@kaname/contract";
import { loadConfig, resetConfigForTests } from "./config.js";
import { createContext, type AppContext } from "./context.js";
import { buildServer } from "./server.js";
import { bootstrap } from "./bootstrap.js";
import {
  NOTIFICATION_KEYS,
  signWebhook,
  type MailEnvelope,
  type Mailer,
  type ResolvedSmtp,
} from "./services/notifications.js";

/* ------------------------------------------------------------------ *
 * Notifications.
 *
 * What is defended here: a domain event on the bus reaches every
 * channel that asked for it and no channel that did not, deliveries
 * are signed, flapping is quiet, and the SMTP password never comes
 * back out of the API.
 * ------------------------------------------------------------------ */

const PASSWORD = "kaname-notifications-test-owner";

interface Posted {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let handle: DbHandle;
let ctx: AppContext;
let app: FastifyInstance;
let cookie: string;

const posted: Posted[] = [];
const mailed: MailEnvelope[] = [];
const mailers: ResolvedSmtp[] = [];
let failNextPost = false;

const fakeFetch: typeof fetch = async (input, init) => {
  posted.push({
    url: String(input),
    headers: Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    ),
    body: String(init?.body ?? ""),
  });
  if (failNextPost) {
    failNextPost = false;
    return new Response("nope", { status: 500 });
  }
  return new Response("ok", { status: 200 });
};

const fakeMailer = (smtp: ResolvedSmtp): Mailer => {
  mailers.push(smtp);
  return {
    async send(mail) {
      if (smtp.host === "broken.example") throw new Error("connect ECONNREFUSED");
      mailed.push(mail);
    },
    close() {},
  };
};

beforeAll(async () => {
  resetConfigForTests();
  const config = loadConfig({
    KANAME_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    KANAME_BOOTSTRAP_EMAIL: "owner@kaname.test",
    KANAME_BOOTSTRAP_PASSWORD: PASSWORD,
    JOB_WORKER_ENABLED: "false",
    AGENT_OFFLINE_AFTER_SECONDS: "1",
    LOG_LEVEL: "fatal",
  } as NodeJS.ProcessEnv);

  handle = await createDb(config.DATABASE_URL);
  await migrateHandle(handle);

  ctx = createContext(
    { config, log: pino({ level: "fatal" }), dbHandle: handle },
    {},
    { fetch: fakeFetch, mailer: fakeMailer },
  );
  await ctx.ca.load();
  await bootstrap(ctx);
  await seedDemo(handle.db);
  ctx.notifications.start();

  app = await buildServer(ctx);
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@kaname.test", password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}, 120_000);

afterAll(async () => {
  ctx?.notifications.stop();
  await app?.close();
  await handle?.close();
  resetConfigForTests();
});

async function firstServer(): Promise<{ id: string; name: string }> {
  const rows = await handle.db
    .select({ id: servers.id, name: servers.name })
    .from(servers)
    .orderBy(servers.name)
    .limit(1);
  return rows[0]!;
}

async function channel(
  overrides: Partial<typeof notificationChannels.$inferInsert> & { name: string },
): Promise<string> {
  const [row] = await handle.db
    .insert(notificationChannels)
    .values({
      kind: "webhook",
      config: { target: "https://hooks.example/kaname" },
      events: ["job_failed"],
      enabled: true,
      ...overrides,
    })
    .returning({ id: notificationChannels.id });
  ctx.notifications.invalidate();
  return row!.id;
}

async function drain(): Promise<void> {
  // Routing is fire-and-forget; give it a tick to enqueue, then wait.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await ctx.notifications.idle();
}

describe("routing", () => {
  it("delivers a failed job to a subscribed webhook and signs it", async () => {
    const id = await channel({ name: "ops-hook" });
    await ctx.notifications.invalidate();
    // Give the webhook a signing secret through the settings API.
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: {
        notifications: {
          channels: [
            {
              id,
              name: "ops-hook",
              kind: "webhook",
              target: "https://hooks.example/kaname",
              events: ["job_failed", "server_offline"],
              enabled: true,
              secret: "s3cret",
            },
          ],
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const doc = JSON.parse(res.body).data as SettingsDocument;
    const saved = doc.notifications.channels.find((c) => c.id === id)!;
    expect(saved.secret_set).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("s3cret");

    posted.length = 0;
    const server = await firstServer();
    ctx.events.publish(
      "jobs",
      "job.failed",
      {
        job_id: "00000000-0000-0000-0000-000000000001",
        job_type: "service.restart",
        server_id: server.id,
        error: { code: "unit_failed", message: "nginx.service exited 1" },
      },
      server.id,
    );
    await drain();

    expect(posted).toHaveLength(1);
    const hook = posted[0]!;
    expect(hook.url).toBe("https://hooks.example/kaname");
    expect(hook.headers["x-kaname-event"]).toBe("job_failed");
    const payload = JSON.parse(hook.body) as {
      event: string;
      title: string;
      server: { name: string };
    };
    expect(payload.event).toBe("job_failed");
    expect(payload.title).toContain("Restart service failed");
    expect(payload.server.name).toBe(server.name);

    const signature = hook.headers["x-kaname-signature"];
    const ts = hook.headers["x-kaname-timestamp"];
    expect(signature).toBe(`sha256=${signWebhook("s3cret", ts!, hook.body)}`);

    const [row] = await handle.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id));
    expect(row!.lastDeliveryAt).not.toBeNull();
    expect(row!.lastError).toBeNull();
  });

  it("does not deliver the same job twice, nor to channels not subscribed", async () => {
    posted.length = 0;
    await channel({ name: "quiet", events: ["backup_failed"] });
    ctx.events.publish("jobs", "job.failed", {
      job_id: "00000000-0000-0000-0000-000000000001",
      job_type: "service.restart",
      error: { code: "x", message: "again" },
    });
    await drain();
    expect(posted).toHaveLength(0);
  });

  it("a backup job failure reaches both backup_failed and job_failed subscribers once each", async () => {
    posted.length = 0;
    ctx.events.publish("jobs", "job.failed", {
      job_id: "00000000-0000-0000-0000-000000000002",
      job_type: "backup.run",
      error: { code: "disk_full", message: "no space left" },
    });
    await drain();
    const events = posted.map((p) => (JSON.parse(p.body) as { event: string }).event);
    expect(events.sort()).toEqual(["backup_failed", "backup_failed"]);
    expect(posted).toHaveLength(2);
  });

  it("records a delivery error on the channel instead of throwing", async () => {
    posted.length = 0;
    failNextPost = true;
    ctx.events.publish("jobs", "job.failed", {
      job_id: "00000000-0000-0000-0000-000000000003",
      job_type: "service.restart",
      error: { code: "x", message: "boom" },
    });
    await drain();
    const rows = await handle.db.select().from(notificationChannels);
    const failed = rows.find((r) => r.lastError !== null);
    expect(failed?.lastError).toContain("500");
  });

  it("waits out the grace period before reporting a server offline, and reports recovery", async () => {
    posted.length = 0;
    const server = await firstServer();
    ctx.events.publish("servers", "server.disconnected", { server_id: server.id }, server.id);
    await drain();
    expect(posted).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await drain();
    const offline = posted.filter(
      (p) => (JSON.parse(p.body) as { event: string }).event === "server_offline",
    );
    expect(offline).toHaveLength(1);
    expect((JSON.parse(offline[0]!.body) as { title: string }).title).toContain("went offline");

    posted.length = 0;
    ctx.events.publish("servers", "server.connected", { server_id: server.id }, server.id);
    await drain();
    expect(posted).toHaveLength(1);
    expect((JSON.parse(posted[0]!.body) as { title: string }).title).toContain("back online");
  });

  it("a reconnect inside the grace period is silent", async () => {
    posted.length = 0;
    const server = await firstServer();
    ctx.events.publish("servers", "server.disconnected", { server_id: server.id }, server.id);
    ctx.events.publish("servers", "server.connected", { server_id: server.id }, server.id);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await drain();
    expect(posted).toHaveLength(0);
  });

  it("announces an available update once per version", async () => {
    posted.length = 0;
    await channel({ name: "updates", events: ["update_available"] });
    ctx.events.publish("updates", "update.available", { version: "9.9.9", breaking: true });
    ctx.events.publish("updates", "update.available", { version: "9.9.9", breaking: true });
    await drain();
    await drain();
    expect(posted).toHaveLength(1);
    expect((JSON.parse(posted[0]!.body) as { title: string }).title).toContain("9.9.9");
    const [state] = await handle.db
      .select()
      .from(settings)
      .where(eq(settings.key, NOTIFICATION_KEYS.STATE_KEY));
    expect((state!.value as { last_update_notified: string }).last_update_notified).toBe("9.9.9");
  });
});

describe("smtp settings and email", () => {
  it("stores the password sealed and never returns it", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: {
        notifications: {
          smtp: {
            host: "smtp.example",
            port: 465,
            security: "tls",
            username: "kaname",
            password: "hunter2",
            from_address: "kaname@example.com",
            from_name: "Kaname",
          },
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const doc = JSON.parse(res.body).data as SettingsDocument;
    expect(doc.notifications.smtp.host).toBe("smtp.example");
    expect(doc.notifications.smtp.password_set).toBe(true);
    expect(res.body).not.toContain("hunter2");

    const [row] = await handle.db
      .select()
      .from(secrets)
      .where(eq(secrets.ref, NOTIFICATION_KEYS.SMTP_SECRET_REF));
    expect(row).toBeDefined();
    expect(row!.ciphertext).not.toContain("hunter2");

    const [stored] = await handle.db
      .select()
      .from(settings)
      .where(eq(settings.key, NOTIFICATION_KEYS.SMTP_KEY));
    expect(JSON.stringify(stored!.value)).not.toContain("hunter2");
  });

  it("sends a test email with the stored password", async () => {
    mailed.length = 0;
    mailers.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/settings/notifications/smtp/test",
      headers: { cookie },
      payload: { to: "ops@example.com" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).data.ok).toBe(true);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.to).toBe("ops@example.com");
    expect(mailed[0]!.subject).toContain("Test email");
    expect(mailers[0]!.password).toBe("hunter2");
    expect(mailers[0]!.security).toBe("tls");
  });

  it("reports why a test email failed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/settings/notifications/smtp/test",
      headers: { cookie },
      payload: { to: "ops@example.com", smtp: { host: "broken.example" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const result = JSON.parse(res.body).data as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("delivers an event to an email channel through the configured server", async () => {
    mailed.length = 0;
    posted.length = 0;
    const id = await channel({
      name: "mail-ops",
      kind: "email",
      config: { target: "oncall@example.com" },
      events: ["threat_detected"],
    });
    const server = await firstServer();
    ctx.events.publish(
      "threats",
      "threat.detected",
      {
        server_id: server.id,
        kind: "ssh_bruteforce",
        source_ip: "203.0.113.9",
        target: "sshd",
        attempts: 40,
      },
      server.id,
    );
    await drain();
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.to).toBe("oncall@example.com");
    expect(mailed[0]!.subject).toContain("203.0.113.9");
    expect(mailed[0]!.from).toContain("kaname@example.com");

    // The per-channel test endpoint works the same way.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/settings/notifications/${id}/test`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).data.ok).toBe(true);
    expect(mailed).toHaveLength(2);
  });

  it("refuses a channel without a valid target and requires the permission", async () => {
    const bad = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      headers: { cookie },
      payload: {
        notifications: {
          channels: [
            {
              id: "00000000-0000-0000-0000-00000000aaaa",
              name: "typo",
              kind: "email",
              target: "not-an-address",
              events: [],
              enabled: true,
            },
          ],
        },
      },
    });
    expect(bad.statusCode).toBe(422);

    const anon = await app.inject({
      method: "POST",
      url: "/api/v1/settings/notifications/smtp/test",
      payload: { to: "ops@example.com" },
    });
    expect(anon.statusCode).toBe(401);
  });
});
