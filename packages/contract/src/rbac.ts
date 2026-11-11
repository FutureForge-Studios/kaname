import { z } from "zod";
import { uuid } from "./primitives.js";

/* ------------------------------------------------------------------ *
 * Permission taxonomy
 *
 * A permission is `module.resource:action`. A *grant* pairs a permission
 * with a scope: either the whole fleet, or an explicit list of servers.
 * This is the thing most competing panels get wrong (single admin flag),
 * so it is modelled properly from day one.
 * ------------------------------------------------------------------ */

export const PERMISSIONS = [
  // Infrastructure
  "infra.servers:read",
  "infra.servers:write",
  "infra.servers:delete",
  "infra.services:read",
  "infra.services:exec",
  "infra.processes:read",
  "infra.processes:exec",
  "infra.containers:read",
  "infra.containers:exec",
  "infra.containers:delete",

  // Websites
  "websites.sites:read",
  "websites.sites:write",
  "websites.sites:delete",
  "websites.domains:read",
  "websites.domains:write",
  "websites.domains:delete",
  "websites.dns:read",
  "websites.dns:write",
  "websites.dns:delete",
  "websites.ssl:read",
  "websites.ssl:write",
  "websites.ssl:delete",
  "websites.deployments:read",
  "websites.deployments:exec",

  // Apps (the one-click installer)
  "apps.installs:read",
  "apps.installs:write",
  "apps.installs:delete",

  // Files
  "files.manager:read",
  "files.manager:write",
  "files.manager:delete",
  "files.ftp:read",
  "files.ftp:write",
  "files.ftp:delete",

  // Email
  "email.mailboxes:read",
  "email.mailboxes:write",
  "email.mailboxes:delete",
  "email.routing:read",
  "email.routing:write",
  "email.routing:delete",
  "email.servers:read",
  "email.servers:write",
  "email.servers:exec",
  "email.logs:read",

  // Databases
  "databases.mysql:read",
  "databases.mysql:write",
  "databases.mysql:delete",
  "databases.postgres:read",
  "databases.postgres:write",
  "databases.postgres:delete",

  // Security
  "security.firewall:read",
  "security.firewall:write",
  "security.threats:read",
  "security.threats:write",
  "security.ssh:read",
  "security.ssh:write",
  "security.audit:read",

  // Backups
  "backups.schedules:read",
  "backups.schedules:write",
  "backups.schedules:delete",
  "backups.restore:exec",

  // Monitoring & logs
  "monitoring.metrics:read",
  "monitoring.alerts:read",
  "monitoring.alerts:write",
  "logs.streams:read",

  // Terminal
  "terminal.session:exec",

  // Administration
  "admin.users:read",
  "admin.users:write",
  "admin.users:delete",
  "admin.roles:read",
  "admin.roles:write",
  "admin.roles:delete",
  "admin.api_keys:read",
  "admin.api_keys:write",
  "admin.api_keys:delete",
  "admin.settings:read",
  "admin.settings:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const permission = z.enum(PERMISSIONS);

export const PERMISSION_MODULES = [
  "infra",
  "websites",
  "apps",
  "files",
  "email",
  "databases",
  "security",
  "backups",
  "monitoring",
  "logs",
  "terminal",
  "admin",
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/** Human labels for the role editor. Keyed by `module.resource`. */
export const PERMISSION_GROUP_LABELS: Record<string, string> = {
  "infra.servers": "Servers",
  "infra.services": "Services",
  "infra.processes": "Processes",
  "infra.containers": "Containers",
  "websites.sites": "Sites",
  "websites.domains": "Domains",
  "websites.dns": "DNS",
  "websites.ssl": "SSL / TLS",
  "websites.deployments": "Deployments",
  "apps.installs": "App installer",
  "files.manager": "File manager",
  "files.ftp": "FTP / SFTP",
  "email.mailboxes": "Mailboxes",
  "email.routing": "Aliases",
  "email.servers": "Mail servers & DNS",
  "email.logs": "Mail logs",
  "databases.mysql": "MySQL / MariaDB",
  "databases.postgres": "PostgreSQL",
  "security.firewall": "Firewall",
  "security.threats": "Threat protection",
  "security.ssh": "SSH security",
  "security.audit": "Audit",
  "backups.schedules": "Backup schedules",
  "backups.restore": "Restore",
  "monitoring.metrics": "Metrics",
  "monitoring.alerts": "Alerts",
  "logs.streams": "Logs",
  "terminal.session": "Terminal",
  "admin.users": "Users",
  "admin.roles": "Roles",
  "admin.api_keys": "API keys",
  "admin.settings": "Settings",
};

/** One-line explanations of what granting each permission actually allows. */
export const PERMISSION_DESCRIPTIONS: Partial<Record<Permission, string>> = {
  // POST /servers/:id/revoke checks exactly this, so the sentence and the code agree.
  "infra.servers:delete": "Remove a server from the fleet and revoke its agent certificate.",
  // A shell inside a container is a shell on the host's kernel, so Exec
  // needs terminal.session:exec as well; this alone is the lifecycle verbs.
  "infra.containers:exec":
    "Start, stop and restart containers. A shell inside one also needs terminal.session:exec.",
  // One grant for the whole bundle: the installer creates the site, the
  // database and the certificate itself, so this is enough on its own.
  "apps.installs:write":
    "Install catalog apps. Creates a site, a database with its own user, and a certificate on the server.",
  "apps.installs:delete":
    "Uninstall an app, deleting the site, its files and its database. Destructive.",
  "terminal.session:exec": "Open an interactive root shell on the server. Sessions are recorded.",
  "backups.restore:exec": "Restore data over live files or databases. Destructive.",
  "security.audit:read": "Read the append-only audit trail and verify its hash chain.",
  "admin.roles:write": "Create roles and grant permissions, including ones this user lacks.",
};

/* ------------------------------------------------------------------ *
 * Grants and scopes
 * ------------------------------------------------------------------ */

export const scopeKind = z.enum(["global", "servers"]);
export type ScopeKind = z.infer<typeof scopeKind>;

export const grantScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("servers"), server_ids: z.array(uuid).min(1) }),
]);
export type GrantScope = z.infer<typeof grantScope>;

