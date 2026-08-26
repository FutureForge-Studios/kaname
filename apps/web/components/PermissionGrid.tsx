"use client";

import * as React from "react";
import { Globe, ShieldAlert } from "lucide-react";
import {
  PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_GROUP_LABELS,
  type GrantScope,
  type Permission,
  type RoleGrant,
  type Server,
} from "@kaname/contract";
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  SearchInput,
  Tooltip,
  cn,
  type ComboboxOption,
} from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * The permission grid.
 *
 * Shared by the role editor and the API-key scope picker, because the
 * two must not drift: an operator who learns to read one has learned to
 * read the other, and a key whose scopes render differently from the
 * role they came from is a key nobody trusts.
 *
 * Density comes from collapsing the taxonomy one level. `PERMISSIONS`
 * is a flat list of `module.resource:action`, but nobody thinks in 68
 * checkboxes — they think "Domains: read and write". So a row is a
 * resource, its actions are inline columns, and the scope control sits
 * at the end of the row it applies to.
 *
 * Scope is per-permission in the data model and per-resource in this
 * control. A row whose granted permissions disagree renders as `Mixed`
 * and normalises on the next change rather than silently rewriting
 * something the API set.
 * ------------------------------------------------------------------ */

/** Column order. Everything destructive sits to the right of what is not. */
const ACTIONS = ["read", "write", "exec", "delete"] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_LABELS: Record<Action, string> = {
  read: "Read",
  write: "Write",
  exec: "Exec",
  delete: "Delete",
};

const MODULE_LABELS: Record<string, string> = {
  infra: "Infrastructure",
  websites: "Websites",
  files: "Files",
  email: "Email",
  databases: "Databases",
  security: "Security",
  backups: "Backups",
  monitoring: "Monitoring",
  logs: "Logs",
  terminal: "Terminal",
  admin: "Administration",
};

/**
 * Permissions worth a second look before they are granted: each one
 * either reaches a root shell, overwrites live data, or can be used to
 * grant itself more.
 */
const SENSITIVE: readonly Permission[] = [
  "terminal.session:exec",
  "backups.restore:exec",
  "infra.servers:delete",
  "admin.roles:write",
  "admin.users:write",
  "admin.api_keys:write",
  "admin.settings:write",
];

const SENSITIVE_SET = new Set<Permission>(SENSITIVE);

export interface PermissionResource {
  /** `module.resource`, e.g. `websites.dns`. */
  key: string;
  module: string;
  label: string;
  actions: { action: Action; permission: Permission; description: string | null }[];
}

export interface PermissionModuleTree {
  module: string;
  label: string;
  resources: PermissionResource[];
}

/**
 * Built from the contract rather than fetched from `/permissions`: the
 * endpoint returns this exact grouping from the same constants, so a
 * request would only add a loading state to a list that cannot change
 * without a redeploy.
 */
export const PERMISSION_TREE: readonly PermissionModuleTree[] = buildTree();

function buildTree(): PermissionModuleTree[] {
  const modules = new Map<string, PermissionModuleTree>();

  for (const permission of PERMISSIONS) {
    const [key, action] = permission.split(":") as [string, Action];
    const moduleKey = key.split(".")[0] as string;

    const module = modules.get(moduleKey) ?? {
      module: moduleKey,
      label: MODULE_LABELS[moduleKey] ?? moduleKey,
      resources: [],
    };

    const resource = module.resources.find((candidate) => candidate.key === key) ?? {
      key,
      module: moduleKey,
      label: PERMISSION_GROUP_LABELS[key] ?? key,
      actions: [],
    };
    if (!module.resources.includes(resource)) module.resources.push(resource);

    resource.actions.push({
      action,
      permission,
      description: PERMISSION_DESCRIPTIONS[permission] ?? null,
    });
    modules.set(moduleKey, module);
  }

  return [...modules.values()];
}

export function isSensitivePermission(permission: Permission): boolean {
  return SENSITIVE_SET.has(permission);
}

