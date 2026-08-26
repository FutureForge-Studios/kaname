"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, GitBranch, Globe, MoreHorizontal, RotateCcw, Rocket, ScrollText } from "lucide-react";
import type { Deployment } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DetailLayout,
  DropdownMenu,
  EmptyState,
  IconButton,
  LogViewer,
  MenuItem,
  MenuSeparator,
  MonoText,
  Progress,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatDuration } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { DeployDialog } from "../../_components/DeployDialog";
import { DetailBody, DetailFailed, DetailLoading } from "../../_components/detail";
import {
  useCancelDeployments,
  useDeployment,
  useRollbackDeployment,
  useSite,
} from "../../_components/queries";
import { useDeploymentLog } from "../../_components/useDeploymentLog";
import {
  DEPLOYMENT_IN_FLIGHT,
  DeploymentStatusBadge,
  HostAxes,
  shortSha,
  useServerById,
} from "../../_components/status";

/* ------------------------------------------------------------------ *
 * Deployment detail.
 *
 * The page is the build log. Everything else — which site, which
 * revision, who asked for it — is identity in the rail; the reason
 * anybody opens this URL is to watch a build or to read why one failed,
 * so the log gets the column and the stream stays open until the run
 * ends.
 * ------------------------------------------------------------------ */

export default function DeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const can = useCan();

  const query = useDeployment(id);
  const deployment = query.data ?? null;
  const site = useSite(deployment?.site_id);
  const server = useServerById(site.data?.server_id);

  const rollback = useRollbackDeployment();
  const cancel = useCancelDeployments();

  const [redeploying, setRedeploying] = React.useState(false);
  const [confirmingRollback, setConfirmingRollback] = React.useState(false);

  const log = useDeploymentLog(deployment?.id ?? null, Boolean(deployment?.log_available));

  if (query.isLoading) return <DetailLoading />;
  if (query.isError || !deployment) {
    return (
      <DetailFailed
        error={query.error}
        onRetry={() => void query.refetch()}
        context="Deployment"
        title="Deployment"
      />
    );
  }

  const status = log.status ?? deployment.status;
  const running = DEPLOYMENT_IN_FLIGHT.includes(status);
  const executable = can("websites.deployments:exec", site.data?.server_id ?? null);
  const label = shortSha(deployment.commit_sha) ?? deployment.site_name;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <ResourceHeader
          name={shortSha(deployment.commit_sha) ?? "Deployment"}
          identity={`${deployment.site_name}${deployment.branch ? ` · ${deployment.branch}` : ""}`}
          connection={server?.connection}
          lastSeenAt={server?.last_seen_at}
          health={server?.health}
          healthReasons={server?.health_reasons}
          badges={
            <>
              <DeploymentStatusBadge status={status} />
              <Badge tone="neutral" size="xs">
                {deployment.source === "git" ? "Git" : "Upload"}
              </Badge>
            </>
          }
          actions={
            <>
              {running && deployment.job_id && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Ban}
                  loading={cancel.isPending}
                  disabled={!executable}
                  onClick={() => cancel.mutate([{ id: deployment.job_id as string, label }])}
                >
                  Cancel run
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                icon={RotateCcw}
                disabled={!executable || deployment.status !== "succeeded"}
                title={
                  deployment.status === "succeeded"
                    ? undefined
                    : "Only a run that finished has a release to go back to."
                }
                onClick={() => setConfirmingRollback(true)}
              >
                Roll back to this
              </Button>
            </>
          }
          menu={
            <DropdownMenu
              trigger={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
              placement="bottom-end"
              label="Deployment actions"
            >
              <MenuItem
                icon={Globe}
                onSelect={() => router.push(`/websites/sites/${deployment.site_id}`)}
              >
                Open the site
              </MenuItem>
              <MenuItem
                icon={Rocket}
                disabled={!executable || deployment.commit_sha === null}
                onSelect={() => setRedeploying(true)}
              >
                Deploy this revision again
              </MenuItem>
              {deployment.job_id && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={ScrollText}
                    onSelect={() => router.push(`/jobs/${deployment.job_id}`)}
                  >
                    Open the job
                  </MenuItem>
                </>
              )}
            </DropdownMenu>
          }
        />

        <DetailBody>
          <DetailLayout
            rail={
              <SectionCard title="Run" headingLevel={3}>
                <PropertyList dense labelWidth="sm">
                  <PropertyRow label="Site">
                    <Link
                      href={`/websites/sites/${deployment.site_id}`}
                      className="rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
                    >
                      {deployment.site_name}
                    </Link>
                  </PropertyRow>
                  <PropertyRow label="Server">
                    <HostAxes server={server} fallbackName={site.data?.server_name ?? null} />
                  </PropertyRow>
                  <PropertyRow label="Source">
                    {deployment.source === "git" ? "Git repository" : "Uploaded build"}
                  </PropertyRow>
                  <PropertyRow label="Repository" mono copyValue={deployment.repo_url ?? undefined}>
                    {deployment.repo_url}
                  </PropertyRow>
                  <PropertyRow label="Branch" mono>
                    {deployment.branch}
                  </PropertyRow>
                  <PropertyRow
                    label="Commit"
                    mono
                    copyValue={deployment.commit_sha ?? undefined}
                    hint="The full object id this release was built from."
                  >
                    {shortSha(deployment.commit_sha)}
                  </PropertyRow>
                  <PropertyRow label="Author">{deployment.commit_author}</PropertyRow>
                  <PropertyRow label="Triggered by">
                    {deployment.triggered_by_name ?? "Automation"}
                  </PropertyRow>
                  <PropertyRow label="Started">
                    <RelativeTime value={deployment.started_at} fallback="not started" />
                  </PropertyRow>
                  <PropertyRow label="Finished">
                    <RelativeTime value={deployment.finished_at} fallback="—" />
                  </PropertyRow>
                  <PropertyRow label="Duration">
                    {deployment.duration_ms == null ? null : formatDuration(deployment.duration_ms)}
                  </PropertyRow>
                </PropertyList>
              </SectionCard>
            }
          >
            <CommitCard deployment={deployment} />

            <SectionCard
              title="Build log"
              icon={ScrollText}
              padded={false}
              headingLevel={3}
              actions={<LogStateBadge state={log.state} />}
              footer={
                deployment.finished_at ? (
                  <span>Finished {formatDateTime(deployment.finished_at)}</span>
                ) : undefined
              }
            >
              {log.progress != null && (
                <Progress
                  value={log.progress}
                  size="sm"
                  tone={status === "failed" ? "danger" : "accent"}
                  label="Build progress"
                />
              )}

              {log.state === "expired" && (
                <EmptyState
                  icon={ScrollText}
                  title="This build log has aged out"
                  description="Kaname keeps job logs for a bounded window. The deployment record survives; its output does not."
                  size="sm"
                />
              )}

              {log.state === "error" && (
                <div className="p-4">
                  <PageError
                    error={
                      new ApiError({
                        code: "network_error",
                        status: 0,
                        message: `The connection to the build log for ${label} dropped.`,
                        remediation: {
                          summary:
                            "Reconnecting replays the log from its first line, so Kaname does not reattach on its own and duplicate what you have already read.",
                          actions: [],
                        },
                      })
                    }
                    onRetry={log.retry}
                  />
                </div>
              )}

              {log.state !== "expired" && (
                <LogViewer
                  lines={log.lines}
                  height={560}
                  emptyLabel={
                    log.state === "connecting"
                      ? "Connecting to the build log."
                      : running
                        ? "Waiting for the agent to report."
                        : "This run produced no output."
                  }
                  label={`${label} build log`}
                />
              )}
            </SectionCard>
          </DetailLayout>
        </DetailBody>
      </div>

      <DeployDialog
        open={redeploying}
        onOpenChange={setRedeploying}
        site={site.data ?? null}
        commitSha={deployment.commit_sha}
      />

      <ConfirmDialog
        open={confirmingRollback}
        onOpenChange={setConfirmingRollback}
        title="Roll back to this release?"
        description={`${deployment.site_name} will be pointed back at the release directory this run wrote. The rollback is itself a deployment, so it appears in the history.`}
        confirmLabel="Roll back"
        loading={rollback.isPending}
        onConfirm={() =>
          rollback.mutate(
            { id: deployment.id, label },
            { onSuccess: () => setConfirmingRollback(false) },
          )
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ */

function CommitCard({ deployment }: { deployment: Deployment }) {
  if (!deployment.commit_sha && !deployment.commit_message) {
    return (
      <SectionCard title="Revision" icon={GitBranch} headingLevel={3}>
        <p className="text-[var(--kn-text-2)]">
          This release came from an uploaded build, so there is no revision to attribute it to.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Revision"
      icon={GitBranch}
      headingLevel={3}
      actions={
        deployment.commit_sha ? (
          <MonoText muted className="text-xs">
            {deployment.commit_sha}
          </MonoText>
        ) : undefined
      }
    >
      <p className="whitespace-pre-wrap text-[var(--kn-text)]">
        {deployment.commit_message ?? "No commit message"}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--kn-text-2)]">
        {deployment.commit_author && <span>{deployment.commit_author}</span>}
        {deployment.branch && (
          <>
            <span aria-hidden>·</span>
            <MonoText muted>{deployment.branch}</MonoText>
          </>
        )}
        {deployment.repo_url && (
          <>
            <span aria-hidden>·</span>
            <MonoText muted className="min-w-0 break-all">
              {deployment.repo_url}
            </MonoText>
          </>
        )}
      </p>
    </SectionCard>
  );
}

function LogStateBadge({ state }: { state: ReturnType<typeof useDeploymentLog>["state"] }) {
  switch (state) {
    case "connecting":
      return (
        <Badge tone="neutral" size="xs">
          Connecting
        </Badge>
      );
    case "streaming":
      return (
        <Badge tone="accent" size="xs">
          Streaming
        </Badge>
      );
    case "expired":
      return (
        <Badge tone="neutral" size="xs">
          Expired
        </Badge>
      );
    case "error":
      return (
        <Badge tone="danger" size="xs">
          Disconnected
        </Badge>
      );
    default:
      return (
        <Badge tone="neutral" size="xs">
          Complete
        </Badge>
      );
  }
}
