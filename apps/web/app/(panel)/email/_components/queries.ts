"use client";

import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useToast } from "@kaname/ui";
import type {
  CreateMailAliasInput,
  CreateMailForwarderInput,
  CreateMailboxInput,
  Job,
  MailAlias,
  MailAuthReport,
  MailDomain,
  MailForwarder,
  MailLogEntry,
  Mailbox,
  Remediation,
  UpdateMailAliasInput,
  UpdateMailForwarderInput,
  UpdateMailboxInput,
} from "@kaname/contract";
import {
  ApiError,
  api,
  buildPath,
  redirectToLogin,
  type AnyErrorCode,
  type ListResult,
  type QueryParams,
} from "@/lib/api";
import {
  DETAIL_STALE_TIME,
  LIST_STALE_TIME,
  invalidateFamilies,
  queryKeys,
  useList,
  useMutationWithJob,
} from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The Email module's data layer.
 *
 * Five pages read through here so they share one set of cache keys and
 * one invalidation rule, and so the two halves of the module stay
 * honest with each other: a mailbox created on one page changes the
 * quota totals the domain rail shows on another.
 *
 * Aliases and forwarders are maps, not rows, as far as Postfix is
 * concerned — the control plane rewrites the whole table for a domain on
 * every change — so their mutations all return one apply job rather than
 * a per-row result. Nothing here reports its own outcome (KD-008).
 * ------------------------------------------------------------------ */

const MAILBOX_FAMILIES = ["mailboxes", "mail-domains"] as const;
const ALIAS_FAMILIES = ["mail-aliases", "mail-domains"] as const;
const FORWARDER_FAMILIES = ["mail-forwarders", "mail-domains"] as const;
const AUTH_FAMILIES = ["mail-auth", "mail-domains"] as const;

/* ------------------------------------------------------------------ *
 * Mail domains
 * ------------------------------------------------------------------ */

