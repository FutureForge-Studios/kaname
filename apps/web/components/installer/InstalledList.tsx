"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, PackageCheck, Trash2 } from "lucide-react";
import type { AppInstall } from "@kaname/contract";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  MonoLabel,
  RelativeTime,
  Skeleton,
  StatusBadge,
  useToast,
} from "@kaname/ui";
import { useCan } from "@/lib/queries";
import { AppMark, versionLabel } from "./AppMark";
import { INSTALL_STATUS } from "./InstallProgress";
import { IN_FLIGHT, useAppInstalls, useUninstallApp } from "./queries";

/* ------------------------------------------------------------------ *
 * Installed apps: one row per install, the address to open, its state,
 * and the one destructive action. Uninstall names everything it will
 * delete and asks for the domain to be typed, because it takes the
 * database with it.
 * ------------------------------------------------------------------ */

export function InstalledList() {
  const router = useRouter();
  const can = useCan();
  const { toast } = useToast();
  const installs = useAppInstalls();
  const uninstall = useUninstallApp();
  const [target, setTarget] = React.useState<AppInstall | null>(null);

  if (installs.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" label="Loading installed apps" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (installs.isError) {
    return (
      <ErrorState
        code={installs.error.code}
        message={installs.error.message}
        remediation={installs.error.remediation}
      />
    );
  }

  const rows = installs.data?.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={PackageCheck}
        title="No apps installed yet"
        description="Pick one from the catalog; it takes a minute or two."
        action={
          <Button variant="primary" arrow onClick={() => router.push("/apps")}>
            Browse the catalog
          </Button>
        }
      />
    );
  }

  const failedNothingLeft = (row: AppInstall) =>
    row.status === "failed" &&
    !row.site_id &&
    !row.database_id &&
    !row.db_user_id &&
    !row.certificate_id;

  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Installed apps">
        {rows.map((row) => {
          const status = INSTALL_STATUS[row.status];
          const busy = IN_FLIGHT.has(row.status);
          return (
            <li key={row.id} data-testid={`install-row-${row.id}`}>
              <Card radius="lg" padding="sm" className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] text-[var(--kn-accent-400)]">
                  <AppMark appId={row.app_id} size={28} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/apps/installs/${row.id}`}
                      className="kn-title text-md text-[var(--kn-text)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
                    >
                      {row.app_name}
                    </Link>
                    <StatusBadge size="xs" tone={status.tone} pulse={busy}>
                      {status.label}
                    </StatusBadge>
                  </div>
                  <p className="kn-mono m-0 mt-0.5 truncate text-xs text-[var(--kn-text-3)]">
                    {row.domain} · {row.server_name} · {versionLabel(row.app_version)}
                  </p>
                </div>
                <MonoLabel size="xs" tone="subtle" className="hidden sm:inline">
                  <RelativeTime value={row.created_at} />
                </MonoLabel>
                <div className="flex shrink-0 items-center gap-1">
                  {row.status === "active" && (
                    <Button
                      size="xs"
                      iconRight={ExternalLink}
                      onClick={() => window.open(row.url, "_blank", "noopener,noreferrer")}
                    >
                      Open
                    </Button>
                  )}
                  <Button size="xs" arrow onClick={() => router.push(`/apps/installs/${row.id}`)}>
                    {busy ? "Progress" : "Details"}
                  </Button>
                  {can("apps.installs:delete", row.server_id) && (
                    <IconButton
                      icon={Trash2}
                      size="xs"
                      label={failedNothingLeft(row) ? `Dismiss ${row.app_name}` : `Uninstall ${row.app_name}`}
                      disabled={busy}
                      onClick={() => setTarget(row)}
                    />
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {target && (
        <UninstallDialog
          install={target}
          dismissOnly={failedNothingLeft(target)}
          loading={uninstall.isPending}
          onOpenChange={(open) => !open && setTarget(null)}
          onConfirm={() =>
            uninstall.mutate(target, {
              onSuccess: (job) => {
                setTarget(null);
                if (job) router.push(`/apps/installs/${target.id}`);
                else toast({ variant: "success", title: `Dismissed ${target.app_name} on ${target.domain}` });
              },
              onError: (error) =>
                toast({ variant: "error", title: error.message, description: error.remediation?.summary }),
            })
          }
        />
      )}
    </>
  );
}

export function UninstallDialog({
  install,
  dismissOnly,
  loading,
  onOpenChange,
  onConfirm,
}: {
  install: AppInstall;
  dismissOnly: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  if (dismissOnly) {
    return (
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title={`Dismiss ${install.app_name} on ${install.domain}?`}
        description="This install failed and left nothing on the server. Dismissing it removes it from the list."
        confirmLabel="Dismiss"
        destructive={false}
        loading={loading}
        onConfirm={onConfirm}
      />
    );
  }
  const gone = [
    "the website and its configuration",
    install.app_port !== null ? "its containers, their network and their data" : "the app's files",
    install.database_id ? "its database and database user" : null,
    install.certificate_id ? "its HTTPS certificate" : null,
  ].filter(Boolean);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Uninstall ${install.app_name}?`}
      description={`This deletes ${gone.join(", ")} for ${install.domain}. Take a backup first if you need the content.`}
      confirmText={install.domain}
      confirmLabel="Uninstall"
      destructive
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
