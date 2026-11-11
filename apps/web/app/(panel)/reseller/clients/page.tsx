"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Users } from "lucide-react";
import type { Client, InvitedClient } from "@kaname/contract";
import {
  Button,
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
  RelativeTime,
  StatusBadge,
  StatusLine,
  Switch,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useOpenFromQuery } from "@/components/ResourcePage";
import { STATUS_TONES, clientUsageCell } from "@/components/modes/columns";
import { useResellerArea } from "@/components/modes/ResellerGate";
import {
  InviteLinkDialog,
  QuotaFields,
  draftFromQuota,
  quotaFromDraft,
  type QuotaDraft,
} from "@/components/modes/shared";
import { ACCOUNT_FAMILIES, useMyClients } from "@/lib/accounts";
import { api, type ApiError } from "@/lib/api";
import { useModes } from "@/lib/modes";
import { useResourceMutation } from "@/lib/queries";

export default function ResellerClientsPage() {
  const router = useRouter();
  const { real, gate } = useResellerArea("Clients");
  const clients = useMyClients(real);
  const [creating, setCreating] = React.useState(false);
  const [invited, setInvited] = React.useState<InvitedClient | null>(null);
  useOpenFromQuery("new", () => setCreating(true), real);

  const columns = React.useMemo<DataTableColumn<Client>[]>(
    () => [
      {
        id: "name",
        header: "Client",
        locked: true,
        minWidth: 220,
        cell: (client) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">{client.name}</span>
            <MonoText muted truncate className="text-sm">
              {client.email}
            </MonoText>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 104,
        cell: (client) => (
          <StatusBadge size="sm" tone={STATUS_TONES[client.status]}>
            {client.status}
          </StatusBadge>
        ),
      },
      { id: "sites", header: "Sites", width: 90, align: "right", cell: clientUsageCell("sites", "max_sites") },
      { id: "domains", header: "Domains", width: 96, align: "right", hideBelow: "md", cell: clientUsageCell("domains", "max_domains") },
      { id: "mailboxes", header: "Mailboxes", width: 106, align: "right", hideBelow: "md", cell: clientUsageCell("mailboxes", "max_mailboxes") },
      { id: "databases", header: "Databases", width: 106, align: "right", hideBelow: "lg", cell: clientUsageCell("databases", "max_databases") },
      { id: "disk", header: "Disk", width: 130, align: "right", hideBelow: "lg", cell: clientUsageCell("disk_mb", "max_disk_mb") },
      {
        id: "last_login_at",
        header: "Last sign-in",
        width: 130,
        align: "right",
        hideBelow: "md",
        cell: (client) => <RelativeTime value={client.last_login_at} fallback="never" />,
      },
    ],
    [],
  );

  const list = clients.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Reseller"
        title="Clients"
        lede="Each client signs in to manage only what you hand them, within the share you set."
        status={
          real && clients.data ? (
            <StatusLine tone="ok">
              {list.length} client{list.length === 1 ? "" : "s"} ·{" "}
              {list.filter((c) => c.status === "invited").length} awaiting first sign-in
            </StatusLine>
          ) : undefined
        }
        actions={
          real && (
            <Button variant="primary" icon={UserPlus} onClick={() => setCreating(true)}>
              New client
            </Button>
          )
        }
      />
      <PageBody>
        {gate ?? (
          <DataTable
            label="Clients"
            columns={columns}
            rows={list}
            loading={clients.isLoading}
            getRowId={(client) => client.id}
            onRowClick={(client) => router.push(`/reseller/clients/${client.id}`)}
            error={
              clients.error ? (
                <PageError error={clients.error} onRetry={() => void clients.refetch()} context="Clients" />
              ) : undefined
            }
            empty={
              <EmptyState
                icon={Users}
                title="No clients yet"
                description="Invite one, then hand them websites, domains, mailboxes or databases from your pool."
                action={
                  <Button variant="primary" icon={UserPlus} onClick={() => setCreating(true)}>
                    New client
                  </Button>
                }
              />
            }
          />
        )}
      </PageBody>

      <NewClientDialog open={creating} onOpenChange={setCreating} onCreated={setInvited} />
      <InviteLinkDialog result={invited} noun="client" onClose={() => setInvited(null)} />
    </div>
  );
}

function NewClientDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (client: InvitedClient) => void;
}) {
  const { account } = useModes();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [quota, setQuota] = React.useState<QuotaDraft>(draftFromQuota(null));
  const [sendInvite, setSendInvite] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setEmail("");
    setName("");
    setQuota(draftFromQuota(null));
    setSendInvite(true);
    setError(null);
  }, [open]);

  const create = useResourceMutation<void, InvitedClient>({
    mutationFn: () =>
      api.post<InvitedClient>("/reseller/clients", {
        email: email.trim(),
        name: name.trim(),
        quota: quotaFromDraft(quota),
        send_invite: sendInvite,
      }),
    invalidates: ACCOUNT_FAMILIES,
    onDone: (client) => {
      onOpenChange(false);
      onCreated(client);
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
          title="New client"
          description="The invitation link is what sets their password. Their share of your allowance can change later."
        />
        <DialogBody>
          {error && error.fieldEntries.length === 0 && <PageError error={error} className="mb-4" />}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Name" required error={error?.fields.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus="" />
              </FormField>
              <FormField label="Email" required error={error?.fields.email}>
                <Input mono type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
            </div>
            <LeaderLabel>Share of your allowance</LeaderLabel>
            <QuotaFields
              draft={quota}
              onChange={setQuota}
              ceiling={account?.quota ?? null}
              errors={error?.fields}
            />
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
            Invite client
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
