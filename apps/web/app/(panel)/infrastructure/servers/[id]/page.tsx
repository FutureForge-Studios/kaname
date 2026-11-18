"use client";

import * as React from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpCircle,
  Box,
  CloudDownload,
  Cog,
  Gauge,
  HardDrive,
  MoreHorizontal,
  Power,
  ScrollText,
  ShieldOff,
  SquareTerminal,
  Terminal,
  Trash2,
} from "lucide-react";
import type { AgentConnection, HealthState, Server } from "@kaname/contract";
import {
  Badge,
  Button,
  ResourceHeader,
  DropdownMenu,
  IconButton,
  MenuItem,
  MenuSeparator,
  RelativeTime,
  Skeleton,
  StatusLine,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  type Tone,
} from "@kaname/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageError } from "@/components/PageError";
import { useCan, useResource } from "@/lib/queries";
import { formatCount } from "@/lib/format";
import { ServerOverview } from "../../_components/ServerOverview";
import { ServerServicesTab } from "../../_components/ServerServicesTab";
import { ServerContainersTab } from "../../_components/ServerContainersTab";
import { ServerStorageTab } from "../../_components/ServerStorageTab";
import { ServerLogsTab } from "../../_components/ServerLogsTab";
import { ServerUpdatesTab } from "../../_components/ServerUpdatesTab";
import { useServerOsUpdates } from "@/lib/system-updates";
import { useServerCommands } from "../../_components/ServerCommands";
import { hasContainerRuntime } from "../../_lib/infra";

/* ------------------------------------------------------------------ *
 * Server detail.
 *
 * The header carries both status axes permanently (PLAN.md 2.6) and the
 * tabs below it are the four things a host actually is: what it is
 * doing, what it runs, what it stores and what it says. The terminal is
 * a shortcut rather than a tab, because it is a separate permission and
 * a separate audited surface (KD-013).
 *
 * The tab lives in the query string so a link into "the containers on
 * web-01" keeps meaning that for whoever receives it.
 * ------------------------------------------------------------------ */

type TabValue = "overview" | "services" | "containers" | "storage" | "updates" | "logs";

const TAB_VALUES: readonly TabValue[] = [
  "overview",
  "services",
  "containers",
  "storage",
  "updates",
  "logs",
];

