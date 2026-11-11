"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Plug, PlugZap, SquareTerminal, Unplug } from "lucide-react";
import type { TerminalSessionTicket } from "@kaname/contract";
import { Badge, Button, EmptyState, NumberedSection, Skeleton, cn } from "@kaname/ui";
import type { TerminalStatus } from "@/components/TerminalPane";
import { RecordingNotice } from "@/components/RecordingNotice";
import { api } from "@/lib/api";
import { useCan } from "@/lib/queries";
import { TerminalWell } from "./TerminalWell";

/* ------------------------------------------------------------------ *
 * A container's Exec tab: an interactive shell inside the container.
 *
 * It used to print `docker exec -it <name> sh` and send the operator to
 * a host terminal, which left `container.exec` unused and put a root
 * shell on the host between them and the container. Now the tab opens
 * `container.exec` itself, over the terminal's own path (KD-013): the
 * same single-use, address-bound ticket from POST /terminal/sessions,
 * the same audit entries on open and close, the same recording, and the
 * same pane minting a ticket per socket (KD-024). The control plane is
 * what decides; the button only mirrors it.
 * ------------------------------------------------------------------ */

const TerminalPane = dynamic(
  () => import("@/components/TerminalPane").then((module) => module.TerminalPane),
  {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full rounded-none" label="Loading the terminal" />,
  },
);

const STATUS_LABELS: Record<TerminalStatus, string> = {
  connecting: "Connecting",
  open: "Connected",
  closed: "Disconnected",
  error: "Disconnected",
};

const STATUS_TONES: Record<TerminalStatus, "ok" | "warn" | "danger" | "neutral"> = {
  connecting: "warn",
  open: "ok",
  closed: "neutral",
  error: "danger",
};

export interface ContainerExecProps {
  container: {
    id: string;
    name: string;
    server_id: string;
    server_name: string;
    state: string;
  };
  connected: boolean;
}

export function ContainerExec({ container, connected }: ContainerExecProps) {
  const can = useCan();
  const [wanted, setWanted] = React.useState(false);
  const [generation, setGeneration] = React.useState(0);
  const [status, setStatus] = React.useState<TerminalStatus>("closed");
  const [detail, setDetail] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<TerminalSessionTicket | null>(null);
  const [geometry, setGeometry] = React.useState({ cols: 80, rows: 24 });

  // Both halves, as the API checks them: a shell is terminal.session:exec,
  // and reaching into this container is infra.containers:exec.
  const mayShell = can("terminal.session:exec", container.server_id);
  const mayContainer = can("infra.containers:exec", container.server_id);
  const running = container.state === "running";
  const ready = connected && running && mayShell && mayContainer;

  const blocked = !mayShell
    ? "This account does not hold terminal.session:exec on this host. A shell inside a container is a shell on the host's kernel, so it is the terminal's permission, not the container's."
    : !mayContainer
      ? "This account does not hold infra.containers:exec on this host."
      : !connected
        ? `${container.server_name}'s agent is not connected, so there is nothing to exec through.`
        : !running
          ? `${container.name} is ${container.state}. Start it to open a shell inside it.`
          : null;

  const mint = React.useCallback(
    (signal: AbortSignal) =>
      api.post<TerminalSessionTicket>(
        "/terminal/sessions",
        {
          server_id: container.server_id,
          container_id: container.id,
          cols: geometry.cols,
          rows: geometry.rows,
        },
        { signal },
      ),
    [container.server_id, container.id, geometry.cols, geometry.rows],
  );

  /* Mounting the pane is what mints the ticket (KD-024), so connecting is
   * only a state change; minting here too would leave a spare ticket. */
  const connect = () => {
    setDetail(null);
    setSession(null);
    setStatus("connecting");
    setWanted(true);
    setGeneration((n) => n + 1);
  };

  const disconnect = () => {
    setWanted(false);
    setSession(null);
    setStatus("closed");
    setDetail(null);
  };

  return (
    <NumberedSection
      index={1}
      title="Exec"
      caption="A shell inside the container, ticketed, audited and recorded like the host terminal."
      actions={
        wanted && (
          <Badge tone={STATUS_TONES[status]} size="sm">
            {STATUS_LABELS[status]}
          </Badge>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {wanted ? (
          <>
            <Button variant="secondary" size="sm" icon={Unplug} onClick={disconnect}>
              Disconnect
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={PlugZap}
              loading={status === "connecting"}
              disabled={!ready}
              onClick={connect}
            >
              Reconnect
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" icon={Plug} disabled={!ready} onClick={connect}>
            Open shell in {container.name}
          </Button>
        )}
        <span className="text-sm text-[var(--kn-text-3)]">
          It is a shell on the host&apos;s kernel, so it goes through the terminal&apos;s path
          (KD-013).
        </span>
      </div>

      {session && (
        <RecordingNotice
          recorded={session.recorded}
          serverName={`${container.name} on ${session.server_name}`}
        />
      )}

      {wanted && (status === "closed" || status === "error") && detail && (
        <div
          role="status"
          className={cn(
            "flex flex-wrap items-center gap-3 rounded-[var(--kn-r-lg)] border px-3 py-2",
            status === "error"
              ? "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]"
              : "border-[var(--kn-border)] bg-[var(--kn-surface)]",
          )}
        >
          <span className="text-[var(--kn-text)]">The session ended: {detail}.</span>
        </div>
      )}

      <TerminalWell
        title={`exec · ${container.name} on ${container.server_name}`}
        status={wanted ? status : null}
        geometry={geometry}
        className="h-[420px] lg:h-[520px]"
      >
        {wanted ? (
          <TerminalPane
            key={generation}
            connect={mint}
            onSession={(next) => setSession(next as TerminalSessionTicket)}
            onStatusChange={(next, why) => {
              setStatus(next);
              setDetail(why ?? null);
            }}
            onGeometry={setGeometry}
            framed={false}
            className="h-full"
          />
        ) : (
          <div className="kn-grid flex h-full items-center justify-center [--kn-grid-size:24px]">
            <EmptyState
              icon={SquareTerminal}
              title={ready ? "Not connected" : "Exec is unavailable"}
              description={
                blocked ??
                "A session opens with a single-use ticket that expires in 30 seconds, is bound to your address, and is written to the audit trail on open and on close."
              }
            />
          </div>
        )}
      </TerminalWell>
    </NumberedSection>
  );
}
