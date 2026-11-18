"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  LayoutDashboard,
  Link2,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  ScrollText,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Certificate, Deployment, Domain, LogSourceRow, Site } from "@kaname/contract";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  DetailLayout,
  DropdownMenu,
  EmptyState,
  FormField,
  IconButton,
  Input,
  LogViewer,
  MenuItem,
  MenuSeparator,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Select,
  Skeleton,
  StatusLine,
  TabPanel,
  Tabs,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { formatCount, formatDuration } from "@/lib/format";
import { useAudience } from "@/lib/modes";
import { invalidateFamilies, useCan } from "@/lib/queries";
import { fieldErrors } from "../../../_components/FormDialog";
import { CertificateDialog } from "../../_components/CertificateDialog";
import { DeployDialog } from "../../_components/DeployDialog";
import { DomainDialog } from "../../_components/DomainDialog";
import { SiteDialog } from "../../_components/SiteDialog";
import {
  DetailBody,
  DetailFailed,
  DetailIdentity,
  DetailLoading,
  DetailTabList,
  PillLink,
  useDetailTab,
  type DetailTabSpec,
} from "../../_components/detail";
import {
  useCertificates,
  useDeleteSite,
  useDeployments,
  useDomains,
  useLogSearch,
  useLogSources,
  useReloadSites,
  useResumeSite,
  useSite,
  useSuspendSite,
  useTriggerDeployment,
  useUpdateSite,
} from "../../_components/queries";
import {
  CertificateStatusBadge,
  CommitCell,
  DEPLOYMENT_IN_FLIGHT,
  DeploymentStatusBadge,
  DnsProviderBadge,
  DomainStatusBadge,
  Expiry,
  ProxiedBadge,
  RUNTIME_LABELS,
  SiteStatusBadge,
  VerificationBadge,
  lineTone,
  siteStatusTone,
  useServerById,
} from "../../_components/status";

/* ------------------------------------------------------------------ *
 * Project page.
 *
 * Shaped like a Vercel project: the header says what it is and where it
 * answers, with Visit and Redeploy one click away; Overview opens on the
 * production deployment. The header keeps both host status axes on
 * screen whichever tab is open, because "this site is fine" and "the box
 * serving it is unreachable" answer different questions.
 *
 * Panels mount only while selected, so an unopened Logs tab never polls.
 * ------------------------------------------------------------------ */

const TAB_VALUES: DetailTabSpec[] = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "deployments", label: "Deployments", icon: Rocket },
  { value: "domains", label: "Domains", icon: Link2 },
  { value: "logs", label: "Logs", icon: ScrollText },
  { value: "settings", label: "Settings", icon: Settings },
];

