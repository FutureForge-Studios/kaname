"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  Certificate,
  CreateDnsRecordInput,
  CreateDomainInput,
  CreateSiteInput,
  Deployment,
  DnsProvider,
  DnsRecord,
  DnsValidationResult,
  Domain,
  FileListing,
  IssueCertificateInput,
  Job,
  LogRecordRow,
  LogSourceRow,
  Site,
  TriggerDeploymentInput,
  UpdateDnsRecordInput,
  UpdateDomainInput,
  UpdateSiteInput,
} from "@kaname/contract";
import { api, toApiError, type ApiError, type ListResult, type QueryParams } from "@/lib/api";
import {
  DETAIL_STALE_TIME,
  queryKeys,
  useList,
  useMutationWithJob,
  useResource,
  useResourceMutation,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The Websites module's data layer.
 *
 * Every read and every write in this section resolves here, so five
 * pages share one set of cache keys, one staleness policy and one
 * invalidation rule. The family names match the ones lib/queries.ts
 * maps SSE topics onto — which is what makes a `cert.renew` that lands
 * while the operator is reading the sites list refresh the right rows
 * without either page knowing the stream exists.
 *
 * The split between `useMutationWithJob` and `useResourceMutation` is
 * not stylistic: anything that reaches nginx or certbot is a job
 * (KD-008), and anything that only moves a row — a domain record, a
 * provider API call, an auto-renew flag — resolves inline.
 * ------------------------------------------------------------------ */

/** A DNS zone write also changes what the domain row reports. */
const DNS_FAMILIES = ["dns", "domains"] as const;

const CERT_FAMILIES = ["certificates", "domains", "sites"] as const;
const SITE_FAMILIES = ["sites", "domains"] as const;
const DEPLOYMENT_FAMILIES = ["deployments", "sites"] as const;

/* ------------------------------------------------------------------ *
 * Bulk fan-out
 *
 * The REST surface has no bulk endpoint for these, so a selection is N
 * requests. They run to completion rather than aborting on the first
 * refusal — an operator acting on twelve rows wants the eleven that
 * worked kept, and a named list of the one that did not.
 * ------------------------------------------------------------------ */

export interface BulkTarget {
  id: string;
  /** How this row is named in the summary, e.g. "MX example.com". */
  label: string;
}

export interface BulkResult {
  ok: number;
  failed: { label: string; message: string }[];
}

async function runBulk<T extends BulkTarget>(
  targets: readonly T[],
  run: (target: T) => Promise<unknown>,
): Promise<BulkResult> {
  const failed: BulkResult["failed"] = [];
  let ok = 0;
  for (const target of targets) {
    try {
      await run(target);
      ok += 1;
    } catch (err) {
      failed.push({ label: target.label, message: toApiError(err).message });
    }
  }
  return { ok, failed };
}

function summarise(result: BulkResult, noun: string, verb: string, failedVerb: string): string {
  if (result.failed.length === 0) {
    return `${result.ok} ${result.ok === 1 ? noun : `${noun}s`} ${verb}.`;
  }
  return `${result.ok} ${verb}, ${result.failed.length} ${failedVerb}: ${result.failed
    .map((entry) => entry.label)
    .join(", ")}`;
}

/* ------------------------------------------------------------------ *
 * Sites
 * ------------------------------------------------------------------ */

export function useSites(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<Site>, ApiError> {
  return useList<Site>("sites", params, { enabled });
}

export function useSite(id: string | null | undefined): UseQueryResult<Site, ApiError> {
  return useResource<Site>("sites", id);
}

export function useCreateSite() {
  return useMutationWithJob<CreateSiteInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/sites", input),
    invalidates: SITE_FAMILIES,
    describe: (input) => `Create ${input.name}`,
  });
}

export function useUpdateSite(id: string) {
  return useMutationWithJob<UpdateSiteInput>({
    mutationFn: (input) => api.patch<{ job: Job }>(`/sites/${id}`, input),
    invalidates: SITE_FAMILIES,
  });
}

export interface DeleteSiteVars {
  id: string;
  name: string;
  deleteWebroot: boolean;
}

export function useDeleteSite() {
  return useMutationWithJob<DeleteSiteVars>({
    mutationFn: ({ id, deleteWebroot }) =>
      api.del<{ job: Job }>(`/sites/${id}`, {
        params: { delete_webroot: deleteWebroot ? "true" : "false" },
      }),
    invalidates: SITE_FAMILIES,
    describe: (vars) => `Remove ${vars.name}`,
  });
}

