"use client";

import { useCallback } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  ArchiveInput,
  ChmodInput,
  ChownInput,
  CopyInput,
  CreateFtpAccountInput,
  DeleteInput,
  ExtractInput,
  FileContent,
  FileListing,
  FtpAccount,
  FtpSession,
  Job,
  MkdirInput,
  MoveInput,
  ResetFtpPasswordInput,
  StorageBreakdown,
  UpdateFtpAccountInput,
  WriteFileInput,
} from "@kaname/contract";
import { api, buildPath, type ApiError, type ListResult, type QueryParams } from "@/lib/api";
import { LIST_STALE_TIME, queryKeys, useList, useMutationWithJob } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The Files module's data layer.
 *
 * Three surfaces — the manager, transfer accounts and the storage
 * breakdown — read through here so they share one set of cache keys and
 * one invalidation rule. The family names are the ones lib/queries.ts
 * maps `fs.*` and `ftp.*` jobs onto, which is what makes a delete that
 * lands while the operator is looking at the storage page refresh both
 * without either page knowing the event feed exists.
 *
 * Browsing is deliberately uncached (KD-008 permits read-only
 * pass-through): a directory listing is stale the moment it is taken,
 * and a stale one is worse than a slow one because the operator acts on
 * what they see. Everything that changes a byte on the host is a job.
 * ------------------------------------------------------------------ */

/** A file mutation changes what the storage sample would have reported. */
const FILE_FAMILIES = ["files", "storage"] as const;
const FTP_FAMILIES = ["ftp-accounts"] as const;

/** The editor pulls whole files inline; anything larger is a download. */
export const EDITOR_MAX_BYTES = 1024 * 1024;
export const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

export type BrowseSort = "name" | "size" | "modified";

export interface BrowseOptions {
  path: string;
  showHidden: boolean;
  sort: BrowseSort;
  order: "asc" | "desc";
}

/**
 * `show_hidden` is omitted rather than sent as `false`: the contract
 * coerces the query string, and every non-empty string — `"false"`
 * included — coerces to true. Absent is the only way to say no.
 */
function browseParams(serverId: string, options: BrowseOptions): QueryParams {
  return {
    server_id: serverId,
    path: options.path,
    show_hidden: options.showHidden ? true : undefined,
    sort: options.sort,
    order: options.order,
  };
}

function directoryKey(serverId: string, options: BrowseOptions) {
  return queryKeys.sub("files", serverId, "listing", browseParams(serverId, options));
}

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

export function useDirectory(
  serverId: string | null | undefined,
  options: BrowseOptions,
): UseQueryResult<FileListing, ApiError> {
  return useQuery<FileListing, ApiError>({
    queryKey: directoryKey(serverId ?? "none", options),
    queryFn: ({ signal }) =>
      api.get<FileListing>("/files", { params: browseParams(serverId ?? "", options), signal }),
    enabled: Boolean(serverId),
    staleTime: 0,
    /* Holds the previous directory on screen while the next one loads,
     * so walking a tree does not flash a skeleton at every step. */
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Imperative sibling of `useDirectory`, for the tree: it expands one
 * folder at a time and must not mount a hook per node. Shares the cache
 * entry, so a folder already opened in the table costs nothing here.
 */
export function useDirectoryLoader(
  serverId: string | null | undefined,
  showHidden: boolean,
): (path: string) => Promise<FileListing> {
  const client = useQueryClient();

  return useCallback(
    (path: string) => {
      const options: BrowseOptions = { path, showHidden, sort: "name", order: "asc" };
      return client.fetchQuery<FileListing, ApiError>({
        queryKey: directoryKey(serverId ?? "none", options),
        queryFn: ({ signal }) =>
          api.get<FileListing>("/files", { params: browseParams(serverId ?? "", options), signal }),
        staleTime: LIST_STALE_TIME,
      });
    },
    [client, serverId, showHidden],
  );
}

export function useFileContent(
  serverId: string | null | undefined,
  path: string | null,
  maxBytes: number,
): UseQueryResult<FileContent, ApiError> {
  return useQuery<FileContent, ApiError>({
    queryKey: queryKeys.sub("files", serverId ?? "none", "content", { path, max_bytes: maxBytes }),
    queryFn: ({ signal }) =>
      api.get<FileContent>("/files/read", {
        params: { server_id: serverId, path, max_bytes: maxBytes },
        signal,
      }),
    enabled: Boolean(serverId) && Boolean(path),
    staleTime: 0,
    retry: false,
  });
}

/**
 * Download is one of the two file routes that is not a job: the bytes
 * only exist for the life of the request, so there is nothing a queued
 * row could hold. Same origin and the session cookie rides along, so the
 * browser can fetch it directly.
 */
export function downloadUrl(serverId: string, path: string): string {
  return buildPath("/files/download", { server_id: serverId, path });
}

/* ------------------------------------------------------------------ *
 * File mutations — every one of them a job (KD-008)
 * ------------------------------------------------------------------ */

export function useWriteFile() {
  return useMutationWithJob<WriteFileInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/write", input),
    invalidates: FILE_FAMILIES,
    describe: (input) => `Write ${input.path}`,
  });
}

export function useMakeDirectory() {
  return useMutationWithJob<MkdirInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/mkdir", input),
    invalidates: FILE_FAMILIES,
    describe: (input) => `Create ${input.path}`,
  });
}

