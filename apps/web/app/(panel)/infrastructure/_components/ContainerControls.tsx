"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ScrollText, Trash2 } from "lucide-react";
import type { Container, Job } from "@kaname/contract";
import {
  Button,
  ByteSize,
  Checkbox,
  ConfirmDialog,
  DropdownMenu,
  MenuItem,
  MonoText,
  RelativeTime,
  StatusBadge,
  TruncatedText,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { api } from "@/lib/api";
import { useCan, useMutationWithJob } from "@/lib/queries";
import { formatCount, formatDuration, formatPercent, pluralize } from "@/lib/format";
import {
  CONTAINER_ACTION_ICONS,
  CONTAINER_ACTION_LABELS,
  CONTAINER_STATE_TONE,
  useContainerAction,
  useContainerRemove,
  type ContainerLifecycle,
} from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Container columns and verbs.
 *
 * Same contract as the service controls: defined once so the fleet-wide
 * table and a server's own Containers tab cannot drift, and every verb
 * lands as a job rather than a spinner (KD-008).
 * ------------------------------------------------------------------ */

const LIFECYCLE: readonly ContainerLifecycle[] = ["start", "stop", "restart"];

export function formatPorts(ports: Container["ports"]): string {
  if (ports.length === 0) return "—";
  return ports
    .map((port) => {
      const target = `${port.container_port}/${port.protocol}`;
      if (port.host_port === null) return target;
      const host = port.host_ip && port.host_ip !== "0.0.0.0" ? port.host_ip : "";
      return `${host ? `${host}:` : ""}${port.host_port}→${target}`;
    })
    .join(" ");
}

function uptimeOf(container: Container): string {
  if (container.state !== "running" || !container.started_at) return "—";
  return formatDuration(Date.now() - Date.parse(container.started_at));
}

export interface ContainerColumnOptions {
  showServer: boolean;
}

export function useContainerColumns({
  showServer,
}: ContainerColumnOptions): DataTableColumn<Container>[] {
  return React.useMemo(() => {
    const columns: DataTableColumn<Container>[] = [
      {
        id: "name",
        header: "Container",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 180,
        accessor: (container) => container.name,
      },
      {
        id: "state",
        header: "State",
        sortable: true,
        width: 176,
        cell: (container) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusBadge tone={CONTAINER_STATE_TONE[container.state]} size="xs">
              {container.state}
            </StatusBadge>
            <MonoText muted truncate className="text-xs">
              {container.status}
            </MonoText>
          </span>
        ),
      },
      {
        id: "image",
        header: "Image",
        sortable: true,
        minWidth: 200,
        hideBelow: "md",
        cell: (container) => <TruncatedText value={container.image} max={38} />,
      },
      {
        id: "ports",
        header: "Ports",
        mono: true,
        minWidth: 168,
        hideBelow: "lg",
        accessor: (container) => formatPorts(container.ports),
      },
      {
        id: "cpu",
        header: "CPU",
        width: 72,
        align: "right",
        hideBelow: "md",
        accessor: (container) => formatPercent(container.cpu_percent),
      },
      {
        id: "memory",
        header: "Memory",
        width: 116,
        align: "right",
        hideBelow: "md",
        cell: (container) => (
          <span className="kn-num">
            <ByteSize bytes={container.memory_usage} />
            {container.memory_limit ? (
              <span className="text-[var(--kn-text-3)]">
                {" / "}
                <ByteSize bytes={container.memory_limit} precision={0} />
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "uptime",
        header: "Uptime",
        width: 92,
        align: "right",
        hideBelow: "lg",
        accessor: uptimeOf,
      },
      {
        id: "restart_count",
        header: "Restarts",
        width: 84,
        align: "right",
        hideBelow: "lg",
        cell: (container) => (
          <span className={container.restart_count > 0 ? "text-[var(--kn-warn)]" : undefined}>
            {formatCount(container.restart_count)}
          </span>
        ),
      },
      {
        id: "last_synced_at",
        header: "Synced",
        width: 96,
        align: "right",
        hideBelow: "lg",
        cell: (container) => <RelativeTime value={container.last_synced_at} />,
      },
    ];

    if (showServer) {
      columns.splice(1, 0, {
        id: "server",
        header: "Server",
        sortable: true,
        width: 140,
        hideBelow: "md",
        accessor: (container) => container.server_name,
      });
    }

    return columns;
  }, [showServer]);
}

/* ------------------------------------------------------------------ */

interface FanOutVars {
  containers: Container[];
  label: string;
  send: (container: Container) => Promise<{ job: Job }>;
}

/**
 * The control plane exposes no bulk container route, so the panel fans
 * out and groups the jobs itself. `allSettled` matters: one container
 * that refuses to stop must not discard the jobs that were accepted.
 */
function useContainerFanOut() {
  return useMutationWithJob<FanOutVars>({
    mutationFn: async ({ containers, send }) => {
      const results = await Promise.allSettled(containers.map(send));
      const jobs = results
        .filter(
          (result): result is PromiseFulfilledResult<{ job: Job }> => result.status === "fulfilled",
        )
        .map((result) => result.value.job);
      if (jobs.length === 0) {
        const rejected = results.find((result) => result.status === "rejected");
        throw (rejected as PromiseRejectedResult | undefined)?.reason;
      }
      return { jobs, correlation_id: jobs[0]?.correlation_id ?? "" };
    },
    invalidates: ["containers", "storage", "servers"],
    describe: ({ label }) => label,
  });
}

interface PendingLifecycle {
  kind: "lifecycle";
  action: ContainerLifecycle;
  containers: Container[];
}

interface PendingRemoval {
  kind: "remove";
  containers: Container[];
}

type PendingCommand = PendingLifecycle | PendingRemoval;

export interface ContainerCommands {
  /** Runs a lifecycle verb, confirming first when it stops something. */
  request: (action: ContainerLifecycle, containers: Container[]) => void;
  /** Opens the removal confirmation for one or many containers. */
  requestRemoval: (containers: Container[]) => void;
  /** True while a request is in flight — before the job exists to watch. */
  pending: boolean;
  rowActions: (container: Container) => DataTableRowAction<Container>[];
  bulkActions: (ids: string[], rows: readonly Container[]) => React.ReactNode;
  dialog: React.ReactNode;
}

export function useContainerCommands(): ContainerCommands {
  const router = useRouter();
  const can = useCan();
  const single = useContainerAction();
  const fanOut = useContainerFanOut();
  const remove = useContainerRemove();

  const [pending, setPending] = React.useState<PendingCommand | null>(null);
  const [force, setForce] = React.useState(false);
  const [removeVolumes, setRemoveVolumes] = React.useState(false);

  React.useEffect(() => {
    if (pending?.kind !== "remove") return;
    // A running container cannot be removed without force, and pretending
    // otherwise just spends a round trip to be told so.
    setForce(pending.containers.some((container) => container.state === "running"));
    setRemoveVolumes(false);
  }, [pending]);

  const runLifecycle = React.useCallback(
    (action: ContainerLifecycle, containers: Container[]) => {
      const first = containers[0];
      if (!first) return;
      if (containers.length === 1) {
        single.mutate({ container: first, action });
        return;
      }
      fanOut.mutate({
        containers,
        label: `${CONTAINER_ACTION_LABELS[action]} ${pluralize(containers.length, "container")}`,
        send: (container) => api.post<{ job: Job }>(`/containers/${container.id}/${action}`),
      });
    },
    [fanOut, single],
  );

  const runRemoval = React.useCallback(
    (containers: Container[]) => {
      const first = containers[0];
      if (!first) return;
      if (containers.length === 1) {
        remove.mutate({ container: first, force, removeVolumes });
        return;
      }
      fanOut.mutate({
        containers,
        label: `Remove ${pluralize(containers.length, "container")}`,
        send: (container) =>
          api.del<{ job: Job }>(`/containers/${container.id}`, {
            params: { force, remove_volumes: removeVolumes },
          }),
      });
    },
    [fanOut, force, remove, removeVolumes],
  );

  const request = React.useCallback(
    (action: ContainerLifecycle, containers: Container[]) => {
      if (containers.length === 0) return;
      if (action === "stop" || containers.length > 1) {
        setPending({ kind: "lifecycle", action, containers });
        return;
      }
      runLifecycle(action, containers);
    },
    [runLifecycle],
  );

  const rowActions = React.useCallback(
    (container: Container): DataTableRowAction<Container>[] => {
      const canExec = can("infra.containers:exec", container.server_id);
      const canDelete = can("infra.containers:delete", container.server_id);
      return [
        {
          id: "open",
          label: "Open container",
          icon: ScrollText,
          onSelect: () => router.push(`/infrastructure/containers/${container.id}`),
        },
        ...LIFECYCLE.map((action, index) => ({
          id: action,
          label: CONTAINER_ACTION_LABELS[action],
          icon: CONTAINER_ACTION_ICONS[action],
          disabled:
            !canExec ||
            (action === "start" && container.state === "running") ||
            (action !== "start" && container.state !== "running"),
          destructive: action === "stop",
          separatorBefore: index === 0,
          onSelect: () => request(action, [container]),
        })),
        {
          id: "remove",
          label: "Remove",
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          disabled: !canDelete,
          onSelect: () => setPending({ kind: "remove", containers: [container] }),
        },
      ];
    },
    [can, request, router],
  );

  const bulkActions = React.useCallback(
    (ids: string[], rows: readonly Container[]) => {
      const selected = rows.filter((container) => ids.includes(container.id));
      const canExec =
        selected.length > 0 &&
        selected.every((container) => can("infra.containers:exec", container.server_id));
      const canDelete =
        selected.length > 0 &&
        selected.every((container) => can("infra.containers:delete", container.server_id));

      return (
        <>
          <Button
            variant="secondary"
            size="xs"
            icon={CONTAINER_ACTION_ICONS.restart}
            disabled={!canExec}
            onClick={() => request("restart", selected)}
          >
            Restart
          </Button>
          <DropdownMenu
            placement="bottom-start"
            label="Bulk container actions"
            trigger={
              <Button variant="ghost" size="xs" iconRight={ChevronDown} disabled={!canExec}>
                More
              </Button>
            }
          >
            <MenuItem
              icon={CONTAINER_ACTION_ICONS.start}
              onSelect={() => request("start", selected)}
            >
              Start
            </MenuItem>
            <MenuItem
              icon={CONTAINER_ACTION_ICONS.stop}
              destructive
              onSelect={() => request("stop", selected)}
            >
              Stop
            </MenuItem>
          </DropdownMenu>
          <Button
            variant="danger-subtle"
            size="xs"
            icon={Trash2}
            disabled={!canDelete}
            onClick={() => setPending({ kind: "remove", containers: selected })}
          >
            Remove
          </Button>
        </>
      );
    },
    [can, request],
  );

  const count = pending?.containers.length ?? 0;
  const first = pending?.containers[0];
  const running = pending?.containers.filter((container) => container.state === "running") ?? [];

  const dialog =
    pending?.kind === "remove" ? (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          count === 1 && first
            ? `Remove ${first.name}?`
            : `Remove ${pluralize(count, "container")}?`
        }
        description="Removing a container discards its writable layer. Data outside a volume or bind mount is gone."
        confirmText={count === 1 && first ? first.name : String(count)}
        confirmLabel="Remove"
        destructive
        loading={remove.isPending || fanOut.isPending}
        onConfirm={() => {
          runRemoval(pending.containers);
          setPending(null);
        }}
      >
        <div className="flex flex-col gap-2">
          {running.length > 0 && (
            <p className="text-[var(--kn-warn)]">
              {pluralize(running.length, "container")} still running — removal needs force, which
              kills the process rather than stopping it.
            </p>
          )}
          <Checkbox
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
            label="Force removal of a running container"
          />
          <Checkbox
            checked={removeVolumes}
            onChange={(event) => setRemoveVolumes(event.target.checked)}
            label="Also remove anonymous volumes"
            description="Named volumes are never touched."
          />
        </div>
      </ConfirmDialog>
    ) : (
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending?.kind === "lifecycle"
            ? count === 1 && first
              ? `${CONTAINER_ACTION_LABELS[pending.action]} ${first.name}?`
              : `${CONTAINER_ACTION_LABELS[pending.action]} ${pluralize(count, "container")}?`
            : ""
        }
        description="Each container gets its own job. You can watch them in the job drawer."
        confirmLabel={
          pending?.kind === "lifecycle" ? CONTAINER_ACTION_LABELS[pending.action] : "Confirm"
        }
        destructive={pending?.kind === "lifecycle" && pending.action === "stop"}
        loading={single.isPending || fanOut.isPending}
        onConfirm={() => {
          if (pending?.kind !== "lifecycle") return;
          runLifecycle(pending.action, pending.containers);
          setPending(null);
        }}
      />
    );

  return {
    request,
    requestRemoval: (containers) => setPending({ kind: "remove", containers }),
    pending: single.isPending || fanOut.isPending || remove.isPending,
    rowActions,
    bulkActions,
    dialog,
  };
}
