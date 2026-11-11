import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppContext, type AppContextValue, type TerminalTarget } from "./context";
import { authSession, connectionsList, needsSignIn, toDesktopError, type Connection, type DesktopError } from "./lib/ipc";
import type { Job } from "./lib/jobs";
import { fleetTabId, nextActiveAfterClose, type Tab } from "./tabs";
import { Sidebar, type AuthState } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { ConnectionSheet } from "./components/ConnectionSheet";
import { SignInSheet } from "./components/SignInSheet";
import { ServerPicker } from "./components/ServerPicker";
import { JobsTray, useJobs } from "./components/JobsTray";
import { ErrorNotice } from "./components/ErrorNotice";
import { NothingOpen, Welcome } from "./views/Welcome";
import { FleetView } from "./views/FleetView";
import { TerminalView } from "./views/TerminalView";

type Theme = "dark" | "light";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function loadTheme(): Theme {
  try {
    return localStorage.getItem("kaname.desktop.theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let tabSeq = 0;

export function App() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<DesktopError | null>(null);
  const [auth, setAuth] = useState<Record<string, AuthState>>({});
  const [authErrors, setAuthErrors] = useState<Record<string, DesktopError>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connSheet, setConnSheet] = useState<{ existing?: Connection } | null>(null);
  const [signIn, setSignIn] = useState<{ connectionId: string; reason: string | null } | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);

  const authRef = useRef(auth);
  authRef.current = auth;
  const connectionsRef = useRef<Connection[]>([]);
  connectionsRef.current = connections ?? [];
  const connection = useCallback((id: string) => connectionsRef.current.find((c) => c.id === id), []);

  /* ------------------------------ theme ----------------------------- */

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("kaname.desktop.theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  /* --------------------------- connections -------------------------- */

  const reloadConnections = useCallback(async () => {
    try {
      const list = await connectionsList();
      setConnections(list);
      setLoadError(null);
      return list;
    } catch (err) {
      setLoadError(toDesktopError(err));
      setConnections((c) => c ?? []);
      return null;
    }
  }, []);

  /* ------------------------------ errors ---------------------------- */

  const handleError = useCallback((connectionId: string | null, error: unknown): DesktopError => {
    const e = toDesktopError(error);
    if (connectionId && needsSignIn(e)) {
      setAuth((a) => ({ ...a, [connectionId]: "signed_out" }));
      const c = connectionsRef.current.find((x) => x.id === connectionId);
      if (c?.auth_kind === "session") {
        setSignIn((s) =>
          s ?? {
            connectionId,
            reason: e.code === "unauthenticated" ? "Your session has ended. Sign in again to continue." : null,
          },
        );
      }
    }
    return e;
  }, []);

  const checkAuth = useCallback(
    async (id: string) => {
      setAuth((a) => ({ ...a, [id]: "checking" }));
      try {
        await authSession(id);
        setAuth((a) => ({ ...a, [id]: "ok" }));
        setAuthErrors(({ [id]: _drop, ...rest }) => rest);
      } catch (err) {
        const e = toDesktopError(err);
        if (needsSignIn(e)) {
          handleError(id, e);
        } else {
          setAuth((a) => ({ ...a, [id]: "error" }));
          setAuthErrors((x) => ({ ...x, [id]: e }));
        }
      }
    },
    [handleError],
  );

  /* ------------------------------- tabs ----------------------------- */

  const selectConnection = useCallback(
    (id: string) => {
      const tabId = fleetTabId(id);
      setTabs((t) => (t.some((x) => x.id === tabId) ? t : [...t, { id: tabId, kind: "fleet", connectionId: id }]));
      setActiveId(tabId);
      const state = authRef.current[id];
      if (state === undefined || state === "error") void checkAuth(id);
    },
    [checkAuth],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((current) => {
      setActiveId((active) => nextActiveAfterClose(current, id, active));
      return current.filter((t) => t.id !== id);
    });
  }, []);

  const openTerminal = useCallback((connectionId: string, target: TerminalTarget) => {
    tabSeq += 1;
    const tab: Tab = { id: `term:${tabSeq}`, kind: "terminal", connectionId, ...target };
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
  }, []);

  useEffect(() => {
    void reloadConnections().then((list) => {
      if (list && list[0]) selectConnection(list[0].id);
    });
  }, [reloadConnections, selectConnection]);

  /* ------------------------------- jobs ----------------------------- */

  const jobs = useJobs(handleError);
  const trackJob = useCallback((connectionId: string, job: Job) => jobs.track(connectionId, job), [jobs.track]);

  /* ---------------------------- shortcuts --------------------------- */

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const currentConnectionId = activeTab?.connectionId ?? null;
  const stateRef = useRef({ tabs, activeId, currentConnectionId, blocked: false });
  stateRef.current = {
    tabs,
    activeId,
    currentConnectionId,
    blocked: connSheet !== null || signIn !== null || picker !== null,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (s.blocked) return;
      const inTerminal = (e.target as HTMLElement | null)?.closest?.(".xterm") != null;
      // In a terminal on Linux/Windows, Ctrl+T/W belong to the shell; use Ctrl+Shift there.
      const mod = isMac ? e.metaKey : e.ctrlKey && (!inTerminal || e.shiftKey);
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        if (!s.currentConnectionId) return;
        e.preventDefault();
        e.stopPropagation();
        setPicker(s.currentConnectionId);
      } else if (key === "w") {
        if (!s.activeId) return;
        e.preventDefault();
        e.stopPropagation();
        closeTab(s.activeId);
      } else if (/^[1-9]$/.test(e.key) || /^Digit[1-9]$/.test(e.code)) {
        const n = Number(e.code.startsWith("Digit") ? e.code.slice(5) : e.key);
        const target = n === 9 ? s.tabs[s.tabs.length - 1] : s.tabs[n - 1];
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        setActiveId(target.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeTab]);

  /* ----------------------------- context ---------------------------- */

  const ctx = useMemo<AppContextValue>(
    () => ({
      connections: connections ?? [],
      connection,
      handleError,
      openTerminal,
      trackJob,
      jobsVersion: jobs.settledVersion,
      requestSignIn: (connectionId) => setSignIn({ connectionId, reason: null }),
    }),
    [connections, connection, handleError, openTerminal, trackJob, jobs.settledVersion],
  );

  /* ------------------------------ render ---------------------------- */

  if (connections === null) {
    return <div className="boot" aria-busy="true" />;
  }

  const signInConnection = signIn ? connection(signIn.connectionId) : undefined;
  const selectedConnectionId = activeTab?.connectionId ?? null;

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <Sidebar
          connections={connections}
          selectedId={selectedConnectionId}
          auth={auth}
          theme={theme}
          onSelect={selectConnection}
          onAdd={() => setConnSheet({})}
          onEdit={(c) => setConnSheet({ existing: c })}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />
        <main className="main">
          {loadError && <ErrorNotice error={loadError} onRetry={() => void reloadConnections()} />}
          {connections.length === 0 ? (
            <Welcome onAdd={() => setConnSheet({})} />
          ) : (
            <>
              <TabBar
                tabs={tabs}
                activeId={activeId}
                connection={connection}
                onActivate={setActiveId}
                onClose={closeTab}
                onNewTerminal={() => currentConnectionId && setPicker(currentConnectionId)}
                canOpenTerminal={currentConnectionId !== null}
              />
              <div className="tab-panels">
                {tabs.length === 0 && <NothingOpen onAdd={() => setConnSheet({})} />}
                {tabs.map((tab) => (
                  <div key={tab.id} className="tab-panel" hidden={tab.id !== activeId} role="tabpanel">
                    {tab.kind === "fleet" ? (
                      auth[tab.connectionId] === "error" && authErrors[tab.connectionId] ? (
                        <div className="page-body">
                          <ErrorNotice
                            error={authErrors[tab.connectionId]!}
                            baseUrl={connection(tab.connectionId)?.base_url}
                            onRetry={() => void checkAuth(tab.connectionId)}
                          />
                        </div>
                      ) : (
                        <FleetView
                          connectionId={tab.connectionId}
                          active={tab.id === activeId}
                          auth={auth[tab.connectionId] ?? "checking"}
                          onSignedOut={() => {
                            setAuth((a) => ({ ...a, [tab.connectionId]: "signed_out" }));
                            void reloadConnections();
                          }}
                        />
                      )
                    ) : (
                      <TerminalView tab={tab} active={tab.id === activeId} theme={theme} />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </main>

        <JobsTray
          jobs={jobs.jobs}
          connectionName={(id) => connection(id)?.name}
          onDismiss={(jobId) => jobs.dispatch({ type: "dismiss", jobId })}
          onClearFinished={() => jobs.dispatch({ type: "clear_finished" })}
        />
      </div>

      {connSheet && (
        <ConnectionSheet
          existing={connSheet.existing}
          onClose={() => setConnSheet(null)}
          onSaved={(saved, isNew) => {
            setConnSheet(null);
            // A new base_url drops stored credentials and closes its terminals (Rust side);
            // mirror that here by closing the terminal tabs and re-checking the session.
            if (connSheet.existing && connSheet.existing.base_url !== saved.base_url) {
              setTabs((current) => {
                const remaining = current.filter((t) => !(t.connectionId === saved.id && t.kind === "terminal"));
                setActiveId((active) => (remaining.some((t) => t.id === active) ? active : fleetTabId(saved.id)));
                return remaining;
              });
            }
            void reloadConnections().then(() => {
              if (isNew || saved.auth_kind !== connSheet.existing?.auth_kind) {
                setAuth(({ [saved.id]: _drop, ...rest }) => rest);
              }
              if (isNew && saved.auth_kind === "session" && !saved.has_credential) {
                const tabId = fleetTabId(saved.id);
                setTabs((t) => (t.some((x) => x.id === tabId) ? t : [...t, { id: tabId, kind: "fleet", connectionId: saved.id }]));
                setActiveId(tabId);
                setAuth((a) => ({ ...a, [saved.id]: "signed_out" }));
                setSignIn({ connectionId: saved.id, reason: null });
              } else {
                setAuth(({ [saved.id]: _drop, ...rest }) => rest);
                selectConnection(saved.id);
                void checkAuth(saved.id);
              }
            });
          }}
          onDeleted={(id) => {
            setConnSheet(null);
            setTabs((current) => {
              const remaining = current.filter((t) => t.connectionId !== id);
              setActiveId((active) =>
                remaining.some((t) => t.id === active) ? active : (remaining[0]?.id ?? null),
              );
              return remaining;
            });
            void reloadConnections();
          }}
        />
      )}

      {signIn && signInConnection && (
        <SignInSheet
          key={signIn.connectionId}
          connection={signInConnection}
          reason={signIn.reason}
          onClose={() => setSignIn(null)}
          onSignedIn={() => {
            const id = signIn.connectionId;
            setSignIn(null);
            setAuth((a) => ({ ...a, [id]: "ok" }));
            void reloadConnections();
          }}
        />
      )}

      {picker && <ServerPicker connectionId={picker} onClose={() => setPicker(null)} />}
    </AppContext.Provider>
  );
}
