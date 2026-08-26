"use client";

import * as React from "react";
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileKey,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  Link2,
  Radio,
  Settings2,
} from "lucide-react";
import type { FileEntry, FileKind, FtpAccount } from "@kaname/contract";
import { Badge, MonoText, cn } from "@kaname/ui";
import type { IconComponent } from "@/lib/icons";

/* ------------------------------------------------------------------ *
 * The Files module's shared vocabulary.
 *
 * A path, a mode and an owner are the three things an operator reads in
 * a file listing before anything else, and all three are technical
 * strings — so they are mono everywhere, formatted the way `ls -l`
 * formats them, because that is the notation the reader already knows.
 * ------------------------------------------------------------------ */

/* -------------------------------- icons ------------------------------ */

const EXTENSION_ICONS: Record<string, IconComponent> = {
  js: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  php: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  css: FileCode,
  scss: FileCode,
  less: FileCode,
  html: FileCode,
  htm: FileCode,
  vue: FileCode,
  svelte: FileCode,
  sql: FileCode,

  json: FileJson,
  yaml: Settings2,
  yml: Settings2,
  toml: Settings2,
  ini: Settings2,
  conf: Settings2,
  cnf: Settings2,
  env: Settings2,

  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  service: Radio,
  socket: Radio,
  timer: Radio,

  pem: FileKey,
  key: FileKey,
  crt: FileKey,
  cer: FileKey,
  pub: FileKey,

  md: FileText,
  txt: FileText,
  log: FileText,

  gz: FileArchive,
  tgz: FileArchive,
  zst: FileArchive,
  bz2: FileArchive,
  xz: FileArchive,
  zip: FileArchive,
  tar: FileArchive,
  rar: FileArchive,
  "7z": FileArchive,

  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  avif: FileImage,
  ico: FileImage,

  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  ogg: FileAudio,

  mp4: FileVideo,
  mkv: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function iconForEntry(entry: { name: string; kind: FileKind }): IconComponent {
  if (entry.kind === "directory") return Folder;
  if (entry.kind === "symlink") return Link2;
  return EXTENSION_ICONS[extensionOf(entry.name)] ?? FileIcon;
}

const ARCHIVE_EXTENSIONS = new Set(["gz", "tgz", "zst", "bz2", "xz", "zip", "tar", "7z"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"]);

export function isArchive(entry: { name: string; kind: FileKind }): boolean {
  return entry.kind === "file" && ARCHIVE_EXTENSIONS.has(extensionOf(entry.name));
}

export function isImage(entry: { name: string; kind: FileKind; mime?: string | null }): boolean {
  if (entry.kind !== "file") return false;
  if (entry.mime?.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(extensionOf(entry.name));
}

/* -------------------------------- mode ------------------------------- */

const RWX = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"] as const;

const KIND_PREFIX: Record<FileKind, string> = {
  file: "-",
  directory: "d",
  symlink: "l",
  socket: "s",
  fifo: "p",
  device: "c",
};

/** Four octal digits, so the chmod dialog always round-trips setuid bits. */
export function octalMode(mode: string): string {
  const digits = mode.replace(/[^0-7]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : digits.padStart(4, "0");
}

/** `drwxr-xr-x` — what an operator is used to reading in a listing. */
export function symbolicMode(kind: FileKind, mode: string): string {
  const digits = octalMode(mode).slice(-3);
  let out = KIND_PREFIX[kind] ?? "-";
  for (const digit of digits) {
    out += RWX[Number.parseInt(digit, 10)] ?? "---";
  }
  return out;
}

export function ModeCell({ entry }: { entry: FileEntry }) {
  const octal = octalMode(entry.mode);
  return (
    <MonoText muted title={`${symbolicMode(entry.kind, entry.mode)} (${octal})`}>
      {symbolicMode(entry.kind, entry.mode)}
    </MonoText>
  );
}

export function OwnerCell({ entry }: { entry: FileEntry }) {
  return (
    <MonoText muted truncate title={`uid ${entry.uid}, gid ${entry.gid}`}>
      {entry.owner}:{entry.group}
    </MonoText>
  );
}

/* -------------------------------- name ------------------------------- */

export interface FileNameCellProps {
  entry: FileEntry;
  className?: string;
}

/** Name, type glyph and — for a symlink — where it actually goes. */
export function FileNameCell({ entry, className }: FileNameCellProps) {
  const Icon = iconForEntry(entry);
  const hidden = entry.name.startsWith(".");

  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <Icon
        size={14}
        aria-hidden
        className={cn(
          "shrink-0",
          entry.kind === "directory" ? "text-[var(--kn-accent-400)]" : "text-[var(--kn-text-3)]",
        )}
      />
      <span
        className={cn(
          "kn-mono min-w-0 truncate",
          hidden ? "text-[var(--kn-text-2)]" : "text-[var(--kn-text)]",
        )}
        title={entry.path}
      >
        {entry.name}
      </span>
      {entry.link_target && (
        <MonoText muted truncate className="min-w-0 text-xs">
          → {entry.link_target}
        </MonoText>
      )}
    </span>
  );
}

/* ------------------------------ transfer ----------------------------- */

export type TransferProtocol = FtpAccount["protocol"];

const PROTOCOL_META: Record<TransferProtocol, { label: string; title: string }> = {
  sftp: {
    label: "SFTP",
    title:
      "File transfer over the host's SSH daemon. Encrypted, and the only protocol whose live sessions Kaname can enumerate.",
  },
  ftps: {
    label: "FTPS",
    title:
      "FTP with TLS. Supported for clients that need it, but its session table is private to the FTP daemon.",
  },
};

export function ProtocolBadge({ protocol }: { protocol: TransferProtocol }) {
  const meta = PROTOCOL_META[protocol];
  return (
    <Badge tone={protocol === "sftp" ? "accent" : "neutral"} size="xs" title={meta.title}>
      {meta.label}
    </Badge>
  );
}

/* -------------------------------- paths ------------------------------ */

export function parentOf(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

export function joinPath(directory: string, name: string): string {
  const base = directory === "/" ? "" : directory.replace(/\/+$/, "");
  return `${base}/${name.replace(/^\/+/, "")}`;
}

export function baseName(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
