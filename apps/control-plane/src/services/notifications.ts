import { createHmac, randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { and, eq, gt, inArray, lt, type Database } from "@kaname/db";
import {
  certificates,
  jobs,
  notificationChannels,
  secrets,
  servers,
  settings,
} from "@kaname/db/schema";
import {
  JOB_SPECS,
  type JobType,
  type NotificationChannel,
  type NotificationChannelInput,
  type NotificationEvent,
  type NotificationTestResult,
  type SmtpSettings,
  type SmtpSettingsInput,
} from "@kaname/contract";
import { conflict } from "../lib/errors.js";
import { open, seal } from "../lib/crypto.js";
import type { AppContext } from "../context.js";
import type { EventTopic, StreamEvent } from "./events.js";

/* ------------------------------------------------------------------ *
 * Notifications.
 *
 * The panel already learns about everything over the event bus; this
 * service listens to the same bus and turns the events an operator
 * asked about into an email, a signed webhook or a Slack message.
 *
 * Three rules keep it from becoming the thing people mute:
 *
 *  - It never throws into a publisher. A broken SMTP server is a
 *    `last_error` on the channel, not a failed job.
 *  - It is quiet about flapping. A server has to stay gone for the
 *    offline grace period before anyone hears about it, a repeated
 *    threat from the same address is one message an hour, and every
 *    channel has a ceiling on deliveries per ten minutes.
 *  - Nothing here reaches a managed host. Delivery is outbound SMTP
 *    and HTTPS from the control plane, which already makes outbound
 *    requests for release manifests and ACME.
 * ------------------------------------------------------------------ */

const SMTP_KEY = "smtp";
const STATE_KEY = "notifications.state";
const SMTP_SECRET_REF = "settings.smtp.password";

const CHANNEL_CACHE_MS = 15_000;
const MAX_QUEUE = 500;
const CONCURRENCY = 2;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_PER_WINDOW = 30;
const DEDUPE_MAX_KEYS = 4000;
const MAX_ERROR_LENGTH = 500;
const DELIVERY_TIMEOUT_MS = 15_000;
const CERT_SWEEP_MS = 24 * 60 * 60_000;
const CERT_WARN_DAYS = 14;

const HOUR = 60 * 60_000;

export interface NotificationMessage {
  event: NotificationEvent;
  /** Other subscriptions this message satisfies (a backup failure is also a job failure). */
  also?: readonly NotificationEvent[];
  title: string;
  body: string;
  serverId?: string | null;
  serverName?: string | null;
  /** Panel path the message links to. */
  href?: string;
  /** Same key inside `windowMs` is sent once. */
  key?: string;
  windowMs?: number;
  /** When set, only these channel ids may receive it (an alert rule's own routing). */
  channels?: readonly string[];
  data?: Record<string, unknown>;
}

export interface MailEnvelope {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: MailEnvelope): Promise<void>;
  close(): void;
}

export interface ResolvedSmtp extends SmtpSettings {
  password: string | null;
}

export interface NotificationServiceDeps {
  fetch?: typeof globalThis.fetch;
  /** Builds the mail transport; tests substitute a recorder. */
  mailer?: (smtp: ResolvedSmtp) => Mailer;
}

interface ChannelRow {
  id: string;
  name: string;
  kind: NotificationChannel["kind"];
  target: string;
  events: Set<string>;
  enabled: boolean;
  secretRef: string | null;
}

interface Delivery {
  id: string;
  channel: ChannelRow;
  message: NotificationMessage;
}

interface PersistedState {
  last_update_notified?: string;
}

interface OfflineState {
  timer: NodeJS.Timeout | null;
  notified: boolean;
}

/* ------------------------------------------------------------------ */

