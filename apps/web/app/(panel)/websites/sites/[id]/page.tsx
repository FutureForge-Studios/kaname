"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Folder,
  LayoutDashboard,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  Certificate,
  Deployment,
  Domain,
  FileEntry,
  LogSourceRow,
  Site,
} from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DetailLayout,
  DropdownMenu,
  EmptyState,
  FileTree,
  IconButton,
  LogViewer,
  MenuItem,
  MenuSeparator,
  MetricTile,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Select,
  Skeleton,
  TabPanel,
  Tabs,
  type DataTableColumn,
  type FileTreeNode,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { formatCount, formatDuration } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { CertificateDialog } from "../../_components/CertificateDialog";
import { DeployDialog } from "../../_components/DeployDialog";
import { DomainDialog } from "../../_components/DomainDialog";
import { SiteDialog } from "../../_components/SiteDialog";
import {
  DetailBody,
  DetailFailed,
  DetailLoading,
  DetailTabList,
  useDetailTab,
  type DetailTabSpec,
} from "../../_components/detail";
import {
  directoryQuery,
  useCertificates,
  useDeleteSite,
  useDeployments,
  useDirectory,
  useDomains,
  useLogSearch,
  useLogSources,
  useReloadSites,
  useSite,
} from "../../_components/queries";
import {
  CertificateStatusBadge,
  CommitCell,
  DeploymentStatusBadge,
  DnsProviderBadge,
  DomainStatusBadge,
  Expiry,
  ProxiedBadge,
  RUNTIME_LABELS,
  SiteStatusBadge,
  VerificationBadge,
  useServerById,
} from "../../_components/status";

/* ------------------------------------------------------------------ *
 * Site detail.
 *
 * Six tabs, one subject. The header keeps identity and both host status
 * axes on screen whichever tab is open, because "this site is fine" and
 * "the box serving it is unreachable" answer different questions, and
 * the second one changes what every tab below means.
 *
 * Panels mount only while selected, so an unopened Files tab never asks
 * the agent to read a directory and an unopened Logs tab never polls.
 * ------------------------------------------------------------------ */

const TAB_VALUES: DetailTabSpec[] = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "domains", label: "Domains", icon: Link2 },
  { value: "ssl", label: "SSL", icon: ShieldCheck },
  { value: "deployments", label: "Deployments", icon: Rocket },
  { value: "files", label: "Files", icon: Folder },
  { value: "logs", label: "Logs", icon: ScrollText },
];

