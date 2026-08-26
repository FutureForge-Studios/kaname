import type { FastifyInstance } from "fastify";
import { sql, type SQL } from "@kaname/db";
import {
  searchQuery,
  type Permission,
  type SearchAction,
  type SearchResponse,
  type SearchResult,
  type SearchResultKind,
} from "@kaname/contract";
import { helpers, item, parseQuery } from "../http/plugin.js";
import { visibleServerIds } from "./_shared.js";

/* ------------------------------------------------------------------ *
 * Search — the command palette backend.
 *
 * Everything the caller may see is found in ONE round trip: a UNION ALL
 * of per-resource subqueries, each carrying its own permission scope,
 * ranked and capped per kind by a single window function. A palette that
 * issued nine queries would be slower than typing the URL.
 *
 * It also returns ACTIONS, not just destinations. "Restart nginx on
 * web-01" is the thing the operator actually wants; making them navigate
 * to a list and hunt for a row is the failure mode this replaces. Every
 * action states the permission it needs so the palette can grey out what
 * the caller cannot do — and the route that runs it re-checks anyway.
 * ------------------------------------------------------------------ */

/** Results per kind, so one crowded kind cannot bury every other. */
const PER_KIND = 5;
const MAX_ACTIONS = 8;

interface Matchers {
  exact: string;
  prefix: string;
  contains: string;
}

interface SourceSpec {
  kind: SearchResultKind;
  permission: Permission;
  /** SQL for the server column a scoped grant restricts, or null when the resource is fleet-wide. */
  scopeColumn: string | null;
  from: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  serverId: string;
  serverName: string;
  icon: string;
  /** Extra column the action builder needs, e.g. a server's capabilities. */
  context: string;
  search: string[];
  rankOn: string;
  filter?: string;
}

/*
 * Every fragment below is a module constant. No part of a user's query
 * ever reaches sql.raw — the search term is always a bound parameter.
 */
const SOURCES: readonly SourceSpec[] = [
  {
    kind: "server",
    permission: "infra.servers:read",
    scopeColumn: "s.id",
    from: "servers s",
    id: "s.id",
    title: "s.name",
    subtitle: "s.hostname || ' · ' || s.connection",
    href: "'/infrastructure/servers/' || s.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Server",
    context: "array_to_string(s.capabilities, ',')",
    search: ["s.name", "s.hostname"],
    rankOn: "s.name",
  },
  {
    kind: "site",
    permission: "websites.sites:read",
    scopeColumn: "s.id",
    from: "sites si join servers s on s.id = si.server_id",
    id: "si.id",
    title: "si.name",
    subtitle: "si.runtime || ' · ' || si.webroot",
    href: "'/websites/sites/' || si.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Globe",
    context: "si.status",
    search: ["si.name", "si.webroot"],
    rankOn: "si.name",
  },
  {
    kind: "domain",
    permission: "websites.domains:read",
    scopeColumn: "s.id",
    from: "domains d left join servers s on s.id = d.server_id",
    id: "d.id",
    title: "d.name",
    subtitle: "d.status || ' · ' || d.dns_provider",
    href: "'/websites/domains/' || d.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Link2",
    context: "d.status",
    search: ["d.name"],
    rankOn: "d.name",
  },
  {
    kind: "mailbox",
    permission: "email.mailboxes:read",
    scopeColumn: "s.id",
    from: "mailboxes mb join servers s on s.id = mb.server_id",
    id: "mb.id",
    title: "mb.address",
    subtitle: "mb.status || coalesce(' · ' || mb.display_name, '')",
    href: "'/email/mailboxes/' || mb.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Mail",
    context: "mb.status",
    search: ["mb.address", "mb.display_name"],
    rankOn: "mb.address",
  },
  {
    kind: "database",
    permission: "databases.mysql:read",
    scopeColumn: "s.id",
    from: "db_databases dd join servers s on s.id = dd.server_id",
    id: "dd.id",
    title: "dd.name",
    subtitle: "dd.engine || ' · ' || dd.table_count::text || ' tables'",
    href: "'/databases/mysql/' || dd.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Database",
    context: "dd.engine",
    search: ["dd.name"],
    rankOn: "dd.name",
    filter: "dd.engine in ('mysql', 'mariadb')",
  },
  {
    kind: "database",
    permission: "databases.postgres:read",
    scopeColumn: "s.id",
    from: "db_databases dd join servers s on s.id = dd.server_id",
    id: "dd.id",
    title: "dd.name",
    subtitle: "dd.engine || ' · ' || dd.table_count::text || ' tables'",
    href: "'/databases/postgres/' || dd.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Database",
    context: "dd.engine",
    search: ["dd.name"],
    rankOn: "dd.name",
    filter: "dd.engine = 'postgres'",
  },
  {
    kind: "container",
    permission: "infra.containers:read",
    scopeColumn: "s.id",
    from: "containers c join servers s on s.id = c.server_id",
    id: "c.id",
    title: "c.name",
    subtitle: "c.image || ' · ' || c.state",
    href: "'/infrastructure/containers/' || c.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Box",
    context: "c.state",
    search: ["c.name", "c.image"],
    rankOn: "c.name",
  },
  {
    kind: "service",
    permission: "infra.services:read",
    scopeColumn: "s.id",
    from: "services sv join servers s on s.id = sv.server_id",
    id: "sv.id",
    title: "sv.unit",
    subtitle: "sv.active_state || coalesce(' · ' || nullif(sv.description, ''), '')",
    href: "'/infrastructure/services/' || sv.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "Cog",
    context: "sv.active_state",
    search: ["sv.unit", "sv.description"],
    rankOn: "sv.unit",
  },
  {
    kind: "job",
    permission: "infra.servers:read",
    scopeColumn: "s.id",
    from: "jobs j left join servers s on s.id = j.server_id",
    id: "j.id",
    title: "j.type",
    subtitle: "j.status || coalesce(' · ' || nullif(j.target_label, ''), '')",
    href: "'/jobs/' || j.id::text",
    serverId: "s.id",
    serverName: "s.name",
    icon: "ListChecks",
    context: "j.status",
    search: ["j.type", "j.target_label"],
    rankOn: "j.type",
  },
  {
    kind: "user",
    permission: "admin.users:read",
    scopeColumn: null,
    from: "users u",
    id: "u.id",
    title: "u.name",
    subtitle: "u.email || ' · ' || u.status",
    href: "'/administration/users/' || u.id::text",
    serverId: "null",
    serverName: "null",
    icon: "Users",
    context: "u.status",
    search: ["u.name", "u.email"],
    rankOn: "u.name",
  },
];

