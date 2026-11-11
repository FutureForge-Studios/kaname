"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Copy,
  CornerUpRight,
  Download,
  FilePlus,
  FileText,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  Lock,
  Package,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Upload,
  UserCog,
  WrapText,
  X,
} from "lucide-react";
import type { FileEntry } from "@kaname/contract";
import {
  InlineError,
  Badge,
  Button,
  ByteSize,
  ConfirmDialog,
  CopyButton,
  DataTable,
  EmptyState,
  FileTree,
  IconButton,
  MonoLabel,
  MonoText,
  PageHeader,
  PathBreadcrumb,
  RelativeTime,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  Switch,
  cn,
  type DataTableColumn,
  type DataTableRowAction,
  type FileTreeNode,
  type SortState,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { queryKeys, useCan } from "@/lib/queries";
import { JobActivityBar } from "../../_components/JobActivity";
import {
  FileDialogs,
  UploadQueue,
  type FileDialog,
  type UploadEntry,
} from "../_components/FileDialogs";
import {
  EDITOR_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  downloadUrl,
  useDirectory,
  useDirectoryLoader,
  useFileContent,
  useSaveFile,
  type BrowseSort,
} from "../_components/queries";
import {
  FileNameCell,
  ModeCell,
  OwnerCell,
  baseName,
  isArchive,
  isImage,
  parentOf,
} from "../_components/status";
import { uploadFile } from "../_components/upload";

/* ------------------------------------------------------------------ *
 * File Manager.
 *
 * A directory listing is a live pass-through: it is stale the moment it
 * is taken, so nothing here is cached across a refresh and the "synced"
 * stamp is real. Everything that changes a byte is a job (KD-008), which
 * is why no button on this page reports its own outcome — the strip
 * above the table and the global drawer do.
 *
 * The layout is desktop-first and deliberately two-pane: the tree is how
 * an operator keeps their place in a deep webroot, and the table is
 * where the density lives. Below 1024px the tree folds away rather than
 * eating a third of the columns.
 * ------------------------------------------------------------------ */

const FILE_JOB_TYPES = ["fs."] as const;
const PER_PAGE = 100;

const FileEditor = dynamic(
  () => import("../_components/FileEditor").then((module) => module.FileEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-0 flex-1 flex-col gap-2 bg-[var(--kn-bg-inset)] p-4">
        <Skeleton className="h-3 w-2/3" label="Loading the editor" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    ),
  },
);

type KindFilter = "" | "directory" | "file" | "symlink";

interface OpenFile {
  path: string;
  mode: "edit" | "preview";
}

