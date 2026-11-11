import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Box, Circle, KeyRound, RotateCw, ShieldAlert, SquareTerminal } from "lucide-react";
import { useApp } from "../context";
import { base64ToBytes, textToBase64 } from "../lib/base64";
import {
  openExternal,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
  type DesktopError,
  type TerminalEvent,
} from "../lib/ipc";
import { ErrorNotice } from "../components/ErrorNotice";
import type { Tab } from "../tabs";

type TerminalTab = Extract<Tab, { kind: "terminal" }>;

type Status =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "closed"; reason: string; code: number | null }
  | { kind: "failed"; error: DesktopError };

const RESIZE_DEBOUNCE_MS = 120;

/** xterm colours from the design tokens, so the terminal follows the theme. */
function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme !== "light";
  return {
    background: v("--kn-bg-inset", "#060608"),
    foreground: v("--kn-text", "#f5f4f0"),
    cursor: v("--kn-accent-400", "#8a9ffa"),
    cursorAccent: v("--kn-bg-inset", "#060608"),
    selectionBackground: dark ? "rgba(91,118,247,0.35)" : "rgba(91,118,247,0.25)",
    black: dark ? "#1a1a1f" : "#0a0a0c",
    red: v("--kn-danger", "#f45b69"),
    green: v("--kn-ok", "#4fe3cb"),
    yellow: v("--kn-warn", "#fbb13c"),
    blue: v("--kn-info", "#7cb7ff"),
    magenta: dark ? "#c9b6ff" : "#6a3ee8",
    cyan: dark ? "#7fe7f2" : "#0b6e7a",
    white: dark ? "#b3b2af" : "#52525b",
    brightBlack: v("--kn-text-3", "#8e8d8b"),
    brightRed: dark ? "#ff8a95" : "#c42b3c",
    brightGreen: dark ? "#8ff0dd" : "#0b7564",
    brightYellow: dark ? "#ffd08a" : "#8f5300",
    brightBlue: dark ? "#a9cfff" : "#22639e",
    brightMagenta: dark ? "#ddd0ff" : "#5a30d4",
    brightCyan: dark ? "#b0f3fa" : "#0b6e7a",
    brightWhite: v("--kn-text", "#f5f4f0"),
  };
}

interface TerminalViewProps {
  tab: TerminalTab;
  active: boolean;
  theme: "dark" | "light";
}

