import { useMemo, useState } from "react";
import { Info, LayoutGrid, List, LogIn, LogOut, RotateCw, Search, SquareTerminal } from "lucide-react";
import { useApp } from "../context";
import { listServers, serverAddress, serverOs, type Server } from "../lib/api";
import { formatBytes, formatPercent } from "../lib/format";
import { authLogout } from "../lib/ipc";
import { displayHost } from "../lib/url";
import { useResource } from "../lib/useResource";
import { ErrorNotice } from "../components/ErrorNotice";
import { HealthBadge, ReachBadge } from "../components/StatusBadges";
import type { AuthState } from "../components/Sidebar";
import { ServerDetail } from "./ServerDetail";

interface FleetViewProps {
  connectionId: string;
  active: boolean;
  auth: AuthState;
  onSignedOut(): void;
}

export function FleetView({ connectionId, active, auth, onSignedOut }: FleetViewProps) {
  const app = useApp();
  const connection = app.connection(connectionId);
  const [serverId, setServerId] = useState<string | null>(null);
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [query, setQuery] = useState("");
  const ready = auth === "ok";

  const servers = useResource(connectionId, () => listServers(connectionId), [], {
    enabled: ready,
    refreshMs: active && !serverId ? 15_000 : undefined,
  });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = servers.data ?? [];
    if (!q) return all;
    return all.filter((s) =>
      `${s.name} ${s.hostname ?? ""} ${s.address ?? ""} ${s.os ?? ""}`.toLowerCase().includes(q),
    );
  }, [servers.data, query]);

  if (!connection) return null;

  if (!ready) {
    return (
      <div className="empty-main canvas">
        <div className="empty-card">
          <div className="label">{auth === "checking" ? "Checking session" : "Signed out"}</div>
          <p>
            {auth === "checking"
              ? `Connecting to ${displayHost(connection.base_url)}…`
              : connection.auth_kind === "api_key"
                ? "No API key is stored for this panel. Edit the connection to add one."
                : `Sign in to ${connection.name} to see its fleet.`}
          </p>
          {auth !== "checking" && connection.auth_kind === "session" && (
            <button className="btn btn-primary" onClick={() => app.requestSignIn(connectionId)}>
              <LogIn size={14} /> Sign in
            </button>
          )}
        </div>
      </div>
    );
  }

  const selected = serverId ? servers.data?.find((s) => s.id === serverId) : undefined;
  if (serverId) {
    return (
      <ServerDetail
        connectionId={connectionId}
        serverId={serverId}
        initial={selected}
        onBack={() => {
          setServerId(null);
          servers.reload();
        }}
      />
    );
  }

  const total = servers.data?.length ?? 0;
  const connected = servers.data?.filter((s) => s.connection === "connected").length ?? 0;
  const unhealthy =
    servers.data?.filter((s) => s.health === "warning" || s.health === "critical").length ?? 0;

  const openTerminal = (s: Server) =>
    app.openTerminal(connectionId, { serverId: s.id, serverName: s.name });

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-heading">
          <div className="eyebrow">
            <span className="eyebrow-square" style={{ background: connection.color ?? undefined }} />
            {connection.name}
          </div>
          <h1 className="page-title">Fleet</h1>
          <div className="page-sub mono">
            {servers.data
              ? `${total} servers · ${connected} connected · ${unhealthy} need attention`
              : displayHost(connection.base_url)}
          </div>
        </div>
        <div className="page-actions">
          <div className="search-box">
            <Search size={13} aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter servers"
              aria-label="Filter servers"
            />
          </div>
          <div className="segmented small" role="radiogroup" aria-label="Layout">
            <button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")} aria-label="List">
              <List size={14} />
            </button>
            <button className={layout === "grid" ? "on" : ""} onClick={() => setLayout("grid")} aria-label="Grid">
              <LayoutGrid size={14} />
            </button>
          </div>
          <button className="icon-btn" onClick={servers.reload} aria-label="Refresh" title="Refresh">
            <RotateCw size={14} className={servers.loading ? "spin" : ""} />
          </button>
          {connection.auth_kind === "session" && (
            <button
              className="icon-btn"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => {
                void authLogout(connectionId).finally(onSignedOut);
              }}
            >
              <LogOut size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="page-body">
        {servers.error && (
          <ErrorNotice error={servers.error} baseUrl={connection.base_url} onRetry={servers.reload} />
        )}
        {servers.loading && !servers.data && <div className="skeleton-rows" aria-label="Loading" />}
        {servers.data && total === 0 && (
          <div className="empty-inline">
            No servers on this panel yet. Pair one from the panel’s Servers page.
          </div>
        )}

        {servers.data && total > 0 && layout === "list" && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Address</th>
                  <th>OS</th>
                  <th>Agent</th>
                  <th>Health</th>
                  <th className="num">CPU</th>
                  <th className="num">Memory</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} onDoubleClick={() => setServerId(s.id)}>
                    <td>
                      <button className="row-link" onClick={() => setServerId(s.id)}>
                        {s.name}
                      </button>
                      {s.hostname && <div className="mono muted small">{s.hostname}</div>}
                    </td>
                    <td className="mono">{serverAddress(s)}</td>
                    <td>{serverOs(s)}</td>
                    <td>
                      <ReachBadge value={s.connection} />
                    </td>
                    <td>
                      <HealthBadge value={s.health} reasons={s.health_reasons} />
                    </td>
                    <td className="num mono">{formatPercent(s.latest?.cpu_percent)}</td>
                    <td className="num mono">
                      {s.latest?.memory_used !== undefined
                        ? `${formatBytes(s.latest.memory_used)} / ${formatBytes(s.latest.memory_total ?? s.memory_total)}`
                        : "—"}
                    </td>
                    <td className="row-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => openTerminal(s)}
                        disabled={s.connection === "disconnected" || s.connection === "never_enrolled"}
                        title="Open terminal"
                      >
                        <SquareTerminal size={13} /> Terminal
                      </button>
                      <button className="icon-btn" onClick={() => setServerId(s.id)} aria-label={`Details for ${s.name}`} title="Details">
                        <Info size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {servers.data && total > 0 && layout === "grid" && (
          <div className="server-grid">
            {rows.map((s) => (
              <article key={s.id} className="server-card">
                <header>
                  <button className="row-link card-title" onClick={() => setServerId(s.id)}>
                    {s.name}
                  </button>
                  <span className="mono muted small">{serverAddress(s)}</span>
                </header>
                <div className="card-badges">
                  <ReachBadge value={s.connection} />
                  <HealthBadge value={s.health} reasons={s.health_reasons} />
                </div>
                <dl className="kv small">
                  <dt>OS</dt>
                  <dd>{serverOs(s)}</dd>
                  <dt>CPU</dt>
                  <dd className="mono">{formatPercent(s.latest?.cpu_percent)}</dd>
                  <dt>Memory</dt>
                  <dd className="mono">{formatBytes(s.latest?.memory_used)}</dd>
                </dl>
                <footer>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => openTerminal(s)}
                    disabled={s.connection === "disconnected" || s.connection === "never_enrolled"}
                  >
                    <SquareTerminal size={13} /> Terminal
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setServerId(s.id)}>
                    Details
                  </button>
                </footer>
              </article>
            ))}
          </div>
        )}
        {servers.data && total > 0 && rows.length === 0 && (
          <div className="empty-inline">No server matches “{query}”.</div>
        )}
      </div>
    </div>
  );
}
