"use client";

import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { cn } from "@kaname/ui";
import "@xterm/xterm/css/xterm.css";

/* ------------------------------------------------------------------ *
 * The xterm.js wiring.
 *
 * Loaded with `ssr: false` from the terminal page — xterm measures a
 * real character cell against a real font, so there is nothing useful
 * it can do on a server.
 *
 * Two details are load-bearing. The palette is read from the CSS
 * tokens at mount and re-read when the theme attribute changes, so the
 * terminal is the same near-black as the panel around it rather than
 * xterm's default blue-black. And keystrokes go out as *binary* frames
 * while resizes go out as *text* frames: the control plane treats a
 * text frame that parses as a resize control as a control message, so
 * sending input as bytes removes any chance that a line an operator
 * typed is swallowed as configuration.
 * ------------------------------------------------------------------ */

export type TerminalStatus = "connecting" | "open" | "closed" | "error";

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export interface TerminalController {
  focus(): void;
  clear(): void;
  fit(): void;
  /** Returns false when the term is not found in the buffer. */
  search(query: string, direction: "next" | "previous"): boolean;
  clearSearch(): void;
  /** Both return false when the browser refuses clipboard access. */
  copySelection(): Promise<boolean>;
  paste(): Promise<boolean>;
  hasSelection(): boolean;
}

export interface TerminalPaneProps {
  /**
   * Mints a fresh session and returns its socket URL. The pane calls
   * this once per socket rather than being handed a URL, because a
   * ticket is consumed the moment it is redeemed (KD-013): React
   * remounts effects in development, and a pre-minted URL would try to
   * spend the same ticket twice and be refused with "ticket already
   * used". Minting per socket also makes reconnect free.
   */
  connect: (signal: AbortSignal) => Promise<{ ws_url: string }>;
  onReady?: (controller: TerminalController) => void;
  onStatusChange?: (status: TerminalStatus, detail?: string) => void;
  onGeometry?: (geometry: TerminalGeometry) => void;
  /** Ctrl/Cmd+Shift+F, so the page can focus its own search field. */
  onRequestSearch?: () => void;
  className?: string;
}

const FONT_SIZE = 12;
const LINE_HEIGHT = 1.5;
const SCROLLBACK = 10_000;

function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * The ANSI palette is mapped onto the semantic tokens rather than onto
 * a stock 16-colour ramp: red is the same red as a failed job, green
 * the same green as a healthy host.
 */
function buildTheme(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);

  const background = token(styles, "--kn-bg-inset", "#08090a");
  const foreground = token(styles, "--kn-text", "#e7e9ec");
  const muted = token(styles, "--kn-text-2", "#9ba3ae");
  const dim = token(styles, "--kn-text-3", "#6b7280");
  const accent = token(styles, "--kn-accent-400", "#8aa0ff");
  const accentSoft = token(styles, "--kn-accent-300", "#a9b8ff");
  const ok = token(styles, "--kn-ok", "#3fb950");
  const warn = token(styles, "--kn-warn", "#d29922");
  const danger = token(styles, "--kn-danger", "#f85149");
  const info = token(styles, "--kn-info", "#58a6ff");

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: token(styles, "--kn-accent-soft-strong", "rgba(91,118,247,0.22)"),
    selectionForeground: foreground,
    black: token(styles, "--kn-surface-3", "#1c2024"),
    red: danger,
    green: ok,
    yellow: warn,
    blue: info,
    magenta: accent,
    cyan: accentSoft,
    white: muted,
    brightBlack: dim,
    brightRed: danger,
    brightGreen: ok,
    brightYellow: warn,
    brightBlue: info,
    brightMagenta: accentSoft,
    brightCyan: accentSoft,
    brightWhite: foreground,
  };
}