const GROUP_ORDER: readonly SearchResultKind[] = [
  "server",
  "site",
  "domain",
  "mailbox",
  "database",
  "container",
  "service",
  "job",
  "user",
  "file",
  "action",
];

const GROUP_LABELS: Record<SearchResultKind, string> = {
  server: "Servers",
  site: "Sites",
  domain: "Domains",
  mailbox: "Mailboxes",
  database: "Databases",
  container: "Containers",
  service: "Services",
  file: "Files",
  job: "Jobs",
  user: "Users",
  action: "Actions",
};

interface SearchRow extends SearchResult {
  /** Carried for the action builder only; never returned to the client. */
  server_id: string | null;
  context: string | null;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/search", async (req, reply) => {
    const q = parseQuery(req, searchQuery);
    // The palette belongs to the app shell, exactly like the Command
    // Center it sits above; each subquery below is separately scoped.
    helpers(req).authorize("infra.servers:read");

    const term = q.q.trim().toLowerCase();
    const escaped = escapeLike(term);
    const matchers: Matchers = {
      exact: term,
      prefix: `${escaped}%`,
      contains: `%${escaped}%`,
    };

    const parts: SQL[] = [];
    for (const source of SOURCES) {
      if (q.kind && q.kind !== source.kind) continue;
      const scope = visibleServerIds(req, source.permission);
      if (scope !== "global" && scope.length === 0) continue;
      parts.push(subquery(source, scope, matchers));
    }

    if (parts.length === 0) {
      return item(reply, { groups: [], actions: [] } satisfies SearchResponse);
    }

    const result = await req.ctx.db.execute(sql`
      select kind, id, title, subtitle, href, server_id, server_name, icon, context, score
      from (
        select r.*,
               row_number() over (
                 partition by r.kind
                 order by r.score desc, length(r.title), r.title
               ) as rn
        from (${sql.join(parts, sql` union all `)}) r
      ) ranked
      where rn <= ${sql.raw(String(PER_KIND))}
      order by score desc, length(title), title
      limit ${sql.raw(String(q.limit))}
    `);

    const rows = resultRows(result).map(toRow);
    const groups = GROUP_ORDER.flatMap((kind) => {
      const results = rows.filter((r) => r.kind === kind);
      return results.length === 0
        ? []
        : [{ kind, label: GROUP_LABELS[kind], results: results.map(toResult) }];
    });

    const response: SearchResponse = { groups, actions: buildActions(rows) };
    return item(reply, response);
  });
}

/* ------------------------------------------------------------------ */

function subquery(source: SourceSpec, scope: "global" | readonly string[], m: Matchers): SQL {
  const conditions: SQL[] = [matches(source.search, m)];
  if (source.filter) conditions.push(sql`(${sql.raw(source.filter)})`);
  if (source.scopeColumn) conditions.push(scopeClause(source.scopeColumn, scope));

  return sql`
    select ${source.kind}::text as kind,
           (${sql.raw(source.id)})::text as id,
           (${sql.raw(source.title)})::text as title,
           (${sql.raw(source.subtitle)})::text as subtitle,
           (${sql.raw(source.href)})::text as href,
           (${sql.raw(source.serverId)})::text as server_id,
           (${sql.raw(source.serverName)})::text as server_name,
           ${source.icon}::text as icon,
           (${sql.raw(source.context)})::text as context,
           ${rank(source.rankOn, m)} as score
    from ${sql.raw(source.from)}
    where ${sql.join(conditions, sql` and `)}
  `;
}

