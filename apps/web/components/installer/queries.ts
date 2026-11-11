"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  AppInstall,
  AppInstallPlan,
  AppInstallStatus,
  AppRecipe,
  InstallAppInput,
  Job,
} from "@kaname/contract";
import { api, toApiError, type ApiError, type ListResult, type QueryParams } from "@/lib/api";
import {
  DETAIL_STALE_TIME,
  invalidateFamilies,
  LIST_STALE_TIME,
  queryKeys,
  useJobDrawer,
  useList,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The app installer's data layer.
 *
 * Two families: the catalog (static data from the contract, served so
 * a future catalog can change without a web release) and installs.
 * An install's progress lives on its row (`steps`), which the job
 * writes as each step starts and ends; while a row is in flight the
 * detail query polls it, so the checklist moves without the page
 * having to know which SSE events touch it.
 * ------------------------------------------------------------------ */

export const INSTALLS = "apps/installs";
const CATALOG = "apps/catalog";

/** Statuses during which a job is working on the row. */
export const IN_FLIGHT: ReadonlySet<AppInstallStatus> = new Set([
  "queued",
  "installing",
  "rolling_back",
  "removing",
]);

const POLL_MS = 1500;

export function useAppCatalog(): UseQueryResult<ListResult<AppRecipe>, ApiError> {
  return useList<AppRecipe>(CATALOG, undefined, { staleTime: 5 * 60_000 });
}

export function useAppInstalls(
  params?: QueryParams,
): UseQueryResult<ListResult<AppInstall>, ApiError> {
  const merged: QueryParams = { per_page: 100, ...params };
  return useQuery<ListResult<AppInstall>, ApiError>({
    queryKey: queryKeys.list(INSTALLS, merged),
    queryFn: ({ signal }) => api.list<AppInstall>(`/${INSTALLS}`, { params: merged, signal }),
    staleTime: LIST_STALE_TIME,
    placeholderData: keepPreviousData,
    // Keep the list honest while anything on it is moving.
    refetchInterval: (query) =>
      query.state.data?.data.some((row) => IN_FLIGHT.has(row.status)) ? POLL_MS * 2 : false,
  });
}

export function useAppInstall(id: string | null | undefined): UseQueryResult<AppInstall, ApiError> {
  return useQuery<AppInstall, ApiError>({
    queryKey: queryKeys.detail(INSTALLS, id ?? "none"),
    queryFn: ({ signal }) => api.get<AppInstall>(`/${INSTALLS}/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: DETAIL_STALE_TIME,
    refetchInterval: (query) =>
      query.state.data && IN_FLIGHT.has(query.state.data.status) ? POLL_MS : false,
  });
}

/** The dry run: every check the install runs, and the names it would create. */
export function usePlanInstall() {
  return useMutation<AppInstallPlan, ApiError, InstallAppInput>({
    mutationFn: async (input) => {
      try {
        return await api.post<AppInstallPlan>(`/${INSTALLS}/plan`, input);
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
}

/** Families an install or uninstall changes once its job settles. */
const INSTALL_FAMILIES = [INSTALLS, "sites", "domains", "databases", "db-users", "certificates"];

export function useInstallApp() {
  const client = useQueryClient();
  const drawer = useJobDrawer();
  return useMutation<{ job: Job; install: AppInstall }, ApiError, InstallAppInput>({
    mutationFn: async (input) => {
      try {
        return await api.post<{ job: Job; install: AppInstall }>(`/${INSTALLS}`, input);
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: ({ job, install }) => {
      // The drawer keeps the raw log; the install page shows the steps.
      drawer.track(job, INSTALL_FAMILIES);
      client.setQueryData(queryKeys.detail(INSTALLS, install.id), install);
      invalidateFamilies(client, [INSTALLS]);
    },
  });
}

export function useUninstallApp() {
  const client = useQueryClient();
  const drawer = useJobDrawer();
  return useMutation<Job | null, ApiError, AppInstall>({
    mutationFn: async (install) => {
      try {
        // 202 with the removal job, or 204 when a failed install left nothing to remove.
        const job = await api.del<Job | undefined>(`/${INSTALLS}/${install.id}`);
        return job && typeof job === "object" && "id" in job ? job : null;
      } catch (err) {
        throw toApiError(err);
      }
    },
    onSuccess: (job) => {
      if (job) drawer.track(job, INSTALL_FAMILIES);
      invalidateFamilies(client, [INSTALLS]);
    },
  });
}
