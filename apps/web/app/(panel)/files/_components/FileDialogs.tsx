"use client";

import * as React from "react";
import type { ArchiveInput, FileEntry } from "@kaname/contract";
import { ConfirmDialog, FormField, Input, MonoText, Select, Switch, cn } from "@kaname/ui";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import {
  useArchive,
  useChmod,
  useChown,
  useCopyEntries,
  useDeleteEntries,
  useExtract,
  useMakeDirectory,
  useMoveEntries,
  useWriteFile,
} from "./queries";
import { baseName, joinPath, octalMode, parentOf, symbolicMode } from "./status";

/* ------------------------------------------------------------------ *
 * Every file-manager mutation, as a dialog.
 *
 * They are collected here rather than scattered through the page for
 * one reason: rename, move, copy, compress, chmod and delete have to
 * feel like the same gesture with a different verb — same field column,
 * same footer order, same typed confirmation for the destructive one.
 * Each is mounted only while it is open, which is also how its form
 * state resets between uses.
 *
 * Every one of them ends in a job (KD-008); none of them reports its own
 * outcome. The page's job strip and the global drawer own that.
 * ------------------------------------------------------------------ */

export type FileDialog =
  | { kind: "mkdir" }
  | { kind: "new-file" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "move"; entries: readonly FileEntry[] }
  | { kind: "copy"; entries: readonly FileEntry[] }
  | { kind: "delete"; entries: readonly FileEntry[] }
  | { kind: "chmod"; entries: readonly FileEntry[] }
  | { kind: "chown"; entries: readonly FileEntry[] }
  | { kind: "archive"; entries: readonly FileEntry[] }
  | { kind: "extract"; entry: FileEntry };

export interface FileDialogsProps {
  dialog: FileDialog | null;
  onClose: () => void;
  serverId: string;
  /** Directory being browsed; seeds every destination field. */
  cwd: string;
}

export function FileDialogs({ dialog, onClose, serverId, cwd }: FileDialogsProps) {
  if (!dialog) return null;

  switch (dialog.kind) {
    case "mkdir":
      return <NewEntryDialog kind="directory" serverId={serverId} cwd={cwd} onClose={onClose} />;
    case "new-file":
      return <NewEntryDialog kind="file" serverId={serverId} cwd={cwd} onClose={onClose} />;
    case "rename":
      return <RenameDialog entry={dialog.entry} serverId={serverId} onClose={onClose} />;
    case "move":
      return (
        <TransferDialog
          mode="move"
          entries={dialog.entries}
          serverId={serverId}
          cwd={cwd}
          onClose={onClose}
        />
      );
    case "copy":
      return (
        <TransferDialog
          mode="copy"
          entries={dialog.entries}
          serverId={serverId}
          cwd={cwd}
          onClose={onClose}
        />
      );
    case "delete":
      return <DeleteDialog entries={dialog.entries} serverId={serverId} onClose={onClose} />;
    case "chmod":
      return <ChmodDialog entries={dialog.entries} serverId={serverId} onClose={onClose} />;
    case "chown":
      return <ChownDialog entries={dialog.entries} serverId={serverId} onClose={onClose} />;
    case "archive":
      return (
        <ArchiveDialog entries={dialog.entries} serverId={serverId} cwd={cwd} onClose={onClose} />
      );
    case "extract":
      return <ExtractDialog entry={dialog.entry} serverId={serverId} cwd={cwd} onClose={onClose} />;
  }
}

/* ------------------------------------------------------------------ *
 * Shared validation
 * ------------------------------------------------------------------ */

/** The agent re-validates; this is so the operator hears it immediately. */
function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "." || trimmed === "..") return "That is not a name a file can have.";
  if (trimmed.includes("/")) return "A name cannot contain a path separator.";
  if (trimmed.includes("\0")) return "A name cannot contain a null byte.";
  return null;
}

function pathProblem(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("/")) return "Give an absolute path, starting at /.";
  if (trimmed.split("/").includes("..")) return "Path traversal is not allowed.";
  return null;
}

