"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  ClipboardPaste,
  Eraser,
  History,
  Plug,
  PlugZap,
  RadioTower,
  Search,
  ShieldAlert,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import type { TerminalSessionRecord, TerminalSessionTicket } from "@kaname/contract";
import {
  Badge,
  Button,
  ByteSize,
  DataTable,
  Duration,
  EmptyState,
  IconButton,
  Input,
  MonoText,
  PageHeader,
  RelativeTime,
  SectionCard,
  Select,
  Skeleton,
  cn,
  useToast,
  type DataTableColumn,
} from "@kaname/ui";
import type { TerminalController, TerminalStatus } from "@/components/TerminalPane";
import { PageError } from "@/components/PageError";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useCan, useList, useResourceMutation, useServers } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Terminal (KD-013).
 *
 * The one surface where the "no shell strings" rule cannot hold, so the
 * compensating controls are made visible rather than hidden: the
 * session is ticketed and single-use, it is a permission of its own,
 * and whether it is being recorded is stated on screen for as long as
 * it is open. A recorded root shell that does not say so would be worse
 * than an unrecorded one.
 *
 * The pane itself is loaded with `ssr: false` — xterm measures a real
 * character cell against a real font, which a server cannot do.
 * ------------------------------------------------------------------ */

const TerminalPane = dynamic(
  () => import("@/components/TerminalPane").then((module) => module.TerminalPane),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-full w-full rounded-[var(--kn-r-md)]" label="Loading the terminal" />
    ),
  },
);

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const HISTORY_PAGE_SIZE = 10;

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

