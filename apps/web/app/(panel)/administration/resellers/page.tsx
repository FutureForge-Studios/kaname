"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, UserPlus, Users } from "lucide-react";
import type { InvitedReseller, Reseller } from "@kaname/contract";
import {
  Button,
  Combobox,
  DataTable,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  FormField,
  Input,
  LeaderLabel,
  MonoText,
  PageBody,
  PageHeader,
  StatusBadge,
  StatusLine,
  Switch,
  Tag,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useOpenFromQuery } from "@/components/ResourcePage";
import { STATUS_TONES, clientUsageCell } from "@/components/modes/columns";
import {
  InviteLinkDialog,
  QuotaFields,
  draftFromQuota,
  quotaFromDraft,
  type QuotaDraft,
} from "@/components/modes/shared";
import { ACCOUNT_FAMILIES, useResellers } from "@/lib/accounts";
import { api, type ApiError } from "@/lib/api";
import { useModes } from "@/lib/modes";
import { useCan, useResourceMutation, useServers } from "@/lib/queries";

/*
 * Resellers (KD-039): accounts that hand sites, domains, mailboxes and
 * databases on their servers to clients of their own, within the
 * allowance set here. No tenancy, no billing.
 */
export default function ResellersPage() {
  const router = useRouter();
  const can = useCan();
  const { canPreview, startPreview } = useModes();
  const resellers = useResellers(can("admin.users:read"));
  const [creating, setCreating] = React.useState(false);
  const [invited, setInvited] = React.useState<InvitedReseller | null>(null);
  useOpenFromQuery("new", () => setCreating(true), can("admin.users:write"));

  const columns = React.useMemo<DataTableColumn<Reseller>[]>(
    () => [
      {
        id: "name",
        header: "Reseller",
        locked: true,
        minWidth: 220,
        cell: (r) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">
              {r.branding?.display_name ?? r.name}
            </span>
            <MonoText muted truncate className="text-sm">
              {r.email}
            </MonoText>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 104,
        cell: (r) => (
          <StatusBadge size="sm" tone={STATUS_TONES[r.status]}>
            {r.status}
          </StatusBadge>
        ),
      },
      {
        id: "servers",
        header: "Servers",
        minWidth: 160,
        hideBelow: "md",
        cell: (r) =>
          r.servers.length === 0 ? (
            <span className="text-[var(--kn-warn)]">none</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {r.servers.map((s) => (
                <Tag key={s.id} size="xs">
                  {s.name}
                </Tag>
              ))}
            </div>
          ),
      },
      { id: "clients", header: "Clients", width: 88, align: "right", mono: true, accessor: (r) => r.client_count },
      { id: "sites", header: "Sites", width: 96, align: "right", cell: clientUsageCell("sites", "max_sites") },
      { id: "mailboxes", header: "Mailboxes", width: 110, align: "right", hideBelow: "lg", cell: clientUsageCell("mailboxes", "max_mailboxes") },
      { id: "disk", header: "Disk", width: 140, align: "right", hideBelow: "lg", cell: clientUsageCell("disk_mb", "max_disk_mb") },
    ],
    [],
  );

  const list = resellers.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Administration"
        title="Resellers"
        lede="Accounts that resell part of this fleet: they create clients and hand them resources, inside the allowance you set."
        status={
          resellers.data ? (
            <StatusLine tone="ok">
              {list.length} reseller{list.length === 1 ? "" : "s"} ·{" "}
              {list.reduce((n, r) => n + r.client_count, 0)} clients
            </StatusLine>
          ) : undefined
        }
        actions={
          <>
            {canPreview && (
              <Button icon={Eye} onClick={() => startPreview("reseller")}>
                Preview as reseller
              </Button>
            )}
            {can("admin.users:write") && (
              <Button variant="primary" icon={UserPlus} onClick={() => setCreating(true)}>
                New reseller
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <DataTable
          label="Resellers"
          columns={columns}
          rows={list}
          loading={resellers.isLoading}
          getRowId={(r) => r.id}
          onRowClick={(r) => router.push(`/administration/resellers/${r.id}`)}
          error={
            resellers.error ? (
              <PageError error={resellers.error} onRetry={() => void resellers.refetch()} context="Resellers" />
            ) : undefined
          }
          empty={
            <EmptyState
              icon={Users}
              title="No resellers"
              description="A reseller gets servers and an allowance, then invites clients of its own. There is no billing or tenancy."
              action={
                can("admin.users:write") && (
                  <Button variant="primary" icon={UserPlus} onClick={() => setCreating(true)}>
                    New reseller
                  </Button>
                )
              }
            />
          }
        />
      </PageBody>

      <NewResellerDialog open={creating} onOpenChange={setCreating} onCreated={setInvited} />
      <InviteLinkDialog result={invited} noun="reseller" onClose={() => setInvited(null)} />
    </div>
  );
}

function NewResellerDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (reseller: InvitedReseller) => void;
}) {
  const servers = useServers();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [serverIds, setServerIds] = React.useState<string[]>([]);
  const [quota, setQuota] = React.useState<QuotaDraft>(draftFromQuota(null));
  const [sendInvite, setSendInvite] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setEmail("");
    setName("");
    setDisplayName("");
    setServerIds([]);
    setQuota(draftFromQuota(null));
    setSendInvite(true);
    setError(null);
  }, [open]);

  const create = useResourceMutation<void, InvitedReseller>({
    mutationFn: () =>
      api.post<InvitedReseller>("/resellers", {
        email: email.trim(),
        name: name.trim(),
        server_ids: serverIds,
        quota: quotaFromDraft(quota),
        branding: displayName.trim()
          ? { display_name: displayName.trim(), logo_text: null, support_email: null, support_url: null }
          : undefined,
        send_invite: sendInvite,
      }),
    invalidates: [...ACCOUNT_FAMILIES, "users"],
    onDone: (reseller) => {
      onOpenChange(false);
      onCreated(reseller);
    },
    onFailed: setError,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" dismissible={!create.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <DialogHeader
          title="New reseller"
          description="They get the servers and allowance below, and an invitation link that sets their password."
        />
        <DialogBody>
          {error && error.fieldEntries.length === 0 && <PageError error={error} className="mb-4" />}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Contact name" required error={error?.fields.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus="" />
              </FormField>
              <FormField label="Email" required error={error?.fields.email}>
                <Input mono type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
            </div>
            <FormField
              label="Brand name"
              description="What their clients see in the sidebar. They can change it later."
              error={error?.fields["branding.display_name"]}
            >
              <Input value={displayName} maxLength={64} onChange={(e) => setDisplayName(e.target.value)} />
            </FormField>
            <FormField
              label="Servers"
              description="Where they and their clients may put sites, mailboxes and databases."
              error={error?.fields.server_ids}
            >
              <Combobox
                multiple
                options={(servers.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
                value={serverIds}
                onValueChange={setServerIds}
                placeholder="Choose servers"
                emptyMessage="No server matches that name."
              />
            </FormField>
            <LeaderLabel>Allowance</LeaderLabel>
            <QuotaFields draft={quota} onChange={setQuota} errors={error?.fields} />
            <Switch
              checked={sendInvite}
              onChange={(e) => setSendInvite(e.target.checked)}
              label="Email the invitation"
              description="Off hands you the link instead."
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Invite reseller
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