export function TerminalView({ tab, active, theme }: TerminalViewProps) {
  const app = useApp();
  const connection = app.connection(tab.connectionId);
  const needsUser = connection?.auth_kind === "api_key";

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  /** Bumped on every (re)connect; events from an older socket are ignored. */
  const generation = useRef(0);
  const disposed = useRef(false);

  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [recorded, setRecorded] = useState(false);

  const safeFit = useCallback(() => {
    const host = hostRef.current;
    if (!host || host.offsetWidth === 0 || host.offsetHeight === 0) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* not attached yet */
    }
  }, []);

  const closeCurrent = useCallback(() => {
    const id = terminalIdRef.current;
    terminalIdRef.current = null;
    if (id) void terminalClose(id).catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    closeCurrent();
    const gen = ++generation.current;
    setStatus({ kind: "connecting" });
    safeFit();

    const onEvent = (event: TerminalEvent) => {
      if (gen !== generation.current) return;
      if (event.kind === "data") {
        term.write(base64ToBytes(event.b64));
      } else if (event.kind === "closed") {
        terminalIdRef.current = null;
        setStatus({ kind: "closed", code: event.code, reason: event.reason || "connection closed" });
        term.write(`\r\n\x1b[2m[session closed${event.reason ? `: ${event.reason}` : ""}]\x1b[0m\r\n`);
      } else if (event.kind === "error") {
        term.write(`\r\n\x1b[31m[${event.message}]\x1b[0m\r\n`);
      }
    };

    try {
      const opened = await terminalOpen(
        {
          id: tab.connectionId,
          serverId: tab.serverId,
          cols: term.cols,
          rows: term.rows,
          ...(tab.containerId ? { containerId: tab.containerId } : {}),
        },
        onEvent,
      );
      if (disposed.current || gen !== generation.current) {
        void terminalClose(opened.terminal_id).catch(() => undefined);
        return;
      }
      terminalIdRef.current = opened.terminal_id;
      setRecorded(opened.recorded);
      setStatus((s) => (s.kind === "closed" ? s : { kind: "open" }));
      if (active) term.focus();
    } catch (err) {
      if (gen !== generation.current) return;
      setStatus({ kind: "failed", error: app.handleError(tab.connectionId, err) });
    }
    // `active` is read for the initial focus only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, tab.serverId, tab.containerId, app.handleError, closeCurrent, safeFit]);

  // Create xterm once. Creation is deferred a tick: disposing an xterm in
  // the same task it was opened in (React StrictMode's mount → unmount →
  // mount) leaves a queued render that throws on the disposed renderer.
  useEffect(() => {
    if (needsUser || !hostRef.current) return;
    disposed.current = false;
    let teardown: (() => void) | undefined;
    const startTimer = setTimeout(() => {
      teardown = start();
    }, 0);
    return () => {
      clearTimeout(startTimer);
      disposed.current = true;
      generation.current += 1;
      teardown?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsUser]);

  function start(): (() => void) | undefined {
    if (!hostRef.current) return undefined;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: themeFromTokens(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri).catch(() => undefined)));
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // Let app shortcuts (⌘/Ctrl+T, W, 1–9) through instead of sending them to the shell.
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.metaKey || (e.ctrlKey && e.shiftKey);
      if (mod && /^(t|w|[1-9])$/i.test(e.key)) return false;
      return true;
    });

    const encoderSub = term.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void terminalWrite(id, textToBase64(data)).catch(() => undefined);
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeSub = term.onResize(({ cols, rows }) => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const id = terminalIdRef.current;
        if (id) void terminalResize(id, cols, rows).catch(() => undefined);
      }, RESIZE_DEBOUNCE_MS);
    });

    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(safeFit, 30);
    });
    observer.observe(hostRef.current);

    safeFit();
    void connect();

    return () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
      clearTimeout(fitTimer);
      encoderSub.dispose();
      resizeSub.dispose();
      closeCurrent();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => {
      safeFit();
      termRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [active, safeFit]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFromTokens();
  }, [theme]);

  const title = tab.containerName ? `${tab.containerName} on ${tab.serverName}` : tab.serverName;

  if (needsUser) {
    return (
      <div className="empty-main canvas">
        <div className="empty-card wide">
          <div className="label">
            <KeyRound size={12} /> Terminal needs a user session
          </div>
          <p>
            <strong>{connection?.name}</strong> is connected with an API key. Kaname only opens terminals for
            signed-in people — every session is tied to a user, audited, and can be recorded — so API keys are
            refused by design.
          </p>
          <p className="muted">
            Add this panel again with “Email &amp; password” sign-in (or switch this connection to it) to open
            shells on {tab.serverName}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-view">
      <div className="terminal-bar">
        {tab.containerId ? <Box size={13} aria-hidden /> : <SquareTerminal size={13} aria-hidden />}
        <span className="terminal-title">{title}</span>
        <span className="mono muted small">{connection?.name}</span>
        <span className="spacer" />
        {recorded && (
          <span className="badge tone-warn" title="An administrator has turned on session recording for this panel.">
            <ShieldAlert size={12} /> This session is recorded
          </span>
        )}
        <StatusPill status={status} />
        {(status.kind === "closed" || status.kind === "failed") && (
          <button className="btn btn-ghost btn-sm" onClick={() => void connect()}>
            <RotateCw size={12} /> Reconnect
          </button>
        )}
      </div>
      {status.kind === "failed" && (
        <div className="terminal-error">
          <ErrorNotice error={status.error} baseUrl={connection?.base_url} />
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const map = {
    connecting: { tone: "info", label: "connecting…" },
    open: { tone: "ok", label: "connected" },
    closed: { tone: "neutral", label: "closed" },
    failed: { tone: "danger", label: "failed" },
  } as const;
  const m = map[status.kind];
  return (
    <span
      className={`badge tone-${m.tone}${status.kind === "connecting" ? " pulsing" : ""}`}
      title={status.kind === "closed" ? `${status.reason}${status.code ? ` (${status.code})` : ""}` : undefined}
    >
      <Circle size={7} fill="currentColor" aria-hidden />
      {m.label}
      {status.kind === "closed" && <span className="muted">· {status.reason}</span>}
    </span>
  );
}
