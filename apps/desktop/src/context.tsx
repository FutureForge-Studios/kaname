import { createContext, useContext } from "react";
import type { Connection, DesktopError } from "./lib/ipc";
import type { Job } from "./lib/jobs";

export interface TerminalTarget {
  serverId: string;
  serverName: string;
  containerId?: string;
  containerName?: string;
}

export interface AppContextValue {
  connections: Connection[];
  connection(id: string): Connection | undefined;
  /** Normalises an error, opens the sign-in sheet for auth errors, returns it for display. */
  handleError(connectionId: string | null, error: unknown): DesktopError;
  openTerminal(connectionId: string, target: TerminalTarget): void;
  trackJob(connectionId: string, job: Job): void;
  /** Bumps whenever a tracked job reaches a terminal state, so lists can refetch. */
  jobsVersion: number;
  requestSignIn(connectionId: string): void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp outside <AppContext.Provider>");
  return value;
}
