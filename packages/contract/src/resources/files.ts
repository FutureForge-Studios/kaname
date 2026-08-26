import { z } from "zod";
import {
  absolutePath,
  bytes,
  fileMode,
  identifier,
  ipAddress,
  isoDate,
  listQuery,
  percent,
  sortOrder,
  uuid,
} from "../primitives.js";
import { archiveFormat, fileKind, transferProtocol } from "../enums.js";
import { directoryListing, diskUsage, fileEntry } from "../agent/payloads.js";

/* ------------------------------------------------------------------ *
 * File manager
 *
 * Browsing is a live pass-through read, never cached: a listing is
 * stale the moment it is taken, and there is nothing to lose by
 * re-reading it (KD-008).
 * ------------------------------------------------------------------ */

export const fileRow = fileEntry.extend({
  server_id: uuid,
  server_name: z.string(),
});
export type FileRow = z.infer<typeof fileRow>;

export const fileListing = directoryListing.extend({
  server_id: uuid,
  server_name: z.string(),
  listed_at: isoDate,
  /** False when the agent has the path but the mount is read-only. */
  writable: z.boolean(),
});
export type FileListing = z.infer<typeof fileListing>;

export const browseQuery = z.object({
  server_id: uuid,
  path: absolutePath.default("/"),
  show_hidden: z.coerce.boolean().default(false),
  sort: z.enum(["name", "size", "modified"]).default("name"),
  order: sortOrder.default("asc"),
});
export type BrowseQuery = z.infer<typeof browseQuery>;

export const fileStatQuery = z.object({
  server_id: uuid,
  path: absolutePath,
});
export type FileStatQuery = z.infer<typeof fileStatQuery>;

export const readFileQuery = z.object({
  server_id: uuid,
  path: absolutePath,
  max_bytes: z.coerce
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024)
    .default(1024 * 1024),
});
export type ReadFileQuery = z.infer<typeof readFileQuery>;

export const fileContent = z.object({
  server_id: uuid,
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  /** Set when the file exceeded `max_bytes`; the editor opens read-only. */
  truncated: z.boolean(),
  size: bytes,
  mode: fileMode,
  mime: z.string().nullable(),
  read_at: isoDate,
});
export type FileContent = z.infer<typeof fileContent>;

/* ------------------------------------------------------------------ *
 * Mutations — each one becomes a job (KD-008)
 * ------------------------------------------------------------------ */

export const writeFileInput = z.object({
  server_id: uuid,
  path: absolutePath,
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  mode: fileMode.optional(),
  create_parents: z.boolean().default(false),
});
export type WriteFileInput = z.infer<typeof writeFileInput>;

export const mkdirInput = z.object({
  server_id: uuid,
  path: absolutePath,
  mode: fileMode.optional(),
  parents: z.boolean().default(true),
});
export type MkdirInput = z.infer<typeof mkdirInput>;

export const moveInput = z.object({
  server_id: uuid,
  from: absolutePath,
  to: absolutePath,
  overwrite: z.boolean().default(false),
});
export type MoveInput = z.infer<typeof moveInput>;

export const copyInput = z.object({
  server_id: uuid,
  from: absolutePath,
  to: absolutePath,
  overwrite: z.boolean().default(false),
});
export type CopyInput = z.infer<typeof copyInput>;

export const deleteInput = z.object({
  server_id: uuid,
  paths: z.array(absolutePath).min(1).max(500),
  recursive: z.boolean().default(false),
});
export type DeleteInput = z.infer<typeof deleteInput>;

export const chmodInput = z.object({
  server_id: uuid,
  paths: z.array(absolutePath).min(1).max(500),
  mode: fileMode,
  recursive: z.boolean().default(false),
});
export type ChmodInput = z.infer<typeof chmodInput>;

export const chownInput = z
  .object({
    server_id: uuid,
    paths: z.array(absolutePath).min(1).max(500),
    owner: identifier.optional(),
    group: identifier.optional(),
    recursive: z.boolean().default(false),
  })
  .refine((v) => v.owner !== undefined || v.group !== undefined, {
    message: "specify an owner, a group, or both",
  });
export type ChownInput = z.infer<typeof chownInput>;

export const archiveInput = z.object({
  server_id: uuid,
  paths: z.array(absolutePath).min(1).max(500),
  destination: absolutePath,
  format: archiveFormat.default("tar.gz"),
});
export type ArchiveInput = z.infer<typeof archiveInput>;

