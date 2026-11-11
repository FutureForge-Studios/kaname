"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { UNLIMITED_QUOTA, type Client, type QuotaUsage } from "@kaname/contract";
import {
  Card,
  DataTable,
  EmptyState,
  NumberedSection,
  PageBody,
  PageHeader,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { clientUsageCell } from "@/components/modes/columns";
import { OwnedResourcesTable } from "@/components/modes/forms";
import { useResellerArea } from "@/components/modes/ResellerGate";
import { QuotaMeters, QuotaStatus } from "@/components/modes/shared";
import { useMyClients, useMyPool } from "@/lib/accounts";
import { useModes } from "@/lib/modes";

const EMPTY_USAGE: QuotaUsage = { sites: 0, domains: 0, mailboxes: 0, databases: 0, disk_mb: 0 };

/*
 * The reseller's allowance (set by the operator, read-only here), how
 * it is shared out between clients, and the whole pool of resources.
 */
export default function ResellerQuotasPage() {
  const router = useRouter();
  const { account } = useModes();
  const { real, gate } = useResellerArea("Quotas");
  const clients = useMyClients(real);
  const pool = useMyPool(real);
  const quota = account?.quota ?? UNLIMITED_QUOTA;
  const usage = account?.usage ?? EMPTY_USAGE;

  const columns = React.useMemo<DataTableColumn<Client>[]>(
    () => [
      { id: "name", header: "Client", minWidth: 200, accessor: (c) => c.name },
      { id: "sites", header: "Sites", width: 96, align: "right", cell: clientUsageCell("sites", "max_sites") },
      { id: "domains", header: "Domains", width: 100, align: "right", cell: clientUsageCell("domains", "max_domains") },
      { id: "mailboxes", header: "Mailboxes", width: 110, align: "right", cell: clientUsageCell("mailboxes", "max_mailboxes") },
      { id: "databases", header: "Databases", width: 110, align: "right", hideBelow: "md", cell: clientUsageCell("databases", "max_databases") },
      { id: "disk", header: "Disk", width: 140, align: "right", hideBelow: "md", cell: clientUsageCell("disk_mb", "max_disk_mb") },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Reseller"
        title="Quotas"
        lede="Your provider sets your allowance. You share it out: each client's ceiling sits inside yours."
        status={real && account ? <QuotaStatus quota={quota} usage={usage} /> : undefined}
      />
      <PageBody>
        {gate ?? (
          <>
            <NumberedSection index={1} title="Your allowance" caption="Includes every client's usage.">
              <Card padding="none" className="px-4">
                <QuotaMeters quota={quota} usage={usage} />
              </Card>
            </NumberedSection>

            <NumberedSection index={2} title="Per client" caption="Open a client to change its share.">
              <DataTable
                label="Client quotas"
                density="compact"
                columns={columns}
                rows={clients.data ?? []}
                loading={clients.isLoading}
                getRowId={(c) => c.id}
                columnVisibility={false}
                onRowClick={(c) => router.push(`/reseller/clients/${c.id}`)}
                error={clients.error ? <PageError error={clients.error} context="Clients" /> : undefined}
                empty={<EmptyState size="sm" title="No clients yet" description="Shares appear here once you invite a client." />}
              />
            </NumberedSection>

            <NumberedSection index={3} title="Your pool" caption="Everything you answer for, and who holds it.">
              <OwnedResourcesTable
                rows={pool.data ?? []}
                loading={pool.isLoading}
                error={pool.error}
                onRetry={() => void pool.refetch()}
                showOwner
                empty={{
                  title: "Nothing in your pool",
                  description: "Resources you create, or your provider assigns you, appear here.",
                }}
              />
            </NumberedSection>
          </>
        )}
      </PageBody>
    </div>
  );
}