export class NotificationService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly makeMailer: (smtp: ResolvedSmtp) => Mailer;

  private listeners: Array<[EventTopic, (event: StreamEvent) => void]> = [];
  private certTimer: NodeJS.Timeout | null = null;
  private started = false;

  private channelCache: { at: number; rows: ChannelRow[] } | null = null;
  private mailer: { signature: string; instance: Mailer } | null = null;

  private readonly queue: Delivery[] = [];
  private inFlight = 0;
  private idleWaiters: Array<() => void> = [];

  private readonly recent = new Map<string, number>();
  private readonly rate = new Map<string, number[]>();
  private readonly offline = new Map<string, OfflineState>();
  private dropped = 0;

  constructor(
    private readonly ctx: AppContext,
    deps: NotificationServiceDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.makeMailer = deps.mailer ?? smtpMailer;
  }

  /* ---------------------------- lifecycle --------------------------- */

  start(): void {
    if (this.started) return;
    this.started = true;

    this.listen("jobs", (event) => this.onJob(event));
    this.listen("servers", (event) => this.onServer(event));
    this.listen("services", (event) => this.onService(event));
    this.listen("threats", (event) => this.onThreat(event));
    this.listen("alerts", (event) => this.onAlert(event));
    this.listen("updates", (event) => this.onUpdate(event));

    // Certificates Kaname issued are in the database; the agent only
    // reports the ones it finds on disk. Both end up as the same event.
    this.certTimer = setInterval(() => void this.sweepCertificates(), CERT_SWEEP_MS);
    this.certTimer.unref?.();
    const first = setTimeout(() => void this.sweepCertificates(), 5 * 60_000);
    first.unref?.();
  }

  stop(): void {
    for (const [topic, handler] of this.listeners) this.ctx.events.off(topic, handler);
    this.listeners = [];
    if (this.certTimer) clearInterval(this.certTimer);
    this.certTimer = null;
    for (const state of this.offline.values()) if (state.timer) clearTimeout(state.timer);
    this.offline.clear();
    this.queue.length = 0;
    this.mailer?.instance.close();
    this.mailer = null;
    this.started = false;
  }

  /** Called after channels or SMTP settings change. */
  invalidate(): void {
    this.channelCache = null;
    this.mailer?.instance.close();
    this.mailer = null;
  }

  /** Resolves once every queued delivery has been attempted. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private listen(topic: EventTopic, handler: (event: StreamEvent) => Promise<void> | void): void {
    const wrapped = (event: StreamEvent): void => {
      try {
        const result = handler(event);
        if (result && typeof result.catch === "function") {
          result.catch((err: unknown) =>
            this.ctx.log.warn({ err, topic, type: event.type }, "notification handler failed"),
          );
        }
      } catch (err) {
        this.ctx.log.warn({ err, topic, type: event.type }, "notification handler failed");
      }
    };
    this.ctx.events.on(topic, wrapped);
    this.listeners.push([topic, wrapped]);
  }

  /* ----------------------------- routing ---------------------------- */

  /**
   * Queues a message for every enabled channel subscribed to it. Safe to
   * call from anywhere: it never throws and never blocks the caller.
   */
  notify(message: NotificationMessage): void {
    void this.route(message).catch((err) =>
      this.ctx.log.warn({ err, event: message.event }, "notification routing failed"),
    );
  }

  private async route(message: NotificationMessage): Promise<void> {
    if (message.key && !this.remember(message.key, message.windowMs ?? HOUR)) return;

    const wanted = new Set<string>([message.event, ...(message.also ?? [])]);
    const only = message.channels && message.channels.length > 0 ? new Set(message.channels) : null;
    const channels = (await this.loadChannels()).filter(
      (channel) =>
        channel.enabled &&
        (!only || only.has(channel.id)) &&
        [...wanted].some((event) => channel.events.has(event)),
    );
    if (channels.length === 0) return;

    for (const channel of channels) {
      if (!this.withinRate(channel.id)) {
        this.ctx.log.warn(
          { channel: channel.name, event: message.event },
          "notification suppressed: channel rate limit",
        );
        continue;
      }
      if (this.queue.length >= MAX_QUEUE) {
        this.queue.shift();
        this.dropped += 1;
        if (this.dropped % 50 === 1) {
          this.ctx.log.warn({ dropped: this.dropped }, "notification queue full; dropping oldest");
        }
      }
      this.queue.push({ id: randomUUID(), channel, message });
    }
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < CONCURRENCY && this.queue.length > 0) {
      const delivery = this.queue.shift()!;
      this.inFlight += 1;
      void this.deliver(delivery.channel, delivery.message, delivery.id)
        .then(async (result) => {
          await this.recordOutcome(delivery.channel.id, result);
        })
        .catch((err) => this.ctx.log.warn({ err }, "notification delivery crashed"))
        .finally(() => {
          this.inFlight -= 1;
          if (this.queue.length === 0 && this.inFlight === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const resolve of waiters) resolve();
          } else {
            this.pump();
          }
        });
    }
  }

  private async recordOutcome(channelId: string, result: NotificationTestResult): Promise<void> {
    try {
      await this.ctx.db
        .update(notificationChannels)
        .set(
          result.ok
            ? { lastDeliveryAt: new Date(), lastError: null }
            : { lastError: (result.error ?? "delivery failed").slice(0, MAX_ERROR_LENGTH) },
        )
        .where(eq(notificationChannels.id, channelId));
    } catch (err) {
      this.ctx.log.warn({ err, channelId }, "could not record notification outcome");
    }
    if (!result.ok) {
      this.ctx.log.warn({ channelId, error: result.error }, "notification delivery failed");
    }
  }

  /* ---------------------------- throttling -------------------------- */

  /** True the first time a key is seen inside its window. */
  private remember(key: string, windowMs: number): boolean {
    const now = Date.now();
    const until = this.recent.get(key);
    if (until !== undefined && until > now) return false;
    if (windowMs > 0) {
      this.recent.set(key, now + windowMs);
      this.pruneRecent(now);
    }
    return true;
  }

  private pruneRecent(now: number): void {
    if (this.recent.size <= DEDUPE_MAX_KEYS) return;
    for (const [key, until] of this.recent) {
      if (until <= now) this.recent.delete(key);
    }
    // Still over: the oldest insertions go first. Map iterates in insertion order.
    while (this.recent.size > DEDUPE_MAX_KEYS) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  private withinRate(channelId: string): boolean {
    const now = Date.now();
    const stamps = (this.rate.get(channelId) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (stamps.length >= RATE_MAX_PER_WINDOW) {
      this.rate.set(channelId, stamps);
      return false;
    }
    stamps.push(now);
    this.rate.set(channelId, stamps);
    return true;
  }

  /* ---------------------------- channels ---------------------------- */

  private async loadChannels(): Promise<ChannelRow[]> {
    const now = Date.now();
    if (this.channelCache && now - this.channelCache.at < CHANNEL_CACHE_MS) {
      return this.channelCache.rows;
    }
    const rows = await this.ctx.db.select().from(notificationChannels);
    const mapped = rows.map(toChannelRow);
    this.channelCache = { at: now, rows: mapped };
    return mapped;
  }

  private async channelById(id: string): Promise<ChannelRow | null> {
    const rows = await this.ctx.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .limit(1);
    return rows[0] ? toChannelRow(rows[0]) : null;
  }

  /* ---------------------------- delivery ---------------------------- */

  private async deliver(
    channel: ChannelRow,
    message: NotificationMessage,
    deliveryId: string,
  ): Promise<NotificationTestResult> {
    const started = Date.now();
    try {
      switch (channel.kind) {
        case "email":
          await this.deliverEmail(channel, message);
          break;
        case "webhook":
          await this.deliverWebhook(channel, message, deliveryId);
          break;
        case "slack":
          await this.deliverSlack(channel, message);
          break;
      }
      return { ok: true, error: null, duration_ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: describe(err), duration_ms: Date.now() - started };
    }
  }

  private async deliverEmail(channel: ChannelRow, message: NotificationMessage): Promise<void> {
    const smtp = await loadSmtp(this.ctx);
    const mailer = this.mailerFor(smtp);
    const panel = await this.panel();
    await mailer.send(composeMail(smtp, channel.target, message, panel));
  }

  private mailerFor(smtp: ResolvedSmtp): Mailer {
    if (!smtp.host) {
      throw new Error(
        "No outgoing mail server is configured. Set one under Administration > Settings > Notifications.",
      );
    }
    if (!smtp.from_address) {
      throw new Error("The outgoing mail server has no sender address.");
    }
    const signature = JSON.stringify(smtp);
    if (this.mailer && this.mailer.signature === signature) return this.mailer.instance;
    this.mailer?.instance.close();
    this.mailer = { signature, instance: this.makeMailer(smtp) };
    return this.mailer.instance;
  }

  private async deliverWebhook(
    channel: ChannelRow,
    message: NotificationMessage,
    deliveryId: string,
  ): Promise<void> {
    const panel = await this.panel();
    const body = JSON.stringify({
      id: deliveryId,
      event: message.event,
      title: message.title,
      message: message.body,
      server: message.serverId ? { id: message.serverId, name: message.serverName ?? null } : null,
      url: message.href ? `${panel.url}${message.href}` : panel.url,
      panel: panel.name,
      ts: new Date().toISOString(),
      data: message.data ?? {},
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": `kaname/${this.ctx.config.KANAME_VERSION}`,
      "x-kaname-event": message.event,
      "x-kaname-delivery": deliveryId,
    };
    const secret = channel.secretRef ? await readSecret(this.ctx, channel.secretRef) : null;
    if (secret) {
      const ts = String(Math.floor(Date.now() / 1000));
      headers["x-kaname-timestamp"] = ts;
      headers["x-kaname-signature"] = `sha256=${signWebhook(secret, ts, body)}`;
    }

    await this.post(channel.target, headers, body);
  }

  private async deliverSlack(channel: ChannelRow, message: NotificationMessage): Promise<void> {
    const panel = await this.panel();
    const link = message.href ? `\n<${panel.url}${message.href}|Open in ${panel.name}>` : "";
    const where = message.serverName ? ` · ${message.serverName}` : "";
    const body = JSON.stringify({
      text: `*${message.title}*${where}\n${message.body}${link}`,
    });
    await this.post(
      channel.target,
      {
        "content-type": "application/json",
        "user-agent": `kaname/${this.ctx.config.KANAME_VERSION}`,
      },
      body,
    );
  }

  private async post(url: string, headers: Record<string, string>, body: string): Promise<void> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `The endpoint answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}.`,
      );
    }
  }

  private async panel(): Promise<{ name: string; url: string }> {
    const rows = await this.ctx.db.select().from(settings).where(eq(settings.key, "panel"));
    const stored = (rows[0]?.value ?? {}) as { name?: string; url?: string };
    return {
      name: stored.name || "Kaname",
      url: (stored.url || this.ctx.config.KANAME_PUBLIC_URL).replace(/\/+$/, ""),
    };
  }

  /* ------------------------------ tests ----------------------------- */

  async sendTest(channelId: string): Promise<NotificationTestResult> {
    const channel = await this.channelById(channelId);
    if (!channel) return { ok: false, error: "That channel no longer exists.", duration_ms: 0 };
    const panel = await this.panel();
    const result = await this.deliver(
      channel,
      {
        event: "job_failed",
        title: `Test notification from ${panel.name}`,
        body: `This is a test message for the "${channel.name}" channel. If you can read it, deliveries to this channel work.`,
        href: "/administration/settings",
        data: { test: true },
      },
      randomUUID(),
    );
    await this.recordOutcome(channel.id, result);
    return result;
  }

  async sendTestEmail(to: string, draft?: SmtpSettingsInput): Promise<NotificationTestResult> {
    const started = Date.now();
    try {
      const stored = await loadSmtp(this.ctx);
      const smtp: ResolvedSmtp = {
        ...stored,
        ...stripUndefined(draft ?? {}),
        password:
          draft?.password === undefined
            ? stored.password
            : draft.password === null
              ? null
              : draft.password,
        password_set: false,
      };
      smtp.password_set = Boolean(smtp.password);
      if (!smtp.host) throw new Error("Enter the mail server's host name first.");
      if (!smtp.from_address) throw new Error("Enter the sender address first.");
      const panel = await this.panel();
      const mailer = this.makeMailer(smtp);
      try {
        await mailer.send(
          composeMail(
            smtp,
            to,
            {
              event: "job_failed",
              title: `Test email from ${panel.name}`,
              body: `This message confirms that ${panel.name} can send mail through ${smtp.host}:${smtp.port}.`,
              href: "/administration/settings",
            },
            panel,
          ),
        );
      } finally {
        mailer.close();
      }
      return { ok: true, error: null, duration_ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: describe(err), duration_ms: Date.now() - started };
    }
  }

  /* ---------------------------- handlers ---------------------------- */

  private async onJob(event: StreamEvent): Promise<void> {
    if (event.type !== "job.failed") return;
    const data = event.data as {
      job_id?: string;
      job_type?: string;
      server_id?: string | null;
      error?: { code?: string; message?: string };
    };
    if (!data.job_id) return;

    const rows = await this.ctx.db
      .select({
        type: jobs.type,
        targetLabel: jobs.targetLabel,
        serverId: jobs.serverId,
        error: jobs.error,
      })
      .from(jobs)
      .where(eq(jobs.id, data.job_id))
      .limit(1);
    const job = rows[0];
    const type = (job?.type ?? data.job_type ?? "") as JobType;
    const label = JOB_SPECS[type]?.label ?? type ?? "Job";
    const serverId = job?.serverId ?? data.server_id ?? null;
    const serverName = serverId ? await this.serverName(serverId) : null;
    const error = job?.error ?? data.error ?? null;

    const specific: NotificationEvent | null = type.startsWith("backup.")
      ? "backup_failed"
      : type.startsWith("deployment.")
        ? "deployment_failed"
        : null;

    this.notify({
      event: specific ?? "job_failed",
      also: specific ? ["job_failed"] : [],
      title: `${label} failed${serverName ? ` on ${serverName}` : ""}`,
      body: [
        job?.targetLabel ? `Target: ${job.targetLabel}` : null,
        error ? `${error.code ?? "error"}: ${error.message ?? "no message"}` : "The job failed.",
      ]
        .filter(Boolean)
        .join("\n"),
      serverId,
      serverName,
      href: `/jobs/${data.job_id}`,
      key: `job:${data.job_id}`,
      windowMs: HOUR,
      data: { job_id: data.job_id, job_type: type, error },
    });
  }

  private async onServer(event: StreamEvent): Promise<void> {
    const data = event.data as { server_id?: string; connection?: string };
    const serverId = data.server_id ?? event.serverId;
    if (!serverId) return;

    if (event.type === "server.disconnected") {
      await this.refreshAgentsSetting();
      const state = this.offline.get(serverId) ?? { timer: null, notified: false };
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.reportOffline(serverId, state).catch((err) =>
          this.ctx.log.warn({ err, serverId }, "offline notification failed"),
        );
      }, this.offlineGraceMs());
      state.timer.unref?.();
      this.offline.set(serverId, state);
      return;
    }

    if (event.type === "server.connected") {
      const state = this.offline.get(serverId);
      if (!state) return;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (!state.notified) {
        this.offline.delete(serverId);
        return;
      }
      state.notified = false;
      this.offline.delete(serverId);
      const name = await this.serverName(serverId);
      this.notify({
        event: "server_offline",
        title: `${name ?? "A server"} is back online`,
        body: "The agent reconnected and the server is reachable again.",
        serverId,
        serverName: name,
        href: `/infrastructure/servers/${serverId}`,
        key: `server-online:${serverId}`,
        windowMs: 60_000,
      });
      return;
    }

    if (event.type === "server.connection_changed" && data.connection === "revoked") {
      const state = this.offline.get(serverId);
      if (state?.timer) clearTimeout(state.timer);
      this.offline.delete(serverId);
    }
  }

  private offlineGraceMs(): number {
    const seconds =
      this.agentsSetting?.offline_after_seconds ?? this.ctx.config.AGENT_OFFLINE_AFTER_SECONDS;
    return Math.max(1_000, seconds * 1000);
  }

  private agentsSetting: { offline_after_seconds?: number } | null = null;
  private agentsSettingAt = 0;

  /** The window the operator set under Settings > Agents, not the boot-time default. */
  private async refreshAgentsSetting(): Promise<void> {
    if (Date.now() - this.agentsSettingAt < 60_000) return;
    this.agentsSettingAt = Date.now();
    try {
      const rows = await this.ctx.db.select().from(settings).where(eq(settings.key, "agents"));
      const stored = (rows[0]?.value ?? {}) as { offline_after_seconds?: unknown };
      this.agentsSetting =
        typeof stored.offline_after_seconds === "number"
          ? { offline_after_seconds: stored.offline_after_seconds }
          : {};
    } catch {
      /* keep whatever we had */
    }
  }

  private async reportOffline(serverId: string, state: OfflineState): Promise<void> {
    if (this.ctx.hub.isConnected(serverId)) return;
    const rows = await this.ctx.db
      .select({ name: servers.name, hostname: servers.hostname, revokedAt: servers.revokedAt })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    const server = rows[0];
    if (!server || server.revokedAt) {
      this.offline.delete(serverId);
      return;
    }
    state.notified = true;
    const seconds = Math.round(this.offlineGraceMs() / 1000);
    this.notify({
      event: "server_offline",
      title: `${server.name} went offline`,
      body: `The agent on ${server.hostname} has not reconnected for ${seconds} seconds. Jobs for this server will wait until it is back.`,
      serverId,
      serverName: server.name,
      href: `/infrastructure/servers/${serverId}`,
      key: `server-offline:${serverId}`,
      windowMs: 60_000,
    });
  }

  private async onService(event: StreamEvent): Promise<void> {
    if (event.type !== "service.changed") return;
    const data = event.data as {
      server_id?: string;
      unit?: string;
      state?: string;
      active_state?: string;
    };
    const state = data.active_state ?? data.state;
    if (state !== "failed" || !data.unit) return;
    const serverId = data.server_id ?? event.serverId;
    if (!serverId) return;
    const name = await this.serverName(serverId);
    this.notify({
      event: "service_failed",
      title: `${data.unit} failed${name ? ` on ${name}` : ""}`,
      body: `systemd reports the unit as failed. Restart it from Infrastructure > Services, or read its log first.`,
      serverId,
      serverName: name,
      href: `/infrastructure/services?server_id=${serverId}`,
      key: `service:${serverId}:${data.unit}`,
      windowMs: 30 * 60_000,
      data: { unit: data.unit },
    });
  }

  private async onThreat(event: StreamEvent): Promise<void> {
    if (event.type !== "threat.detected") return;
    const data = event.data as {
      server_id?: string;
      kind?: string;
      source_ip?: string;
      target?: string;
      attempts?: number;
    };
    const serverId = data.server_id ?? event.serverId;
    if (!serverId || !data.source_ip) return;
    const name = await this.serverName(serverId);
    this.notify({
      event: "threat_detected",
      title: `${data.kind ?? "Threat"} from ${data.source_ip}${name ? ` on ${name}` : ""}`,
      body: `${data.attempts ?? "Repeated"} attempts against ${data.target ?? "this host"} in the current window. Block the address from Security > Threat Protection if it keeps going.`,
      serverId,
      serverName: name,
      href: "/security/threats",
      key: `threat:${serverId}:${data.source_ip}`,
      windowMs: HOUR,
      data,
    });
  }

  private async onAlert(event: StreamEvent): Promise<void> {
    const data = event.data as Record<string, unknown> & { server_id?: string };
    const serverId = data.server_id ?? event.serverId;
    const name = serverId ? await this.serverName(serverId) : null;
    const where = name ? ` on ${name}` : "";

    switch (event.type) {
      case "cert.expiring": {
        const subject = String(data.subject ?? "a certificate");
        const days = typeof data.days_remaining === "number" ? data.days_remaining : null;
        this.notify({
          event: "certificate_expiring",
          title: `Certificate for ${subject} expires ${days === null ? "soon" : days <= 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
          body: `${subject}${where} has not been renewed.${data.not_after ? ` It expires ${String(data.not_after)}.` : ""}`,
          serverId,
          serverName: name,
          href: "/websites/ssl",
          key: `cert:${serverId ?? "fleet"}:${subject}:${expiryBucket(days)}`,
          windowMs: 30 * 24 * HOUR,
          data,
        });
        return;
      }
      case "disk.pressure": {
        const mount = String(data.mount ?? "/");
        const used =
          typeof data.used_percent === "number" ? `${Math.round(data.used_percent)}%` : "nearly";
        this.notify({
          event: "alert_firing",
          title: `Disk ${mount}${where} is ${used} full`,
          body: `Free some space or the host will start failing writes.`,
          serverId,
          serverName: name,
          href: "/files/storage",
          key: `disk:${serverId ?? "fleet"}:${mount}`,
          windowMs: 6 * HOUR,
          data,
        });
        return;
      }
      case "log.anomaly": {
        const source = String(data.source ?? data.unit ?? "a log");
        this.notify({
          event: "alert_firing",
          title: `Unusual log activity in ${source}${where}`,
          body: String(data.message ?? data.summary ?? "The agent flagged a burst of errors."),
          serverId,
          serverName: name,
          href: "/logs",
          key: `anomaly:${serverId ?? "fleet"}:${source}`,
          windowMs: HOUR,
          data,
        });
        return;
      }
      case "alert.firing":
      case "alert.resolved": {
        const resolved = event.type === "alert.resolved";
        const channels = Array.isArray(data.channels)
          ? data.channels.filter((id): id is string => typeof id === "string")
          : undefined;
        this.notify({
          event: "alert_firing",
          title: `${resolved ? "Resolved: " : ""}${String(data.title ?? data.rule_name ?? "Alert")}${where}`,
          body: String(data.message ?? ""),
          serverId,
          serverName: name,
          href: "/monitoring",
          key: `alert:${String(data.alert_id ?? "")}:${event.type}`,
          windowMs: 6 * HOUR,
          channels,
          data,
        });
        return;
      }
      default:
        return;
    }
  }

  private async onUpdate(event: StreamEvent): Promise<void> {
    const data = event.data as {
      version?: string;
      breaking?: boolean;
      security?: boolean;
      requires_confirmation?: boolean;
    };

    if (event.type === "update.available" && data.version) {
      const state = await this.loadState();
      if (state.last_update_notified === data.version) return;
      await this.saveState({ ...state, last_update_notified: data.version });
      const flags = [data.security ? "security fix" : null, data.breaking ? "breaking" : null]
        .filter(Boolean)
        .join(", ");
      this.notify({
        event: "update_available",
        title: `Kaname ${data.version} is available${flags ? ` (${flags})` : ""}`,
        body: data.requires_confirmation
          ? "This release needs an explicit confirmation before it is applied. Review it under Administration > Updates."
          : "Apply it under Administration > Updates, or let the update cadence handle it.",
        href: "/administration/updates",
        key: `update-available:${data.version}`,
        windowMs: 24 * HOUR,
        data,
      });
      return;
    }

    if (event.type === "update.check_failed") {
      const error = (event.data as { error?: string }).error ?? "unknown error";
      this.notify({
        event: "update_failed",
        title: "Kaname could not check for updates",
        body: `The release manifest could not be fetched: ${error}. An instance that silently stops checking looks identical to one that is up to date, which is why this is worth a message once a day.`,
        href: "/administration/updates",
        key: "update-check-failed",
        windowMs: 24 * HOUR,
        data: { error },
      });
      return;
    }

    const outcome: Record<string, { event: NotificationEvent; title: string; body: string }> = {
      "update.succeeded": {
        event: "update_applied",
        title: `Updated to Kaname ${data.version ?? ""}`.trim(),
        body: "The control plane came back healthy on the new version.",
      },
      "update.rolled_back": {
        event: "update_failed",
        title: `Update to ${data.version ?? "the new version"} was rolled back`,
        body: "The new build did not answer its health check, so the previous version was restored. The run log has the details.",
      },
      "update.needs_attention": {
        event: "update_failed",
        title: `Update to ${data.version ?? "the new version"} needs attention`,
        body: "The update did not finish cleanly and may have left migrations applied. Read the run under Administration > Updates before doing anything else.",
      },
    };
    const text = outcome[event.type];
    if (!text) return;
    this.notify({
      ...text,
      href: "/administration/updates",
      key: `${event.type}:${data.version ?? ""}`,
      windowMs: HOUR,
      data,
    });
  }

  /* ------------------------------ sweeps ---------------------------- */

  private async sweepCertificates(): Promise<void> {
    try {
      const horizon = new Date(Date.now() + CERT_WARN_DAYS * 24 * HOUR);
      const rows = await this.ctx.db
        .select({
          id: certificates.id,
          subject: certificates.subject,
          expiresAt: certificates.expiresAt,
          serverId: certificates.serverId,
          autoRenew: certificates.autoRenew,
        })
        .from(certificates)
        .where(
          and(
            lt(certificates.expiresAt, horizon),
            gt(certificates.expiresAt, new Date(Date.now() - 24 * HOUR)),
            inArray(certificates.status, ["active", "expiring"]),
          ),
        );
      for (const row of rows) {
        if (!row.expiresAt) continue;
        const days = Math.max(0, Math.floor((row.expiresAt.getTime() - Date.now()) / (24 * HOUR)));
        const name = await this.serverName(row.serverId);
        this.notify({
          event: "certificate_expiring",
          title: `Certificate for ${row.subject} expires ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
          body: row.autoRenew
            ? `Automatic renewal has not produced a new certificate yet. Check Websites > SSL / TLS for the last renewal error.`
            : `Automatic renewal is off for this certificate. Renew it from Websites > SSL / TLS.`,
          serverId: row.serverId,
          serverName: name,
          href: `/websites/ssl/${row.id}`,
          key: `cert:${row.serverId}:${row.subject}:${expiryBucket(days)}`,
          windowMs: 30 * 24 * HOUR,
        });
      }
    } catch (err) {
      this.ctx.log.warn({ err }, "certificate expiry sweep failed");
    }
  }

  /* ----------------------------- helpers ---------------------------- */

  private async serverName(serverId: string): Promise<string | null> {
    const rows = await this.ctx.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  private async loadState(): Promise<PersistedState> {
    const rows = await this.ctx.db.select().from(settings).where(eq(settings.key, STATE_KEY));
    return (rows[0]?.value ?? {}) as PersistedState;
  }

  private async saveState(state: PersistedState): Promise<void> {
    await this.ctx.db
      .insert(settings)
      .values({ key: STATE_KEY, value: state })
      .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: new Date() } });
  }
}

