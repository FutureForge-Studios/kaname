import { z } from "zod";
import { emailAddress, isoDate, uuid } from "../primitives.js";
import { userStatus, userInvitation } from "./platform.js";

/* ------------------------------------------------------------------ *
 * View modes and audiences (KD-039).
 *
 * Two independent ideas:
 *
 *   view mode  how much of the panel a person wants to see. A stored
 *              preference. It hides pages; it never changes what the
 *              API allows.
 *   audience   who the account is. `operator` is everyone the panel
 *              had before; `reseller` and `client` are scoped accounts
 *              that only ever reach resources recorded as theirs.
 *
 * There is no tenant: a reseller is a user, a client is a user with a
 * parent, and ownership is one row per resource.
 * ------------------------------------------------------------------ */

export const viewMode = z.enum(["simplified", "advanced"]);
export type ViewMode = z.infer<typeof viewMode>;

export const audience = z.enum(["operator", "reseller", "client"]);
export type Audience = z.infer<typeof audience>;

/** The kinds of resource a scoped account can own. */
export const RESOURCE_KINDS = ["site", "domain", "mailbox", "database"] as const;
export const resourceKind = z.enum(RESOURCE_KINDS);
export type ResourceKind = z.infer<typeof resourceKind>;

export const RESOURCE_KIND_LABELS: Record<ResourceKind, { one: string; many: string }> = {
  site: { one: "Website", many: "Websites" },
  domain: { one: "Domain", many: "Domains" },
  mailbox: { one: "Mailbox", many: "Mailboxes" },
  database: { one: "Database", many: "Databases" },
};

/* ----------------------------- quotas ------------------------------ */

const ceiling = z.number().int().min(0).max(1_000_000).nullable();

/** A null ceiling is "no limit of its own". */
export const accountQuota = z.object({
  max_sites: ceiling,
  max_domains: ceiling,
  max_mailboxes: ceiling,
  max_databases: ceiling,
  max_disk_mb: ceiling,
});
export type AccountQuota = z.infer<typeof accountQuota>;

export const UNLIMITED_QUOTA: AccountQuota = {
  max_sites: null,
  max_domains: null,
  max_mailboxes: null,
  max_databases: null,
  max_disk_mb: null,
};

/**
 * What is in use. Disk is what Kaname can measure without walking a
 * filesystem: database sizes plus the space promised to mailboxes.
 */
export const quotaUsage = z.object({
  sites: z.number().int().nonnegative(),
  domains: z.number().int().nonnegative(),
  mailboxes: z.number().int().nonnegative(),
  databases: z.number().int().nonnegative(),
  disk_mb: z.number().int().nonnegative(),
});
export type QuotaUsage = z.infer<typeof quotaUsage>;

/** Which quota field and which usage field each resource kind counts against. */
export const QUOTA_FIELDS: Record<
  ResourceKind,
  { limit: keyof AccountQuota; usage: keyof QuotaUsage }
> = {
  site: { limit: "max_sites", usage: "sites" },
  domain: { limit: "max_domains", usage: "domains" },
  mailbox: { limit: "max_mailboxes", usage: "mailboxes" },
  database: { limit: "max_databases", usage: "databases" },
};

/* ---------------------------- branding ----------------------------- */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === "" ? null : v));

