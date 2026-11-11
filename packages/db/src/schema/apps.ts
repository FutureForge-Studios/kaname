import { boolean, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type {
  AppInstallStatus,
  AppInstallStepId,
  AppInstallStepStatus,
  DbEngine,
} from "@kaname/contract";
import { pk, timestamps } from "./common";
import { servers } from "./fleet";
import { users } from "./identity";
import { jobs } from "./platform";
import { certificates, domains, sites } from "./web";
import { dbDatabases, dbUsers } from "./databases";

/* ------------------------------------------------------------------ *
 * App installs — the one-click installer's record.
 *
 * One row per app put on a host from the catalog. It is the install's
 * memory: which step it reached, and which site, database, user and
 * certificate it created, so a run that was cut off resumes instead of
 * starting again and a failure can undo exactly what this install made
 * and nothing else.
 *
 * The linked resources are ordinary rows in their own modules; this
 * table only points at them. Deleting one of them elsewhere nulls the
 * pointer rather than taking the install with it.
 * ------------------------------------------------------------------ */

/** One provisioning step as stored; titles are re-read from the recipe. */
export interface AppInstallStepState {
  id: AppInstallStepId;
  status: AppInstallStepStatus;
  message: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * What the job needs to remember between steps and across a resume.
 * `*_attempted` is written before the agent is asked to create
 * something and `*_created` once it has, which is how a rollback tells
 * "ours, remove it" from "was already on the host, leave it alone".
 */
export interface AppInstallResources {
  site_name?: string;
  deploy_root?: string;
  webroot?: string;
  release?: string;
  release_path?: string;
  commit_sha?: string | null;
  database?: string;
  db_user?: string;
  db_host_pattern?: string;
  /** The domain row existed before this install, so it is detached, not deleted. */
  domain_preexisting?: boolean;
  database_attempted?: boolean;
  database_created?: boolean;
  db_user_attempted?: boolean;
  db_user_created?: boolean;
  files_attempted?: boolean;
  files_created?: boolean;
  site_attempted?: boolean;
  site_created?: boolean;
  certificate_attempted?: boolean;
  certificate_issued?: boolean;
}

export interface AppInstallInputs {
  admin_email: string;
  system_user: string;
  php_version: string | null;
}

export const appInstalls = pgTable(
  "app_installs",
  {
    id: pk(),
    appId: text("app_id").notNull(),
    appName: text("app_name").notNull(),
    appVersion: text("app_version").notNull(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status").$type<AppInstallStatus>().notNull().default("queued"),
    ssl: boolean("ssl").notNull().default(true),
    dbEngine: text("db_engine").$type<DbEngine>(),
    /** What the person chose. Never a credential: those live in `secrets`. */
    inputs: jsonb("inputs").$type<AppInstallInputs>().notNull(),

    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "set null" }),
    databaseId: uuid("database_id").references(() => dbDatabases.id, { onDelete: "set null" }),
    dbUserId: uuid("db_user_id").references(() => dbUsers.id, { onDelete: "set null" }),
    certificateId: uuid("certificate_id").references(() => certificates.id, {
      onDelete: "set null",
    }),

    steps: jsonb("steps").$type<AppInstallStepState[]>().notNull().default([]),
    resources: jsonb("resources").$type<AppInstallResources>().notNull().default({}),
    error: jsonb("error").$type<{ code: string; message: string } | null>(),

    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name"),
    ...timestamps,
  },
  (t) => [
    index("app_installs_server_idx").on(t.serverId),
    index("app_installs_domain_idx").on(t.domain),
    index("app_installs_created_by_idx").on(t.createdBy),
  ],
);
