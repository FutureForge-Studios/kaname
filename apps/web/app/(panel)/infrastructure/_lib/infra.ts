"use client";

import * as React from "react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Ban, CircleStop, Play, RefreshCw, RotateCw, ToggleLeft, ToggleRight } from "lucide-react";
import type {
  Container,
  ContainerState,
  CreateServerInput,
  DiskUsage,
  EnrollmentInstructions,
  Job,
  MetricName,
  MetricSeries,
  ProcessRow,
  Server,
  Service,
  ServiceAction,
  ServiceActiveState,
  SignalName,
  StorageBreakdown,
  TimeRange,
} from "@kaname/contract";
import type { Tone } from "@kaname/ui";
import { api, type ApiError, type ListResult } from "@/lib/api";
import type { IconComponent } from "@/lib/icons";
import { pluralize } from "@/lib/format";
import {
  DETAIL_STALE_TIME,
  LIST_STALE_TIME,
  queryKeys,
  useMutationWithJob,
  useResourceMutation,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Infrastructure data access.
 *
 * Servers, services, processes and containers are four views of the
 * same fleet, so the hooks live together: one definition of what a
 * service action invalidates, one definition of how a sparkline is
 * sourced, and one place that keeps the live pass-through read
 * (processes) distinguishable from the cached ones (KD-012).
 *
 * Every mutation below that reaches a host goes through
 * `useMutationWithJob`, so the caller gets a job and never a spinner
 * that has to guess whether `systemctl restart` happened (KD-008).
 * ------------------------------------------------------------------ */

/** Live tables refresh often enough to feel current without hammering a host. */
export const PROCESS_REFRESH_MS = 5000;
export const METRICS_REFRESH_MS = 30_000;

/** The agent caps a process read; asking for more than this fails validation. */
export const MAX_PROCESS_ROWS = 2000;

/** Matches the list scaffold's debounce, so search feels the same everywhere. */
const SEARCH_DEBOUNCE_MS = 200;

/** For the embedded tables, whose search lives in component state rather than the URL. */
export function useDebounced<T>(value: T, delayMs = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = React.useState(value);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return settled;
}

/* --------------------------- shared verdicts ------------------------ */

/** One threshold table, so a disk at 91% is red on every surface. */
export function usageTone(percent: number | null | undefined): Tone {
  if (percent == null || !Number.isFinite(percent)) return "neutral";
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warn";
  return "neutral";
}

export const SERVICE_STATE_TONE: Record<ServiceActiveState, Tone> = {
  active: "ok",
  reloading: "info",
  activating: "info",
  deactivating: "warn",
  inactive: "neutral",
  failed: "danger",
  unknown: "neutral",
};

export const CONTAINER_STATE_TONE: Record<ContainerState, Tone> = {
  running: "ok",
  restarting: "warn",
  paused: "warn",
  removing: "warn",
  created: "neutral",
  exited: "neutral",
  dead: "danger",
  unknown: "neutral",
};

/** Worst mount on the host: a full `/var` is a full server. */
export function worstDiskPercent(disks: readonly DiskUsage[] | undefined): number | null {
  if (!disks || disks.length === 0) return null;
  return disks.reduce((worst, disk) => Math.max(worst, disk.used_percent), 0);
}

export function hasContainerRuntime(server: Server | null | undefined): boolean {
  if (!server) return false;
  return server.capabilities.includes("docker") || server.capabilities.includes("podman");
}

/* ---------------------------- service verbs ------------------------- */

export const SERVICE_ACTIONS: readonly ServiceAction[] = [
  "start",
  "stop",
  "restart",
  "reload",
  "enable",
  "disable",
];

export const SERVICE_ACTION_LABELS: Record<ServiceAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  reload: "Reload",
  enable: "Enable at boot",
  disable: "Disable at boot",
};

export const SERVICE_ACTION_ICONS: Record<ServiceAction, IconComponent> = {
  start: Play,
  stop: CircleStop,
  restart: RotateCw,
  reload: RefreshCw,
  enable: ToggleRight,
  disable: ToggleLeft,
};

/** Verbs that leave something not running, now or after the next boot. */
export const SERVICE_ACTIONS_CONFIRMED: ReadonlySet<ServiceAction> = new Set<ServiceAction>([
  "stop",
  "disable",
]);

export type ContainerLifecycle = "start" | "stop" | "restart";

export const CONTAINER_ACTION_LABELS: Record<ContainerLifecycle, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
};

export const CONTAINER_ACTION_ICONS: Record<ContainerLifecycle, IconComponent> = {
  start: Play,
  stop: CircleStop,
  restart: RotateCw,
};