export default function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const can = useCan();

  const query = useSite(id);
  const site = query.data ?? null;
  const server = useServerById(site?.server_id);

  const reload = useReloadSites();
  const remove = useDeleteSite();

  const [editing, setEditing] = React.useState(false);
  const [deploying, setDeploying] = React.useState(false);
  const [issuing, setIssuing] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleteWebroot, setDeleteWebroot] = React.useState(false);

  const tabs = React.useMemo<DetailTabSpec[]>(
    () =>
      TAB_VALUES.map((tab) =>
        tab.value === "domains" && site ? { ...tab, badge: formatCount(site.domains.length) } : tab,
      ),
    [site],
  );
  const [tab, setTab] = useDetailTab(tabs, "overview");

  if (query.isLoading) return <DetailLoading />;
  if (query.isError || !site) {
    return (
      <DetailFailed
        error={query.error}
        onRetry={() => void query.refetch()}
        context="Site"
        title="Site"
      />
    );
  }

  const writable = can("websites.sites:write", site.server_id);

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={setTab}
        activationMode="manual"
        className="flex min-h-0 flex-1 flex-col"
      >
        <ResourceHeader
          name={site.name}
          identity={site.primary_domain ?? site.webroot}
          connection={server?.connection}
          lastSeenAt={server?.last_seen_at}
          health={server?.health}
          healthReasons={server?.health_reasons}
          badges={
            <>
              <SiteStatusBadge status={site.status} />
              <Badge tone="neutral" size="xs">
                {RUNTIME_LABELS[site.runtime]}
                {site.runtime_version ? ` ${site.runtime_version}` : ""}
              </Badge>
            </>
          }
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                loading={reload.isPending}
                disabled={!writable}
                onClick={() => reload.mutate([site.id])}
              >
                Reload
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Rocket}
                disabled={!can("websites.deployments:exec", site.server_id)}
                onClick={() => setDeploying(true)}
              >
                Deploy
              </Button>
            </>
          }
          menu={
            <DropdownMenu
              trigger={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
              placement="bottom-end"
              label={`${site.name} actions`}
            >
              <MenuItem icon={Pencil} disabled={!writable} onSelect={() => setEditing(true)}>
                Edit site
              </MenuItem>
              <MenuItem
                icon={ShieldCheck}
                disabled={!can("websites.ssl:write", site.server_id)}
                onSelect={() => setIssuing(true)}
              >
                Issue certificate
              </MenuItem>
              <MenuItem
                icon={Folder}
                onSelect={() =>
                  router.push(
                    `/files/manager?server_id=${site.server_id}&path=${encodeURIComponent(site.webroot)}`,
                  )
                }
              >
                Open in File Manager
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                destructive
                disabled={!can("websites.sites:delete", site.server_id)}
                onSelect={() => {
                  setDeleteWebroot(false);
                  setConfirmingDelete(true);
                }}
              >
                Delete site
              </MenuItem>
            </DropdownMenu>
          }
          tabs={<DetailTabList tabs={tabs} />}
        />

        <DetailBody>
          <Panel value="overview">
            <OverviewTab site={site} onIssue={() => setIssuing(true)} />
          </Panel>
          <Panel value="domains">
            <DomainsTab site={site} onAttach={() => setAttaching(true)} />
          </Panel>
          <Panel value="ssl">
            <SslTab site={site} onIssue={() => setIssuing(true)} />
          </Panel>
          <Panel value="deployments">
            <DeploymentsTab site={site} onDeploy={() => setDeploying(true)} />
          </Panel>
          <Panel value="files">
            <FilesTab site={site} />
          </Panel>
          <Panel value="logs">
            <LogsTab site={site} />
          </Panel>
        </DetailBody>
      </Tabs>

      <SiteDialog open={editing} onOpenChange={setEditing} site={site} />
      <DeployDialog open={deploying} onOpenChange={setDeploying} site={site} />
      <CertificateDialog
        open={issuing}
        onOpenChange={setIssuing}
        defaultDomainId={site.domains[0]?.id ?? null}
        defaultServerId={site.server_id}
      />
      <DomainDialog
        open={attaching}
        onOpenChange={setAttaching}
        defaultSiteId={site.id}
        defaultServerId={site.server_id}
      />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${site.name}?`}
        description="The vhost is removed and the web server reloaded as a job. Domains stay in Kaname so their DNS records and certificate history survive."
        confirmText={site.name}
        confirmLabel="Delete site"
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { id: site.id, name: site.name, deleteWebroot },
            {
              onSuccess: () => {
                setConfirmingDelete(false);
                router.push("/websites/sites");
              },
            },
          )
        }
      >
        <Checkbox
          checked={deleteWebroot}
          onChange={(event) => setDeleteWebroot(event.target.checked)}
          label="Also delete the webroot"
          description={`Removes ${site.webroot} and everything in it. There is no undo.`}
        />
      </ConfirmDialog>
    </>
  );
}

function Panel({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabPanel value={value} className="flex min-w-0 flex-col gap-4">
      {children}
    </TabPanel>
  );
}

/* ------------------------------ overview ---------------------------- */

function OverviewTab({ site, onIssue }: { site: Site; onIssue: () => void }) {
  const deployments = useDeployments({
    site_id: site.id,
    per_page: 5,
    sort: "created_at",
    order: "desc",
  });

  return (
    <DetailLayout
      rail={
        <SectionCard title="Configuration" headingLevel={3}>
          <PropertyList dense labelWidth="sm">
            <PropertyRow label="Server">
              <Link
                href={`/infrastructure/servers/${site.server_id}`}
                className="kn-mono rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
              >
                {site.server_name}
              </Link>
            </PropertyRow>
            <PropertyRow label="Runtime">
              {RUNTIME_LABELS[site.runtime]}
              {site.runtime_version ? ` ${site.runtime_version}` : ""}
            </PropertyRow>
            {site.php_version && (
              <PropertyRow label="PHP pool" mono>
                {site.php_version}
              </PropertyRow>
            )}
            <PropertyRow label="Webroot" mono copyValue={site.webroot}>
              {site.webroot}
            </PropertyRow>
            {site.config_path && (
              <PropertyRow label="Vhost" mono copyValue={site.config_path}>
                {site.config_path}
              </PropertyRow>
            )}
            {site.upstream && (
              <PropertyRow label="Upstream" mono copyValue={site.upstream}>
                {site.upstream}
              </PropertyRow>
            )}
            <PropertyRow label="Owner" mono>
              {site.owner}
            </PropertyRow>
            <PropertyRow label="Force HTTPS">{site.force_https ? "Yes" : "No"}</PropertyRow>
            <PropertyRow label="Created">
              <RelativeTime value={site.created_at} />
            </PropertyRow>
            <PropertyRow label="Synced" hint="When the host last reconciled this vhost.">
              <RelativeTime value={site.last_synced_at} fallback="never" />
            </PropertyRow>
          </PropertyList>
        </SectionCard>
      }
    >
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MetricTile size="sm" label="Disk usage" value={<ByteSize bytes={site.disk_usage} />} />
        <MetricTile size="sm" label="Domains" value={formatCount(site.domains.length)} />
        <MetricTile
          size="sm"
          label="Certificate"
          value={
            site.ssl ? <Expiry days={site.ssl.days_remaining} at={site.ssl.expires_at} /> : "None"
          }
          tone={site.ssl ? "neutral" : "warn"}
        />
        <MetricTile
          size="sm"
          label="Deployments"
          value={formatCount(deployments.data?.meta.total ?? 0)}
        />
      </div>

      <SectionCard
        title="Certificate"
        icon={ShieldCheck}
        headingLevel={3}
        actions={
          site.ssl ? (
            <Link
              href={`/websites/ssl/${site.ssl.certificate_id}`}
              className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              Open certificate
            </Link>
          ) : undefined
        }
      >
        {site.ssl ? (
          <div className="flex flex-wrap items-center gap-3">
            <CertificateStatusBadge status={site.ssl.status} />
            <Expiry days={site.ssl.days_remaining} at={site.ssl.expires_at} />
            <span className="text-[var(--kn-text-2)]">
              covering {site.primary_domain ?? site.name}
            </span>
          </div>
        ) : (
          <EmptyState
            title="No certificate on this site"
            description="HTTPS will not answer until one is issued and installed."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={ShieldCheck} onClick={onIssue}>
                Issue a certificate
              </Button>
            }
          />
        )}
      </SectionCard>

      <SectionCard
        title="Recent deployments"
        icon={Rocket}
        headingLevel={3}
        padded={false}
        actions={
          <Link
            href={`/websites/deployments?site_id=${site.id}`}
            className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
          >
            All deployments
          </Link>
        }
      >
        <DeploymentMiniTable query={deployments} />
      </SectionCard>
    </DetailLayout>
  );
}

function DeploymentMiniTable({ query }: { query: ReturnType<typeof useDeployments> }) {
  const router = useRouter();
  const columns = React.useMemo<DataTableColumn<Deployment>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        width: 116,
        cell: (row) => <DeploymentStatusBadge status={row.status} />,
      },
      {
        id: "commit",
        header: "Commit",
        minWidth: 200,
        cell: (row) => <CommitCell sha={row.commit_sha} message={row.commit_message} />,
      },
      {
        id: "duration",
        header: "Duration",
        width: 96,
        align: "right",
        accessor: (row) => (row.duration_ms == null ? "—" : formatDuration(row.duration_ms)),
      },
      {
        id: "finished",
        header: "Finished",
        width: 112,
        align: "right",
        cell: (row) => <RelativeTime value={row.finished_at ?? row.created_at} />,
      },
    ],
    [],
  );

  return (
    <DataTable<Deployment>
      columns={columns}
      rows={query.data?.data ?? []}
      getRowId={(row) => row.id}
      label="Recent deployments"
      density="compact"
      columnVisibility={false}
      loading={query.isLoading}
      skeletonRows={3}
      onRowClick={(row) => router.push(`/websites/deployments/${row.id}`)}
      error={
        query.isError ? (
          <PageError
            error={query.error}
            onRetry={() => void query.refetch()}
            context="Deployments"
          />
        ) : undefined
      }
      empty={
        <EmptyState
          title="Never deployed"
          description="Trigger a deployment to build this site from its repository."
          size="sm"
        />
      }
      className="rounded-none border-0"
    />
  );
}

/* ------------------------------- domains ---------------------------- */

function DomainsTab({ site, onAttach }: { site: Site; onAttach: () => void }) {
  const router = useRouter();
  const can = useCan();
  const query = useDomains({ site_id: site.id, per_page: 100, sort: "name", order: "asc" });

  const columns = React.useMemo<DataTableColumn<Domain>[]>(
    () => [
      {
        id: "name",
        header: "Domain",
        minWidth: 200,
        locked: true,
        cell: (domain) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate>{domain.name}</MonoText>
            {domain.name === site.primary_domain && (
              <Badge tone="accent" size="xs">
                Primary
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 112,
        cell: (domain) => <DomainStatusBadge status={domain.status} />,
      },
      {
        id: "verified",
        header: "Control",
        width: 112,
        cell: (domain) => <VerificationBadge verified={domain.verified} />,
      },
      {
        id: "provider",
        header: "DNS",
        width: 128,
        cell: (domain) => <DnsProviderBadge provider={domain.dns_provider} />,
      },
      {
        id: "proxied",
        header: "Edge",
        width: 96,
        hideBelow: "md",
        cell: (domain) => <ProxiedBadge proxied={domain.proxied} />,
      },
      {
        id: "records",
        header: "Records",
        width: 88,
        align: "right",
        hideBelow: "md",
        accessor: (domain) => formatCount(domain.record_count),
      },
    ],
    [site.primary_domain],
  );

  return (
    <SectionCard
      title="Domains answering on this site"
      icon={Link2}
      padded={false}
      headingLevel={3}
      actions={
        <Button
          variant="secondary"
          size="xs"
          icon={Plus}
          disabled={!can("websites.domains:write", site.server_id)}
          onClick={onAttach}
        >
          Attach domain
        </Button>
      }
    >
      <DataTable<Domain>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(domain) => domain.id}
        label="Site domains"
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={3}
        onRowClick={(domain) => router.push(`/websites/domains/${domain.id}`)}
        error={
          query.isError ? (
            <PageError error={query.error} onRetry={() => void query.refetch()} context="Domains" />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={Link2}
            title="No domains attached"
            description="A site with no server_name answers on nothing. Attach a domain to route traffic to it."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={Plus} onClick={onAttach}>
                Attach a domain
              </Button>
            }
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

/* --------------------------------- ssl ------------------------------ */

function SslTab({ site, onIssue }: { site: Site; onIssue: () => void }) {
  const router = useRouter();
  const can = useCan();
  const query = useCertificates({
    server_id: site.server_id,
    per_page: 200,
    sort: "expires_at",
    order: "asc",
  });

  const domainIds = React.useMemo(
    () => new Set(site.domains.map((domain) => domain.id)),
    [site.domains],
  );
  const rows = React.useMemo(
    () => (query.data?.data ?? []).filter((certificate) => domainIds.has(certificate.domain_id)),
    [domainIds, query.data],
  );

  const columns = React.useMemo<DataTableColumn<Certificate>[]>(
    () => [
      {
        id: "subject",
        header: "Subject",
        minWidth: 200,
        locked: true,
        cell: (certificate) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText truncate>{certificate.subject}</MonoText>
            {certificate.sans.length > 0 && (
              <Badge tone="neutral" size="xs" title={certificate.sans.join("\n")}>
                +{certificate.sans.length}
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 116,
        cell: (certificate) => <CertificateStatusBadge status={certificate.status} />,
      },
      {
        id: "expires",
        header: "Expires in",
        width: 116,
        align: "right",
        cell: (certificate) => (
          <Expiry days={certificate.days_remaining} at={certificate.expires_at} />
        ),
      },
      {
        id: "auto_renew",
        header: "Auto-renew",
        width: 104,
        hideBelow: "md",
        accessor: (certificate) => (certificate.auto_renew ? "On" : "Off"),
      },
      {
        id: "challenge",
        header: "Challenge",
        width: 104,
        mono: true,
        hideBelow: "lg",
        accessor: (certificate) => certificate.challenge,
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Certificates covering this site"
      icon={ShieldCheck}
      padded={false}
      headingLevel={3}
      actions={
        <Button
          variant="secondary"
          size="xs"
          icon={Plus}
          disabled={!can("websites.ssl:write", site.server_id)}
          onClick={onIssue}
        >
          Issue certificate
        </Button>
      }
    >
      <DataTable<Certificate>
        columns={columns}
        rows={rows}
        getRowId={(certificate) => certificate.id}
        label="Site certificates"
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={2}
        onRowClick={(certificate) => router.push(`/websites/ssl/${certificate.id}`)}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Certificates"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={ShieldCheck}
            title="No certificate for these domains"
            description="HTTPS will not answer until one is issued and installed on the host."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={ShieldCheck} onClick={onIssue}>
                Issue a certificate
              </Button>
            }
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

/* ----------------------------- deployments -------------------------- */

function DeploymentsTab({ site, onDeploy }: { site: Site; onDeploy: () => void }) {
  const router = useRouter();
  const can = useCan();
  const query = useDeployments({
    site_id: site.id,
    per_page: 50,
    sort: "created_at",
    order: "desc",
  });

  const columns = React.useMemo<DataTableColumn<Deployment>[]>(
    () => [
      {
        id: "status",
        header: "Status",
        width: 116,
        locked: true,
        cell: (row) => <DeploymentStatusBadge status={row.status} />,
      },
      {
        id: "commit",
        header: "Commit",
        minWidth: 220,
        cell: (row) => <CommitCell sha={row.commit_sha} message={row.commit_message} />,
      },
      {
        id: "branch",
        header: "Branch",
        width: 132,
        mono: true,
        hideBelow: "md",
        accessor: (row) => row.branch ?? "—",
      },
      {
        id: "triggered",
        header: "Triggered by",
        width: 148,
        hideBelow: "lg",
        accessor: (row) => row.triggered_by_name ?? "Automation",
      },
      {
        id: "duration",
        header: "Duration",
        width: 96,
        align: "right",
        accessor: (row) => (row.duration_ms == null ? "—" : formatDuration(row.duration_ms)),
      },
      {
        id: "finished",
        header: "Finished",
        width: 112,
        align: "right",
        cell: (row) => <RelativeTime value={row.finished_at ?? row.created_at} />,
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Deployment history"
      icon={Rocket}
      padded={false}
      headingLevel={3}
      actions={
        <Button
          variant="secondary"
          size="xs"
          icon={Rocket}
          disabled={!can("websites.deployments:exec", site.server_id)}
          onClick={onDeploy}
        >
          Deploy
        </Button>
      }
    >
      <DataTable<Deployment>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(row) => row.id}
        label="Deployments"
        density="compact"
        columnVisibility={false}
        loading={query.isLoading}
        skeletonRows={5}
        onRowClick={(row) => router.push(`/websites/deployments/${row.id}`)}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Deployments"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={Rocket}
            title="Never deployed"
            description="Kaname builds from a git repository and swaps the release directory on success."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={Rocket} onClick={onDeploy}>
                Deploy this site
              </Button>
            }
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}

/* -------------------------------- files ----------------------------- */

function toNode(entry: FileEntry): FileTreeNode {
  return { path: entry.path, name: entry.name, kind: entry.kind, size: entry.size };
}

/**
 * Read-only, rooted at the webroot and loaded a level at a time. The
 * full manager — uploads, editing, permissions — stays in its own
 * module; this is the view that answers "is the build actually there".
 */
function FilesTab({ site }: { site: Site }) {
  const client = useQueryClient();
  const root = useDirectory(site.server_id, site.webroot);
  const [children, setChildren] = React.useState<Record<string, FileTreeNode[]>>({});
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [failedPath, setFailedPath] = React.useState<string | null>(null);

  React.useEffect(() => {
    setChildren({});
    setExpanded([]);
  }, [site.server_id, site.webroot]);

  const loadChildren = React.useCallback(
    async (node: FileTreeNode) => {
      if (children[node.path]) return;
      try {
        const listing = await client.fetchQuery(directoryQuery(site.server_id, node.path));
        setChildren((previous) => ({ ...previous, [node.path]: listing.entries.map(toNode) }));
        setFailedPath(null);
      } catch {
        setFailedPath(node.path);
      }
    },
    [children, client, site.server_id],
  );

  const nodes = React.useMemo<FileTreeNode[]>(() => {
    const build = (path: string): FileTreeNode[] | undefined =>
      children[path]?.map((node) =>
        node.kind === "directory" ? { ...node, children: build(node.path) } : node,
      );

    return (root.data?.entries ?? []).map((entry) => {
      const node = toNode(entry);
      return node.kind === "directory" ? { ...node, children: build(node.path) } : node;
    });
  }, [children, root.data]);

  return (
    <SectionCard
      title="Webroot"
      icon={Folder}
      description={site.webroot}
      padded={false}
      headingLevel={3}
      actions={
        <>
          <IconButton
            icon={RefreshCw}
            label="Refresh listing"
            size="sm"
            disabled={root.isFetching}
            onClick={() => {
              setChildren({});
              void root.refetch();
            }}
          />
          <Link
            href={`/files/manager?server_id=${site.server_id}&path=${encodeURIComponent(site.webroot)}`}
            className="inline-flex items-center gap-1 rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
          >
            Open in File Manager
            <ExternalLink size={12} aria-hidden />
          </Link>
        </>
      }
    >
      {root.isLoading && (
        <div className="flex flex-col gap-1.5 p-4">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton
              key={index}
              className="h-4 w-full"
              label={index === 0 ? "Loading webroot" : undefined}
            />
          ))}
        </div>
      )}

      {root.isError && (
        <div className="p-4">
          <PageError
            error={root.error}
            onRetry={() => void root.refetch()}
            context={site.webroot}
          />
        </div>
      )}

      {failedPath && (
        <p
          role="alert"
          className="border-b border-[var(--kn-border)] px-4 py-2 text-xs text-[var(--kn-danger)]"
        >
          Could not read <MonoText>{failedPath}</MonoText> from {site.server_name}.
        </p>
      )}

      {root.data && (
        <FileTree
          nodes={nodes}
          expandedPaths={expanded}
          onExpandedChange={setExpanded}
          onLoadChildren={loadChildren}
          label={`Contents of ${site.webroot}`}
          emptyLabel="The webroot is empty — nothing has been deployed here yet."
          className="max-h-[520px] overflow-auto p-2"
        />
      )}
    </SectionCard>
  );
}

/* --------------------------------- logs ----------------------------- */

const LOG_POLL_MS = 5_000;
const WEB_LOG_KINDS = new Set(["nginx_access", "nginx_error"]);

function LogsTab({ site }: { site: Site }) {
  const sources = useLogSources(site.server_id);
  const [sourceRef, setSourceRef] = React.useState("");
  const [live, setLive] = React.useState(true);

  const relevant = React.useMemo<LogSourceRow[]>(() => {
    const rows = sources.data?.data ?? [];
    const web = rows.filter((row) => WEB_LOG_KINDS.has(row.kind));
    return web.length > 0 ? web : rows;
  }, [sources.data]);

  /* A per-vhost access log answers "is my site being hit" far better
   * than the host-wide one, so it wins when the host keeps both. */
  const preferred = React.useMemo(() => {
    const named = relevant.find(
      (row) =>
        row.ref.includes(site.name) ||
        (site.primary_domain !== null && row.ref.includes(site.primary_domain)),
    );
    return named?.ref ?? relevant[0]?.ref ?? "";
  }, [relevant, site.name, site.primary_domain]);

  const selected = sourceRef || preferred;

  const logs = useLogSearch(
    selected ? { serverId: site.server_id, source: selected, limit: 500 } : null,
    live ? LOG_POLL_MS : false,
  );

  const lines = React.useMemo(
    () =>
      (logs.data?.data ?? [])
        .slice()
        .reverse()
        .map((record) => ({
          id: record.id,
          ts: record.ts,
          level: record.level,
          message: record.message,
          source: record.source,
        })),
    [logs.data],
  );

  return (
    <SectionCard
      title="Web server logs"
      icon={ScrollText}
      padded={false}
      headingLevel={3}
      actions={
        <Link
          href={`/logs?server_id=${site.server_id}${selected ? `&source=${encodeURIComponent(selected)}` : ""}`}
          className="inline-flex items-center gap-1 rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Open in Logs
          <ExternalLink size={12} aria-hidden />
        </Link>
      }
    >
      {sources.isError && (
        <div className="p-4">
          <PageError
            error={sources.error}
            onRetry={() => void sources.refetch()}
            context="Log sources"
          />
        </div>
      )}

      {logs.isError && (
        <div className="p-4">
          <PageError error={logs.error} onRetry={() => void logs.refetch()} context="Logs" />
        </div>
      )}

      {!sources.isLoading && !sources.isError && relevant.length === 0 && (
        <EmptyState
          icon={ScrollText}
          title="No log sources on this host"
          description="The agent found no journal unit or log file it could tail for the web server."
          size="sm"
        />
      )}

      {relevant.length > 0 && (
        <LogViewer
          lines={lines}
          height={480}
          paused={!live}
          onPausedChange={(paused) => setLive(!paused)}
          emptyLabel="No lines in the current window."
          label={`${site.name} web server log`}
          toolbarExtra={
            <Select
              size="xs"
              aria-label="Log source"
              value={selected}
              onChange={(event) => setSourceRef(event.target.value)}
              boxClassName="w-auto min-w-40"
              options={relevant.map((row) => ({ value: row.ref, label: row.label }))}
              mono
            />
          }
        />
      )}
    </SectionCard>
  );
}
