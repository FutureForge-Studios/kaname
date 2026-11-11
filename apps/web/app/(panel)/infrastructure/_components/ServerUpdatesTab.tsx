"use client";

import * as React from "react";
import { ArrowUpCircle, PackageCheck, Power, RefreshCw, ShieldAlert } from "lucide-react";
import type { OsPackageUpdate, Server, ServerOsUpdates } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  MonoText,
  NumberedSection,
  RelativeTime,
  SectionCard,
  Skeleton,
  StatusLine,
  Switch,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useCan } from "@/lib/queries";
import { formatCount } from "@/lib/format";
import {
  useOsUpdateSettings,
  useRefreshOsUpdates,
  useServerOsUpdates,
  useUpgradeOsPackages,
  useUpgradesInFlight,
} from "@/lib/system-updates";
import { JobActivityBar } from "../../_components/JobActivity";

/* ------------------------------------------------------------------ *
 * System updates — the host's own packages.
 *
 * What is shown is the control plane's last read of the package
 * manager, with its age; checking again is one click and talks to the
 * host, reading the tab never does. Upgrading is a job (the drawer and
 * the strip below carry it), and a reboot the upgrade asks for stays
 * on screen until the host has actually booted.
 * ------------------------------------------------------------------ */

const PACKAGE_JOB_TYPES = ["system.packages."] as const;

export interface ServerUpdatesTabProps {
  server: Server;
  /** Opens the page's existing reboot confirmation. */
  onReboot: () => void;
}

type Pending = { securityOnly: boolean } | null;

export function ServerUpdatesTab({ server, onReboot }: ServerUpdatesTabProps) {
  const can = useCan();
  const query = useServerOsUpdates(server.id);
  const refresh = useRefreshOsUpdates();
  const upgrade = useUpgradeOsPackages();
  const settings = useOsUpdateSettings();
  const inFlight = useUpgradesInFlight().has(server.id);
  const [pending, setPending] = React.useState<Pending>(null);

  const write = can("infra.servers:write", server.id);
  const connected = server.connection === "connected";
  const check = () => refresh.mutate({ serverId: server.id });

  const columns = React.useMemo<DataTableColumn<OsPackageUpdate>[]>(
    () => [
      {
        id: "name",
        header: "Package",
        mono: true,
        locked: true,
        minWidth: 180,
        accessor: (p) => p.name,
      },
      {
        id: "versions",
        header: "Installed → candidate",
        minWidth: 280,
        cell: (p) => (
          <span className="flex min-w-0 items-center gap-2">
            <MonoText muted truncate className="min-w-0 text-sm">
              {p.installed_version}
            </MonoText>
            <span aria-hidden className="shrink-0 text-[var(--kn-text-3)]">
              →
            </span>
            <span className="sr-only">to</span>
            <MonoText truncate className="min-w-0 text-sm">
              {p.available_version}
            </MonoText>
          </span>
        ),
      },
      {
        id: "security",
        header: "Kind",
        width: 112,
        align: "right",
        cell: (p) =>
          p.security ? (
            <Badge tone="warn" size="xs">
              security
            </Badge>
          ) : (
            <span className="text-xs text-[var(--kn-text-3)]">update</span>
          ),
      },
    ],
    [],
  );

  if (query.isLoading) return <Skeleton className="h-64" label="Loading system updates" />;
  if (query.isError || !query.data) {
    return (
      <PageError
        error={query.error ?? new Error("No answer from the control plane.")}
        onRetry={() => void query.refetch()}
        context="System updates"
      />
    );
  }

  const data = query.data;
  const disabledReason = !write
    ? "This account cannot upgrade packages on this server."
    : !connected
      ? `${server.name}'s agent is not connected.`
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <NumberedSection
        index={1}
        title="Pending updates"
        caption="From the host's package manager, cached by Kaname."
        actions={
          data.total > 0 && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                icon={ShieldAlert}
                disabled={Boolean(disabledReason) || data.security === 0 || inFlight}
                onClick={() => setPending({ securityOnly: true })}
              >
                Security only
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={ArrowUpCircle}
                disabled={Boolean(disabledReason) || inFlight}
                loading={inFlight}
                onClick={() => setPending({ securityOnly: false })}
              >
                Upgrade all
              </Button>
            </div>
          )
        }
      >
        <CheckedLine
          data={data}
          connected={connected}
          checking={refresh.isPending}
          upgrading={inFlight}
          onCheck={check}
        />

        {data.reboot_required && (
          <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--kn-r-lg)] border border-[var(--kn-warn-soft)] bg-[var(--kn-warn-soft)] py-1.5 pl-3 pr-1.5">
            <StatusLine tone="warn" className="min-w-0 flex-1">
              Reboot required — the last upgrade
              {data.last_upgrade_at && (
                <>
                  {" "}
                  (<RelativeTime value={data.last_upgrade_at} />)
                </>
              )}{" "}
              replaced something the running system still uses.
            </StatusLine>
            <Button
              variant="secondary"
              size="xs"
              icon={Power}
              disabled={!write || !connected}
              onClick={onReboot}
            >
              Reboot…
            </Button>
          </div>
        )}

        {disabledReason && data.total > 0 && (
          <p className="text-xs text-[var(--kn-text-3)]">{disabledReason}</p>
        )}

        <PackagesBody
          data={data}
          columns={columns}
          server={server}
          connected={connected}
          checking={refresh.isPending}
          onCheck={check}
        />

        <JobActivityBar types={PACKAGE_JOB_TYPES} title="Package upgrades" />
      </NumberedSection>

      <NumberedSection
        index={2}
        title="Automatic security updates"
        caption="Checked every six hours; applied at most once a day."
      >
        <SectionCard>
          <Switch
            checked={data.auto_security}
            disabled={!write || settings.isPending}
            onChange={(event) =>
              settings.mutate({ serverId: server.id, autoSecurity: event.currentTarget.checked })
            }
            label="Apply security updates automatically"
            description="Only packages the package manager marks as security fixes. Other updates and reboots stay manual; a reboot the upgrade needs is shown above."
          />
        </SectionCard>
      </NumberedSection>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.securityOnly
            ? `Apply ${formatCount(data.security)} security ${data.security === 1 ? "update" : "updates"} on ${server.name}`
            : `Upgrade ${formatCount(data.total)} ${data.total === 1 ? "package" : "packages"} on ${server.name}`
        }
        confirmLabel={pending?.securityOnly ? "Apply security updates" : "Upgrade all"}
        destructive={false}
        loading={upgrade.isPending}
        onConfirm={() => {
          if (!pending) return;
          upgrade.mutate({
            serverId: server.id,
            serverName: server.name,
            securityOnly: pending.securityOnly,
          });
          setPending(null);
        }}
      >
        <div className="flex flex-col gap-2 text-[var(--kn-text-2)]">
          <p>
            Runs the host&apos;s package manager non-interactively, keeping existing configuration
            files. Services whose packages change may restart while it runs.
          </p>
          <p>
            The output streams into the job drawer. If the upgrade replaces the kernel or a core
            library, the server is marked as needing a reboot — Kaname never reboots it for you.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