export default function TerminalPage() {
  const { toast } = useToast();
  const can = useCan();
  const selection = useServerSelection({ permission: "terminal.session:exec" });

  const [posixUser, setPosixUser] = React.useState("root");
  /* True from Connect until Disconnect; the pane is mounted while it is. */
  const [wanted, setWanted] = React.useState(false);
  /* The ticket the pane actually redeemed, for the recording notice. */
  const [session, setSession] = React.useState<TerminalSessionTicket | null>(null);
  /* Bumped only by an explicit connect or reconnect. */
  const [generation, setGeneration] = React.useState(0);
  const [status, setStatus] = React.useState<TerminalStatus>("closed");
  const [detail, setDetail] = React.useState<string | null>(null);
  const [geometry, setGeometry] = React.useState({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });

  const [query, setQuery] = React.useState("");
  const [noMatch, setNoMatch] = React.useState(false);

  const controller = React.useRef<TerminalController | null>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  const allowed = can("terminal.session:exec", selection.serverId);

  /*
   * Connect is a local state change: mounting the pane is what mints the
   * ticket. Minting one here as well would leave an unredeemed ticket —
   * and an audit entry for a session that never happened — on every
   * click, because a ticket is spent on redemption (KD-013) and the pane
   * has to mint its own for every socket it opens.
   */
  const connectNow = React.useCallback(() => {
    setDetail(null);
    setStatus("connecting");
    setSession(null);
    setWanted(true);
    setGeneration((n) => n + 1);
  }, []);

  /*
   * The pane mints its own ticket for every socket it opens. A ticket is
   * spent on redemption (KD-013), so handing the pane a pre-minted URL
   * broke the moment React remounted the effect — which it does on every
   * mount in development and on every Fast Refresh.
   */
  const mintSession = React.useCallback(
    async (signal: AbortSignal): Promise<TerminalSessionTicket> => {
      const ticket = await api.post<TerminalSessionTicket>(
        "/terminal/sessions",
        {
          server_id: selection.serverId,
          cols: geometry.cols,
          rows: geometry.rows,
          ...(posixUser && posixUser !== "root" ? { user: posixUser } : {}),
        },
        { signal },
      );
      return ticket;
    },
    [selection.serverId, geometry.cols, geometry.rows, posixUser],
  );

  const disconnect = React.useCallback(() => {
    setWanted(false);
    setSession(null);
    setStatus("closed");
    setDetail(null);
    // The pane is unmounting; nothing should keep its 10k-line buffer alive.
    controller.current = null;
  }, []);

  /* A ticket is single-use, so reconnecting means minting a new one. */
  const reconnect = React.useCallback(() => {
    setStatus("connecting");
    setDetail(null);
    setGeneration((n) => n + 1);
  }, []);

  const runSearch = React.useCallback(
    (direction: "next" | "previous") => {
      if (!controller.current || query.length === 0) return;
      setNoMatch(!controller.current.search(query, direction));
    },
    [query],
  );

  const copy = React.useCallback(async () => {
    const ok = await controller.current?.copySelection();
    if (ok === false) {
      toast({
        variant: "warning",
        title: "Nothing copied",
        description:
          "Select some output first, or allow this page to use the clipboard in your browser.",
      });
    }
  }, [toast]);

  const paste = React.useCallback(async () => {
    const ok = await controller.current?.paste();
    if (ok === false) {
      toast({
        variant: "warning",
        title: "Nothing pasted",
        description: "The browser refused clipboard access. Ctrl+Shift+V pastes directly instead.",
      });
    }
  }, [toast]);

  const live = wanted && status !== "closed" && status !== "error";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Terminal"
        subtitle={
          selection.server ? `${selection.server.hostname} · ${posixUser}` : "no host selected"
        }
        actions={
          wanted && (
            <>
              <Badge tone={STATUS_TONES[status]} size="sm">
                {STATUS_LABELS[status]}
              </Badge>
              <MonoText muted className="hidden text-xs sm:inline">
                {geometry.cols}×{geometry.rows}
              </MonoText>
            </>
          )
        }
      />

      <div className="flex min-w-0 flex-col gap-3 px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <ServerPicker selection={selection} />

          <Input
            size="sm"
            mono
            aria-label="POSIX user to run as"
            title="The POSIX user the shell runs as. Audited either way."
            value={posixUser}
            disabled={wanted}
            spellCheck={false}
            autoComplete="off"
            boxClassName="w-28"
            onChange={(event) => setPosixUser(event.target.value)}
          />

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
                onClick={reconnect}
              >
                Reconnect
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={Plug}
              disabled={!selection.serverId || !allowed}
              onClick={connectNow}
            >
              Connect
            </Button>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <Input
              ref={searchRef}
              size="sm"
              mono
              icon={Search}
              value={query}
              invalid={noMatch}
              disabled={!live}
              placeholder="Find in buffer"
              aria-label="Find in the terminal buffer"
              spellCheck={false}
              boxClassName="w-44"
              onChange={(event) => {
                setQuery(event.target.value);
                setNoMatch(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
              }}
            />
            <IconButton
              icon={ChevronUp}
              label="Previous match"
              size="sm"
              disabled={!live || query.length === 0}
              onClick={() => runSearch("previous")}
            />
            <IconButton
              icon={ChevronDown}
              label="Next match"
              size="sm"
              disabled={!live || query.length === 0}
              onClick={() => runSearch("next")}
            />
            <IconButton
              icon={ClipboardCopy}
              label="Copy selection"
              size="sm"
              disabled={!live}
              onClick={() => void copy()}
            />
            <IconButton
              icon={ClipboardPaste}
              label="Paste"
              size="sm"
              disabled={!live}
              onClick={() => void paste()}
            />
            <IconButton
              icon={Eraser}
              label="Clear the screen"
              size="sm"
              disabled={!live}
              onClick={() => controller.current?.clear()}
            />
          </div>
        </div>

        {session && (
          <RecordingNotice recorded={session.recorded} serverName={session.server_name} />
        )}

        {(status === "closed" || status === "error") && wanted && detail && (
          <div
            role="status"
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-[var(--kn-r-sm)] border p-3",
              status === "error"
                ? "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]"
                : "border-[var(--kn-border)] bg-[var(--kn-surface)]",
            )}
          >
            <span className="text-[var(--kn-text)]">The session ended: {detail}.</span>
            <Button variant="secondary" size="xs" icon={PlugZap} onClick={reconnect}>
              Reconnect
            </Button>
          </div>
        )}

        <div className="h-[420px] min-h-0 w-full lg:h-[560px] 2xl:h-[672px]">
          {wanted ? (
            <TerminalPane
              key={generation}
              connect={mintSession}
              onSession={(next) => setSession(next as TerminalSessionTicket)}
              onReady={(next) => {
                controller.current = next;
              }}
              onStatusChange={(next, why) => {
                setStatus(next);
                setDetail(why ?? null);
              }}
              onGeometry={setGeometry}
              onRequestSearch={() => searchRef.current?.focus()}
              className="h-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)]">
              <EmptyState
                icon={SquareTerminal}
                title={selection.serverId ? "Not connected" : "Pick a server"}
                description={
                  allowed
                    ? "A session opens with a single-use ticket that expires in 30 seconds, is bound to your address, and is written to the audit trail on open and on close."
                    : "This account does not hold terminal.session:exec on that host, so it cannot open a shell there."
                }
                action={
                  selection.serverId &&
                  allowed && (
                    <Button variant="primary" size="sm" icon={Plug} onClick={connectNow}>
                      Connect to {selection.server?.name}
                    </Button>
                  )
                }
              />
            </div>
          )}
        </div>

        <SessionHistory />
      </div>
    </div>
  );
}

