import type { ErrorCode, ListMeta, Remediation, RemediationAction } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * The typed API client.
 *
 * Every request in the product goes through here. That is what lets the
 * UI keep its promise about errors: the control plane guarantees a
 * machine `code`, a human `message`, an optional `remediation` and
 * optional per-field messages, so `ApiError` carries all four and no
 * component ever has to render "something went wrong".
 *
 * Same-origin by construction (KD-011) — the session cookie rides along
 * and there is no token to manage on this side.
 * ------------------------------------------------------------------ */

export const API_BASE = "/api/v1";

/** Failures that happen before the control plane can answer at all. */
export type ClientErrorCode = "network_error" | "malformed_response" | "aborted";
export type AnyErrorCode = ErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  code: AnyErrorCode;
  message: string;
  status: number;
  detail?: unknown;
  remediation?: Remediation | null;
  fields?: Record<string, string>;
  requestId?: string | null;
}

export class ApiError extends Error {
  readonly code: AnyErrorCode;
  readonly status: number;
  readonly detail: unknown;
  readonly remediation: Remediation | null;
  /** Dotted field path -> message, ready to bind straight onto a form. */
  readonly fields: Record<string, string>;
  readonly requestId: string | null;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.detail = init.detail;
    this.remediation = init.remediation ?? null;
    this.fields = init.fields ?? {};
    this.requestId = init.requestId ?? null;
  }

  /** True while retrying is plausibly useful rather than just noisy. */
  get retryable(): boolean {
    return (
      this.code === "network_error" ||
      this.code === "agent_timeout" ||
      this.code === "agent_offline" ||
      this.code === "rate_limited" ||
      this.status >= 500
    );
  }

  get fieldEntries(): [string, string][] {
    return Object.entries(this.fields);
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Normalises anything thrown by a query or mutation into an ApiError. */
export function toApiError(value: unknown): ApiError {
  if (isApiError(value)) return value;
  return new ApiError({
    code: "internal_error",
    message: value instanceof Error ? value.message : String(value),
    status: 0,
  });
}

export interface ListResult<T> {
  data: T[];
  meta: ListMeta;
}

export type QueryValue =
  string | number | boolean | null | undefined | readonly (string | number)[];
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  params?: QueryParams;
  signal?: AbortSignal;
  /** Login and the session probe handle 401 themselves. */
  allowUnauthenticated?: boolean;
  headers?: Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * URL building
 * ------------------------------------------------------------------ */

export function buildPath(path: string, params?: QueryParams): string {
  const base = path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
  const query = encodeParams(params);
  return query ? `${base}?${query}` : base;
}

export function encodeParams(params: QueryParams | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(","));
      continue;
    }
    search.set(key, String(value));
  }
  return search.toString();
}

/* ------------------------------------------------------------------ *
 * Session expiry
 * ------------------------------------------------------------------ */

let redirecting = false;

/**
 * A 401 anywhere means the session is gone, so the whole app is stale.
 * The current location is carried through so the operator lands back on
 * the page they were reading rather than the dashboard.
 */
export function redirectToLogin(): void {
  if (typeof window === "undefined" || redirecting) return;
  const { pathname, search } = window.location;
  if (pathname === "/login") return;
  redirecting = true;
  const next = `${pathname}${search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    detail?: unknown;
    remediation?: Remediation;
    fields?: Record<string, string>;
    request_id?: string;
  };
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  const init: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  };
  if (options.signal) init.signal = options.signal;

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }

  let response: Response;
  try {
    response = await fetch(buildPath(path, options.params), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError({ code: "aborted", message: "Request cancelled.", status: 0 });
    }
    throw new ApiError({
      code: "network_error",
      message: "The control plane did not answer.",
      status: 0,
      remediation: {
        summary:
          "The panel could not reach its own API. Check that the control plane process is running and that nothing in front of it is refusing the connection.",
        actions: [{ label: "Retry", action: "request.retry" }],
      },
    });
  }

  if (response.status === 204 || response.status === 205) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new ApiError({
          code: "malformed_response",
          message: "The control plane returned something that is not JSON.",
          status: response.status,
          detail: text.slice(0, 500),
        });
      }
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    const error = envelope.error ?? {};
    const apiError = new ApiError({
      code: (error.code as AnyErrorCode) ?? fallbackCode(response.status),
      message: error.message ?? fallbackMessage(response.status),
      status: response.status,
      detail: error.detail,
      remediation: error.remediation ?? null,
      fields: error.fields ?? {},
      requestId: error.request_id ?? null,
    });

    if (response.status === 401 && !options.allowUnauthenticated) redirectToLogin();
    throw apiError;
  }

  return (payload as { data: T } | null)?.data as T;
}

function fallbackCode(status: number): AnyErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation_failed";
  if (status === 429) return "rate_limited";
  return "internal_error";
}

function fallbackMessage(status: number): string {
  if (status === 401) return "This session is no longer signed in.";
  if (status === 403) return "This account does not hold the permission for that.";
  if (status === 404) return "That resource does not exist.";
  return `The control plane answered ${status}.`;
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export const api = {
  /** Unwraps `{ data }` and returns the resource. */
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("GET", path, undefined, options);
  },

  /** Index routes answer `{ data, meta }`, so both halves come back. */
  async list<T>(path: string, options?: RequestOptions): Promise<ListResult<T>> {
    const headers: Record<string, string> = { Accept: "application/json", ...options?.headers };
    const init: RequestInit = {
      method: "GET",
      headers,
      credentials: "same-origin",
      cache: "no-store",
    };
    if (options?.signal) init.signal = options.signal;

    let response: Response;
    try {
      response = await fetch(buildPath(path, options?.params), init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new ApiError({ code: "aborted", message: "Request cancelled.", status: 0 });
      }
      throw new ApiError({
        code: "network_error",
        message: "The control plane did not answer.",
        status: 0,
        remediation: {
          summary:
            "The panel could not reach its own API. Check that the control plane process is running.",
          actions: [{ label: "Retry", action: "request.retry" }],
        },
      });
    }

    const text = await response.text();
    const payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      const error = ((payload ?? {}) as ErrorEnvelope).error ?? {};
      if (response.status === 401 && !options?.allowUnauthenticated) redirectToLogin();
      throw new ApiError({
        code: (error.code as AnyErrorCode) ?? fallbackCode(response.status),
        message: error.message ?? fallbackMessage(response.status),
        status: response.status,
        detail: error.detail,
        remediation: error.remediation ?? null,
        fields: error.fields ?? {},
        requestId: error.request_id ?? null,
      });
    }

    const envelope = payload as { data?: T[]; meta?: ListMeta } | null;
    const data = envelope?.data ?? [];
    return {
      data,
      meta: envelope?.meta ?? {
        page: 1,
        per_page: data.length,
        total: data.length,
        has_more: false,
      },
    };
  },

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("POST", path, body ?? {}, options);
  },

  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("PATCH", path, body ?? {}, options);
  },

  /** Whole-resource replacement: a grant set, an sshd configuration. */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("PUT", path, body ?? {}, options);
  },

  del<T = void>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("DELETE", path, undefined, options);
  },
};

/**
 * Routes a remediation action. `href` navigates, `copy` is handled by
 * ErrorState itself, and `action` is left to the caller because only it
 * knows what "certificates.retry" means in its own context.
 */
export function followRemediation(
  action: RemediationAction,
  onAction?: (action: RemediationAction) => void,
): void {
  if (action.href && typeof window !== "undefined") {
    window.location.assign(action.href);
    return;
  }
  onAction?.(action);
}
