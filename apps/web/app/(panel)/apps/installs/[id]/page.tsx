"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, ScrollText, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  CheckItem,
  CheckList,
  ErrorState,
  NumberedSection,
  PageBody,
  PageHeader,
  PropertyList,
  PropertyRow,
  RelativeTime,
  Skeleton,
  useToast,
} from "@kaname/ui";
import { AppMark, versionLabel } from "@/components/installer/AppMark";
import { InstallProgress, InstallSummary } from "@/components/installer/InstallProgress";
import { UninstallDialog } from "@/components/installer/InstalledList";
import { IN_FLIGHT, useAppInstall, useUninstallApp } from "@/components/installer/queries";
import { useCan } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * One install: the live checklist while the job runs, then what to do
 * next and what it created. The raw job log stays one click away for
 * whoever wants it; the checklist is the version for everyone else.
 * ------------------------------------------------------------------ */

export default function AppInstallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = React.use(params);
  const router = useRouter();
  const can = useCan();
  const { toast } = useToast();
  const query = useAppInstall(id);
  const uninstall = useUninstallApp();
  const [confirming, setConfirming] = React.useState(false);

  const back = (
    <Button size="sm" icon={ArrowLeft} onClick={() => router.push("/apps/installed")}>
      Installed
    </Button>
  );

  if (query.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader eyebrow="Apps" title="Install" actions={back} />
        <PageBody width="prose">
          <Skeleton className="h-64 w-full" label="Loading install" />
        </PageBody>
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader eyebrow="Apps" title="Install" actions={back} />
        <PageBody width="prose">
          {query.error && (
            <ErrorState
              code={query.error.code}
              message={query.error.message}
              remediation={query.error.remediation}
            />
          )}
        </PageBody>
      </div>
    );
  }

  const install = query.data;
  const busy = IN_FLIGHT.has(install.status);
  const nothingLeft =
    install.status === "failed" &&
    !install.site_id &&
    !install.database_id &&
    !install.db_user_id &&
    !install.certificate_id;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Apps"
        title={`${install.app_name} on ${install.domain}`}
        subtitle={`${install.server_name} · ${versionLabel(install.app_version)}`}
        status={<InstallSummary install={install} />}
        actions={
          <>
            {back}
            {install.job_id && (
              <Button size="sm" icon={ScrollText} onClick={() => router.push(`/jobs/${install.job_id}`)}>
                Job log
              </Button>
            )}
            {can("apps.installs:delete", install.server_id) && !busy && (
              <Button size="sm" variant="danger-subtle" icon={Trash2} onClick={() => setConfirming(true)}>
                {nothingLeft ? "Dismiss" : "Uninstall"}
              </Button>
            )}
            {install.status === "active" && (
              <Button
                size="sm"
                variant="primary"
                iconRight={ExternalLink}
                onClick={() => window.open(install.url, "_blank", "noopener,noreferrer")}
              >
                Open site
              </Button>
            )}
          </>
        }
      />
      <PageBody width="prose">
        <NumberedSection
          index={1}
          title="Progress"
          caption={busy ? "Updates live as each step finishes." : "Last change"}
          actions={
            !busy ? (
              <span className="kn-mono text-xs text-[var(--kn-text-3)]">
                <RelativeTime value={install.updated_at} />
              </span>
            ) : undefined
          }
        >
          <Card radius="xl" padding="md" className="flex gap-4">
            <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] text-[var(--kn-accent-400)] sm:flex">
              <AppMark appId={install.app_id} size={32} />
            </span>
            <InstallProgress install={install} className="min-w-0 flex-1" />
          </Card>
          {install.status === "failed" && install.error && (
            <ErrorState
              code={install.error.code}
              message={install.error.message}
              remediation={{
                summary: nothingLeft
                  ? "Everything this install created was undone. Fix the cause and install again."
                  : "Some of what it created could not be undone. Uninstall to remove what is left.",
                actions: [{ label: "Try again", href: `/apps/install/${install.app_id}` }],
              }}
            />
          )}
        </NumberedSection>

        {install.status === "active" && (
          <NumberedSection index={2} title="Next" caption="One thing left for you.">
            <CheckList divided>
              <CheckItem
                state="current"
                title={install.finish}
                description={install.url}
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    arrow
                    onClick={() => window.open(install.url, "_blank", "noopener,noreferrer")}
                  >
                    Open
                  </Button>
                }
              />
            </CheckList>
          </NumberedSection>
        )}

        <NumberedSection
          index={install.status === "active" ? 3 : 2}
          title="What it created"
          caption="Each is an ordinary resource you can manage on its own."
        >
          <Card radius="xl" padding="md">
            <PropertyList dense>
              <PropertyRow label="Address" mono>
                {install.url}
              </PropertyRow>
              <PropertyRow label="Website">
                {install.site_id ? (
                  <ResourceLink href={`/websites/sites/${install.site_id}`}>{install.domain}</ResourceLink>
                ) : null}
              </PropertyRow>
              {install.app_port !== null && (
                <PropertyRow label="Containers" mono>
                  <ResourceLink href="/infrastructure/containers">127.0.0.1:{install.app_port}</ResourceLink>
                </PropertyRow>
              )}
              <PropertyRow label="Database" mono>
                {install.database_id ? (
                  <ResourceLink href={install.db_engine === "postgres" ? "/databases/postgres" : "/databases/mysql"}>
                    {install.db_engine ?? "database"}
                  </ResourceLink>
                ) : null}
              </PropertyRow>
              <PropertyRow label="Certificate">
                {install.certificate_id ? (
                  <ResourceLink href="/websites/ssl">Let&apos;s Encrypt</ResourceLink>
                ) : install.ssl ? null : (
                  "HTTPS not requested"
                )}
              </PropertyRow>
              <PropertyRow label="Installed by">{install.created_by_name}</PropertyRow>
            </PropertyList>
          </Card>
        </NumberedSection>
      </PageBody>

      {confirming && (
        <UninstallDialog
          install={install}
          dismissOnly={nothingLeft}
          loading={uninstall.isPending}
          onOpenChange={setConfirming}
          onConfirm={() =>
            uninstall.mutate(install, {
              onSuccess: (job) => {
                setConfirming(false);
                if (job) void query.refetch();
                else {
                  toast({ variant: "success", title: `Dismissed ${install.app_name} on ${install.domain}` });
                  router.push("/apps/installed");
                }
              },
              onError: (error) =>
                toast({ variant: "error", title: error.message, description: error.remediation?.summary }),
            })
          }
        />
      )}
    </div>
  );
}

function ResourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
    >
      {children}
    </Link>
  );
}
