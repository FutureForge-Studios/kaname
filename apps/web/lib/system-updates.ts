"use client";

import * as React from "react";
import {
  TERMINAL_JOB_STATUSES,
  type Job,
  type OsUpdatesFleet,
  type ServerOsUpdates,
} from "@kaname/contract";
import { api } from "@/lib/api";
import {
  useJobDrawer,
  useMutationWithJob,
  useResource,
  useResourceMutation,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Operating-system updates — the host's packages, not Kaname's.
 *
 * Every read is the control plane's cache (KD-041); the only live call
 * is the explicit refresh. Upgrading is a job like any other, so the
 * drawer and the in-page activity strip carry it to completion, and its
 * success re-reads the cache through the `system.packages.` job family.
 * ------------------------------------------------------------------ */

export const OS_UPDATES = "os-updates";

export function useServerOsUpdates(serverId: string | null | undefined, enabled = true) {
  return useResource<ServerOsUpdates>(OS_UPDATES, serverId, {
    path: `/servers/${serverId ?? ""}/os-updates`,
    enabled,
  });
}

export function useOsUpdatesFleet(enabled = true) {
  return useResource<OsUpdatesFleet>(OS_UPDATES, "fleet", { path: "/os-updates", enabled });
}

export function useRefreshOsUpdates() {
  return useResourceMutation<{ serverId: string }, ServerOsUpdates>({
    mutationFn: ({ serverId }) => api.post<ServerOsUpdates>(`/servers/${serverId}/os-updates/refresh`),
    invalidates: [OS_UPDATES, "dashboard"],
    successMessage: (result) =>
      result.state === "error"
        ? `The check failed: ${result.error ?? "unknown error"}`
        : result.state === "unsupported"
          ? `${result.server_name} has no package manager Kaname can drive.`
          : result.total === 0
            ? `${result.server_name} is up to date.`
            : `${result.total} ${result.total === 1 ? "update" : "updates"} pending on ${result.server_name}.`,
  });
}

export function useUpgradeOsPackages() {
  return useMutationWithJob<{ serverId: string; serverName: string; securityOnly: boolean }>({
    mutationFn: ({ serverId, securityOnly }) =>
      api.post<{ job: Job }>(`/servers/${serverId}/os-updates/upgrade`, {
        security_only: securityOnly,
      }),
    invalidates: [OS_UPDATES, "servers"],
    describe: ({ serverName, securityOnly }) =>
      securityOnly ? `Security updates on ${serverName}` : `Upgrade packages on ${serverName}`,
  });
}

export function useBulkUpgradeOsPackages() {
  return useMutationWithJob<{ serverIds: string[]; securityOnly: boolean }>({
    mutationFn: ({ serverIds, securityOnly }) =>
      api.post<{ jobs: Job[]; correlation_id: string }>("/os-updates/upgrade", {
        server_ids: serverIds,
        security_only: securityOnly,
      }),
    invalidates: [OS_UPDATES, "servers"],
  });
}

export function useOsUpdateSettings() {
  return useResourceMutation<{ serverId: string; autoSecurity: boolean }, ServerOsUpdates>({
    mutationFn: ({ serverId, autoSecurity }) =>
      api.patch<ServerOsUpdates>(`/servers/${serverId}/os-updates/settings`, {
        auto_security: autoSecurity,
      }),
    invalidates: [OS_UPDATES],
    successMessage: (result) =>
      result.auto_security
        ? `Security updates on ${result.server_name} now apply themselves.`
        : `Automatic security updates are off on ${result.server_name}.`,
  });
}

const TERMINAL = new Set<Job["status"]>(TERMINAL_JOB_STATUSES);

/** Server ids with a package upgrade this session started that has not finished. */
export function useUpgradesInFlight(): ReadonlySet<string> {
  const drawer = useJobDrawer();
  return React.useMemo(
    () =>
      new Set(
        drawer.tracked
          .filter(
            (entry) =>
              entry.job.type === "system.packages.upgrade" &&
              !entry.settled &&
              !TERMINAL.has(entry.job.status) &&
              entry.job.server_id,
          )
          .map((entry) => entry.job.server_id!),
      ),
    [drawer.tracked],
  );
}
