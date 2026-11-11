"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Globe, UserPlus, Users } from "lucide-react";
import { UNLIMITED_QUOTA, type Client, type QuotaUsage } from "@kaname/contract";
import {
  Card,
  DataTable,
  EmptyState,
  MonoText,
  NumberedSection,
  PageBody,
  PageHero,
  Skeleton,
  StatusBadge,
  type DataTableColumn,
} from "@kaname/ui";
import { LinkButton } from "@/components/ResourcePage";
import { PageError } from "@/components/PageError";
import { useMyClients } from "@/lib/accounts";
import { useModes } from "@/lib/modes";
import { PreviewNotice, QuotaMeters, QuotaStatus, TaskCard } from "./shared";
import { clientUsageCell } from "./columns";

/* ------------------------------------------------------------------ *
 * Reseller home: the allowance the operator gave, how the clients are
 * using it, and the three things a reseller does most.
 * ------------------------------------------------------------------ */

const EMPTY_USAGE: QuotaUsage = { sites: 0, domains: 0, mailboxes: 0, databases: 0, disk_mb: 0 };

export function ResellerHome() {
  const router = useRouter();
  const { account, branding, preview } = useModes();
  const real = !preview;
  const clients = useMyClients(real);
  const usage = account?.usage ?? EMPTY_USAGE;
  const quota = real ? (account?.quota ?? UNLIMITED_QUOTA) : null;
  const list = clients.data ?? [];

  const columns = React.useMemo<DataTableColumn<Client>[]>(
    () => [
      {
        id: "name",
        header: "Client",
        minWidth: 200,
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
          <StatusBadge size="sm" tone={client.status === "active" ? "ok" : client.status === "invited" ? "info" : "warn"}>
            {client.status}
          </StatusBadge>
        ),
      },
      { id: "sites", header: "Sites", width: 96, align: "right", mono: true, cell: clientUsageCell("sites", "max_sites") },
      { id: "mail", header: "Mailboxes", width: 110, align: "right", mono: true, cell: clientUsageCell("mailboxes", "max_mailboxes") },
      { id: "db", header: "Databases", width: 110, align: "right", mono: true, cell: clientUsageCell("databases", "max_databases") },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="reseller-home">
      <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 py-8">
        <PageHero
          size="md"
          eyebrow={branding?.display_name ?? "Reseller"}
          title="Your clients,"
          accent="your allowance."
          lede="Create client accounts, hand them websites, domains, mailboxes and databases, and keep each within the share you choose."
          actions={
            <LinkButton href="/reseller/clients?new=1" icon={UserPlus}>
              New client
            </LinkButton>
          }
          status={
            real && !account ? (
              <Skeleton className="h-4 w-64" />
            ) : (
              <QuotaStatus quota={quota} usage={usage} />
            )
          }
        />
      </header>

      <PageBody gap="lg">
        <NumberedSection
          index={1}
          title="Allowance"
          caption="Set by your provider. Your clients' usage counts against it."
          actions={<LinkButton href="/reseller/quotas" variant="ghost">Quotas</LinkButton>}
        >
          <Card padding="none" className="px-4">
            <QuotaMeters quota={quota} usage={usage} />
          </Card>
        </NumberedSection>

        <NumberedSection
          index={2}
          title="Clients"
          caption={real && clients.data ? `${list.length} account${list.length === 1 ? "" : "s"}` : undefined}
          actions={<LinkButton href="/reseller/clients" variant="ghost">All clients</LinkButton>}
        >
          {preview ? (
            <PreviewNotice what="Clients" manageHref="/administration/resellers" manageLabel="Manage resellers" />
          ) : clients.error ? (
            <PageError error={clients.error} onRetry={() => void clients.refetch()} context="Clients" />
          ) : clients.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : list.length === 0 ? (
            <Card padding="none">
              <EmptyState
                icon={Users}
                title="No clients yet"
                description="A client signs in to manage only what you hand them."
                action={<LinkButton href="/reseller/clients?new=1" icon={UserPlus}>New client</LinkButton>}
              />
            </Card>
          ) : (
            <DataTable
              label="Clients"
              density="compact"
              columns={columns}
              rows={list.slice(0, 8)}
              getRowId={(client) => client.id}
              onRowClick={(client) => router.push(`/reseller/clients/${client.id}`)}
            />
          )}
        </NumberedSection>

        <NumberedSection index={3} title="Quick create" caption="The usual order.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <TaskCard
              href="/reseller/clients?new=1"
              icon={UserPlus}
              title="Add a client"
              description="Invite someone and give them a share of your allowance."
            />
            <TaskCard
              href="/reseller/clients"
              icon={Globe}
              title="Hand over a site"
              description="Open a client and assign websites, domains, mailboxes or databases."
            />
            <TaskCard
              href="/reseller/branding"
              icon={BadgeCheck}
              title="Your branding"
              description="The name, mark and support contact your clients see."
            />
          </div>
        </NumberedSection>
      </PageBody>
    </div>
  );
}