export const SIGNAL_ICON: IconComponent = Ban;

/* ------------------------------ metrics ----------------------------- */

export interface ServerMetricSample {
  ts: string;
  cpu_percent: number;
  memory_used: number;
  memory_total: number;
  swap_used: number;
  load1: number;
  load5: number;
  load15: number;
  processes: number;
  net_rx_rate: number;
  net_tx_rate: number;
  disks: DiskUsage[];
}

export interface ServerMetrics {
  server_id: string;
  range: TimeRange;
  samples: ServerMetricSample[];
}

export function useServerMetrics(
  serverId: string | null | undefined,
  range: TimeRange,
  enabled = true,
): UseQueryResult<ServerMetrics, ApiError> {
  return useQuery<ServerMetrics, ApiError>({
    queryKey: queryKeys.sub("servers", serverId ?? "none", "metrics", { range }),
    queryFn: ({ signal }) =>
      api.get<ServerMetrics>(`/servers/${serverId}/metrics`, { params: { range }, signal }),
    enabled: Boolean(serverId) && enabled,
    staleTime: DETAIL_STALE_TIME,
    refetchInterval: METRICS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

interface SeriesResponse {
  metric: MetricName;
  range: TimeRange;
  step_seconds: number;
  resolution: string;
  series: MetricSeries[];
}

/** Enough points to read a shape, short enough to stay in the raw table. */
const SPARKLINE_RANGE: TimeRange = "6h";

export type SparklineMetric = "cpu" | "memory" | "disk";

export interface FleetSparklines {
  /** metric -> server id -> values, oldest first. */
  values: Record<SparklineMetric, Map<string, number[]>>;
  isLoading: boolean;
}

const EMPTY_SERIES = new Map<string, number[]>();

function useFleetSeries(metric: SparklineMetric, enabled: boolean) {
  return useQuery<SeriesResponse, ApiError>({
    queryKey: queryKeys.sub("monitoring", "fleet", "series", { metric, range: SPARKLINE_RANGE }),
    queryFn: ({ signal }) =>
      api.get<SeriesResponse>("/monitoring/series", {
        params: { metric, range: SPARKLINE_RANGE },
        signal,
      }),
    enabled,
    staleTime: LIST_STALE_TIME,
  });
}

function indexSeries(response: SeriesResponse | undefined): Map<string, number[]> {
  if (!response) return EMPTY_SERIES;
  const map = new Map<string, number[]>();
  for (const series of response.series) {
    map.set(
      series.server_id,
      series.points.map((point) => point.value),
    );
  }
  return map;
}

/**
 * Fleet sparklines come from the monitoring series endpoint, which
 * answers for every server in scope in one query per metric — three
 * requests for the whole table instead of three per row.
 */
export function useFleetSparklines(enabled: boolean): FleetSparklines {
  const cpu = useFleetSeries("cpu", enabled);
  const memory = useFleetSeries("memory", enabled);
  const disk = useFleetSeries("disk", enabled);

  return React.useMemo(
    () => ({
      values: {
        cpu: indexSeries(cpu.data),
        memory: indexSeries(memory.data),
        disk: indexSeries(disk.data),
      },
      isLoading: cpu.isLoading || memory.isLoading || disk.isLoading,
    }),
    [cpu.data, cpu.isLoading, disk.data, disk.isLoading, memory.data, memory.isLoading],
  );
}

/* ------------------------------ storage ----------------------------- */

export function useStorage(
  serverId: string | null | undefined,
  enabled = true,
): UseQueryResult<StorageBreakdown, ApiError> {
  return useQuery<StorageBreakdown, ApiError>({
    queryKey: queryKeys.sub("storage", serverId ?? "none", "breakdown"),
    queryFn: ({ signal }) =>
      api.get<StorageBreakdown>("/storage", { params: { server_id: serverId }, signal }),
    enabled: Boolean(serverId) && enabled,
    staleTime: LIST_STALE_TIME,
    /* A never-sampled host answers 404 with a remediation; retrying it
     * only delays the operator reading that remediation. */
    retry: false,
  });
}

export function useStorageSample() {
  return useMutationWithJob<{ serverId: string; serverName: string }>({
    mutationFn: ({ serverId }) =>
      api.post<{ job: Job }>("/storage/sample", undefined, { params: { server_id: serverId } }),
    invalidates: ["storage", "servers"],
    describe: ({ serverName }) => `Sample storage on ${serverName}`,
  });
}

/* ------------------------------ servers ----------------------------- */

/**
 * Watches one server row while something is expected to change on it —
 * an enrollment landing, a reboot coming back. The SSE bridge already
 * invalidates on `server.connected`, and the poll is the belt to its
 * braces for the case where the event feed itself is what is broken.
 */
export function useServerWatch(
  serverId: string | null | undefined,
  enabled: boolean,
  intervalMs = 2000,
): UseQueryResult<Server, ApiError> {
  return useQuery<Server, ApiError>({
    queryKey: queryKeys.detail("servers", serverId ?? "none"),
    queryFn: ({ signal }) => api.get<Server>(`/servers/${serverId}`, { signal }),
    enabled: Boolean(serverId) && enabled,
    staleTime: 0,
    refetchInterval: intervalMs,
  });
}

export function useCreateServer(onCreated?: (server: Server) => void) {
  return useResourceMutation<CreateServerInput, Server>({
    mutationFn: (input) => api.post<Server>("/servers", input),
    invalidates: ["servers"],
    onDone: (server) => onCreated?.(server),
  });
}

export function useEnrollmentToken(onIssued?: (instructions: EnrollmentInstructions) => void) {
  return useResourceMutation<{ serverId: string }, EnrollmentInstructions>({
    mutationFn: ({ serverId }) =>
      api.post<EnrollmentInstructions>(`/servers/${serverId}/enroll-token`),
    onDone: (instructions) => onIssued?.(instructions),
  });
}

export function useServerReboot() {
  return useMutationWithJob<{ server: Server; delaySeconds: number }>({
    mutationFn: ({ server, delaySeconds }) =>
      api.post<{ job: Job }>(`/servers/${server.id}/reboot`, { delay_seconds: delaySeconds }),
    invalidates: ["servers"],
    describe: ({ server }) => `Reboot ${server.name}`,
  });
}

export function useServerSync() {
  return useMutationWithJob<{ server: Server }>({
    mutationFn: ({ server }) => api.post<{ job: Job }>(`/servers/${server.id}/sync`),
    invalidates: ["servers", "services", "containers"],
    describe: ({ server }) => `Sync ${server.name}`,
  });
}

export function useServerRevoke(onDone?: () => void) {
  return useResourceMutation<{ server: Server }, Server>({
    mutationFn: ({ server }) => api.post<Server>(`/servers/${server.id}/revoke`),
    invalidates: ["servers"],
    successMessage: (_result, { server }) => `${server.name}'s certificate is revoked.`,
    onDone: () => onDone?.(),
  });
}

export function useServerDelete(onDone?: () => void) {
  return useResourceMutation<{ server: Server }, void>({
    mutationFn: ({ server }) => api.del(`/servers/${server.id}`),
    invalidates: ["servers", "services", "containers"],
    successMessage: (_result, { server }) => `${server.name} was removed from Kaname.`,
    onDone: () => onDone?.(),
  });
}

/* ------------------------------ services ---------------------------- */

export function useServiceAction() {
  return useMutationWithJob<{ service: Service; action: ServiceAction }>({
    mutationFn: ({ service, action }) =>
      api.post<{ job: Job }>(`/services/${service.id}/${action}`),
    invalidates: ["services", "servers"],
    describe: ({ service, action }) => `${SERVICE_ACTION_LABELS[action]} ${service.unit}`,
  });
}

export function useServiceBulkAction() {
  return useMutationWithJob<{ action: ServiceAction; ids: string[] }>({
    mutationFn: ({ action, ids }) =>
      api.post<{ jobs: Job[]; correlation_id: string }>("/services/bulk", { action, ids }),
    invalidates: ["services", "servers"],
    describe: ({ action, ids }) =>
      `${SERVICE_ACTION_LABELS[action]} ${pluralize(ids.length, "unit")}`,
  });
}

interface SyncResult {
  server_id: string;
  synced_at: string;
  units?: number;
  containers?: number;
}

export function useServiceSync() {
  return useResourceMutation<{ serverId: string; serverName: string }, SyncResult>({
    mutationFn: ({ serverId }) =>
      api.post<SyncResult>("/services/sync", undefined, { params: { server_id: serverId } }),
    invalidates: ["services", "servers"],
    successMessage: (result, { serverName }) =>
      `${pluralize(result.units ?? 0, "unit")} synced from ${serverName}.`,
  });
}

/* ----------------------------- containers --------------------------- */

/** The detail route merges a live inspect over the cached row. */
export type ContainerDetail = Container & { inspect: unknown };

export function useContainerDetail(id: string | null | undefined) {
  return useQuery<ContainerDetail, ApiError>({
    queryKey: queryKeys.detail("containers", id ?? "none"),
    queryFn: ({ signal }) => api.get<ContainerDetail>(`/containers/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: DETAIL_STALE_TIME,
  });
}

export function useContainerAction() {
  return useMutationWithJob<{ container: Container; action: ContainerLifecycle }>({
    mutationFn: ({ container, action }) =>
      api.post<{ job: Job }>(`/containers/${container.id}/${action}`),
    invalidates: ["containers", "servers"],
    describe: ({ container, action }) => `${CONTAINER_ACTION_LABELS[action]} ${container.name}`,
  });
}

export function useContainerRemove() {
  return useMutationWithJob<{ container: Container; force: boolean; removeVolumes: boolean }>({
    mutationFn: ({ container, force, removeVolumes }) =>
      api.del<{ job: Job }>(`/containers/${container.id}`, {
        params: { force, remove_volumes: removeVolumes },
      }),
    invalidates: ["containers", "servers"],
    describe: ({ container }) => `Remove ${container.name}`,
  });
}

export function useContainerPrune() {
  return useMutationWithJob<{
    serverId: string;
    serverName: string;
    includeImages: boolean;
    includeVolumes: boolean;
  }>({
    mutationFn: ({ serverId, includeImages, includeVolumes }) =>
      api.post<{ job: Job }>("/containers/prune", {
        server_id: serverId,
        include_images: includeImages,
        include_volumes: includeVolumes,
      }),
    invalidates: ["containers", "storage", "servers"],
    describe: ({ serverName }) => `Prune containers on ${serverName}`,
  });
}

export function useContainerSync() {
  return useResourceMutation<{ serverId: string; serverName: string }, SyncResult>({
    mutationFn: ({ serverId }) =>
      api.post<SyncResult>("/containers/sync", undefined, { params: { server_id: serverId } }),
    invalidates: ["containers", "servers"],
    successMessage: (result, { serverName }) =>
      `${pluralize(result.containers ?? 0, "container")} synced from ${serverName}.`,
  });
}

/* ------------------------------ processes --------------------------- */

export type ProcessSort = "cpu" | "memory" | "pid" | "name";
export type ProcessView = "flat" | "tree";

/** The direction each sort actually arrives in, so the header cannot lie. */
export const PROCESS_SORT_ORDER: Record<ProcessSort, "asc" | "desc"> = {
  cpu: "desc",
  memory: "desc",
  pid: "asc",
  name: "asc",
};

export interface ProcessListParams {
  serverId: string | null;
  q: string;
  user: string;
  sort: ProcessSort;
  view: ProcessView;
  page: number;
  perPage: number;
  refreshMs: number | false;
  enabled: boolean;
}

/**
 * Processes are never cached (KD-012): the endpoint reads the host live
 * and returns the top `limit` rows in the requested order. Paging is
 * therefore "ask for more, show the tail" rather than an offset — the
 * host has no stable cursor to offset against between two samples.
 */
export function useProcesses({
  serverId,
  q,
  user,
  sort,
  view,
  page,
  perPage,
  refreshMs,
  enabled,
}: ProcessListParams): UseQueryResult<ListResult<ProcessRow>, ApiError> {
  const limit = Math.min(MAX_PROCESS_ROWS, page * perPage);

  return useQuery<ListResult<ProcessRow>, ApiError>({
    queryKey: queryKeys.list("processes", {
      server_id: serverId,
      q,
      user,
      sort,
      view,
      limit,
      page,
    }),
    queryFn: async ({ signal }) => {
      const result = await api.list<ProcessRow>("/processes", {
        params: {
          server_id: serverId,
          q: q || undefined,
          user: user || undefined,
          sort,
          view,
          limit,
        },
        signal,
      });
      const start = (page - 1) * perPage;
      return {
        data: result.data.slice(start, start + perPage),
        meta: {
          page,
          per_page: perPage,
          total: result.meta.total,
          has_more: result.meta.total > page * perPage,
        },
      };
    },
    enabled: Boolean(serverId) && enabled,
    staleTime: 0,
    refetchInterval: refreshMs,
    placeholderData: keepPreviousData,
  });
}

export function useProcessSignal() {
  return useMutationWithJob<{ pid: number; serverId: string; signal: SignalName; command: string }>(
    {
      mutationFn: ({ pid, serverId, signal }) =>
        api.post<{ job: Job }>(`/processes/${pid}/signal`, { server_id: serverId, signal }),
      invalidates: ["processes"],
      describe: ({ signal, pid, command }) => `${signal} to ${command} (pid ${pid})`,
    },
  );
}
