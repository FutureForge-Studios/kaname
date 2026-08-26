"use client";

import * as React from "react";
import type { FileKind } from "@kaname/contract";
import {
  Check,
  ChevronRight,
  Copy,
  File as FileIcon,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { IconButton } from "./Button.js";
import { DropdownMenu, MenuItem } from "./DropdownMenu.js";

/* ------------------------------------------------------------------ *
 * FileTree — lazy directory tree, and PathBreadcrumb — the segmented
 * path that sits above it.
 *
 * The tree is rendered as a flat list with explicit aria-level rather
 * than nested groups: a deep home directory would otherwise put a few
 * thousand DOM nodes behind every expanded folder, and flattening keeps
 * roving-tabindex navigation to one array walk.
 * ------------------------------------------------------------------ */

export interface FileTreeNode {
  /** Absolute path. Doubles as the identity of the row. */
  path: string;
  name: string;
  kind: FileKind;
  size?: number;
  /** `undefined` means "not loaded yet"; an empty array means "empty directory". */
  children?: readonly FileTreeNode[];
}

export interface FileTreeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> {
  nodes: readonly FileTreeNode[];
  expandedPaths?: readonly string[];
  onExpandedChange?: (paths: string[]) => void;
  selectedPath?: string | null;
  onSelect?: (node: FileTreeNode) => void;
  /** Enter or double-click: open the file, or descend into the directory. */
  onActivate?: (node: FileTreeNode) => void;
  /** Called once per directory, the first time it expands. */
  onLoadChildren?: (node: FileTreeNode) => void | Promise<void>;
  label?: string;
  emptyLabel?: string;
}

interface FlatNode {
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  setSize: number;
  posInSet: number;
}

const INDENT = 12;

function flatten(
  nodes: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
  depth: number,
  out: FlatNode[],
): void {
  nodes.forEach((node, index) => {
    const isOpen = node.kind === "directory" && expanded.has(node.path);
    out.push({ node, depth, expanded: isOpen, setSize: nodes.length, posInSet: index + 1 });
    if (isOpen && node.children) flatten(node.children, expanded, depth + 1, out);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function nodeIcon(node: FileTreeNode, expanded: boolean) {
  if (node.kind === "directory") return expanded ? FolderOpen : Folder;
  if (node.kind === "symlink") return Link2;
  return FileIcon;
}

export const FileTree = React.forwardRef<HTMLDivElement, FileTreeProps>(function FileTree(
  {
    nodes,
    expandedPaths,
    onExpandedChange,
    selectedPath = null,
    onSelect,
    onActivate,
    onLoadChildren,
    label = "Files",
    emptyLabel = "This directory is empty",
    className,
    ...props
  },
  ref,
) {
  const [internalExpanded, setInternalExpanded] = React.useState<string[]>([]);
  const expandedList = expandedPaths ?? internalExpanded;
  const expanded = React.useMemo(() => new Set(expandedList), [expandedList]);
  const setExpanded = React.useCallback(
    (next: string[]) => {
      if (onExpandedChange) onExpandedChange(next);
      else setInternalExpanded(next);
    },
    [onExpandedChange],
  );

  const [loading, setLoading] = React.useState<ReadonlySet<string>>(() => new Set());
  const requested = React.useRef<Set<string>>(new Set());

  const flat = React.useMemo(() => {
    const out: FlatNode[] = [];
    flatten(nodes, expanded, 0, out);
    return out;
  }, [nodes, expanded]);

  const [focusIndex, setFocusIndex] = React.useState(0);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  React.useEffect(() => {
    if (focusIndex > flat.length - 1) setFocusIndex(Math.max(0, flat.length - 1));
  }, [flat.length, focusIndex]);

  const focusAt = React.useCallback((index: number) => {
    setFocusIndex(index);
    itemRefs.current[index]?.focus();
  }, []);

  const loadChildren = React.useCallback(
    (node: FileTreeNode) => {
      if (!onLoadChildren || node.children !== undefined || requested.current.has(node.path))
        return;
      requested.current.add(node.path);
      setLoading((prev) => new Set(prev).add(node.path));
      void Promise.resolve(onLoadChildren(node)).finally(() => {
        setLoading((prev) => {
          const draft = new Set(prev);
          draft.delete(node.path);
          return draft;
        });
      });
    },
    [onLoadChildren],
  );

  const setOpen = React.useCallback(
    (node: FileTreeNode, open: boolean) => {
      if (node.kind !== "directory") return;
      const draft = new Set(expanded);
      if (open) {
        draft.add(node.path);
        loadChildren(node);
      } else {
        draft.delete(node.path);
      }
      setExpanded([...draft]);
    },
    [expanded, loadChildren, setExpanded],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (flat.length === 0) return;
    const index = Math.min(focusIndex, flat.length - 1);
    const entry = flat[index];
    if (!entry) return;
    const { node, depth, expanded: isOpen } = entry;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(Math.min(index + 1, flat.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(Math.max(index - 1, 0));
        break;
      case "ArrowRight":
        event.preventDefault();
        if (node.kind === "directory" && !isOpen) setOpen(node, true);
        else if (isOpen && index + 1 < flat.length) focusAt(index + 1);
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (node.kind === "directory" && isOpen) {
          setOpen(node, false);
          break;
        }
        for (let i = index - 1; i >= 0; i -= 1) {
          if ((flat[i]?.depth ?? 0) < depth) {
            focusAt(i);
            break;
          }
        }
        break;
      }
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(flat.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        onSelect?.(node);
        if (node.kind === "directory") setOpen(node, !isOpen);
        onActivate?.(node);
        break;
      case " ":
        event.preventDefault();
        onSelect?.(node);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={ref}
      role="tree"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn("min-w-0 select-none py-1", className)}
      {...props}
    >
      {flat.length === 0 && (
        <p className="px-3 py-2 text-xs text-[var(--kn-text-3)]">{emptyLabel}</p>
      )}

      {flat.map((entry, index) => {
        const { node, depth, expanded: isOpen, setSize, posInSet } = entry;
        const Icon = nodeIcon(node, isOpen);
        const isDir = node.kind === "directory";
        const isSelected = selectedPath === node.path;
        const isLoading = loading.has(node.path);
        return (
          <div
            key={node.path}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            role="treeitem"
            aria-level={depth + 1}
            aria-setsize={setSize}
            aria-posinset={posInSet}
            aria-expanded={isDir ? isOpen : undefined}
            aria-selected={isSelected}
            tabIndex={index === focusIndex ? 0 : -1}
            title={node.path}
            style={{ paddingLeft: 8 + depth * INDENT }}
            onFocus={() => setFocusIndex(index)}
            onClick={() => {
              setFocusIndex(index);
              onSelect?.(node);
              if (isDir) setOpen(node, !isOpen);
            }}
            onDoubleClick={() => onActivate?.(node)}
            className={cn(
              "flex h-6 cursor-pointer items-center gap-1 rounded-[var(--kn-r-sm)] pr-2 outline-none",
              "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
              "hover:bg-[var(--kn-surface-2)]",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
              isSelected && "bg-[var(--kn-accent-soft)]",
            )}
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--kn-text-3)]">
              {isDir &&
                (isLoading ? (
                  <Loader2 size={12} className="animate-[var(--animate-spin-slow)]" aria-hidden />
                ) : (
                  <ChevronRight
                    size={12}
                    aria-hidden
                    className={cn(
                      "transition-transform duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)] motion-reduce:transition-none",
                      isOpen && "rotate-90",
                    )}
                  />
                ))}
            </span>

            <Icon
              size={14}
              aria-hidden
              className={cn(
                "shrink-0",
                isDir ? "text-[var(--kn-accent-400)]" : "text-[var(--kn-text-3)]",
              )}
            />

            <span
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-sm",
                isSelected ? "text-[var(--kn-text)]" : "text-[var(--kn-text-2)]",
              )}
            >
              {node.name}
            </span>

            {node.size !== undefined && !isDir && (
              <span className="tabular-nums shrink-0 font-mono text-2xs text-[var(--kn-text-3)]">
                {formatBytes(node.size)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
});

/* --------------------------- PathBreadcrumb -------------------------- */

export interface PathBreadcrumbProps extends React.HTMLAttributes<HTMLElement> {
  /** Absolute POSIX path, e.g. `/var/www/example.com/public`. */
  path: string;
  onNavigate?: (path: string) => void;
  rootLabel?: string;
  /** Segments kept visible before the middle collapses into a menu. */
  maxSegments?: number;
  copyable?: boolean;
  label?: string;
}

interface Segment {
  name: string;
  path: string;
}

export const PathBreadcrumb = React.forwardRef<HTMLElement, PathBreadcrumbProps>(
  function PathBreadcrumb(
    {
      path,
      onNavigate,
      rootLabel = "/",
      maxSegments = 4,
      copyable = true,
      label = "Path",
      className,
      ...props
    },
    ref,
  ) {
    const [copied, setCopied] = React.useState(false);

    const segments = React.useMemo<Segment[]>(() => {
      const parts = path.split("/").filter(Boolean);
      let cursor = "";
      return parts.map((name) => {
        cursor += `/${name}`;
        return { name, path: cursor };
      });
    }, [path]);

    const overflow = segments.length > maxSegments;
    const tailCount = Math.max(1, maxSegments - 1);
    const hidden = overflow ? segments.slice(0, segments.length - tailCount) : [];
    const visible = overflow ? segments.slice(segments.length - tailCount) : segments;

    const copy = () => {
      void navigator.clipboard?.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    };

    const segmentClass =
      "max-w-40 truncate rounded-[var(--kn-r-xs)] px-1 font-mono text-sm text-[var(--kn-text-2)] transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)] hover:bg-[var(--kn-surface-2)] hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]";

    return (
      <nav
        ref={ref}
        aria-label={label}
        className={cn("flex min-w-0 items-center gap-0.5", className)}
        {...props}
      >
        <ol className="flex min-w-0 items-center gap-0.5">
          <li className="shrink-0">
            <button type="button" onClick={() => onNavigate?.("/")} className={segmentClass}>
              {rootLabel}
            </button>
          </li>

          {overflow && (
            <li className="flex shrink-0 items-center gap-0.5">
              <DropdownMenu
                placement="bottom-start"
                label="Hidden path segments"
                trigger={
                  <IconButton icon={MoreHorizontal} label="Show hidden path segments" size="xs" />
                }
              >
                {hidden.map((segment) => (
                  <MenuItem key={segment.path} onSelect={() => onNavigate?.(segment.path)}>
                    <span className="font-mono">{segment.path}</span>
                  </MenuItem>
                ))}
              </DropdownMenu>
              <span aria-hidden className="font-mono text-sm text-[var(--kn-text-3)]">
                /
              </span>
            </li>
          )}

          {visible.map((segment, index) => {
            const isLast = index === visible.length - 1;
            return (
              <li key={segment.path} className="flex min-w-0 items-center gap-0.5">
                {isLast ? (
                  <span
                    aria-current="page"
                    className="min-w-0 truncate px-1 font-mono text-sm text-[var(--kn-text)]"
                  >
                    {segment.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onNavigate?.(segment.path)}
                    className={segmentClass}
                  >
                    {segment.name}
                  </button>
                )}
                {!isLast && (
                  <span aria-hidden className="font-mono text-sm text-[var(--kn-text-3)]">
                    /
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {copyable && (
          <IconButton
            icon={copied ? Check : Copy}
            label={copied ? "Path copied" : "Copy path"}
            size="xs"
            onClick={copy}
            className="ml-1 shrink-0"
          />
        )}
      </nav>
    );
  },
);
