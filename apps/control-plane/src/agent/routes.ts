import { webcrypto } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as x509 from "@peculiar/x509";
import { and, eq, gt, isNull, type Database } from "@kaname/db";
import { enrollmentTokens, servers } from "@kaname/db/schema";
import {
  AGENT_SUBPROTOCOL,
  AGENT_PROTOCOL_VERSION,
  enrollRequest,
  type EnrollResponse,
} from "@kaname/contract/agent";
import { z } from "zod";
import { ApiException } from "../lib/errors.js";
import { hashToken, hmac } from "../lib/crypto.js";
import type { AppContext } from "../context.js";

/* ------------------------------------------------------------------ *
 * The agent-facing surface. Three endpoints, nothing else.
 *
 *   POST /agent/v1/enroll   one-time, token-authenticated, signs a CSR
 *   POST /agent/v1/token    proof-of-possession, returns a 5-minute bearer
 *   GET  /agent/v1/connect  WebSocket upgrade, bearer-authenticated
 *
 * Authentication is proof of possession of the private key generated on
 * the host at enrollment. When TLS client authentication is available
 * (direct TLS, or a trusted proxy forwarding the peer certificate) the
 * certificate CN is additionally pinned to the same server. The signed
 * challenge is what makes the scheme sound over either transport.
 * ------------------------------------------------------------------ */

const TOKEN_TTL_MS = 5 * 60_000;
const CHALLENGE_SKEW_MS = 60_000;

const tokenRequest = z.object({
  server_id: z.string().uuid(),
  nonce: z.string().min(16).max(128),
  timestamp: z.number().int(),
  /** base64url ECDSA P-256 signature over "server_id|nonce|timestamp". */
  signature: z.string().min(16).max(512),
});

export async function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, config, log } = ctx;

  /* ------------------------------ enroll ----------------------------- */

  app.post("/agent/v1/enroll", async (req, reply) => {
    const body = enrollRequest.parse(req.body);

    const tokenRows = await db
      .select({ token: enrollmentTokens, server: servers })
      .from(enrollmentTokens)
      .innerJoin(servers, eq(enrollmentTokens.serverId, servers.id))
      .where(
        and(
          eq(enrollmentTokens.tokenHash, hashToken(body.token)),
          isNull(enrollmentTokens.usedAt),
          gt(enrollmentTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const found = tokenRows[0];
    if (!found) {
      throw new ApiException("unauthenticated", "Enrollment token is invalid, used or expired.", {
        remediation: {
          summary: "Generate a fresh enrollment command from the server's page and run it again.",
          actions: [{ label: "Servers", href: "/infrastructure/servers" }],
        },
      });
    }

    const issued = await ctx.ca.signCsr(body.csr_pem, found.server.id, body.host.hostname);

    await db
      .update(enrollmentTokens)
      .set({ usedAt: new Date() })
      .where(eq(enrollmentTokens.id, found.token.id));

    await db
      .update(servers)
      .set({
        hostname: body.host.hostname,
        machineId: body.host.machine_id,
        os: body.host.os,
        osVersion: body.host.os_version,
        arch: body.host.arch,
        kernel: body.host.kernel,
        agentVersion: body.agent_version,
        simulated: body.host.simulated,
        enrolledAt: new Date(),
        connection: "disconnected",
        certSerial: issued.serialNumber,
        certFingerprint: issued.fingerprint,
        certPem: issued.certificatePem,
        certExpiresAt: issued.notAfter,
        revokedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(servers.id, found.server.id));

    await ctx.audit.record({
      actor: { type: "agent", id: found.server.id, name: body.host.hostname, ip: req.ip },
      action: "server.enrolled",
      targetType: "server",
      targetId: found.server.id,
      targetLabel: found.server.name,
      serverId: found.server.id,
      metadata: { agent_version: body.agent_version, simulated: body.host.simulated },
    });

    ctx.events.publish(
      "servers",
      "server.enrolled",
      { server_id: found.server.id },
      found.server.id,
    );
    log.info({ serverId: found.server.id, hostname: body.host.hostname }, "agent enrolled");

    const response: EnrollResponse = {
      server_id: found.server.id,
      certificate_pem: issued.certificatePem,
      ca_pem: issued.caPem,
      connect_url: connectUrl(config.agentUrl),
      expires_at: issued.notAfter.toISOString(),
    };
    return reply.status(200).send(response);
  });

  /* ------------------------------ token ------------------------------ */

  app.post("/agent/v1/token", async (req, reply) => {
    const body = tokenRequest.parse(req.body);

    const server = await requireEnrolledServer(db, body.server_id);
    const drift = Math.abs(Date.now() - body.timestamp);
    if (drift > CHALLENGE_SKEW_MS) {
      throw new ApiException("unauthenticated", "Agent clock is too far out of sync.", {
        detail: { drift_ms: drift },
      });
    }

    const ok = await verifyChallenge(
      server.certPem!,
      `${body.server_id}|${body.nonce}|${body.timestamp}`,
      body.signature,
    );
    if (!ok) throw new ApiException("unauthenticated", "Agent signature is not valid.");

    await assertPeerMatches(req, ctx, body.server_id);

    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const token = `${body.server_id}.${expiresAt}.${hmac(
      config.masterKey,
      "agent-connect",
      body.server_id,
      String(expiresAt),
    )}`;

    return reply.send({ token, expires_at: new Date(expiresAt).toISOString() });
  });

  /* ----------------------------- connect ----------------------------- */

  app.get("/agent/v1/connect", { websocket: true }, async (socket, req) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const serverId = verifyConnectToken(bearer, ctx);

    if (!serverId) {
      socket.close(4401, "invalid or expired agent token");
      return;
    }

    // The agent writes its hello the moment the upgrade completes, and
    // `ws` starts emitting messages right away. Nothing is listening until
    // the hub registers this socket, so a frame that lands during the
    // checks below would be lost — and a hub that never hears a hello now
    // drops the connection. Hold the frames until there is a reader.
    socket.pause();

    const rows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    const server = rows[0];
    if (!server || server.revokedAt) {
      socket.close(4403, "server revoked");
      return;
    }

    try {
      await assertPeerMatches(req, ctx, serverId);
    } catch {
      socket.close(4403, "client certificate does not match");
      return;
    }

    log.info({ serverId, name: server.name }, "agent connected");
    ctx.hub.register(serverId, socket as never, req.ip ?? null);
    socket.resume();
  });

  /* ------------------------------ health ----------------------------- */

  app.get("/agent/v1/ca", async (_req, reply) => {
    const { pem } = await ctx.ca.load();
    return reply.type("application/x-pem-file").send(pem);
  });

  app.get("/agent/v1/hello", async (_req, reply) =>
    reply.send({ protocol: AGENT_PROTOCOL_VERSION, subprotocol: AGENT_SUBPROTOCOL }),
  );
}

/* ------------------------------------------------------------------ */

async function requireEnrolledServer(db: Database, serverId: string) {
  const rows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const server = rows[0];
  if (!server || !server.certPem) {
    throw new ApiException("unauthenticated", "This server is not enrolled.");
  }
  if (server.revokedAt) {
    throw new ApiException("forbidden", "This server's agent certificate has been revoked.");
  }
  if (server.certExpiresAt && server.certExpiresAt < new Date()) {
    throw new ApiException("unauthenticated", "This server's agent certificate has expired.", {
      remediation: {
        summary: "Re-run enrollment on the host to obtain a fresh certificate.",
        actions: [],
      },
    });
  }
  return server;
}

async function verifyChallenge(
  certPem: string,
  message: string,
  signatureB64Url: string,
): Promise<boolean> {
  try {
    const cert = new x509.X509Certificate(certPem);
    const key = await cert.publicKey.export(webcrypto as unknown as Crypto);
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signatureB64Url, "base64url"),
      Buffer.from(message, "utf8"),
    );
  } catch {
    return false;
  }
}