export interface TransferVars {
  server_id: string;
  /** One entry per selected path, so a rename and a bulk move are one shape. */
  moves: readonly { from: string; to: string }[];
  overwrite: boolean;
}

/**
 * The agent moves one path per call, so a multi-select becomes several
 * jobs under one correlation id rather than a single opaque one — if the
 * fourth of nine collides with an existing name, the operator sees which.
 */
export function useMoveEntries() {
  return useMutationWithJob<TransferVars>({
    mutationFn: async ({ server_id, moves, overwrite }) => {
      const jobs: Job[] = [];
      for (const move of moves) {
        const input: MoveInput = { server_id, from: move.from, to: move.to, overwrite };
        const { job } = await api.post<{ job: Job }>("/files/move", input);
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: FILE_FAMILIES,
    describe: ({ moves }) =>
      moves.length > 1 ? `Move ${moves.length} entries` : `Move ${moves[0]?.from ?? "entry"}`,
  });
}

export function useCopyEntries() {
  return useMutationWithJob<TransferVars>({
    mutationFn: async ({ server_id, moves, overwrite }) => {
      const jobs: Job[] = [];
      for (const move of moves) {
        const input: CopyInput = { server_id, from: move.from, to: move.to, overwrite };
        const { job } = await api.post<{ job: Job }>("/files/copy", input);
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: FILE_FAMILIES,
    describe: ({ moves }) =>
      moves.length > 1 ? `Copy ${moves.length} entries` : `Copy ${moves[0]?.from ?? "entry"}`,
  });
}

export function useDeleteEntries() {
  return useMutationWithJob<DeleteInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/delete", input),
    invalidates: FILE_FAMILIES,
    describe: (input) =>
      input.paths.length > 1 ? `Delete ${input.paths.length} entries` : `Delete ${input.paths[0]}`,
  });
}

export function useChmod() {
  return useMutationWithJob<ChmodInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/chmod", input),
    invalidates: FILE_FAMILIES,
    describe: (input) => `Set mode ${input.mode}`,
  });
}

export function useChown() {
  return useMutationWithJob<ChownInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/chown", input),
    invalidates: FILE_FAMILIES,
    describe: (input) => `Set owner ${input.owner ?? ""}${input.group ? `:${input.group}` : ""}`,
  });
}

export function useArchive() {
  return useMutationWithJob<ArchiveInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/archive", input),
    invalidates: FILE_FAMILIES,
    describe: (input) => `Compress into ${input.destination}`,
  });
}

export function useExtract() {
  return useMutationWithJob<ExtractInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/files/extract", input),
    invalidates: FILE_FAMILIES,
    describe: (input) => `Extract ${input.path}`,
  });
}

/* ------------------------------------------------------------------ *
 * Transfer accounts
 * ------------------------------------------------------------------ */