export const roleGrant = z.object({
  permission,
  scope: grantScope,
});
export type RoleGrant = z.infer<typeof roleGrant>;

/* ------------------------------------------------------------------ *
 * Seeded system roles
 * ------------------------------------------------------------------ */

export const SYSTEM_ROLE_SLUGS = ["owner", "operator", "developer", "auditor", "viewer"] as const;
export type SystemRoleSlug = (typeof SYSTEM_ROLE_SLUGS)[number];

const readOnly = PERMISSIONS.filter((p) => p.endsWith(":read"));

export const SYSTEM_ROLES: Record<
  SystemRoleSlug,
  { name: string; description: string; permissions: readonly Permission[] }
> = {
  owner: {
    name: "Owner",
    description: "Full control over the fleet and the panel itself. Cannot be deleted.",
    permissions: PERMISSIONS,
  },
  operator: {
    name: "Operator",
    description:
      "Runs the infrastructure day to day. Everything except panel administration and restores.",
    permissions: PERMISSIONS.filter((p) => !p.startsWith("admin.") && p !== "backups.restore:exec"),
  },
  developer: {
    name: "Developer",
    description:
      "Ships and debugs applications on scoped servers. No security, email or administration.",
    permissions: [
      "infra.servers:read",
      "infra.services:read",
      "infra.services:exec",
      "infra.processes:read",
      "infra.containers:read",
      "infra.containers:exec",
      "websites.sites:read",
      "websites.sites:write",
      "websites.domains:read",
      "websites.dns:read",
      "websites.ssl:read",
      "websites.deployments:read",
      "websites.deployments:exec",
      "files.manager:read",
      "files.manager:write",
      "databases.mysql:read",
      "databases.mysql:write",
      "databases.postgres:read",
      "databases.postgres:write",
      "monitoring.metrics:read",
      "logs.streams:read",
    ],
  },
  auditor: {
    name: "Auditor",
    description: "Reads everything, changes nothing. Includes the audit trail.",
    permissions: readOnly,
  },
  viewer: {
    name: "Viewer",
    description: "Dashboard and monitoring only.",
    permissions: [
      "infra.servers:read",
      "infra.services:read",
      "infra.containers:read",
      "monitoring.metrics:read",
      "monitoring.alerts:read",
    ],
  },
};