function CheckedLine({
  data,
  connected,
  checking,
  upgrading,
  onCheck,
}: {
  data: ServerOsUpdates;
  connected: boolean;
  checking: boolean;
  upgrading: boolean;
  onCheck: () => void;
}) {
  const tone: Tone =
    data.state === "error"
      ? "danger"
      : data.security > 0
        ? "warn"
        : data.total > 0
          ? "info"
          : data.state === "current"
            ? "ok"
            : "neutral";

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] py-1.5 pl-3 pr-1.5">
      <StatusLine tone={tone} pulse={upgrading} className="min-w-0 flex-1">
        {upgrading ? (
          "Upgrading now — follow it in the job drawer."
        ) : data.state === "unknown" ? (
          "Not checked yet."
        ) : data.state === "unsupported" ? (
          "No supported package manager on this host."
        ) : data.state === "error" ? (
          <>The last check failed: {data.error}</>
        ) : data.total === 0 ? (
          "Up to date."
        ) : (
          <>
            {formatCount(data.total)} {data.total === 1 ? "update" : "updates"} pending
            {data.security > 0 && (
              <>
                {" · "}
                <span className="text-[var(--kn-warn)]">{formatCount(data.security)} security</span>
              </>
            )}
          </>
        )}
        {data.checked_at && (
          <span className="text-[var(--kn-text-3)]">
            {" · checked "}
            <RelativeTime value={data.checked_at} />
          </span>
        )}
      </StatusLine>
      <Button
        variant="secondary"
        size="xs"
        icon={RefreshCw}
        disabled={!connected || checking}
        loading={checking}
        onClick={onCheck}
      >
        Check now
      </Button>
    </div>
  );
}

function PackagesBody({
  data,
  columns,
  server,
  connected,
  checking,
  onCheck,
}: {
  data: ServerOsUpdates;
  columns: DataTableColumn<OsPackageUpdate>[];
  server: Server;
  connected: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  if (data.state === "unknown") {
    return (
      <EmptyState
        icon={PackageCheck}
        title="No package list yet"
        description={
          connected
            ? "Kaname reads it in the background every six hours, or now if you ask."
            : `It is read once ${server.name}'s agent connects.`
        }
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={!connected || checking}
            loading={checking}
            onClick={onCheck}
          >
            Check now
          </Button>
        }
      />
    );
  }

  if (data.state === "unsupported") {
    return (
      <EmptyState
        icon={PackageCheck}
        title="Package updates are not managed here"
        description="The agent drives apt, dnf, yum, apk and pacman; this host has none of them."
      />
    );
  }

  return (
    <SectionCard padded={false}>
      <DataTable<OsPackageUpdate>
        columns={columns}
        rows={data.packages}
        getRowId={(p) => p.name}
        label={`Pending package updates on ${server.name}`}
        density="compact"
        columnVisibility={false}
        empty={
          <EmptyState
            icon={PackageCheck}
            title="Nothing to install"
            description="Every package is at the newest version the host's repositories offer."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}