/* ------------------------------------------------------------------ *
 * SMTP settings
 *
 * One settings row for the shape and one sealed secret for the
 * password, so the password never sits in a settings document that is
 * returned to the browser or diffed into the audit trail.
 * ------------------------------------------------------------------ */

const SMTP_DEFAULTS: Omit<SmtpSettings, "password_set"> = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  from_address: "",
  from_name: "Kaname",
};

export async function loadSmtpSettings(ctx: AppContext): Promise<SmtpSettings> {
  const rows = await ctx.db.select().from(settings).where(eq(settings.key, SMTP_KEY));
  const stored = (rows[0]?.value ?? {}) as Partial<Omit<SmtpSettings, "password_set">>;
  const secret = await ctx.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(eq(secrets.ref, SMTP_SECRET_REF))
    .limit(1);
  return {
    ...SMTP_DEFAULTS,
    ...stripUndefined(stored),
    password_set: secret.length > 0,
  };
}

async function loadSmtp(ctx: AppContext): Promise<ResolvedSmtp> {
  const stored = await loadSmtpSettings(ctx);
  const password = stored.password_set ? await readSecret(ctx, SMTP_SECRET_REF) : null;
  return { ...stored, password };
}

export async function saveSmtpSettings(
  ctx: AppContext,
  patch: SmtpSettingsInput,
  updatedBy: string | null,
): Promise<SmtpSettings> {
  const { password, ...shape } = patch;
  const current = await loadSmtpSettings(ctx);
  const next: Omit<SmtpSettings, "password_set"> = {
    host: shape.host ?? current.host,
    port: shape.port ?? current.port,
    security: shape.security ?? current.security,
    username: shape.username ?? current.username,
    from_address: shape.from_address ?? current.from_address,
    from_name: shape.from_name ?? current.from_name,
  };
  await ctx.db
    .insert(settings)
    .values({ key: SMTP_KEY, value: next, updatedBy })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedBy, updatedAt: new Date() },
    });

  if (password === null || (password !== undefined && password.length === 0)) {
    await ctx.db.delete(secrets).where(eq(secrets.ref, SMTP_SECRET_REF));
  } else if (password !== undefined) {
    await writeSecret(ctx, SMTP_SECRET_REF, "settings", null, password);
  }

  ctx.notifications?.invalidate();
  return loadSmtpSettings(ctx);
}