/**
 * When the peer certificate is available — direct TLS, or a trusted
 * reverse proxy forwarding it — pin it to the same server. When it is
 * not available the signed challenge above already proved possession.
 */
async function assertPeerMatches(
  req: { socket: unknown; headers: Record<string, unknown> },
  ctx: AppContext,
  serverId: string,
): Promise<void> {
  const pem = peerCertificatePem(req);
  if (!pem) return;

  const verified = await ctx.ca.verifyClientCertificate(pem);
  if (!verified || verified.serverId !== serverId) {
    throw new ApiException("forbidden", "Client certificate does not match the claimed server.");
  }
}

function peerCertificatePem(req: {
  socket: unknown;
  headers: Record<string, unknown>;
}): string | null {
  const socket = req.socket as { getPeerCertificate?: (d?: boolean) => { raw?: Buffer } };
  const cert = socket.getPeerCertificate?.();
  if (cert?.raw?.length) {
    return `-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  }

  // Caddy and nginx can forward the client cert; only trusted when the
  // deployment explicitly opts in.
  if (process.env.KANAME_TRUST_PROXY_CLIENT_CERT === "true") {
    const header = req.headers["x-kaname-client-cert"];
    if (typeof header === "string" && header.includes("BEGIN CERTIFICATE")) {
      return decodeURIComponent(header.replace(/\t/g, "\n"));
    }
  }
  return null;
}

function verifyConnectToken(token: string, ctx: AppContext): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [serverId, expiresRaw, signature] = parts as [string, string, string];
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const expected = hmac(ctx.config.masterKey, "agent-connect", serverId, expiresRaw);
  return expected === signature ? serverId : null;
}

function connectUrl(base: string): string {
  const url = new URL("/agent/v1/connect", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