/** Reloads one site, or fans out across a bulk selection. */
export function useReloadSites() {
  return useMutationWithJob<readonly string[]>({
    mutationFn: async (ids) => {
      const jobs: Job[] = [];
      for (const id of ids) {
        const { job } = await api.post<{ job: Job }>(`/sites/${id}/reload`);
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: ["sites"],
    describe: (ids, jobs) =>
      ids.length > 1 ? `Reload ${ids.length} sites` : (jobs[0]?.label ?? "Reload site"),
  });
}

/* ------------------------------------------------------------------ *
 * Domains
 * ------------------------------------------------------------------ */

export function useDomains(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<Domain>, ApiError> {
  return useList<Domain>("domains", params, { enabled });
}

export function useDomain(id: string | null | undefined): UseQueryResult<Domain, ApiError> {
  return useResource<Domain>("domains", id);
}

export function useCreateDomain() {
  return useResourceMutation<CreateDomainInput, Domain>({
    mutationFn: (input) => api.post<Domain>("/domains", input),
    invalidates: ["domains", "sites"],
    successMessage: (domain) => `${domain.name} added.`,
  });
}

export function useUpdateDomain(id: string) {
  return useResourceMutation<UpdateDomainInput, Domain>({
    mutationFn: (input) => api.patch<Domain>(`/domains/${id}`, input),
    invalidates: ["domains", "sites"],
    successMessage: (domain) => `${domain.name} updated.`,
  });
}

export function useDeleteDomain() {
  return useResourceMutation<{ id: string; name: string }, void>({
    mutationFn: ({ id }) => api.del(`/domains/${id}`),
    invalidates: ["domains", "dns", "certificates"],
    successMessage: (_result, vars) => `${vars.name} removed.`,
  });
}

/**
 * Verification resolves from the managed host, so a failure comes back
 * carrying the exact TXT record to publish. The caller keeps the error
 * rather than only toasting it.
 */
export function useVerifyDomain(onFailed?: (error: ApiError) => void) {
  return useResourceMutation<{ id: string; name: string }, Domain>({
    mutationFn: ({ id }) => api.post<Domain>(`/domains/${id}/verify`),
    invalidates: ["domains"],
    successMessage: (domain) => `${domain.name} verified.`,
    onFailed: (error) => onFailed?.(error),
  });
}

/**
 * Bulk verification runs each domain to completion instead of stopping
 * at the first failure: an operator checking twelve names wants the
 * eleven that passed recorded, not rolled back by the twelfth.
 */
export function useVerifyDomains() {
  return useResourceMutation<readonly BulkTarget[], BulkResult>({
    mutationFn: (targets) =>
      runBulk(targets, (target) => api.post<Domain>(`/domains/${target.id}/verify`)),
    invalidates: ["domains"],
    successMessage: (result) => summarise(result, "domain", "verified", "could not be proved"),
  });
}

/* ------------------------------------------------------------------ *
 * DNS
 * ------------------------------------------------------------------ */

export function useDnsRecords(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<DnsRecord>, ApiError> {
  return useList<DnsRecord>("dns", params, { enabled });
}

export function useCreateDnsRecord() {
  return useResourceMutation<CreateDnsRecordInput, DnsRecord>({
    mutationFn: (input) => api.post<DnsRecord>("/dns", input),
    invalidates: DNS_FAMILIES,
    successMessage: (record) => `${record.type} ${record.name} added.`,
  });
}

export interface UpdateDnsRecordVars {
  id: string;
  input: UpdateDnsRecordInput;
}

export function useUpdateDnsRecord() {
  return useResourceMutation<UpdateDnsRecordVars, DnsRecord>({
    mutationFn: ({ id, input }) => api.patch<DnsRecord>(`/dns/${id}`, input),
    invalidates: DNS_FAMILIES,
    successMessage: (record) => `${record.type} ${record.name} updated.`,
  });
}

export function useDeleteDnsRecord() {
  return useResourceMutation<{ id: string; label: string }, void>({
    mutationFn: ({ id }) => api.del(`/dns/${id}`),
    invalidates: DNS_FAMILIES,
    successMessage: (_result, vars) => `${vars.label} deleted.`,
  });
}

export function useDeleteDnsRecords() {
  return useResourceMutation<readonly BulkTarget[], BulkResult>({
    mutationFn: (targets) => runBulk(targets, (target) => api.del(`/dns/${target.id}`)),
    invalidates: DNS_FAMILIES,
    successMessage: (result) => summarise(result, "record", "deleted", "refused"),
  });
}

export interface ReconcileDnsVars {
  id: string;
  label: string;
  content: string;
  /** Which side of the drift is being kept. */
  direction: "kaname" | "zone";
}

/**
 * One click to close a drift. Writing the chosen value back through the
 * normal update path is what clears the flag: the provider echoes what
 * it stored, and the row records that instead of a guess.
 */
export function useReconcileDnsRecord() {
  return useResourceMutation<ReconcileDnsVars, DnsRecord>({
    mutationFn: ({ id, content }) => api.patch<DnsRecord>(`/dns/${id}`, { content }),
    invalidates: DNS_FAMILIES,
    successMessage: (_record, vars) =>
      vars.direction === "kaname"
        ? `${vars.label} restored to Kaname's value.`
        : `${vars.label} now matches the zone.`,
  });
}

/** Fan-out of the same write, with one summary instead of N toasts. */
export function useReconcileDnsRecords() {
  return useResourceMutation<readonly ReconcileDnsVars[], BulkResult>({
    mutationFn: (targets) =>
      runBulk(targets, (target) =>
        api.patch<DnsRecord>(`/dns/${target.id}`, { content: target.content }),
      ),
    invalidates: DNS_FAMILIES,
    successMessage: (result) => summarise(result, "record", "reconciled", "refused"),
  });
}

/** What `POST /dns/sync` answers with; the zone reconcile has no contract type. */
export interface DnsSyncResult {
  domain_id: string;
  domain_name: string;
  zone_id: string;
  provider: DnsProvider;
  checked_at: string;
  total: number;
  created: number;
  updated: number;
  adopted: number;
  drifted: number;
  removed: number;
  unsupported: { type: string; name: string }[];
  records: DnsRecord[];
}

export interface SyncDnsVars {
  domainId: string;
  adoptUnmanaged?: boolean;
}

export function useSyncDns(onDone?: (result: DnsSyncResult) => void) {
  return useResourceMutation<SyncDnsVars, DnsSyncResult>({
    mutationFn: ({ domainId, adoptUnmanaged = false }) =>
      api.post<DnsSyncResult>("/dns/sync", {
        domain_id: domainId,
        adopt_unmanaged: adoptUnmanaged,
      }),
    invalidates: DNS_FAMILIES,
    successMessage: (result) =>
      result.drifted > 0
        ? `${result.domain_name} synced — ${result.drifted} record${result.drifted === 1 ? "" : "s"} had drifted.`
        : `${result.domain_name} synced — the zone matches Kaname.`,
    onDone: (result) => onDone?.(result),
  });
}

/**
 * A POST that reads: it re-runs the zone checks against current state
 * and returns findings. Cached like a read because that is what it is.
 */
export function useDnsValidation(
  domainId: string | null | undefined,
): UseQueryResult<DnsValidationResult, ApiError> {
  return useQuery<DnsValidationResult, ApiError>({
    queryKey: queryKeys.sub("dns", domainId ?? "none", "validation"),
    queryFn: ({ signal }) =>
      api.post<DnsValidationResult>("/dns/validate", undefined, {
        params: { domain_id: domainId },
        signal,
      }),
    enabled: Boolean(domainId),
    staleTime: DETAIL_STALE_TIME,
  });
}

/* ------------------------------------------------------------------ *
 * Certificates
 * ------------------------------------------------------------------ */

export function useCertificates(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<Certificate>, ApiError> {
  return useList<Certificate>("certificates", params, { enabled });
}

/**
 * The work queue: everything inside its renewal window, soonest first,
 * revoked certificates excluded. Keyed under the certificates family so
 * a renewal that lands refreshes it, but on its own sub-key so it never
 * collides with the main list's cache entry.
 */
export function useExpiringCertificates(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<Certificate>, ApiError> {
  return useQuery<ListResult<Certificate>, ApiError>({
    queryKey: queryKeys.sub("certificates", "expiring", "list", params),
    queryFn: ({ signal }) => api.list<Certificate>("/certificates/expiring", { params, signal }),
    enabled,
    staleTime: DETAIL_STALE_TIME,
  });
}

export function useCertificate(
  id: string | null | undefined,
): UseQueryResult<Certificate, ApiError> {
  return useResource<Certificate>("certificates", id);
}

export function useIssueCertificate() {
  return useMutationWithJob<IssueCertificateInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/certificates", input),
    invalidates: CERT_FAMILIES,
  });
}

export interface RenewCertificateVars {
  ids: readonly string[];
  force?: boolean;
}

export function useRenewCertificates() {
  return useMutationWithJob<RenewCertificateVars>({
    mutationFn: async ({ ids, force = false }) => {
      const jobs: Job[] = [];
      for (const id of ids) {
        const { job } = await api.post<{ job: Job }>(`/certificates/${id}/renew`, { force });
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: CERT_FAMILIES,
    describe: ({ ids }, jobs) =>
      ids.length > 1 ? `Renew ${ids.length} certificates` : (jobs[0]?.label ?? "Renew certificate"),
  });
}

export interface RevokeCertificateVars {
  id: string;
  subject: string;
  reason?: string;
}

export function useRevokeCertificate() {
  return useMutationWithJob<RevokeCertificateVars>({
    mutationFn: ({ id, reason }) =>
      api.post<{ job: Job }>(`/certificates/${id}/revoke`, { reason: reason ?? "unspecified" }),
    invalidates: CERT_FAMILIES,
    describe: (vars) => `Revoke ${vars.subject}`,
  });
}

export interface AutoRenewVars {
  id: string;
  subject: string;
  autoRenew: boolean;
}

export function useSetAutoRenew() {
  return useResourceMutation<AutoRenewVars, Certificate>({
    mutationFn: ({ id, autoRenew }) =>
      api.patch<Certificate>(`/certificates/${id}`, { auto_renew: autoRenew }),
    invalidates: ["certificates"],
    successMessage: (_result, vars) =>
      vars.autoRenew
        ? `${vars.subject} will renew automatically.`
        : `Automatic renewal is off for ${vars.subject}.`,
  });
}

/* ------------------------------------------------------------------ *
 * Deployments
 * ------------------------------------------------------------------ */

export function useDeployments(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<Deployment>, ApiError> {
  return useList<Deployment>("deployments", params, { enabled });
}

export function useDeployment(id: string | null | undefined): UseQueryResult<Deployment, ApiError> {
  return useResource<Deployment>("deployments", id);
}

export function useTriggerDeployment() {
  return useMutationWithJob<TriggerDeploymentInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/deployments", input),
    invalidates: DEPLOYMENT_FAMILIES,
  });
}

export interface RollbackVars {
  id: string;
  label: string;
}

export function useRollbackDeployment() {
  return useMutationWithJob<RollbackVars>({
    mutationFn: ({ id }) => api.post<{ job: Job }>(`/deployments/${id}/rollback`),
    invalidates: DEPLOYMENT_FAMILIES,
    describe: (vars) => `Roll back to ${vars.label}`,
  });
}

/**
 * A deployment is cancelled by cancelling the job that is running it —
 * there is no separate endpoint, because there is no separate work.
 */
export function useCancelDeployments() {
  return useResourceMutation<readonly BulkTarget[], BulkResult>({
    mutationFn: (targets) =>
      runBulk(targets, (target) => api.post<Job>(`/jobs/${target.id}/cancel`)),
    invalidates: [...DEPLOYMENT_FAMILIES, "jobs"],
    successMessage: (result) =>
      summarise(result, "deployment", "asked to stop", "could not be cancelled"),
  });
}

/* ------------------------------------------------------------------ *
 * Host reads used by the site detail tabs
 * ------------------------------------------------------------------ */

/**
 * A directory read is a live pass-through with nothing to lose, so it
 * is never cached. Exposed as a descriptor rather than a hook because
 * the webroot tree loads a level at a time, from an event handler.
 */
export function directoryQuery(serverId: string, path: string) {
  return {
    queryKey: queryKeys.sub("files", serverId, "listing", { path }),
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.get<FileListing>("/files", { params: { server_id: serverId, path }, signal }),
    staleTime: 0,
  };
}

export function useDirectory(
  serverId: string | null | undefined,
  path: string | null | undefined,
): UseQueryResult<FileListing, ApiError> {
  return useQuery<FileListing, ApiError>({
    ...directoryQuery(serverId ?? "", path ?? "/"),
    enabled: Boolean(serverId && path),
  });
}

export function useLogSources(
  serverId: string | null | undefined,
): UseQueryResult<ListResult<LogSourceRow>, ApiError> {
  return useList<LogSourceRow>(
    "logs",
    { server_id: serverId, per_page: 100 },
    { path: "/logs/sources", enabled: Boolean(serverId) },
  );
}

export interface SiteLogQuery {
  serverId: string;
  source: string;
  q?: string;
  limit?: number;
}

/** A log read is a live pass-through, so it is polled rather than cached. */
export function useLogSearch(
  query: SiteLogQuery | null,
  refetchInterval: number | false,
): UseQueryResult<ListResult<LogRecordRow>, ApiError> {
  return useList<LogRecordRow>(
    "logs",
    {
      server_id: query?.serverId,
      source: query?.source,
      q: query?.q,
      limit: query?.limit ?? 500,
    },
    { path: "/logs/search", enabled: Boolean(query), staleTime: 0, refetchInterval },
  );
}
