"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Database as DatabaseIcon,
  Download,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import {
  dbPrivilege,
  type Database,
  type DbEngine,
  type DbGrant,
  type DbInstance,
  type DbUser,
  type Job,
  type Permission,
  type Server,
} from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Badge,
  Button,
  ByteSize,
  Combobox,
  ConfirmDialog,
  CopyableCode,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  FormField,
  HealthBadge,
  Input,
  MetricTile,
  MonoText,
  RelativeTime,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  type ComboboxOption,
  type DataTableColumn,
  type DataTableRowAction,
  type Tone,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { ServerPicker, useServerSelection } from "@/components/ServerPicker";
import { PageError } from "@/components/PageError";
import { ViewTabs } from "@/components/ViewTabs";
import { api } from "@/lib/api";
import {
  invalidateFamilies,
  useCan,
  useList,
  useMutationWithJob,
  useResourceMutation,
} from "@/lib/queries";
import { formatCount, formatUptime, joinMeta } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * The database section, parameterised by engine.
 *
 * MySQL/MariaDB and PostgreSQL are two nav leaves, two permission sets
 * and one screen. They render from this component rather than from two
 * files, because the moment they are two files they start drifting —
 * one grows a bulk action, the other grows a different confirmation —
 * and an operator who manages both then has to learn the page twice.
 *
 * Everything that genuinely differs between the engines is data in
 * ENGINE_META below. If a difference cannot be expressed there, it is
 * probably not a real difference.
 * ------------------------------------------------------------------ */

export type DatabaseEngineGroup = "mysql" | "postgres";

export interface EngineMeta {
  group: DatabaseEngineGroup;
  title: string;
  /** MariaDB answers to the MySQL permission set and shares this page. */
  engines: readonly DbEngine[];
  read: Permission;
  write: Permission;
  delete: Permission;
  scheme: string;
  defaultEncoding: string;
  /** MySQL identifies a user by name *and* host; Postgres does not. */
  hostPatterns: boolean;
  ownerLabel: string;
  dumpExtension: string;
}

const ENGINE_META: Record<DatabaseEngineGroup, EngineMeta> = {
  mysql: {
    group: "mysql",
    title: "MySQL / MariaDB",
    engines: ["mysql", "mariadb"],
    read: "databases.mysql:read",
    write: "databases.mysql:write",
    delete: "databases.mysql:delete",
    scheme: "mysql",
    defaultEncoding: "utf8mb4",
    hostPatterns: true,
    ownerLabel: "Owner",
    dumpExtension: "sql",
  },
  postgres: {
    group: "postgres",
    title: "PostgreSQL",
    engines: ["postgres"],
    read: "databases.postgres:read",
    write: "databases.postgres:write",
    delete: "databases.postgres:delete",
    scheme: "postgresql",
    defaultEncoding: "UTF8",
    hostPatterns: false,
    ownerLabel: "Owner role",
    dumpExtension: "sql",
  },
};

export function engineMeta(group: DatabaseEngineGroup): EngineMeta {
  return ENGINE_META[group];
}

export function engineGroupOf(engine: DbEngine): DatabaseEngineGroup {
  return engine === "postgres" ? "postgres" : "mysql";
}

export function isEngineGroup(value: string): value is DatabaseEngineGroup {
  return value === "mysql" || value === "postgres";
}

/** Placeholders only. A stored password is never read back into the panel. */
export function connectionTemplate(
  meta: EngineMeta,
  host: string,
  port: number,
  database: string,
): string {
  return `${meta.scheme}://{user}:{password}@${host}:${port}/${database || "{database}"}`;
}

const PRIVILEGE_OPTIONS: ComboboxOption[] = dbPrivilege.options.map((privilege) => ({
  value: privilege,
  label: privilege,
  mono: true,
}));

const INSTANCE_TONES: Record<DbInstance["status"], Tone> = {
  reachable: "ok",
  degraded: "warn",
  unreachable: "danger",
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const IDENTIFIER_HINT = "must start with a letter or underscore, then letters, digits, _ or -";

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\0");
}

type View = "databases" | "users";

interface GeneratedCredentials {
  username: string;
  password: string;
  host_pattern: string;
  connection_string: string;
}

interface JobsResponse {
  job: Job | null;
  jobs: Job[];
  correlation_id: string;
}

interface CreateDatabaseResponse extends JobsResponse {
  database: Database;
  credentials: GeneratedCredentials | null;
}

interface CreateDbUserResponse extends JobsResponse {
  db_user: DbUser;
  credentials: GeneratedCredentials;
}

/* ------------------------------------------------------------------ */

export interface DatabaseSectionProps {
  engine: DatabaseEngineGroup;
}

