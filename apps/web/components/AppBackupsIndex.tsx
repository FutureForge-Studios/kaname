"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { AppInstall } from "@kaname/contract";
import { DataTable, EmptyState, PageBody, PageHeader, RelativeTime, type DataTableColumn } from "@kaname/ui";
import { useList } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Backups, as a reseller or client sees them (KD-043). The operator's
 * schedules, destinations and repositories are not theirs to see; what
 * is theirs is each app they installed, whose page carries its own
 * backups and restore points. So this lists those apps and sends each
 * row there.
 * ------------------------------------------------------------------ */

const columns: readonly DataTableColumn<AppInstall>[] = [
  { id: "domain", header: "App", mono: true, locked: true, accessor: (row) => row.domain },
  { id: "app", header: "Kind", accessor: (row) => `${row.app_name} ${row.app_version}` },
  { id: "server", header: "Server", mono: true, hideBelow: "md", accessor: (row) => row.server_name },
  { id: "updated", header: "Changed", hideBelow: "md", cell: (row) => <RelativeTime value={row.updated_at} /> },
];

export function AppBackupsIndex() {
  const router = useRouter();
  const installs = useList<AppInstall>("apps/installs", { per_page: 100, status: "active" });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Backups"
        title="Your apps' backups"
        subtitle="Open an app to back it up now, or to restore it from one of its restore points."
      />
      <PageBody>
        <DataTable<AppInstall>
          label="Apps with backups"
          columnVisibility={false}
          loading={installs.isLoading}
          rows={installs.data?.data ?? []}
          getRowId={(row) => row.id}
          columns={columns}
          onRowClick={(row) => router.push(`/apps/installs/${row.id}`)}
          empty={<EmptyState title="No apps yet" description="Apps you install appear here with their backups." />}
        />
      </PageBody>
    </div>
  );
}
