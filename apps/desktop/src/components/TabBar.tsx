import { Box, LayoutGrid, Plus, SquareTerminal, X } from "lucide-react";
import type { Connection } from "../lib/ipc";
import type { Tab } from "../tabs";

interface TabBarProps {
  tabs: Tab[];
  activeId: string | null;
  connection(id: string): Connection | undefined;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNewTerminal(): void;
  canOpenTerminal: boolean;
}

export function TabBar({ tabs, activeId, connection, onActivate, onClose, onNewTerminal, canOpenTerminal }: TabBarProps) {
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabs" data-tauri-drag-region>
      {tabs.map((tab, i) => {
        const c = connection(tab.connectionId);
        const title =
          tab.kind === "fleet"
            ? (c?.name ?? "Fleet")
            : tab.containerName
              ? `${tab.containerName} · ${tab.serverName}`
              : tab.serverName;
        const Icon = tab.kind === "fleet" ? LayoutGrid : tab.containerId ? Box : SquareTerminal;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === activeId}
            className={`tab${tab.id === activeId ? " active" : ""}`}
            onClick={() => onActivate(tab.id)}
            onAuxClick={(e) => e.button === 1 && onClose(tab.id)}
            onKeyDown={(e) => e.key === "Enter" && onActivate(tab.id)}
            title={`${title}${i < 9 ? `  (⌘${i + 1})` : ""}`}
          >
            <span className="tab-accent" style={{ background: c?.color ?? "var(--kn-text-3)" }} aria-hidden />
            <Icon size={13} className="tab-icon" aria-hidden />
            <span className="tab-title">{title}</span>
            {tab.kind === "terminal" && tab.containerId && <span className="tab-tag mono">ctr</span>}
            <button
              className="tab-close"
              aria-label={`Close ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button
        className="icon-btn tab-new"
        onClick={onNewTerminal}
        disabled={!canOpenTerminal}
        aria-label="New terminal"
        title="New terminal (⌘T)"
      >
        <Plus size={15} />
      </button>
      <div className="tabbar-fill" data-tauri-drag-region />
    </div>
  );
}