export default function FileManagerPage() {
  const router = useRouter();
  const pathname = usePathname() ?? "/files/manager";
  const searchParams = useSearchParams();
  const client = useQueryClient();
  const can = useCan();

  const selection = useServerSelection({ permission: "files.manager:read", required: true });
  const serverId = selection.serverId;

  const path = searchParams.get("path") ?? "/";
  const kindParam = searchParams.get("kind");
  const urlKind: KindFilter =
    kindParam === "directory" || kindParam === "file" || kindParam === "symlink" ? kindParam : "";
  const urlHidden = searchParams.get("hidden") === "1";
  /* The URL is the source of truth (so Back and Forward restore filters),
   * but router.replace lands a tick later; a control bound straight to it
   * would snap back for a frame on every click. Local state answers the
   * click at once and follows the URL whenever history moves it. */
  const [kindFilter, setKindState] = React.useState<KindFilter>(urlKind);
  const [showHidden, setHiddenState] = React.useState(urlHidden);
  React.useEffect(() => setKindState(urlKind), [urlKind]);
  React.useEffect(() => setHiddenState(urlHidden), [urlHidden]);

  /*
   * Directory changes are history entries and filter tweaks are not.
   * Navigating with replace meant the browser's Back button left the file
   * manager altogether instead of going up to the folder the operator was
   * just in; pushing every filter click would bury that folder under
   * entries that differ only by a checkbox. So a new path pushes, and a
   * filter rewrites the current entry in place.
   */
  const navigate = React.useCallback(
    (updates: Record<string, string | null>, mode: "push" | "replace") => {
      // The live URL, not the render's snapshot: two filter changes in one
      // tick would otherwise each start from the same stale query and the
      // second would drop the first.
      const params = new URLSearchParams(
        typeof window === "undefined" ? searchParams.toString() : window.location.search,
      );
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const setPath = React.useCallback(
    (next: string) => {
      if (next === path) return;
      navigate({ path: next === "/" ? null : next }, "push");
    },
    [navigate, path],
  );
  const setKindFilter = React.useCallback(
    (next: KindFilter) => {
      setKindState(next);
      navigate({ kind: next || null }, "replace");
    },
    [navigate],
  );
  const setShowHidden = React.useCallback(
    (next: boolean) => {
      setHiddenState(next);
      navigate({ hidden: next ? "1" : null }, "replace");
    },
    [navigate],
  );

  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortState | null>({ id: "name", order: "asc" });
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [dialog, setDialog] = React.useState<FileDialog | null>(null);
  const [open, setOpen] = React.useState<OpenFile | null>(null);

  const listing = useDirectory(serverId, {
    path,
    showHidden,
    sort: (sort?.id as BrowseSort | undefined) ?? "name",
    order: sort?.order ?? "asc",
  });

  /* A selection that survived a directory change would act on rows the
   * operator can no longer see. */
  React.useEffect(() => {
    setSelected([]);
    setPage(1);
    setOpen(null);
  }, [path, serverId]);

  React.useEffect(() => {
    setPage(1);
  }, [search, kindFilter, showHidden]);

  const entries = React.useMemo(() => listing.data?.entries ?? [], [listing.data]);

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (kindFilter && entry.kind !== kindFilter) return false;
      if (needle && !entry.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [entries, kindFilter, search]);

  const rows = React.useMemo(
    () => filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE),
    [filtered, page],
  );

  const byPath = React.useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry] as const)),
    [entries],
  );

  const selectedEntries = React.useMemo(
    () =>
      selected.map((id) => byPath.get(id)).filter((entry): entry is FileEntry => Boolean(entry)),
    [byPath, selected],
  );

  const writable = Boolean(listing.data?.writable);
  const canWrite = writable && can("files.manager:write", serverId);
  const canDelete = writable && can("files.manager:delete", serverId);
  const filtering = search.trim().length > 0 || kindFilter !== "";

  /* ---------------------------- the tree ---------------------------- */

  const loadDirectory = useDirectoryLoader(serverId, showHidden);
  const [treeChildren, setTreeChildren] = React.useState<Record<string, FileTreeNode[]>>({});
  const [expanded, setExpanded] = React.useState<string[]>(["/"]);

  React.useEffect(() => {
    setTreeChildren({});
    setExpanded(["/"]);
  }, [serverId, showHidden]);

  const loadInto = React.useCallback(
    async (directory: string) => {
      const result = await loadDirectory(directory);
      setTreeChildren((current) => ({
        ...current,
        [directory]: result.entries
          .filter((entry) => entry.kind === "directory")
          .map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind })),
      }));
    },
    [loadDirectory],
  );

  /* The tree has to already contain the directory the table is showing,
   * so every ancestor of the current path is opened for it. */
  React.useEffect(() => {
    if (!serverId) return;
    let cancelled = false;

    const ancestors: string[] = ["/"];
    const segments = path.split("/").filter(Boolean);
    let cursor = "";
    for (const segment of segments) {
      cursor += `/${segment}`;
      ancestors.push(cursor);
    }

    void (async () => {
      for (const ancestor of ancestors) {
        if (cancelled) return;
        try {
          await loadInto(ancestor);
        } catch {
          /* A directory the caller cannot read is simply not expandable;
           * the table below already renders the real error. */
          return;
        }
      }
      if (!cancelled) setExpanded((current) => [...new Set([...current, ...ancestors])]);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadInto, path, serverId]);

  /* `undefined` children is what tells FileTree a folder has not been
   * read yet, so an unloaded directory must stay undefined rather than
   * collapse to an empty array — otherwise it renders as "empty". */
  const treeNodes = React.useMemo<FileTreeNode[]>(() => {
    const build = (directory: string): FileTreeNode[] | undefined => {
      const children = treeChildren[directory];
      if (!children) return undefined;
      return children.map((child) => {
        const nested = build(child.path);
        return nested === undefined ? child : { ...child, children: nested };
      });
    };
    return [{ path: "/", name: "/", kind: "directory", children: build("/") }];
  }, [treeChildren]);

  /* ---------------------------- uploads ----------------------------- */

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const uploadHandles = React.useRef(new Map<string, () => void>());
  const [uploads, setUploads] = React.useState<UploadEntry[]>([]);
  const [dragging, setDragging] = React.useState(false);

  const startUploads = React.useCallback(
    (files: FileList | File[]) => {
      if (!serverId || !canWrite) return;
      for (const file of Array.from(files)) {
        const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setUploads((current) => [
          ...current,
          { id, name: file.name, loaded: 0, total: file.size, status: "uploading", error: null },
        ]);

        const handle = uploadFile({
          serverId,
          directory: path,
          file,
          overwrite: false,
          onProgress: (loaded, total) => {
            setUploads((current) =>
              current.map((entry) => (entry.id === id ? { ...entry, loaded, total } : entry)),
            );
          },
        });
        uploadHandles.current.set(id, handle.cancel);

        void handle.done
          .then(() => {
            setUploads((current) =>
              current.map((entry) =>
                entry.id === id ? { ...entry, status: "done", loaded: entry.total } : entry,
              ),
            );
            void client.invalidateQueries({ queryKey: queryKeys.family("files") });
            void client.invalidateQueries({ queryKey: queryKeys.family("storage") });
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            setUploads((current) =>
              current.map((entry) =>
                entry.id === id ? { ...entry, status: "failed", error: message } : entry,
              ),
            );
          })
          .finally(() => {
            uploadHandles.current.delete(id);
          });
      }
    },
    [canWrite, client, path, serverId],
  );

  React.useEffect(() => {
    const handles = uploadHandles.current;
    return () => {
      for (const cancel of handles.values()) cancel();
      handles.clear();
    };
  }, []);

  /* ---------------------------- columns ----------------------------- */

  const columns = React.useMemo<DataTableColumn<FileEntry>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        locked: true,
        sortable: true,
        minWidth: 260,
        cell: (entry) => <FileNameCell entry={entry} />,
      },
      {
        id: "size",
        header: "Size",
        sortable: true,
        width: 96,
        align: "right",
        cell: (entry) =>
          entry.kind === "directory" ? (
            <span className="text-[var(--kn-text-3)]">
              {entry.child_count === null ? "—" : `${entry.child_count} items`}
            </span>
          ) : (
            <ByteSize bytes={entry.size} />
          ),
      },
      {
        id: "mode",
        header: "Mode",
        width: 108,
        mono: true,
        hideBelow: "md",
        cell: (entry) => <ModeCell entry={entry} />,
      },
      {
        id: "owner",
        header: "Owner",
        width: 140,
        mono: true,
        hideBelow: "lg",
        cell: (entry) => <OwnerCell entry={entry} />,
      },
      {
        id: "modified",
        header: "Modified",
        sortable: true,
        width: 112,
        align: "right",
        cell: (entry) => <RelativeTime value={entry.modified_at} />,
      },
    ],
    [],
  );

  const openEntry = React.useCallback(
    (entry: FileEntry) => {
      if (entry.kind === "directory") {
        setPath(entry.path);
        return;
      }
      if (isImage(entry)) {
        setOpen({ path: entry.path, mode: "preview" });
        return;
      }
      if (entry.is_editable) {
        setOpen({ path: entry.path, mode: "edit" });
        return;
      }
      if (serverId) window.location.assign(downloadUrl(serverId, entry.path));
    },
    [serverId, setPath],
  );

  const rowActions = React.useCallback(
    (entry: FileEntry): DataTableRowAction<FileEntry>[] => {
      const actions: DataTableRowAction<FileEntry>[] = [
        {
          id: "open",
          label:
            entry.kind === "directory"
              ? "Open"
              : isImage(entry)
                ? "Preview"
                : entry.is_editable
                  ? "Edit"
                  : "Download",
          icon:
            entry.kind === "directory"
              ? FolderInput
              : isImage(entry)
                ? ImageIcon
                : entry.is_editable
                  ? FileText
                  : Download,
          onSelect: openEntry,
        },
      ];

      /* A file that neither previews nor edits already opens as a
       * download, so a second "Download" entry would be the same action
       * listed twice. Only files whose open action is something else get
       * the explicit one. */
      const opensAsDownload = entry.kind !== "directory" && !isImage(entry) && !entry.is_editable;
      if (entry.kind !== "directory" && !opensAsDownload) {
        actions.push({
          id: "download",
          label: "Download",
          icon: Download,
          onSelect: () => {
            if (serverId) window.location.assign(downloadUrl(serverId, entry.path));
          },
        });
      }

      if (entry.link_target?.startsWith("/")) {
        actions.push({
          id: "follow",
          label: "Go to link target",
          icon: CornerUpRight,
          onSelect: () => setPath(parentOf(entry.link_target ?? "/")),
        });
      }

      actions.push(
        {
          id: "rename",
          label: "Rename",
          icon: Pencil,
          disabled: !canWrite,
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "rename", entry }),
        },
        {
          id: "move",
          label: "Move",
          icon: FolderInput,
          disabled: !canWrite,
          onSelect: () => setDialog({ kind: "move", entries: [entry] }),
        },
        {
          id: "copy",
          label: "Copy",
          icon: Copy,
          disabled: !canWrite,
          onSelect: () => setDialog({ kind: "copy", entries: [entry] }),
        },
        {
          id: "compress",
          label: "Compress",
          icon: Package,
          disabled: !canWrite,
          onSelect: () => setDialog({ kind: "archive", entries: [entry] }),
        },
      );

      if (isArchive(entry)) {
        actions.push({
          id: "extract",
          label: "Extract",
          icon: Package,
          disabled: !canWrite,
          onSelect: () => setDialog({ kind: "extract", entry }),
        });
      }

      actions.push(
        {
          id: "chmod",
          label: "Permissions",
          icon: Lock,
          disabled: !canWrite,
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "chmod", entries: [entry] }),
        },
        {
          id: "chown",
          label: "Ownership",
          icon: UserCog,
          disabled: !canWrite,
          onSelect: () => setDialog({ kind: "chown", entries: [entry] }),
        },
        {
          id: "delete",
          label: "Delete",
          icon: Trash2,
          destructive: true,
          disabled: !canDelete,
          separatorBefore: true,
          onSelect: () => setDialog({ kind: "delete", entries: [entry] }),
        },
      );

      return actions;
    },
    [canDelete, canWrite, openEntry, serverId, setPath],
  );

  /* ---------------------------- rendering --------------------------- */

  const toolbar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <SearchInput
        data-kn-list-search=""
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onClear={() => setSearch("")}
        placeholder="Filter this directory"
        aria-label="Filter entries in this directory"
        size="sm"
        className="w-48"
      />
      <Select
        size="sm"
        value={kindFilter}
        onChange={(event) => setKindFilter(event.target.value as KindFilter)}
        aria-label="Entry type"
        boxClassName="w-36"
        options={[
          { value: "", label: "All types" },
          { value: "directory", label: "Directories" },
          { value: "file", label: "Files" },
          { value: "symlink", label: "Symlinks" },
        ]}
      />
      <Switch
        checked={showHidden}
        onChange={(event) => setShowHidden(event.target.checked)}
        label="Hidden"
        labelClassName="text-sm text-[var(--kn-text-2)]"
      />
      {filtering && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setSearch("");
            setKindFilter("");
          }}
        >
          Clear filters
        </Button>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {listing.dataUpdatedAt > 0 && (
          <span className="hidden items-center gap-1 text-xs text-[var(--kn-text-3)] md:inline-flex">
            listed <RelativeTime value={listing.dataUpdatedAt} />
          </span>
        )}
        <IconButton
          icon={RefreshCw}
          label="Re-read this directory"
          size="sm"
          disabled={listing.isFetching}
          onClick={() => void listing.refetch()}
        />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Files"
        title="File Manager"
        lede="Browse, edit and move files on a host. Reads are live; every change runs as a job on its agent."
        subtitle={
          selection.server ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{selection.server.hostname}</span>
              {!writable && listing.data && (
                <Badge tone="neutral" size="xs" title="This account cannot write on this host.">
                  read-only
                </Badge>
              )}
            </span>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={FolderPlus}
              disabled={!canWrite}
              onClick={() => setDialog({ kind: "mkdir" })}
            >
              New folder
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={FilePlus}
              disabled={!canWrite}
              onClick={() => setDialog({ kind: "new-file" })}
            >
              New file
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={Upload}
              disabled={!canWrite}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload
            </Button>
          </>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) startUploads(event.target.files);
          event.target.value = "";
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} />
          {/* The location bar: a recessed mono well, like an address field. */}
          <div className="flex h-8 min-w-[16rem] flex-1 items-center gap-1 rounded-[var(--kn-r-md)] border border-[var(--kn-field-border)] bg-[var(--kn-field-bg)] pl-1 pr-1.5">
            <IconButton
              icon={ArrowUp}
              label="Parent directory"
              size="xs"
              disabled={path === "/"}
              onClick={() => setPath(parentOf(path))}
            />
            <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--kn-border)]" />
            <PathBreadcrumb path={path} onNavigate={setPath} className="min-w-0 flex-1" />
          </div>
        </div>

        <JobActivityBar types={FILE_JOB_TYPES} title="File operations" />

        <UploadQueue
          uploads={uploads}
          onCancel={(id) => uploadHandles.current.get(id)?.()}
          onDismiss={() => setUploads((current) => current.filter((u) => u.status === "uploading"))}
        />

        {listing.data?.truncated && (
          <p className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-warn-soft)] px-3 py-2 text-sm text-[var(--kn-warn)]">
            This directory holds {listing.data.total} entries and the agent returned the first
            1,000. Narrow it with the filter, or work in a subdirectory.
          </p>
        )}

        {!serverId && !selection.isLoading ? (
          <SectionCard>
            <EmptyState
              icon={FolderPlus}
              title="No host in scope"
              description="File management needs a server this account may read files on."
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => router.push("/infrastructure/servers")}
                >
                  Open servers
                </Button>
              }
            />
          </SectionCard>
        ) : (
          <div
            onDragOver={(event) => {
              if (!canWrite) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              if (!canWrite) return;
              event.preventDefault();
              setDragging(false);
              if (event.dataTransfer.files.length > 0) startUploads(event.dataTransfer.files);
            }}
            className={cn(
              "grid min-h-[420px] flex-1 grid-cols-1 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]",
              dragging &&
                "rounded-[var(--kn-r-md)] outline-2 outline-dashed outline-[var(--kn-accent-500)]",
            )}
          >
            {/* The tree is a rail, not a card: a hairline on its right edge
                and a mono caption, so the listing stays the one framed object. */}
            <aside
              aria-label="Folders"
              className="hidden min-h-0 border-r border-[var(--kn-border)] pr-3 lg:flex lg:flex-col"
            >
              <div className="flex h-10 shrink-0 items-center border-b border-[var(--kn-border)] pl-1">
                <MonoLabel size="xs">Folders</MonoLabel>
              </div>
              <div className="-ml-1 min-h-0 flex-1 overflow-auto pt-1">
                <FileTree
                  nodes={treeNodes}
                  expandedPaths={expanded}
                  onExpandedChange={setExpanded}
                  selectedPath={path}
                  onSelect={(node) => {
                    if (node.kind === "directory") setPath(node.path);
                  }}
                  onLoadChildren={(node) => loadInto(node.path)}
                  label="Directory tree"
                  emptyLabel="Nothing readable here"
                />
              </div>
            </aside>

            {open ? (
              <FilePane
                key={open.path}
                serverId={serverId ?? ""}
                open={open}
                canWrite={canWrite}
                onClose={() => setOpen(null)}
                onReveal={() => {
                  setPath(parentOf(open.path));
                  setOpen(null);
                }}
              />
            ) : (
              <DataTable<FileEntry>
                columns={columns}
                rows={rows}
                getRowId={(entry) => entry.path}
                label="Directory listing"
                density="compact"
                toolbar={toolbar}
                sort={sort}
                onSortChange={setSort}
                page={page}
                perPage={PER_PAGE}
                total={filtered.length}
                onPageChange={setPage}
                selectedIds={selected}
                onSelectionChange={setSelected}
                bulkActions={() => (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={FolderInput}
                      disabled={!canWrite}
                      onClick={() => setDialog({ kind: "move", entries: selectedEntries })}
                    >
                      Move
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={Copy}
                      disabled={!canWrite}
                      onClick={() => setDialog({ kind: "copy", entries: selectedEntries })}
                    >
                      Copy
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={Package}
                      disabled={!canWrite}
                      onClick={() => setDialog({ kind: "archive", entries: selectedEntries })}
                    >
                      Compress
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={Lock}
                      disabled={!canWrite}
                      onClick={() => setDialog({ kind: "chmod", entries: selectedEntries })}
                    >
                      Permissions
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={UserCog}
                      disabled={!canWrite}
                      onClick={() => setDialog({ kind: "chown", entries: selectedEntries })}
                    >
                      Ownership
                    </Button>
                    <Button
                      variant="danger-subtle"
                      size="xs"
                      icon={Trash2}
                      disabled={!canDelete}
                      onClick={() => setDialog({ kind: "delete", entries: selectedEntries })}
                    >
                      Delete
                    </Button>
                  </>
                )}
                rowActions={rowActions}
                onRowClick={openEntry}
                loading={listing.isLoading}
                skeletonRows={12}
                error={
                  listing.isError ? (
                    <PageError
                      error={listing.error}
                      onRetry={() => void listing.refetch()}
                      context={path}
                    />
                  ) : undefined
                }
                empty={
                  <EmptyState
                    icon={FolderPlus}
                    title={filtering ? "No matches" : "This directory is empty"}
                    description={
                      filtering
                        ? "Nothing in this directory matches the current filter."
                        : `Nothing lives in ${path} yet.`
                    }
                    action={
                      filtering ? undefined : (
                        <Button
                          variant="primary"
                          size="sm"
                          icon={Upload}
                          disabled={!canWrite}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Upload a file
                        </Button>
                      )
                    }
                    secondaryAction={
                      filtering ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setSearch("");
                            setKindFilter("");
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : undefined
                    }
                    size="md"
                  />
                }
                className="min-h-0"
              />
            )}
          </div>
        )}
      </div>

      <FileDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        serverId={serverId ?? ""}
        cwd={path}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The open file: editor or preview
 * ------------------------------------------------------------------ */