export function useFtpAccounts(
  params: QueryParams,
  enabled = true,
): UseQueryResult<ListResult<FtpAccount>, ApiError> {
  return useList<FtpAccount>("ftp-accounts", params, { enabled });
}

export function useCreateFtpAccount() {
  return useMutationWithJob<CreateFtpAccountInput>({
    mutationFn: (input) => api.post<{ job: Job }>("/ftp-accounts", input),
    invalidates: FTP_FAMILIES,
    describe: (input) => `Create ${input.username}`,
  });
}

export interface UpdateFtpAccountVars {
  id: string;
  username: string;
  input: UpdateFtpAccountInput;
}

export function useUpdateFtpAccount() {
  return useMutationWithJob<UpdateFtpAccountVars>({
    mutationFn: ({ id, input }) => api.patch<{ job: Job }>(`/ftp-accounts/${id}`, input),
    invalidates: FTP_FAMILIES,
    describe: (vars) => `Update ${vars.username}`,
  });
}

export interface DeleteFtpAccountVars {
  id: string;
  username: string;
}

export function useDeleteFtpAccount() {
  return useMutationWithJob<readonly DeleteFtpAccountVars[]>({
    mutationFn: async (accounts) => {
      const jobs: Job[] = [];
      for (const account of accounts) {
        const { job } = await api.del<{ job: Job }>(`/ftp-accounts/${account.id}`);
        jobs.push(job);
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: FTP_FAMILIES,
    describe: (accounts) =>
      accounts.length > 1
        ? `Remove ${accounts.length} accounts`
        : `Remove ${accounts[0]?.username ?? "account"}`,
  });
}

export interface ResetFtpPasswordVars extends ResetFtpPasswordInput {
  id: string;
  username: string;
}

export function useResetFtpPassword() {
  return useMutationWithJob<ResetFtpPasswordVars>({
    mutationFn: ({ id, password }) =>
      api.post<{ job: Job }>(`/ftp-accounts/${id}/reset-password`, { password }),
    invalidates: FTP_FAMILIES,
    describe: (vars) => `Reset password for ${vars.username}`,
  });
}

/**
 * Live from the host, so it is keyed per account rather than through
 * `useList` — two accounts asking for page 1 must not share a cache
 * entry just because their query strings match.
 */
export function useFtpSessions(
  accountId: string | null,
  params: QueryParams,
): UseQueryResult<ListResult<FtpSession>, ApiError> {
  return useQuery<ListResult<FtpSession>, ApiError>({
    queryKey: queryKeys.sub("ftp-accounts", accountId ?? "none", "sessions", params),
    queryFn: ({ signal }) =>
      api.list<FtpSession>(`/ftp-accounts/${accountId}/sessions`, { params, signal }),
    enabled: Boolean(accountId),
    staleTime: 0,
    retry: false,
  });
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * The key is shared with the server detail page's storage tab on
 * purpose: both surfaces read one cache entry, so a sample taken from
 * either is immediately true on the other.
 */
export function useStorageBreakdown(
  serverId: string | null | undefined,
): UseQueryResult<StorageBreakdown, ApiError> {
  return useQuery<StorageBreakdown, ApiError>({
    queryKey: queryKeys.sub("storage", serverId ?? "none", "breakdown"),
    queryFn: ({ signal }) =>
      api.get<StorageBreakdown>("/storage", { params: { server_id: serverId }, signal }),
    enabled: Boolean(serverId),
    staleTime: LIST_STALE_TIME,
    /* A never-sampled host answers 404 carrying the remediation that
     * says how to fix it; retrying only delays the operator reading it. */
    retry: false,
  });
}

export interface StorageSampleVars {
  serverId: string;
  serverName: string;
  path: string;
  depth: number;
}

export function useStorageSample() {
  return useMutationWithJob<StorageSampleVars>({
    mutationFn: ({ serverId, path, depth }) =>
      api.post<{ job: Job }>("/storage/sample", undefined, {
        params: { server_id: serverId, path, depth },
      }),
    invalidates: ["storage", "servers"],
    describe: ({ serverName }) => `Sample storage on ${serverName}`,
  });
}
