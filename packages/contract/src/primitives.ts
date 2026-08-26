import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Scalars
 * ------------------------------------------------------------------ */

export const uuid = z.string().uuid();
export const isoDate = z.string().datetime({ offset: true });
export const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case slug");

export const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/,
    "must be a valid hostname",
  );

export const domainName = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/,
    "must be a valid domain name",
  );

export const emailAddress = z.string().email().max(320);
export const ipv4 = z.string().ip({ version: "v4" });
export const ipAddress = z.string().ip();
export const cidr = z.string().cidr();
export const port = z.coerce.number().int().min(1).max(65535);

/** Absolute POSIX path with no traversal segments. The agent re-validates. */
export const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\//, "must be an absolute path")
  .refine((p) => !p.split("/").includes(".."), { message: "path traversal is not allowed" })
  .refine((p) => !p.includes("\0"), { message: "path may not contain a null byte" });

/** POSIX user/group or database identifier. */
export const identifier = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "must start with a letter or underscore");

export const bytes = z.number().int().nonnegative();
export const percent = z.number().min(0).max(100);

/** Unix file mode as an octal string, e.g. "0644". */
export const fileMode = z.string().regex(/^0?[0-7]{3,4}$/, "must be an octal mode like 0644");

export const cronExpression = z
  .string()
  .min(9)
  .max(120)
  .regex(/^[\d*/,\-A-Za-z? ]+$/, "must be a cron expression");

/* ------------------------------------------------------------------ *
 * List query + pagination
 * ------------------------------------------------------------------ */

export const sortOrder = z.enum(["asc", "desc"]);
export type SortOrder = z.infer<typeof sortOrder>;

export const listQuery = z.object({
  q: z.string().max(200).optional(),
  sort: z.string().max(64).optional(),
  order: sortOrder.default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListQuery = z.infer<typeof listQuery>;

export const listMeta = z.object({
  page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  has_more: z.boolean(),
});
export type ListMeta = z.infer<typeof listMeta>;

/* ------------------------------------------------------------------ *
 * Response envelopes
 * ------------------------------------------------------------------ */

export function itemEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: schema });
}

export function listEnvelope<T extends z.ZodTypeAny>(schema: T) {
  return z.object({ data: z.array(schema), meta: listMeta });
}

/**
 * Actionable remediation attached to errors. This is what makes the difference
 * between "something went wrong" and
 * "DNS record _acme-challenge.example.com not found — [Check DNS] [Retry]".
 */
export const remediationAction = z.object({
  label: z.string().min(1).max(48),
  /** In-app route to send the operator to. */
  href: z.string().max(512).optional(),
  /** Machine action the UI can re-dispatch, e.g. "certificates.retry". */
  action: z.string().max(64).optional(),
  /** Literal value the operator should copy (a DNS record, a command). */
  copy: z.string().max(2048).optional(),
});
export type RemediationAction = z.infer<typeof remediationAction>;

export const remediation = z.object({
  summary: z.string().min(1).max(500),
  actions: z.array(remediationAction).max(4).default([]),
});
export type Remediation = z.infer<typeof remediation>;

export const errorCode = z.enum([
  "bad_request",
  "validation_failed",
  "unauthenticated",
  "totp_required",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "rate_limited",
  "agent_offline",
  "agent_timeout",
  "agent_error",
  "agent_unsupported",
  "job_failed",
  "upstream_error",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof errorCode>;

export const apiError = z.object({
  error: z.object({
    code: errorCode,
    message: z.string(),
    detail: z.unknown().optional(),
    remediation: remediation.optional(),
    /** Field-level messages keyed by dotted path, for form binding. */
    fields: z.record(z.string(), z.string()).optional(),
    request_id: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

/** HTTP status that each error code maps to. Single source of truth. */
export const errorStatus: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  totp_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  agent_offline: 503,
  agent_timeout: 504,
  agent_error: 502,
  agent_unsupported: 501,
  job_failed: 500,
  upstream_error: 502,
  internal_error: 500,
};

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

export const timestamps = z.object({
  created_at: isoDate,
  updated_at: isoDate,
});

/** Set on every row that belongs to a managed host. */
export const serverScoped = z.object({
  server_id: uuid,
  server_name: z.string().optional(),
});

export const idParam = z.object({ id: uuid });
export const serverIdQuery = z.object({ server_id: uuid.optional() });
