"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Play, Send, Square } from "lucide-react";
import type { LogLevel, MailServer } from "@kaname/contract";
import {
  Button,
  EmptyState,
  Input,
  LogViewer,
  PageHeader,
  SectionCard,
  cn,
  type LogLine,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import type { ApiError } from "@/lib/api";
import { useServers } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { useMailServers } from "../_components/queries";
import { MailServerPicker } from "../_components/status";
import { openMailLogTail, type MailLogLine, type MailTailStatus } from "../_components/tail";

/* ------------------------------------------------------------------ *
 * Mail logs.
 *
 * One surface: what is happening right now, read straight off the host.
 * Yunori drives Stalwart, and Stalwart's log is a stream on the box, not
 * a store the control plane ingests, so there is no search tab — a
 * "search" over nothing would be a page that lies about history. The
 * filter is pushed down to the host so a busy server does not flood the
 * socket.
 * ------------------------------------------------------------------ */

const MAX_TAIL_LINES = 5000;
const TAIL_BACKLOG = 200;
/** A busy server writes several lines per message; React gets them in batches. */
const TAIL_FLUSH_MS = 120;

const STATUS_LABELS: Record<MailTailStatus, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Stopped",
};

/**
 * Stalwart's tracing lines carry a level word; yunori-mail's do too. The
 * parse is a reading aid for the viewer's level filter, not a claim
 * about the record's severity on disk.
 */
function levelFor(line: string): LogLevel {
  if (/\b(FATAL|PANIC)\b/i.test(line)) return "fatal";
  if (/\bERROR\b|\brejected\b|\bbounce[ds]?\b/i.test(line)) return "error";
  if (/\bWARN(ING)?\b|\bdeferred\b|\bgreylist/i.test(line)) return "warn";
  if (/\bDEBUG\b|\bTRACE\b/i.test(line)) return "debug";
  if (/\bINFO\b|\bdelivered\b|\baccepted\b/i.test(line)) return "info";
  return "notice";
}

