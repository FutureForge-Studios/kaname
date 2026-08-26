"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ScrollText } from "lucide-react";
import type { Service, ServiceAction } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  DropdownMenu,
  MenuItem,
  MonoText,
  RelativeTime,
  StatusBadge,
  ConfirmDialog,
  type DataTableColumn,
  type DataTableRowAction,
} from "@kaname/ui";
import { useCan } from "@/lib/queries";
import { formatCount, pluralize } from "@/lib/format";
import {
  SERVICE_ACTION_ICONS,
  SERVICE_ACTION_LABELS,
  SERVICE_ACTIONS,
  SERVICE_ACTIONS_CONFIRMED,
  SERVICE_STATE_TONE,
  useServiceAction,
  useServiceBulkAction,
} from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Service columns and verbs.
 *
 * The units table appears twice — fleet-wide under Infrastructure and
 * scoped to one host on a server's detail page — and both must behave
 * identically down to which action is disabled on a failed unit. That
 * is only true if the columns and the verbs are defined once.
 *
 * Every verb here produces a job (KD-008); none of them waits.
 * ------------------------------------------------------------------ */

export interface ServiceColumnOptions {
  /** Off on a server's own page, where every row is the same host. */
  showServer: boolean;
}

export function useServiceColumns({
  showServer,
}: ServiceColumnOptions): DataTableColumn<Service>[] {
  return React.useMemo(() => {
    const columns: DataTableColumn<Service>[] = [
      {
        id: "unit",
        header: "Unit",
        locked: true,
        sortable: true,
        mono: true,
        minWidth: 220,
        accessor: (service) => service.unit,
      },
      {
        id: "active_state",
        header: "State",
        sortable: true,
        width: 168,
        cell: (service) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusBadge tone={SERVICE_STATE_TONE[service.active_state]} size="xs">
              {service.active_state}
            </StatusBadge>
            <MonoText muted truncate className="text-xs">
              {service.sub_state}
            </MonoText>
          </span>
        ),
      },
      {
        id: "enabled",
        header: "At boot",
        sortable: true,
        width: 88,
        cell: (service) => (
          <Badge tone="neutral" size="xs">
            {service.enabled ? "enabled" : "disabled"}
          </Badge>
        ),
      },
      {
        id: "description",
        header: "Description",
        minWidth: 200,
        hideBelow: "lg",
        accessor: (service) => service.description,
      },
      {
        id: "main_pid",
        header: "PID",
        width: 80,
        align: "right",
        mono: true,
        hideBelow: "lg",
        accessor: (service) => (service.main_pid === null ? "—" : formatCount(service.main_pid)),
      },
      {
        id: "memory_current",
        header: "Memory",
        width: 92,
        align: "right",
        hideBelow: "md",
        cell: (service) => <ByteSize bytes={service.memory_current} />,
      },
      {
        id: "restart_count",
        header: "Restarts",
        width: 84,
        align: "right",
        hideBelow: "lg",
        cell: (service) => (
          <span className={service.restart_count > 0 ? "text-[var(--kn-warn)]" : undefined}>
            {formatCount(service.restart_count)}
          </span>
        ),
      },
      {
        id: "active_since",
        header: "Active since",
        width: 108,
        align: "right",
        hideBelow: "lg",
        cell: (service) => <RelativeTime value={service.active_since} />,
      },
      {
        id: "last_synced_at",
        header: "Synced",
        width: 96,
        align: "right",
        hideBelow: "lg",
        cell: (service) => <RelativeTime value={service.last_synced_at} />,
      },
    ];

    if (showServer) {
      columns.splice(1, 0, {
        id: "server",
        header: "Server",
        sortable: true,
        width: 140,
        hideBelow: "md",
        accessor: (service) => service.server_name,
      });
    }

    return columns;
  }, [showServer]);
}

/* ------------------------------------------------------------------ */

interface PendingCommand {
  action: ServiceAction;
  services: Service[];
}

export interface ServiceCommands {
  /** Runs a verb, confirming first when the verb takes something down. */
  request: (action: ServiceAction, services: Service[]) => void;
  /** True while a request is in flight — before the job exists to watch. */
  pending: boolean;
  rowActions: (service: Service) => DataTableRowAction<Service>[];
  /** The bar that appears above the table while rows are selected. */
  bulkActions: (ids: string[], rows: readonly Service[]) => React.ReactNode;
  /** Mount once per page: the confirmation for the verbs that need one. */
  dialog: React.ReactNode;
}

/** `reload` only means something to a unit that is currently running. */
function disabledReason(service: Service, action: ServiceAction): boolean {
  switch (action) {
    case "start":
      return service.active_state === "active" || service.active_state === "activating";
    case "stop":
      return service.active_state === "inactive" || service.active_state === "deactivating";
    case "reload":
      return service.active_state !== "active";
    case "enable":
      return service.enabled;
    case "disable":
      return !service.enabled;
    default:
      return false;
  }
}