export default function ServerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const can = useCan();

  const query = useResource<Server>("servers", id);
  const server = query.data;
  // The cached package list only — reading it never runs apt on the host.
  const osUpdates = useServerOsUpdates(id, Boolean(server));

  const commands = useServerCommands({
    onRemoved: () => router.push("/infrastructure/servers"),
  });

  const requested = searchParams.get("tab");
  const tab: TabValue = TAB_VALUES.includes(requested as TabValue)
    ? (requested as TabValue)
    : "overview";

  const selectTab = (next: string) => {
    const params_ = new URLSearchParams(searchParams.toString());
    if (next === "overview") params_.delete("tab");
    else params_.set("tab", next);
    const search = params_.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  };

  if (query.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--kn-border)] px-6 pb-5 pt-6">
          <Skeleton label="Loading server" className="h-7 w-56" />
          <Skeleton className="mt-2 h-3 w-72" />
        </header>
        <div className="px-6 py-6">
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (query.isError || !server) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--kn-border)] px-6 pb-5 pt-6">
          <Breadcrumbs />
        </header>
        <div className="px-6 py-6">
          <PageError
            error={query.error ?? new Error("This server is not in the fleet.")}
            onRetry={() => void query.refetch()}
            context="Server"
          />
        </div>
      </div>
    );
  }

  const connected = server.connection === "connected";
  const failed = server.counts?.services_failed ?? 0;
  const pendingOs = osUpdates.data;

  return (
    <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
      <ResourceHeader
        breadcrumb={<Breadcrumbs trailing={server.name} />}
        name={server.name}
        identity={
          <>
            {server.hostname}
            {server.address ? ` · ${server.address}` : ""}
            {server.agent_version ? ` · kanamed ${server.agent_version}` : ""}
          </>
        }
        connection={server.connection}
        lastSeenAt={server.last_seen_at}
        health={server.health}
        healthReasons={server.health_reasons}
        status={<HostStatusLine host={server} />}
        badges={
          server.simulated ? (
            <Badge tone="info" size="xs">
              simulated
            </Badge>
          ) : undefined
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={CloudDownload}
              disabled={!connected || commands.syncing}
              loading={commands.syncing}
              onClick={() => commands.sync(server)}
            >
              Sync
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={SquareTerminal}
              disabled={!connected || !can("terminal.session:exec", server.id)}
              onClick={() => router.push(`/terminal?server_id=${server.id}`)}
            >
              Terminal
            </Button>
          </>
        }
        menu={
          <DropdownMenu
            placement="bottom-end"
            label="Server actions"
            trigger={<IconButton icon={MoreHorizontal} label="Server actions" size="sm" />}
          >
            <MenuItem
              icon={Terminal}
              disabled={!can("infra.servers:write", server.id)}
              onSelect={() => commands.request("enroll", server)}
            >
              Enrollment command
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Power}
              destructive
              disabled={!can("infra.servers:write", server.id) || !connected}
              onSelect={() => commands.request("reboot", server)}
            >
              Reboot
            </MenuItem>
            <MenuItem
              icon={ShieldOff}
              destructive
              // Revoking is granted by infra.servers:delete, as the API checks it.
              disabled={!can("infra.servers:delete", server.id) || server.connection === "revoked"}
              onSelect={() => commands.request("revoke", server)}
            >
              Revoke certificate
            </MenuItem>
            <MenuItem
              icon={Trash2}
              destructive
              disabled={!can("infra.servers:delete", server.id)}
              onSelect={() => commands.request("remove", server)}
            >
              Remove from Kaname
            </MenuItem>
          </DropdownMenu>
        }
        tabs={
          <TabList>
            <Tab value="overview" icon={Gauge}>
              Overview
            </Tab>
            <Tab
              value="services"
              icon={Cog}
              badge={failed > 0 ? `${formatCount(failed)} failed` : undefined}
            >
              Services
            </Tab>
            <Tab
              value="containers"
              icon={Box}
              badge={
                hasContainerRuntime(server) && server.counts
                  ? formatCount(server.counts.containers)
                  : undefined
              }
            >
              Containers
            </Tab>
            <Tab value="storage" icon={HardDrive}>
              Storage
            </Tab>
            <Tab
              value="updates"
              icon={ArrowUpCircle}
              badge={
                pendingOs && pendingOs.security > 0
                  ? `${formatCount(pendingOs.security)} security`
                  : pendingOs && pendingOs.total > 0
                    ? formatCount(pendingOs.total)
                    : undefined
              }
            >
              System updates
            </Tab>
            <Tab value="logs" icon={ScrollText}>
              Logs
            </Tab>
          </TabList>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-6 py-6">
        <TabPanel value="overview">
          <ServerOverview server={server} commands={commands} />
        </TabPanel>
        <TabPanel value="services">
          <ServerServicesTab server={server} />
        </TabPanel>
        <TabPanel value="containers">
          <ServerContainersTab server={server} />
        </TabPanel>
        <TabPanel value="storage">
          <ServerStorageTab server={server} />
        </TabPanel>
        <TabPanel value="updates">
          <ServerUpdatesTab server={server} onReboot={() => commands.request("reboot", server)} />
        </TabPanel>
        <TabPanel value="logs">
          <ServerLogsTab server={server} />
        </TabPanel>
      </div>

      {commands.dialogs}
    </Tabs>
  );
}

/* ----------------------------- HostStatusLine --------------------------- */

const CONNECTION_TONE: Record<AgentConnection, Tone> = {
  connected: "ok",
  degraded: "warn",
  disconnected: "danger",
  never_enrolled: "info",
  revoked: "danger",
};

const HEALTH_TONE: Record<HealthState, Tone> = {
  healthy: "ok",
  warning: "warn",
  critical: "danger",
  unknown: "neutral",
};

const RANK: Record<string, number> = { neutral: 0, info: 1, ok: 1, warn: 2, danger: 3 };

/**
 * The two axes read as one sentence: "Agent connected, seen 4s ago ·
 * 2 health findings: disk / is 91% full". The dot takes the worse of the
 * two tones; the badges beside the name keep them apart.
 */
function HostStatusLine({ host }: { host: Server }) {
  const connectionTone = CONNECTION_TONE[host.connection] ?? "neutral";
  const healthTone = HEALTH_TONE[host.health] ?? "neutral";
  const tone = (RANK[healthTone] ?? 0) > (RANK[connectionTone] ?? 0) ? healthTone : connectionTone;

  const agent =
    host.connection === "never_enrolled" ? (
      <>Agent never enrolled — run the enrollment command on the host</>
    ) : host.connection === "revoked" ? (
      <>Certificate revoked — the agent cannot reconnect until it is enrolled again</>
    ) : (
      <>
        Agent {host.connection === "connected" ? "online" : host.connection}
        {host.last_seen_at && (
          <>
            , last heard from <RelativeTime value={host.last_seen_at} />
          </>
        )}
      </>
    );

  const first = host.health_reasons[0];
  const health =
    host.health === "unknown"
      ? "health not evaluated without recent metrics"
      : host.health === "healthy"
        ? "every monitored threshold within range"
        : `${host.health_reasons.length} health finding${host.health_reasons.length === 1 ? "" : "s"}${first ? `: ${first}` : ""}`;

  return (
    <StatusLine tone={tone} pulse={host.connection === "connected"} className="min-w-0">
      {agent} · {health}
    </StatusLine>
  );
}