/** An exact hit beats a prefix hit beats a substring hit. */
function rank(column: string, m: Matchers): SQL {
  const target = sql.raw(column);
  return sql`(case
    when lower(${target}) = ${m.exact} then 1.0
    when lower(${target}) like ${m.prefix} then 0.9
    else 0.6
  end)::float8`;
}

function matches(columns: string[], m: Matchers): SQL {
  return sql`(${sql.join(
    columns.map((c) => sql`lower(${sql.raw(c)}) like ${m.contains}`),
    sql` or `,
  )})`;
}

function scopeClause(column: string, scope: "global" | readonly string[]): SQL {
  if (scope === "global") return sql`true`;
  return sql`${sql.raw(column)} in (${sql.join(
    scope.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/**
 * The whole point of a palette is to do the thing, not to find the page
 * that does the thing. Actions carry their permission so the UI can grey
 * out what this caller cannot run; the endpoint behind each one checks
 * again, because a hidden button is not a security control.
 */
function buildActions(rows: SearchRow[]): SearchAction[] {
  const actions: SearchAction[] = [];
  const seen = new Set<string>();

  const push = (action: SearchAction): void => {
    if (seen.has(action.id) || actions.length >= MAX_ACTIONS) return;
    seen.add(action.id);
    actions.push(action);
  };

  for (const row of rows) {
    if (actions.length >= MAX_ACTIONS) break;

    switch (row.kind) {
      case "server": {
        const capabilities = (row.context ?? "").split(",").filter(Boolean);
        const webServer = capabilities.find(
          (c) => c === "nginx" || c === "apache" || c === "caddy",
        );
        if (webServer) {
          push({
            id: `services.restart:${row.id}:${webServer}`,
            label: `Restart ${webServer} on ${row.title}`,
            hint: "Reloads the web server as a tracked job",
            permission: "infra.services:exec",
            action: "services.restart",
            href: `/infrastructure/services?server_id=${row.id}&unit=${webServer}`,
          });
        }
        push({
          id: `terminal.open:${row.id}`,
          label: `Open terminal on ${row.title}`,
          hint: "Recorded and audited root shell",
          permission: "terminal.session:exec",
          action: "terminal.open",
          href: `/terminal?server_id=${row.id}`,
        });
        push({
          id: `logs.view:${row.id}`,
          label: `View logs for ${row.title}`,
          hint: "Live tail with server-side filtering",
          permission: "logs.streams:read",
          href: `/logs?server_id=${row.id}`,
        });
        break;
      }

      case "service":
        push({
          id: `services.restart:${row.id}`,
          label: `Restart ${row.title}${row.server_name ? ` on ${row.server_name}` : ""}`,
          hint: "Queues a restart job and follows it",
          permission: "infra.services:exec",
          action: "services.restart",
          href: row.href,
        });
        break;

      case "domain":
        push({
          id: `certificates.issue:${row.id}`,
          label: `Issue certificate for ${row.title}`,
          hint: "Requests a certificate over ACME",
          permission: "websites.ssl:write",
          action: "certificates.issue",
          href: `/websites/ssl?domain_id=${row.id}`,
        });
        push({
          id: `mail.auth.check:${row.id}`,
          label: `Check mail DNS for ${row.title}`,
          hint: "MX, SPF, DKIM, DMARC, PTR and proxy exposure",
          permission: "email.auth:exec",
          action: "mail.auth.check",
          href: `/email/authentication?domain_id=${row.id}`,
        });
        break;

      case "container":
        push({
          id: `containers.restart:${row.id}`,
          label: `Restart ${row.title}${row.server_name ? ` on ${row.server_name}` : ""}`,
          hint: "Queues a container restart job",
          permission: "infra.containers:exec",
          action: "containers.restart",
          href: row.href,
        });
        break;

      case "site":
        push({
          id: `deployments.run:${row.id}`,
          label: `Deploy ${row.title}`,
          hint: "Runs the site's configured deployment",
          permission: "websites.deployments:exec",
          action: "deployments.run",
          href: `/websites/deployments?site_id=${row.id}`,
        });
        break;

      default:
        break;
    }
  }

  return actions;
}

/**
 * A term is a LIKE pattern, so an operator typing `%` or `_` must match
 * those characters rather than everything in the fleet.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toRow(raw: Record<string, unknown>): SearchRow {
  return {
    kind: String(raw.kind) as SearchResultKind,
    id: String(raw.id),
    title: String(raw.title ?? ""),
    subtitle: String(raw.subtitle ?? ""),
    href: String(raw.href ?? ""),
    server_id: raw.server_id === null || raw.server_id === undefined ? null : String(raw.server_id),
    server_name:
      raw.server_name === null || raw.server_name === undefined ? null : String(raw.server_name),
    icon: String(raw.icon ?? "Circle"),
    context: raw.context === null || raw.context === undefined ? null : String(raw.context),
    score: Number(raw.score ?? 0),
  };
}

function toResult(row: SearchRow): SearchResult {
  return {
    kind: row.kind,
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    href: row.href,
    server_name: row.server_name,
    icon: row.icon,
    score: row.score,
  };
}

/* Drizzle's execute() returns a driver-shaped result; normalise it. */
function resultRows(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown[] })?.rows ?? (result as unknown[]);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}
