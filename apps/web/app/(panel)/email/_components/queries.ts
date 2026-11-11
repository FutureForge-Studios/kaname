"use client";

import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  AdoptMailServerInput,
  CreateMailAliasInput,
  CreateMailDomainInput,
  CreateMailboxInput,
  DeployMailServerInput,
  Job,
  MailAlias,
  MailCheck,
  MailDeploySecrets,
  MailDnsReport,
  MailDomain,
  MailRelease,
  MailServer,
  Mailbox,
  MailboxCredential,
} from "@kaname/contract";
import { api, toApiError, type ApiError, type ListResult, type QueryParams } from "@/lib/api";
import {
  LIST_STALE_TIME,
  queryKeys,
  useList,
  useMutationWithJob,
  useResource,
  useResourceMutation,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The Email module's data layer (KD-023).
 *
 * Kaname does not run a mail stack of its own: a managed host runs
 * Yunori Mail Server and Kaname deploys it, reads what it says and sends
 * it the changes an operator asks for. Everything that reaches the host
 * is therefore a job (KD-008) and reports its outcome through the job
 * drawer, with two exceptions the contract spells out (KD-024): creating
 * a mailbox and resetting its password answer synchronously, because the
 * password they hand back crosses one HTTPS response and is never stored
 * — not in a row, not in a job result.
 *
 * Six pages read through here so they share one set of cache keys and
 * one invalidation rule. The families below are deliberately generous:
 * a domain added on one page changes the counts a server card shows on
 * another, and a stale count is the kind of lie this product does not
 * tell (KD-012).
 * ------------------------------------------------------------------ */

const SERVER_FAMILIES = ["mail-servers", "mail-domains", "mailboxes", "mail-aliases"] as const;
const DOMAIN_FAMILIES = ["mail-domains", "mail-servers"] as const;
const MAILBOX_FAMILIES = ["mailboxes", "mail-domains", "mail-servers"] as const;
const ALIAS_FAMILIES = ["mail-aliases", "mailboxes", "mail-domains"] as const;

/** Every job-type prefix this module owns, for JobActivityBar. */
export const MAIL_JOB_TYPES = ["mail."] as const;

/* ------------------------------------------------------------------ *
 * Mail servers
 * ------------------------------------------------------------------ */

const ALL_SERVERS: QueryParams = { per_page: 100, sort: "server_name", order: "asc" };

export function useMailServers(
  params: QueryParams = ALL_SERVERS,
  enabled = true,
): UseQueryResult<ListResult<MailServer>, ApiError> {
  return useList<MailServer>("mail-servers", params, { enabled });
}

export function useMailServer(id: string | null | undefined): UseQueryResult<MailServer, ApiError> {
  return useResource<MailServer>("mail-servers", id);
}

export function useDeployMailServer() {
  return useMutationWithJob<DeployMailServerInput & { server_name: string }>({
    mutationFn: ({ server_name: _name, ...input }) =>
      api.post<{ job: Job }>("/mail-servers", input),
    invalidates: SERVER_FAMILIES,
    describe: (input) => `Deploy Yunori Mail Server on ${input.server_name}`,
    // The FormDialog shows the refusal above its fields.
    toastErrors: false,
  });
}

export function useAdoptMailServer() {
  return useMutationWithJob<AdoptMailServerInput & { server_name: string }>({
    mutationFn: ({ server_name: _name, ...input }) =>
      api.post<{ job: Job }>("/mail-servers/adopt", input),
    invalidates: SERVER_FAMILIES,
    describe: (input) => `Adopt Yunori Mail Server on ${input.server_name}`,
    // The FormDialog shows the refusal above its fields.
    toastErrors: false,
  });
}

export interface MailServerVars {
  id: string;
  server_name: string;
}

/** Re-reads the host: status, doctor checks, domains and mailboxes. */
export function useSyncMailServer() {
  return useMutationWithJob<MailServerVars>({
    mutationFn: ({ id }) => api.post<{ job: Job }>(`/mail-servers/${id}/sync`),
    invalidates: SERVER_FAMILIES,
    describe: (vars) => `Check mail server on ${vars.server_name}`,
  });
}

export function useUpdateMailServer() {
  return useMutationWithJob<MailServerVars>({
    mutationFn: ({ id }) => api.post<{ job: Job }>(`/mail-servers/${id}/update`),
    invalidates: SERVER_FAMILIES,
    describe: (vars) => `Update Yunori Mail Server on ${vars.server_name}`,
  });
}

export function useRenewMailCertificate() {
  return useMutationWithJob<MailServerVars>({
    mutationFn: ({ id }) => api.post<{ job: Job }>(`/mail-servers/${id}/certificate/renew`),
    invalidates: ["mail-servers"],
    describe: (vars) => `Renew mail certificate on ${vars.server_name}`,
  });
}

/**
 * Forgetting is a control-plane row delete: nothing on the host changes,
 * so there is no job and the list refreshes on the spot.
 */
export function useForgetMailServer() {
  return useResourceMutation<MailServerVars, void>({
    mutationFn: ({ id }) => api.del(`/mail-servers/${id}`),
    invalidates: SERVER_FAMILIES,
    successMessage: (_result, vars) =>
      `Forgot the mail server on ${vars.server_name}. Yunori keeps running there.`,
  });
}

/**
 * Preflight talks to the live agent and takes seconds, so it never runs
 * on mount: the caller flips `enabled` (or calls `refetch`) when the
 * operator asks, and the answer is kept only until they ask again.
 */
export function useMailPreflight(
  id: string | null | undefined,
  enabled: boolean,
): UseQueryResult<{ checks: MailCheck[] }, ApiError> {
  return useQuery<{ checks: MailCheck[] }, ApiError>({
    queryKey: queryKeys.sub("mail-servers", id ?? "none", "preflight"),
    queryFn: ({ signal }) =>
      api.get<{ checks: MailCheck[] }>(`/mail-servers/${id}/preflight`, { signal }),
    enabled: Boolean(id) && enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * The deploy secrets are handed over exactly once — the control plane
 * answers 404 on the second read — so this is a mutation, not a query:
 * nothing may refetch it in the background, and nothing caches it.
 */
export function useRevealDeploySecrets(): UseMutationResult<MailDeploySecrets, ApiError, string> {
  return useMutation<MailDeploySecrets, ApiError, string>({
    mutationFn: async (mailServerId) => {
      try {
        return await api.get<MailDeploySecrets>(`/mail-servers/${mailServerId}/deploy-secrets`);
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
}

/** The newest yunori-mail release the control plane would install. */
export function useLatestMailRelease(enabled = true): UseQueryResult<MailRelease, ApiError> {
  return useQuery<MailRelease, ApiError>({
    queryKey: queryKeys.list("mail-releases", { latest: true }),
    queryFn: ({ signal }) => api.get<MailRelease>("/mail-releases/latest", { signal }),
    staleTime: 10 * 60_000,
    enabled,
  });
}

/* ------------------------------------------------------------------ *
 * Mail domains
 * ------------------------------------------------------------------ */

const ALL_DOMAINS: QueryParams = { per_page: 200, sort: "domain_name", order: "asc" };

export function useMailDomains(
  params: QueryParams = ALL_DOMAINS,
  enabled = true,
): UseQueryResult<ListResult<MailDomain>, ApiError> {
  return useList<MailDomain>("mail-domains", params, { enabled });
}

export function useAddMailDomain() {
  return useMutationWithJob<CreateMailDomainInput & { domain_name: string }>({
    mutationFn: ({ domain_name: _name, ...input }) =>
      api.post<{ job: Job }>("/mail-domains", input),
    invalidates: DOMAIN_FAMILIES,
    describe: (input) => `Add mail domain ${input.domain_name}`,
    // The FormDialog shows the refusal above its fields.
    toastErrors: false,
  });
}

export interface MailDomainVars {
  id: string;
  domain_name: string;
}

export function useRemoveMailDomain() {
  return useMutationWithJob<MailDomainVars>({
    mutationFn: ({ id }) => api.del<{ job: Job }>(`/mail-domains/${id}`),
    invalidates: DOMAIN_FAMILIES,
    describe: (vars) => `Remove mail domain ${vars.domain_name}`,
  });
}

/**
 * Lives under the `mail-domains` family on purpose: when a DNS check job
 * lands and the SSE bridge invalidates the family, the report an
 * operator is looking at refreshes with it.
 */
export function useMailDnsReport(
  mailDomainId: string | null | undefined,
): UseQueryResult<MailDnsReport, ApiError> {
  return useQuery<MailDnsReport, ApiError>({
    queryKey: queryKeys.sub("mail-domains", mailDomainId ?? "none", "dns"),
    queryFn: ({ signal }) =>
      api.get<MailDnsReport>(`/mail-domains/${mailDomainId}/dns`, { signal }),
    enabled: Boolean(mailDomainId),
    staleTime: LIST_STALE_TIME,
  });
}

export function useCheckMailDns() {
  return useMutationWithJob<MailDomainVars>({
    mutationFn: ({ id }) => api.post<{ job: Job }>(`/mail-domains/${id}/dns/check`),
    invalidates: DOMAIN_FAMILIES,
    describe: (vars) => `Check DNS records for ${vars.domain_name}`,
  });
}

/* ------------------------------------------------------------------ *
 * Mailboxes
 * ------------------------------------------------------------------ */

export function useMailboxes(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<Mailbox>, ApiError> {
  return useList<Mailbox>("mailboxes", params, { enabled });
}

/**
 * Synchronous on purpose (KD-024): the host generates the password and
 * the control plane relays it once. The dialog that called this is the
 * only place it will ever be displayed, so there is no toast — the
 * success surface is the credential dialog itself.
 */
export function useCreateMailbox() {
  return useResourceMutation<CreateMailboxInput, MailboxCredential>({
    mutationFn: (input) => api.post<MailboxCredential>("/mailboxes", input),
    invalidates: MAILBOX_FAMILIES,
    // The FormDialog shows the refusal above its fields.
    toastErrors: false,
  });
}

export interface ResetMailboxPasswordVars {
  id: string;
  address: string;
}

export function useResetMailboxPassword() {
  return useResourceMutation<ResetMailboxPasswordVars, { address: string; password: string }>({
    mutationFn: ({ id }) =>
      api.post<{ address: string; password: string }>(`/mailboxes/${id}/reset-password`),
    invalidates: ["mailboxes"],
  });
}

export interface MailboxVars {
  id: string;
  address: string;
}

export function useDeleteMailbox() {
  return useMutationWithJob<MailboxVars>({
    mutationFn: ({ id }) => api.del<{ job: Job }>(`/mailboxes/${id}`),
    invalidates: MAILBOX_FAMILIES,
    describe: (vars) => `Delete ${vars.address}`,
  });
}

/* ------------------------------------------------------------------ *
 * Aliases
 * ------------------------------------------------------------------ */

export function useMailAliases(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<MailAlias>, ApiError> {
  return useList<MailAlias>("mail-aliases", params, { enabled });
}

export function useCreateMailAlias() {
  return useMutationWithJob<CreateMailAliasInput & { address: string }>({
    mutationFn: ({ address: _address, ...input }) => api.post<{ job: Job }>("/mail-aliases", input),
    invalidates: ALIAS_FAMILIES,
    describe: (input) => `Add alias ${input.address}`,
    // The FormDialog shows the refusal above its fields.
    toastErrors: false,
  });
}

export function useDeleteMailAlias() {
  return useMutationWithJob<MailboxVars>({
    mutationFn: ({ id }) => api.del<{ job: Job }>(`/mail-aliases/${id}`),
    invalidates: ALIAS_FAMILIES,
    describe: (vars) => `Remove alias ${vars.address}`,
  });
}
