"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Gauge, MoreHorizontal, ScrollText, SquareTerminal } from "lucide-react";
import type { Server } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  CopyableCode,
  DetailLayout,
  DropdownMenu,
  IconButton,
  MenuItem,
  MenuSeparator,
  MonoText,
  PropertyList,
  PropertyRow,
  RelativeTime,
  ResourceHeader,
  SectionCard,
  Skeleton,
  StatusBadge,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tag,
} from "@kaname/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageError } from "@/components/PageError";
import { useCan, useResource } from "@/lib/queries";
import { formatCount, formatDuration, formatPercent } from "@/lib/format";
import { LogTailPanel } from "../../_components/LogTailPanel";
import { useContainerCommands } from "../../_components/ContainerControls";
import { CONTAINER_ACTION_ICONS, CONTAINER_STATE_TONE, useContainerDetail } from "../../_lib/infra";

/* ------------------------------------------------------------------ *
 * Container detail.
 *
 * The overview merges the cached row with a live inspect, which is
 * affordable here because it is one host and the operator asked for it.
 * Environment values are masked by default: they are already in this
 * response, so the mask is about shoulder-surfing and screenshots
 * rather than about secrecy, and the page says exactly that.
 * ------------------------------------------------------------------ */

type TabValue = "overview" | "logs" | "exec";

const TAB_VALUES: readonly TabValue[] = ["overview", "logs", "exec"];

/** Names whose value is a credential often enough to hide by default. */
const SECRET_KEY = /(PASS|SECRET|TOKEN|APIKEY|API_KEY|_KEY|^KEY$|CREDENTIAL|PRIVATE|SALT|SIGNING)/i;