export function TerminalPane({
  connect,
  onReady,
  onStatusChange,
  onGeometry,
  onRequestSearch,
  className,
}: TerminalPaneProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);

  /* Callbacks live in refs so a parent re-render never tears down a
   * live shell just because it passed a new closure. */
  const callbacks = React.useRef({ onReady, onStatusChange, onGeometry, onRequestSearch });
  callbacks.current = { onReady, onStatusChange, onGeometry, onRequestSearch };

  const connectRef = React.useRef(connect);
  connectRef.current = connect;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const styles = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: token(styles, "--kn-font-mono", "ui-monospace, monospace"),
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: SCROLLBACK,
      macOptionIsMeta: true,
      theme: buildTheme(),
      // The socket carries a real PTY, so the shell owns wrapping and
      // echo; xterm converting line endings would corrupt both.
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    /*
     * xterm measures a real character cell, so opening it against a box
     * that has not been laid out leaves the renderer without dimensions
     * and every subsequent write throws. The pane starts inside a flex
     * column that is frequently zero-height on the first frame, so the
     * open is deferred until the element actually has a size and any
     * output that arrives first is buffered.
     */
    let opened = false;
    let flushed = false;
    let fontsReady = document.fonts === undefined || document.fonts.status === "loaded";
    const pending: (string | Uint8Array)[] = [];

    const openTerminal = (): boolean => {
      if (opened) return true;
      // xterm sizes everything off a measured character cell. Opening
      // before the monospace face has loaded measures the fallback — or
      // nothing at all — and leaves the renderer without dimensions, so
      // every write throws and the pane stays blank.
      if (!fontsReady) return false;
      const box = host.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
      term.open(host);
      opened = true;
      safeFit();
      callbacks.current.onGeometry?.({ cols: term.cols, rows: term.rows });
      flushSoon();
      return true;
    };

    /*
     * Flushing is deliberately not a step inside openTerminal: whichever
     * of "the pane got a size" and "the socket connected" happens second
     * has to be the one that releases the buffer. Tying it to the open
     * meant that when the pane was sized first, the flush was never
     * scheduled and every byte queued forever behind a blank screen.
     */
    const flushSoon = (): void => {
      if (flushed || !opened) return;
      flushed = true;
      for (const chunk of pending) term.write(chunk);
      pending.length = 0;
      // The DOM renderer repaints only rows it was told changed, and
      // misses the first batch written into a freshly-opened terminal.
      // This is deliberately not deferred to requestAnimationFrame: a
      // pane opened in a background tab would never get a frame, and the
      // shell would sit blank until the operator typed something.
      safeFit();
      term.refresh(0, term.rows - 1);
    };

    const writeOut = (chunk: string | Uint8Array): void => {
      if (flushed) {
        term.write(chunk);
        return;
      }
      pending.push(chunk);
      flushSoon();
    };

    const encoder = new TextEncoder();
    const abort = new AbortController();
    let socket: WebSocket | null = null;
    let disposed = false;
    callbacks.current.onStatusChange?.("connecting");

    const safeFit = (): void => {
      if (!opened) return;
      try {
        fitAddon.fit();
      } catch {
        /* The pane can be measured at zero while a drawer animates. */
      }
    };

    const sendResize = (cols: number, rows: number): void => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ t: "resize", cols, rows }));
    };

    const wire = (ws: WebSocket): void => {
      ws.onopen = () => {
        callbacks.current.onStatusChange?.("open");
        openTerminal();
        sendResize(term.cols, term.rows);
        if (opened) term.focus();
      };

      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (typeof event.data === "string") writeOut(event.data);
        else writeOut(new Uint8Array(event.data));
      };

      ws.onerror = () => callbacks.current.onStatusChange?.("error", "the connection failed");

      ws.onclose = (event) => {
        callbacks.current.onStatusChange?.(
          event.wasClean ? "closed" : "error",
          event.reason || (event.wasClean ? "session ended" : "the connection dropped"),
        );
      };
    };

    const dataSub = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });

    // Mouse reports and similar arrive as raw bytes in a JS string.
    const binarySub = term.onBinary((data) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
      socket.send(bytes);
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      callbacks.current.onGeometry?.({ cols, rows });
      sendResize(cols, rows);
    });

    const copySelection = async (): Promise<boolean> => {
      const selection = term.getSelection();
      if (selection.length === 0) return false;
      try {
        await navigator.clipboard.writeText(selection);
        return true;
      } catch {
        return false;
      }
    };

    const paste = async (): Promise<boolean> => {
      try {
        const text = await navigator.clipboard.readText();
        if (text.length > 0) term.paste(text);
        return true;
      } catch {
        return false;
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // Plain Ctrl+C has to stay SIGINT, so copy is Ctrl+Shift+C — or
      // the platform-native Cmd combination on macOS.
      const chord = (event.ctrlKey && event.shiftKey) || event.metaKey;
      if (!chord) return true;

      const key = event.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        void copySelection();
        return false;
      }
      if (key === "v") {
        void paste();
        return false;
      }
      if (key === "f") {
        callbacks.current.onRequestSearch?.();
        return false;
      }
      return true;
    });

    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!openTerminal()) return;
        safeFit();
      });
    });
    observer.observe(host);

    // The panel's theme can change under a live session.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = buildTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    if (!fontsReady) {
      void document.fonts.ready.then(() => {
        fontsReady = true;
        if (openTerminal()) safeFit();
      });
    }

    openTerminal();
    callbacks.current.onReady?.({
      focus: () => term.focus(),
      clear: () => term.clear(),
      fit: safeFit,
      search: (query, direction) =>
        direction === "next" ? searchAddon.findNext(query) : searchAddon.findPrevious(query),
      clearSearch: () => term.clearSelection(),
      copySelection,
      paste,
      hasSelection: () => term.hasSelection(),
    });

    void (async () => {
      let session: { ws_url: string };
      try {
        session = await connectRef.current(abort.signal);
      } catch (err) {
        if (disposed || abort.signal.aborted) return;
        callbacks.current.onStatusChange?.(
          "error",
          err instanceof Error ? err.message : "could not start a session",
        );
        return;
      }
      // The pane can be torn down while the ticket is in flight; opening
      // the socket then would spend it on a session nobody is watching.
      if (disposed) return;
      socket = new WebSocket(session.ws_url);
      socket.binaryType = "arraybuffer";
      wire(socket);
    })();

    return () => {
      disposed = true;
      abort.abort();
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      dataSub.dispose();
      binarySub.dispose();
      resizeSub.dispose();
      if (socket) {
        socket.onclose = null;
        socket.close(1000, "pane closed");
      }
      term.dispose();
    };
    // Deliberately mount-scoped: the parent remounts with a new `key` to
    // start a new session, so a changing callback must not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      className={cn(
        "min-h-0 w-full flex-1 overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)]",
        "bg-[var(--kn-bg-inset)] p-2",
        // xterm positions its viewport and screen absolutely, so the
        // element it mounts into collapses to zero height unless it is
        // told to fill its container — the rows render, correctly sized,
        // into a box nobody can see.
        "[&>.xterm]:h-full",
        className,
      )}
    />
  );
}
