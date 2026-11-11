import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SquareTerminal } from "lucide-react";
import { useApp } from "../context";
import { isReachable, listServers, serverAddress, type Server } from "../lib/api";
import { useResource } from "../lib/useResource";
import { ErrorNotice } from "./ErrorNotice";
import { ReachBadge } from "./StatusBadges";

interface ServerPickerProps {
  connectionId: string;
  onClose(): void;
}

/** ⌘T: a quick switcher that opens a terminal on the chosen server. */
export function ServerPicker({ connectionId, onClose }: ServerPickerProps) {
  const app = useApp();
  const connection = app.connection(connectionId);
  const servers = useResource(connectionId, () => listServers(connectionId), []);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = servers.data ?? [];
    const filtered = q
      ? all.filter((s) => `${s.name} ${s.hostname ?? ""} ${s.address ?? ""}`.toLowerCase().includes(q))
      : all;
    return [...filtered].sort((a, b) => Number(isReachable(b)) - Number(isReachable(a)));
  }, [servers.data, query]);

  useEffect(() => setIndex(0), [query]);

  // Enter pressed before the list arrived: take the first match once it does.
  const pendingEnter = useRef(false);
  useEffect(() => {
    if (pendingEnter.current && servers.data) {
      pendingEnter.current = false;
      pick(rows[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.data, rows]);

  function pick(server: Server | undefined) {
    if (!server) return;
    app.openTerminal(connectionId, { serverId: server.id, serverName: server.name });
    onClose();
  }

  return (
    <div className="sheet-overlay top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="picker" role="dialog" aria-modal="true" aria-label="Open terminal">
        <div className="picker-search">
          <Search size={15} aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder={`Open a terminal on… (${connection?.name ?? "panel"})`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (!servers.data) pendingEnter.current = true;
                else pick(rows[index]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <span className="kbd mono">esc</span>
        </div>
        <div className="picker-list" role="listbox">
          {servers.error && <ErrorNotice error={servers.error} compact baseUrl={connection?.base_url} />}
          {servers.loading && !servers.data && <div className="picker-empty">Loading servers…</div>}
          {servers.data && rows.length === 0 && <div className="picker-empty">No server matches.</div>}
          {rows.map((s, i) => (
            <div
              key={s.id}
              role="option"
              aria-selected={i === index}
              className={`picker-row${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(s)}
            >
              <SquareTerminal size={14} aria-hidden />
              <span className="picker-name">{s.name}</span>
              <span className="mono muted">{serverAddress(s)}</span>
              <span className="spacer" />
              <ReachBadge value={s.connection} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