export const extractInput = z.object({
  server_id: uuid,
  path: absolutePath,
  destination: absolutePath,
  overwrite: z.boolean().default(false),
});
export type ExtractInput = z.infer<typeof extractInput>;

/* ------------------------------------------------------------------ *
 * FTP / SFTP accounts
 * ------------------------------------------------------------------ */

/** enums.ts carries no generic account lifecycle; transfer accounts have their own. */
export const ftpAccountStatus = z.enum(["active", "provisioning", "suspended", "error"]);
export type FtpAccountStatus = z.infer<typeof ftpAccountStatus>;

/** Long because a transfer credential is pasted into a client once and then lives for years. */
const transferPassword = z.string().min(16).max(256);

export const ftpAccount = z.object({
  id: uuid,
  server_id: uuid,
  server_name: z.string(),
  username: identifier,
  protocol: transferProtocol,
  home_dir: absolutePath,
  /** 0 means unlimited. */
  quota_bytes: bytes,
  used_bytes: bytes,
  status: ftpAccountStatus,
  ssh_key_fingerprint: z.string().nullable(),
  last_login_at: isoDate.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
});
export type FtpAccount = z.infer<typeof ftpAccount>;

export const createFtpAccountInput = z.object({
  server_id: uuid,
  username: identifier,
  password: transferPassword,
  protocol: transferProtocol.default("sftp"),
  home_dir: absolutePath,
  quota_bytes: bytes.default(0),
  ssh_public_key: z.string().max(4096).optional(),
});
export type CreateFtpAccountInput = z.infer<typeof createFtpAccountInput>;

/** Server, username and password are not editable: changing any of them is a new account. */
export const updateFtpAccountInput = createFtpAccountInput
  .omit({ server_id: true, username: true, password: true })
  .partial()
  .extend({ status: ftpAccountStatus.optional() });
export type UpdateFtpAccountInput = z.infer<typeof updateFtpAccountInput>;

export const resetFtpPasswordInput = z.object({ password: transferPassword });
export type ResetFtpPasswordInput = z.infer<typeof resetFtpPasswordInput>;

export const ftpAccountListQuery = listQuery.extend({
  server_id: uuid.optional(),
  protocol: transferProtocol.optional(),
  status: ftpAccountStatus.optional(),
  over_quota: z.coerce.boolean().optional(),
});
export type FtpAccountListQuery = z.infer<typeof ftpAccountListQuery>;

/** Live-only: sessions exist on the host, so there is no row to persist. */
export const ftpSession = z.object({
  server_id: uuid,
  username: identifier,
  from_ip: ipAddress,
  protocol: transferProtocol,
  started_at: isoDate,
  bytes_transferred: bytes,
  current_path: z.string().nullable(),
});
export type FtpSession = z.infer<typeof ftpSession>;

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/** What a slice of the disk is being spent on, for the breakdown legend. */
export const storageCategoryKind = z.enum([
  "sites",
  "mail",
  "databases",
  "backups",
  "logs",
  "containers",
  "home",
  "system",
  "other",
]);
export type StorageCategoryKind = z.infer<typeof storageCategoryKind>;

export const storageCategory = z.object({
  label: z.string(),
  path: z.string(),
  bytes,
  percent,
  kind: storageCategoryKind,
});
export type StorageCategory = z.infer<typeof storageCategory>;

export const storageLargestEntry = z.object({
  path: z.string(),
  bytes,
  kind: fileKind,
  modified_at: isoDate,
});
export type StorageLargestEntry = z.infer<typeof storageLargestEntry>;

export const storageBreakdown = z.object({
  server_id: uuid,
  server_name: z.string(),
  total: bytes,
  used: bytes,
  available: bytes,
  used_percent: percent,
  /** Walking a large disk is expensive, so this can be hours old. Shown, never hidden (KD-012). */
  sampled_at: isoDate,
  mounts: z.array(diskUsage),
  categories: z.array(storageCategory),
  largest: z.array(storageLargestEntry),
});
export type StorageBreakdown = z.infer<typeof storageBreakdown>;

export const storageQuery = z.object({
  server_id: uuid,
  path: absolutePath.default("/"),
  depth: z.coerce.number().int().min(1).max(4).default(2),
  /** Forces a fresh walk instead of serving the last sample. */
  refresh: z.coerce.boolean().default(false),
});
export type StorageQuery = z.infer<typeof storageQuery>;
