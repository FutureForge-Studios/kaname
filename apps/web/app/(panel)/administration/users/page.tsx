"use client";

import * as React from "react";
import {
  CircleCheck,
  CircleSlash,
  KeyRound,
  Mail,
  Pencil,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import type { Role, User } from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  CopyableCode,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  FormField,
  Input,
  MonoText,
  RelativeTime,
  Select,
  StatusBadge,
  Switch,
  Tag,
  type DataTableColumn,
  type Tone,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { ResourcePage, useResourceListState } from "@/components/ResourcePage";
import { api, type ApiError } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useCan, useList, useResourceMutation, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Users.
 *
 * Accounts are invited, never created with a password somebody else has
 * seen, so the create flow ends in a single-use link rather than in a
 * credential. The link is shown exactly once, for the same reason an
 * API token is.
 *
 * Suspension and deletion both refuse to remove the last active owner —
 * the control plane enforces that, and its message says why, so this
 * page does not try to guess the rule a second time.
 * ------------------------------------------------------------------ */

const STATUS_TONES: Record<User["status"], Tone> = {
  active: "ok",
  invited: "info",
  suspended: "danger",
};

type InvitedUser = User & { invite: { url: string; expires_at: string } };

export default function UsersPage() {
  const can = useCan();
  const { session } = useSession();
  const state = useResourceListState({
    defaultSort: { id: "name", order: "asc" },
    filterKeys: ["status", "role", "totp_enabled"],
  });
  const query = useList<User>("users", state.params);
  const roles = useList<Role>("roles", { per_page: 200, sort: "name", order: "asc" });

  const [inviting, setInviting] = React.useState(false);
  const [invited, setInvited] = React.useState<InvitedUser | null>(null);
  const [editing, setEditing] = React.useState<User | null>(null);
  const [deleting, setDeleting] = React.useState<User | null>(null);

  const setStatus = useResourceMutation<{ ids: string[]; suspend: boolean }, unknown>({
    mutationFn: ({ ids, suspend }) =>
      Promise.all(ids.map((id) => api.post(`/users/${id}/${suspend ? "suspend" : "activate"}`))),
    invalidates: ["users"],
    successMessage: (_result, { ids, suspend }) =>
      `${formatCount(ids.length)} account${ids.length === 1 ? "" : "s"} ${suspend ? "suspended" : "activated"}.`,
    onDone: () => state.setSelected([]),
  });

  const remove = useResourceMutation<User, void>({
    mutationFn: (user) => api.del(`/users/${user.id}`),
    invalidates: ["users"],
    successMessage: (_result, user) => `${user.email} deleted.`,
    onDone: () => setDeleting(null),
  });

  const columns = React.useMemo<DataTableColumn<User>[]>(
    () => [
      {
        id: "name",
        header: "User",
        locked: true,
        sortable: true,
        minWidth: 200,
        cell: (user) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">
              {user.name}
              {session?.user?.id === user.id && (
                <span className="ml-1.5 text-xs text-[var(--kn-text-3)]">you</span>
              )}
            </span>
            <MonoText muted truncate className="text-sm">
              {user.email}
            </MonoText>
          </div>
        ),
      },
      {
        id: "roles",
        header: "Roles",
        minWidth: 200,
        cell: (user) => (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {user.roles.length === 0 ? (
              <span className="text-[var(--kn-warn)]">no role</span>
            ) : (
              user.roles.map((role) => (
                <Tag key={role.id} size="xs">
                  {role.name}
                </Tag>
              ))
            )}
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 104,
        sortable: true,
        cell: (user) => (
          <StatusBadge tone={STATUS_TONES[user.status]} size="sm">
            {user.status}
          </StatusBadge>
        ),
      },
      {
        id: "totp",
        header: "TOTP",
        width: 88,
        cell: (user) =>
          user.totp_enabled ? (
            <Badge tone="ok" size="xs" icon={KeyRound}>
              on
            </Badge>
          ) : (
            <Badge tone="warn" size="xs">
              off
            </Badge>
          ),
      },
      {
        id: "last_login_at",
        header: "Last sign-in",
        width: 160,
        align: "right",
        sortable: true,
        cell: (user) => (
          <div className="flex flex-col items-end">
            <RelativeTime value={user.last_login_at} fallback="never" />
            {user.last_login_ip && (
              <MonoText muted className="text-xs">
                {user.last_login_ip}
              </MonoText>
            )}
          </div>
        ),
      },
    ],
    [session?.user?.id],
  );

  const inviteButton = can("admin.users:write") && (
    <Button variant="primary" size="sm" icon={UserPlus} onClick={() => setInviting(true)}>
      Invite user
    </Button>
  );

  return (
    <>
      <ResourcePage<User>
        title="Users"
        state={state}
        query={query}
        columns={columns}
        getRowId={(user) => user.id}
        tableLabel="Users"
        searchPlaceholder="Search name or email"
        selectable
        onRowClick={(user) => can("admin.users:write") && setEditing(user)}
        errorContext="Users"
        emptyIcon={Users}
        emptyTitle="No users match"
        emptyDescription="Every account that can sign in to this panel is listed here."
        primaryAction={inviteButton}
        emptyAction={inviteButton}
        filters={
          <>
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by status"
              value={state.filters.status ?? ""}
              onChange={(event) => state.setFilter("status", event.target.value || null)}
              options={[
                { value: "", label: "Any status" },
                { value: "active", label: "Active" },
                { value: "invited", label: "Invited" },
                { value: "suspended", label: "Suspended" },
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by role"
              value={state.filters.role ?? ""}
              onChange={(event) => state.setFilter("role", event.target.value || null)}
              options={[
                { value: "", label: "Any role" },
                ...(roles.data?.data ?? []).map((role) => ({
                  value: role.slug,
                  label: role.name,
                })),
              ]}
            />
            <Select
              size="sm"
              boxClassName="w-40"
              aria-label="Filter by two-factor"
              value={state.filters.totp_enabled ?? ""}
              onChange={(event) => state.setFilter("totp_enabled", event.target.value || null)}
              options={[
                { value: "", label: "TOTP on or off" },
                { value: "true", label: "TOTP enabled" },
                { value: "false", label: "TOTP disabled" },
              ]}
            />
          </>
        }
        rowActions={(user) => [
          {
            id: "edit",
            label: "Edit",
            icon: Pencil,
            disabled: !can("admin.users:write"),
            onSelect: () => setEditing(user),
          },
          {
            id: "status",
            label: user.status === "suspended" ? "Activate" : "Suspend",
            icon: user.status === "suspended" ? CircleCheck : CircleSlash,
            disabled: !can("admin.users:write"),
            onSelect: () =>
              setStatus.mutate({ ids: [user.id], suspend: user.status !== "suspended" }),
          },
          {
            id: "delete",
            label: "Delete",
            icon: Trash2,
            destructive: true,
            separatorBefore: true,
            disabled: !can("admin.users:delete") || session?.user?.id === user.id,
            onSelect: () => setDeleting(user),
          },
        ]}
        bulkActions={(ids) => (
          <>
            <Button
              variant="secondary"
              size="xs"
              icon={CircleSlash}
              disabled={!can("admin.users:write")}
              onClick={() => setStatus.mutate({ ids, suspend: true })}
            >
              Suspend
            </Button>
            <Button
              variant="secondary"
              size="xs"
              icon={CircleCheck}
              disabled={!can("admin.users:write")}
              onClick={() => setStatus.mutate({ ids, suspend: false })}
            >
              Activate
            </Button>
          </>
        )}
      />

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        roles={roles.data?.data ?? []}
        onInvited={setInvited}
      />
      <InviteLinkDialog user={invited} onOpenChange={() => setInvited(null)} />
      <EditUserDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        user={editing}
        roles={roles.data?.data ?? []}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.email ?? "account"}?`}
        description="Their sessions end immediately and every API key they created is revoked. The audit trail keeps what they did."
        confirmText={deleting?.email}
        confirmLabel="Delete account"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

/* ------------------------------ invite ------------------------------ */

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: readonly Role[];
  onInvited: (user: InvitedUser) => void;
}

function InviteDialog({ open, onOpenChange, roles, onInvited }: InviteDialogProps) {
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [roleIds, setRoleIds] = React.useState<string[]>([]);
  const [sendInvite, setSendInvite] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setEmail("");
    setName("");
    setRoleIds([]);
    setSendInvite(true);
    setError(null);
  }, [open]);

  const invite = useResourceMutation<void, InvitedUser>({
    mutationFn: () =>
      api.post<InvitedUser>("/users", {
        email: email.trim(),
        name: name.trim(),
        role_ids: roleIds,
        send_invite: sendInvite,
      }),
    invalidates: ["users"],
    onDone: (user) => {
      onOpenChange(false);
      onInvited(user);
    },
    onFailed: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" dismissible={!invite.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          invite.mutate();
        }}
      >
        <DialogHeader
          title="Invite a user"
          description="Kaname never creates an account with a password somebody else chose. The invitation link is what sets one."
        />

        <DialogBody>
          {error && error.fieldEntries.length === 0 && (
            <PageError error={error} onRetry={() => invite.mutate()} className="mb-4" />
          )}

          <div className="flex flex-col gap-4">
            <FormField label="Email" required error={error?.fields.email}>
              <Input
                mono
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                data-autofocus=""
              />
            </FormField>
            <FormField label="Name" required error={error?.fields.name}>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </FormField>
            <FormField
              label="Roles"
              required
              description="What this account may do, and on which servers."
              error={error?.fields.role_ids}
            >
              <Combobox
                multiple
                options={roles.map((role) => ({
                  value: role.id,
                  label: role.name,
                  description: role.description,
                }))}
                value={roleIds}
                onValueChange={setRoleIds}
                placeholder="Select at least one role"
                emptyMessage="No role matches that name."
              />
            </FormField>
            <Switch
              checked={sendInvite}
              onChange={(event) => setSendInvite(event.target.checked)}
              label="Email the invitation"
              description="Off hands you the link instead, for a fleet with no outbound mail yet."
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={invite.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={invite.isPending}>
            Send invitation
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function InviteLinkDialog({
  user,
  onOpenChange,
}: {
  user: InvitedUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!user) return null;

  return (
    <Dialog open onOpenChange={onOpenChange} size="md">
      <DialogHeader
        title={`${user.email} is invited`}
        description="This link sets their first password. It is shown once and expires on its own."
      />
      <DialogBody>
        <CopyableCode value={user.invite.url} label="Invitation link" block />
        <p className="mt-3 text-[var(--kn-text-2)]">
          Expires <RelativeTime value={user.invite.expires_at} />. Send it over a channel you
          already trust — anyone holding it can set the password for this account.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" icon={Mail} onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ------------------------------- edit ------------------------------- */

interface EditUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: User | null;
  roles: readonly Role[];
}

function EditUserDialog({ open, onOpenChange, user, roles }: EditUserDialogProps) {
  const [name, setName] = React.useState("");
  const [status, setStatus] = React.useState<User["status"]>("active");
  const [roleIds, setRoleIds] = React.useState<string[]>([]);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open || !user) return;
    setName(user.name);
    setStatus(user.status);
    setRoleIds(user.roles.map((role) => role.id));
    setError(null);
  }, [open, user]);

  const save = useResourceMutation<void, User>({
    mutationFn: () =>
      api.patch<User>(`/users/${user!.id}`, {
        name: name.trim(),
        status,
        role_ids: roleIds,
      }),
    invalidates: ["users"],
    successMessage: (result) => `${result.email} updated.`,
    onDone: () => onOpenChange(false),
    onFailed: setError,
  });

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" dismissible={!save.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <DialogHeader title={user.email} description="Roles take effect on their next request." />

        <DialogBody>
          {error && error.fieldEntries.length === 0 && (
            <PageError error={error} onRetry={() => save.mutate()} className="mb-4" />
          )}

          <div className="flex flex-col gap-4">
            <FormField label="Name" required error={error?.fields.name}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                data-autofocus=""
              />
            </FormField>
            <FormField
              label="Status"
              required
              description="Suspending an account ends its sessions immediately."
              error={error?.fields.status}
            >
              <Select
                value={status}
                onChange={(event) => setStatus(event.target.value as User["status"])}
                options={[
                  { value: "active", label: "Active" },
                  { value: "suspended", label: "Suspended" },
                  ...(user.status === "invited" ? [{ value: "invited", label: "Invited" }] : []),
                ]}
              />
            </FormField>
            <FormField label="Roles" required error={error?.fields.role_ids}>
              <Combobox
                multiple
                options={roles.map((role) => ({
                  value: role.id,
                  label: role.name,
                  description: role.description,
                }))}
                value={roleIds}
                onValueChange={setRoleIds}
                placeholder="Select at least one role"
                emptyMessage="No role matches that name."
              />
            </FormField>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save changes
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