interface InspectMount {
  source: string;
  destination: string;
  rw: boolean;
  kind: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** The agent forwards the runtime's own inspect payload, whose casing differs by runtime. */
function readMounts(inspect: unknown): InspectMount[] {
  const root = asRecord(inspect);
  const raw = root ? pick(root, "Mounts", "mounts") : undefined;
  if (!Array.isArray(raw)) return [];

  const out: InspectMount[] = [];
  for (const entry of raw) {
    const mount = asRecord(entry);
    if (!mount) continue;
    const source = pick(mount, "Source", "source");
    const destination = pick(mount, "Destination", "destination");
    if (typeof source !== "string" || typeof destination !== "string") continue;
    const rw = pick(mount, "RW", "rw");
    const kind = pick(mount, "Type", "type");
    out.push({
      source,
      destination,
      rw: rw !== false,
      kind: typeof kind === "string" ? kind : "bind",
    });
  }
  return out;
}

function readEnv(inspect: unknown): { key: string; value: string }[] {
  const root = asRecord(inspect);
  const config = root ? asRecord(pick(root, "Config", "config")) : null;
  const raw = config ? pick(config, "Env", "env") : undefined;
  if (!Array.isArray(raw)) return [];

  const out: { key: string; value: string }[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const split = entry.indexOf("=");
    if (split === -1) out.push({ key: entry, value: "" });
    else out.push({ key: entry.slice(0, split), value: entry.slice(split + 1) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export default function ContainerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const can = useCan();

  const query = useContainerDetail(id);
  const container = query.data;
  const serverQuery = useResource<Server>("servers", container?.server_id);
  const server = serverQuery.data;

  const commands = useContainerCommands();
  const [revealed, setRevealed] = React.useState(false);

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
          <Skeleton className="h-3 w-40" label="Loading container" />
          <Skeleton className="mt-3 h-6 w-64" />
        </div>
        <div className="px-6 py-4">
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (query.isError || !container) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-[var(--kn-border)] px-6 pb-4 pt-4">
          <Breadcrumbs />
        </div>
        <div className="px-6 py-4">
          <PageError
            error={query.error ?? new Error("This container is no longer in the cached list.")}
            onRetry={() => void query.refetch()}
            context="Container"
          />
        </div>
      </div>
    );
  }

  const connected = server?.connection === "connected";
  const running = container.state === "running";
  const mounts = readMounts(container.inspect);
  const env = readEnv(container.inspect);
  const actions = commands.rowActions(container).filter((action) => action.id !== "open");
  const execCommand = `${container.runtime} exec -it ${container.name} sh`;

  const rail = (
    <>
      <SectionCard title="Container" headingLevel={3}>
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="Name" mono copyValue={container.name}>
            {container.name}
          </PropertyRow>
          <PropertyRow label="ID" mono copyValue={container.container_id}>
            {container.container_id.slice(0, 12)}
          </PropertyRow>
          <PropertyRow label="Image" mono copyValue={container.image}>
            {container.image}
          </PropertyRow>
          <PropertyRow label="Image ID" mono copyValue={container.image_id}>
            {container.image_id.slice(0, 19)}
          </PropertyRow>
          <PropertyRow label="Status">{container.status}</PropertyRow>
          <PropertyRow label="Runtime" mono>
            {container.runtime}
          </PropertyRow>
          <PropertyRow label="Restarts">{formatCount(container.restart_count)}</PropertyRow>
          <PropertyRow label="Created">
            <RelativeTime value={container.created_at_host} />
          </PropertyRow>
          <PropertyRow label="Started">
            {container.started_at ? <RelativeTime value={container.started_at} /> : null}
          </PropertyRow>
          <PropertyRow label="Uptime">
            {running && container.started_at
              ? formatDuration(Date.now() - Date.parse(container.started_at))
              : null}
          </PropertyRow>
          <PropertyRow label="Synced">
            <RelativeTime value={container.last_synced_at} />
          </PropertyRow>
        </PropertyList>
      </SectionCard>

      <SectionCard title="Resources" headingLevel={3}>
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="CPU">{formatPercent(container.cpu_percent, 1)}</PropertyRow>
          <PropertyRow label="Memory">
            {container.memory_usage === null ? null : <ByteSize bytes={container.memory_usage} />}
          </PropertyRow>
          <PropertyRow label="Memory limit">
            {container.memory_limit ? <ByteSize bytes={container.memory_limit} /> : null}
          </PropertyRow>
        </PropertyList>
      </SectionCard>

      <SectionCard title="Host" headingLevel={3}>
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="Server">
            <Link
              href={`/infrastructure/servers/${container.server_id}`}
              className="rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              {container.server_name}
            </Link>
          </PropertyRow>
          <PropertyRow label="Hostname" mono>
            {server?.hostname}
          </PropertyRow>
          <PropertyRow label="Containers">
            <Link
              href={`/infrastructure/containers?server_id=${container.server_id}`}
              className="rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline"
            >
              All on this host
            </Link>
          </PropertyRow>
        </PropertyList>
      </SectionCard>
    </>
  );

  return (
    <Tabs value={tab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
      <ResourceHeader
        breadcrumb={<Breadcrumbs trailing={container.name} />}
        name={container.name}
        identity={`${container.server_name} · ${container.image}`}
        connection={server?.connection}
        lastSeenAt={server?.last_seen_at}
        health={server?.health}
        healthReasons={server?.health_reasons}
        badges={
          <>
            <StatusBadge tone={CONTAINER_STATE_TONE[container.state]} size="xs">
              {container.state}
            </StatusBadge>
            <Badge tone="neutral" size="xs" mono>
              {container.runtime}
            </Badge>
          </>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={running ? CONTAINER_ACTION_ICONS.restart : CONTAINER_ACTION_ICONS.start}
            loading={commands.pending}
            disabled={!connected || !can("infra.containers:exec", container.server_id)}
            onClick={() => commands.request(running ? "restart" : "start", [container])}
          >
            {running ? "Restart" : "Start"}
          </Button>
        }
        menu={
          <DropdownMenu
            placement="bottom-end"
            label="Container actions"
            trigger={<IconButton icon={MoreHorizontal} label="Container actions" size="sm" />}
          >
            {actions.map((action, index) => (
              <React.Fragment key={action.id}>
                {action.separatorBefore && index > 0 && <MenuSeparator />}
                <MenuItem
                  icon={action.icon}
                  disabled={action.disabled}
                  destructive={action.destructive}
                  onSelect={() => action.onSelect(container)}
                >
                  {action.label}
                </MenuItem>
              </React.Fragment>
            ))}
          </DropdownMenu>
        }
        tabs={
          <TabList>
            <Tab value="overview" icon={Gauge}>
              Overview
            </Tab>
            <Tab value="logs" icon={ScrollText}>
              Logs
            </Tab>
            <Tab value="exec" icon={SquareTerminal}>
              Exec
            </Tab>
          </TabList>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <TabPanel value="overview">
          <DetailLayout rail={rail}>
            <SectionCard title="Ports" padded={false}>
              {container.ports.length === 0 ? (
                <p className="px-4 py-3 text-[var(--kn-text-3)]">No published ports.</p>
              ) : (
                <ul className="flex flex-col">
                  {container.ports.map((port) => (
                    <li
                      key={`${port.host_ip ?? ""}:${port.host_port ?? "-"}:${port.container_port}/${port.protocol}`}
                      className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
                    >
                      <MonoText className="min-w-0 flex-1 truncate">
                        {port.host_port === null
                          ? "not published"
                          : `${port.host_ip ?? "0.0.0.0"}:${port.host_port}`}
                      </MonoText>
                      <span className="text-[var(--kn-text-3)]">→</span>
                      <MonoText muted className="w-32 shrink-0">
                        {port.container_port}/{port.protocol}
                      </MonoText>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="Mounts" padded={false}>
              {mounts.length === 0 ? (
                <p className="px-4 py-3 text-[var(--kn-text-3)]">
                  {container.inspect === null
                    ? "The host is unreachable, so the live definition could not be read."
                    : "No volumes or bind mounts."}
                </p>
              ) : (
                <ul className="flex flex-col">
                  {mounts.map((mount) => (
                    <li
                      key={`${mount.source}:${mount.destination}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--kn-border-subtle)] px-4 py-2 last:border-b-0"
                    >
                      <MonoText className="min-w-0 flex-1 truncate">{mount.source}</MonoText>
                      <span className="text-[var(--kn-text-3)]">→</span>
                      <MonoText muted className="min-w-0 flex-1 truncate">
                        {mount.destination}
                      </MonoText>
                      <Badge tone="neutral" size="xs">
                        {mount.kind}
                      </Badge>
                      <Badge tone={mount.rw ? "warn" : "neutral"} size="xs">
                        {mount.rw ? "rw" : "ro"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
              <SectionCard title="Networks">
                {container.networks.length === 0 ? (
                  <p className="text-[var(--kn-text-3)]">No networks attached.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {container.networks.map((network) => (
                      <Tag key={network} size="xs" mono>
                        {network}
                      </Tag>
                    ))}
                  </div>
                )}
              </SectionCard>

              <SectionCard title="Labels">
                {Object.keys(container.labels).length === 0 ? (
                  <p className="text-[var(--kn-text-3)]">No labels.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(container.labels).map(([key, value]) => (
                      <Tag key={key} size="xs" mono>
                        {value ? `${key}=${value}` : key}
                      </Tag>
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>

            <SectionCard
              title="Environment"
              description="Values arrive with the container definition. Masking is against shoulders and screenshots, not against the network."
              padded={false}
              actions={
                env.length > 0 && (
                  <Switch
                    size="sm"
                    checked={revealed}
                    onChange={(event) => setRevealed(event.target.checked)}
                    label="Reveal secrets"
                  />
                )
              }
            >
              {env.length === 0 ? (
                <p className="px-4 py-3 text-[var(--kn-text-3)]">
                  {container.inspect === null
                    ? "The host is unreachable, so the live definition could not be read."
                    : "No environment variables."}
                </p>
              ) : (
                <ul className="flex flex-col">
                  {env.map((entry) => {
                    const secret = SECRET_KEY.test(entry.key);
                    const hidden = secret && !revealed;
                    return (
                      <li
                        key={entry.key}
                        className="flex items-center gap-3 border-b border-[var(--kn-border-subtle)] px-4 py-1.5 last:border-b-0"
                      >
                        <MonoText className="w-64 shrink-0 truncate">{entry.key}</MonoText>
                        {hidden ? (
                          <span className="kn-mono text-[var(--kn-text-3)]">
                            •••••••• ({formatCount(entry.value.length)} chars)
                          </span>
                        ) : (
                          <MonoText muted className="min-w-0 flex-1 truncate">
                            {entry.value || "—"}
                          </MonoText>
                        )}
                        {secret && (
                          <Badge tone="warn" size="xs">
                            secret
                          </Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>
          </DetailLayout>
        </TabPanel>

        <TabPanel value="logs">
          <LogTailPanel
            path={`/containers/${container.id}/logs`}
            label={`Output from ${container.name}`}
            height={560}
            unavailable={
              connected ? undefined : (
                <>
                  <p className="text-[var(--kn-text)]">
                    {container.server_name}&apos;s agent is not connected.
                  </p>
                  <p className="mt-1">
                    Container output is read live from the host, so there is nothing to follow until
                    it dials back in.
                  </p>
                </>
              )
            }
          />
        </TabPanel>

        <TabPanel value="exec">
          <SectionCard
            title="Exec"
            description="A shell inside a container is a shell on the host's kernel, so it goes through the same audited path as any other terminal (KD-013)."
          >
            <div className="flex flex-col gap-4">
              <p className="text-[var(--kn-text-2)]">
                Open a terminal on <MonoText muted>{container.server_name}</MonoText> and run this.
                The session is permission-gated, ticketed and recorded; nothing here is sent as a
                shell string through the RPC surface.
              </p>
              <CopyableCode value={execCommand} label="Copy exec command" block />
              <div>
                <Button
                  variant="primary"
                  size="sm"
                  icon={SquareTerminal}
                  disabled={!connected || !can("terminal.session:exec", container.server_id)}
                  onClick={() => router.push(`/terminal?server_id=${container.server_id}`)}
                >
                  Open terminal on {container.server_name}
                </Button>
              </div>
              {!can("terminal.session:exec", container.server_id) && (
                <p className="text-[var(--kn-text-3)]">
                  This account does not hold <MonoText muted>terminal.session:exec</MonoText> on
                  this host, which is deliberately a separate permission from managing containers.
                </p>
              )}
            </div>
          </SectionCard>
        </TabPanel>
      </div>

      {commands.dialog}
    </Tabs>
  );
}