/* ------------------------------------------------------------------ */

export interface PermissionGridProps {
  value: readonly RoleGrant[];
  onChange: (next: RoleGrant[]) => void;
  /** Servers this principal may scope a grant to. */
  servers: readonly Server[];
  /** Off for API keys, whose scope belongs to the key rather than each grant. */
  perPermissionScope?: boolean;
  readOnly?: boolean;
  /** Permissions this principal may not delegate. Rendered disabled, with why. */
  canGrant?: (permission: Permission) => boolean;
  className?: string;
}

const EVERYWHERE = "*";

export function PermissionGrid({
  value,
  onChange,
  servers,
  perPermissionScope = true,
  readOnly = false,
  canGrant,
  className,
}: PermissionGridProps) {
  const [query, setQuery] = React.useState("");

  const granted = React.useMemo(() => {
    const map = new Map<Permission, GrantScope>();
    for (const grant of value) map.set(grant.permission, grant.scope);
    return map;
  }, [value]);

  const serverOptions = React.useMemo<ComboboxOption[]>(
    () => [
      {
        value: EVERYWHERE,
        label: "Everywhere",
        description: "The whole fleet, including servers added later",
      },
      ...servers.map((server) => ({
        value: server.id,
        label: server.name,
        description: server.hostname,
        mono: true,
      })),
    ],
    [servers],
  );

  const emit = React.useCallback(
    (next: Map<Permission, GrantScope>) => {
      // Emitted in the contract's own order so two roles with the same
      // grants always serialise identically.
      onChange(
        PERMISSIONS.filter((permission) => next.has(permission)).map((permission) => ({
          permission,
          scope: next.get(permission)!,
        })),
      );
    },
    [onChange],
  );

  const toggle = React.useCallback(
    (permission: Permission, on: boolean, scope: GrantScope) => {
      const next = new Map(granted);
      if (on) next.set(permission, scope);
      else next.delete(permission);
      emit(next);
    },
    [emit, granted],
  );

  const setResource = React.useCallback(
    (resource: PermissionResource, on: boolean) => {
      const next = new Map(granted);
      const scope = resourceScope(resource, granted) ?? { kind: "global" as const };
      for (const entry of resource.actions) {
        if (on && canGrant && !canGrant(entry.permission)) continue;
        if (on) next.set(entry.permission, scope);
        else next.delete(entry.permission);
      }
      emit(next);
    },
    [canGrant, emit, granted],
  );

  const setScope = React.useCallback(
    (resource: PermissionResource, scope: GrantScope) => {
      const next = new Map(granted);
      for (const entry of resource.actions) {
        if (next.has(entry.permission)) next.set(entry.permission, scope);
      }
      emit(next);
    },
    [emit, granted],
  );

  const setModule = React.useCallback(
    (module: PermissionModuleTree, on: boolean) => {
      const next = new Map(granted);
      for (const resource of module.resources) {
        for (const entry of resource.actions) {
          if (on && canGrant && !canGrant(entry.permission)) continue;
          if (on) next.set(entry.permission, next.get(entry.permission) ?? { kind: "global" });
          else next.delete(entry.permission);
        }
      }
      emit(next);
    },
    [canGrant, emit, granted],
  );

  const needle = query.trim().toLowerCase();
  const tree = React.useMemo(() => {
    if (needle.length === 0) return PERMISSION_TREE;
    return PERMISSION_TREE.map((module) => ({
      ...module,
      resources: module.resources.filter(
        (resource) =>
          resource.label.toLowerCase().includes(needle) ||
          resource.key.toLowerCase().includes(needle) ||
          module.label.toLowerCase().includes(needle),
      ),
    })).filter((module) => module.resources.length > 0);
  }, [needle]);

  const columns = perPermissionScope
    ? "grid-cols-[minmax(0,1fr)_repeat(4,56px)_192px]"
    : "grid-cols-[minmax(0,1fr)_repeat(4,56px)]";

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          placeholder="Filter permissions"
          aria-label="Filter permissions"
          size="sm"
          className="w-56"
        />
        <Badge tone={granted.size > 0 ? "accent" : "neutral"} size="sm">
          {granted.size} of {PERMISSIONS.length} granted
        </Badge>
        {!readOnly && granted.size > 0 && (
          <Button variant="ghost" size="xs" onClick={() => onChange([])}>
            Clear all
          </Button>
        )}
      </div>

      <div className="min-w-0 overflow-x-auto rounded-[var(--kn-r-md)] border border-[var(--kn-border)]">
        <div className="min-w-[640px]">
          <div
            className={cn(
              "grid items-center gap-x-3 border-b border-[var(--kn-border)] bg-[var(--kn-surface-2)] px-3 py-1.5",
              columns,
            )}
          >
            <span className="text-2xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
              Resource
            </span>
            {ACTIONS.map((action) => (
              <span
                key={action}
                className="text-center text-2xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]"
              >
                {ACTION_LABELS[action]}
              </span>
            ))}
            {perPermissionScope && (
              <span className="text-2xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
                Scope
              </span>
            )}
          </div>

          {tree.length === 0 && (
            <p className="px-3 py-6 text-center text-[var(--kn-text-2)]">
              No permission matches “{query}”.
            </p>
          )}

          {tree.map((module) => {
            const total = module.resources.reduce((sum, r) => sum + r.actions.length, 0);
            const held = module.resources.reduce(
              (sum, r) => sum + r.actions.filter((a) => granted.has(a.permission)).length,
              0,
            );

            return (
              <section key={module.module}>
                <div className="flex items-center justify-between gap-3 border-b border-[var(--kn-border-subtle)] bg-[var(--kn-bg-inset)] px-3 py-1.5">
                  <h3 className="font-medium text-[var(--kn-text)]">{module.label}</h3>
                  <div className="flex items-center gap-2">
                    <span className="kn-num text-xs text-[var(--kn-text-3)]">
                      {held}/{total}
                    </span>
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setModule(module, held < total)}
                      >
                        {held < total ? "Select all" : "Clear"}
                      </Button>
                    )}
                  </div>
                </div>

                {module.resources.map((resource) => (
                  <ResourceRow
                    key={resource.key}
                    resource={resource}
                    granted={granted}
                    columns={columns}
                    serverOptions={serverOptions}
                    servers={servers}
                    perPermissionScope={perPermissionScope}
                    readOnly={readOnly}
                    canGrant={canGrant}
                    onToggle={toggle}
                    onToggleResource={setResource}
                    onScopeChange={setScope}
                  />
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface ResourceRowProps {
  resource: PermissionResource;
  granted: ReadonlyMap<Permission, GrantScope>;
  columns: string;
  serverOptions: readonly ComboboxOption[];
  servers: readonly Server[];
  perPermissionScope: boolean;
  readOnly: boolean;
  canGrant?: (permission: Permission) => boolean;
  onToggle: (permission: Permission, on: boolean, scope: GrantScope) => void;
  onToggleResource: (resource: PermissionResource, on: boolean) => void;
  onScopeChange: (resource: PermissionResource, scope: GrantScope) => void;
}

function ResourceRow({
  resource,
  granted,
  columns,
  serverOptions,
  servers,
  perPermissionScope,
  readOnly,
  canGrant,
  onToggle,
  onToggleResource,
  onScopeChange,
}: ResourceRowProps) {
  const held = resource.actions.filter((entry) => granted.has(entry.permission));
  const scope = resourceScope(resource, granted);
  const mixed = held.length > 0 && scope === null;
  const anySensitive = resource.actions.some(
    (entry) => granted.has(entry.permission) && isSensitivePermission(entry.permission),
  );

  const selected = React.useMemo(() => {
    if (!scope) return [];
    return scope.kind === "global" ? [EVERYWHERE] : [...scope.server_ids];
  }, [scope]);

  return (
    <div
      className={cn(
        "grid items-center gap-x-3 border-b border-[var(--kn-border-subtle)] px-3 py-1.5 last:border-b-0",
        "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)] hover:bg-[var(--kn-surface-2)]",
        columns,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => onToggleResource(resource, held.length < resource.actions.length)}
          className={cn(
            "min-w-0 truncate text-left text-[var(--kn-text)] outline-none",
            !readOnly && "hover:text-[var(--kn-accent-400)]",
            readOnly && "cursor-default",
          )}
        >
          {resource.label}
        </button>
        {anySensitive && (
          <Tooltip content="Grants here reach a root shell, live data, or the panel's own permissions.">
            <span className="inline-flex shrink-0 text-[var(--kn-warn)]">
              <ShieldAlert size={12} aria-hidden />
            </span>
          </Tooltip>
        )}
      </div>

      {ACTIONS.map((action) => {
        const entry = resource.actions.find((candidate) => candidate.action === action);
        if (!entry) return <span key={action} aria-hidden />;

        const blocked = Boolean(canGrant && !canGrant(entry.permission));
        const checked = granted.has(entry.permission);

        return (
          <div key={action} className="flex justify-center">
            <Checkbox
              checked={checked}
              disabled={readOnly || (blocked && !checked)}
              aria-label={`${ACTION_LABELS[action]} ${resource.label}`}
              title={
                blocked && !checked
                  ? `You do not hold ${entry.permission}, so you cannot delegate it.`
                  : (entry.description ?? entry.permission)
              }
              onChange={(event) =>
                onToggle(entry.permission, event.target.checked, scope ?? { kind: "global" })
              }
            />
          </div>
        );
      })}

      {perPermissionScope &&
        (held.length === 0 ? (
          <span className="text-xs text-[var(--kn-text-3)]">—</span>
        ) : readOnly ? (
          <ScopeText scope={scope} servers={servers} mixed={mixed} />
        ) : (
          <Combobox
            multiple
            options={serverOptions}
            value={selected}
            onValueChange={(next) => {
              const explicit = next.filter((id) => id !== EVERYWHERE);
              const wantsGlobal = next.includes(EVERYWHERE) || explicit.length === 0;
              onScopeChange(
                resource,
                wantsGlobal ? { kind: "global" } : { kind: "servers", server_ids: explicit },
              );
            }}
            size="xs"
            placeholder={mixed ? "Mixed" : "Everywhere"}
            emptyMessage="No server matches that name."
            aria-label={`Scope for ${resource.label}`}
            className="w-full"
          />
        ))}
    </div>
  );
}

function ScopeText({
  scope,
  servers,
  mixed,
}: {
  scope: GrantScope | null;
  servers: readonly Server[];
  mixed: boolean;
}) {
  if (mixed || !scope) return <span className="text-xs text-[var(--kn-warn)]">Mixed</span>;
  if (scope.kind === "global") {
    return (
      <span className="flex items-center gap-1 text-xs text-[var(--kn-text-2)]">
        <Globe size={12} aria-hidden /> Everywhere
      </span>
    );
  }
  const names = scope.server_ids.map(
    (id) => servers.find((server) => server.id === id)?.name ?? id.slice(0, 8),
  );
  return (
    <span className="kn-mono truncate text-xs text-[var(--kn-text-2)]" title={names.join(", ")}>
      {names.join(", ")}
    </span>
  );
}

/** One scope for the whole resource, or null when its grants disagree. */
function resourceScope(
  resource: PermissionResource,
  granted: ReadonlyMap<Permission, GrantScope>,
): GrantScope | null {
  const scopes = resource.actions
    .map((entry) => granted.get(entry.permission))
    .filter((entry): entry is GrantScope => entry !== undefined);

  if (scopes.length === 0) return null;
  const first = scopes[0]!;
  const key = scopeKey(first);
  return scopes.every((scope) => scopeKey(scope) === key) ? first : null;
}

export function scopeKey(scope: GrantScope): string {
  return scope.kind === "global" ? "global" : `servers:${[...scope.server_ids].sort().join(",")}`;
}
