import { errorStatus, type ErrorCode, type Remediation } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * One error type for the whole API.
 *
 * The important field is `remediation`: an operator should never see
 * "something went wrong" when we know exactly what is wrong and what
 * they should do about it.
 * ------------------------------------------------------------------ */

export class ApiException extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: unknown;
  readonly remediation?: Remediation;
  readonly fields?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { detail?: unknown; remediation?: Remediation; fields?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "ApiException";
    this.code = code;
    this.status = errorStatus[code];
    this.detail = opts.detail;
    this.remediation = opts.remediation;
    this.fields = opts.fields;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail !== undefined ? { detail: this.detail } : {}),
        ...(this.remediation ? { remediation: this.remediation } : {}),
        ...(this.fields ? { fields: this.fields } : {}),
      },
    };
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiException("bad_request", message, { fields });

export const notFound = (what: string, id?: string) =>
  new ApiException("not_found", id ? `${what} ${id} not found.` : `${what} not found.`);

export const forbidden = (permission: string, serverName?: string) =>
  new ApiException(
    "forbidden",
    serverName
      ? `You do not have ${permission} on ${serverName}.`
      : `You do not have ${permission}.`,
    {
      remediation: {
        summary:
          "Ask an owner to grant this permission, or scope your role to include this server.",
        actions: [{ label: "View roles", href: "/administration/roles" }],
      },
    },
  );

export const unauthenticated = () =>
  new ApiException("unauthenticated", "Sign in to continue.", {
    remediation: {
      summary: "Your session has expired.",
      actions: [{ label: "Sign in", href: "/login" }],
    },
  });

export const conflict = (message: string, remediation?: Remediation) =>
  new ApiException("conflict", message, { remediation });

export const agentOffline = (serverName: string, lastSeen: Date | null) =>
  new ApiException("agent_offline", `The agent on ${serverName} is not connected.`, {
    detail: { last_seen_at: lastSeen?.toISOString() ?? null },
    remediation: {
      summary: lastSeen
        ? `Last seen ${lastSeen.toISOString()}. The job will run automatically when the agent reconnects.`
        : "This server has never connected. Finish enrollment on the host.",
      actions: [
        { label: "Server details", href: "/infrastructure/servers" },
        { label: "Check agent", action: "servers.ping" },
      ],
    },
  });

export const agentUnsupported = (serverName: string, capability: string) =>
  new ApiException("agent_unsupported", `${serverName} does not have ${capability} available.`, {
    remediation: {
      summary: `Install ${capability} on the host, then re-sync the server so Kaname re-detects its capabilities.`,
      actions: [{ label: "Re-sync server", action: "servers.sync" }],
    },
  });

/** Maps an agent-side error code onto the API's vocabulary. */
export function fromAgentError(
  serverName: string,
  err: { code: string; message: string; detail?: unknown; output?: string },
): ApiException {
  switch (err.code) {
    case "unsupported":
      return agentUnsupported(serverName, "this capability");
    case "not_found":
      return new ApiException("not_found", err.message, { detail: err.detail });
    case "permission_denied":
      return new ApiException("forbidden", `${serverName}: ${err.message}`, { detail: err.detail });
    case "timeout":
      return new ApiException("agent_timeout", `${serverName}: ${err.message}`);
    case "conflict":
      return new ApiException("conflict", err.message, { detail: err.detail });
    case "invalid_params":
      return new ApiException("validation_failed", err.message, { detail: err.detail });
    default:
      return new ApiException("agent_error", `${serverName}: ${err.message}`, {
        detail: err.output ?? err.detail,
      });
  }
}
