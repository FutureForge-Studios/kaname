"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Boxes, FolderOpen, HardDrive, Layers, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { DiskUsage, StorageBreakdown, StorageLargestEntry } from "@kaname/contract";
import {
  BarChart,
  Button,
  ByteSize,
  DataTable,
  DropdownMenu,
  EmptyState,
  FormField,
  Input,
  MenuItem,
  MetricTile,
  MonoText,
  PageHeader,
  Progress,
  RelativeTime,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  cn,
  type DataTableColumn,
  type SortState,
  type Tone,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { formatBytes, formatCount, formatPercent, percentOf } from "@/lib/format";
import { FormDialog } from "../../_components/FormDialog";
import { JobActivityBar } from "../../_components/JobActivity";
import { usageTone } from "../../_components/cells";
import { useStorageBreakdown, useStorageSample } from "../_components/queries";

/* ------------------------------------------------------------------ *
 * Storage.
 *
 * Walking a filesystem costs real IO on a live host, so this page never
 * does it on a page view (KD-012): it serves the last sample and says
 * how old it is. That staleness is stated rather than hidden, because
 * the alternative — a page that silently re-walks a 4 TB disk every time
 * someone opens it — is how a panel becomes the reason a host is slow.
 *
 * Percentages are shares of what is *used*, not of the device: "mail is
 * 40% of your disk" and "mail is 40% of what you have spent" are
 * different claims, and only the second one is true here.
 * ------------------------------------------------------------------ */

const STORAGE_JOB_TYPES = ["fs.usage"] as const;
/** ext4 refuses new files at 100% inodes even with free bytes; warn early. */
const INODE_WARN_PERCENT = 85;
const LARGEST_PER_PAGE = 25;

export default function StoragePage() {
  const router = useRouter();
  const selection = useServerSelection({ permission: "files.manager:read", required: true });
  const serverId = selection.serverId;

  const query = useStorageBreakdown(serverId);
  const sample = useStorageSample();
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const takeSample = React.useCallback(
    (path: string, depth: number) => {
      if (!serverId || !selection.server) return;
      sample.mutate({ serverId, serverName: selection.server.name, path, depth });
    },
    [sample, selection.server, serverId],
  );

  const breakdown = query.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Storage"
        subtitle={selection.server?.hostname}
        actions={
          <>
            <DropdownMenu
              placement="bottom-end"
              label="Sampling options"
              trigger={
                <Button variant="secondary" size="sm" icon={SlidersHorizontal}>
                  Options
                </Button>
              }
            >
              <MenuItem onSelect={() => setAdvancedOpen(true)}>Sample a subtree…</MenuItem>
              <MenuItem onSelect={() => void query.refetch()}>Re-read the last sample</MenuItem>
            </DropdownMenu>
            <Button
              variant="primary"
              size="sm"
              icon={RefreshCw}
              disabled={!serverId || sample.isPending}
              loading={sample.isPending}
              onClick={() => takeSample("/", 2)}
            >
              Take a sample
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} />
          {breakdown && (
            <span className="flex items-center gap-1 text-xs text-[var(--kn-text-3)]">
              sampled <RelativeTime value={breakdown.sampled_at} />
            </span>
          )}
        </div>

        <JobActivityBar types={STORAGE_JOB_TYPES} title="Sampling" />

        {!serverId && !selection.isLoading && (
          <SectionCard>
            <EmptyState
              icon={HardDrive}
              title="No host in scope"
              description="Storage is reported per server, and this account can read none of them."
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
        )}

        {query.isError && (
          <PageError
            error={query.error}
            onRetry={() => void query.refetch()}
            onAction={(action) => {
              if (action.action === "storage.sample") takeSample("/", 2);
            }}
            context={selection.server?.name}
          />
        )}

        {query.isLoading && serverId && <StorageSkeleton />}

        {breakdown && (
          <>
            <Rollup breakdown={breakdown} />
            <InodePressure mounts={breakdown.mounts} />
            <Mounts mounts={breakdown.mounts} />
            <Categories breakdown={breakdown} />
            <Largest entries={breakdown.largest} />
          </>
        )}
      </div>

      {advancedOpen && (
        <SampleDialog
          submitting={sample.isPending}
          error={sample.error}
          onClose={() => setAdvancedOpen(false)}
          onSubmit={(path, depth) => {
            takeSample(path, depth);
            setAdvancedOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rollup
 * ------------------------------------------------------------------ */

function Rollup({ breakdown }: { breakdown: StorageBreakdown }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <MetricTile
        size="sm"
        icon={HardDrive}
        label="Capacity"
        value={formatBytes(breakdown.total, "binary", 0)}
      />
      <MetricTile
        size="sm"
        icon={Layers}
        label="Used"
        value={formatPercent(breakdown.used_percent)}
        unit={`of ${formatBytes(breakdown.total, "binary", 0)}`}
        tone={usageTone(breakdown.used_percent)}
      />
      <MetricTile
        size="sm"
        icon={Boxes}
        label="Available"
        value={formatBytes(breakdown.available, "binary", 0)}
      />
      <MetricTile
        size="sm"
        icon={FolderOpen}
        label="Mounts"
        value={formatCount(breakdown.mounts.length)}
      />
    </div>
  );
}

function StorageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton
            key={index}
            className="h-16 rounded-[var(--kn-r-md)]"
            label={index === 0 ? "Loading the storage sample" : undefined}
          />
        ))}
      </div>
      <div className="overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]">
        <div className="h-9 border-b border-[var(--kn-border)]" />
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex h-[var(--kn-row-h)] items-center gap-3 border-b border-[var(--kn-border-subtle)] px-3 last:border-b-0"
          >
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="ml-auto h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Inodes
 * ------------------------------------------------------------------ */

function inodePercent(mount: DiskUsage): number | null {
  if (!mount.inodes_total || mount.inodes_used === undefined) return null;
  return percentOf(mount.inodes_used, mount.inodes_total);
}

/**
 * The failure this warns about does not look like a disk problem from
 * the application side: writes start failing with ENOSPC while `df` says
 * there is room, because what ran out was the inode table.
 */
function InodePressure({ mounts }: { mounts: readonly DiskUsage[] }) {
  const pressured = mounts.filter((mount) => {
    const percent = inodePercent(mount);
    return percent !== null && percent >= INODE_WARN_PERCENT;
  });

  if (pressured.length === 0) return null;

  return (
    <div
      role="alert"
      className="rounded-[var(--kn-r-md)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] px-4 py-3"
    >
      <p className="font-medium text-[var(--kn-warn)]">
        {pressured.length === 1
          ? "One filesystem is running out of inodes"
          : `${pressured.length} filesystems are running out of inodes`}
      </p>
      <p className="mt-1 text-[var(--kn-text-2)]">
        A filesystem with no inodes left refuses to create files even while it reports free space,
        and the error the application sees is “no space left on device”. It is almost always a
        directory full of tiny files — a mail spool, a session store, a cache that never prunes.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {pressured.map((mount) => (
          <li key={mount.mount} className="flex items-center gap-2 text-sm">
            <MonoText className="text-[var(--kn-text)]">{mount.mount}</MonoText>
            <span className="kn-num text-[var(--kn-warn)]">
              {formatPercent(inodePercent(mount) ?? 0)} of {formatCount(mount.inodes_total ?? 0)}{" "}
              inodes
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Mounts
 * ------------------------------------------------------------------ */

function Mounts({ mounts }: { mounts: readonly DiskUsage[] }) {
  const columns = React.useMemo<DataTableColumn<DiskUsage>[]>(
    () => [
      {
        id: "mount",
        header: "Mount",
        locked: true,
        mono: true,
        minWidth: 160,
        cell: (mount) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {mount.mount}
          </MonoText>
        ),
      },
      {
        id: "device",
        header: "Device",
        mono: true,
        minWidth: 140,
        hideBelow: "md",
        cell: (mount) => (
          <MonoText muted truncate className="min-w-0">
            {mount.device}
          </MonoText>
        ),
      },
      {
        id: "fstype",
        header: "Type",
        width: 88,
        mono: true,
        hideBelow: "lg",
        accessor: (mount) => mount.fstype,
      },
      {
        id: "total",
        header: "Size",
        width: 96,
        align: "right",
        cell: (mount) => <ByteSize bytes={mount.total} />,
      },
      {
        id: "available",
        header: "Free",
        width: 96,
        align: "right",
        cell: (mount) => <ByteSize bytes={mount.available} />,
      },
      {
        id: "used_percent",
        header: "Used",
        width: 176,
        cell: (mount) => (
          <div className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-2 text-sm">
              <ByteSize bytes={mount.used} />
              <span className={cn("kn-num", toneClass(usageTone(mount.used_percent)))}>
                {formatPercent(mount.used_percent)}
              </span>
            </span>
            <Progress
              value={mount.used_percent}
              tone={usageTone(mount.used_percent)}
              size="xs"
              label={`${mount.mount} used`}
              className="rounded-[var(--kn-r-xs)]"
            />
          </div>
        ),
      },
      {
        id: "inodes",
        header: "Inodes",
        width: 120,
        align: "right",
        hideBelow: "lg",
        cell: (mount) => {
          const percent = inodePercent(mount);
          if (percent === null) return <span className="text-[var(--kn-text-3)]">—</span>;
          return (
            <span
              className={cn("kn-num", percent >= INODE_WARN_PERCENT && "text-[var(--kn-warn)]")}
              title={`${formatCount(mount.inodes_used ?? 0)} of ${formatCount(mount.inodes_total ?? 0)}`}
            >
              {formatPercent(percent)}
            </span>
          );
        },
      },
    ],
    [],
  );

  return (
    <SectionCard title="Mounts" icon={HardDrive} padded={false}>
      <DataTable<DiskUsage>
        columns={columns}
        rows={mounts}
        getRowId={(mount) => mount.mount}
        label="Mounted filesystems"
        density="default"
        columnVisibility={false}
        empty={
          <EmptyState
            icon={HardDrive}
            title="No mounts reported"
            description="The sample carried no filesystem list."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

function toneClass(tone: Tone): string {
  if (tone === "danger") return "text-[var(--kn-danger)]";
  if (tone === "warn") return "text-[var(--kn-warn)]";
  return "text-[var(--kn-text-2)]";
}

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

function Categories({ breakdown }: { breakdown: StorageBreakdown }) {
  const categories = [...breakdown.categories].sort((a, b) => b.bytes - a.bytes);

  return (
    <SectionCard
      title="What the space is spent on"
      icon={Layers}
      description={`Shares of the ${formatBytes(breakdown.used, "binary", 0)} in use, not of the device.`}
    >
      {categories.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No category breakdown"
          description="The agent classified nothing on this host — take a fresh sample to build one."
          size="sm"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <BarChart
            title="Storage by category"
            description="Bytes per category, largest first."
            orientation="horizontal"
            height={Math.max(140, categories.length * 28 + 32)}
            categories={categories.map((category) => category.label)}
            series={[
              { id: "bytes", label: "Bytes", values: categories.map((category) => category.bytes) },
            ]}
            formatValue={(value) => formatBytes(value, "binary", 0)}
            showLegend={false}
          />

          <ul className="flex flex-col">
            {categories.map((category) => (
              <li
                key={`${category.kind}-${category.path}`}
                className="flex items-baseline gap-3 border-b border-[var(--kn-border-subtle)] py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[var(--kn-text)]">{category.label}</span>
                  <MonoText muted truncate className="block min-w-0 text-xs">
                    {category.path}
                  </MonoText>
                </span>
                <ByteSize bytes={category.bytes} className="shrink-0" />
                <span className="kn-num w-12 shrink-0 text-right text-xs text-[var(--kn-text-3)]">
                  {formatPercent(category.percent)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * Largest directories
 * ------------------------------------------------------------------ */

function Largest({ entries }: { entries: readonly StorageLargestEntry[] }) {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<SortState | null>({ id: "bytes", order: "desc" });
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    setPage(1);
  }, [search]);

  const filtered = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? entries.filter((entry) => entry.path.toLowerCase().includes(needle))
      : [...entries];
    if (!sort) return matched;
    const direction = sort.order === "asc" ? 1 : -1;
    return matched.sort((a, b) => {
      if (sort.id === "path") return a.path.localeCompare(b.path) * direction;
      if (sort.id === "modified_at") {
        return (Date.parse(a.modified_at) - Date.parse(b.modified_at)) * direction;
      }
      return (a.bytes - b.bytes) * direction;
    });
  }, [entries, search, sort]);

  const rows = filtered.slice((page - 1) * LARGEST_PER_PAGE, page * LARGEST_PER_PAGE);

  const columns = React.useMemo<DataTableColumn<StorageLargestEntry>[]>(
    () => [
      {
        id: "path",
        header: "Path",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 280,
        cell: (entry) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]" title={entry.path}>
            {entry.path}
          </MonoText>
        ),
      },
      {
        id: "kind",
        header: "Kind",
        width: 96,
        hideBelow: "md",
        accessor: (entry) => entry.kind,
      },
      {
        id: "bytes",
        header: "Size",
        sortable: true,
        width: 112,
        align: "right",
        cell: (entry) => <ByteSize bytes={entry.bytes} />,
      },
      {
        id: "modified_at",
        header: "Modified",
        sortable: true,
        width: 112,
        align: "right",
        cell: (entry) => <RelativeTime value={entry.modified_at} />,
      },
    ],
    [],
  );

  return (
    <SectionCard title="Largest directories" icon={FolderOpen} padded={false}>
      <DataTable<StorageLargestEntry>
        columns={columns}
        rows={rows}
        getRowId={(entry) => entry.path}
        label="Largest directories"
        density="compact"
        columnVisibility={false}
        sort={sort}
        onSortChange={setSort}
        page={page}
        perPage={LARGEST_PER_PAGE}
        total={filtered.length}
        onPageChange={setPage}
        toolbar={
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch("")}
            placeholder="Filter paths"
            aria-label="Filter largest directories"
            size="sm"
            className="w-56"
          />
        }
        empty={
          <EmptyState
            icon={FolderOpen}
            title={search ? "No matching paths" : "Nothing measured yet"}
            description={
              search
                ? "No sampled directory contains that."
                : "The last sample recorded no directory sizes. Take one at a greater depth."
            }
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * Subtree sampling
 * ------------------------------------------------------------------ */

function SampleDialog({
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  submitting: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (path: string, depth: number) => void;
}) {
  const [path, setPath] = React.useState("/");
  const [depth, setDepth] = React.useState("2");

  const valid = path.startsWith("/") && !path.split("/").includes("..");

  return (
    <FormDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Sample a subtree"
      description="Walking a filesystem is expensive. Pointing the walk at one directory keeps the cost proportional to what you actually want to know."
      submitLabel="Take sample"
      submitting={submitting}
      canSubmit={valid}
      error={error}
      onSubmit={() => onSubmit(path.trim(), Number.parseInt(depth, 10))}
      size="sm"
    >
      <FormField
        label="Start at"
        required
        error={valid ? undefined : "Give an absolute path with no traversal segments."}
      >
        <Input
          mono
          data-autofocus=""
          value={path}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPath(event.target.value)}
          placeholder="/var/www"
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField
        label="Depth"
        description="How many directory levels the walk descends before it stops counting separately."
      >
        <Select
          value={depth}
          onChange={(event) => setDepth(event.target.value)}
          options={[
            { value: "1", label: "1 — immediate children only" },
            { value: "2", label: "2 — children and grandchildren" },
            { value: "3", label: "3 levels" },
            { value: "4", label: "4 levels — slowest" },
          ]}
        />
      </FormField>
    </FormDialog>
  );
}
