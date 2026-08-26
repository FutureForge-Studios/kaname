"use client";

import * as React from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  buildEffectiveGrants,
  can as evaluate,
  scopeFor,
  type CommandCenterSummary,
  type EffectiveGrants,
  type EventTopic,
  type Job,
  type JobLogLine,
  type JobType,
  type Permission,
  type RoleGrant,
  type Server,
  type User,
  type UserPreferences,
} from "@kaname/contract";
import { useToast } from "@kaname/ui";
import { api, toApiError, type ApiError, type ListResult, type QueryParams } from "./api";
import type { StreamMessage } from "./events";

/* ------------------------------------------------------------------ *
 * Query keys, shared hooks and the job-tracking contract.
 *
 * Every module reads through the four hooks below, which is what makes
 * thirty pages behave identically: the same staleness, the same
 * pagination behaviour, the same error type, and — for anything that
 * touches a host — the same job lifecycle (KD-008). A page that fetched
 * on its own would be the one page whose "synced 12s ago" lies.
 * ------------------------------------------------------------------ */

/** Lists are cached long enough to survive navigation, short enough to feel live. */
export const LIST_STALE_TIME = 30_000;
export const DETAIL_STALE_TIME = 15_000;

const ROOT = "kaname" as const;

/**
 * A resource family is both the query-key namespace and the API path,
 * so `useList("servers")` and an incoming `servers` event can never
 * disagree about what to invalidate.
 */
export type ResourceFamily = string;

function normalizeParams(params: QueryParams | undefined): Record<string, string> {
  if (!params) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}

export const queryKeys = {
  family: (resource: ResourceFamily) => [ROOT, resource] as const,
  list: (resource: ResourceFamily, params?: QueryParams) =>
    [ROOT, resource, "list", normalizeParams(params)] as const,
  detail: (resource: ResourceFamily, id: string) => [ROOT, resource, "detail", id] as const,
  sub: (resource: ResourceFamily, id: string, part: string, params?: QueryParams) =>
    [ROOT, resource, "detail", id, part, normalizeParams(params)] as const,
  session: () => [ROOT, "session"] as const,
  dashboard: () => [ROOT, "dashboard"] as const,
  job: (id: string) => [ROOT, "jobs", "detail", id] as const,
  jobLogs: (id: string) => [ROOT, "jobs", "logs", id] as const,
  search: (q: string) => [ROOT, "search", q] as const,
};

export function invalidateFamilies(client: QueryClient, families: Iterable<ResourceFamily>): void {
  for (const family of families) {
    void client.invalidateQueries({ queryKey: queryKeys.family(family) });
  }
}

/* ------------------------------------------------------------------ *
 * Generic resource hooks
 * ------------------------------------------------------------------ */

export interface UseListOptions {
  /** Defaults to `/${resource}`; set it for nested routes like `backups/schedules`. */
  path?: string;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
}

/**
 * The one list hook. `placeholderData` holds the previous page on
 * screen while the next one loads, so paging does not flash a skeleton
 * over rows the operator was already reading.
 */
export function useList<T>(
  resource: ResourceFamily,
  params?: QueryParams,
  options: UseListOptions = {},
): UseQueryResult<ListResult<T>, ApiError> {
  const path = options.path ?? `/${resource}`;
  return useQuery<ListResult<T>, ApiError>({
    queryKey: queryKeys.list(resource, params),
    queryFn: ({ signal }) => api.list<T>(path, { params, signal }),
    staleTime: options.staleTime ?? LIST_STALE_TIME,
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: options.refetchInterval ?? false,
  });
}

export interface UseResourceOptions {
  path?: string;
  enabled?: boolean;
  staleTime?: number;
}

export function useResource<T>(
  resource: ResourceFamily,
  id: string | null | undefined,
  options: UseResourceOptions = {},
): UseQueryResult<T, ApiError> {
  const path = options.path ?? `/${resource}/${id ?? ""}`;
  return useQuery<T, ApiError>({
    queryKey: queryKeys.detail(resource, id ?? "none"),
    queryFn: ({ signal }) => api.get<T>(path, { signal }),
    staleTime: options.staleTime ?? DETAIL_STALE_TIME,
    enabled: Boolean(id) && (options.enabled ?? true),
  });
}

