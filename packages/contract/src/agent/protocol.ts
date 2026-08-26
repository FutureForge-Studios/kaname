import { z } from "zod";

/* ------------------------------------------------------------------ *
 * kaname-agent/1 — wire protocol
 *
 * One agent-initiated WebSocket carries request/response, streaming
 * chunks in both directions, unsolicited events and heartbeats.
 * The agent binds no port; the control plane never dials the agent.
 * ------------------------------------------------------------------ */

export const AGENT_PROTOCOL_VERSION = 1 as const;
/**
 * A WebSocket subprotocol name is an RFC 7230 token, so "/" is illegal —
 * `ws` rejects the handshake with 400 before any route sees it. The
 * version therefore rides as `.v1`, not as a path segment.
 */
export const AGENT_SUBPROTOCOL = "kaname-agent.v1" as const;

/** Max unacknowledged chunks in flight before the sender must pause. */
export const STREAM_WINDOW = 32;
/** Max bytes per chunk frame. */
export const MAX_CHUNK_BYTES = 256 * 1024;
/** Heartbeat cadence and the multiple of it after which a peer is dead. */
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MULTIPLIER = 3;

export const agentErrorCode = z.enum([
  "unknown_method",
  "invalid_params",
  "unsupported",
  "not_found",
  "permission_denied",
  "conflict",
  "precondition_failed",
  "timeout",
  "cancelled",
  "io_error",
  "exec_failed",
  "internal",
]);
export type AgentErrorCode = z.infer<typeof agentErrorCode>;

export const agentError = z.object({
  code: agentErrorCode,
  message: z.string(),
  detail: z.unknown().optional(),
  /** stderr / journal excerpt, already truncated by the agent. */
  output: z.string().max(16_384).optional(),
});
export type AgentError = z.infer<typeof agentError>;

/* --------------------------- frames --------------------------- */

export const helloFrame = z.object({
  t: z.literal("hlo"),
  proto: z.number().int(),
  agent_version: z.string(),
  capabilities: z.array(z.string()),
  host: z.object({
    hostname: z.string(),
    machine_id: z.string(),
    os: z.string(),
    os_version: z.string(),
    arch: z.string(),
    kernel: z.string(),
    boot_time: z.string(),
    simulated: z.boolean().default(false),
  }),
});

export const requestFrame = z.object({
  t: z.literal("req"),
  id: z.string().min(1).max(64),
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
  deadline_ms: z
    .number()
    .int()
    .min(100)
    .max(6 * 60 * 60 * 1000),
  /** Set when the request opens a bidirectional stream (upload, PTY). */
  stream: z.boolean().optional(),
});

export const responseFrame = z.union([
  z.object({ t: z.literal("res"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ t: z.literal("res"), id: z.string(), ok: z.literal(false), error: agentError }),
]);

export const chunkFrame = z.object({
  t: z.literal("chk"),
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** base64 for binary payloads, plain string for text streams. */
  data: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

export const ackFrame = z.object({
  t: z.literal("ack"),
  id: z.string(),
  seq: z.number().int().nonnegative(),
});

export const endFrame = z.union([
  z.object({ t: z.literal("end"), id: z.string(), ok: z.literal(true) }),
  z.object({ t: z.literal("end"), id: z.string(), ok: z.literal(false), error: agentError }),
]);

export const cancelFrame = z.object({ t: z.literal("can"), id: z.string() });

export const eventFrame = z.object({
  t: z.literal("evt"),
  topic: z.string().min(1).max(64),
  ts: z.string(),
  data: z.unknown(),
});

export const pingFrame = z.object({ t: z.literal("png"), ts: z.number() });
export const pongFrame = z.object({ t: z.literal("pog"), ts: z.number() });

export const agentFrame = z.union([
  helloFrame,
  requestFrame,
  responseFrame,
  chunkFrame,
  ackFrame,
  endFrame,
  cancelFrame,
  eventFrame,
  pingFrame,
  pongFrame,
]);
export type AgentFrame = z.infer<typeof agentFrame>;
export type HelloFrame = z.infer<typeof helloFrame>;
export type RequestFrame = z.infer<typeof requestFrame>;
export type ChunkFrame = z.infer<typeof chunkFrame>;
export type EventFrame = z.infer<typeof eventFrame>;

/* --------------------------- topics --------------------------- */

/** Unsolicited pushes from an agent. Anything not listed is dropped. */
export const AGENT_EVENT_TOPICS = [
  "metrics",
  "service.changed",
  "container.changed",
  "threat.detected",
  "ssh.session",
  "cert.expiring",
  "disk.pressure",
  "log.anomaly",
] as const;
export type AgentEventTopic = (typeof AGENT_EVENT_TOPICS)[number];

/* --------------------------- enrollment --------------------------- */

export const enrollRequest = z.object({
  token: z.string().min(16).max(200),
  csr_pem: z.string().min(1).max(8192),
  host: helloFrame.shape.host,
  agent_version: z.string(),
});
export type EnrollRequest = z.infer<typeof enrollRequest>;

export const enrollResponse = z.object({
  server_id: z.string().uuid(),
  certificate_pem: z.string(),
  ca_pem: z.string(),
  /** Absolute wss:// endpoint the agent should connect to from now on. */
  connect_url: z.string().url(),
  expires_at: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponse>;

/** Short-lived bearer obtained over the mTLS-only token endpoint. */
export const agentTokenResponse = z.object({
  token: z.string(),
  expires_at: z.string(),
});
