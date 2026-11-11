import { useMemo, useState } from "react";
import { Moon, Pencil, Plus, Search, Sun } from "lucide-react";
import type { Connection } from "../lib/ipc";
import { displayHost } from "../lib/url";
import { Logo } from "./Logo";

export type AuthState = "unknown" | "checking" | "ok" | "signed_out" | "error";

interface SidebarProps {
  connections: Connection[];
  selectedId: string | null;
  auth: Record<string, AuthState>;
  theme: "dark" | "light";
  onSelect(id: string): void;
  onAdd(): void;
  onEdit(connection: Connection): void;
  onToggleTheme(): void;
}

export function Sidebar(props: SidebarProps) {
  const { connections, selectedId, auth, onSelect, onAdd, onEdit } = props;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) => c.name.toLowerCase().includes(q) || c.base_url.toLowerCase().includes(q),
    );
  }, [connections, query]);

  return (
    <aside className="sidebar" aria-label="Connections">
      <div className="sidebar-brand" data-tauri-drag-region>
        <Logo />
        <span className="brand-name">Kaname</span>
        <span className="brand-sub mono">desktop</span>
      </div>

      <div className="sidebar-head">
        <span className="label">Connections</span>
        <button className="icon-btn" onClick={onAdd} title="Add connection" aria-label="Add connection">
          <Plus size={15} />
        </button>
      </div>

      {connections.length > 0 && (
        <div className="sidebar-search">
          <Search size={13} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter"
            aria-label="Filter connections"
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </div>
      )}

      <nav className="conn-list">
        {filtered.map((c) => {
          const state = auth[c.id] ?? (c.has_credential ? "unknown" : "signed_out");
          const signedIn = state === "ok" || (state === "unknown" && c.has_credential);
          return (
            <div
              key={c.id}
              className={`conn-item${c.id === selectedId ? " selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-current={c.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(c.id);
                }
              }}
            >
              <span className="conn-dot" style={{ background: c.color ?? "var(--kn-text-3)" }} aria-hidden />
              <span className="conn-text">
                <span className="conn-name">{c.name}</span>
                <span className="conn-host mono">{displayHost(c.base_url)}</span>
              </span>
              <span
                className={`conn-auth ${state === "checking" ? "checking" : signedIn ? "in" : "out"}`}
                title={
                  state === "checking"
                    ? "Checking session…"
                    : signedIn
                      ? c.auth_kind === "api_key"
                        ? "API key stored"
                        : `Signed in${c.email ? ` as ${c.email}` : ""}`
                      : "Signed out"
                }
              >
                {state === "checking" ? "…" : signedIn ? (c.auth_kind === "api_key" ? "key" : "in") : "out"}
              </span>
              <button
                className="icon-btn conn-edit"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(c);
                }}
                aria-label={`Edit ${c.name}`}
                title="Edit"
              >
                <Pencil size={13} />
              </button>
            </div>
          );
        })}
        {connections.length > 0 && filtered.length === 0 && (
          <div className="sidebar-empty">No connection matches “{query}”.</div>
        )}
      </nav>

      <div className="sidebar-foot">
        <button className="icon-btn" onClick={props.onToggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {props.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <span className="mono foot-version">v0.2.0</span>
        <span className="kbd-hint mono">⌘T ⌘W ⌘1–9</span>
      </div>
    </aside>
  );
}