function TargetSummary({ entries }: { entries: readonly FileEntry[] }) {
  if (entries.length === 1) {
    return <MonoText className="text-[var(--kn-text)]">{entries[0]!.path}</MonoText>;
  }
  return (
    <ul className="max-h-32 overflow-y-auto rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-2 py-1.5">
      {entries.map((entry) => (
        <li key={entry.path} className="kn-mono truncate text-[var(--kn-text-2)]">
          {entry.path}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

function NewEntryDialog({
  kind,
  serverId,
  cwd,
  onClose,
}: {
  kind: "directory" | "file";
  serverId: string;
  cwd: string;
  onClose: () => void;
}) {
  const [name, setName] = React.useState("");
  const mkdir = useMakeDirectory();
  const write = useWriteFile();
  const mutation = kind === "directory" ? mkdir : write;

  const problem = nameProblem(name);
  const errors = fieldErrors(mutation.error);
  const target = joinPath(cwd, name.trim());

  const submit = () => {
    if (kind === "directory") {
      mkdir.mutate({ server_id: serverId, path: target, parents: true }, { onSuccess: onClose });
      return;
    }
    write.mutate(
      {
        server_id: serverId,
        path: target,
        content: "",
        encoding: "utf8",
        create_parents: false,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={kind === "directory" ? "New folder" : "New file"}
      description={
        <>
          Created in <MonoText muted>{cwd}</MonoText>.
        </>
      }
      submitLabel={kind === "directory" ? "Create folder" : "Create file"}
      submitting={mutation.isPending}
      canSubmit={name.trim().length > 0 && problem === null}
      error={mutation.error}
      onSubmit={submit}
      size="sm"
    >
      <FormField
        label="Name"
        error={problem ?? errors["path"]}
        description={
          name.trim().length > 0 ? (
            <MonoText muted>{target}</MonoText>
          ) : (
            "A leading dot makes it hidden."
          )
        }
        required
      >
        <Input
          mono
          data-autofocus=""
          value={name}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          placeholder={kind === "directory" ? "releases" : "app.conf"}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Rename
 * ------------------------------------------------------------------ */

function RenameDialog({
  entry,
  serverId,
  onClose,
}: {
  entry: FileEntry;
  serverId: string;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(entry.name);
  const move = useMoveEntries();

  const problem = nameProblem(name);
  const errors = fieldErrors(move.error);
  const target = joinPath(parentOf(entry.path), name.trim());
  const changed = name.trim() !== entry.name;

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Rename"
      description={<MonoText muted>{entry.path}</MonoText>}
      submitLabel="Rename"
      submitting={move.isPending}
      canSubmit={changed && name.trim().length > 0 && problem === null}
      error={move.error}
      onSubmit={() =>
        move.mutate(
          {
            server_id: serverId,
            moves: [{ from: entry.path, to: target }],
            overwrite: false,
          },
          { onSuccess: onClose },
        )
      }
      size="sm"
    >
      <FormField
        label="New name"
        error={problem ?? errors["to"]}
        description={<MonoText muted>{target}</MonoText>}
        required
      >
        <Input
          mono
          data-autofocus=""
          value={name}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Move / copy
 * ------------------------------------------------------------------ */

function TransferDialog({
  mode,
  entries,
  serverId,
  cwd,
  onClose,
}: {
  mode: "move" | "copy";
  entries: readonly FileEntry[];
  serverId: string;
  cwd: string;
  onClose: () => void;
}) {
  const [destination, setDestination] = React.useState(cwd);
  const [overwrite, setOverwrite] = React.useState(false);
  const move = useMoveEntries();
  const copy = useCopyEntries();
  const mutation = mode === "move" ? move : copy;

  const problem = pathProblem(destination);
  const errors = fieldErrors(mutation.error);
  const moves = entries.map((entry) => ({
    from: entry.path,
    to: joinPath(destination.trim(), entry.name),
  }));
  const unchanged = moves.every((entry) => entry.to === entry.from);

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={mode === "move" ? "Move" : "Copy"}
      description={`${entries.length} ${entries.length === 1 ? "entry" : "entries"} into a destination directory.`}
      submitLabel={mode === "move" ? "Move" : "Copy"}
      submitting={mutation.isPending}
      canSubmit={destination.trim().length > 0 && problem === null && !unchanged}
      error={mutation.error}
      onSubmit={() =>
        mutation.mutate({ server_id: serverId, moves, overwrite }, { onSuccess: onClose })
      }
    >
      <FormField label={entries.length === 1 ? "Source" : "Sources"}>
        <TargetSummary entries={entries} />
      </FormField>

      <FormField
        label="Destination directory"
        error={problem ?? errors["to"]}
        description={
          unchanged
            ? "That is where these already are."
            : "Each entry keeps its own name inside this directory."
        }
        required
      >
        <Input
          mono
          data-autofocus=""
          value={destination}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setDestination(event.target.value)
          }
          placeholder="/var/www"
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <Switch
        checked={overwrite}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          setOverwrite(event.target.checked)
        }
        label="Overwrite what is already there"
        description="Off means the job fails on a name collision instead of replacing a file."
      />
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

function DeleteDialog({
  entries,
  serverId,
  onClose,
}: {
  entries: readonly FileEntry[];
  serverId: string;
  onClose: () => void;
}) {
  const remove = useDeleteEntries();
  const single = entries.length === 1 ? entries[0] : undefined;
  const directories = entries.filter((entry) => entry.kind === "directory").length;
  const confirmText = single ? single.name : `delete ${entries.length} items`;

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={single ? `Delete ${single.name}?` : `Delete ${entries.length} entries?`}
      description="Deletion happens on the host and Kaname keeps no copy. Nothing here goes to a trash folder."
      confirmText={confirmText}
      confirmLabel="Delete"
      loading={remove.isPending}
      onConfirm={() =>
        remove.mutate(
          {
            server_id: serverId,
            paths: entries.map((entry) => entry.path),
            recursive: directories > 0,
          },
          { onSuccess: onClose },
        )
      }
    >
      <div className="flex flex-col gap-3">
        <TargetSummary entries={entries} />
        {directories > 0 && (
          <p className="text-sm text-[var(--kn-warn)]">
            {directories === 1
              ? "One of these is a directory"
              : `${directories} of these are directories`}{" "}
            and will be removed with everything inside.
          </p>
        )}
        {remove.error != null && (
          <p className="text-sm text-[var(--kn-danger)]">
            {remove.error.message}
            {remove.error.remediation?.summary ? ` ${remove.error.remediation.summary}` : ""}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

const MODE_PATTERN = /^0?[0-7]{3,4}$/;

const MODE_PRESETS: readonly { mode: string; label: string }[] = [
  { mode: "0644", label: "0644 — files the web server reads" },
  { mode: "0664", label: "0664 — files the group may write" },
  { mode: "0755", label: "0755 — directories and executables" },
  { mode: "0775", label: "0775 — directories the group may write" },
  { mode: "0600", label: "0600 — keys and credentials" },
  { mode: "0700", label: "0700 — private directories" },
];

function ChmodDialog({
  entries,
  serverId,
  onClose,
}: {
  entries: readonly FileEntry[];
  serverId: string;
  onClose: () => void;
}) {
  const first = entries[0];
  const [mode, setMode] = React.useState(() => (first ? octalMode(first.mode) : "0644"));
  const [recursive, setRecursive] = React.useState(false);
  const chmod = useChmod();

  const valid = MODE_PATTERN.test(mode.trim());
  const errors = fieldErrors(chmod.error);
  const hasDirectory = entries.some((entry) => entry.kind === "directory");

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Permissions"
      description={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}.`}
      submitLabel="Apply mode"
      submitting={chmod.isPending}
      canSubmit={valid}
      error={chmod.error}
      onSubmit={() =>
        chmod.mutate(
          {
            server_id: serverId,
            paths: entries.map((entry) => entry.path),
            mode: mode.trim(),
            recursive,
          },
          { onSuccess: onClose },
        )
      }
      size="sm"
    >
      <FormField label="Target">
        <TargetSummary entries={entries} />
      </FormField>

      <FormField
        label="Octal mode"
        required
        error={!valid && mode.trim().length > 0 ? "Modes look like 0644." : errors["mode"]}
        description={
          valid ? (
            <MonoText muted>{symbolicMode(first?.kind ?? "file", mode.trim())}</MonoText>
          ) : (
            "Three or four octal digits."
          )
        }
      >
        <Input
          mono
          data-autofocus=""
          value={mode}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setMode(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField label="Common modes">
        <Select
          value={MODE_PRESETS.some((preset) => preset.mode === mode.trim()) ? mode.trim() : ""}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setMode(event.target.value)}
          placeholder="Pick one"
          options={MODE_PRESETS.map((preset) => ({ value: preset.mode, label: preset.label }))}
          mono
        />
      </FormField>

      {hasDirectory && (
        <Switch
          checked={recursive}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setRecursive(event.target.checked)
          }
          label="Apply to everything inside"
          description="A recursive chmod gives files the same bits as directories, which usually makes them executable. Prefer running it on files and directories separately."
        />
      )}
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

function ChownDialog({
  entries,
  serverId,
  onClose,
}: {
  entries: readonly FileEntry[];
  serverId: string;
  onClose: () => void;
}) {
  const first = entries[0];
  const [owner, setOwner] = React.useState(first?.owner ?? "");
  const [group, setGroup] = React.useState(first?.group ?? "");
  const [recursive, setRecursive] = React.useState(false);
  const chown = useChown();

  const errors = fieldErrors(chown.error);
  const hasDirectory = entries.some((entry) => entry.kind === "directory");
  const canSubmit = owner.trim().length > 0 || group.trim().length > 0;

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Ownership"
      description={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}. Leave a field empty to keep it as it is.`}
      submitLabel="Apply ownership"
      submitting={chown.isPending}
      canSubmit={canSubmit}
      error={chown.error}
      onSubmit={() =>
        chown.mutate(
          {
            server_id: serverId,
            paths: entries.map((entry) => entry.path),
            ...(owner.trim() ? { owner: owner.trim() } : {}),
            ...(group.trim() ? { group: group.trim() } : {}),
            recursive,
          },
          { onSuccess: onClose },
        )
      }
      size="sm"
    >
      <FormField label="Target">
        <TargetSummary entries={entries} />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Owner" error={errors["owner"]}>
          <Input
            mono
            data-autofocus=""
            value={owner}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setOwner(event.target.value)}
            placeholder="www-data"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <FormField label="Group" error={errors["group"]}>
          <Input
            mono
            value={group}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setGroup(event.target.value)}
            placeholder="www-data"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      </div>

      {hasDirectory && (
        <Switch
          checked={recursive}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setRecursive(event.target.checked)
          }
          label="Apply to everything inside"
        />
      )}
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Archive / extract
 * ------------------------------------------------------------------ */

type ArchiveFormat = ArchiveInput["format"];

const FORMAT_META: Record<ArchiveFormat, { label: string; extension: string }> = {
  "tar.gz": { label: "tar.gz — read by anything", extension: ".tar.gz" },
  "tar.zst": { label: "tar.zst — smaller and faster, needs zstd", extension: ".tar.zst" },
  zip: { label: "zip — for handing to a desktop", extension: ".zip" },
};

function defaultArchiveName(entries: readonly FileEntry[], format: ArchiveFormat): string {
  const stem = entries.length === 1 && entries[0] ? baseName(entries[0].path) : "archive";
  return `${stem}${FORMAT_META[format].extension}`;
}

function ArchiveDialog({
  entries,
  serverId,
  cwd,
  onClose,
}: {
  entries: readonly FileEntry[];
  serverId: string;
  cwd: string;
  onClose: () => void;
}) {
  const [format, setFormat] = React.useState<ArchiveFormat>("tar.gz");
  const [name, setName] = React.useState(() => defaultArchiveName(entries, "tar.gz"));
  const archive = useArchive();

  const problem = nameProblem(name);
  const errors = fieldErrors(archive.error);
  const destination = joinPath(cwd, name.trim());

  const changeFormat = (next: ArchiveFormat) => {
    setFormat(next);
    setName((current) =>
      current === defaultArchiveName(entries, format) ? defaultArchiveName(entries, next) : current,
    );
  };

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Compress"
      description={`${entries.length} ${entries.length === 1 ? "entry" : "entries"} into one archive, written next to them.`}
      submitLabel="Create archive"
      submitting={archive.isPending}
      canSubmit={name.trim().length > 0 && problem === null}
      error={archive.error}
      onSubmit={() =>
        archive.mutate(
          {
            server_id: serverId,
            paths: entries.map((entry) => entry.path),
            destination,
            format,
          },
          { onSuccess: onClose },
        )
      }
    >
      <FormField label={entries.length === 1 ? "Source" : "Sources"}>
        <TargetSummary entries={entries} />
      </FormField>

      <FormField label="Format">
        <Select
          value={format}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
            changeFormat(event.target.value as ArchiveFormat)
          }
          options={(Object.keys(FORMAT_META) as ArchiveFormat[]).map((key) => ({
            value: key,
            label: FORMAT_META[key].label,
          }))}
        />
      </FormField>

      <FormField
        label="Archive name"
        required
        error={problem ?? errors["destination"]}
        description={<MonoText muted>{destination}</MonoText>}
      >
        <Input
          mono
          value={name}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
    </FormDialog>
  );
}

function ExtractDialog({
  entry,
  serverId,
  cwd,
  onClose,
}: {
  entry: FileEntry;
  serverId: string;
  cwd: string;
  onClose: () => void;
}) {
  const [destination, setDestination] = React.useState(cwd);
  const [overwrite, setOverwrite] = React.useState(false);
  const extract = useExtract();

  const problem = pathProblem(destination);
  const errors = fieldErrors(extract.error);

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Extract"
      description={<MonoText muted>{entry.path}</MonoText>}
      submitLabel="Extract"
      submitting={extract.isPending}
      canSubmit={destination.trim().length > 0 && problem === null}
      error={extract.error}
      onSubmit={() =>
        extract.mutate(
          {
            server_id: serverId,
            path: entry.path,
            destination: destination.trim(),
            overwrite,
          },
          { onSuccess: onClose },
        )
      }
      size="sm"
    >
      <FormField
        label="Destination directory"
        required
        error={problem ?? errors["destination"]}
        description="The archive's own paths are created underneath this."
      >
        <Input
          mono
          data-autofocus=""
          value={destination}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setDestination(event.target.value)
          }
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <Switch
        checked={overwrite}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          setOverwrite(event.target.checked)
        }
        label="Overwrite existing files"
        description="Off means the job stops at the first collision rather than replacing anything."
      />
    </FormDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Upload queue
 * ------------------------------------------------------------------ */

export interface UploadEntry {
  id: string;
  name: string;
  loaded: number;
  total: number;
  status: "uploading" | "done" | "failed";
  error: string | null;
}

export interface UploadQueueProps {
  uploads: readonly UploadEntry[];
  onCancel: (id: string) => void;
  onDismiss: () => void;
  className?: string;
}

/** Byte progress, because an upload is the one file operation where the panel really knows. */
export function UploadQueue({ uploads, onCancel, onDismiss, className }: UploadQueueProps) {
  if (uploads.length === 0) return null;

  return (
    <section
      aria-label="Uploads"
      className={cn(
        "overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]",
        className,
      )}
    >
      <div className="flex h-9 items-center justify-between gap-3 border-b border-[var(--kn-border)] px-4">
        <h2 className="font-medium text-[var(--kn-text)]">Uploads</h2>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Clear finished
        </button>
      </div>
      <ul>
        {uploads.map((upload) => {
          const percent = upload.total > 0 ? (upload.loaded / upload.total) * 100 : 0;
          return (
            <li
              key={upload.id}
              className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
            >
              <MonoText truncate className="min-w-0 flex-1 text-[var(--kn-text)]">
                {upload.name}
              </MonoText>

              <div className="w-40 shrink-0">
                <div
                  role="progressbar"
                  aria-label={`${upload.name} upload`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(percent)}
                  className="h-0.5 w-full overflow-hidden rounded-[var(--kn-r-xs)] bg-[var(--kn-border)]"
                >
                  <div
                    className={cn(
                      "h-full w-full origin-left transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)]",
                      upload.status === "failed"
                        ? "bg-[var(--kn-danger)]"
                        : upload.status === "done"
                          ? "bg-[var(--kn-ok)]"
                          : "bg-[var(--kn-accent-500)]",
                    )}
                    style={{ transform: `scaleX(${Math.min(1, percent / 100)})` }}
                  />
                </div>
              </div>

              <span
                className={cn(
                  "kn-num w-28 shrink-0 text-right text-xs",
                  upload.status === "failed"
                    ? "text-[var(--kn-danger)]"
                    : "text-[var(--kn-text-2)]",
                )}
                title={upload.error ?? undefined}
              >
                {upload.status === "failed"
                  ? (upload.error ?? "Failed")
                  : upload.status === "done"
                    ? "Uploaded"
                    : `${Math.round(percent)}%`}
              </span>

              {upload.status === "uploading" && (
                <button
                  type="button"
                  onClick={() => onCancel(upload.id)}
                  className="shrink-0 rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
                >
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
