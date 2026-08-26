"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import type { Server, Service } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  DetailLayout,
  DropdownMenu,
  IconButton,
  MenuItem,
  MenuSeparator,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Skeleton,
  StatusBadge,
} from "@kaname/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageError } from "@/components/PageError";
import { useResource } from "@/lib/queries";
import { formatCount } from "@/lib/format";
import { LogTailPanel } from "../../_components/LogTailPanel";
import { useServiceCommands } from "../../_components/ServiceControls";
import { SERVICE_ACTION_ICONS, SERVICE_STATE_TONE } from "../../_lib/infra";

/* ------------------------------------------------------------------ *
 * Unit detail.
 *
 * The journal is the reason this page exists, so it gets the main
 * column and starts following immediately. The verbs are the same ones
 * the table offers, taken from the same definition, so a restart here
 * and a restart there are the same act with the same confirmation.
 * ------------------------------------------------------------------ */

export default function ServiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const query = useResource<Service>("services", id);
  const service = query.data;
  const serverQuery = useResource<Server>("servers", service?.server_id);
  const server = serverQuery.data;

  const commands = useServiceCommands();

  if (query.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[var(--kn-border)] px-6 pb-4 pt-4">
          <Skeleton className="h-3 w-40" label="Loading unit" />
          <Skeleton className="mt-3 h-6 w-64" />
        </div>
        <div className="px-6 py-4">
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (query.isError || !service) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[var(--kn-border)] px-6 pb-4 pt-4">
          <Breadcrumbs />
        </div>
        <div className="px-6 py-4">
          <PageError
            error={query.error ?? new Error("This unit is no longer in the cached list.")}
            onRetry={() => void query.refetch()}
            context="Unit"
          />
        </div>
      </div>
    );
  }

  const connected = server?.connection === "connected";
  const actions = commands.rowActions(service).filter((action) => action.id !== "journal");

  const rail = (
    <>
      <SectionCard title="Unit" headingLevel={3}>
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="Name" mono copyValue={service.unit}>
            {service.unit}
          </PropertyRow>
          <PropertyRow label="Description">{service.description}</PropertyRow>
          <PropertyRow label="Load state" mono>
            {service.load_state}
          </PropertyRow>
          <PropertyRow label="Sub state" mono>
            {service.sub_state}
          </PropertyRow>
          <PropertyRow label="At boot">{service.enabled ? "enabled" : "disabled"}</PropertyRow>
          <PropertyRow label="Main PID" mono>
            {service.main_pid === null ? null : formatCount(service.main_pid)}
          </PropertyRow>
          <PropertyRow label="Memory">
            {service.memory_current === null ? null : <ByteSize bytes={service.memory_current} />}
          </PropertyRow>
          <PropertyRow label="Active since">
            {service.active_since ? <RelativeTime value={service.active_since} /> : null}
          </PropertyRow>
          <PropertyRow label="Restarts">{formatCount(service.restart_count)}</PropertyRow>
          <PropertyRow label="Synced">
            <RelativeTime value={service.last_synced_at} />
          </PropertyRow>
        </PropertyList>
      </SectionCard>

      <SectionCard title="Host" headingLevel={3}>
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="Server">
            <Link
              href={`/infrastructure/servers/${service.server_id}`}
              className="rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              {service.server_name}
            </Link>
          </PropertyRow>
          <PropertyRow label="Hostname" mono>
            {server?.hostname}
          </PropertyRow>
          <PropertyRow label="Units on host">
            <Link
              href={`/infrastructure/services?server_id=${service.server_id}`}
              className="rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              All units
            </Link>
          </PropertyRow>
        </PropertyList>
      </SectionCard>
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResourceHeader
        breadcrumb={<Breadcrumbs trailing={service.unit} />}
        name={service.unit}
        identity={`${service.server_name}${service.description ? ` · ${service.description}` : ""}`}
        connection={server?.connection}
        lastSeenAt={server?.last_seen_at}
        health={server?.health}
        healthReasons={server?.health_reasons}
        badges={
          <>
            <StatusBadge tone={SERVICE_STATE_TONE[service.active_state]} size="xs">
              {service.active_state} · {service.sub_state}
            </StatusBadge>
            <Badge tone="neutral" size="xs">
              {service.enabled ? "enabled at boot" : "disabled at boot"}
            </Badge>
          </>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={SERVICE_ACTION_ICONS.restart}
            loading={commands.pending}
            disabled={!connected || actions.every((action) => action.disabled)}
            onClick={() => commands.request("restart", [service])}
          >
            Restart
          </Button>
        }
        menu={
          <DropdownMenu
            placement="bottom-end"
            label="Unit actions"
            trigger={<IconButton icon={MoreHorizontal} label="Unit actions" size="sm" />}
          >
            {actions.map((action, index) => (
              <React.Fragment key={action.id}>
                {action.separatorBefore && index > 0 && <MenuSeparator />}
                <MenuItem
                  icon={action.icon}
                  disabled={action.disabled}
                  destructive={action.destructive}
                  onSelect={() => action.onSelect(service)}
                >
                  {action.label}
                </MenuItem>
              </React.Fragment>
            ))}
          </DropdownMenu>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <DetailLayout rail={rail}>
          <div className="flex min-w-0 flex-col gap-2">
            <h2 className="font-medium text-[var(--kn-text)]">Journal</h2>
            <LogTailPanel
              path={`/services/${service.id}/logs`}
              label={`Journal for ${service.unit}`}
              height={560}
              unavailable={
                connected ? undefined : (
                  <>
                    <p className="text-[var(--kn-text)]">
                      {service.server_name}&apos;s agent is not connected.
                    </p>
                    <p className="mt-1">
                      The journal is read live from the host, so there is nothing to follow until it
                      dials back in.
                    </p>
                  </>
                )
              }
            />
          </div>
        </DetailLayout>
      </div>

      {commands.dialog}
    </div>
  );
}
