/* ------------------------------------------------------------------ *
 * @kaname/contract
 *
 * The single definition of every payload that crosses a boundary:
 * browser to control plane, and control plane to agent. The UI infers
 * its types from here; the control plane validates with the same
 * schemas at the edge; the agent's method list is generated from the
 * registry in ./agent.
 * ------------------------------------------------------------------ */

export * from "./primitives.js";
export * from "./enums.js";
export * from "./rbac.js";
export * from "./jobs.js";

export * from "./resources/fleet.js";
export * from "./resources/web.js";
export * from "./resources/files.js";
export * from "./resources/mail.js";
export * from "./resources/databases.js";
export * from "./resources/security.js";
export * from "./resources/backups.js";
export * from "./resources/platform.js";
export * from "./resources/updates.js";
export * from "./resources/setup.js";

export * as agent from "./agent/index.js";
export {
  AGENT_METHODS,
  AGENT_METHOD_NAMES,
  AGENT_PROTOCOL_VERSION,
  AGENT_SUBPROTOCOL,
  isAgentMethod,
  type AgentMethod,
  type MethodParams,
  type MethodResult,
} from "./agent/index.js";
export type {
  ContainerInfo,
  DirectoryListing,
  DiskUsage,
  FileEntry,
  LogRecord,
  LogSource,
  MetricsSample,
  ProcessInfo,
  ResolvedRecord,
  ServiceInfo,
  SystemInfo,
  ThreatObservation,
} from "./agent/payloads.js";

/* ------------------------------------------------------------------ *
 * Navigation — the product's information architecture, in one place so
 * the sidebar, the command palette and the breadcrumb trail can never
 * disagree about what exists.
 * ------------------------------------------------------------------ */

import type { Permission } from "./rbac.js";

export interface NavLeaf {
  label: string;
  href: string;
  /** Lucide icon name, resolved in the UI layer. */
  icon: string;
  permission: Permission;
  /** "g" then this key jumps here. */
  shortcut?: string;
}

export interface NavSection {
  label: string;
  icon: string;
  href?: string;
  permission: Permission;
  children?: NavLeaf[];
}

