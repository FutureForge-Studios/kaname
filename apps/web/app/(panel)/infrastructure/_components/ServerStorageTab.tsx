"use client";

import * as React from "react";
import { HardDrive } from "lucide-react";
import type { DiskUsage, Server, StorageCategory, StorageLargestEntry } from "@kaname/contract";
import {
  Button,
  ByteSize,
  DataTable,
  EmptyState,
  MetricTile,
  Progress,
  RelativeTime,
  SectionCard,
  Skeleton,
  cn,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCan } from "@/lib/queries";
import { formatPercent } from "@/lib/format";
import { HostSync } from "./HostSync";
import { usageTone, useStorage, useStorageSample } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Storage.
 *
 * Walking a filesystem costs real IO on a live host, so the panel never
 * does it on a page view: it shows the last sample, says how old it is,
 * and makes a fresh walk an explicit job (KD-012). A host that has
 * never been sampled says exactly that instead of showing zeroes.
 * ------------------------------------------------------------------ */

const USAGE_TEXT: Record<string, string> = {
  danger: "text-[var(--kn-danger)]",
  warn: "text-[var(--kn-warn)]",
  neutral: "",
};

export function ServerStorageTab({ server }: { server: Server }) {
  const can = useCan();
  const storage = useStorage(server.id);
  const sample = useStorageSample();

  const allowed = can("files.manager:read", server.id);
  const takeSample = () => sample.mutate({ serverId: server.id, serverName: server.name });

  const mountColumns = React.useMemo<DataTableColumn<DiskUsage>[]>(
    () => [
      {
        id: "mount",
        header: "Mount",
        mono: true,
        locked: true,
        minWidth: 160,
        accessor: (d) => d.mount,
      },
      {
        id: "device",
        header: "Device",
        mono: true,
        minWidth: 140,
        hideBelow: "md",
        accessor: (d) => d.device,
      },
      {
        id: "fstype",
        header: "Type",
        mono: true,
        width: 96,
        hideBelow: "lg",
        accessor: (d) => d.fstype,
      },
      {
        id: "used",
        header: "Used",
        width: 104,
        align: "right",
        cell: (d) => <ByteSize bytes={d.used} />,
      },
      {
        id: "available",
        header: "Available",
        width: 104,
        align: "right",
        hideBelow: "md",
        cell: (d) => <ByteSize bytes={d.available} />,
      },
      {
        id: "total",
        header: "Size",
        width: 104,
        align: "right",
        hideBelow: "md",
        cell: (d) => <ByteSize bytes={d.total} />,
      },
      {
        id: "used_percent",
        header: "Full",
        width: 128,
        align: "right",
        cell: (d) => (
          <span className="flex items-center justify-end gap-2">
            <Progress
              value={d.used_percent}
              tone={usageTone(d.used_percent)}
              label={`${d.mount} usage`}
              className="w-16"
            />
            <span className={cn("kn-num", USAGE_TEXT[usageTone(d.used_percent)])}>
              {formatPercent(d.used_percent)}
            </span>
          </span>
        ),
      },
    ],
    [],
  );

  const largestColumns = React.useMemo<DataTableColumn<StorageLargestEntry>[]>(
    () => [
      {
        id: "path",
        header: "Path",
        mono: true,
        locked: true,
        minWidth: 260,
        accessor: (e) => e.path,
      },
      { id: "kind", header: "Kind", width: 104, hideBelow: "md", accessor: (e) => e.kind },
      {
        id: "modified_at",
        header: "Modified",
        width: 120,
        align: "right",
        hideBelow: "md",
        cell: (e) => <RelativeTime value={e.modified_at} />,
      },
      {
        id: "bytes",
        header: "Size",
        width: 108,
        align: "right",
        cell: (e) => <ByteSize bytes={e.bytes} />,
      },
    ],
    [],
  );

  if (storage.isLoading) {
    return <Skeleton className="h-64" label="Loading storage" />;
  }

  const error = storage.error;
  if (error) {
    // A host that has never been walked answers 404 with a remediation;
    // that is an empty state, not a failure.
    const missing = error.status === 404;
    return missing ? (
      <EmptyState
        icon={HardDrive}
        title="Storage has never been sampled"
        description="Walking a filesystem is expensive, so it only runs when asked. The breakdown appears here when the job finishes."
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={!allowed || server.connection !== "connected"}
            loading={sample.isPending}
            onClick={takeSample}
          >
            Take a sample
          </Button>
        }
      />
    ) : (
      <PageError
        error={error}
        onRetry={() => void storage.refetch()}
        onAction={(action) => {
          if (action.action === "storage.sample") takeSample();
        }}
        context="Storage"
      />
    );
  }

  const breakdown = storage.data;
  if (!breakdown) return null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <HostSync
        syncedAt={breakdown.sampled_at}
        server={server}
        noun="storage figures"
        canSync={allowed}
        pending={sample.isPending}
        onSync={takeSample}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          size="sm"
          icon={HardDrive}
          label="Used"
          value={formatPercent(breakdown.used_percent)}
          tone={usageTone(breakdown.used_percent)}
        />
        <MetricTile size="sm" label="Consumed" value={<ByteSize bytes={breakdown.used} />} />
        <MetricTile size="sm" label="Available" value={<ByteSize bytes={breakdown.available} />} />
        <MetricTile size="sm" label="Capacity" value={<ByteSize bytes={breakdown.total} />} />
      </div>

      <SectionCard title="Mounts" padded={false}>
        <DataTable<DiskUsage>
          columns={mountColumns}
          rows={breakdown.mounts}
          getRowId={(mount) => mount.mount}
          label={`Mounts on ${server.name}`}
          density="compact"
          columnVisibility={false}
          empty={<EmptyState icon={HardDrive} title="No mounts reported" size="sm" />}
          className="rounded-none border-0"
        />
      </SectionCard>

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard
          title="Where it went"
          description="Shares of what is consumed, not of the whole device."
        >
          {breakdown.categories.length === 0 ? (
            <p className="text-[var(--kn-text-3)]">The sample carried no category breakdown.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {breakdown.categories.map((category) => (
                <CategoryRow key={`${category.kind}-${category.path}`} category={category} />
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Largest entries" padded={false}>
          <DataTable<StorageLargestEntry>
            columns={largestColumns}
            rows={breakdown.largest}
            getRowId={(entry) => entry.path}
            label={`Largest entries on ${server.name}`}
            density="compact"
            columnVisibility={false}
            empty={<EmptyState icon={HardDrive} title="Nothing recorded" size="sm" />}
            className="rounded-none border-0"
          />
        </SectionCard>
      </div>
    </div>
  );
}

function CategoryRow({ category }: { category: StorageCategory }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-[var(--kn-text)]">{category.label}</span>
        <span className="kn-mono shrink-0 text-sm text-[var(--kn-text-3)]">{category.path}</span>
        <span className="kn-num shrink-0 text-[var(--kn-text-2)]">
          <ByteSize bytes={category.bytes} /> · {formatPercent(category.percent)}
        </span>
      </div>
      <Progress value={category.percent} tone="accent" label={`${category.label} share`} />
    </li>
  );
}