/** Every page in this module needs the domain list to label and filter. */
export function useMailDomains(): UseQueryResult<ListResult<MailDomain>, ApiError> {
  return useList<MailDomain>("mail-domains", { per_page: 200, sort: "domain", order: "asc" });
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

export function useCreateMailbox() {
  return useMutationWithJob<CreateMailboxInput & { address: string }>({
    mutationFn: ({ address: _address, ...input }) => api.post<{ job: Job }>("/mailboxes", input),
    invalidates: MAILBOX_FAMILIES,
    describe: (input) => `Create ${input.address}`,
  });
}

export interface UpdateMailboxVars {
  id: string;
  address: string;
  input: UpdateMailboxInput;
}

export function useUpdateMailbox() {
  return useMutationWithJob<UpdateMailboxVars>({
    mutationFn: ({ id, input }) => api.patch<{ job: Job }>(`/mailboxes/${id}`, input),
    invalidates: MAILBOX_FAMILIES,
    describe: (vars) => `Update ${vars.address}`,
  });
}

export interface MailboxQuotaVars {
  id: string;
  address: string;
  quota_bytes: number;
}

/**
 * Quota has its own route rather than riding on the PATCH, because the
 * control plane refuses a quota below current usage with a specific
 * conflict — a mailbox that is over quota the instant the change lands
 * stops accepting mail, and that deserves its own answer.
 */
export function useSetMailboxQuota() {
  return useMutationWithJob<MailboxQuotaVars>({
    mutationFn: ({ id, quota_bytes }) =>
      api.post<{ job: Job }>(`/mailboxes/${id}/quota`, { quota_bytes }),
    invalidates: MAILBOX_FAMILIES,
    describe: (vars) => `Set quota for ${vars.address}`,
  });
}

export interface ResetMailboxPasswordVars {
  id: string;
  address: string;
  password: string;
  revoke_sessions: boolean;
}

export function useResetMailboxPassword() {
  return useMutationWithJob<ResetMailboxPasswordVars>({
    mutationFn: ({ id, password, revoke_sessions }) =>
      api.post<{ job: Job }>(`/mailboxes/${id}/reset-password`, { password, revoke_sessions }),
    invalidates: MAILBOX_FAMILIES,
    describe: (vars) => `Reset password for ${vars.address}`,
  });
}

export interface DeleteMailboxVars {
  mailboxes: readonly { id: string; address: string }[];
  deleteMaildir: boolean;
}

export function useDeleteMailboxes() {
  const client = useQueryClient();
  const { toast } = useToast();

  return useMutationWithJob<DeleteMailboxVars>({
    mutationFn: async ({ mailboxes, deleteMaildir }) => {
      const jobs: Job[] = [];
      for (const mailbox of mailboxes) {
        // A mailbox whose create never reached the host is removed on the
        // spot when the agent is away: there is no job because there is
        // nothing on the host to undo.
        const { job } = await deleteWithBody<{ job: Job | null }>(`/mailboxes/${mailbox.id}`, {
          delete_maildir: deleteMaildir,
        });
        if (job) jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: MAILBOX_FAMILIES,
    describe: ({ mailboxes }) =>
      mailboxes.length > 1
        ? `Delete ${mailboxes.length} mailboxes`
        : `Delete ${mailboxes[0]?.address ?? "mailbox"}`,
    onQueued: (jobs, { mailboxes }) => {
      const removed = mailboxes.length - jobs.length;
      if (removed === 0) return;
      // Nothing queued means nothing will invalidate these lists later.
      invalidateFamilies(client, MAILBOX_FAMILIES);
      toast({
        variant: "info",
        title:
          removed === 1 && mailboxes.length === 1
            ? `Removed ${mailboxes[0]!.address}`
            : `Removed ${removed} mailbox record${removed === 1 ? "" : "s"}`,
        description: "It never finished provisioning, so there was nothing on the host to remove.",
      });
    },
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

export function useCreateAlias() {
  return useMutationWithJob<CreateMailAliasInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/mail-aliases", input),
    invalidates: ALIAS_FAMILIES,
    describe: (input) => `Route ${input.address}`,
  });
}

export interface UpdateAliasVars {
  id: string;
  address: string;
  input: UpdateMailAliasInput;
}

export function useUpdateAlias() {
  return useMutationWithJob<UpdateAliasVars>({
    mutationFn: ({ id, input }) => api.patch<{ job: Job }>(`/mail-aliases/${id}`, input),
    invalidates: ALIAS_FAMILIES,
    describe: (vars) => `Update ${vars.address}`,
  });
}

export interface SetEnabledVars {
  rows: readonly { id: string; label: string }[];
  enabled: boolean;
}

/**
 * Enabling is the panel's word for "present in the map we apply": the
 * mail stack has no concept of a disabled alias, so a toggle rewrites
 * the domain's whole table exactly as a create or a delete does.
 */
export function useSetAliasesEnabled() {
  return useMutationWithJob<SetEnabledVars>({
    mutationFn: async ({ rows, enabled }) => {
      const jobs: Job[] = [];
      for (const row of rows) {
        const { job } = await api.patch<{ job: Job }>(`/mail-aliases/${row.id}`, { enabled });
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: ALIAS_FAMILIES,
    describe: ({ rows, enabled }) =>
      `${enabled ? "Enable" : "Disable"} ${rows.length > 1 ? `${rows.length} aliases` : (rows[0]?.label ?? "alias")}`,
  });
}

export function useDeleteAliases() {
  return useMutationWithJob<readonly { id: string; address: string }[]>({
    mutationFn: async (aliases) => {
      const jobs: Job[] = [];
      for (const alias of aliases) {
        const { job } = await api.del<{ job: Job }>(`/mail-aliases/${alias.id}`);
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: ALIAS_FAMILIES,
    describe: (aliases) =>
      aliases.length > 1
        ? `Remove ${aliases.length} aliases`
        : `Remove ${aliases[0]?.address ?? "alias"}`,
  });
}

/* ------------------------------------------------------------------ *
 * Forwarders
 * ------------------------------------------------------------------ */

export function useMailForwarders(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<MailForwarder>, ApiError> {
  return useList<MailForwarder>("mail-forwarders", params, { enabled });
}

export function useCreateForwarder() {
  return useMutationWithJob<CreateMailForwarderInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/mail-forwarders", input),
    invalidates: FORWARDER_FAMILIES,
    describe: (input) => `Forward ${input.source}`,
  });
}

export interface UpdateForwarderVars {
  id: string;
  source: string;
  input: UpdateMailForwarderInput;
}

export function useUpdateForwarder() {
  return useMutationWithJob<UpdateForwarderVars>({
    mutationFn: ({ id, input }) => api.patch<{ job: Job }>(`/mail-forwarders/${id}`, input),
    invalidates: FORWARDER_FAMILIES,
    describe: (vars) => `Update ${vars.source}`,
  });
}

export function useSetForwardersEnabled() {
  return useMutationWithJob<SetEnabledVars>({
    mutationFn: async ({ rows, enabled }) => {
      const jobs: Job[] = [];
      for (const row of rows) {
        const { job } = await api.patch<{ job: Job }>(`/mail-forwarders/${row.id}`, { enabled });
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: FORWARDER_FAMILIES,
    describe: ({ rows, enabled }) =>
      `${enabled ? "Enable" : "Disable"} ${rows.length > 1 ? `${rows.length} forwarders` : (rows[0]?.label ?? "forwarder")}`,
  });
}

export function useDeleteForwarders() {
  return useMutationWithJob<readonly { id: string; source: string }[]>({
    mutationFn: async (forwarders) => {
      const jobs: Job[] = [];
      for (const forwarder of forwarders) {
        const { job } = await api.del<{ job: Job }>(`/mail-forwarders/${forwarder.id}`);
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: FORWARDER_FAMILIES,
    describe: (forwarders) =>
      forwarders.length > 1
        ? `Remove ${forwarders.length} forwarders`
        : `Remove ${forwarders[0]?.source ?? "forwarder"}`,
  });
}

/* ------------------------------------------------------------------ *
 * DNS authentication
 * ------------------------------------------------------------------ */

export function useMailAuthReport(
  mailDomainId: string | null,
): UseQueryResult<MailAuthReport, ApiError> {
  return useQuery<MailAuthReport, ApiError>({
    queryKey: queryKeys.sub("mail-auth", mailDomainId ?? "none", "report"),
    queryFn: ({ signal }) =>
      api.get<MailAuthReport>("/mail-auth", {
        params: { mail_domain_id: mailDomainId },
        signal,
      }),
    enabled: Boolean(mailDomainId),
    staleTime: DETAIL_STALE_TIME,
    retry: false,
  });
}

export interface RunMailAuthVars {
  mail_domain_id: string;
  domain: string;
  resolver?: string;
}

/**
 * The queued form of the check. A refresh could answer inline — every
 * check is a DNS query or a read-only agent call — but running it as a
 * job is what gives the page a progress line and a log an operator can
 * read afterwards, which is most of the value when a check disagrees
 * with their own resolver.
 */
export function useRunMailAuthCheck() {
  return useMutationWithJob<RunMailAuthVars>({
    mutationFn: ({ mail_domain_id, resolver }) =>
      api.post<{ job: Job }>("/mail-auth/check", {
        mail_domain_id,
        ...(resolver ? { resolver } : {}),
      }),
    invalidates: AUTH_FAMILIES,
    describe: (vars) => `Re-check ${vars.domain}`,
  });
}

/* ------------------------------------------------------------------ *
 * Mail logs
 * ------------------------------------------------------------------ */

export function useMailLogs(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<MailLogEntry>, ApiError> {
  return useList<MailLogEntry>("mail-logs", params, { enabled, staleTime: 10_000 });
}

export const DELIVERY_STATUSES: readonly MailLogEntry["status"][] = [
  "received",
  "sent",
  "deferred",
  "bounced",
  "rejected",
  "quarantined",
];

export interface DeliveryBreakdown {
  counts: Record<MailLogEntry["status"], number>;
  total: number;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Counts come from the server, one narrow query per status, rather than
 * from tallying the page on screen: a breakdown computed from fifty
 * visible rows would describe the page, not the mail flow.
 */
export function useDeliveryBreakdown(params: QueryParams, enabled = true): DeliveryBreakdown {
  const results = useQueries({
    queries: DELIVERY_STATUSES.map((status) => {
      const query = { ...params, status, page: 1, per_page: 1 };
      return {
        queryKey: queryKeys.list("mail-logs", query),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api.list<MailLogEntry>("/mail-logs", { params: query, signal }),
        enabled,
        staleTime: LIST_STALE_TIME,
      };
    }),
  });

  const counts = {} as Record<MailLogEntry["status"], number>;
  let total = 0;
  DELIVERY_STATUSES.forEach((status, index) => {
    const value = results[index]?.data?.meta.total ?? 0;
    counts[status] = value;
    total += value;
  });

  return {
    counts,
    total,
    isLoading: results.some((result) => result.isLoading),
    isError: results.some((result) => result.isError),
  };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    remediation?: Remediation;
    fields?: Record<string, string>;
    request_id?: string;
  };
}

/**
 * `DELETE /mailboxes/:id` validates a body — `delete_maildir` decides
 * whether years of stored mail survive the row — and the shared client
 * cannot attach one to a DELETE. Rather than send a request the control
 * plane will reject, this sends the body and translates the envelope the
 * same way lib/api.ts does.
 */
async function deleteWithBody<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildPath(path), {
      method: "DELETE",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError({
      code: "network_error",
      message: "The control plane did not answer.",
      status: 0,
    });
  }

  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    if (response.status === 401) redirectToLogin();
    const error = ((payload ?? {}) as ErrorEnvelope).error ?? {};
    throw new ApiError({
      code: (error.code as AnyErrorCode) ?? "internal_error",
      message: error.message ?? `The control plane answered ${response.status}.`,
      status: response.status,
      remediation: error.remediation ?? null,
      fields: error.fields ?? {},
      requestId: error.request_id ?? null,
    });
  }

  return (payload as { data: T } | null)?.data as T;
}
