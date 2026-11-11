"use client";

import * as React from "react";
import {
  Activity,
  Bell,
  Box,
  Cog,
  Cpu,
  Database,
  Globe,
  Mail,
  HardDrive,
  Layers,
  MemoryStick,
  Network,
  Power,
  ShieldOff,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { Server, TimeRange } from "@kaname/contract";
import {
  AreaChart,
  Button,
  ByteSize,
  Card,
  HealthBadge,
  LineChart,
  MetricTile,
  MonoLabel,
  NumberedSection,
  PropertyList,
  PropertyRow,
  RelativeTime,
  SectionCard,
  Skeleton,
  Tag,
  TimeRangePicker,
  type ChartSeries,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCan } from "@/lib/queries";
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatLoad,
  formatPercent,
  formatRate,
  formatUptime,
  percentOf,
} from "@/lib/format";
import {
  hasContainerRuntime,
  useServerMetrics,
  usageTone,
  worstDiskPercent,
  type ServerMetricSample,
} from "../_lib/infra";
import type { ServerCommands } from "./ServerCommands";

/* ------------------------------------------------------------------ *
 * Server overview.
 *
 * Both status axes are already in the page header; this is the "why".
 * Health reasons are spelled out as sentences rather than left implied
 * by a colour, the charts read from the same samples the health verdict
 * was computed from, and the rail keeps identity, certificate expiry
 * and labels on screen while the body scrolls.
 * ------------------------------------------------------------------ */

const CERT_WARN_DAYS = 21;
const CERT_DANGER_DAYS = 7;

