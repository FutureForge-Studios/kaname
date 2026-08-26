"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CloudDownload, ExternalLink, Power, ShieldOff, Terminal, Trash2 } from "lucide-react";
import type { Job, Server } from "@kaname/contract";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  MonoText,
  Select,
  type DataTableRowAction,
} from "@kaname/ui";
import { api } from "@/lib/api";
import { useCan, useMutationWithJob } from "@/lib/queries";
import { formatCount, pluralize } from "@/lib/format";
import { useServerDelete, useServerReboot, useServerRevoke, useServerSync } from "../_lib/infra";
import { EnrollmentPanel } from "./EnrollmentPanel";

/* ------------------------------------------------------------------ *
 * Server verbs.
 *
 * Reboot, revoke and remove are the three things in this product that
 * an operator cannot take back, so all three share one confirmation
 * shape — typed server name, plain statement of what happens, no
 * "are you sure" — and the fleet table and the detail page's danger
 * zone both go through it rather than each rolling their own.
 * ------------------------------------------------------------------ */

export type ServerCommandKind = "reboot" | "revoke" | "remove" | "enroll";

const REBOOT_DELAYS = [
  { value: "0", label: "Immediately" },
  { value: "60", label: "In 1 minute" },
  { value: "300", label: "In 5 minutes" },
];

interface Pending {
  kind: ServerCommandKind;
  servers: Server[];
}

export interface ServerCommandsOptions {
  /** Lets a detail page leave the route it no longer has a row for. */
  onRemoved?: (server: Server) => void;
}

export interface ServerCommands {
  request: (kind: ServerCommandKind, servers: Server | Server[]) => void;
  sync: (servers: Server | Server[]) => void;
  syncing: boolean;
  rowActions: (server: Server) => DataTableRowAction<Server>[];
  bulkActions: (ids: string[], rows: readonly Server[]) => React.ReactNode;
  /** Mount once per page. */
  dialogs: React.ReactNode;
}

interface FanOutVars {
  servers: Server[];
  label: string;
  send: (server: Server) => Promise<{ job: Job }>;
}

/**
 * There is no bulk server route, so the panel fans out and groups the
 * jobs itself. `allSettled` matters: one host that refuses must not
 * discard the jobs that were accepted for the rest.
 */
