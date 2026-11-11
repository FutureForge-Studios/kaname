"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUpCircle, PackageCheck, ShieldAlert } from "lucide-react";
import type { ServerOsUpdatesSummary } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  RelativeTime,
  SectionCard,
  Skeleton,
  StatusLine,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCan } from "@/lib/queries";
import { formatCount } from "@/lib/format";
import { useBulkUpgradeOsPackages, useOsUpdatesFleet } from "@/lib/system-updates";

/* ------------------------------------------------------------------ *
 * System updates across the fleet.
 *
 * The hosts' own package updates, next to Kaname's: which servers have
 * something waiting, how much of it is security, which still need the
 * reboot their last upgrade asked for. Everything here is the cached
 * list each host last reported — a fleet-wide apt run on page load is
 * exactly what this section must never do. Rows open the server's
 * System updates tab, where the packages are listed one by one.
 * ------------------------------------------------------------------ */

type Pending = { ids: string[]; securityOnly: boolean } | null;

function needsLook(row: ServerOsUpdatesSummary): boolean {
  return row.total > 0 || row.reboot_required || row.state === "error";
}

export function SystemUpdatesSection({ index }: { index: number }) {
  const router = useRouter();
  const can = useCan();
  const fleet = useOsUpdatesFleet();
  const upgrade = useBulkUpgradeOsPackages();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState<Pending>(null);
  const write = can("infra.servers:write");

  const rows = React.useMemo(
    () =>
      (fleet.data?.servers ?? [])
        .filter(needsLook)
        .sort((a, b) => b.security - a.security || b.total - a.total || a.server_name.localeCompare(b.server_name)),
    [fleet.data],
  );

  const columns: DataTableColumn<ServerOsUpdatesSummary>[] = [
    {
      id: "server",
      header: "Server",
      minWidth: 200,
      cell: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[var(--kn-text)]">{row.server_name}</span>
          <span className="truncate font-mono text-xs text-[var(--kn-text-3)]">{row.hostname}</span>
        </div>
      ),
    },
    {
      id: "pending",
      header: "Pending",
      width: 96,
      align: "right",
      cell: (row) => <span className="kn-num">{formatCount(row.total)}</span>,
    },
    {
      id: "security",
      header: "Security",
      width: 104,
      align: "right",
      cell: (row) =>
        row.security > 0 ? (
          <Badge tone="warn" size="xs">
            {formatCount(row.security)} security
          </Badge>
        ) : (
          <span className="text-[var(--kn-text-3)]">—</span>
        ),
    },
    {
      id: "state",
      header: "State",
      width: 150,
      cell: (row) =>
        row.reboot_required ? (
          <Badge tone="warn" size="xs">
            reboot required
          </Badge>
        ) : row.state === "error" ? (
          <Badge tone="danger" size="xs">
            check failed
          </Badge>
        ) : row.auto_security ? (
          <Badge tone="info" size="xs">
            auto security
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            manual
          </Badge>
        ),
    },
    {
      id: "checked",
      header: "Checked",
      width: 120,
      hideBelow: "md",
      cell: (row) =>
        row.checked_at ? (
          <RelativeTime value={row.checked_at} />
        ) : (
          <span className="text-[var(--kn-text-3)]">never</span>
        ),
    },
  ];

  const totals = fleet.data?.totals;
  const targetRows = rows.filter((r) => pending?.ids.includes(r.server_id));
  const targetCount = pending?.securityOnly
    ? targetRows.reduce((n, r) => n + r.security, 0)
    : targetRows.reduce((n, r) => n + r.total, 0);

  return (
    <SectionCard
      id="system-updates"
      index={index}
      title="System updates"
      description="Operating-system packages on each host, as its package manager last reported them."
      className="scroll-mt-6"
    >
      {fleet.isLoading && <Skeleton className="h-40" label="Loading system updates" />}
      {fleet.isError && (
        <PageError error={fleet.error} onRetry={() => void fleet.refetch()} context="System updates" />
      )}

      {totals && (
        <div className="flex flex-col gap-3">
          <StatusLine
            tone={
              totals.servers_with_security_updates > 0
                ? "warn"
                : totals.servers_with_updates > 0
                  ? "info"
                  : "ok"
            }
          >
            {totals.servers_with_updates === 0
              ? `Every checked server is up to date`
              : `${formatCount(totals.packages)} ${totals.packages === 1 ? "update" : "updates"} on ${formatCount(totals.servers_with_updates)} of ${formatCount(totals.servers)} servers`}
            {totals.security > 0 && (
              <span className="text-[var(--kn-warn)]"> · {formatCount(totals.security)} security</span>
            )}
            {totals.reboot_required > 0 && ` · ${formatCount(totals.reboot_required)} need a reboot`}
            {totals.unchecked > 0 && (
              <span className="text-[var(--kn-text-3)]">
                {" "}
                · {formatCount(totals.unchecked)} not checked yet
              </span>
            )}
          </StatusLine>

          <DataTable<ServerOsUpdatesSummary>
            label="Servers with system updates"
            columns={columns}
            rows={rows}
            getRowId={(row) => row.server_id}
            density="compact"
            columnVisibility={false}
            selectedIds={write ? selected : undefined}
            onSelectionChange={write ? setSelected : undefined}
            isRowSelectable={(row) => row.connection === "connected" && row.total > 0}
            onRowClick={(row) => router.push(`/infrastructure/servers/${row.server_id}?tab=updates`)}
            bulkActions={(ids) => {
              const chosen = rows.filter((r) => ids.includes(r.server_id));
              const security = chosen.some((r) => r.security > 0);
              return (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="xs"
                    icon={ShieldAlert}
                    disabled={!security}
                    onClick={() => setPending({ ids, securityOnly: true })}
                  >
                    Security only
                  </Button>
                  <Button
                    variant="primary"
                    size="xs"
                    icon={ArrowUpCircle}
                    loading={upgrade.isPending}
                    onClick={() => setPending({ ids, securityOnly: false })}
                  >
                    Upgrade {ids.length} {ids.length === 1 ? "server" : "servers"}
                  </Button>
                </div>
              );
            }}
            empty={
              <EmptyState
                icon={PackageCheck}
                title="Nothing waiting"
                description="Servers appear here once their package manager reports an update or a pending reboot."
                size="sm"
              />
            }
          />
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.securityOnly
            ? `Apply security updates on ${pending.ids.length} ${pending.ids.length === 1 ? "server" : "servers"}`
            : `Upgrade packages on ${pending?.ids.length ?? 0} ${pending?.ids.length === 1 ? "server" : "servers"}`
        }
        confirmLabel={pending?.securityOnly ? "Apply security updates" : "Upgrade all"}
        destructive={false}
        loading={upgrade.isPending}
        onConfirm={() => {
          if (!pending) return;
          upgrade.mutate({ serverIds: pending.ids, securityOnly: pending.securityOnly });
          setPending(null);
          setSelected([]);
        }}
      >
        <div className="flex flex-col gap-2 text-[var(--kn-text-2)]">
          <p>
            {formatCount(targetCount)} {pending?.securityOnly ? "security " : ""}
            {targetCount === 1 ? "package" : "packages"} across{" "}
            {targetRows.map((r) => r.server_name).join(", ")}. One job per server, each with its own
            output in the job drawer.
          </p>
          <p>
            Services whose packages change may restart. Servers that need a reboot afterwards are
            marked — none is rebooted for you.
          </p>
        </div>
      </ConfirmDialog>
    </SectionCard>
  );
}