export default function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const can = useCan();
  const operator = useAudience().audience === "operator";

  const query = useSite(id);
  const site = query.data ?? null;
  const server = useServerById(site?.server_id);

  const reload = useReloadSites();
  const remove = useDeleteSite();
  const suspend = useSuspendSite();
  const resume = useResumeSite();
  const redeploy = useTriggerDeployment();
  const [confirmingSuspend, setConfirmingSuspend] = React.useState(false);

  const [editing, setEditing] = React.useState(false);
  const [deploying, setDeploying] = React.useState(false);
  /* undefined: closed; null: issue without a domain picked. */
  const [issuingFor, setIssuingFor] = React.useState<string | null | undefined>(undefined);
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
        context="Project"
        title="Project"
      />
    );
  }

  const writable = can("websites.sites:write", site.server_id);
  const canDeploy = can("websites.deployments:exec", site.server_id);
  const inFlight = deploymentInFlight(site);
  // Scoped accounts may not set a repository, so they deploy through the dialog.
  const gitDeploy = site.repo_url !== null && operator;

  /* With a repository on the site, one click deploys its branch head;
   * without one, the dialog asks for a repository or an upload. */
  const deploy = () => {
    if (gitDeploy) redeploy.mutate({ site_id: site.id, source: "git", force: false });
    else setDeploying(true);
  };
  const confirmDelete = () => {
    setDeleteWebroot(false);
    setConfirmingDelete(true);
  };

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={setTab}
        activationMode="manual"
        className="flex min-h-0 flex-1 flex-col"
      >
        <ResourceHeader
          breadcrumb={
            <Link href="/" className="hover:text-[var(--kn-text)] hover:underline">
              Projects
            </Link>
          }
          name={site.name}
          identity={
            <DetailIdentity status={<SiteStatusLine site={site} />}>
              {site.primary_domain ? (
                <a
                  href={siteUrl(site, site.primary_domain)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {site.primary_domain}
                </a>
              ) : (
                "No domain yet"
              )}
            </DetailIdentity>
          }
          connection={server?.connection}
          lastSeenAt={server?.last_seen_at}
          health={server?.health}
          healthReasons={server?.health_reasons}
          badges={<SiteStatusBadge status={site.status} />}
          actions={
            <>
              {site.primary_domain && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ExternalLink}
                  onClick={() =>
                    window.open(
                      siteUrl(site, site.primary_domain!),
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  Visit
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                icon={site.last_deployment ? RotateCw : Rocket}
                loading={redeploy.isPending}
                disabled={!canDeploy || inFlight}
                title={inFlight ? IN_FLIGHT_REASON : undefined}
                onClick={deploy}
              >
                {site.last_deployment ? "Redeploy" : "Deploy"}
              </Button>
            </>
          }
          menu={
            <DropdownMenu
              trigger={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
              placement="bottom-end"
              label={`${site.name} actions`}
            >
              <MenuItem
                icon={RefreshCw}
                disabled={!writable || reload.isPending}
                onSelect={() => reload.mutate([site.id])}
              >
                Reload
              </MenuItem>
              <MenuSeparator />
              {site.status === "suspended" ? (
                <MenuItem
                  icon={PlayCircle}
                  disabled={!writable || resume.isPending}
                  onSelect={() => resume.mutate({ id: site.id, name: site.name })}
                >
                  Resume project
                </MenuItem>
              ) : (
                <MenuItem
                  icon={PauseCircle}
                  disabled={!writable || site.status === "provisioning"}
                  onSelect={() => setConfirmingSuspend(true)}
                >
                  Suspend project
                </MenuItem>
              )}
              <MenuItem
                icon={Trash2}
                destructive
                disabled={!can("websites.sites:delete", site.server_id)}
                onSelect={confirmDelete}
              >
                Delete project
              </MenuItem>
            </DropdownMenu>
          }
          tabs={<DetailTabList tabs={tabs} />}
        />

        <DetailBody>
          <Panel value="overview">
            <OverviewTab site={site} canDeploy={canDeploy && !inFlight} onDeploy={deploy} />
          </Panel>
          <Panel value="deployments">
            <DeploymentsTab site={site} inFlight={inFlight} onDeploy={() => setDeploying(true)} />
          </Panel>
          <Panel value="domains">
            <DomainsTab site={site} onAttach={() => setAttaching(true)} onIssue={setIssuingFor} />
            <CertificatesSection site={site} onIssue={() => setIssuingFor(null)} />
          </Panel>
          <Panel value="logs">
            <LogsTab site={site} />
          </Panel>
          <Panel value="settings">
            <SettingsTab
              site={site}
              operator={operator}
              onEdit={() => setEditing(true)}
              onSuspend={() => setConfirmingSuspend(true)}
              onResume={() => resume.mutate({ id: site.id, name: site.name })}
              resuming={resume.isPending}
              onDelete={confirmDelete}
            />
          </Panel>
        </DetailBody>
      </Tabs>

      <SiteDialog open={editing} onOpenChange={setEditing} site={site} />
      <DeployDialog open={deploying} onOpenChange={setDeploying} site={site} />
      <CertificateDialog
        open={issuingFor !== undefined}
        onOpenChange={(open) => {
          if (!open) setIssuingFor(undefined);
        }}
        defaultDomainId={issuingFor ?? site.domains[0]?.id ?? null}
        defaultServerId={site.server_id}
      />
      <DomainDialog
        open={attaching}
        onOpenChange={setAttaching}
        defaultSiteId={site.id}
        defaultServerId={site.server_id}
      />

      <ConfirmDialog
        open={confirmingSuspend}
        onOpenChange={setConfirmingSuspend}
        title={`Suspend ${site.name}?`}
        description={`${site.primary_domain ?? "The project"} stops answering until you resume it. Files, domains and certificates are kept.`}
        confirmLabel="Suspend project"
        destructive
        loading={suspend.isPending}
        onConfirm={() =>
          suspend.mutate(
            { id: site.id, name: site.name },
            { onSuccess: () => setConfirmingSuspend(false) },
          )
        }
      />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${site.name}?`}
        description={`${site.primary_domain ?? "The project"} stops answering and its server config is removed. Its files stay unless you tick the box below. Domains stay in Kaname with their DNS records and certificates.`}
        confirmText={site.name}
        confirmLabel="Delete project"
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { id: site.id, name: site.name, deleteWebroot },
            {
              onSuccess: () => {
                setConfirmingDelete(false);
                router.push("/");
              },
            },
          )
        }
      >
        <Checkbox
          checked={deleteWebroot}
          onChange={(event) => setDeleteWebroot(event.target.checked)}
          label="Also delete its files"
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

const IN_FLIGHT_REASON = "A deployment is already running";

function deploymentInFlight(site: Site): boolean {
  return (
    site.last_deployment !== null && DEPLOYMENT_IN_FLIGHT.includes(site.last_deployment.status)
  );
}

/** https only when the host can answer on it. */
function siteUrl(site: Site, host: string): string {
  const https = site.force_https || site.ssl?.status === "active";
  return `${https ? "https" : "http"}://${host}`;
}

/* ------------------------------ overview ---------------------------- */

/** One sentence under the name: what this site is doing right now. */
function SiteStatusLine({ site }: { site: Site }) {
  const tone = lineTone(siteStatusTone(site.status));
  const name = site.primary_domain ?? site.name;

  let sentence: string;
  switch (site.status) {
    case "provisioning":
      sentence = `Setting up ${name} on ${site.server_name}`;
      break;
    case "suspended":
      sentence = `Suspended on ${site.server_name} · ${name} is not answering`;
      break;
    case "error":
      sentence = `The last change to this project failed on ${site.server_name}`;
      break;
    default:
      sentence = `Serving ${name} from ${site.server_name}`;
  }

  return (
    <StatusLine tone={tone} pulse={site.status === "provisioning"}>
      {sentence}
    </StatusLine>
  );
}

function OverviewTab({
  site,
  canDeploy,
  onDeploy,
}: {
  site: Site;
  canDeploy: boolean;
  onDeploy: () => void;
}) {
  const deployments = useDeployments({
    site_id: site.id,
    per_page: 5,
    sort: "created_at",
    order: "desc",
  });

  return (
    <DetailLayout
      rail={
        <SectionCard title="Project" headingLevel={2}>
          <PropertyList dense labelWidth="sm">
            <PropertyRow label="Server">
              <Link
                href={`/infrastructure/servers/${site.server_id}`}
                className="kn-mono rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
              >
                {site.server_name}
              </Link>
            </PropertyRow>
            <PropertyRow label="Runtime">
              {RUNTIME_LABELS[site.runtime]}
              {site.runtime_version ? ` ${site.runtime_version}` : ""}
            </PropertyRow>
            <PropertyRow label="HTTPS">
              {site.ssl ? (
                <Expiry days={site.ssl.days_remaining} at={site.ssl.expires_at} />
              ) : (
                "None"
              )}
            </PropertyRow>
            <PropertyRow label="Created">
              <RelativeTime value={site.created_at} />
            </PropertyRow>
          </PropertyList>
        </SectionCard>
      }
    >
      <ProductionDeployment site={site} canDeploy={canDeploy} onDeploy={onDeploy} />

      <SectionCard
        title="Recent deployments"
        headingLevel={2}
        padded={false}
        actions={
          <PillLink href={`/websites/deployments?site_id=${site.id}`}>All deployments</PillLink>
        }
      >
        <DeploymentMiniTable query={deployments} />
      </SectionCard>
    </DetailLayout>
  );
}

/** What is live now: the newest deployment that succeeded, and where it answers. */
function ProductionDeployment({
  site,
  canDeploy,
  onDeploy,
}: {
  site: Site;
  canDeploy: boolean;
  onDeploy: () => void;
}) {
  const query = useDeployments({
    site_id: site.id,
    status: "succeeded",
    per_page: 1,
    sort: "created_at",
    order: "desc",
  });
  const live: Deployment | null = query.data?.data[0] ?? null;

  return (
    <SectionCard
      title="Production deployment"
      headingLevel={2}
      actions={
        live ? (
          <PillLink href={`/websites/deployments/${live.id}`}>Open deployment</PillLink>
        ) : undefined
      }
    >
      {query.isLoading ? (
        <Skeleton className="h-16 w-full" label="Loading the production deployment" />
      ) : query.isError ? (
        <PageError
          error={query.error}
          onRetry={() => void query.refetch()}
          context="Production deployment"
        />
      ) : (
        <div className="flex flex-col gap-3">
          <PropertyList dense labelWidth="sm">
            {live && (
              <>
                <PropertyRow label="Status">
                  <DeploymentStatusBadge status={live.status} />
                </PropertyRow>
                <PropertyRow label="Commit">
                  <CommitCell sha={live.commit_sha} message={live.commit_message} />
                </PropertyRow>
                <PropertyRow label="Branch" mono>
                  {live.branch ?? (live.source === "upload" ? "uploaded build" : "—")}
                </PropertyRow>
                <PropertyRow label="Deployed">
                  <RelativeTime value={live.finished_at ?? live.created_at} />
                  {` by ${live.triggered_by_name ?? live.commit_author ?? "automation"}`}
                </PropertyRow>
              </>
            )}
            <PropertyRow label="Domains">
              {site.domains.length > 0 ? (
                <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                  {site.domains.map((domain) => (
                    <a
                      key={domain.id}
                      href={siteUrl(site, domain.name)}
                      target="_blank"
                      rel="noreferrer"
                      className="kn-mono text-[var(--kn-accent-400)] hover:underline"
                    >
                      {domain.name}
                    </a>
                  ))}
                </span>
              ) : (
                "None yet"
              )}
            </PropertyRow>
            <PropertyRow label="Git">
              {site.repo_url ? (
                <MonoText truncate>{`${site.repo_url} · ${site.branch ?? "main"}`}</MonoText>
              ) : (
                "No repository connected"
              )}
            </PropertyRow>
          </PropertyList>

          {!live && (
            <EmptyState
              icon={Rocket}
              title="Not deployed yet"
              description={
                site.repo_url
                  ? `Deploy ${site.branch ?? "main"} to put it live.`
                  : "Connect a git repository in Settings, or deploy an uploaded build."
              }
              size="sm"
              action={
                canDeploy ? (
                  <Button variant="primary" size="sm" icon={Rocket} onClick={onDeploy}>
                    Deploy
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      )}
    </SectionCard>
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
      empty={<EmptyState title="Never deployed" description="No deployments yet." size="sm" />}
      className="rounded-none border-0"
    />
  );
}

/* ------------------------------- domains ---------------------------- */

function DomainsTab({
  site,
  onAttach,
  onIssue,
}: {
  site: Site;
  onAttach: () => void;
  onIssue: (domainId: string) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const canIssue = can("websites.ssl:write", site.server_id);
  const query = useDomains({ site_id: site.id, per_page: 100, sort: "name", order: "asc" });
  // Same query as CertificatesSection below, so it is fetched once.
  const certificates = useCertificates({
    server_id: site.server_id,
    per_page: 200,
    sort: "expires_at",
    order: "asc",
  });
  // Names any certificate on the host covers, so a www alias on the SANs counts.
  const certified = React.useMemo(
    () =>
      new Set(
        (certificates.data?.data ?? []).flatMap((certificate) => [
          certificate.subject,
          ...certificate.sans,
        ]),
      ),
    [certificates.data],
  );

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
      {
        id: "https",
        header: "HTTPS",
        width: 148,
        align: "right",
        cell: (domain) =>
          certified.has(domain.name) ? (
            "On"
          ) : certificates.isLoading ? null : (
            <Button
              variant="secondary"
              size="xs"
              icon={ShieldCheck}
              disabled={!canIssue}
              aria-label={`Issue certificate for ${domain.name}`}
              onClick={() => onIssue(domain.id)}
            >
              Issue certificate
            </Button>
          ),
      },
    ],
    [site.primary_domain, certified, certificates.isLoading, canIssue, onIssue],
  );

  return (
    <SectionCard
      title="Domains"
      caption="The addresses this project answers on."
      padded={false}
      headingLevel={2}
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
        label="Project domains"
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
            description="Add a domain so people can reach this project."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={Plus} arrow onClick={onAttach}>
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

/* ---------------------------- certificates -------------------------- */

function CertificatesSection({ site, onIssue }: { site: Site; onIssue: () => void }) {
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
      title="Certificates"
      caption="Issued for this project's domains."
      padded={false}
      headingLevel={2}
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
        label="Project certificates"
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
            description="HTTPS will not work until one is issued."
            size="sm"
            action={
              <Button variant="primary" size="sm" icon={ShieldCheck} arrow onClick={onIssue}>
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

function DeploymentsTab({
  site,
  inFlight,
  onDeploy,
}: {
  site: Site;
  inFlight: boolean;
  onDeploy: () => void;
}) {
  const router = useRouter();
  const can = useCan();
  const canDeploy = can("websites.deployments:exec", site.server_id) && !inFlight;
  const reason = inFlight ? IN_FLIGHT_REASON : undefined;
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
      caption="Newest first."
      padded={false}
      headingLevel={2}
      actions={
        <Button
          variant="secondary"
          size="xs"
          icon={Rocket}
          disabled={!canDeploy}
          title={reason}
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
            description="Each deploy pulls your branch and goes live when it succeeds."
            size="sm"
            action={
              <Button
                variant="primary"
                size="sm"
                icon={Rocket}
                arrow
                disabled={!canDeploy}
                title={reason}
                onClick={onDeploy}
              >
                Deploy this project
              </Button>
            }
          />
        }
        className="rounded-none border-0"
      />
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
      padded={false}
      headingLevel={2}
      actions={
        <PillLink
          href={`/logs?server_id=${site.server_id}${selected ? `&source=${encodeURIComponent(selected)}` : ""}`}
        >
          Open in Logs
        </PillLink>
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
          title="No logs found"
          description="This server has no web server log Kaname can read yet."
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

/* ------------------------------- settings --------------------------- */

interface SettingsTabProps {
  site: Site;
  /** Scoped accounts cannot set a repository, so they get no Git section. */
  operator: boolean;
  onEdit: () => void;
  onSuspend: () => void;
  onResume: () => void;
  resuming: boolean;
  onDelete: () => void;
}

function SettingsTab({
  site,
  operator,
  onEdit,
  onSuspend,
  onResume,
  resuming,
  onDelete,
}: SettingsTabProps) {
  const can = useCan();
  const writable = can("websites.sites:write", site.server_id);
  const suspended = site.status === "suspended";

  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-4">
      {operator && <GitSettings site={site} writable={writable} />}

      <SectionCard
        title="General"
        headingLevel={2}
        actions={
          <Button variant="secondary" size="xs" icon={Pencil} disabled={!writable} onClick={onEdit}>
            Edit
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <PropertyList dense labelWidth="sm">
            <PropertyRow label="Name" mono>
              {site.name}
            </PropertyRow>
            <PropertyRow label="Primary domain" mono>
              {site.primary_domain}
            </PropertyRow>
            <PropertyRow label="Runtime">
              {RUNTIME_LABELS[site.runtime]}
              {site.runtime_version ? ` ${site.runtime_version}` : ""}
            </PropertyRow>
            <PropertyRow label="Folder" mono copyValue={site.webroot}>
              {site.webroot}
            </PropertyRow>
            {site.upstream && (
              <PropertyRow label="Proxies to" mono copyValue={site.upstream}>
                {site.upstream}
              </PropertyRow>
            )}
            {site.php_version && (
              <PropertyRow label="PHP version" mono>
                {site.php_version}
              </PropertyRow>
            )}
            <PropertyRow label="Runs as" mono>
              {site.owner}
            </PropertyRow>
            <PropertyRow label="Redirect to HTTPS">{site.force_https ? "Yes" : "No"}</PropertyRow>
            {site.config_path && (
              <PropertyRow label="Config file" mono copyValue={site.config_path}>
                {site.config_path}
              </PropertyRow>
            )}
            <PropertyRow label="Last checked">
              <RelativeTime value={site.last_synced_at} fallback="never" />
            </PropertyRow>
          </PropertyList>
          <div>
            <PillLink
              href={`/files/manager?server_id=${site.server_id}&path=${encodeURIComponent(site.webroot)}`}
            >
              Open in File Manager
            </PillLink>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Danger zone" headingLevel={2}>
        <div className="flex flex-col divide-y divide-[var(--kn-border-subtle)]">
          <DangerRow
            title={suspended ? "Resume this project" : "Suspend this project"}
            description={
              suspended
                ? "Puts it back online as it was."
                : "Takes it offline. Files, domains and certificates are kept."
            }
          >
            {suspended ? (
              <Button
                variant="secondary"
                size="sm"
                icon={PlayCircle}
                loading={resuming}
                disabled={!writable}
                onClick={onResume}
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={PauseCircle}
                disabled={!writable || site.status === "provisioning"}
                onClick={onSuspend}
              >
                Suspend
              </Button>
            )}
          </DangerRow>
          <DangerRow
            title="Delete this project"
            description="Removes its server config. You can also delete its files."
          >
            <Button
              variant="danger"
              size="sm"
              icon={Trash2}
              disabled={!can("websites.sites:delete", site.server_id)}
              onClick={onDelete}
            >
              Delete
            </Button>
          </DangerRow>
        </div>
      </SectionCard>
    </div>
  );
}

function DangerRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-medium text-[var(--kn-text)]">{title}</p>
        <p className="text-sm text-[var(--kn-text-3)]">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Repository and branch, saved with PATCH; an empty field clears it. */
function GitSettings({ site, writable }: { site: Site; writable: boolean }) {
  const client = useQueryClient();
  const update = useUpdateSite(site.id);
  const [saved, setSaved] = React.useState({
    repoUrl: site.repo_url ?? "",
    branch: site.branch ?? "",
  });
  const [repoUrl, setRepoUrl] = React.useState(site.repo_url ?? "");
  const [branch, setBranch] = React.useState(site.branch ?? "");

  React.useEffect(() => {
    setSaved({ repoUrl: site.repo_url ?? "", branch: site.branch ?? "" });
    setRepoUrl(site.repo_url ?? "");
    setBranch(site.branch ?? "");
  }, [site.repo_url, site.branch]);

  const errors = fieldErrors(update.error);
  const dirty = repoUrl.trim() !== saved.repoUrl || branch.trim() !== saved.branch;

  return (
    <SectionCard
      title="Git"
      description="Each deploy pulls this branch. Build steps are not run yet."
      headingLevel={2}
    >
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const next = { repoUrl: repoUrl.trim(), branch: branch.trim() };
          update.mutate(
            { repo_url: next.repoUrl || null, branch: next.branch || null },
            {
              onSuccess: () => {
                setSaved(next);
                setRepoUrl(next.repoUrl);
                setBranch(next.branch);
                // The row is written before the job runs, so refetch now.
                invalidateFamilies(client, ["sites"]);
              },
            },
          );
        }}
      >
        {update.error != null && !errors["repo_url"] && !errors["branch"] && (
          <PageError error={update.error} />
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FormField label="Repository URL" error={errors["repo_url"]}>
            <Input
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="https://github.com/you/site.git"
              disabled={!writable}
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Branch" error={errors["branch"]}>
            <Input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="main"
              disabled={!writable}
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        </div>
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={update.isPending}
            disabled={!writable || !dirty}
          >
            Save
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
