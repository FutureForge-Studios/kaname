"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Globe, RotateCcw, Rocket, ScrollText } from "lucide-react";
import type { Deployment, DeploymentStatus, Site } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  Combobox,
  MonoText,
  RelativeTime,
  type ComboboxOption,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { formatDuration } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { DeployDialog } from "../_components/DeployDialog";
import { FilterSelect } from "../_components/filters";
import {
  useCancelDeployments,
  useDeployments,
  useRollbackDeployment,
  useSites,
} from "../_components/queries";
import {
  CommitCell,
  DEPLOYMENT_IN_FLIGHT,
  DeploymentStatusBadge,
  shortSha,
} from "../_components/status";

/* ------------------------------------------------------------------ *
 * Deployments.
 *
 * A history, read newest first, that answers "what is running and who
 * put it there". The commit is the identity — abbreviated object id in
 * mono, then the subject — with author, branch and duration as their
 * own columns rather than a second line, because a row is 36px and
 * a clipped line helps nobody.
 * ------------------------------------------------------------------ */

const STATUS_OPTIONS: { value: DeploymentStatus; label: string }[] = [
  { value: "queued", label: "Queued" },
  { value: "building", label: "Building" },
  { value: "deploying", label: "Deploying" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "rolled_back", label: "Rolled back" },
];

const SOURCE_OPTIONS = [
  { value: "git", label: "From git" },
  { value: "upload", label: "From upload" },
];