/* --------------------------- recording state ------------------------ */

function RecordingNotice({ recorded, serverName }: { recorded: boolean; serverName: string }) {
  if (recorded) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-info)] bg-[var(--kn-info-soft)] p-2.5"
      >
        <RadioTower size={14} className="mt-0.5 shrink-0 text-[var(--kn-info)]" aria-hidden />
        <p className="text-[var(--kn-text)]">
          <span className="font-medium">This session is being recorded.</span> Everything typed and
          everything printed on <MonoText>{serverName}</MonoText> is stored and replayable, and
          reading that recording back is itself audited.
        </p>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] p-2.5"
    >
      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
      <p className="text-[var(--kn-text)]">
        <span className="font-medium">This session is not being recorded.</span> Session recording
        is switched off for this install — the open and close are still audited, but what happens in
        between is not.
      </p>
    </div>
  );
}

/* --------------------------- session history ------------------------ */

function SessionHistory() {
  const servers = useServers();
  const [page, setPage] = React.useState(1);
  const [serverId, setServerId] = React.useState("");
  const [active, setActive] = React.useState("");

  const query = useList<TerminalSessionRecord>(
    "terminal-sessions",
    {
      page,
      per_page: HISTORY_PAGE_SIZE,
      sort: "started_at",
      order: "desc",
      server_id: serverId || undefined,
      active: active || undefined,
    },
    { path: "/terminal/sessions" },
  );

  const columns = React.useMemo<DataTableColumn<TerminalSessionRecord>[]>(
    () => [
      {
        id: "started_at",
        header: "Started",
        width: 132,
        locked: true,
        cell: (row) => <RelativeTime value={row.started_at} />,
      },
      {
        id: "server",
        header: "Server",
        width: 140,
        mono: true,
        accessor: (row) => row.server_name,
      },
      {
        id: "user",
        header: "Opened by",
        minWidth: 140,
        accessor: (row) => row.user_name,
      },
      {
        id: "duration",
        header: "Duration",
        width: 96,
        align: "right",
        cell: (row) =>
          row.ended_at ? (
            <Duration ms={row.duration_ms} />
          ) : (
            <Badge tone="ok" size="xs">
              open
            </Badge>
          ),
      },
      {
        id: "commands",
        header: "Lines sent",
        width: 96,
        align: "right",
        hideBelow: "md",
        cell: (row) => <span className="kn-num">{formatCount(row.command_count)}</span>,
      },
      {
        id: "bytes",
        header: "In / out",
        width: 140,
        align: "right",
        hideBelow: "lg",
        cell: (row) => (
          <span className="kn-num text-[var(--kn-text-2)]">
            <ByteSize bytes={row.bytes_in} precision={0} /> /{" "}
            <ByteSize bytes={row.bytes_out} precision={0} />
          </span>
        ),
      },
      {
        id: "recording",
        header: "Recording",
        width: 104,
        cell: (row) =>
          row.recording_available ? (
            <Badge tone="info" size="xs">
              recorded
            </Badge>
          ) : (
            <span className="text-[var(--kn-text-3)]">—</span>
          ),
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Session history"
      icon={History}
      padded={false}
      description="Every shell opened through the panel, whether or not it was recorded."
    >
      <DataTable<TerminalSessionRecord>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(row) => row.id}
        label="Terminal session history"
        density="compact"
        columnVisibility={false}
        page={page}
        perPage={HISTORY_PAGE_SIZE}
        total={query.data?.meta.total}
        onPageChange={setPage}
        loading={query.isLoading}
        skeletonRows={5}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter sessions by server"
              value={serverId}
              onChange={(event) => {
                setServerId(event.target.value);
                setPage(1);
              }}
              options={[
                { value: "", label: "Any server" },
                ...(servers.data?.data ?? []).map((server) => ({
                  value: server.id,
                  label: server.name,
                })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter sessions by state"
              value={active}
              onChange={(event) => {
                setActive(event.target.value);
                setPage(1);
              }}
              options={[
                { value: "", label: "Open and closed" },
                { value: "true", label: "Still open" },
                { value: "false", label: "Closed" },
              ]}
            />
          </div>
        }
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Session history"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={SquareTerminal}
            title="No sessions yet"
            description="Every shell opened through the panel is listed here with who opened it and for how long."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />
    </SectionCard>
  );
}