export const resellerBranding = z.object({
  display_name: z.string().trim().min(1).max(64),
  /** Up to four characters drawn in the sidebar mark. */
  logo_text: optionalText(4),
  support_email: z.union([emailAddress, z.literal("").transform(() => null)]).nullable(),
  support_url: z
    .union([
      z
        .string()
        .url()
        .max(300)
        .refine((v) => /^https?:\/\//i.test(v), "Use an http:// or https:// address."),
      z.literal("").transform(() => null),
    ])
    .nullable(),
});
export type ResellerBranding = z.infer<typeof resellerBranding>;

/* --------------------------- the "me" card -------------------------- */

export const serverRef = z.object({ id: uuid, name: z.string() });
export type ServerRef = z.infer<typeof serverRef>;

/**
 * Everything the shell needs to decide what to draw for the signed-in
 * person. `branding` is the reseller's own for a reseller, the parent's
 * for a client, and null for an operator.
 */
export const accountContext = z.object({
  user_id: uuid,
  audience,
  view_mode: viewMode,
  reseller_id: uuid.nullable(),
  branding: resellerBranding.nullable(),
  /** Null for operators, who have no quota. */
  quota: accountQuota.nullable(),
  usage: quotaUsage.nullable(),
  servers: z.array(serverRef),
});
export type AccountContext = z.infer<typeof accountContext>;

export const updateViewModeInput = z.object({ view_mode: viewMode });
export type UpdateViewModeInput = z.infer<typeof updateViewModeInput>;

/**
 * Where a scoped account may put something new. Infrastructure routes
 * stay operator-only, so this is the one place a reseller or client
 * learns which hosts, engines and mail domains are open to them.
 */
export const placement = z.object({
  servers: z.array(serverRef.extend({ hostname: z.string(), address: z.string().nullable() })),
  db_instances: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      engine: z.string(),
      version: z.string().nullable(),
      server_id: uuid,
      server_name: z.string(),
    }),
  ),
  mail_domains: z.array(z.object({ id: uuid, name: z.string(), server_id: uuid })),
});
export type Placement = z.infer<typeof placement>;

/* ---------------------------- resellers ---------------------------- */

export const reseller = z.object({
  id: uuid,
  email: emailAddress,
  name: z.string(),
  status: userStatus,
  servers: z.array(serverRef),
  quota: accountQuota,
  /** The reseller's own resources plus every client's. */
  usage: quotaUsage,
  branding: resellerBranding.nullable(),
  client_count: z.number().int().nonnegative(),
  last_login_at: isoDate.nullable(),
  created_at: isoDate,
});
export type Reseller = z.infer<typeof reseller>;

export const createResellerInput = z.object({
  email: emailAddress,
  name: z.string().trim().min(1).max(96),
  server_ids: z.array(uuid).max(200).default([]),
  quota: accountQuota.partial().default({}),
  branding: resellerBranding.optional(),
  send_invite: z.boolean().default(true),
});
export type CreateResellerInput = z.infer<typeof createResellerInput>;

export const updateResellerInput = z.object({
  name: z.string().trim().min(1).max(96).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  server_ids: z.array(uuid).max(200).optional(),
  quota: accountQuota.partial().optional(),
});
export type UpdateResellerInput = z.infer<typeof updateResellerInput>;

export const invitedReseller = reseller.extend({ invite: userInvitation });
export type InvitedReseller = z.infer<typeof invitedReseller>;

/* ----------------------------- clients ----------------------------- */

export const client = z.object({
  id: uuid,
  email: emailAddress,
  name: z.string(),
  status: userStatus,
  reseller_id: uuid.nullable(),
  quota: accountQuota,
  usage: quotaUsage,
  last_login_at: isoDate.nullable(),
  created_at: isoDate,
});
export type Client = z.infer<typeof client>;

export const createClientInput = z.object({
  email: emailAddress,
  name: z.string().trim().min(1).max(96),
  quota: accountQuota.partial().default({}),
  send_invite: z.boolean().default(true),
});
export type CreateClientInput = z.infer<typeof createClientInput>;

export const updateClientInput = z.object({
  name: z.string().trim().min(1).max(96).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  quota: accountQuota.partial().optional(),
});
export type UpdateClientInput = z.infer<typeof updateClientInput>;

export const invitedClient = client.extend({ invite: userInvitation });
export type InvitedClient = z.infer<typeof invitedClient>;

/* ------------------------ owned resources -------------------------- */

export const ownedResource = z.object({
  kind: resourceKind,
  id: uuid,
  label: z.string(),
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  owner_id: uuid.nullable(),
  owner_name: z.string().nullable(),
});
export type OwnedResource = z.infer<typeof ownedResource>;

export const assignResourceInput = z.object({ kind: resourceKind, resource_id: uuid });
export type AssignResourceInput = z.infer<typeof assignResourceInput>;

export const resourceParam = z.object({ id: uuid, kind: resourceKind, resourceId: uuid });