function useServerFanOut() {
  return useMutationWithJob<FanOutVars>({
    mutationFn: async ({ servers, send }) => {
      const results = await Promise.allSettled(servers.map(send));
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
    invalidates: ["servers", "services", "containers"],
    describe: ({ label }) => label,
  });
}

export function useServerCommands(options: ServerCommandsOptions = {}): ServerCommands {
  const router = useRouter();
  const can = useCan();

  const reboot = useServerReboot();
  const syncOne = useServerSync();
  const fanOut = useServerFanOut();
  const revoke = useServerRevoke();
  const remove = useServerDelete();

  const [pending, setPending] = React.useState<Pending | null>(null);
  const [delay, setDelay] = React.useState("0");

  const request = React.useCallback((kind: ServerCommandKind, servers: Server | Server[]) => {
    const list = Array.isArray(servers) ? servers : [servers];
    if (list.length === 0) return;
    setDelay("0");
    setPending({ kind, servers: list });
  }, []);

  const sync = React.useCallback(
    (servers: Server | Server[]) => {
      const list = Array.isArray(servers) ? servers : [servers];
      const first = list[0];
      if (!first) return;
      if (list.length === 1) {
        syncOne.mutate({ server: first });
        return;
      }
      fanOut.mutate({
        servers: list,
        label: `Sync ${pluralize(list.length, "server")}`,
        send: (server) => api.post<{ job: Job }>(`/servers/${server.id}/sync`),
      });
    },
    [fanOut, syncOne],
  );

  const rowActions = React.useCallback(
    (server: Server): DataTableRowAction<Server>[] => {
      const write = can("infra.servers:write", server.id);
      const destroy = can("infra.servers:delete", server.id);
      const connected = server.connection === "connected";
      return [
        {
          id: "open",
          label: "Open server",
          icon: ExternalLink,
          onSelect: () => router.push(`/infrastructure/servers/${server.id}`),
        },
        {
          id: "terminal",
          label: "Open terminal",
          icon: Terminal,
          disabled: !connected || !can("terminal.session:exec", server.id),
          onSelect: () => router.push(`/terminal?server_id=${server.id}`),
        },
        {
          id: "sync",
          label: "Sync from host",
          icon: CloudDownload,
          separatorBefore: true,
          disabled: !connected,
          onSelect: () => sync(server),
        },
        {
          id: "enroll",
          label: "Enrollment command",
          icon: Terminal,
          disabled: !write,
          onSelect: () => request("enroll", server),
        },
        {
          id: "reboot",
          label: "Reboot",
          icon: Power,
          separatorBefore: true,
          destructive: true,
          disabled: !write || !connected,
          onSelect: () => request("reboot", server),
        },
        {
          id: "revoke",
          label: "Revoke certificate",
          icon: ShieldOff,
          destructive: true,
          disabled: !write || server.connection === "revoked",
          onSelect: () => request("revoke", server),
        },
        {
          id: "remove",
          label: "Remove from Kaname",
          icon: Trash2,
          destructive: true,
          disabled: !destroy,
          onSelect: () => request("remove", server),
        },
      ];
    },
    [can, request, router, sync],
  );

  const bulkActions = React.useCallback(
    (ids: string[], rows: readonly Server[]) => {
      const selected = rows.filter((server) => ids.includes(server.id));
      const connected = selected.filter((server) => server.connection === "connected");
      const canWrite =
        selected.length > 0 && selected.every((server) => can("infra.servers:write", server.id));

      return (
        <>
          <Button
            variant="secondary"
            size="xs"
            icon={CloudDownload}
            disabled={connected.length === 0}
            onClick={() => sync(connected)}
          >
            Sync{connected.length > 0 ? ` ${formatCount(connected.length)}` : ""}
          </Button>
          <Button
            variant="danger-subtle"
            size="xs"
            icon={Power}
            disabled={!canWrite || connected.length === 0}
            onClick={() => request("reboot", connected)}
          >
            Reboot
          </Button>
          {connected.length < selected.length && (
            <span className="text-xs text-[var(--kn-text-3)]">
              {formatCount(selected.length - connected.length)} of the selected hosts are not
              connected and are skipped.
            </span>
          )}
        </>
      );
    },
    [can, request, sync],
  );

  const servers = pending?.servers ?? [];
  const first = servers[0];
  const many = servers.length > 1;

  const dialogs = (
    <>
      <ConfirmDialog
        open={pending?.kind === "reboot"}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={many ? `Reboot ${pluralize(servers.length, "server")}?` : `Reboot ${first?.name}?`}
        description="Everything on the host stops. The agent reconnects on its own once the box is back; jobs queued in the meantime wait for it."
        confirmText={many ? String(servers.length) : first?.name}
        confirmLabel="Reboot"
        loading={reboot.isPending || fanOut.isPending}
        onConfirm={() => {
          const seconds = Number.parseInt(delay, 10) || 0;
          if (!first) return;
          if (many) {
            fanOut.mutate({
              servers,
              label: `Reboot ${pluralize(servers.length, "server")}`,
              send: (server) =>
                api.post<{ job: Job }>(`/servers/${server.id}/reboot`, { delay_seconds: seconds }),
            });
          } else {
            reboot.mutate({ server: first, delaySeconds: seconds });
          }
          setPending(null);
        }}
      >
        <FormField label="When">
          <Select
            options={REBOOT_DELAYS}
            value={delay}
            onChange={(event) => setDelay(event.target.value)}
          />
        </FormField>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === "revoke"}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={`Revoke ${first?.name}'s certificate?`}
        description="The socket drops immediately and the host cannot reconnect until it is enrolled again. Nothing on the box is changed or stopped."
        confirmText={first?.name}
        confirmLabel="Revoke"
        loading={revoke.isPending}
        onConfirm={() => {
          if (first) revoke.mutate({ server: first });
          setPending(null);
        }}
      />

      <ConfirmDialog
        open={pending?.kind === "remove"}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={`Remove ${first?.name} from Kaname?`}
        description="The agent is disconnected and everything the panel knows about this host — cached units, containers, metrics, storage samples — is deleted. The host itself keeps running exactly as it is."
        confirmText={first?.name}
        confirmLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => {
          if (!first) return;
          const target = first;
          remove.mutate({ server: target }, { onSuccess: () => options.onRemoved?.(target) });
          setPending(null);
        }}
      >
        <p className="text-[var(--kn-text-2)]">
          Audit history is append-only and is not removed with the server (KD-009).
        </p>
      </ConfirmDialog>

      <Dialog
        open={pending?.kind === "enroll"}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        size="lg"
      >
        <DialogHeader
          title={`Enroll ${first?.name}`}
          description={
            <>
              Run this on <MonoText muted>{first?.hostname}</MonoText> as root. Any previously
              issued token is superseded.
            </>
          }
        />
        <DialogBody>{first && <EnrollmentPanel server={first} />}</DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => setPending(null)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );

  return {
    request,
    sync,
    syncing: syncOne.isPending || fanOut.isPending,
    rowActions,
    bulkActions,
    dialogs,
  };
}
