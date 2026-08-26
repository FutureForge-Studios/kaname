"use client";

import * as React from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import {
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
import type { Server } from "@kaname/contract";
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  MenuItem,
  MenuSeparator,
  ResourceHeader,
  Skeleton,
  Tab,
  TabList,
  TabPanel,
  Tabs,
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

type TabValue = "overview" | "services" | "containers" | "storage" | "logs";

const TAB_VALUES: readonly TabValue[] = ["overview", "services", "containers", "storage", "logs"];

export default function ServerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const can = useCan();

  const query = useResource<Server>("servers", id);
  const server = query.data;

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
        <div className="border-b border-[var(--kn-border)] px-6 pb-4 pt-4">
          <Skeleton className="h-3 w-40" label="Loading server" />
          <Skeleton className="mt-3 h-6 w-56" />
          <Skeleton className="mt-2 h-3 w-72" />
        </div>
        <div className="px-6 py-4">
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (query.isError || !server) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[var(--kn-border)] px-6 pb-4 pt-4">
          <Breadcrumbs />
        </div>
        <div className="px-6 py-4">
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
              disabled={!can("infra.servers:write", server.id) || server.connection === "revoked"}
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
            <Tab value="logs" icon={ScrollText}>
              Logs
            </Tab>
          </TabList>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
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
        <TabPanel value="logs">
          <ServerLogsTab server={server} />
        </TabPanel>
      </div>

      {commands.dialogs}
    </Tabs>
  );
}