export function useServiceCommands(): ServiceCommands {
  const router = useRouter();
  const can = useCan();
  const single = useServiceAction();
  const bulk = useServiceBulkAction();
  const [pending, setPending] = React.useState<PendingCommand | null>(null);

  const dispatch = React.useCallback(
    (action: ServiceAction, services: Service[]) => {
      const first = services[0];
      if (!first) return;
      if (services.length === 1) single.mutate({ service: first, action });
      else bulk.mutate({ action, ids: services.map((service) => service.id) });
    },
    [bulk, single],
  );

  const request = React.useCallback(
    (action: ServiceAction, services: Service[]) => {
      if (services.length === 0) return;
      if (SERVICE_ACTIONS_CONFIRMED.has(action) || services.length > 1) {
        setPending({ action, services });
        return;
      }
      dispatch(action, services);
    },
    [dispatch],
  );

  const rowActions = React.useCallback(
    (service: Service): DataTableRowAction<Service>[] => {
      const allowed = can("infra.services:exec", service.server_id);
      return [
        {
          id: "journal",
          label: "Open unit",
          icon: ScrollText,
          onSelect: () => router.push(`/infrastructure/services/${service.id}`),
        },
        ...SERVICE_ACTIONS.map((action, index) => ({
          id: action,
          label: SERVICE_ACTION_LABELS[action],
          icon: SERVICE_ACTION_ICONS[action],
          disabled: !allowed || disabledReason(service, action),
          destructive: action === "stop",
          separatorBefore: index === 0,
          onSelect: () => request(action, [service]),
        })),
      ];
    },
    [can, request, router],
  );

  const bulkActions = React.useCallback(
    (ids: string[], rows: readonly Service[]) => {
      const selected = rows.filter((service) => ids.includes(service.id));
      const allowed =
        selected.length > 0 &&
        selected.every((service) => can("infra.services:exec", service.server_id));

      return (
        <>
          <Button
            variant="secondary"
            size="xs"
            icon={SERVICE_ACTION_ICONS.restart}
            disabled={!allowed}
            onClick={() => request("restart", selected)}
          >
            Restart
          </Button>
          <DropdownMenu
            placement="bottom-start"
            label="Bulk unit actions"
            trigger={
              <Button variant="ghost" size="xs" iconRight={ChevronDown} disabled={!allowed}>
                More
              </Button>
            }
          >
            {SERVICE_ACTIONS.filter((action) => action !== "restart").map((action) => (
              <MenuItem
                key={action}
                icon={SERVICE_ACTION_ICONS[action]}
                destructive={action === "stop"}
                onSelect={() => request(action, selected)}
              >
                {SERVICE_ACTION_LABELS[action]}
              </MenuItem>
            ))}
          </DropdownMenu>
          {!allowed && selected.length > 0 && (
            <span className="text-xs text-[var(--kn-text-3)]">
              This account cannot run units on every selected host.
            </span>
          )}
        </>
      );
    },
    [can, request],
  );

  const count = pending?.services.length ?? 0;
  const first = pending?.services[0];
  const label = pending ? SERVICE_ACTION_LABELS[pending.action] : "";
  const destructive = pending ? SERVICE_ACTIONS_CONFIRMED.has(pending.action) : false;
  /* Typing the count is friction worth having when the verb takes things
   * down across hosts, and noise when it brings them up. */
  const confirmText = destructive && count > 1 ? String(count) : undefined;

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={
        count === 1 && first ? `${label} ${first.unit}?` : `${label} ${pluralize(count, "unit")}?`
      }
      description={
        count === 1 && first
          ? `${label} runs as a job on ${first.server_name}. You can watch it in the job drawer.`
          : `Each unit gets its own job, grouped under one activity entry. Nothing is retried automatically.`
      }
      confirmText={confirmText}
      confirmLabel={label}
      destructive={destructive}
      loading={single.isPending || bulk.isPending}
      onConfirm={() => {
        if (!pending) return;
        dispatch(pending.action, pending.services);
        setPending(null);
      }}
    >
      {count > 1 && (
        <ul className="max-h-40 overflow-auto rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] p-2">
          {pending?.services.slice(0, 20).map((service) => (
            <li key={service.id} className="kn-mono truncate text-sm text-[var(--kn-text-2)]">
              {service.server_name} · {service.unit}
            </li>
          ))}
          {count > 20 && (
            <li className="pt-1 text-sm text-[var(--kn-text-3)]">
              and {formatCount(count - 20)} more
            </li>
          )}
        </ul>
      )}
    </ConfirmDialog>
  );

  return {
    request,
    pending: single.isPending || bulk.isPending,
    rowActions,
    bulkActions,
    dialog,
  };
}