export function DatabaseSection({ engine }: DatabaseSectionProps) {
  const meta = ENGINE_META[engine];
  const router = useRouter();
  const pathname = usePathname() ?? `/databases/${engine}`;
  const searchParams = useSearchParams();
  const can = useCan();
  const client = useQueryClient();

  const selection = useServerSelection({ permission: meta.read, required: true });
  const serverId = selection.serverId;

  const instances = useList<DbInstance>(
    "db-instances",
    { server_id: serverId ?? undefined, per_page: 100, sort: "port", order: "asc" },
    { enabled: Boolean(serverId) },
  );

  const engineInstances = React.useMemo(
    () => (instances.data?.data ?? []).filter((row) => meta.engines.includes(row.engine)),
    [instances.data, meta.engines],
  );

  const requestedInstance = searchParams.get("instance_id");
  const instance =
    engineInstances.find((row) => row.id === requestedInstance) ?? engineInstances[0] ?? null;
  const instanceId = instance?.id ?? null;

  const view: View = searchParams.get("view") === "users" ? "users" : "databases";

  /* A view is a different list with different columns, so it starts on a
   * clean search, sort and page rather than inheriting the other's. */
  const viewHref = React.useCallback(
    (next: View) => {
      const params = new URLSearchParams();
      if (serverId) params.set("server_id", serverId);
      if (instanceId) params.set("instance_id", instanceId);
      if (next !== "databases") params.set("view", next);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [instanceId, pathname, serverId],
  );

  const selectInstance = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("instance_id", next);
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const state = useResourceListState({
    defaultSort: view === "users" ? { id: "username", order: "asc" } : { id: "name", order: "asc" },
    filterKeys: ["engine", "database_id"],
    extraParams: { server_id: serverId ?? undefined, instance_id: instanceId ?? undefined },
  });

  const ready = Boolean(instanceId);
  const databases = useList<Database>("databases", state.params, {
    enabled: ready && view === "databases",
  });
  const users = useList<DbUser>("db-users", state.params, {
    enabled: ready && view === "users",
  });

  /* Grant editing and the database filter need every database on the
   * instance, not the page of them the operator is looking at. */
  const allDatabases = useList<Database>(
    "databases",
    { instance_id: instanceId ?? undefined, per_page: 200, sort: "name", order: "asc" },
    { enabled: ready },
  );

  const [createDatabaseOpen, setCreateDatabaseOpen] = React.useState(false);
  const [createUserOpen, setCreateUserOpen] = React.useState(false);
  const [credentials, setCredentials] = React.useState<GeneratedCredentials | null>(null);
  const [dropping, setDropping] = React.useState<Database[] | null>(null);
  const [dumping, setDumping] = React.useState<Database | null>(null);
  const [restoring, setRestoring] = React.useState<Database | null>(null);
  const [grantsFor, setGrantsFor] = React.useState<DbUser | null>(null);
  const [rotating, setRotating] = React.useState<DbUser | null>(null);
  const [droppingUsers, setDroppingUsers] = React.useState<DbUser[] | null>(null);

  const refreshLists = React.useCallback(() => {
    invalidateFamilies(client, ["databases", "db-users", "db-instances"]);
  }, [client]);

  const sync = useResourceMutation<string, DbInstance>({
    mutationFn: (id) => api.post<DbInstance>(`/db-instances/${id}/sync`),
    invalidates: ["db-instances", "databases", "db-users"],
    successMessage: (row) => `Re-read ${row.engine} on ${row.server_name}.`,
  });

  const createDatabase = useMutationWithJob<CreateDatabaseBody>({
    mutationFn: async (body) => {
      const response = await api.post<CreateDatabaseResponse>("/databases", body);
      // The generated password exists only in this response; the row
      // itself is envelope-encrypted and cannot be read back.
      setCredentials(response.credentials);
      return response;
    },
    invalidates: ["databases", "db-users", "db-instances"],
    describe: (body) => `Create ${body.name}`,
    onQueued: () => {
      setCreateDatabaseOpen(false);
      refreshLists();
    },
  });

  const dropDatabases = useMutationWithJob<Database[]>({
    mutationFn: async (rows) => {
      const jobs: Job[] = [];
      for (const row of rows) {
        const response = await api.del<{ job: Job }>(`/databases/${row.id}`);
        jobs.push(response.job);
      }
      return { jobs, correlation_id: globalThis.crypto.randomUUID() };
    },
    invalidates: ["databases", "db-users", "db-instances"],
    describe: (rows) =>
      rows.length === 1 ? `Drop ${rows[0]!.name}` : `Drop ${rows.length} databases`,
    onQueued: () => {
      setDropping(null);
      state.setSelected([]);
      refreshLists();
    },
  });

  const dumpDatabase = useMutationWithJob<{
    database: Database;
    destination: string;
    compress: boolean;
  }>({
    mutationFn: ({ database, destination, compress }) =>
      api.post<{ job: Job }>(`/databases/${database.id}/dump`, { destination, compress }),
    invalidates: ["databases"],
    describe: ({ database }) => `Dump ${database.name}`,
    onQueued: () => setDumping(null),
  });

  const restoreDatabase = useMutationWithJob<{
    database: Database;
    source: string;
    dropExisting: boolean;
  }>({
    mutationFn: ({ database, source, dropExisting }) =>
      api.post<{ job: Job }>(`/databases/${database.id}/restore`, {
        source,
        database_name: database.name,
        confirm_name: database.name,
        drop_existing: dropExisting,
      }),
    invalidates: ["databases"],
    describe: ({ database }) => `Restore ${database.name}`,
    onQueued: () => setRestoring(null),
  });

  const createUser = useMutationWithJob<CreateUserBody>({
    mutationFn: async (body) => {
      const response = await api.post<CreateDbUserResponse>("/db-users", body);
      setCredentials(response.credentials);
      return response;
    },
    invalidates: ["db-users", "databases"],
    describe: (body) => `Create ${body.username}`,
    onQueued: () => {
      setCreateUserOpen(false);
      refreshLists();
    },
  });

  const applyGrants = useMutationWithJob<{ user: DbUser; grants: GrantDraft[] }>({
    mutationFn: ({ user, grants }) =>
      api.put<JobsResponse>(`/db-users/${user.id}/grants`, {
        grants: grants.map((grant) => ({
          database_id: grant.databaseId,
          privileges: grant.privileges,
          grant_option: grant.grantOption,
        })),
      }),
    invalidates: ["db-users", "databases"],
    describe: ({ user }) => `Apply grants for ${user.username}`,
    onQueued: () => {
      setGrantsFor(null);
      refreshLists();
    },
  });

  const rotatePassword = useMutationWithJob<{ user: DbUser; password: string }>({
    mutationFn: ({ user, password }) =>
      api.patch<JobsResponse>(`/db-users/${user.id}`, { password }),
    invalidates: ["db-users"],
    describe: ({ user }) => `Rotate password for ${user.username}`,
    onQueued: (_jobs, { user, password }) => {
      setRotating(null);
      setCredentials({
        username: user.username,
        password,
        host_pattern: user.host_pattern,
        connection_string: "",
      });
    },
  });

  const dropUsers = useMutationWithJob<DbUser[]>({
    mutationFn: async (rows) => {
      const jobs: Job[] = [];
      for (const row of rows) {
        const response = await api.del<{ job: Job }>(`/db-users/${row.id}`);
        jobs.push(response.job);
      }
      return { jobs, correlation_id: globalThis.crypto.randomUUID() };
    },
    invalidates: ["db-users", "databases"],
    describe: (rows) =>
      rows.length === 1 ? `Drop ${rows[0]!.username}` : `Drop ${rows.length} users`,
    onQueued: () => {
      setDroppingUsers(null);
      state.setSelected([]);
      refreshLists();
    },
  });

  const mayWrite = can(meta.write, serverId);
  const mayDelete = can(meta.delete, serverId);

  const newDatabase = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      disabled={!mayWrite || !instance}
      onClick={() => setCreateDatabaseOpen(true)}
    >
      New database
    </Button>
  );

  const newUser = (
    <Button
      variant="primary"
      size="sm"
      icon={UserPlus}
      disabled={!mayWrite || !instance}
      onClick={() => setCreateUserOpen(true)}
    >
      New user
    </Button>
  );

  const databaseColumns = React.useMemo<DataTableColumn<Database>[]>(
    () => [
      {
        id: "name",
        header: "Database",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-2">
            <MonoText truncate className="font-medium">
              {row.name}
            </MonoText>
            {meta.engines.length > 1 && (
              <Badge tone="neutral" size="xs" mono>
                {row.engine}
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "owner",
        header: meta.ownerLabel,
        mono: true,
        width: 140,
        hideBelow: "lg",
        accessor: (row) => row.owner ?? "—",
      },
      {
        id: "size_bytes",
        header: "Size",
        sortable: true,
        align: "right",
        width: 96,
        cell: (row) => <ByteSize bytes={row.size_bytes} />,
      },
      {
        id: "table_count",
        header: "Tables",
        sortable: true,
        align: "right",
        width: 80,
        hideBelow: "md",
        cell: (row) => <span className="kn-num">{formatCount(row.table_count)}</span>,
      },
      {
        id: "users",
        header: "Users",
        minWidth: 160,
        hideBelow: "lg",
        cell: (row) =>
          row.users.length === 0 ? (
            <span className="text-[var(--kn-text-3)]">none</span>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {row.users.slice(0, 3).map((user) => (
                <Badge
                  key={user.id}
                  tone="neutral"
                  size="xs"
                  mono
                  title={user.privileges.join(", ")}
                >
                  {user.username}
                </Badge>
              ))}
              {row.users.length > 3 && (
                <span className="kn-num text-xs text-[var(--kn-text-3)]">
                  +{row.users.length - 3}
                </span>
              )}
            </span>
          ),
      },
      {
        id: "last_backup_at",
        header: "Last backup",
        sortable: true,
        align: "right",
        width: 116,
        cell: (row) =>
          row.last_backup_at ? (
            <RelativeTime value={row.last_backup_at} />
          ) : (
            <span className="text-[var(--kn-warn)]">never</span>
          ),
      },
      {
        id: "last_synced_at",
        header: "Synced",
        align: "right",
        width: 96,
        hideBelow: "lg",
        cell: (row) => <RelativeTime value={row.last_synced_at} />,
      },
    ],
    [meta.engines.length, meta.ownerLabel],
  );

  const userColumns = React.useMemo<DataTableColumn<DbUser>[]>(
    () => [
      {
        id: "username",
        header: "User",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-2">
            <MonoText truncate className="font-medium">
              {meta.hostPatterns ? `${row.username}@${row.host_pattern}` : row.username}
            </MonoText>
            {row.is_superuser && (
              <Badge tone="warn" size="xs">
                superuser
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "can_login",
        header: "Login",
        width: 92,
        cell: (row) => (
          <StatusBadge tone={row.can_login ? "ok" : "neutral"} size="xs">
            {row.can_login ? "enabled" : "disabled"}
          </StatusBadge>
        ),
      },
      {
        id: "grants",
        header: "Grants",
        minWidth: 240,
        cell: (row) =>
          row.grants.length === 0 ? (
            <span className="text-[var(--kn-text-3)]">no databases</span>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {row.grants.slice(0, 4).map((grant) => (
                <Badge
                  key={grant.database_id}
                  tone="neutral"
                  size="xs"
                  mono
                  title={`${grant.privileges.join(", ")}${grant.grant_option ? " (with grant option)" : ""}`}
                >
                  {grant.database_name}: {summarizePrivileges(grant)}
                </Badge>
              ))}
              {row.grants.length > 4 && (
                <span className="kn-num text-xs text-[var(--kn-text-3)]">
                  +{row.grants.length - 4}
                </span>
              )}
            </span>
          ),
      },
      {
        id: "auth_plugin",
        header: "Auth",
        mono: true,
        width: 140,
        hideBelow: "lg",
        accessor: (row) => row.auth_plugin ?? "—",
      },
      {
        id: "last_used_at",
        header: "Last used",
        sortable: true,
        align: "right",
        width: 108,
        cell: (row) =>
          row.last_used_at ? (
            <RelativeTime value={row.last_used_at} />
          ) : (
            <span className="text-[var(--kn-text-3)]">never</span>
          ),
      },
    ],
    [meta.hostPatterns],
  );

  const databaseActions = React.useCallback(
    (row: Database): DataTableRowAction<Database>[] => [
      {
        id: "open",
        label: "Open",
        icon: DatabaseIcon,
        onSelect: () => router.push(`/databases/${engineGroupOf(row.engine)}/${row.id}`),
      },
      {
        id: "dump",
        label: "Dump to file",
        icon: Download,
        disabled: !can(meta.read, row.server_id),
        onSelect: () => setDumping(row),
      },
      {
        id: "restore",
        label: "Restore from file",
        icon: Upload,
        disabled: !can(meta.write, row.server_id),
        onSelect: () => setRestoring(row),
      },
      {
        id: "drop",
        label: "Drop database",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled: !can(meta.delete, row.server_id),
        onSelect: () => setDropping([row]),
      },
    ],
    [can, meta.delete, meta.read, meta.write, router],
  );

  const userActions = React.useCallback(
    (row: DbUser): DataTableRowAction<DbUser>[] => [
      {
        id: "grants",
        label: "Edit grants",
        icon: KeyRound,
        disabled: !can(meta.write, row.server_id),
        onSelect: () => setGrantsFor(row),
      },
      {
        id: "rotate",
        label: "Rotate password",
        icon: RefreshCw,
        disabled: !can(meta.write, row.server_id),
        onSelect: () => setRotating(row),
      },
      {
        id: "drop",
        label: "Drop user",
        icon: Trash2,
        destructive: true,
        separatorBefore: true,
        disabled: !can(meta.delete, row.server_id),
        onSelect: () => setDroppingUsers([row]),
      },
    ],
    [can, meta.delete, meta.write],
  );

  const tabs = (
    <ViewTabs
      label={`${meta.title} views`}
      current={view}
      tabs={[
        {
          id: "databases",
          label: "Databases",
          href: viewHref("databases"),
          icon: DatabaseIcon,
          badge: instance ? formatCount(instance.database_count) : undefined,
        },
        {
          id: "users",
          label: "Users",
          href: viewHref("users"),
          icon: Users,
          badge: instance ? formatCount(instance.user_count) : undefined,
        },
      ]}
    />
  );

  const header = (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <ServerPicker selection={selection} />
        {engineInstances.length > 1 && (
          <Combobox
            options={engineInstances.map((row) => ({
              value: row.id,
              label: `${row.engine} ${row.version}`,
              description: `${row.host}:${row.port}`,
              mono: true,
            }))}
            value={instanceId ?? ""}
            onValueChange={(next) => {
              if (next) selectInstance(next);
            }}
            aria-label="Instance"
            mono
            className="w-56"
          />
        )}
      </div>

      {instances.isError && (
        <PageError
          error={instances.error}
          onRetry={() => void instances.refetch()}
          context={`${meta.title} instances`}
        />
      )}

      {instances.isLoading && <InstanceSkeleton />}

      {!instances.isLoading && !instances.isError && !instance && (
        <SectionCard>
          <EmptyState
            icon={DatabaseIcon}
            title={`No ${meta.title} instance on this server`}
            description={
              selection.server
                ? `The agent on ${selection.server.name} reports no ${meta.engines.join(" or ")} listening. Install the engine on the host, then re-sync the server so it re-advertises its capabilities.`
                : "Pick a server that runs this engine."
            }
            size="sm"
          />
        </SectionCard>
      )}

      {instance && (
        <InstanceHeader
          instance={instance}
          server={selection.server}
          meta={meta}
          syncing={sync.isPending}
          onSync={() => sync.mutate(instance.id)}
        />
      )}

      {instance && view === "databases" && <ConnectionCard instance={instance} meta={meta} />}
    </>
  );

  const shared = {
    title: meta.title,
    subtitle: instance
      ? joinMeta(
          `${instance.engine} ${instance.version}`,
          `${instance.host}:${instance.port}`,
          instance.server_name,
        )
      : undefined,
    tabs,
    state,
    children: header,
  };

  return (
    <>
      {view === "databases" ? (
        <ResourcePage<Database>
          {...shared}
          primaryAction={newDatabase}
          query={databases}
          columns={databaseColumns}
          getRowId={(row) => row.id}
          tableLabel="Databases"
          density="compact"
          searchPlaceholder="Search databases"
          filters={
            meta.engines.length > 1 ? (
              <Select
                size="sm"
                aria-label="Engine"
                value={state.filters.engine ?? ""}
                onChange={(event) => state.setFilter("engine", event.target.value || null)}
                options={[
                  { value: "", label: "Any engine" },
                  ...meta.engines.map((value) => ({ value, label: value })),
                ]}
                boxClassName="w-32"
              />
            ) : undefined
          }
          selectable
          bulkActions={(ids) => (
            <Button
              variant="danger-subtle"
              size="xs"
              icon={Trash2}
              disabled={!mayDelete}
              onClick={() =>
                setDropping((databases.data?.data ?? []).filter((row) => ids.includes(row.id)))
              }
            >
              Drop {ids.length === 1 ? "database" : `${ids.length} databases`}
            </Button>
          )}
          rowActions={databaseActions}
          onRowClick={(row) => router.push(`/databases/${engineGroupOf(row.engine)}/${row.id}`)}
          emptyIcon={DatabaseIcon}
          emptyTitle="No databases on this instance"
          emptyDescription="A database is created with its own user and password, never on a shared superuser connection."
          emptyAction={newDatabase}
          errorContext="Databases"
        />
      ) : (
        <ResourcePage<DbUser>
          {...shared}
          primaryAction={newUser}
          query={users}
          columns={userColumns}
          getRowId={(row) => row.id}
          tableLabel="Database users"
          density="compact"
          searchPlaceholder="Search users"
          filters={
            <Combobox
              options={(allDatabases.data?.data ?? []).map((row) => ({
                value: row.id,
                label: row.name,
                mono: true,
              }))}
              value={state.filters.database_id ?? ""}
              onValueChange={(next) => state.setFilter("database_id", next)}
              placeholder="Any database"
              emptyMessage="No database matches that name."
              clearable
              loading={allDatabases.isLoading}
              mono
              aria-label="Granted on database"
              size="sm"
              className="w-48"
            />
          }
          selectable
          bulkActions={(ids) => (
            <Button
              variant="danger-subtle"
              size="xs"
              icon={Trash2}
              disabled={!mayDelete}
              onClick={() =>
                setDroppingUsers((users.data?.data ?? []).filter((row) => ids.includes(row.id)))
              }
            >
              Drop {ids.length === 1 ? "user" : `${ids.length} users`}
            </Button>
          )}
          rowActions={userActions}
          emptyIcon={Users}
          emptyTitle="No users on this instance"
          emptyDescription="Every database should have a dedicated user, granted only the databases it needs."
          emptyAction={newUser}
          errorContext="Database users"
        />
      )}

      {instance && (
        <CreateDatabaseDialog
          open={createDatabaseOpen}
          onOpenChange={setCreateDatabaseOpen}
          instance={instance}
          meta={meta}
          pending={createDatabase.isPending}
          onSubmit={(body) => createDatabase.mutate(body)}
        />
      )}

      {instance && (
        <CreateUserDialog
          open={createUserOpen}
          onOpenChange={setCreateUserOpen}
          instance={instance}
          meta={meta}
          databases={allDatabases.data?.data ?? []}
          databasesLoading={allDatabases.isLoading}
          pending={createUser.isPending}
          onSubmit={(body) => createUser.mutate(body)}
        />
      )}

      <CredentialsDialog
        credentials={credentials}
        meta={meta}
        onClose={() => setCredentials(null)}
      />

      <ConfirmDialog
        open={dropping !== null && dropping.length > 0}
        onOpenChange={(next) => !next && setDropping(null)}
        title={dropTitle(dropping?.map((row) => row.name) ?? [], "databases")}
        description={
          dropping && dropping.length > 0
            ? `Every table, row and index is destroyed on ${dropping[0]!.server_name}. Kaname cannot undo this; only a restore from a dump can.`
            : undefined
        }
        confirmText={
          dropping && dropping.length === 1
            ? dropping[0]!.name
            : `drop ${dropping?.length ?? 0} databases`
        }
        confirmLabel="Drop"
        loading={dropDatabases.isPending}
        onConfirm={() => dropping && dropDatabases.mutate(dropping)}
      >
        {dropping && dropping.length > 1 && (
          <p className="kn-mono text-[var(--kn-text-2)]">
            {dropping.map((row) => row.name).join(", ")}
          </p>
        )}
        {dropping?.some((row) => row.last_backup_at === null) && (
          <p className="mt-2 text-[var(--kn-warn)]">
            {dropping.length === 1
              ? "This database has never been backed up by Kaname."
              : "At least one of these has never been backed up by Kaname."}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={droppingUsers !== null && droppingUsers.length > 0}
        onOpenChange={(next) => !next && setDroppingUsers(null)}
        title={dropTitle(droppingUsers?.map((row) => row.username) ?? [], "users")}
        description={
          droppingUsers && droppingUsers.length > 0
            ? `Removed from ${droppingUsers[0]!.server_name}. Anything still connecting with these credentials stops working immediately.`
            : undefined
        }
        confirmText={
          droppingUsers && droppingUsers.length === 1
            ? droppingUsers[0]!.username
            : `drop ${droppingUsers?.length ?? 0} users`
        }
        confirmLabel="Drop"
        loading={dropUsers.isPending}
        onConfirm={() => droppingUsers && dropUsers.mutate(droppingUsers)}
      >
        {droppingUsers && droppingUsers.some((row) => row.grants.length > 0) && (
          <p className="text-[var(--kn-text-2)]">
            Holds grants on{" "}
            <span className="kn-mono text-[var(--kn-text)]">
              {[
                ...new Set(
                  droppingUsers.flatMap((row) => row.grants.map((grant) => grant.database_name)),
                ),
              ].join(", ")}
            </span>
            .
          </p>
        )}
      </ConfirmDialog>

      <DumpDialog
        database={dumping}
        meta={meta}
        pending={dumpDatabase.isPending}
        onClose={() => setDumping(null)}
        onSubmit={(destination, compress) => {
          if (dumping) dumpDatabase.mutate({ database: dumping, destination, compress });
        }}
      />

      <RestoreDialog
        database={restoring}
        meta={meta}
        pending={restoreDatabase.isPending}
        onClose={() => setRestoring(null)}
        onSubmit={(source, dropExisting) => {
          if (restoring) restoreDatabase.mutate({ database: restoring, source, dropExisting });
        }}
      />

      <GrantsDialog
        user={grantsFor}
        databases={allDatabases.data?.data ?? []}
        loading={allDatabases.isLoading}
        pending={applyGrants.isPending}
        onClose={() => setGrantsFor(null)}
        onSubmit={(grants) => {
          if (grantsFor) applyGrants.mutate({ user: grantsFor, grants });
        }}
      />

      <RotatePasswordDialog
        user={rotating}
        meta={meta}
        pending={rotatePassword.isPending}
        onClose={() => setRotating(null)}
        onSubmit={(password) => {
          if (rotating) rotatePassword.mutate({ user: rotating, password });
        }}
      />
    </>
  );
}

/* --------------------------- instance header ------------------------ */

function InstanceSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton
          key={index}
          className="h-16 rounded-[var(--kn-r-md)]"
          label={index === 0 ? "Loading instance" : undefined}
        />
      ))}
    </div>
  );
}

interface InstanceHeaderProps {
  instance: DbInstance;
  server: Server | null;
  meta: EngineMeta;
  syncing: boolean;
  onSync: () => void;
}

function InstanceHeader({ instance, server, meta, syncing, onSync }: InstanceHeaderProps) {
  const load =
    instance.connections !== null && instance.max_connections
      ? Math.round((instance.connections / instance.max_connections) * 100)
      : null;

  return (
    <SectionCard
      title={`${instance.engine} ${instance.version}`}
      icon={DatabaseIcon}
      description={`${instance.host}:${instance.port}`}
      actions={
        <>
          {/* Both axes, never merged: whether Kaname can reach the host,
              and whether the host is healthy. The engine being reachable
              is a third, separate fact. */}
          {server && (
            <>
              <AgentConnectionIndicator
                connection={server.connection}
                since={server.last_seen_at}
              />
              <HealthBadge
                health={server.health}
                reasons={server.health_reasons}
                since={server.latest?.sampled_at ?? null}
              />
            </>
          )}
          <StatusBadge tone={INSTANCE_TONES[instance.status]} size="sm">
            {instance.status}
          </StatusBadge>
          <span className="hidden items-center gap-1 text-xs text-[var(--kn-text-3)] md:inline-flex">
            synced <RelativeTime value={instance.last_synced_at} />
          </span>
          <Button variant="ghost" size="xs" icon={RefreshCw} loading={syncing} onClick={onSync}>
            Sync
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <MetricTile size="sm" label="Databases" value={formatCount(instance.database_count)} />
        <MetricTile size="sm" label="Users" value={formatCount(instance.user_count)} />
        <MetricTile
          size="sm"
          label="Connections"
          value={instance.connections === null ? "—" : formatCount(instance.connections)}
          unit={
            instance.max_connections ? `of ${formatCount(instance.max_connections)}` : undefined
          }
          tone={load === null ? "neutral" : load >= 90 ? "danger" : load >= 75 ? "warn" : "neutral"}
        />
        <MetricTile size="sm" label="Data size" value={<ByteSize bytes={instance.data_size} />} />
        <MetricTile size="sm" label="Uptime" value={formatUptime(instance.uptime_seconds)} />
        <MetricTile size="sm" label="Default encoding" value={meta.defaultEncoding} />
      </div>
    </SectionCard>
  );
}

function ConnectionCard({ instance, meta }: { instance: DbInstance; meta: EngineMeta }) {
  return (
    <SectionCard title="Connection" icon={KeyRound} headingLevel={3}>
      <CopyableCode
        value={connectionTemplate(meta, instance.host, instance.port, "")}
        label={`${instance.engine} on ${instance.server_name}`}
      />
      <p className="mt-2 text-[var(--kn-text-2)]">
        Passwords are envelope-encrypted the moment they are stored and are never read back into the
        panel — not here and not on a detail page. Rotate a user&apos;s password to be shown a new
        one once.
      </p>
    </SectionCard>
  );
}

/* ---------------------------- create forms -------------------------- */

interface CreateDatabaseBody {
  instance_id: string;
  engine: DbEngine;
  name: string;
  owner?: string;
  encoding?: string;
  collation?: string;
  create_user?: {
    username: string;
    password?: string;
    host_pattern: string;
    privileges: string[];
  };
}

interface CreateDatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance: DbInstance;
  meta: EngineMeta;
  pending: boolean;
  onSubmit: (body: CreateDatabaseBody) => void;
}

function CreateDatabaseDialog({
  open,
  onOpenChange,
  instance,
  meta,
  pending,
  onSubmit,
}: CreateDatabaseDialogProps) {
  const [name, setName] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [encoding, setEncoding] = React.useState("");
  const [collation, setCollation] = React.useState("");
  const [withUser, setWithUser] = React.useState(true);
  const [username, setUsername] = React.useState("");
  const [hostPattern, setHostPattern] = React.useState("localhost");
  const [privileges, setPrivileges] = React.useState<string[]>(["ALL"]);
  const [generate, setGenerate] = React.useState(true);
  const [password, setPassword] = React.useState("");

  React.useEffect(() => {
    if (open) return;
    setName("");
    setOwner("");
    setEncoding("");
    setCollation("");
    setWithUser(true);
    setUsername("");
    setHostPattern("localhost");
    setPrivileges(["ALL"]);
    setGenerate(true);
    setPassword("");
  }, [open]);

  const nameError = name.length > 0 && !IDENTIFIER.test(name) ? IDENTIFIER_HINT : undefined;
  const usernameError =
    withUser && username.length > 0 && !IDENTIFIER.test(username) ? IDENTIFIER_HINT : undefined;
  const passwordError =
    withUser && !generate && password.length > 0 && password.length < 16
      ? "at least 16 characters"
      : undefined;

  const valid =
    IDENTIFIER.test(name) &&
    (!withUser ||
      (IDENTIFIER.test(username) && privileges.length > 0 && (generate || password.length >= 16)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" dismissible={!pending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || pending) return;
          onSubmit({
            instance_id: instance.id,
            engine: instance.engine,
            name,
            ...(owner ? { owner } : {}),
            ...(encoding ? { encoding } : {}),
            ...(collation ? { collation } : {}),
            ...(withUser
              ? {
                  create_user: {
                    username,
                    host_pattern: meta.hostPatterns ? hostPattern : "localhost",
                    privileges,
                    ...(generate ? {} : { password }),
                  },
                }
              : {}),
          });
        }}
      >
        <DialogHeader
          title="New database"
          description={`${instance.engine} ${instance.version} at ${instance.host}:${instance.port} · ${instance.server_name}`}
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            <FormField label="Name" error={nameError} required>
              <Input
                data-autofocus=""
                mono
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="shop"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <FormField label={meta.ownerLabel} description="Defaults to the new user.">
                <Input
                  mono
                  value={owner}
                  onChange={(event) => setOwner(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField label="Encoding" description={`Default ${meta.defaultEncoding}.`}>
                <Input
                  mono
                  value={encoding}
                  onChange={(event) => setEncoding(event.target.value)}
                  placeholder={meta.defaultEncoding}
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              <FormField label="Collation">
                <Input
                  mono
                  value={collation}
                  onChange={(event) => setCollation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
            </div>

            <Switch
              checked={withUser}
              onChange={(event) => setWithUser(event.target.checked)}
              label="Create a dedicated user"
              description="A database born with its own credentials is never shared by accident."
            />

            {withUser && (
              <div className="flex flex-col gap-4 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] p-3">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Username" error={usernameError} required>
                    <Input
                      mono
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder={name ? `${name}_app` : "shop_app"}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </FormField>
                  {meta.hostPatterns && (
                    <FormField
                      label="Host pattern"
                      description="Part of the user's identity on MySQL."
                    >
                      <Input
                        mono
                        value={hostPattern}
                        onChange={(event) => setHostPattern(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </FormField>
                  )}
                </div>

                <FormField label="Privileges" required>
                  <Combobox
                    multiple
                    options={PRIVILEGE_OPTIONS}
                    value={privileges}
                    onValueChange={setPrivileges}
                    placeholder="Select privileges"
                    mono
                  />
                </FormField>

                <Switch
                  checked={generate}
                  onChange={(event) => setGenerate(event.target.checked)}
                  label="Generate a password"
                  description="Shown once, then stored envelope-encrypted."
                />

                {!generate && (
                  <FormField label="Password" error={passwordError} required>
                    <Input
                      type="password"
                      mono
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                    />
                  </FormField>
                )}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
            Create database
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

interface CreateUserBody {
  instance_id: string;
  username: string;
  password?: string;
  host_pattern: string;
  can_login: boolean;
  grants: { database_id: string; privileges: string[]; grant_option: boolean }[];
}

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance: DbInstance;
  meta: EngineMeta;
  databases: readonly Database[];
  databasesLoading: boolean;
  pending: boolean;
  onSubmit: (body: CreateUserBody) => void;
}

function CreateUserDialog({
  open,
  onOpenChange,
  instance,
  meta,
  databases,
  databasesLoading,
  pending,
  onSubmit,
}: CreateUserDialogProps) {
  const [username, setUsername] = React.useState("");
  const [hostPattern, setHostPattern] = React.useState("localhost");
  const [canLogin, setCanLogin] = React.useState(true);
  const [generate, setGenerate] = React.useState(true);
  const [password, setPassword] = React.useState("");
  const [grants, setGrants] = React.useState<GrantDraft[]>([]);

  React.useEffect(() => {
    if (open) return;
    setUsername("");
    setHostPattern("localhost");
    setCanLogin(true);
    setGenerate(true);
    setPassword("");
    setGrants([]);
  }, [open]);

  const usernameError =
    username.length > 0 && !IDENTIFIER.test(username) ? IDENTIFIER_HINT : undefined;
  const passwordError =
    !generate && password.length > 0 && password.length < 16 ? "at least 16 characters" : undefined;
  const valid = IDENTIFIER.test(username) && (generate || password.length >= 16);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" dismissible={!pending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || pending) return;
          onSubmit({
            instance_id: instance.id,
            username,
            host_pattern: meta.hostPatterns ? hostPattern : "localhost",
            can_login: canLogin,
            ...(generate ? {} : { password }),
            grants: grants.map((grant) => ({
              database_id: grant.databaseId,
              privileges: grant.privileges,
              grant_option: grant.grantOption,
            })),
          });
        }}
      >
        <DialogHeader
          title="New database user"
          description={`${instance.engine} ${instance.version} · ${instance.server_name}`}
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Username" error={usernameError} required>
                <Input
                  data-autofocus=""
                  mono
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </FormField>
              {meta.hostPatterns && (
                <FormField label="Host pattern" description="Part of the user's identity on MySQL.">
                  <Input
                    mono
                    value={hostPattern}
                    onChange={(event) => setHostPattern(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>
              )}
            </div>

            <Switch
              checked={canLogin}
              onChange={(event) => setCanLogin(event.target.checked)}
              label="Can log in"
            />
            <Switch
              checked={generate}
              onChange={(event) => setGenerate(event.target.checked)}
              label="Generate a password"
              description="Shown once, then stored envelope-encrypted."
            />
            {!generate && (
              <FormField label="Password" error={passwordError} required>
                <Input
                  type="password"
                  mono
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </FormField>
            )}

            <GrantEditor
              databases={databases}
              grants={grants}
              onChange={setGrants}
              loading={databasesLoading}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
            Create user
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ------------------------------ grants ------------------------------ */

export interface GrantDraft {
  databaseId: string;
  databaseName: string;
  privileges: string[];
  grantOption: boolean;
}

interface GrantEditorProps {
  databases: readonly Database[];
  grants: GrantDraft[];
  onChange: (grants: GrantDraft[]) => void;
  loading?: boolean;
}

function GrantEditor({ databases, grants, onChange, loading = false }: GrantEditorProps) {
  const available = databases.filter(
    (database) => !grants.some((grant) => grant.databaseId === database.id),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[var(--kn-text)]">Grants</span>
        <Combobox
          options={available.map((database) => ({
            value: database.id,
            label: database.name,
            mono: true,
          }))}
          value=""
          onValueChange={(next) => {
            const database = databases.find((row) => row.id === next);
            if (!database) return;
            onChange([
              ...grants,
              {
                databaseId: database.id,
                databaseName: database.name,
                privileges: ["ALL"],
                grantOption: false,
              },
            ]);
          }}
          placeholder={available.length === 0 ? "Every database granted" : "Add a database"}
          emptyMessage="No database matches that name."
          disabled={available.length === 0}
          loading={loading}
          mono
          aria-label="Add a database grant"
          size="xs"
          className="w-56"
        />
      </div>

      {grants.length === 0 ? (
        <p className="rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] px-3 py-2 text-[var(--kn-text-2)]">
          No grants. The user will exist and be able to authenticate, but reach nothing.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {grants.map((grant) => (
            <li
              key={grant.databaseId}
              className="flex flex-wrap items-center gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] p-2"
            >
              <MonoText className="w-32 shrink-0 truncate font-medium">
                {grant.databaseName}
              </MonoText>
              <Combobox
                multiple
                options={PRIVILEGE_OPTIONS}
                value={grant.privileges}
                onValueChange={(next) =>
                  onChange(
                    grants.map((row) =>
                      row.databaseId === grant.databaseId ? { ...row, privileges: next } : row,
                    ),
                  )
                }
                aria-label={`Privileges on ${grant.databaseName}`}
                placeholder="Privileges"
                mono
                size="xs"
                className="min-w-48 flex-1"
              />
              <Switch
                checked={grant.grantOption}
                onChange={(event) =>
                  onChange(
                    grants.map((row) =>
                      row.databaseId === grant.databaseId
                        ? { ...row, grantOption: event.target.checked }
                        : row,
                    ),
                  )
                }
                label="Grant option"
              />
              <Button
                variant="ghost"
                size="xs"
                icon={Trash2}
                onClick={() =>
                  onChange(grants.filter((row) => row.databaseId !== grant.databaseId))
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface GrantsDialogProps {
  user: DbUser | null;
  databases: readonly Database[];
  loading: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (grants: GrantDraft[]) => void;
}

function GrantsDialog({ user, databases, loading, pending, onClose, onSubmit }: GrantsDialogProps) {
  const [grants, setGrants] = React.useState<GrantDraft[]>([]);

  React.useEffect(() => {
    if (!user) return;
    setGrants(
      user.grants.map((grant) => ({
        databaseId: grant.database_id,
        databaseName: grant.database_name,
        privileges: [...grant.privileges],
        grantOption: grant.grant_option,
      })),
    );
  }, [user]);

  const revoked = user
    ? user.grants.filter((grant) => !grants.some((row) => row.databaseId === grant.database_id))
    : [];

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => !next && onClose()}
      size="md"
      dismissible={!pending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          onSubmit(grants);
        }}
      >
        <DialogHeader
          title={`Grants for ${user?.username ?? ""}`}
          description="This replaces the whole set. A database removed here is revoked on the host."
        />
        <DialogBody>
          <GrantEditor
            databases={databases}
            grants={grants}
            onChange={setGrants}
            loading={loading}
          />
          {revoked.length > 0 && (
            <p className="mt-3 text-[var(--kn-warn)]">
              Revoking access to{" "}
              <span className="kn-mono">
                {revoked.map((grant) => grant.database_name).join(", ")}
              </span>
              .
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            Apply grants
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* -------------------------- dump and restore ------------------------ */

function defaultDumpPath(database: Database, extension: string, compress: boolean): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `/var/backups/kaname/${database.name}-${stamp}.${extension}${compress ? ".gz" : ""}`;
}

export interface DumpDialogProps {
  database: Database | null;
  meta: EngineMeta;
  pending: boolean;
  onClose: () => void;
  onSubmit: (destination: string, compress: boolean) => void;
}

export function DumpDialog({ database, meta, pending, onClose, onSubmit }: DumpDialogProps) {
  const [compress, setCompress] = React.useState(true);
  const [destination, setDestination] = React.useState("");
  const [edited, setEdited] = React.useState(false);

  React.useEffect(() => {
    if (!database) {
      setEdited(false);
      return;
    }
    setCompress(true);
    setDestination(defaultDumpPath(database, meta.dumpExtension, true));
  }, [database, meta.dumpExtension]);

  const valid = isAbsolutePath(destination);

  return (
    <Dialog
      open={database !== null}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      dismissible={!pending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || pending) return;
          onSubmit(destination, compress);
        }}
      >
        <DialogHeader
          title={`Dump ${database?.name ?? ""}`}
          description={
            database
              ? `Written on ${database.server_name} by the agent. The panel never streams the dump through itself.`
              : undefined
          }
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            <FormField
              label="Destination path on the host"
              error={valid || destination.length === 0 ? undefined : "must be an absolute path"}
              required
            >
              <Input
                data-autofocus=""
                mono
                value={destination}
                onChange={(event) => {
                  setEdited(true);
                  setDestination(event.target.value);
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <Switch
              checked={compress}
              onChange={(event) => {
                const next = event.target.checked;
                setCompress(next);
                if (!edited && database) {
                  setDestination(defaultDumpPath(database, meta.dumpExtension, next));
                }
              }}
              label="Compress with gzip"
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
            Dump
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export interface RestoreDialogProps {
  database: Database | null;
  meta: EngineMeta;
  pending: boolean;
  onClose: () => void;
  onSubmit: (source: string, dropExisting: boolean) => void;
}

/*
 * Restore carries required inputs of its own, so the typed confirmation
 * is part of this form rather than a ConfirmDialog: the confirm button
 * has to stay disabled until the path is valid too, and a button that
 * looks armed but does nothing is worse than no confirmation at all.
 */
export function RestoreDialog({ database, meta, pending, onClose, onSubmit }: RestoreDialogProps) {
  const [source, setSource] = React.useState("");
  const [dropExisting, setDropExisting] = React.useState(false);
  const [typed, setTyped] = React.useState("");

  React.useEffect(() => {
    if (!database) return;
    setSource(defaultDumpPath(database, meta.dumpExtension, true));
    setDropExisting(false);
    setTyped("");
  }, [database, meta.dumpExtension]);

  const pathValid = isAbsolutePath(source);
  const armed = pathValid && database !== null && typed.trim() === database.name;

  return (
    <Dialog
      open={database !== null}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      dismissible={!pending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!armed || pending) return;
          onSubmit(source, dropExisting);
        }}
      >
        <DialogHeader
          title={`Restore into ${database?.name ?? ""}`}
          description={
            database
              ? `This writes over whatever is in ${database.name} on ${database.server_name} right now. Anything not in the dump is gone.`
              : undefined
          }
        />
        <DialogBody>
          <div className="flex flex-col gap-4">
            <FormField
              label="Source path on the host"
              error={pathValid || source.length === 0 ? undefined : "must be an absolute path"}
              required
            >
              <Input
                data-autofocus=""
                mono
                value={source}
                onChange={(event) => setSource(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <Switch
              checked={dropExisting}
              onChange={(event) => setDropExisting(event.target.checked)}
              label="Drop existing objects first"
              description="Leaves nothing from the current contents behind."
            />
            <FormField
              label={
                <>
                  Type <span className="kn-mono text-[var(--kn-text)]">{database?.name}</span> to
                  confirm
                </>
              }
              required
            >
              <Input
                mono
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!armed} loading={pending}>
            Restore
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ---------------------------- credentials --------------------------- */

interface RotatePasswordDialogProps {
  user: DbUser | null;
  meta: EngineMeta;
  pending: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
}

function RotatePasswordDialog({
  user,
  meta,
  pending,
  onClose,
  onSubmit,
}: RotatePasswordDialogProps) {
  const [password, setPassword] = React.useState("");

  React.useEffect(() => {
    if (!user) setPassword("");
  }, [user]);

  const valid = password.length >= 16;

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      dismissible={!pending}
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || pending) return;
          onSubmit(password);
        }}
      >
        <DialogHeader
          title={`Rotate password for ${user?.username ?? ""}`}
          description={
            user
              ? `Everything connecting as ${meta.hostPatterns ? `${user.username}@${user.host_pattern}` : user.username} keeps failing until it is given the new password.`
              : undefined
          }
        />
        <DialogBody>
          <FormField
            label="New password"
            error={password.length > 0 && !valid ? "at least 16 characters" : undefined}
            description="Shown once here, then stored envelope-encrypted."
            required
          >
            <Input
              data-autofocus=""
              type="password"
              mono
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={pending}>
            Rotate password
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

interface CredentialsDialogProps {
  credentials: GeneratedCredentials | null;
  meta: EngineMeta;
  onClose: () => void;
}

function CredentialsDialog({ credentials, meta, onClose }: CredentialsDialogProps) {
  return (
    <Dialog open={credentials !== null} onOpenChange={(next) => !next && onClose()} size="md">
      <DialogHeader
        title="Credentials — shown once"
        description="Kaname stores this password envelope-encrypted and cannot read it back. Copy it now."
      />
      <DialogBody>
        {credentials && (
          <div className="flex flex-col gap-3">
            <CopyableCode
              value={
                meta.hostPatterns
                  ? `${credentials.username}@${credentials.host_pattern}`
                  : credentials.username
              }
              label="User"
            />
            <CopyableCode value={credentials.password} label="Password" />
            {credentials.connection_string && (
              <CopyableCode value={credentials.connection_string} label="Connection string" block />
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          I have copied it
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ------------------------------ helpers ----------------------------- */

function dropTitle(names: string[], plural: string): string {
  if (names.length === 1) return `Drop ${names[0]}?`;
  return `Drop ${names.length} ${plural}?`;
}

function summarizePrivileges(grant: DbGrant): string {
  if (grant.privileges.includes("ALL")) return "ALL";
  if (grant.privileges.length <= 2) return grant.privileges.join(",");
  return `${grant.privileges.length} privileges`;
}
