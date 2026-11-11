/* ------------------------------------------------------------------ *
 * The only module that talks to the Rust backend.
 *
 * Mirrors apps/desktop/INTERFACE.md one-to-one: every command name and
 * argument key below is the contract's. Outside Tauri (plain `pnpm dev`
 * in a browser) the same functions are served by the in-memory mock in
 * ./mock.ts, so the UI can be developed without a Rust build.
 * ------------------------------------------------------------------ */

import { Channel, invoke } from "@tauri-apps/api/core";

/* ----------------------------- types ------------------------------ */

export type AuthKind = "session" | "api_key";

export interface Connection {
  id: string;
  name: string;
  base_url: string;
  auth_kind: AuthKind;
  email: string | null;
  color: string | null;
  accept_invalid_certs: boolean;
  created_at: string;
  last_connected_at: string | null;
  has_credential: boolean;
}

export interface ConnectionInput {
  id?: string;
  name: string;
  base_url: string;
  auth_kind: AuthKind;
  email?: string | null;
  color?: string | null;
  accept_invalid_certs?: boolean;
  api_key?: string | null;
}

export interface RemediationAction {
  label: string;
  href?: string;
  action?: string;
}

export interface DesktopError {
  code: string;
  message: string;
  status: number | null;
  remediation: { summary: string; actions: RemediationAction[] } | null;
  /** Per-field messages from the panel's `validation_failed`, keyed by field name. */
  fields?: Record<string, string>;
}

export type LoginResult =
  | { status: "ok"; session: unknown }
  | { status: "totp_required"; challenge: string };

export interface ApiResponse<T = unknown> {
  status: number;
  data: T | null;
  meta: unknown | null;
}

export interface ConnectionTestResult {
  reachable: boolean;
  version: string | null;
  setup_required: boolean;
}

export interface TerminalOpened {
  terminal_id: string;
  server_id: string;
  server_name: string;
  container_name: string | null;
  recorded: boolean;
}

export type TerminalEvent =
  | { kind: "data"; b64: string }
  | { kind: "closed"; code: number | null; reason: string }
  | { kind: "error"; message: string };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean;

/* ----------------------------- errors ----------------------------- */

export function isDesktopError(value: unknown): value is DesktopError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Whatever a rejected invoke carried, as a DesktopError. */
export function toDesktopError(value: unknown): DesktopError {
  if (isDesktopError(value)) {
    const error: DesktopError = {
      code: value.code,
      message: value.message,
      status: value.status ?? null,
      remediation: value.remediation ?? null,
    };
    if (value.fields && typeof value.fields === "object") error.fields = { ...value.fields };
    return error;
  }
  const message =
    typeof value === "string" ? value : value instanceof Error ? value.message : "Unexpected error";
  return { code: "unknown", message, status: null, remediation: null };
}

/** Errors that mean "this connection needs you to sign in (again)". */
export function needsSignIn(error: DesktopError): boolean {
  return error.code === "unauthenticated" || error.code === "not_signed_in";
}

/* ---------------------------- transport --------------------------- */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

type MockModule = typeof import("./mock");
let mockModule: Promise<MockModule> | null = null;
function mock(): Promise<MockModule> {
  mockModule ??= import("./mock");
  return mockModule;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauri) return await invoke<T>(command, args);
    return (await (await mock()).mockInvoke(command, args ?? {})) as T;
  } catch (error) {
    throw toDesktopError(error);
  }
}

/**
 * Opens a link in the system browser: tauri-plugin-opener inside Tauri,
 * window.open in a plain browser (the mock).
 */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isTauri) {
    await invoke("plugin:opener|open_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** A field's validation message, matching `name` or any of its aliases. */
export function fieldError(error: DesktopError | null, ...names: string[]): string | undefined {
  if (!error?.fields) return undefined;
  for (const name of names) {
    const message = error.fields[name];
    if (message) return message;
  }
  return undefined;
}

/* --------------------------- connections -------------------------- */

export const connectionsList = () => call<Connection[]>("connections_list");

export const connectionSave = (input: ConnectionInput) =>
  call<Connection>("connection_save", { input });

export const connectionDelete = (id: string) => call<null>("connection_delete", { id });

export const connectionTest = (baseUrl: string, acceptInvalidCerts: boolean) =>
  call<ConnectionTestResult>("connection_test", { baseUrl, acceptInvalidCerts });

/* ------------------------------ auth ------------------------------ */

export const authLogin = (id: string, email: string, password: string, remember: boolean) =>
  call<LoginResult>("auth_login", { id, email, password, remember });

export const authTotp = (id: string, challenge: string, code: string) =>
  call<LoginResult>("auth_totp", { id, challenge, code });

export const authSession = (id: string) => call<unknown>("auth_session", { id });

export const authLogout = (id: string) => call<null>("auth_logout", { id });

/* ------------------------------- api ------------------------------ */

export interface ApiRequestArgs {
  id: string;
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export function apiRequest<T = unknown>(args: ApiRequestArgs): Promise<ApiResponse<T>> {
  const payload: Record<string, unknown> = { id: args.id, method: args.method, path: args.path };
  if (args.query !== undefined) payload.query = args.query;
  if (args.body !== undefined) payload.body = args.body;
  return call<ApiResponse<T>>("api_request", payload);
}

/* ---------------------------- terminal ---------------------------- */

export interface TerminalOpenArgs {
  id: string;
  serverId: string;
  cols: number;
  rows: number;
  user?: string;
  containerId?: string;
}

/**
 * Opens a terminal. `onEvent` receives every TerminalEvent for this
 * socket; in Tauri it is wired through a `Channel<TerminalEvent>`.
 */
export async function terminalOpen(
  args: TerminalOpenArgs,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalOpened> {
  const payload: Record<string, unknown> = {
    id: args.id,
    serverId: args.serverId,
    cols: args.cols,
    rows: args.rows,
  };
  if (args.user) payload.user = args.user;
  if (args.containerId) payload.containerId = args.containerId;

  if (isTauri) {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return call<TerminalOpened>("terminal_open", { ...payload, onEvent: channel });
  }
  // The mock takes a plain sink with the same shape as a Channel.
  return call<TerminalOpened>("terminal_open", { ...payload, onEvent: { onmessage: onEvent } });
}

export const terminalWrite = (terminalId: string, b64: string) =>
  call<null>("terminal_write", { terminalId, b64 });

export const terminalResize = (terminalId: string, cols: number, rows: number) =>
  call<null>("terminal_resize", { terminalId, cols, rows });

export const terminalClose = (terminalId: string) => call<null>("terminal_close", { terminalId });
