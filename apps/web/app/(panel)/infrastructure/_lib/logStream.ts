"use client";

import * as React from "react";
import type { LogRecord } from "@kaname/contract";
import type { LogLine } from "@kaname/ui";
import { ApiError, buildPath, encodeParams, redirectToLogin, type QueryParams } from "@/lib/api";

/* ------------------------------------------------------------------ *
 * Followed log tails.
 *
 * The journal and container-output endpoints answer with SSE when
 * `follow=true`, framed exactly like /events but carrying `log`, `end`
 * and `error` events. That is a different contract from the multiplexed
 * feed in lib/events, so it gets its own reader rather than a flag on
 * that one.
 *
 * Lines are buffered and flushed on an interval: a chatty unit emits
 * faster than React can usefully re-render, and a per-line setState
 * would spend the whole frame budget on a viewer that is virtualized
 * anyway.
 * ------------------------------------------------------------------ */

const FLUSH_MS = 100;
const DEFAULT_MAX_LINES = 5000;

export type LogTailStatus = "idle" | "connecting" | "streaming" | "ended" | "failed";

export interface LogTailOptions {
  /** API path, e.g. `/services/<id>/logs`. Null suspends the stream. */
  path: string | null;
  params?: QueryParams;
  enabled?: boolean;
  /** Ring-buffer bound; an unbounded tail is an out-of-memory tab. */
  max?: number;
}

export interface LogTail {
  lines: LogLine[];
  status: LogTailStatus;
  error: ApiError | null;
  /** Drops the buffer and reopens the stream. */
  restart: () => void;
}

interface ErrorFrame {
  code?: string;
  message?: string;
}

export function useLogTail({
  path,
  params,
  enabled = true,
  max = DEFAULT_MAX_LINES,
}: LogTailOptions): LogTail {
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [status, setStatus] = React.useState<LogTailStatus>("idle");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [nonce, setNonce] = React.useState(0);

  const query = encodeParams(params);
  const active = enabled && path !== null;

  React.useEffect(() => {
    if (!active || path === null) {
      setStatus("idle");
      return;
    }

    const controller = new AbortController();
    let seq = 0;
    let pending: LogLine[] = [];
    let flushTimer = 0;

    setLines([]);
    setError(null);
    setStatus("connecting");

    const flush = () => {
      flushTimer = 0;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setLines((previous) => {
        const next = previous.concat(batch);
        return next.length > max ? next.slice(next.length - max) : next;
      });
    };

    const push = (line: LogLine) => {
      pending.push(line);
      if (flushTimer === 0) flushTimer = window.setTimeout(flush, FLUSH_MS);
    };

    const dispatch = (frame: string) => {
      let event = "message";
      const data: string[] = [];

      for (const rawLine of frame.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0 || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const rest = colon === -1 ? "" : line.slice(colon + 1);
        const value = rest.startsWith(" ") ? rest.slice(1) : rest;
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }

      if (data.length === 0) return;

      let payload: unknown;
      try {
        payload = JSON.parse(data.join("\n"));
      } catch {
        return;
      }

      if (event === "log") {
        const record = payload as LogRecord;
        seq += 1;
        push({
          id: `${record.cursor ?? record.ts}:${seq}`,
          ts: record.ts,
          level: record.level,
          message: record.message,
          source: record.source,
        });
        return;
      }

      if (event === "error") {
        const frameError = payload as ErrorFrame;
        setError(
          new ApiError({
            code: (frameError.code as ApiError["code"]) ?? "agent_error",
            message: frameError.message ?? "The log stream ended unexpectedly.",
            status: 502,
          }),
        );
        setStatus("failed");
      }
    };

    void (async () => {
      let response: Response;
      try {
        response = await fetch(buildPath(path, params), {
          headers: { Accept: "text/event-stream" },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) return;
        setError(
          new ApiError({
            code: "network_error",
            message: "The control plane did not answer the log stream.",
            status: 0,
            remediation: {
              summary:
                "The panel could not open the stream. Check that the control plane is running, then reconnect.",
              actions: [{ label: "Reconnect", action: "logs.reconnect" }],
            },
          }),
        );
        setStatus("failed");
        return;
      }

      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        let envelope: { error?: ErrorFrame & { remediation?: ApiError["remediation"] } } = {};
        try {
          envelope = text ? (JSON.parse(text) as typeof envelope) : {};
        } catch {
          /* A non-JSON body is still a failure with a status to report. */
        }
        setError(
          new ApiError({
            code: (envelope.error?.code as ApiError["code"]) ?? "agent_error",
            message: envelope.error?.message ?? `The log stream answered ${response.status}.`,
            status: response.status,
            remediation: envelope.error?.remediation ?? null,
          }),
        );
        setStatus("failed");
        return;
      }

      setStatus("streaming");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            dispatch(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        /* An abort is our own teardown; a broken socket ends the tail. */
      }

      flush();
      if (!controller.signal.aborted) {
        setStatus((previous) => (previous === "failed" ? previous : "ended"));
      }
    })();

    return () => {
      controller.abort();
      if (flushTimer !== 0) window.clearTimeout(flushTimer);
    };
    // `params` is rebuilt on every render; `query` is its stable identity.
  }, [active, max, nonce, path, query]);

  const restart = React.useCallback(() => setNonce((value) => value + 1), []);

  return { lines, status, error, restart };
}