export default function DeploymentsPage() {
  const router = useRouter();
  const can = useCan();

  const selection = useServerSelection({ permission: "websites.deployments:read" });
  const extraParams = React.useMemo(
    () => ({ server_id: selection.serverId ?? undefined }),
    [selection.serverId],
  );

  const state = useResourceListState({
    defaultSort: { id: "created_at", order: "desc" },
    filterKeys: ["site_id", "status", "source"],
    extraParams,
  });
  const query = useDeployments(state.params);

  const siteId = state.filters["site_id"] ?? null;
  const sites = useSites({ per_page: 200, sort: "name", order: "asc" });
  const site = React.useMemo<Site | null>(
    () => sites.data?.data.find((row) => row.id === siteId) ?? null,
    [siteId, sites.data],
  );

  const rollback = useRollbackDeployment();
  const cancel = useCancelDeployments();

  const [deploying, setDeploying] = React.useState(false);
  const [redeploy, setRedeploy] = React.useState<Deployment | null>(null);
  const [pendingRollback, setPendingRollback] = React.useState<Deployment | null>(null);

  const columns = React.useMemo<DataTableColumn<Deployment>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        sortable: true,
        locked: true,
        width: 124,
        cell: (row) => <DeploymentStatusBadge status={row.status} />,
      },
      {
        id: "site",
        header: "Site",
        minWidth: 148,
        cell: (row) => (
          <Link
            href={`/websites/sites/${row.site_id}`}
            className="min-w-0 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
          >
            {row.site_name}
          </Link>
        ),
      },
      {
        id: "commit",
        header: "Commit",
        minWidth: 260,
        cell: (row) => <CommitCell sha={row.commit_sha} message={row.commit_message} />,
      },
      {
        id: "author",
        header: "Author",
        minWidth: 132,
        hideBelow: "lg",
        accessor: (row) => row.commit_author ?? "—",
      },
      {
        id: "branch",
        header: "Branch",
        sortable: true,
        width: 132,
        mono: true,
        hideBelow: "md",
        cell: (row) =>
          row.branch ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <MonoText truncate>{row.branch}</MonoText>
              {row.source === "upload" && (
                <Badge tone="neutral" size="xs">
                  upload
                </Badge>
              )}
            </span>
          ) : (
            <Badge tone="neutral" size="xs">
              upload
            </Badge>
          ),
      },
      {
        id: "duration_ms",
        header: "Duration",
        sortable: true,
        width: 100,
        align: "right",
        accessor: (row) => (row.duration_ms == null ? "—" : formatDuration(row.duration_ms)),
      },
      {
        id: "triggered",
        header: "Triggered by",
        minWidth: 140,
        hideBelow: "md",
        accessor: (row) => row.triggered_by_name ?? "Automation",
      },
      {
        id: "finished_at",
        header: "Finished",
        sortable: true,
        width: 116,
        align: "right",
        cell: (row) => <RelativeTime value={row.finished_at ?? row.created_at} />,
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (row: Deployment): DataTableRowAction<Deployment>[] => {
      const executable = can("websites.deployments:exec", null);
      const running = DEPLOYMENT_IN_FLIGHT.includes(row.status);
      return [
        {
          id: "open",
          label: "Open build log",
          icon: ScrollText,
          onSelect: () => router.push(`/websites/deployments/${row.id}`),
        },
        {
          id: "site",
          label: "Open the site",
          icon: Globe,
          onSelect: () => router.push(`/websites/sites/${row.site_id}`),
        },
        {
          id: "redeploy",
          label: "Deploy this revision again",
          icon: Rocket,
          disabled: !executable || row.commit_sha === null,
          onSelect: () => setRedeploy(row),
        },
        {
          id: "rollback",
          label: "Roll back to this release",
          icon: RotateCcw,
          disabled: !executable || row.status !== "succeeded",
          onSelect: () => setPendingRollback(row),
        },
        {
          id: "cancel",
          label: "Cancel this run",
          icon: Ban,
          destructive: true,
          separatorBefore: true,
          disabled: !executable || !running || row.job_id === null,
          onSelect: () =>
            row.job_id &&
            cancel.mutate([{ id: row.job_id, label: shortSha(row.commit_sha) ?? row.site_name }]),
        },
      ];
    },
    [can, cancel, router],
  );

  const siteOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (sites.data?.data ?? []).map((row) => ({
        value: row.id,
        label: row.name,
        description: row.primary_domain ?? row.server_name,
        mono: true,
      })),
    [sites.data],
  );

  const deploy = (
    <Button
      variant="primary"
      size="sm"
      icon={Rocket}
      onClick={() => setDeploying(true)}
      disabled={!can("websites.deployments:exec")}
    >
      Deploy
    </Button>
  );

  return (
    <>
      <ResourcePage<Deployment>
        title="Deployments"
        subtitle={site ? (site.primary_domain ?? site.name) : "Every site in scope"}
        primaryAction={deploy}
        state={state}
        query={query}
        columns={columns}
        getRowId={(row) => row.id}
        tableLabel="Deployments"
        searchPlaceholder="Search commits and sites"
        errorContext="Deployments"
        emptyIcon={Rocket}
        emptyTitle="Nothing deployed yet"
        emptyDescription="Kaname builds a site from its repository on the host and swaps the release directory when the build succeeds."
        emptyAction={deploy}
        selectable
        onRowClick={(row) => router.push(`/websites/deployments/${row.id}`)}
        rowActions={rowActions}
        filters={
          <>
            <FilterSelect
              label="Status"
              value={state.filters["status"]}
              onChange={(value) => state.setFilter("status", value)}
              options={STATUS_OPTIONS}
            />
            <FilterSelect
              label="Source"
              value={state.filters["source"]}
              onChange={(value) => state.setFilter("source", value)}
              options={SOURCE_OPTIONS}
            />
          </>
        }
        bulkActions={(ids) => {
          const rows = (query.data?.data ?? []).filter((row) => ids.includes(row.id));
          const running = rows.filter(
            (row) => DEPLOYMENT_IN_FLIGHT.includes(row.status) && row.job_id !== null,
          );
          if (running.length === 0) {
            return (
              <span className="text-xs text-[var(--kn-text-3)]">
                Nothing selected is still running.
              </span>
            );
          }
          return (
            <Button
              variant="danger-subtle"
              size="xs"
              icon={Ban}
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate(
                  running.map((row) => ({
                    id: row.job_id as string,
                    label: shortSha(row.commit_sha) ?? row.site_name,
                  })),
                  { onSuccess: () => state.setSelected([]) },
                );
              }}
            >
              Cancel {running.length === 1 ? "1 run" : `${running.length} runs`}
            </Button>
          );
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <ServerPicker selection={selection} allowAll />
          <Combobox
            options={siteOptions}
            value={siteId ?? ""}
            onValueChange={(next) =>
              state.setFilter("site_id", next && next.length > 0 ? next : null)
            }
            placeholder={siteOptions.length === 0 ? "No sites in scope" : "All sites"}
            emptyMessage="No site matches that name."
            loading={sites.isLoading}
            disabled={siteOptions.length === 0}
            clearable
            mono
            aria-label="Site"
            className="w-56"
          />
        </div>
      </ResourcePage>

      <DeployDialog open={deploying} onOpenChange={setDeploying} site={site} />
      <DeployDialog
        open={redeploy !== null}
        onOpenChange={(open) => !open && setRedeploy(null)}
        site={sites.data?.data.find((row) => row.id === redeploy?.site_id) ?? null}
        commitSha={redeploy?.commit_sha ?? null}
      />

      <ConfirmDialog
        open={pendingRollback !== null}
        onOpenChange={(open) => !open && setPendingRollback(null)}
        title="Roll back to this release?"
        description={
          pendingRollback
            ? `${pendingRollback.site_name} will be pointed back at the release directory this run wrote. The rollback is itself a deployment, so it appears in this list.`
            : undefined
        }
        confirmLabel="Roll back"
        loading={rollback.isPending}
        onConfirm={() => {
          if (!pendingRollback) return;
          rollback.mutate(
            {
              id: pendingRollback.id,
              label: shortSha(pendingRollback.commit_sha) ?? pendingRollback.site_name,
            },
            { onSuccess: () => setPendingRollback(null) },
          );
        }}
      >
        {pendingRollback && (
          <CommitCell sha={pendingRollback.commit_sha} message={pendingRollback.commit_message} />
        )}
      </ConfirmDialog>
    </>
  );
}
