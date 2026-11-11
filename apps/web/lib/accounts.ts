"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  AccountQuota,
  Client,
  OwnedResource,
  QuotaUsage,
  Reseller,
  ResellerBranding,
  ResourceKind,
} from "@kaname/contract";
import { api, type ApiError } from "./api";
import { LIST_STALE_TIME } from "./queries";

/* ------------------------------------------------------------------ *
 * Resellers, clients and ownership (KD-039).
 *
 * Two families, because they are two authorities:
 *   "resellers"  an operator managing resellers (/resellers/*)
 *   "reseller"   a reseller managing its own clients (/reseller/*)
 * plus "me", the account card the shell reads. A mutation here
 * invalidates all three: a quota change moves meters everywhere.
 * ------------------------------------------------------------------ */

export const ACCOUNT_FAMILIES = ["resellers", "reseller", "me"] as const;

function useGet<T>(
  key: readonly unknown[],
  path: string,
  enabled = true,
): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey: ["kaname", ...key],
    queryFn: ({ signal }) => api.get<T>(path, { signal }),
    staleTime: LIST_STALE_TIME,
    enabled,
  });
}

/* ------------------------------ operator ---------------------------- */

export const useResellers = (enabled = true) =>
  useGet<Reseller[]>(["resellers", "list"], "/resellers", enabled);

export const useResellerDetail = (id: string) =>
  useGet<Reseller>(["resellers", "detail", id], `/resellers/${id}`);

export const useResellerClients = (id: string) =>
  useGet<Client[]>(["resellers", "detail", id, "clients"], `/resellers/${id}/clients`);

export const useResellerResources = (id: string) =>
  useGet<OwnedResource[]>(["resellers", "detail", id, "resources"], `/resellers/${id}/resources`);

export const useUnownedResources = (kind: ResourceKind, enabled = true) =>
  useGet<OwnedResource[]>(
    ["resellers", "unowned", kind],
    `/resources/unowned?kind=${encodeURIComponent(kind)}`,
    enabled,
  );

/* ------------------------------ reseller ---------------------------- */

export const useMyClients = (enabled = true) =>
  useGet<Client[]>(["reseller", "clients"], "/reseller/clients", enabled);

export const useMyClient = (id: string, enabled = true) =>
  useGet<Client>(["reseller", "clients", id], `/reseller/clients/${id}`, enabled);

export const useMyClientResources = (id: string, enabled = true) =>
  useGet<OwnedResource[]>(
    ["reseller", "clients", id, "resources"],
    `/reseller/clients/${id}/resources`,
    enabled,
  );

export const useMyPool = (enabled = true) =>
  useGet<OwnedResource[]>(["reseller", "resources"], "/reseller/resources", enabled);

export const useMyBranding = (enabled = true) =>
  useGet<ResellerBranding | null>(["reseller", "branding"], "/reseller/branding", enabled);

/* ------------------------------ helpers ----------------------------- */

export interface QuotaRow {
  key: keyof AccountQuota;
  usage: keyof QuotaUsage;
  label: string;
  unit?: string;
}

export const QUOTA_ROWS: readonly QuotaRow[] = [
  { key: "max_sites", usage: "sites", label: "Websites" },
  { key: "max_domains", usage: "domains", label: "Domains" },
  { key: "max_mailboxes", usage: "mailboxes", label: "Mailboxes" },
  { key: "max_databases", usage: "databases", label: "Databases" },
  { key: "max_disk_mb", usage: "disk_mb", label: "Disk", unit: "MB" },
];

export function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10_240 ? 0 : 1)} GB`;
  return `${mb} MB`;
}

/** Fraction of a ceiling in use; null when there is no ceiling. */
export function quotaFraction(used: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit === 0) return used > 0 ? 1 : 0;
  return used / limit;
}

/** Where a resource of this kind lives in the panel. */
export const RESOURCE_HREFS: Record<ResourceKind, string> = {
  site: "/websites/sites",
  domain: "/websites/domains",
  mailbox: "/email/mailboxes",
  database: "/databases/mysql",
};
