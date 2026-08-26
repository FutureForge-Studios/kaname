"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil, Plus, Trash2, UserCog, Users } from "lucide-react";
import type { Role } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  MonoText,
  RelativeTime,
  Select,
  type DataTableColumn,
} from "@kaname/ui";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useCan, useList, useResourceMutation } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Roles.
 *
 * The list is deliberately thin: what a role actually permits is a
 * matrix, and a matrix does not fit in a table cell. So this page
 * answers "which roles exist and who holds them", and the editor
 * answers "what can this role do".
 *
 * System roles are reconciled from the release on every boot, so they
 * render locked rather than editable-then-reverted.
 * ------------------------------------------------------------------ */

export default function RolesPage() {
  const router = useRouter();
  const can = useCan();
  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["is_system"],
  });
  const query = useList<Role>("roles", state.params);

  const [deleting, setDeleting] = React.useState<Role | null>(null);
  const [bulkDeleting, setBulkDeleting] = React.useState<string[] | null>(null);

  /* A count is what the operator is actually confirming here, so it is
   * what they have to type. */
  const bulkPhrase = `delete ${bulkDeleting?.length ?? 0} roles`;

  const remove = useResourceMutation<Role, void>({
    mutationFn: (role) => api.del(`/roles/${role.id}`),
    invalidates: ["roles"],
    successMessage: (_result, role) => `Role "${role.name}" deleted.`,
    onDone: () => setDeleting(null),
  });

  const removeMany = useResourceMutation<string[], unknown>({
    mutationFn: (ids) => Promise.all(ids.map((id) => api.del(`/roles/${id}`))),
    invalidates: ["roles"],
    successMessage: (_result, ids) => `${formatCount(ids.length)} roles deleted.`,
    onDone: () => {
      setBulkDeleting(null);
      state.setSelected([]);
    },
  });

  const columns = React.useMemo<DataTableColumn<Role>[]>(
    () => [
      {
        id: "name",
        header: "Role",
        locked: true,
        sortable: true,
        minWidth: 180,
        cell: (role) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-[var(--kn-text)]">{role.name}</span>
            {role.is_system && (
              <Badge tone="neutral" size="xs" icon={Lock}>
                system
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "slug",
        header: "Slug",
        width: 140,
        mono: true,
        sortable: true,
        hideBelow: "md",
        accessor: (role) => role.slug,
      },
      {
        id: "description",
        header: "Description",
        minWidth: 260,
        cell: (role) => (
          <span className="truncate text-[var(--kn-text-2)]" title={role.description}>
            {role.description || "—"}
          </span>
        ),
      },
      {
        id: "grants",
        header: "Permissions",
        width: 112,
        align: "right",
        cell: (role) => (
          <span className="kn-num">
            {formatCount(role.grants.length)}
            {role.grants.some((grant) => grant.scope.kind === "servers") && (
              <MonoText muted className="ml-1.5 text-xs">
                scoped
              </MonoText>
            )}
          </span>
        ),
      },
      {
        id: "user_count",
        header: "Users",
        width: 88,
        align: "right",
        cell: (role) => <span className="kn-num">{formatCount(role.user_count)}</span>,
      },
      {
        id: "updated_at",
        header: "Updated",
        width: 112,
        align: "right",
        sortable: true,
        cell: (role) => <RelativeTime value={role.updated_at} />,
      },
    ],
    [],
  );

  const newRoleButton = can("admin.roles:write") && (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => router.push("/administration/roles/new")}
    >
      New role
    </Button>
  );

  return (
    <>
      <ResourcePage<Role>
        title="Roles"
        state={state}
        query={query}
        columns={columns}
        getRowId={(role) => role.id}
        tableLabel="Roles"
        searchPlaceholder="Search roles"
        selectable
        isRowSelectable={(role) => !role.is_system}
        onRowClick={(role) => router.push(`/administration/roles/${role.id}`)}
        errorContext="Roles"
        emptyIcon={UserCog}
        emptyTitle="No roles match"
        emptyDescription="A role is a set of permissions, each scoped either to the whole fleet or to named servers."
        primaryAction={newRoleButton}
        emptyAction={newRoleButton}
        filters={
          <Select
            size="sm"
            boxClassName="w-40"
            aria-label="Filter by kind"
            value={state.filters.is_system ?? ""}
            onChange={(event) => state.setFilter("is_system", event.target.value || null)}
            options={[
              { value: "", label: "System and custom" },
              { value: "true", label: "System roles" },
              { value: "false", label: "Custom roles" },
            ]}
          />
        }
        rowActions={(role) => [
          {
            id: "open",
            label: role.is_system ? "View permissions" : "Edit permissions",
            icon: Pencil,
            onSelect: () => router.push(`/administration/roles/${role.id}`),
          },
          {
            id: "users",
            label: "Users with this role",
            icon: Users,
            onSelect: () => router.push(`/administration/users?role=${role.slug}`),
          },
          {
            id: "delete",
            label: "Delete",
            icon: Trash2,
            destructive: true,
            separatorBefore: true,
            disabled: role.is_system || !can("admin.roles:delete"),
            onSelect: () => setDeleting(role),
          },
        ]}
        bulkActions={(ids) => (
          <Button
            variant="danger-subtle"
            size="xs"
            icon={Trash2}
            disabled={!can("admin.roles:delete")}
            onClick={() => setBulkDeleting(ids)}
          >
            Delete
          </Button>
        )}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "role"}?`}
        description={
          deleting && deleting.user_count > 0
            ? `${formatCount(deleting.user_count)} user(s) still hold this role and would lose its permissions.`
            : "Nobody holds this role, so nothing loses access."
        }
        confirmText={deleting?.slug}
        confirmLabel="Delete role"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />

      <ConfirmDialog
        open={bulkDeleting !== null}
        onOpenChange={(open) => !open && setBulkDeleting(null)}
        title={`Delete ${formatCount(bulkDeleting?.length ?? 0)} roles?`}
        description="Any user still holding one of them loses its permissions on their next request. System roles are never affected."
        confirmText={bulkPhrase}
        confirmLabel="Delete roles"
        loading={removeMany.isPending}
        onConfirm={() => bulkDeleting && removeMany.mutate(bulkDeleting)}
      />
    </>
  );
}