export const NAVIGATION: readonly NavSection[] = [
  { label: "Command Center", icon: "LayoutDashboard", href: "/", permission: "infra.servers:read" },
  {
    label: "Infrastructure",
    icon: "Server",
    permission: "infra.servers:read",
    children: [
      {
        label: "Servers",
        href: "/infrastructure/servers",
        icon: "Server",
        permission: "infra.servers:read",
        shortcut: "s",
      },
      {
        label: "Services",
        href: "/infrastructure/services",
        icon: "Cog",
        permission: "infra.services:read",
      },
      {
        label: "Processes",
        href: "/infrastructure/processes",
        icon: "Activity",
        permission: "infra.processes:read",
      },
      {
        label: "Containers",
        href: "/infrastructure/containers",
        icon: "Box",
        permission: "infra.containers:read",
        shortcut: "c",
      },
    ],
  },
  {
    label: "Websites",
    icon: "Globe",
    permission: "websites.sites:read",
    children: [
      {
        label: "Sites",
        href: "/websites/sites",
        icon: "Globe",
        permission: "websites.sites:read",
        shortcut: "w",
      },
      {
        label: "Domains",
        href: "/websites/domains",
        icon: "Link2",
        permission: "websites.domains:read",
        shortcut: "d",
      },
      { label: "DNS", href: "/websites/dns", icon: "Network", permission: "websites.dns:read" },
      {
        label: "SSL / TLS",
        href: "/websites/ssl",
        icon: "ShieldCheck",
        permission: "websites.ssl:read",
      },
      {
        label: "Deployments",
        href: "/websites/deployments",
        icon: "Rocket",
        permission: "websites.deployments:read",
      },
    ],
  },
  {
    label: "Files",
    icon: "Folder",
    permission: "files.manager:read",
    children: [
      {
        label: "File Manager",
        href: "/files/manager",
        icon: "Folder",
        permission: "files.manager:read",
        shortcut: "f",
      },
      {
        label: "FTP / SFTP",
        href: "/files/ftp",
        icon: "ArrowLeftRight",
        permission: "files.ftp:read",
      },
      {
        label: "Storage",
        href: "/files/storage",
        icon: "HardDrive",
        permission: "files.manager:read",
      },
    ],
  },
  {
    label: "Email",
    icon: "Mail",
    permission: "email.mailboxes:read",
    children: [
      {
        label: "Mailboxes",
        href: "/email/mailboxes",
        icon: "Mail",
        permission: "email.mailboxes:read",
        shortcut: "m",
      },
      {
        label: "Aliases",
        href: "/email/aliases",
        icon: "AtSign",
        permission: "email.routing:read",
      },
      {
        label: "Forwarders",
        href: "/email/forwarders",
        icon: "Forward",
        permission: "email.routing:read",
      },
      {
        label: "DNS Authentication",
        href: "/email/authentication",
        icon: "BadgeCheck",
        permission: "email.auth:read",
      },
      {
        label: "Mail Logs",
        href: "/email/logs",
        icon: "ScrollText",
        permission: "email.logs:read",
      },
    ],
  },
  {
    label: "Databases",
    icon: "Database",
    permission: "databases.mysql:read",
    children: [
      {
        label: "MySQL / MariaDB",
        href: "/databases/mysql",
        icon: "Database",
        permission: "databases.mysql:read",
        shortcut: "b",
      },
      {
        label: "PostgreSQL",
        href: "/databases/postgres",
        icon: "Database",
        permission: "databases.postgres:read",
      },
    ],
  },
  {
    label: "Security",
    icon: "Shield",
    permission: "security.firewall:read",
    children: [
      {
        label: "Firewall",
        href: "/security/firewall",
        icon: "Shield",
        permission: "security.firewall:read",
      },
      {
        label: "Threat Protection",
        href: "/security/threats",
        icon: "ShieldAlert",
        permission: "security.threats:read",
      },
      {
        label: "SSH Security",
        href: "/security/ssh",
        icon: "KeyRound",
        permission: "security.ssh:read",
      },
      {
        label: "Audit",
        href: "/security/audit",
        icon: "FileSearch",
        permission: "security.audit:read",
      },
    ],
  },
  { label: "Backups", icon: "Archive", href: "/backups", permission: "backups.schedules:read" },
  {
    label: "Monitoring",
    icon: "LineChart",
    href: "/monitoring",
    permission: "monitoring.metrics:read",
  },
  { label: "Logs", icon: "ScrollText", href: "/logs", permission: "logs.streams:read" },
  {
    label: "Terminal",
    icon: "SquareTerminal",
    href: "/terminal",
    permission: "terminal.session:exec",
  },
  {
    label: "Administration",
    icon: "Settings",
    permission: "admin.users:read",
    children: [
      {
        label: "Users",
        href: "/administration/users",
        icon: "Users",
        permission: "admin.users:read",
      },
      {
        label: "Roles",
        href: "/administration/roles",
        icon: "UserCog",
        permission: "admin.roles:read",
      },
      {
        label: "API",
        href: "/administration/api",
        icon: "Webhook",
        permission: "admin.api_keys:read",
      },
      {
        label: "Updates",
        href: "/administration/updates",
        icon: "ArrowUpCircle",
        permission: "admin.settings:read",
      },
      {
        label: "Settings",
        href: "/administration/settings",
        icon: "Settings",
        permission: "admin.settings:read",
      },
    ],
  },
];

/** Flattened leaves, for the command palette and breadcrumb resolution. */
export const NAV_LEAVES: readonly (NavLeaf & { section: string })[] = NAVIGATION.flatMap((s) =>
  s.children
    ? s.children.map((c) => ({ ...c, section: s.label }))
    : [{ label: s.label, href: s.href!, icon: s.icon, permission: s.permission, section: s.label }],
);
