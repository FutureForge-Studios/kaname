"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Globe, Pencil, Plus, RefreshCw, Rocket, ShieldCheck, Trash2 } from "lucide-react";
import type { CertStatus, Site, SiteRuntime } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  Checkbox,
  ConfirmDialog,
  MonoText,
  RelativeTime,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { useCan } from "@/lib/queries";
import { CertificateDialog } from "../_components/CertificateDialog";
import { DeployDialog } from "../_components/DeployDialog";
import { SiteDialog } from "../_components/SiteDialog";
import { FilterSelect } from "../_components/filters";
import { useDeleteSite, useReloadSites, useSites } from "../_components/queries";
import {
  DeploymentStatusBadge,
  HostAxes,
  RUNTIME_LABELS,
  RuntimeCell,
  SiteSslCell,
  SiteStatusBadge,
  useServerById,
} from "../_components/status";

/* ------------------------------------------------------------------ *
 * Sites.
 *
 * The list answers one question per column: what serves this name, on
 * which host, is its certificate healthy, did the last deploy work, and
 * how much disk is it using. Everything that changes a vhost is a job,
 * so a reload — single or bulk — closes onto a pill rather than a
 * spinner that has to guess whether nginx came back.
 * ------------------------------------------------------------------ */

const RUNTIMES: readonly SiteRuntime[] = ["static", "php", "node", "python", "proxy", "container"];

const RUNTIME_OPTIONS = RUNTIMES.map((runtime) => ({
  value: runtime,
  label: RUNTIME_LABELS[runtime],
}));

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "provisioning", label: "Provisioning" },
  { value: "suspended", label: "Suspended" },
  { value: "error", label: "Error" },
];

const SSL_OPTIONS: { value: CertStatus; label: string }[] = [
  { value: "active", label: "Certificate active" },
  { value: "expiring", label: "Certificate renewing" },
  { value: "expired", label: "Certificate expired" },
  { value: "failed", label: "Issuance failed" },
  { value: "pending", label: "Issuance pending" },
];