/* ------------------------------------------------------------------ *
 * Fleet, jobs and the dashboard
 * ------------------------------------------------------------------ */

/**
 * Every server-scoped page needs the same list to populate its picker,
 * so it is one query with a long stale time rather than one per page.
 */
export function useServers(): UseQueryResult<ListResult<Server>, ApiError> {
  return useList<Server>("servers", { per_page: 200, sort: "name", order: "asc" });
}

export function useJob(id: string | null | undefined): UseQueryResult<Job, ApiError> {
  return useQuery<Job, ApiError>({
    queryKey: queryKeys.job(id ?? "none"),
    queryFn: ({ signal }) => api.get<Job>(`/jobs/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 0,
  });
}

export function useJobLogs(id: string | null | undefined): UseQueryResult<JobLogLine[], ApiError> {
  return useQuery<JobLogLine[], ApiError>({
    queryKey: queryKeys.jobLogs(id ?? "none"),
    queryFn: ({ signal }) =>
      api.get<JobLogLine[]>(`/jobs/${id}/logs`, { params: { per_page: 500 }, signal }),
    enabled: Boolean(id),
    staleTime: 0,
  });
}

export type DashboardSummary = Omit<CommandCenterSummary, "recent_jobs" | "recent_audit"> & {
  recent_jobs: Job[];
  recent_audit: AuditRow[];
};

/** The audit shape the dashboard returns, narrowed from the contract's `unknown`. */
export interface AuditRow {
  id: string;
  ts: string;
  actor_type: "user" | "api_key" | "agent" | "system";
  actor_name: string;
  action: string;
  target_type: string;
  target_label: string;
  server_name: string | null;
}

export function useDashboard(): UseQueryResult<DashboardSummary, ApiError> {
  return useQuery<DashboardSummary, ApiError>({
    queryKey: queryKeys.dashboard(),
    queryFn: ({ signal }) => api.get<DashboardSummary>("/dashboard", { signal }),
    staleTime: LIST_STALE_TIME,
  });
}

/* ------------------------------------------------------------------ *
 * Session and permissions
 * ------------------------------------------------------------------ */

export interface SessionPayload {
  user: User | null;
  api_key: { id: string; name: string } | null;
  permissions: RoleGrant[];
  totp_required: boolean;
  /** Display choices that follow the account, not the browser. */
  preferences?: UserPreferences;
}

export interface SessionValue {
  session: SessionPayload | null;
  grants: EffectiveGrants;
  /** Nav visibility passes no server id; a mutation must always pass one. */
  can: (permission: Permission, serverId?: string | null) => boolean;
  /** Server ids this principal may exercise a permission on. */
  scope: (permission: Permission) => "global" | readonly string[] | null;
  isLoading: boolean;
  error: ApiError | null;
  /**
   * Re-reads the session probe. Awaitable, because signing in has to
   * land on a resolved answer: the shell decides whether to admit a
   * navigation from this cache, and a stale "not signed in" left over
   * from the login screen bounces the operator straight back to it.
   */
  refresh: () => Promise<void>;
}

const EMPTY_GRANTS = buildEffectiveGrants([]);

const SessionContext = React.createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();

  const query = useQuery<SessionPayload, ApiError>({
    queryKey: queryKeys.session(),
    queryFn: ({ signal }) =>
      api.get<SessionPayload>("/auth/session", { signal, allowUnauthenticated: true }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const value = React.useMemo<SessionValue>(() => {
    const session = query.data ?? null;
    const grants = session ? buildEffectiveGrants(session.permissions) : EMPTY_GRANTS;
    return {
      session,
      grants,
      can: (permission, serverId) => evaluate(grants, permission, serverId ?? undefined),
      scope: (permission) => scopeFor(grants, permission),
      isLoading: query.isLoading,
      error: query.error ?? null,
      refresh: () => client.invalidateQueries({ queryKey: queryKeys.session() }),
    };
  }, [client, query.data, query.error, query.isLoading]);

  return React.createElement(SessionContext.Provider, { value }, children);
}

export function useSession(): SessionValue {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside <SessionProvider>");
  return context;
}

/**
 * Hides what the caller cannot do. Defence in depth only — the control
 * plane re-checks every permission, because a hidden button is not a
 * security control.
 */
export function useCan(): (permission: Permission, serverId?: string | null) => boolean {
  return useSession().can;
}

/* ------------------------------------------------------------------ *
 * Job drawer
 *
 * The drawer owns the "what did I just start" state for the whole app.
 * A mutation hands it a job plus the query families that job will
 * invalidate once it lands, and the SSE bridge feeds it transitions —
 * so a restart started on the services page still resolves correctly
 * after navigating to the dashboard.
 * ------------------------------------------------------------------ */

export interface TrackedJob {
  job: Job;
  invalidates: readonly ResourceFamily[];
  trackedAt: number;
  settled: boolean;
}

export interface JobDrawerValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  tracked: TrackedJob[];
  /** Jobs this session started that have not reached a terminal state. */
  activeCount: number;
  /** Job the drawer should scroll to and expand. */
  focusedJobId: string | null;
  focusJob: (id: string | null) => void;
  track: (job: Job, invalidates?: readonly ResourceFamily[]) => void;
  clearSettled: () => void;
  /** Called by the SSE bridge for every `jobs` topic message. */
  note: (message: StreamMessage) => void;
}

const TERMINAL_EVENTS = new Set(["job.succeeded", "job.failed", "job.cancelled", "job.timed_out"]);
const MAX_TRACKED = 50;

const JobDrawerContext = React.createContext<JobDrawerValue | null>(null);

interface JobEventData {
  job_id?: string;
  job_type?: JobType;
  server_id?: string | null;
  level?: JobLogLine["level"];
  message?: string;
  progress?: number;
  error?: { code: string; message: string };
}

export function JobDrawerProvider({ children }: { children: React.ReactNode }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [focusedJobId, setFocusedJobId] = React.useState<string | null>(null);
  const [tracked, setTracked] = React.useState<TrackedJob[]>([]);

  const trackedRef = React.useRef<TrackedJob[]>(tracked);
  trackedRef.current = tracked;

  const track = React.useCallback((job: Job, invalidates: readonly ResourceFamily[] = []) => {
    setTracked((prev) => {
      const rest = prev.filter((entry) => entry.job.id !== job.id);
      return [{ job, invalidates, trackedAt: Date.now(), settled: false }, ...rest].slice(
        0,
        MAX_TRACKED,
      );
    });
  }, []);

  const clearSettled = React.useCallback(() => {
    setTracked((prev) => prev.filter((entry) => !entry.settled));
  }, []);

  const note = React.useCallback(
    (message: StreamMessage) => {
      const data = (message.data ?? {}) as JobEventData;
      const jobId = data.job_id;
      if (!jobId) return;

      if (message.type === "job.log" && data.message) {
        // Appending beats refetching: the drawer is usually watching a
        // job that is emitting a line every few hundred milliseconds.
        client.setQueryData<JobLogLine[]>(queryKeys.jobLogs(jobId), (previous) => {
          const lines = previous ?? [];
          const last = lines[lines.length - 1];
          return [
            ...lines,
            {
              seq: (last?.seq ?? 0) + 1,
              ts: message.ts,
              level: data.level ?? "info",
              message: data.message ?? "",
            },
          ];
        });
        return;
      }

      void client.invalidateQueries({ queryKey: queryKeys.job(jobId) });

      if (!TERMINAL_EVENTS.has(message.type)) return;

      const entry = trackedRef.current.find((candidate) => candidate.job.id === jobId);
      if (!entry || entry.settled) return;

      const openTo = (id: string): void => {
        setFocusedJobId(id);
        setOpen(true);
      };

      void (async () => {
        const job = await api.get<Job>(`/jobs/${jobId}`).catch(() => null);
        if (job) {
          client.setQueryData(queryKeys.job(jobId), job);
          setTracked((prev) =>
            prev.map((candidate) =>
              candidate.job.id === jobId ? { ...candidate, job, settled: true } : candidate,
            ),
          );
        } else {
          setTracked((prev) =>
            prev.map((candidate) =>
              candidate.job.id === jobId ? { ...candidate, settled: true } : candidate,
            ),
          );
        }

        invalidateFamilies(client, [...entry.invalidates, "jobs"]);
        void client.invalidateQueries({ queryKey: queryKeys.dashboard() });

        const label = job?.label ?? entry.job.label;
        const where = job?.server_name ?? entry.job.server_name;
        const suffix = where ? ` on ${where}` : "";

        if (message.type === "job.succeeded") {
          toast({
            variant: "success",
            title: `${label}${suffix}`,
            description: "Completed.",
            job: { id: jobId, onClick: () => openTo(jobId) },
          });
          return;
        }

        toast({
          variant: "error",
          title: `${label}${suffix}`,
          description:
            job?.error?.message ??
            data.error?.message ??
            (message.type === "job.cancelled" ? "Cancelled." : "Did not complete."),
          job: { id: jobId, onClick: () => openTo(jobId) },
        });
      })();
    },
    [client, toast],
  );

  const value = React.useMemo<JobDrawerValue>(
    () => ({
      open,
      setOpen,
      tracked,
      activeCount: tracked.filter((entry) => !entry.settled).length,
      focusedJobId,
      focusJob: setFocusedJobId,
      track,
      clearSettled,
      note,
    }),
    [clearSettled, focusedJobId, note, open, track, tracked],
  );

  return React.createElement(JobDrawerContext.Provider, { value }, children);
}

export function useJobDrawer(): JobDrawerValue {
  const context = React.useContext(JobDrawerContext);
  if (!context) throw new Error("useJobDrawer must be used inside <JobDrawerProvider>");
  return context;
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

type JobResponse = { job: Job } | { jobs: Job[]; correlation_id: string } | Job;

function jobsOf(response: JobResponse): Job[] {
  if ("jobs" in response && Array.isArray(response.jobs)) return response.jobs;
  if ("job" in response && response.job) return [response.job];
  if ("id" in response && "status" in response) return [response as Job];
  return [];
}

export interface JobMutationOptions<TVars> {
  mutationFn: (variables: TVars) => Promise<JobResponse>;
  /** Query families refreshed once the job reaches a terminal state. */
  invalidates?: readonly ResourceFamily[];
  /** Acknowledgement line. The outcome belongs to the job, not to a toast (KD-008). */
  describe?: (variables: TVars, jobs: Job[]) => string;
  onQueued?: (jobs: Job[], variables: TVars) => void;
  onFailed?: (error: ApiError, variables: TVars) => void;
}

/**
 * The single entry point for any mutation that reaches a host. It fires
 * the request, opens the job drawer on the resulting job, and lets the
 * SSE bridge carry it to completion. Callers never see a spinner that
 * has to guess whether `systemctl restart` happened.
 */
export function useMutationWithJob<TVars = void>(
  options: JobMutationOptions<TVars>,
): UseMutationResult<Job[], ApiError, TVars> {
  const drawer = useJobDrawer();
  const { toast } = useToast();
  const { mutationFn, invalidates = [], describe, onQueued, onFailed } = options;

  return useMutation<Job[], ApiError, TVars>({
    mutationFn: async (variables) => jobsOf(await mutationFn(variables)),
    onSuccess: (jobs, variables) => {
      for (const job of jobs) drawer.track(job, invalidates);
      const first = jobs[0];
      if (first) {
        drawer.focusJob(first.id);
        drawer.setOpen(true);
        toast({
          variant: "info",
          title: describe?.(variables, jobs) ?? queuedTitle(jobs),
          description: jobs.length > 1 ? `${jobs.length} jobs queued.` : "Queued.",
          job: { id: first.id, onClick: () => drawer.setOpen(true) },
        });
      }
      onQueued?.(jobs, variables);
    },
    onError: (error, variables) => {
      toast({
        variant: "error",
        title: error.message,
        description: error.remediation?.summary,
      });
      onFailed?.(error, variables);
    },
  });
}

function queuedTitle(jobs: Job[]): string {
  const first = jobs[0];
  if (!first) return "Queued";
  const where = first.server_name ? ` on ${first.server_name}` : "";
  return jobs.length > 1 ? `${first.label} on ${jobs.length} servers` : `${first.label}${where}`;
}

export interface ResourceMutationOptions<TVars, TResult> {
  mutationFn: (variables: TVars) => Promise<TResult>;
  invalidates?: readonly ResourceFamily[];
  successMessage?: (result: TResult, variables: TVars) => string;
  onDone?: (result: TResult, variables: TVars) => void;
  onFailed?: (error: ApiError, variables: TVars) => void;
}

/**
 * Control-plane-only mutations — creating a server row, editing a role,
 * changing a setting — resolve immediately, so they toast and
 * invalidate. Same call shape as the job flavour so a form does not
 * change structure depending on where its work happens.
 */
export function useResourceMutation<TVars = void, TResult = unknown>(
  options: ResourceMutationOptions<TVars, TResult>,
): UseMutationResult<TResult, ApiError, TVars> {
  const client = useQueryClient();
  const { toast } = useToast();
  const { mutationFn, invalidates = [], successMessage, onDone, onFailed } = options;

  return useMutation<TResult, ApiError, TVars>({
    mutationFn: async (variables) => {
      try {
        return await mutationFn(variables);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: (result, variables) => {
      invalidateFamilies(client, invalidates);
      const message = successMessage?.(result, variables);
      if (message) toast({ variant: "success", title: message });
      onDone?.(result, variables);
    },
    onError: (error, variables) => {
      toast({
        variant: "error",
        title: error.message,
        description: error.remediation?.summary,
      });
      onFailed?.(error, variables);
    },
  });
}

/* ------------------------------------------------------------------ *
 * Event routing
 *
 * The control plane publishes coarse topics; the UI caches fine-grained
 * lists. This table is the translation, and it is the reason a
 * `job.succeeded` for `service.restart` refreshes the services list
 * without every page subscribing to anything.
 * ------------------------------------------------------------------ */

const TOPIC_FAMILIES: Record<EventTopic, readonly ResourceFamily[]> = {
  jobs: ["jobs"],
  servers: ["servers"],
  services: ["services"],
  containers: ["containers"],
  threats: ["threats", "ip-blocks"],
  alerts: ["alerts", "alert-rules"],
  deployments: ["deployments", "sites"],
  certificates: ["certificates", "domains"],
  backups: ["backups/runs", "backups/schedules", "backups/destinations", "backups/restore-points"],
  audit: ["audit"],
  updates: ["updates", "update-runs"],
};

/** Job type prefix -> the lists that job changes when it succeeds. */
const JOB_FAMILIES: readonly [string, readonly ResourceFamily[]][] = [
  ["system.", ["servers"]],
  ["service.", ["services", "servers"]],
  ["process.", ["processes"]],
  ["container.", ["containers"]],
  ["fs.", ["files", "storage"]],
  ["ftp.", ["ftp-accounts"]],
  ["site.", ["sites"]],
  ["cert.", ["certificates", "domains"]],
  ["dns.", ["dns", "domains"]],
  ["deployment.", ["deployments", "sites"]],
  ["mail.mailbox.", ["mailboxes"]],
  ["mail.alias.", ["mail-aliases"]],
  ["mail.forwarder.", ["mail-forwarders"]],
  ["mail.auth.", ["mail-auth"]],
  ["mail.domain.", ["mail-domains", "mailboxes"]],
  ["db.database.", ["databases", "db-instances"]],
  ["db.user.", ["db-users"]],
  ["db.grant.", ["db-users", "databases"]],
  ["db.dump", ["databases"]],
  ["db.restore", ["databases"]],
  ["fw.", ["firewall", "threats", "ip-blocks"]],
  ["ssh.", ["ssh"]],
  ["backup.", ["backups/runs", "backups/schedules", "backups/restore-points"]],
];

/** Topics whose arrival should also refresh the Command Center. */
const DASHBOARD_TOPICS = new Set<EventTopic>([
  "jobs",
  "servers",
  "services",
  "threats",
  "alerts",
  "certificates",
  "backups",
  "audit",
]);

export function familiesForEvent(message: StreamMessage): ResourceFamily[] {
  const families = new Set<ResourceFamily>(TOPIC_FAMILIES[message.topic] ?? []);

  const jobType = (message.data as { job_type?: string } | null)?.job_type;
  if (jobType) {
    for (const [prefix, targets] of JOB_FAMILIES) {
      if (!jobType.startsWith(prefix)) continue;
      for (const target of targets) families.add(target);
    }
  }

  return [...families];
}

export function eventTouchesDashboard(message: StreamMessage): boolean {
  return DASHBOARD_TOPICS.has(message.topic);
}