export default function MailLogsPage() {
  const router = useRouter();
  const pathname = usePathname() ?? "/email/logs";
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get("server_id");

  const mailServers = useMailServers();
  const hosts = useServers();

  /* Only hosts that both have a mail_servers row and still advertise the
   * yunori capability: a row whose binary was removed by hand cannot be
   * tailed, and should not be offered. Hosts outside this account's
   * fleet scope are kept, since the row itself is proof enough. */
  const eligible = React.useMemo<MailServer[]>(() => {
    const rows = mailServers.data?.data ?? [];
    const byId = new Map((hosts.data?.data ?? []).map((host) => [host.id, host]));
    return rows.filter((row) => {
      const host = byId.get(row.server_id);
      return host ? host.capabilities.includes("yunori") : true;
    });
  }, [hosts.data, mailServers.data]);

  /* As on Health: a link to a server that is not here must not quietly
   * tail a different one. */
  const unmatched =
    fromUrl !== null &&
    !mailServers.isLoading &&
    !hosts.isLoading &&
    eligible.length > 0 &&
    !eligible.some((row) => row.id === fromUrl || row.server_id === fromUrl);

  const selected = React.useMemo<MailServer | null>(() => {
    if (fromUrl) {
      const match = eligible.find((row) => row.id === fromUrl || row.server_id === fromUrl);
      if (match) return match;
      // Never fall back to another server on a link that names one: not
      // while the lists are still loading (that rewrote the URL before the
      // mismatch could be shown), and not after.
      return null;
    }
    return eligible[0] ?? null;
  }, [eligible, fromUrl]);

  const select = React.useCallback(
    (server: MailServer | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (server) next.set("server_id", server.server_id);
      else next.delete("server_id");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  React.useEffect(() => {
    if (mailServers.isLoading || !selected) return;
    if (fromUrl !== selected.server_id && fromUrl !== selected.id) select(selected);
  }, [fromUrl, mailServers.isLoading, select, selected]);

  const serverId = selected?.server_id ?? null;

  const [filter, setFilter] = React.useState("");
  const [applied, setApplied] = React.useState("");
  const [running, setRunning] = React.useState(true);
  /** Bumped by Retry so the effect reopens a tail even when nothing else changed. */
  const [session, setSession] = React.useState(0);
  const [status, setStatus] = React.useState<MailTailStatus>("closed");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const sequence = React.useRef(0);

  React.useEffect(() => {
    setLines([]);
    setError(null);
    sequence.current = 0;
  }, [serverId, applied]);

  React.useEffect(() => {
    if (!serverId || !running) {
      setStatus("closed");
      return;
    }

    const buffer: LogLine[] = [];
    const flush = setInterval(() => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      setLines((current) => {
        const next = current.concat(batch);
        return next.length > MAX_TAIL_LINES ? next.slice(next.length - MAX_TAIL_LINES) : next;
      });
    }, TAIL_FLUSH_MS);

    const stop = openMailLogTail({
      serverId,
      lines: TAIL_BACKLOG,
      ...(applied ? { q: applied } : {}),
      onStatusChange: setStatus,
      onError: (failure) => {
        setError(failure);
        // The stream is closed; the toggle has to say so or the next
        // click would "stop" something that already stopped.
        setRunning(false);
      },
      onLine: (record: MailLogLine) => {
        sequence.current += 1;
        buffer.push({
          id: `mail-${sequence.current}`,
          ts: record.ts,
          level: levelFor(record.line),
          message: record.line,
        });
      },
      onGap: () => {
        sequence.current += 1;
        buffer.push({
          id: `mail-${sequence.current}`,
          ts: new Date().toISOString(),
          level: "notice",
          message: "— reconnected; lines written in between are not shown —",
        });
      },
    });

    return () => {
      clearInterval(flush);
      stop();
    };
  }, [applied, running, serverId, session]);

  const loading = mailServers.isLoading || hosts.isLoading;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Mail logs"
        subtitle={selected?.hostname ?? "Live from the mail engine on the host"}
        actions={
          <Button
            variant={running ? "secondary" : "primary"}
            size="sm"
            icon={running ? Square : Play}
            disabled={!serverId}
            onClick={() => setRunning((current) => !current)}
          >
            {running ? "Stop" : "Start"}
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <MailServerPicker value={selected?.id ?? null} onChange={(_id, server) => select(server)} />
          {selected && <HostCell serverId={selected.server_id} serverName={selected.server_name} />}

          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setApplied(filter.trim());
            }}
          >
            <Input
              size="sm"
              mono
              value={filter}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
              placeholder="Filter on the host"
              aria-label="Filter the tail on the host"
              boxClassName="w-64"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="secondary" size="sm">
              Apply
            </Button>
            {applied && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilter("");
                  setApplied("");
                }}
              >
                Clear
              </Button>
            )}
          </form>

          <span
            className="ml-auto flex items-center gap-1.5 text-xs text-[var(--kn-text-3)]"
            title="Filtering happens on the host, so a busy server does not push every line down this socket."
          >
            <span
              aria-hidden
              className={cn(
                "h-1.5 w-1.5 rounded-[var(--kn-r-pill)]",
                status === "open"
                  ? "bg-[var(--kn-ok)]"
                  : status === "closed"
                    ? "bg-[var(--kn-text-3)]"
                    : "bg-[var(--kn-warn)] animate-[kn-pulse-ring_1.8s_ease-in-out_infinite]",
              )}
            />
            {STATUS_LABELS[status]}
          </span>
        </div>

        {mailServers.isError && (
          <PageError
            error={mailServers.error}
            onRetry={() => void mailServers.refetch()}
            context="Mail servers"
          />
        )}

        {error && (
          <PageError
            error={error}
            onRetry={() => {
              setError(null);
              setRunning(true);
              setSession((current) => current + 1);
            }}
            context="Live tail"
          />
        )}

        {unmatched ? (
          <SectionCard>
            <EmptyState
              icon={Send}
              title="No mail server matches this link"
              description={`The link names ${fromUrl}, which is not a mail server you can tail here. It may have been forgotten, or Yunori is no longer installed on it.`}
              action={
                <Button variant="secondary" size="sm" onClick={() => select(eligible[0] ?? null)}>
                  Tail {eligible[0]?.server_name}
                </Button>
              }
            />
          </SectionCard>
        ) : !serverId && !loading && !mailServers.isError ? (
          <SectionCard>
            <EmptyState
              icon={Send}
              title="No mail server to tail"
              description="The live tail reads the mail engine's log off a host running Yunori Mail Server, and Kaname manages none this account can reach."
              action={
                <Button variant="primary" size="sm" onClick={() => router.push("/email")}>
                  Go to mail servers
                </Button>
              }
            />
          </SectionCard>
        ) : (
          <LogViewer
            lines={lines}
            height="100%"
            label={`Mail log on ${selected?.server_name ?? "the selected host"}`}
            emptyLabel={
              loading
                ? "Finding mail servers…"
                : running
                  ? "Connected. Nothing has passed through since this tail opened."
                  : "The tail is stopped."
            }
            className="min-h-0 flex-1"
          />
        )}
      </div>
    </div>
  );
}