/* ------------------------------------------------------------------ *
 * Channels
 * ------------------------------------------------------------------ */

export async function loadNotificationChannels(db: Database): Promise<NotificationChannel[]> {
  const rows = await db.select().from(notificationChannels).orderBy(notificationChannels.name);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    // Credentials live in `secrets`; only the address is ever returned.
    target: typeof row.config.target === "string" ? row.config.target : "",
    events: row.events as NotificationEvent[],
    enabled: row.enabled,
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    last_error: row.lastError,
    secret_set: Boolean(row.secretRef),
  }));
}

/** The supplied array is the whole set: anything omitted is removed. */
export async function applyNotificationChannels(
  ctx: AppContext,
  next: NotificationChannelInput[],
): Promise<void> {
  const duplicate = next.find((c, i) => next.findIndex((o) => o.name === c.name) !== i);
  if (duplicate) {
    throw conflict(`Two notification channels are both called "${duplicate.name}".`, {
      summary: "Channel names identify them in alerts and must be unique.",
      actions: [],
    });
  }

  const existing = await ctx.db
    .select({ id: notificationChannels.id, secretRef: notificationChannels.secretRef })
    .from(notificationChannels);
  const known = new Map(existing.map((row) => [row.id, row.secretRef] as const));
  const keep = new Set(next.map((c) => c.id));

  for (const channel of next) {
    const ref = `notification.${channel.id}.secret`;
    let secretRef = known.get(channel.id) ?? null;

    if (channel.kind !== "webhook" || channel.secret === null) {
      if (secretRef) await ctx.db.delete(secrets).where(eq(secrets.ref, secretRef));
      secretRef = null;
    } else if (channel.secret) {
      await writeSecret(ctx, ref, "notification_channel", channel.id, channel.secret);
      secretRef = ref;
    }

    const values = {
      name: channel.name,
      kind: channel.kind,
      config: { target: channel.target },
      events: channel.events,
      enabled: channel.enabled,
      secretRef,
    };
    await ctx.db
      .insert(notificationChannels)
      .values({ id: channel.id, ...values })
      .onConflictDoUpdate({
        target: notificationChannels.id,
        set: { ...values, updatedAt: new Date() },
      });
  }

  const removed = existing.filter((row) => !keep.has(row.id));
  if (removed.length > 0) {
    const refs = removed.map((row) => row.secretRef).filter((ref): ref is string => Boolean(ref));
    if (refs.length > 0) await ctx.db.delete(secrets).where(inArray(secrets.ref, refs));
    await ctx.db.delete(notificationChannels).where(
      inArray(
        notificationChannels.id,
        removed.map((row) => row.id),
      ),
    );
  }

  ctx.notifications?.invalidate();
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

async function writeSecret(
  ctx: AppContext,
  ref: string,
  ownerType: string,
  ownerId: string | null,
  plaintext: string,
): Promise<void> {
  const sealed = seal(plaintext, ctx.config.masterKey);
  await ctx.db
    .insert(secrets)
    .values({
      ref,
      ownerType,
      ownerId,
      wrappedKey: sealed.wrappedKey,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
    })
    .onConflictDoUpdate({
      target: secrets.ref,
      set: {
        wrappedKey: sealed.wrappedKey,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        updatedAt: new Date(),
      },
    });
}

async function readSecret(ctx: AppContext, ref: string): Promise<string | null> {
  const rows = await ctx.db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return open(
    {
      wrappedKey: row.wrappedKey,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      keyVersion: row.keyVersion,
    },
    ctx.config.masterKey,
  );
}

/* ------------------------------------------------------------------ *
 * Transport and formatting
 * ------------------------------------------------------------------ */

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function smtpMailer(smtp: ResolvedSmtp): Mailer {
  const transport: Transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth: smtp.username ? { user: smtp.username, pass: smtp.password ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      await transport.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
    close() {
      transport.close();
    },
  };
}

function composeMail(
  smtp: ResolvedSmtp,
  to: string,
  message: NotificationMessage,
  panel: { name: string; url: string },
): MailEnvelope {
  const link = message.href ? `${panel.url}${message.href}` : panel.url;
  const from = smtp.from_name
    ? `"${smtp.from_name.replace(/["\\]/g, "")}" <${smtp.from_address}>`
    : smtp.from_address;
  const where = message.serverName ? `Server: ${message.serverName}\n` : "";

  const text = `${message.title}\n\n${message.body}\n\n${where}Open in ${panel.name}: ${link}\n\n— ${panel.name}`;
  const html = [
    `<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5;color:#1c2024">`,
    `<h2 style="font-size:16px;margin:0 0 12px">${escapeHtml(message.title)}</h2>`,
    `<p style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(message.body)}</p>`,
    message.serverName
      ? `<p style="margin:0 0 12px;color:#6b7280">Server: ${escapeHtml(message.serverName)}</p>`
      : "",
    `<p style="margin:0 0 16px"><a href="${escapeHtml(link)}">Open in ${escapeHtml(panel.name)}</a></p>`,
    `<p style="margin:0;color:#9ba3ae;font-size:12px">Sent by ${escapeHtml(panel.name)}. Change what it sends under Administration &gt; Settings &gt; Notifications.</p>`,
    `</div>`,
  ].join("");

  return { from, to, subject: `[${panel.name}] ${message.title}`, text, html };
}

/**
 * Which warning a certificate is in: one message per threshold, not one
 * per sweep. 14 days out, then 7, 3, 1 and the day itself.
 */
function expiryBucket(days: number | null): string {
  if (days === null) return "soon";
  for (const edge of [0, 1, 3, 7, 14]) if (days <= edge) return String(edge);
  return "far";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const message = err.message || err.name;
    if (err.name === "TimeoutError" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
      return "The endpoint did not answer in time.";
    }
    if (code === "ECONNREFUSED") return `${message} — nothing is listening at that address.`;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      return `${message} — the host name did not resolve.`;
    if (code === "EAUTH") return "The mail server rejected the username or password.";
    return message.slice(0, MAX_ERROR_LENGTH);
  }
  return String(err).slice(0, MAX_ERROR_LENGTH);
}

function toChannelRow(row: typeof notificationChannels.$inferSelect): ChannelRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    target: typeof row.config.target === "string" ? row.config.target : "",
    events: new Set(row.events),
    enabled: row.enabled,
    secretRef: row.secretRef,
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

/** Kept exported for tests and for anything that needs the key names. */
export const NOTIFICATION_KEYS = { SMTP_KEY, STATE_KEY, SMTP_SECRET_REF } as const;
