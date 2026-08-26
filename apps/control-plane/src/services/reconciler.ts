import { and, eq, isNull, lt, sql } from "@kaname/db";
import { alerts, containers, serverMetrics, servers, services } from "@kaname/db/schema";
import type { HealthState, MetricsSample, ThreatObservation } from "@kaname/contract";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * Reconciler.
 *
 * Turns agent-pushed events into control-plane state, and periodically
 * re-derives the two status axes. This is the only writer of
 * `servers.connection` and `servers.health`, which is what keeps them
 * from drifting apart into a single confusing dot (PLAN.md 2.6).
 * ------------------------------------------------------------------ */

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private rollupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    const { hub, db, log, events } = this.ctx;

    hub.on("connected", (serverId, info) => {
      void (async () => {
        await db
          .update(servers)
          .set({
            connection: "connected",
            lastSeenAt: new Date(),
            agentVersion: info.agentVersion,
            capabilities: info.capabilities as never,
            simulated: info.host?.simulated ?? false,
            hostname: info.host?.hostname ?? sql`hostname`,
            updatedAt: new Date(),
          })
          .where(eq(servers.id, serverId));
        events.publish("servers", "server.connected", { server_id: serverId, ...info }, serverId);
        // A reconnect is the right moment to refresh cached inventory.
        void this.syncInventory(serverId);
      })().catch((err) => log.error({ err, serverId }, "connect reconcile failed"));
    });

    hub.on("disconnected", (serverId) => {
      void db
        .update(servers)
        .set({ connection: "disconnected", updatedAt: new Date() })
        .where(eq(servers.id, serverId))
        .then(() =>
          events.publish("servers", "server.disconnected", { server_id: serverId }, serverId),
        )
        .catch((err) => log.error({ err, serverId }, "disconnect reconcile failed"));
    });

    hub.on("event", (serverId, topic, ts, data) => {
      void this.handleAgentEvent(serverId, topic, ts, data).catch((err) =>
        log.error({ err, serverId, topic }, "agent event handling failed"),
      );
    });

    this.timer = setInterval(() => void this.sweep(), 15_000);
    this.timer.unref?.();
    this.rollupTimer = setInterval(() => void this.rollupAndPrune(), 5 * 60_000);
    this.rollupTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.rollupTimer) clearInterval(this.rollupTimer);
  }

  /* --------------------------- agent events -------------------------- */

  private async handleAgentEvent(
    serverId: string,
    topic: string,
    ts: string,
    data: unknown,
  ): Promise<void> {
    const { db, events } = this.ctx;

    switch (topic) {
      case "metrics": {
        const sample = data as MetricsSample;
        await db.insert(serverMetrics).values({
          serverId,
          ts: new Date(ts),
          cpuPercent: sample.cpu_percent,
          memoryUsed: sample.memory_used,
          memoryTotal: sample.memory_total,
          swapUsed: sample.swap_used,
          swapTotal: sample.swap_total,
          load1: sample.load1,
          load5: sample.load5,
          load15: sample.load15,
          processes: sample.processes,
          netRxRate: sample.net_rx_rate,
          netTxRate: sample.net_tx_rate,
          netRxBytes: sample.net_rx_bytes,
          netTxBytes: sample.net_tx_bytes,
          diskReadRate: sample.disk_read_rate ?? null,
          diskWriteRate: sample.disk_write_rate ?? null,
          disks: sample.disks,
        });
        await db
          .update(servers)
          .set({
            lastSeenAt: new Date(),
            health: deriveHealth(sample),
            healthReasons: healthReasons(sample),
          })
          .where(eq(servers.id, serverId));
        events.publish("metrics", "metrics.sample", { server_id: serverId, sample }, serverId);
        break;
      }

      case "service.changed":
        await this.syncServices(serverId);
        events.publish(
          "services",
          "service.changed",
          { server_id: serverId, ...(data as object) },
          serverId,
        );
        break;

      case "container.changed":
        await this.syncContainers(serverId);
        events.publish(
          "containers",
          "container.changed",
          { server_id: serverId, ...(data as object) },
          serverId,
        );
        break;

      case "threat.detected": {
        const obs = data as ThreatObservation;
        await this.ctx.db.execute(sql`
          insert into threat_events (server_id, kind, source_ip, target, attempts, first_seen, last_seen, sample)
          values (${serverId}, ${obs.kind}, ${obs.source_ip}::inet, ${obs.target}, ${obs.attempts},
                  ${obs.first_seen}, ${obs.last_seen}, ${obs.sample ?? null})
          on conflict (server_id, kind, source_ip) do update set
            attempts = threat_events.attempts + excluded.attempts,
            last_seen = excluded.last_seen,
            updated_at = now();
        `);
        events.publish("threats", "threat.detected", { server_id: serverId, ...obs }, serverId);
        break;
      }

      case "disk.pressure":
      case "cert.expiring":
      case "ssh.session":
      case "log.anomaly":
        events.publish("alerts", topic, { server_id: serverId, ...(data as object) }, serverId);
        break;

      default:
        this.ctx.log.debug({ serverId, topic }, "unhandled agent event topic");
    }
  }

  /* ---------------------------- inventory ---------------------------- */

  async syncInventory(serverId: string): Promise<void> {
    await Promise.allSettled([this.syncServices(serverId), this.syncContainers(serverId)]);
  }

  private async syncServices(serverId: string): Promise<void> {
    const { hub, db } = this.ctx;
    if (!hub.isConnected(serverId) || !hub.capabilities(serverId).includes("systemd")) return;

    const result = await hub.call(serverId, "service.list", {}, { timeoutMs: 20_000 });
    const now = new Date();
    for (const s of result.services) {
      await db
        .insert(services)
        .values({
          serverId,
          unit: s.unit,
          description: s.description,
          loadState: s.load_state,
          activeState: s.active_state,
          subState: s.sub_state,
          enabled: s.enabled,
          mainPid: s.main_pid,
          memoryCurrent: s.memory_current,
          activeSince: s.active_since ? new Date(s.active_since) : null,
          restartCount: s.restart_count,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [services.serverId, services.unit],
          set: {
            description: s.description,
            loadState: s.load_state,
            activeState: s.active_state,
            subState: s.sub_state,
            enabled: s.enabled,
            mainPid: s.main_pid,
            memoryCurrent: s.memory_current,
            activeSince: s.active_since ? new Date(s.active_since) : null,
            restartCount: s.restart_count,
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
    }
    // Units that vanished from the host should vanish from the panel.
    await db
      .delete(services)
      .where(and(eq(services.serverId, serverId), lt(services.lastSyncedAt, now)));
  }

  private async syncContainers(serverId: string): Promise<void> {
    const { hub, db } = this.ctx;
    const caps = hub.capabilities(serverId);
    if (!hub.isConnected(serverId) || !(caps.includes("docker") || caps.includes("podman"))) return;

    const result = await hub.call(
      serverId,
      "container.list",
      { all: true, with_stats: true },
      { timeoutMs: 20_000 },
    );
    const now = new Date();
    for (const c of result.containers) {
      await db
        .insert(containers)
        .values({
          serverId,
          containerId: c.id,
          name: c.name,
          image: c.image,
          imageId: c.image_id,
          state: c.state,
          status: c.status,
          runtime: c.runtime,
          ports: c.ports,
          labels: c.labels,
          networks: c.networks,
          mounts: c.mounts,
          restartCount: c.restart_count,
          cpuPercent: c.cpu_percent,
          memoryUsage: c.memory_usage,
          memoryLimit: c.memory_limit,
          createdAtHost: new Date(c.created_at),
          startedAt: c.started_at ? new Date(c.started_at) : null,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [containers.serverId, containers.containerId],
          set: {
            name: c.name,
            image: c.image,
            state: c.state,
            status: c.status,
            ports: c.ports,
            labels: c.labels,
            networks: c.networks,
            restartCount: c.restart_count,
            cpuPercent: c.cpu_percent,
            memoryUsage: c.memory_usage,
            memoryLimit: c.memory_limit,
            startedAt: c.started_at ? new Date(c.started_at) : null,
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
    }
    await db
      .delete(containers)
      .where(and(eq(containers.serverId, serverId), lt(containers.lastSyncedAt, now)));
  }

  /* ------------------------------ sweeps ----------------------------- */

  /** Marks servers stale or offline based on heartbeat recency. */
  private async sweep(): Promise<void> {
    const { db, config, hub, events } = this.ctx;
    const connected = new Set(hub.connectedServerIds());

    const rows = await db
      .select({
        id: servers.id,
        connection: servers.connection,
        lastSeenAt: servers.lastSeenAt,
        enrolledAt: servers.enrolledAt,
        revokedAt: servers.revokedAt,
      })
      .from(servers);

    const now = Date.now();
    for (const row of rows) {
      let next: (typeof row)["connection"];
      if (row.revokedAt) next = "revoked";
      else if (!row.enrolledAt) next = "never_enrolled";
      else if (connected.has(row.id)) {
        const age = row.lastSeenAt ? now - row.lastSeenAt.getTime() : 0;
        next = age > config.AGENT_OFFLINE_AFTER_SECONDS * 1000 ? "degraded" : "connected";
      } else next = "disconnected";

      if (next !== row.connection) {
        await db
          .update(servers)
          .set({ connection: next, updatedAt: new Date() })
          .where(eq(servers.id, row.id));
        events.publish(
          "servers",
          "server.connection_changed",
          { server_id: row.id, connection: next },
          row.id,
        );
      }
    }

    // A server we cannot reach has unknown health — not "healthy".
    await db
      .update(servers)
      .set({ health: "unknown" })
      .where(and(eq(servers.connection, "disconnected"), sql`${servers.health} <> 'unknown'`));
  }

  /** Rolls raw samples into 5-minute buckets and applies retention. */
  private async rollupAndPrune(): Promise<void> {
    const { db, config, log } = this.ctx;
    try {
      await db.execute(sql`
        insert into server_metrics_5m (
          server_id, bucket, samples, cpu_percent, memory_used, memory_total, swap_used, swap_total,
          load1, load5, load15, processes, net_rx_rate, net_tx_rate, net_rx_bytes, net_tx_bytes,
          disk_read_rate, disk_write_rate, disks
        )
        select server_id,
               date_trunc('hour', ts) + floor(extract(minute from ts) / 5) * interval '5 minutes' as bucket,
               count(*)::int,
               avg(cpu_percent), avg(memory_used)::bigint, max(memory_total)::bigint,
               avg(swap_used)::bigint, max(swap_total)::bigint,
               avg(load1), avg(load5), avg(load15), avg(processes)::int,
               avg(net_rx_rate), avg(net_tx_rate), max(net_rx_bytes)::bigint, max(net_tx_bytes)::bigint,
               avg(disk_read_rate), avg(disk_write_rate),
               (array_agg(disks order by ts desc))[1]
        from server_metrics
        where ts < now() - interval '5 minutes'
        group by server_id, bucket
        on conflict (server_id, bucket) do nothing;
      `);

      await db.execute(sql`
        delete from server_metrics
        where ts < now() - ${sql.raw(`interval '${config.RAW_METRICS_RETENTION_HOURS} hours'`)};
      `);
      await db.execute(sql`
        delete from server_metrics_5m
        where bucket < now() - ${sql.raw(`interval '${config.METRICS_RETENTION_DAYS} days'`)};
      `);
    } catch (err) {
      log.error({ err }, "metric rollup failed");
    }
  }
}

/* ------------------------------------------------------------------ */

function deriveHealth(sample: MetricsSample): HealthState {
  const reasons = healthReasons(sample);
  if (reasons.some((r) => r.startsWith("critical:"))) return "critical";
  if (reasons.length > 0) return "warning";
  return "healthy";
}

function healthReasons(sample: MetricsSample): string[] {
  const out: string[] = [];
  const memPct = sample.memory_total > 0 ? (sample.memory_used / sample.memory_total) * 100 : 0;

  for (const disk of sample.disks) {
    if (disk.used_percent >= 95)
      out.push(`critical:disk ${disk.mount} ${disk.used_percent.toFixed(0)}% full`);
    else if (disk.used_percent >= 85)
      out.push(`warning:disk ${disk.mount} ${disk.used_percent.toFixed(0)}% full`);
  }
  if (memPct >= 95) out.push(`critical:memory ${memPct.toFixed(0)}%`);
  else if (memPct >= 88) out.push(`warning:memory ${memPct.toFixed(0)}%`);
  if (sample.cpu_percent >= 95) out.push(`warning:cpu ${sample.cpu_percent.toFixed(0)}%`);
  if (sample.swap_total > 0 && sample.swap_used / sample.swap_total > 0.5) {
    out.push("warning:swap in heavy use");
  }
  return out;
}