export default function SitesPage() {
  const router = useRouter();
  const can = useCan();

  const selection = useServerSelection({ permission: "websites.sites:read" });
  const extraParams = React.useMemo(
    () => ({ server_id: selection.serverId ?? undefined }),
    [selection.serverId],
  );

  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["runtime", "status", "ssl_status"],
    extraParams,
  });
  const query = useSites(state.params);

  const reload = useReloadSites();
  const remove = useDeleteSite();

  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Site | null>(null);
  const [deploying, setDeploying] = React.useState<Site | null>(null);
  const [issuing, setIssuing] = React.useState<Site | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Site | null>(null);
  const [deleteWebroot, setDeleteWebroot] = React.useState(false);

  const columns = React.useMemo<DataTableColumn<Site>[]>(
    () => [
      {
        id: "name",
        header: "Site",
        locked: true,
        sortable: true,
        minWidth: 176,
        cell: (site) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium text-[var(--kn-text)]">{site.name}</span>
            <SiteStatusBadge status={site.status} />
          </span>
        ),
      },
      {
        id: "domain",
        header: "Domain",
        minWidth: 200,
        cell: (site) =>
          site.primary_domain ? (
            <span className="flex min-w-0 items-center gap-2">
              <MonoText truncate className="min-w-0">
                {site.primary_domain}
              </MonoText>
              {site.domains.length > 1 && (
                <Badge
                  tone="neutral"
                  size="xs"
                  title={site.domains.map((domain) => domain.name).join("\n")}
                >
                  +{site.domains.length - 1}
                </Badge>
              )}
            </span>
          ) : (
            <span className="text-[var(--kn-text-3)]">No domain attached</span>
          ),
      },
      {
        id: "runtime",
        header: "Runtime",
        sortable: true,
        width: 132,
        cell: (site) => <RuntimeCell site={site} />,
      },
      {
        id: "server",
        header: "Server",
        minWidth: 168,
        hideBelow: "lg",
        cell: (site) => <SiteServerCell site={site} />,
      },
      {
        id: "ssl",
        header: "SSL",
        minWidth: 168,
        cell: (site) => <SiteSslCell site={site} />,
      },
      {
        id: "deploy",
        header: "Last deploy",
        width: 168,
        hideBelow: "md",
        cell: (site) =>
          site.last_deployment ? (
            <Link
              href={`/websites/deployments/${site.last_deployment.id}`}
              className="flex min-w-0 items-center gap-2 rounded-[var(--kn-r-xs)] outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
            >
              <DeploymentStatusBadge status={site.last_deployment.status} />
              <RelativeTime
                value={site.last_deployment.finished_at}
                className="text-xs text-[var(--kn-text-2)]"
              />
            </Link>
          ) : (
            <span className="text-[var(--kn-text-3)]">Never deployed</span>
          ),
      },
      {
        id: "disk_usage",
        header: "Disk",
        sortable: true,
        align: "right",
        width: 96,
        hideBelow: "md",
        cell: (site) => <ByteSize bytes={site.disk_usage} />,
      },
    ],
    [],
  );

  const rowActions = React.useCallback(
    (site: Site): DataTableRowAction<Site>[] => {
      const writable = can("websites.sites:write", site.server_id);
      return [
        {
          id: "open",
          label: "Open",
          icon: Globe,
          onSelect: () => router.push(`/websites/sites/${site.id}`),
        },
        {
          id: "deploy",
          label: "Deploy",
          icon: Rocket,
          disabled: !can("websites.deployments:exec", site.server_id),
          onSelect: () => setDeploying(site),
        },
        {
          id: "reload",
          label: "Reload web server",
          icon: RefreshCw,
          disabled: !writable,
          onSelect: () => reload.mutate([site.id]),
        },
        {
          id: "certificate",
          label: "Issue certificate",
          icon: ShieldCheck,
          disabled: !can("websites.ssl:write", site.server_id),
          onSelect: () => setIssuing(site),
        },
        {
          id: "edit",
          label: "Edit site",
          icon: Pencil,
          separatorBefore: true,
          disabled: !writable,
          onSelect: () => setEditing(site),
        },
        {
          id: "delete",
          label: "Delete site",
          icon: Trash2,
          destructive: true,
          disabled: !can("websites.sites:delete", site.server_id),
          onSelect: () => {
            setDeleteWebroot(false);
            setPendingDelete(site);
          },
        },
      ];
    },
    [can, reload, router],
  );

  const newSite = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => setCreating(true)}
      disabled={!can("websites.sites:write")}
    >
      New site
    </Button>
  );

  return (
    <>
      <ResourcePage<Site>
        title="Sites"
        subtitle={selection.server ? selection.server.hostname : "Every host in scope"}
        primaryAction={newSite}
        state={state}
        query={query}
        columns={columns}
        getRowId={(site) => site.id}
        tableLabel="Sites"
        searchPlaceholder="Search sites and domains"
        errorContext="Sites"
        emptyIcon={Globe}
        emptyTitle="No sites yet"
        emptyDescription="A site is a vhost Kaname writes and reloads for you. Add one to point a domain at a webroot."
        emptyAction={newSite}
        selectable
        onRowClick={(site) => router.push(`/websites/sites/${site.id}`)}
        rowActions={rowActions}
        filters={
          <>
            <FilterSelect
              label="Runtime"
              value={state.filters["runtime"]}
              onChange={(value) => state.setFilter("runtime", value)}
              options={RUNTIME_OPTIONS}
            />
            <FilterSelect
              label="Status"
              value={state.filters["status"]}
              onChange={(value) => state.setFilter("status", value)}
              options={STATUS_OPTIONS}
            />
            <FilterSelect
              label="SSL"
              value={state.filters["ssl_status"]}
              onChange={(value) => state.setFilter("ssl_status", value)}
              options={SSL_OPTIONS}
            />
          </>
        }
        bulkActions={(ids) => (
          <Button
            variant="secondary"
            size="xs"
            icon={RefreshCw}
            loading={reload.isPending}
            onClick={() => {
              reload.mutate(ids);
              state.setSelected([]);
            }}
          >
            Reload {ids.length === 1 ? "site" : `${ids.length} sites`}
          </Button>
        )}
      >
        <ServerPicker selection={selection} allowAll />
      </ResourcePage>

      <SiteDialog open={creating} onOpenChange={setCreating} defaultServerId={selection.serverId} />
      <SiteDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        site={editing}
      />
      <DeployDialog
        open={deploying !== null}
        onOpenChange={(open) => !open && setDeploying(null)}
        site={deploying}
      />
      <CertificateDialog
        open={issuing !== null}
        onOpenChange={(open) => !open && setIssuing(null)}
        defaultDomainId={issuing?.domains[0]?.id ?? null}
        defaultServerId={issuing?.server_id ?? null}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete ${pendingDelete?.name ?? "site"}?`}
        description="The vhost is removed and the web server reloaded as a job. Domains stay in Kaname so their DNS records and certificate history survive."
        confirmText={pendingDelete?.name}
        confirmLabel="Delete site"
        loading={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          remove.mutate(
            { id: pendingDelete.id, name: pendingDelete.name, deleteWebroot },
            { onSuccess: () => setPendingDelete(null) },
          );
        }}
      >
        <Checkbox
          checked={deleteWebroot}
          onChange={(event) => setDeleteWebroot(event.target.checked)}
          label="Also delete the webroot"
          description={
            pendingDelete
              ? `Removes ${pendingDelete.webroot} and everything in it. There is no undo.`
              : undefined
          }
        />
      </ConfirmDialog>
    </>
  );
}

/** Both status axes for the host, resolved from the fleet list. */
function SiteServerCell({ site }: { site: Site }) {
  const server = useServerById(site.server_id);
  return <HostAxes server={server} fallbackName={site.server_name} />;
}