interface FilePaneProps {
  serverId: string;
  open: OpenFile;
  canWrite: boolean;
  onClose: () => void;
  onReveal: () => void;
}

function FilePane({ serverId, open, canWrite, onClose, onReveal }: FilePaneProps) {
  const content = useFileContent(
    serverId,
    open.path,
    open.mode === "preview" ? PREVIEW_MAX_BYTES : EDITOR_MAX_BYTES,
  );
  const write = useSaveFile();

  const [draft, setDraft] = React.useState<string | null>(null);
  const [baseline, setBaseline] = React.useState<string | null>(null);
  const [wrap, setWrap] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  React.useEffect(() => {
    const loaded = content.data;
    if (!loaded || loaded.encoding !== "utf8") return;
    setDraft((current) => current ?? loaded.content);
    setBaseline((current) => current ?? loaded.content);
  }, [content.data]);

  const dirty = draft !== null && baseline !== null && draft !== baseline;
  const truncated = Boolean(content.data?.truncated);
  const readOnly = !canWrite || truncated;

  /* Binary content is never written back from here: the editor only ever
   * held a base64 rendering of it, and saving that as text would replace
   * the file with its own encoding. */
  const binary = content.data?.encoding === "base64";

  const save = React.useCallback(() => {
    if (draft === null || readOnly || binary) return;
    write.mutate(
      { serverId, path: open.path, content: draft },
      { onSuccess: () => setBaseline(draft) },
    );
  }, [binary, draft, open.path, readOnly, serverId, write]);

  const close = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const image =
    content.data !== undefined &&
    isImage({ name: baseName(open.path), kind: "file", mime: content.data.mime });

  return (
    <section
      aria-label={`File ${open.path}`}
      className="flex min-h-0 flex-col overflow-hidden rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)]"
    >
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--kn-border)] py-1.5 pl-3 pr-2">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <MonoLabel size="xs" tone="muted" className="shrink-0">
            {open.mode === "edit" ? "Edit" : "Preview"}
          </MonoLabel>
          <span aria-hidden className="h-3.5 w-px shrink-0 bg-[var(--kn-border)]" />
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]" title={open.path}>
            {baseName(open.path)}
          </MonoText>
        </span>

        {content.data && (
          <>
            <ByteSize bytes={content.data.size} className="text-xs text-[var(--kn-text-3)]" />
            {content.data.mime && (
              <MonoText muted className="hidden text-xs md:inline">
                {content.data.mime}
              </MonoText>
            )}
          </>
        )}
        {truncated && (
          <Badge
            tone="warn"
            size="xs"
            title="Only the first megabyte was read, so saving would truncate the file."
          >
            truncated
          </Badge>
        )}
        {readOnly && !truncated && !binary && (
          <Badge tone="neutral" size="xs">
            read-only
          </Badge>
        )}
        {binary && !image && (
          <Badge
            tone="neutral"
            size="xs"
            title="Kaname read this file as binary, so it cannot be edited or saved here."
          >
            binary
          </Badge>
        )}
        {dirty && (
          <Badge tone="accent" size="xs">
            unsaved
          </Badge>
        )}

        <CopyButton value={open.path} label="Copy path" size="xs" />
        {open.mode === "edit" && !image && (
          <IconButton
            icon={WrapText}
            label={wrap ? "Disable line wrapping" : "Wrap long lines"}
            size="xs"
            aria-pressed={wrap}
            className={cn(wrap && "bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]")}
            onClick={() => setWrap((current) => !current)}
          />
        )}
        <Button variant="ghost" size="xs" icon={FolderInput} onClick={onReveal}>
          Show in folder
        </Button>
        <a
          href={downloadUrl(serverId, open.path)}
          className="inline-flex h-6 items-center gap-1 rounded-[var(--kn-r-pill)] border border-transparent px-2.5 text-xs text-[var(--kn-text-2)] outline-none transition-colors duration-[var(--kn-dur-fast)] hover:bg-[var(--kn-neutral-soft)] hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
        >
          <Download size={12} aria-hidden />
          Download
        </a>
        {/* No Save at all for binary content, rather than a disabled one
            that never says why: the pane below explains it instead. */}
        {open.mode === "edit" && !image && !binary && (
          <Button
            variant="primary"
            size="xs"
            icon={Save}
            disabled={!dirty || readOnly}
            loading={write.isPending}
            onClick={save}
          >
            Save
          </Button>
        )}
        <IconButton icon={X} label="Close file" size="xs" onClick={close} />
      </div>

      {/* The save is a direct streamed upload, not a job, so its failure has
          no job pill to land on and is shown here, next to the draft that
          is still unsaved. */}
      {write.isError && (
        <InlineError
          className="border-b border-[var(--kn-border)] px-3 py-1.5"
          message={`Not saved: ${write.error.message}`}
        />
      )}

      {content.isError && (
        <div className="p-4">
          <PageError
            error={content.error}
            onRetry={() => void content.refetch()}
            context={open.path}
          />
        </div>
      )}

      {content.isLoading && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <Skeleton className="h-3 w-2/3" label="Reading the file" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      )}

      {content.data && image && (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--kn-bg-inset)] p-4">
          {/* A data URI the control plane just handed us: there is no URL
              for next/image to optimise, and no second request to make. */}
          <img
            src={dataUri(content.data.mime, content.data.encoding, content.data.content, open.path)}
            alt={baseName(open.path)}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}

      {content.data && !image && content.data.encoding === "base64" && (
        <EmptyState
          icon={Download}
          title="This file is not text"
          description="Kaname read it as binary despite its name, so there is nothing to edit or save here: writing text back would replace its bytes. Download it to inspect it."
          action={
            <a
              href={downloadUrl(serverId, open.path)}
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--kn-r-pill)] border border-[var(--kn-accent-500)] bg-[var(--kn-accent-500)] px-3 text-sm font-medium text-[var(--kn-accent-fg)] outline-none hover:bg-[var(--kn-accent-600)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
            >
              <Download size={14} aria-hidden />
              Download
            </a>
          }
        />
      )}

      {content.data && !image && content.data.encoding === "utf8" && draft !== null && (
        <FileEditor
          path={open.path}
          value={draft}
          onChange={setDraft}
          onSave={save}
          readOnly={readOnly}
          wrap={wrap}
        />
      )}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard unsaved changes?"
        description={`${baseName(open.path)} has edits that were never written to the host.`}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </section>
  );
}

function dataUri(
  mime: string | null,
  encoding: "utf8" | "base64",
  content: string,
  path: string,
): string {
  const type = mime ?? (path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/*");
  if (encoding === "base64") return `data:${type};base64,${content}`;
  return `data:${type};utf8,${encodeURIComponent(content)}`;
}
