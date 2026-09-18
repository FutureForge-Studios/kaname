"use client";

import * as React from "react";
import type { DeploymentStatus, LogLevel } from "@kaname/contract";
import type { LogLine } from "@kaname/ui";
import { API_BASE } from "@/lib/api";

/* ------------------------------------------------------------------ *
 * The deployment build log.
 *
 * `GET /deployments/:id/log` replays the job's stored lines and then
 * keeps the connection open for the rest of the run, so a build watched
 * from the start and one opened halfway through render the same thing.
 *
 * The stream is read with EventSource rather than the panel's own SSE
 * client because this feed needs nothing that client exists for: it has
 * no `Last-Event-ID` resumption — the endpoint replays from the first
 * line on every connect. That also means an automatic reconnect would
 * duplicate the whole log, so a dropped connection stops and offers a
 * retry instead of silently reattaching.
 * ------------------------------------------------------------------ */

/** A long build is thousands of lines; a runaway one must not be unbounded. */
const MAX_LINES = 20_000;
/** npm and Docker print hundreds of lines a second; React gets them per frame, not per line. */
const FLUSH_MS = 100;

export type DeploymentLogState = "connecting" | "streaming" | "ended" | "expired" | "error";

export interface DeploymentLog {
  lines: LogLine[];
  /** 0-100 while the job reports it, null otherwise. */
  progress: number | null;
  /** Latest status the deployment topic pushed, if any. */
  status: DeploymentStatus | null;
  state: DeploymentLogState;
  retry: () => void;
}

interface LogEventData {
  ts?: string;
  level?: LogLevel;
  message?: string;
}

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function useDeploymentLog(deploymentId: string | null, enabled: boolean): DeploymentLog {
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [status, setStatus] = React.useState<DeploymentStatus | null>(null);
  const [state, setState] = React.useState<DeploymentLogState>("connecting");
  const [attempt, setAttempt] = React.useState(0);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);

  React.useEffect(() => {
    if (!deploymentId || !enabled || typeof window === "undefined") return;

    setLines([]);
    setProgress(null);
    setState("connecting");

    const source = new EventSource(`${API_BASE}/deployments/${deploymentId}/log`);
    let seq = 0;
    let closed = false;
    let pending: LogLine[] = [];
    let flushTimer = 0;

    const flush = (): void => {
      flushTimer = 0;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setLines((previous) => {
        const next = previous.concat(batch);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (flushTimer !== 0) window.clearTimeout(flushTimer);
      flush();
      source.close();
    };

    source.addEventListener("open", () => setState("streaming"));

    source.addEventListener("log", (event) => {
      const data = parse<LogEventData>((event as MessageEvent<string>).data);
      if (!data) return;
      seq += 1;
      pending.push({
        id: `${deploymentId}-${seq}`,
        ts: data.ts,
        level: data.level ?? "info",
        message: data.message ?? "",
      });
      if (flushTimer === 0) flushTimer = window.setTimeout(flush, FLUSH_MS);
    });

    source.addEventListener("progress", (event) => {
      const data = parse<{ progress?: number | null }>((event as MessageEvent<string>).data);
      setProgress(data?.progress ?? null);
    });

    source.addEventListener("status", (event) => {
      const data = parse<{ status?: DeploymentStatus }>((event as MessageEvent<string>).data);
      if (data?.status) setStatus(data.status);
    });

    source.addEventListener("end", (event) => {
      const data = parse<{ reason?: string; status?: DeploymentStatus }>(
        (event as MessageEvent<string>).data,
      );
      if (data?.status) setStatus(data.status);
      setState(data?.reason === "log_expired" ? "expired" : "ended");
      close();
    });

    source.addEventListener("error", () => {
      // EventSource would reattach on its own and replay the whole log.
      setState((current) => (current === "ended" || current === "expired" ? current : "error"));
      close();
    });

    return close;
  }, [deploymentId, enabled, attempt]);

  return { lines, progress, status, state, retry };
}
