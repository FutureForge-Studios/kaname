"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Activity, BellOff, BellRing, Gauge, HardDrive, Plus, ShieldCheck, Timer } from "lucide-react";
import {
  APP_ALERT_KIND_LABELS,
  APP_ALERT_KIND_UNITS,
  type AlertRule,
  type AppAlertKind,
  type AppHealth as AppHealthData,
  type AppHealthStatus,
  type AppHealthSummary,
} from "@kaname/contract";
import {
  Badge,
  Button,
  Card,
  CardInset,
  DataTable,
  Dot,
  DropdownMenu,
  ErrorState,
  FormField,
  Input,
  MenuItem,
  MetricTile,
  MonoLabel,
  MonoText,
  NumberedSection,
  RelativeTime,
  Select,
  Skeleton,
  Sparkline,
  StatusBadge,
  StatusLine,
  Switch,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { api, type ApiError, type ListResult } from "@/lib/api";
import { describeAppRule, formatAppThreshold, formatWindow } from "@/lib/app-health";
import { formatBytes, formatCount, formatPercent } from "@/lib/format";
import { DETAIL_STALE_TIME, LIST_STALE_TIME, queryKeys, useCan, useResourceMutation } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * An installed app's health: is it answering, how fast, how its
 * containers are doing, what fired, and the rules that decide what
 * fires. Self-contained — the install page mounts it with one line.
 *
 * Data lives under the `alerts` family, so the SSE `alerts` topic (an
 * alert opening or resolving, a rule changing, the probe flipping
 * up/down) refreshes it; it also polls once a minute, the probe's own
 * cadence, for anyone without the event stream.
 * ------------------------------------------------------------------ */

const FAMILY = "alerts";
const REFRESH_MS = 60_000;

export const APP_HEALTH_TONES: Record<AppHealthStatus, Tone> = {
  up: "ok",
  degraded: "warn",
  down: "danger",
  unknown: "neutral",
};

const STATUS_WORDS: Record<AppHealthStatus, string> = {
  up: "Up",
  degraded: "Degraded",
  down: "Down",
  unknown: "Not checked",
};

const SEVERITY_TONES: Record<AlertRule["severity"], Tone> = {
  info: "info",
  warning: "warn",
  critical: "danger",
};

/* ------------------------------ data ------------------------------- */

export function useAppHealth(installId: string, enabled = true): UseQueryResult<AppHealthData, ApiError> {
  return useQuery<AppHealthData, ApiError>({
    queryKey: queryKeys.sub(FAMILY, installId, "app-health"),
    queryFn: ({ signal }) => api.get<AppHealthData>(`/apps/installs/${installId}/health`, { signal }),
    enabled,
    staleTime: DETAIL_STALE_TIME,
    refetchInterval: REFRESH_MS,
  });
}

/** One request for every visible install: the Installed list's dots and the homes' line. */
export function useAppHealthSummaries(
  enabled = true,
): UseQueryResult<ListResult<AppHealthSummary>, ApiError> {
  return useQuery<ListResult<AppHealthSummary>, ApiError>({
    enabled,
    queryKey: queryKeys.list(FAMILY, { view: "app-health" }),
    queryFn: ({ signal }) => api.list<AppHealthSummary>("/apps/health", { signal }),
    staleTime: LIST_STALE_TIME,
    refetchInterval: REFRESH_MS,
  });
}

/* ------------------------------ small ------------------------------ */

/** The status dot for one install, for lists. Renders nothing until known. */
export function AppHealthDot({ installId, className }: { installId: string; className?: string }) {
  const summaries = useAppHealthSummaries();
  const row = summaries.data?.data.find((s) => s.install_id === installId);
  if (!row) return null;
  const detail =
    row.status === "unknown"
      ? "Not checked yet"
      : `${STATUS_WORDS[row.status]}${row.uptime_24h !== null ? ` · ${formatUptime(row.uptime_24h)} uptime (24h)` : ""}${row.open_alerts > 0 ? ` · ${row.open_alerts} open alert${row.open_alerts === 1 ? "" : "s"}` : ""}`;
  return (
    <span className={className} title={detail} data-testid={`app-health-${installId}`}>
      <Dot
        tone={APP_HEALTH_TONES[row.status]}
        hollow={row.status === "unknown"}
        pulse={row.status === "down"}
        label={`Health: ${detail}`}
      />
    </span>
  );
}

/**
 * One calm sentence about every app the caller can see — for a home
 * page. Nothing at all while there are no apps.
 */
export function AppHealthLine({ className }: { className?: string }) {
  const can = useCan();
  const summaries = useAppHealthSummaries(can("apps.installs:read"));
  const rows = (summaries.data?.data ?? []).filter((r) => r.status !== "unknown");
  if (rows.length === 0) return null;
  const down = rows.filter((r) => r.status === "down");
  const degraded = rows.filter((r) => r.status === "degraded");
  const tone: Tone = down.length > 0 ? "danger" : degraded.length > 0 ? "warn" : "ok";
  const named = (list: AppHealthSummary[]) =>
    list.length === 1 ? `${list[0]!.app_name} on ${list[0]!.domain}` : `${list.length} apps`;
  return (
    <StatusLine tone={tone} className={className}>
      {down.length > 0
        ? `${named(down)} ${down.length === 1 ? "is" : "are"} not answering.`
        : degraded.length > 0
          ? `${named(degraded)} ${degraded.length === 1 ? "needs" : "need"} a look.`
          : rows.length === 1
            ? `${rows[0]!.app_name} is up and answering.`
            : `All ${rows.length} apps are up and answering.`}{" "}
      <Link href="/apps/installed" className="text-[var(--kn-accent-400)] hover:underline">
        Apps
      </Link>
    </StatusLine>
  );
}

/* ------------------------------ section ---------------------------- */

export interface AppHealthProps {
  installId: string;
  /** Section number on the page. */
  index: number;
}

export function AppHealth({ installId, index }: AppHealthProps) {
  const query = useAppHealth(installId);

  if (query.isLoading) {
    return (
      <NumberedSection index={index} title="Health" caption="Checked every minute.">
        <Skeleton className="h-40 w-full" label="Loading health" />
      </NumberedSection>
    );
  }
  if (query.isError || !query.data) {
    return (
      <NumberedSection index={index} title="Health">
        {query.error && (
          <ErrorState code={query.error.code} message={query.error.message} remediation={query.error.remediation} />
        )}
      </NumberedSection>
    );
  }

  const health = query.data;
  return (
    <>
      <NumberedSection
        index={index}
        title="Health"
        caption={health.probe.enabled ? "Checked every minute from the control plane." : "Checks are paused."}
        data-testid="app-health"
      >
        <Card radius="xl" padding="md" className="flex flex-col gap-4">
          <Headline health={health} />
          <Readings health={health} />
        </Card>
        {health.containers && <Containers containers={health.containers} />}
        {health.recent_alerts.length > 0 && <RecentAlerts health={health} />}
      </NumberedSection>
      <NumberedSection
        index={index + 1}
        title="Alert rules"
        caption={
          health.can_manage
            ? "Alerts go to the operator's alert channels."
            : "Read only. Ask an operator to change these."
        }
        data-testid="app-alert-rules"
      >
        <Rules health={health} />
        {health.can_manage && <ProbeSettings health={health} />}
      </NumberedSection>
    </>
  );
}

function Headline({ health }: { health: AppHealthData }) {
  const { probe, status } = health;
  let sentence: React.ReactNode;
  if (!probe.enabled) {
    sentence = "Health checks are paused for this app.";
  } else if (!probe.last_checked_at) {
    sentence = "Waiting for the first check.";
  } else if (status === "down") {
    sentence = (
      <>
        Down · {probe.error ?? (probe.status_code !== null ? `HTTP ${probe.status_code}` : "no answer")} ·{" "}
        {formatCount(probe.consecutive_failures)} check{probe.consecutive_failures === 1 ? "" : "s"} failed in a row ·{" "}
        <RelativeTime value={probe.last_checked_at} />
      </>
    );
  } else {
    sentence = (
      <>
        {STATUS_WORDS[status]} · HTTP {probe.status_code ?? "—"} in {formatCount(probe.latency_ms)} ms ·{" "}
        {health.open_alerts > 0
          ? `${health.open_alerts} open alert${health.open_alerts === 1 ? "" : "s"} · `
          : ""}
        checked <RelativeTime value={probe.last_checked_at} />
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <StatusLine tone={APP_HEALTH_TONES[status]} pulse={status === "down"} data-testid="app-health-status">
        {sentence}
      </StatusLine>
      <MonoText className="truncate pl-4 text-xs text-[var(--kn-text-3)]" title={probe.url}>
        GET {probe.url}
      </MonoText>
    </div>
  );
}

/** "100%" when perfect, two decimals otherwise: 99.31% and 99.97% are different weeks. */
function formatUptime(value: number | null): string {
  if (value === null) return "—";
  return formatPercent(value, value >= 99.995 ? 0 : 2);
}

function uptimeTone(value: number | null): Tone {
  if (value === null) return "neutral";
  if (value >= 99.5) return "ok";
  if (value >= 95) return "warn";
  return "danger";
}

function Readings({ health }: { health: AppHealthData }) {
  const latencies = health.latency.map((p) => p.value);
  const days = health.certificate?.days_left ?? null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricTile
        size="sm"
        icon={Activity}
        label="Uptime 24h"
        value={formatUptime(health.uptime_24h)}
        tone={uptimeTone(health.uptime_24h)}
      />
      <MetricTile
        size="sm"
        icon={Activity}
        label="Uptime 7d"
        value={formatUptime(health.uptime_7d)}
        tone={uptimeTone(health.uptime_7d)}
      />
      <MetricTile
        size="sm"
        icon={Timer}
        label="Response"
        value={health.probe.latency_ms === null ? "—" : formatCount(health.probe.latency_ms)}
        unit={health.probe.latency_ms === null ? undefined : "ms"}
        sparkline={
          latencies.length > 1 ? (
            <Sparkline values={latencies} area label="Response time over the last 24 hours" />
          ) : undefined
        }
      />
      {health.certificate ? (
        <MetricTile
          size="sm"
          icon={ShieldCheck}
          label="Certificate"
          value={days === null ? "—" : formatCount(Math.max(0, days))}
          unit={days === null ? undefined : days === 1 ? "day left" : "days left"}
          tone={days === null ? "neutral" : days <= 7 ? "danger" : days <= 21 ? "warn" : "ok"}
        />
      ) : health.data ? (
        <MetricTile size="sm" icon={HardDrive} label="Data" value={formatBytes(health.data.bytes)} />
      ) : (
        <MetricTile size="sm" icon={ShieldCheck} label="Certificate" value="—" unit="none" />
      )}
    </div>
  );
}

type ContainerRow = NonNullable<AppHealthData["containers"]>["items"][number];

const STATE_TONES: Record<string, Tone> = {
  running: "ok",
  restarting: "warn",
  paused: "warn",
  created: "neutral",
  exited: "danger",
  dead: "danger",
};

function Containers({ containers }: { containers: NonNullable<AppHealthData["containers"]> }) {
  const columns = React.useMemo<DataTableColumn<ContainerRow>[]>(
    () => [
      { id: "name", header: "Container", mono: true, minWidth: 160, accessor: (c) => c.name },
      { id: "role", header: "Role", width: 80, mono: true, accessor: (c) => c.role },
      {
        id: "state",
        header: "State",
        width: 120,
        cell: (c) => (
          <StatusBadge size="xs" tone={STATE_TONES[c.state] ?? "neutral"}>
            {c.state}
          </StatusBadge>
        ),
      },
      {
        id: "health",
        header: "Healthcheck",
        width: 112,
        hideBelow: "md",
        cell: (c) =>
          c.health === "none" ? (
            <span className="text-[var(--kn-text-3)]">none</span>
          ) : (
            <Badge size="xs" tone={c.health === "healthy" ? "ok" : c.health === "unhealthy" ? "danger" : "warn"}>
              {c.health}
            </Badge>
          ),
      },
      {
        id: "restarts",
        header: "Restarts",
        width: 88,
        align: "right",
        cell: (c) => <span className="kn-num">{formatCount(c.restart_count)}</span>,
      },
      {
        id: "cpu",
        header: "CPU",
        width: 80,
        align: "right",
        hideBelow: "md",
        cell: (c) => <span className="kn-num">{c.cpu_percent === null ? "—" : formatPercent(c.cpu_percent)}</span>,
      },
      {
        id: "memory",
        header: "Memory",
        width: 132,
        align: "right",
        hideBelow: "md",
        cell: (c) => (
          <span className="kn-num">
            {c.memory_bytes === null ? "—" : formatBytes(c.memory_bytes)}
            {c.memory_limit ? <span className="text-[var(--kn-text-3)]"> / {formatBytes(c.memory_limit)}</span> : null}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <MonoLabel size="xs" tone="muted">
          Containers · {containers.running}/{containers.total} running
          {containers.unhealthy > 0 ? ` · ${containers.unhealthy} unhealthy` : ""}
        </MonoLabel>
        <MonoLabel size="xs" tone="subtle">
          {containers.sampled_at ? (
            <>
              sampled <RelativeTime value={containers.sampled_at} />
            </>
          ) : (
            "not sampled yet"
          )}
        </MonoLabel>
      </div>
      <DataTable<ContainerRow>
        label="App containers"
        columns={columns}
        rows={containers.items}
        getRowId={(c) => c.name}
        density="compact"
        columnVisibility={false}
        empty={<p className="m-0 p-4 text-sm text-[var(--kn-text-3)]">No containers reported yet.</p>}
      />
    </div>
  );
}

function RecentAlerts({ health }: { health: AppHealthData }) {
  return (
    <div className="flex flex-col gap-2">
      <MonoLabel size="xs" tone="muted">
        Recent alerts
      </MonoLabel>
      <Card radius="lg" padding="none">
        <ul className="m-0 list-none divide-y divide-[var(--kn-border)] p-0" aria-label="Recent alerts">
          {health.recent_alerts.map((alert) => {
            const open = alert.resolved_at === null;
            return (
              <li key={alert.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                <StatusBadge
                  size="xs"
                  tone={open ? SEVERITY_TONES[alert.severity] : "neutral"}
                  pulse={open && alert.state === "firing"}
                >
                  {open ? alert.state : "resolved"}
                </StatusBadge>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--kn-text-2)]" title={alert.message}>
                  {alert.message}
                </span>
                <MonoLabel size="xs" tone="subtle">
                  <RelativeTime value={alert.started_at} />
                  {alert.resolved_at && (
                    <>
                      {" → "}
                      <RelativeTime value={alert.resolved_at} />
                    </>
                  )}
                </MonoLabel>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/* ------------------------------ rules ------------------------------ */

function Rules({ health }: { health: AppHealthData }) {
  const add = useResourceMutation<AppAlertKind, AlertRule>({
    mutationFn: (kind) => api.post<AlertRule>(`/apps/installs/${health.install_id}/alert-rules`, { kind }),
    invalidates: [FAMILY, "alert-rules"],
    successMessage: (rule) => `Added "${rule.name}".`,
  });

  return (
    <Card radius="xl" padding="none">
      <ul className="m-0 list-none divide-y divide-[var(--kn-border)] p-0" aria-label="Alert rules">
        {health.rules.map((rule) => (
          <RuleRow key={rule.id} installId={health.install_id} rule={rule} canManage={health.can_manage} />
        ))}
        {health.rules.length === 0 && (
          <li className="px-4 py-3 text-sm text-[var(--kn-text-3)]">No alert rules for this app.</li>
        )}
      </ul>
      {health.can_manage && health.available_kinds.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--kn-border)] px-4 py-2.5">
          <span className="text-xs text-[var(--kn-text-3)]">
            {health.available_kinds.length} more kind{health.available_kinds.length === 1 ? "" : "s"} of alert available.
          </span>
          <DropdownMenu
            placement="bottom-end"
            label="Add an alert rule"
            trigger={
              <Button size="xs" icon={Plus} loading={add.isPending}>
                Add rule
              </Button>
            }
          >
            {health.available_kinds.map((kind) => (
              <MenuItem key={kind} onSelect={() => add.mutate(kind)}>
                {APP_ALERT_KIND_LABELS[kind]}
              </MenuItem>
            ))}
          </DropdownMenu>
        </div>
      )}
    </Card>
  );
}

function RuleRow({ installId, rule, canManage }: { installId: string; rule: AlertRule; canManage: boolean }) {
  const kind = rule.metric as AppAlertKind;
  const [editing, setEditing] = React.useState(false);
  const [threshold, setThreshold] = React.useState(String(rule.threshold));
  const [duration, setDuration] = React.useState(String(rule.duration_seconds));
  const [severity, setSeverity] = React.useState(rule.severity);

  React.useEffect(() => {
    if (editing) return;
    setThreshold(String(rule.threshold));
    setDuration(String(rule.duration_seconds));
    setSeverity(rule.severity);
  }, [editing, rule]);

  const save = useResourceMutation<Record<string, unknown>, AlertRule>({
    mutationFn: (body) => api.patch<AlertRule>(`/apps/installs/${installId}/alert-rules/${rule.id}`, body),
    invalidates: [FAMILY, "alert-rules"],
    successMessage: (result, body) =>
      body.enabled === false
        ? `Muted "${result.name}".`
        : body.enabled === true
          ? `Unmuted "${result.name}".`
          : `Saved "${result.name}".`,
    onDone: () => setEditing(false),
  });

  // Counted kinds carry their own duration in the threshold.
  const hasWindow = kind !== "app_down" && kind !== "app_cert_expiring";

  return (
    <li className="flex flex-col gap-3 px-4 py-3" data-testid={`app-rule-${kind}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {rule.enabled ? (
          <BellRing size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
        ) : (
          <BellOff size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[var(--kn-text)]">{APP_ALERT_KIND_LABELS[kind]}</span>
            <StatusBadge size="xs" tone={rule.enabled ? SEVERITY_TONES[rule.severity] : "neutral"}>
              {rule.enabled ? rule.severity : "muted"}
            </StatusBadge>
          </div>
          <p className="m-0 mt-0.5 text-xs text-[var(--kn-text-3)]">{describeAppRule(kind, rule)}</p>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            {!editing && (
              <Button size="xs" icon={Gauge} onClick={() => setEditing(true)}>
                Tune
              </Button>
            )}
            <Switch
              checked={rule.enabled}
              disabled={save.isPending}
              onChange={(event) => save.mutate({ enabled: event.target.checked })}
              label={rule.enabled ? "On" : "Muted"}
              aria-label={`${rule.enabled ? "Mute" : "Unmute"} ${APP_ALERT_KIND_LABELS[kind]}`}
            />
          </div>
        )}
      </div>
      {editing && (
        <CardInset padding="sm">
          <form
            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate({
                threshold: Number(threshold),
                ...(hasWindow ? { duration_seconds: Number(duration) } : {}),
                severity,
              });
            }}
          >
            <FormField label={`Threshold (${APP_ALERT_KIND_UNITS[kind]})`} error={save.error?.fields.threshold}>
              <Input mono inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </FormField>
            {hasWindow ? (
              <FormField label="Window (seconds)" error={save.error?.fields.duration_seconds}>
                <Input mono inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
              </FormField>
            ) : (
              <div className="hidden sm:block" />
            )}
            <FormField label="Severity">
              <Select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as AlertRule["severity"])}
                options={[
                  { value: "info", label: "Info" },
                  { value: "warning", label: "Warning" },
                  { value: "critical", label: "Critical" },
                ]}
              />
            </FormField>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="primary" loading={save.isPending}>
                Save
              </Button>
            </div>
            <p className="m-0 text-xs text-[var(--kn-text-3)] sm:col-span-4">
              Reads as: {APP_ALERT_KIND_LABELS[kind].toLowerCase()} when{" "}
              {describeAppRule(kind, {
                threshold: Number(threshold) || 0,
                duration_seconds: Number(duration) || 0,
              })}
              .{" "}
              {hasWindow ? `Window ${formatWindow(Number(duration) || 0)}, threshold ${formatAppThreshold(kind, Number(threshold) || 0)}.` : ""}
            </p>
          </form>
        </CardInset>
      )}
    </li>
  );
}

function ProbeSettings({ health }: { health: AppHealthData }) {
  const [path, setPath] = React.useState(health.probe.path);
  React.useEffect(() => setPath(health.probe.path), [health.probe.path]);

  const save = useResourceMutation<Record<string, unknown>, AppHealthData>({
    mutationFn: (body) => api.patch<AppHealthData>(`/apps/installs/${health.install_id}/monitor`, body),
    invalidates: [FAMILY],
    successMessage: (_r, body) =>
      body.probe_enabled === false
        ? "Health checks paused."
        : body.probe_enabled === true
          ? "Health checks resumed."
          : "Health check path saved.",
  });

  const dirty = path.trim() !== health.probe.path;
  return (
    <Card radius="xl" padding="md">
      <form
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({ probe_path: path.trim() });
        }}
      >
        <FormField
          label="Health check path"
          description={`Requested every minute; a 2xx answer counts as up. The app's default is ${health.probe.default_path}.`}
          error={save.error?.fields.probe_path}
        >
          <Input mono value={path} onChange={(event) => setPath(event.target.value)} placeholder="/" />
        </FormField>
        <div className="flex items-center gap-3 sm:pb-6">
          <Switch
            checked={health.probe.enabled}
            disabled={save.isPending}
            onChange={(event) => save.mutate({ probe_enabled: event.target.checked })}
            label="Checks on"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!dirty} loading={save.isPending}>
            Save path
          </Button>
        </div>
      </form>
    </Card>
  );
}
