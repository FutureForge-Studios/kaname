import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodTypeAny } from "zod";
import { errorStatus, listMeta, type ListMeta, type Permission } from "@kaname/contract";
import { ApiException, badRequest, unauthenticated } from "../lib/errors.js";
import type { AppContext } from "../context.js";
import type { Principal } from "../services/auth.js";

/* ------------------------------------------------------------------ *
 * Request plumbing shared by every route.
 *
 * The important thing here is that authorisation happens in exactly one
 * function. A route that forgets to call `authorize` fails closed,
 * because `principal` is only reachable through it.
 * ------------------------------------------------------------------ */

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
    ctx: AppContext;
  }
}

export interface RouteHelpers {
  /** Throws unless the caller holds `permission`, scoped to `serverId`. */
  authorize(permission: Permission, serverId?: string | null): Principal;
  /** The caller, or throws. Use when a route has already authorised. */
  requirePrincipal(): Principal;
  actor(): {
    type: "user" | "api_key";
    id: string;
    name: string;
    ip: string | null;
    userAgent: string | null;
  };
}

export function helpers(req: FastifyRequest): RouteHelpers {
  return {
    authorize(permission, serverId) {
      req.ctx.auth.authorize(req.principal, permission, serverId);
      return req.principal!;
    },
    requirePrincipal() {
      if (!req.principal) throw unauthenticated();
      return req.principal;
    },
    actor() {
      const p = req.principal;
      if (!p) throw unauthenticated();
      return {
        type: p.kind,
        id: p.id,
        name: p.name,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      };
    },
  };
}

/* ----------------------------- cookies ---------------------------- */

/**
 * Whether a cookie set on this request may carry the Secure flag and
 * the `__Host-` prefix. Decided per request rather than per process: an
 * install answers on its IP over plain HTTP and, once a domain is set,
 * on that name over HTTPS as well. A browser refuses a Secure cookie
 * from the first origin, so choosing by how the request arrived is what
 * keeps sign-in working on both at once. Fastify trusts the proxy, so
 * `protocol` reflects Caddy's x-forwarded-proto.
 */
export function secureCookie(req: FastifyRequest): boolean {
  const policy = req.ctx.config.secureCookies;
  return policy === "auto" ? req.protocol === "https" : policy === "always";
}

/** The session cookie a response to this request sets or clears. */
export function sessionCookieName(req: FastifyRequest): string {
  return secureCookie(req) ? req.ctx.config.secureCookieName : req.ctx.config.cookieName;
}

/**
 * A cookie by either of its names, the `__Host-` one first. Which name
 * a browser holds depends on the origin it signed in on, and the same
 * account may be signed in on both.
 */
export function readCookie(req: FastifyRequest, base: string): string | undefined {
  const jar = req.cookies as Record<string, string | undefined> | undefined;
  return jar?.[`__Host-${base}`] ?? jar?.[base];
}

/* --------------------------- validation --------------------------- */

export function parseBody<T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, req.body, "body");
}

export function parseQuery<T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, req.query, "query");
}

export function parseParams<T extends ZodTypeAny>(req: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, req.params, "params");
}

function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown, where: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fields[issue.path.join(".") || where] = issue.message;
  }
  throw new ApiException("validation_failed", `Invalid request ${where}.`, { fields });
}

/* ---------------------------- responses ---------------------------- */

export function item<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply.status(status).send({ data });
}

export function list<T>(reply: FastifyReply, data: T[], meta: ListMeta): FastifyReply {
  return reply.status(200).send({ data, meta });
}

export function accepted(reply: FastifyReply, job: unknown): FastifyReply {
  return reply.status(202).send({ data: { job } });
}

export function noContent(reply: FastifyReply): FastifyReply {
  return reply.status(204).send();
}

export function paginate(total: number, page: number, perPage: number): ListMeta {
  return listMeta.parse({
    page,
    per_page: perPage,
    total,
    has_more: page * perPage < total,
  });
}

export function offset(page: number, perPage: number): number {
  return (page - 1) * perPage;
}

/* ------------------------- registration ---------------------------- */

export async function registerRequestContext(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Cast: Fastify types decorateRequest defaults as getter/setter pairs,
  // but a null default is exactly what we want here.
  app.decorateRequest("principal", null as never);
  app.decorateRequest("ctx", null as never);

  app.addHook("onRequest", async (req) => {
    req.ctx = ctx;
    req.principal = null;

    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      req.principal = await ctx.auth.principalFromApiKey(auth.slice(7).trim());
      return;
    }

    const cookie = readCookie(req, ctx.config.cookieName);
    if (cookie) {
      req.principal = await ctx.auth.principalFromSessionToken(cookie);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiException) {
      return reply.status(err.status).send({
        ...err.toJSON(),
        error: { ...err.toJSON().error, request_id: req.id },
      });
    }

    // Fastify's own validation and rate-limit errors carry a statusCode.
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      const code = status === 429 ? "rate_limited" : status === 404 ? "not_found" : "bad_request";
      return reply
        .status(status)
        .send({ error: { code, message: (err as Error).message, request_id: req.id } });
    }

    req.log.error({ err, url: req.url }, "unhandled error");
    return reply.status(errorStatus.internal_error).send({
      error: {
        code: "internal_error",
        message: "Something went wrong on the control plane.",
        request_id: req.id,
      },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send({ error: { code: "not_found", message: `No route for ${req.method} ${req.url}.` } }),
  );
}

/** Standard list-query coercion shared by every index route. */
export const baseListQuery = z.object({
  q: z.string().max(200).optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});

export function requireServerId(value: string | undefined): string {
  if (!value)
    throw badRequest("server_id is required for this endpoint.", { server_id: "required" });
  return value;
}