export interface ServerOverviewProps {
  server: Server;
  commands: ServerCommands;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

function series(
  id: string,
  label: string,
  color: string,
  samples: readonly ServerMetricSample[],
  pick: (sample: ServerMetricSample) => number,
): ChartSeries {
  return {
    id,
    label,
    color,
    data: samples.map((sample) => ({ x: Date.parse(sample.ts), y: pick(sample) })),
  };
}

export function ServerOverview({ server, commands }: ServerOverviewProps) {
  const can = useCan();
  const [range, setRange] = React.useState<TimeRange>("24h");
  const metrics = useServerMetrics(server.id, range);

  const samples = metrics.data?.samples ?? [];
  const last = samples[samples.length - 1];
  const latest = server.latest;

  const cpuPercent = last?.cpu_percent ?? latest?.cpu_percent ?? null;
  const memoryPercent = last
    ? percentOf(last.memory_used, last.memory_total)
    : latest
      ? percentOf(latest.memory_used, latest.memory_total)
      : null;
  const diskPercent = worstDiskPercent(last?.disks ?? latest?.disks);
  const certDays = daysUntil(server.cert_expires_at);

  const charts: { key: string; title: string; node: React.ReactNode }[] = [
    {
      key: "cpu",
      title: "CPU",
      node: (
        <AreaChart
          title={`CPU on ${server.name}`}
          series={[series("cpu", "CPU %", "var(--kn-chart-1)", samples, (s) => s.cpu_percent)]}
          yDomain={[0, 100]}
          formatValue={(value) => `${Math.round(value)}%`}
          height={168}
        />
      ),
    },
    {
      key: "memory",
      title: "Memory",
      node: (
        <AreaChart
          title={`Memory on ${server.name}`}
          series={[
            series("memory", "Used", "var(--kn-chart-2)", samples, (s) => s.memory_used),
            series("swap", "Swap", "var(--kn-chart-4)", samples, (s) => s.swap_used),
          ]}
          formatValue={(value) => formatBytes(value, "binary", 0)}
          showLegend
          height={168}
        />
      ),
    },
    {
      key: "load",
      title: "Load average",
      node: (
        <LineChart
          title={`Load average on ${server.name}`}
          series={[
            series("load1", "1m", "var(--kn-chart-1)", samples, (s) => s.load1),
            series("load5", "5m", "var(--kn-chart-3)", samples, (s) => s.load5),
            series("load15", "15m", "var(--kn-chart-6)", samples, (s) => s.load15),
          ]}
          formatValue={(value) => value.toFixed(2)}
          showLegend
          height={168}
        />
      ),
    },
    {
      key: "network",
      title: "Network",
      node: (
        <AreaChart
          title={`Network on ${server.name}`}
          series={[
            series("rx", "Received", "var(--kn-chart-2)", samples, (s) => s.net_rx_rate),
            series("tx", "Sent", "var(--kn-chart-6)", samples, (s) => s.net_tx_rate),
          ]}
          formatValue={(value) => formatRate(value)}
          showLegend
          height={168}
        />
      ),
    },
  ];

  const specs = (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <SectionCard title="Identity" headingLevel={3}>
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="Hostname" mono copyValue={server.hostname}>
            {server.hostname}
          </PropertyRow>
          <PropertyRow label="Address" mono copyValue={server.address ?? undefined}>
            {server.address}
          </PropertyRow>
          <PropertyRow label="Provider">{server.provider}</PropertyRow>
          <PropertyRow label="OS" mono>
            {[server.os, server.os_version].filter(Boolean).join(" ") || null}
          </PropertyRow>
          <PropertyRow label="Kernel" mono>
            {server.kernel}
          </PropertyRow>
          <PropertyRow label="Architecture" mono>
            {server.arch}
          </PropertyRow>
          <PropertyRow label="CPU">
            {server.cpu_model
              ? `${server.cpu_model}${server.cpu_cores ? ` · ${formatCount(server.cpu_cores)} cores` : ""}`
              : null}
          </PropertyRow>
          <PropertyRow label="Memory">
            {server.memory_total ? <ByteSize bytes={server.memory_total} precision={0} /> : null}
          </PropertyRow>
          <PropertyRow label="Timezone" mono>
            {server.timezone}
          </PropertyRow>
          <PropertyRow label="Uptime" hint={formatDateTime(server.boot_time)}>
            {formatUptime(server.uptime_seconds)}
          </PropertyRow>
        </PropertyList>
      </SectionCard>

      <div className="flex min-w-0 flex-col gap-4">
        <SectionCard title="Agent" headingLevel={3}>
          <PropertyList dense labelWidth="sm">
            <PropertyRow label="Version" mono>
              {server.agent_version}
            </PropertyRow>
            <PropertyRow label="Last seen">
              <RelativeTime value={server.last_seen_at} />
            </PropertyRow>
            <PropertyRow label="Enrolled">
              <RelativeTime value={server.enrolled_at} fallback="never" />
            </PropertyRow>
            <PropertyRow
              label="Certificate"
              hint="Agent certificates are issued for 90 days and rotate at two thirds of their life."
            >
              {server.cert_expires_at ? (
                <span
                  className={
                    certDays !== null && certDays <= CERT_DANGER_DAYS
                      ? "text-[var(--kn-danger)]"
                      : certDays !== null && certDays <= CERT_WARN_DAYS
                        ? "text-[var(--kn-warn)]"
                        : undefined
                  }
                >
                  expires <RelativeTime value={server.cert_expires_at} />
                </span>
              ) : null}
            </PropertyRow>
          </PropertyList>
        </SectionCard>

        <SectionCard title="Capabilities and labels" headingLevel={3}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <MonoLabel as="h4" size="xs">
                Capabilities
              </MonoLabel>
              {server.capabilities.length === 0 ? (
                <p className="text-[var(--kn-text-3)]">
                  None reported. Modules a host cannot serve stay greyed out rather than failing at
                  call time.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {server.capabilities.map((capability) => (
                    <Tag key={capability} size="xs" mono>
                      {capability}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-[var(--kn-border-subtle)] pt-4">
              <MonoLabel as="h4" size="xs">
                Labels
              </MonoLabel>
              {Object.keys(server.labels).length === 0 ? (
                <p className="text-[var(--kn-text-3)]">No labels.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(server.labels).map(([key, value]) => (
                    <Tag key={key} size="xs" mono>
                      {key}={value}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
            {server.notes && (
              <p className="whitespace-pre-wrap border-t border-[var(--kn-border-subtle)] pt-4 text-[var(--kn-text-2)]">
                {server.notes}
              </p>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );

  const counts = server.counts;
  const failed = counts?.services_failed ?? 0;
  const alerts = counts?.open_alerts ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <NumberedSection
        index={1}
        title="Overview"
        caption="The latest sample, and why health reads the way it does."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <MetricTile
            size="sm"
            icon={Cpu}
            label="CPU"
            value={formatPercent(cpuPercent)}
            tone={usageTone(cpuPercent)}
          />
          <MetricTile
            size="sm"
            icon={MemoryStick}
            label="Memory"
            value={formatPercent(memoryPercent)}
            unit={last ? `of ${formatBytes(last.memory_total, "binary", 0)}` : undefined}
            tone={usageTone(memoryPercent)}
          />
          <MetricTile
            size="sm"
            icon={HardDrive}
            label="Fullest mount"
            value={formatPercent(diskPercent)}
            tone={usageTone(diskPercent)}
          />
          <MetricTile
            size="sm"
            icon={Activity}
            label="Load, 1m"
            value={formatLoad(last?.load1 ?? latest?.load1 ?? null)}
          />
          <MetricTile
            size="sm"
            icon={Layers}
            label="Processes"
            value={formatCount(last?.processes ?? null)}
          />
          <MetricTile
            size="sm"
            icon={Network}
            label="Network"
            value={formatRate((last?.net_rx_rate ?? 0) + (last?.net_tx_rate ?? 0))}
          />
        </div>

        <SectionCard
          title="Health"
          headingLevel={3}
          icon={server.health === "healthy" ? undefined : TriangleAlert}
          actions={
            <HealthBadge
              health={server.health}
              reasons={server.health_reasons}
              since={latest?.sampled_at ?? null}
            />
          }
        >
          {server.health_reasons.length > 0 ? (
            <ul className="flex flex-col">
              {server.health_reasons.map((reason) => (
                <li
                  key={reason}
                  className="flex items-start gap-2.5 py-1.5 first:pt-0 last:pb-0 [&+li]:border-t [&+li]:border-[var(--kn-border-subtle)]"
                >
                  <TriangleAlert
                    size={13}
                    className="mt-0.5 shrink-0 text-[var(--kn-warn)]"
                    aria-hidden
                  />
                  <span className="text-[var(--kn-text)]">{reason}</span>
                </li>
              ))}
            </ul>
          ) : server.health === "unknown" ? (
            <p className="text-[var(--kn-text-2)]">
              No recent metrics from this host, so health cannot be evaluated. That is a statement
              about the panel's information, not about the box.
            </p>
          ) : (
            <p className="text-[var(--kn-text-2)]">
              Every monitored threshold is within range as of{" "}
              <RelativeTime value={latest?.sampled_at ?? null} />.
            </p>
          )}
        </SectionCard>
      </NumberedSection>

      <NumberedSection
        index={2}
        title="Resources"
        caption="The samples the health verdict is computed from."
        actions={
          <TimeRangePicker
            size="xs"
            allowCustom={false}
            label="Metric range"
            value={{ kind: "preset", preset: range }}
            onChange={(next) => {
              if (next.kind === "preset") setRange(next.preset);
            }}
          />
        }
      >
        {metrics.isError ? (
          <PageError
            error={metrics.error}
            onRetry={() => void metrics.refetch()}
            context="Metrics"
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {charts.map((chart) => (
              <SectionCard key={chart.key} title={chart.title} headingLevel={3} className="min-w-0">
                {metrics.isLoading ? (
                  <Skeleton
                    className="h-[168px]"
                    label={chart.key === "cpu" ? "Loading metrics" : undefined}
                  />
                ) : (
                  chart.node
                )}
              </SectionCard>
            ))}
          </div>
        )}
      </NumberedSection>

      <NumberedSection index={3} title="Workload" caption="What Kaname manages on this host.">
        {counts ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <MetricTile size="sm" icon={Globe} label="Sites" value={formatCount(counts.sites)} />
            <MetricTile
              size="sm"
              icon={Box}
              label="Containers"
              value={hasContainerRuntime(server) ? formatCount(counts.containers) : "—"}
            />
            <MetricTile
              size="sm"
              icon={Cog}
              label="Failed units"
              value={formatCount(failed)}
              tone={failed > 0 ? "danger" : "neutral"}
            />
            <MetricTile
              size="sm"
              icon={Database}
              label="Databases"
              value={formatCount(counts.databases)}
            />
            <MetricTile
              size="sm"
              icon={Mail}
              label="Mailboxes"
              value={formatCount(counts.mailboxes)}
            />
            <MetricTile
              size="sm"
              icon={Bell}
              label="Open alerts"
              value={formatCount(alerts)}
              tone={alerts > 0 ? "warn" : "neutral"}
            />
          </div>
        ) : (
          <Card padding="md">
            <p className="text-[var(--kn-text-3)]">
              No inventory counts yet. They arrive with the agent&apos;s first full report.
            </p>
          </Card>
        )}
      </NumberedSection>

      <NumberedSection
        index={4}
        title="Specification"
        caption="What the agent reported about the machine it runs on."
      >
        {specs}
      </NumberedSection>

      <NumberedSection
        index={5}
        title="Danger zone"
        caption="Each of these asks you to type the server name first."
      >
        <Card padding="none" className="divide-y divide-[var(--kn-border)]">
          <DangerRow
            title="Reboot"
            detail="Everything on the host stops. The agent reconnects on its own; queued jobs wait for it."
            action={
              <Button
                variant="danger-subtle"
                size="sm"
                icon={Power}
                disabled={
                  !can("infra.servers:write", server.id) || server.connection !== "connected"
                }
                onClick={() => commands.request("reboot", server)}
              >
                Reboot
              </Button>
            }
          />
          <DangerRow
            title="Revoke certificate"
            detail="Drops the socket and blocks reconnection until the host is enrolled again. Nothing on the box changes."
            action={
              <Button
                variant="danger-subtle"
                size="sm"
                icon={ShieldOff}
                // Revoking is granted by infra.servers:delete, as the API checks it.
                disabled={
                  !can("infra.servers:delete", server.id) || server.connection === "revoked"
                }
                onClick={() => commands.request("revoke", server)}
              >
                Revoke
              </Button>
            }
          />
          <DangerRow
            title="Remove from Kaname"
            detail="Deletes the row and everything cached about this host. The audit chain keeps the record."
            action={
              <Button
                variant="danger"
                size="sm"
                icon={Trash2}
                disabled={!can("infra.servers:delete", server.id)}
                onClick={() => commands.request("remove", server)}
              >
                Remove
              </Button>
            }
          />
        </Card>
      </NumberedSection>
    </div>
  );
}

function DangerRow({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="kn-title text-[var(--kn-text)]">{title}</p>
        <p className="mt-0.5 text-sm text-[var(--kn-text-2)]">{detail}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