/* ------------------------------------------------------------------ *
 * Scoped accounts (KD-039)
 *
 * A reseller or client holds no role. What they may do is this fixed
 * list, on the servers a reseller was given, and only against
 * resources recorded as theirs. Every permission here is one whose
 * routes filter by ownership; adding one without wiring its routes
 * hands a scoped account nothing, because routes that have not opted
 * in to ownership never see these grants.
 * ------------------------------------------------------------------ */

export const SCOPED_ACCOUNT_PERMISSIONS = [
  "websites.sites:read",
  "websites.sites:write",
  "websites.sites:delete",
  "websites.domains:read",
  "websites.domains:write",
  "websites.domains:delete",
  "email.mailboxes:read",
  "email.mailboxes:write",
  "email.mailboxes:delete",
  "databases.mysql:read",
  "databases.mysql:write",
  "databases.mysql:delete",
  "databases.postgres:read",
  "databases.postgres:write",
  "databases.postgres:delete",
  // The installer opts in to ownership: installs are filtered to the
  // creator's, and what an install creates is recorded as theirs.
  "apps.installs:read",
  "apps.installs:write",
  "apps.installs:delete",
  // Only /backups/apps/* opts in to ownership: a scoped account backs up
  // and restores the app installs it owns, and no other backup route
  // ever sees these grants (KD-041).
  "backups.schedules:read",
  "backups.schedules:write",
  "backups.restore:exec",
] as const satisfies readonly Permission[];

/** The grants a scoped account holds: the fixed list, on exactly these servers. */
export function scopedAccountGrants(serverIds: readonly string[]): EffectiveGrants {
  if (serverIds.length === 0) return { map: new Map() };
  return buildEffectiveGrants(
    SCOPED_ACCOUNT_PERMISSIONS.map((permission) => ({
      permission,
      scope: { kind: "servers" as const, server_ids: [...serverIds] },
    })),
  );
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

export interface EffectiveGrants {
  /** Permission -> "global" or the set of server ids it applies to. */
  readonly map: ReadonlyMap<Permission, "global" | ReadonlySet<string>>;
}

/** Collapse a list of grants (from every role a principal holds) into one map. */
export function buildEffectiveGrants(grants: readonly RoleGrant[]): EffectiveGrants {
  const map = new Map<Permission, "global" | Set<string>>();
  for (const g of grants) {
    const existing = map.get(g.permission);
    if (existing === "global") continue;
    if (g.scope.kind === "global") {
      map.set(g.permission, "global");
      continue;
    }
    const set = existing instanceof Set ? existing : new Set<string>();
    for (const id of g.scope.server_ids) set.add(id);
    map.set(g.permission, set);
  }
  return { map };
}

/**
 * Single authority for "may this principal do this". `serverId` is required
 * for any server-scoped permission; passing undefined asks "anywhere at all",
 * which is only correct for nav visibility, never for a mutation.
 */
export function can(grants: EffectiveGrants, perm: Permission, serverId?: string | null): boolean {
  const entry = grants.map.get(perm);
  if (!entry) return false;
  if (entry === "global") return true;
  if (!serverId) return entry.size > 0;
  return entry.has(serverId);
}

/** Server ids a principal may exercise `perm` on, or "global" for all of them. */
export function scopeFor(
  grants: EffectiveGrants,
  perm: Permission,
): "global" | readonly string[] | null {
  const entry = grants.map.get(perm);
  if (!entry) return null;
  if (entry === "global") return "global";
  return [...entry];
}
