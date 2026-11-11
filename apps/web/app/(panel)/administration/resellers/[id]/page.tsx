"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { CircleCheck, CircleSlash, Plus, Trash2 } from "lucide-react";
import type { Client, OwnedResource, Reseller, ResourceKind } from "@kaname/contract";
import {
  Button,
  Card,
  Combobox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FormField,
  LeaderLabel,
  MonoText,
  NumberedSection,
  PageBody,
  PageHeader,
  Skeleton,
  StatusBadge,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { STATUS_TONES, clientUsageCell } from "@/components/modes/columns";
import {
  AssignResourceDialog,
  BrandingForm,
  OwnedResourcesTable,
  brandingDraft,
  brandingPayload,
  type BrandingDraft,
} from "@/components/modes/forms";
import {
  QuotaFields,
  QuotaMeters,
  QuotaStatus,
  draftFromQuota,
  quotaFromDraft,
  type QuotaDraft,
} from "@/components/modes/shared";
import {
  ACCOUNT_FAMILIES,
  useResellerClients,
  useResellerDetail,
  useResellerResources,
  useUnownedResources,
} from "@/lib/accounts";
import { api, type ApiError } from "@/lib/api";
import { useCan, useResourceMutation, useServers } from "@/lib/queries";

export default function ResellerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const can = useCan();
  const writable = can("admin.users:write");
  const reseller = useResellerDetail(id);
  const clients = useResellerClients(id);
  const resources = useResellerResources(id);
  const servers = useServers();

  const data = reseller.data;
  const [serverIds, setServerIds] = React.useState<string[]>([]);
  const [quota, setQuota] = React.useState<QuotaDraft>(draftFromQuota(null));
  const [limitsError, setLimitsError] = React.useState<ApiError | null>(null);
  const [branding, setBranding] = React.useState<BrandingDraft>(brandingDraft(null));
  const [brandingError, setBrandingError] = React.useState<ApiError | null>(null);
  const [assigning, setAssigning] = React.useState(false);
  const [assignError, setAssignError] = React.useState<ApiError | null>(null);
  const [releasing, setReleasing] = React.useState<OwnedResource | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (!data) return;
    setServerIds(data.servers.map((s) => s.id));
    setQuota(draftFromQuota(data.quota));
    setBranding(brandingDraft(data.branding, data.name));
  }, [data]);

  const saveLimits = useResourceMutation<void, Reseller>({
    mutationFn: () => api.patch(`/resellers/${id}`, { server_ids: serverIds, quota: quotaFromDraft(quota) }),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Servers and allowance saved.",
    onFailed: setLimitsError,
  });

  const saveBranding = useResourceMutation<void, Reseller>({
    mutationFn: () => api.put(`/resellers/${id}/branding`, brandingPayload(branding)),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Branding saved.",
    onFailed: setBrandingError,
  });

  const setStatus = useResourceMutation<"active" | "suspended", Reseller>({
    mutationFn: (status) => api.patch(`/resellers/${id}`, { status }),
    invalidates: [...ACCOUNT_FAMILIES, "users"],
    successMessage: (_r, status) => (status === "active" ? "Reseller activated." : "Reseller suspended."),
  });

  const assign = useResourceMutation<{ kind: ResourceKind; resource_id: string }, unknown>({
    mutationFn: (input) => api.post(`/resellers/${id}/resources`, input),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Assigned.",
    onDone: () => setAssigning(false),
    onFailed: setAssignError,
    toastErrors: false,
  });

  const release = useResourceMutation<OwnedResource, void>({
    mutationFn: (row) => api.del(`/resellers/${id}/resources/${row.kind}/${row.id}`),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: (_r, row) => `${row.label} released.`,
    onDone: () => setReleasing(null),
  });

  const remove = useResourceMutation<void, void>({
    mutationFn: () => api.del(`/resellers/${id}`),
    invalidates: [...ACCOUNT_FAMILIES, "users"],
    successMessage: () => "Reseller removed.",
    onDone: () => router.push("/administration/resellers"),
  });

  const useCandidates = (kind: ResourceKind) => {
    const query = useUnownedResources(kind, assigning);
    return { rows: query.data ?? [], loading: query.isLoading, error: query.error ?? null };
  };

  const clientColumns = React.useMemo<DataTableColumn<Client>[]>(
    () => [
      {
        id: "name",
        header: "Client",
        minWidth: 200,
        cell: (c) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--kn-text)]">{c.name}</span>
            <MonoText muted truncate className="text-sm">
              {c.email}
            </MonoText>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        width: 104,
        cell: (c) => (
          <StatusBadge size="sm" tone={STATUS_TONES[c.status]}>
            {c.status}
          </StatusBadge>
        ),
      },
      { id: "sites", header: "Sites", width: 96, align: "right", cell: clientUsageCell("sites", "max_sites") },
      { id: "mailboxes", header: "Mailboxes", width: 110, align: "right", cell: clientUsageCell("mailboxes", "max_mailboxes") },
      { id: "databases", header: "Databases", width: 110, align: "right", hideBelow: "md", cell: clientUsageCell("databases", "max_databases") },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Reseller"
        title={data?.branding?.display_name ?? data?.name ?? "Reseller"}
        subtitle={data?.email}
        status={data ? <QuotaStatus quota={data.quota} usage={data.usage} /> : undefined}
        actions={
          data && (
            <>
              <StatusBadge tone={STATUS_TONES[data.status]}>{data.status}</StatusBadge>
              {writable && data.status === "suspended" && (
                <Button icon={CircleCheck} onClick={() => setStatus.mutate("active")} loading={setStatus.isPending}>
                  Activate
                </Button>
              )}
              {writable && data.status === "active" && (
                <Button icon={CircleSlash} onClick={() => setStatus.mutate("suspended")} loading={setStatus.isPending}>
                  Suspend
                </Button>
              )}
              {can("admin.users:delete") && (
                <Button variant="danger-subtle" icon={Trash2} onClick={() => setDeleting(true)}>
                  Remove
                </Button>
              )}
            </>
          )
        }
      />
      <PageBody>
        {reseller.error ? (
          <PageError error={reseller.error} onRetry={() => void reseller.refetch()} context="Reseller" />
        ) : !data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <NumberedSection index={1} title="Usage" caption="The reseller's own resources plus every client's.">
              <Card padding="none" className="px-4">
                <QuotaMeters quota={data.quota} usage={data.usage} />
              </Card>
            </NumberedSection>

            <NumberedSection
              index={2}
              title="Servers and allowance"
              caption="Empty means no limit."
              actions={
                writable && (
                  <Button
                    variant="primary"
                    size="sm"
                    loading={saveLimits.isPending}
                    onClick={() => {
                      setLimitsError(null);
                      saveLimits.mutate();
                    }}
                  >
                    Save
                  </Button>
                )
              }
            >
              <Card padding="lg" className="flex flex-col gap-4">
                <FormField
                  label="Servers"
                  description="Where this reseller and its clients may put things."
                  error={limitsError?.fields.server_ids}
                >
                  <Combobox
                    multiple
                    options={(servers.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
                    value={serverIds}
                    onValueChange={setServerIds}
                    placeholder="Choose servers"
                    emptyMessage="No server matches that name."
                    disabled={!writable}
                  />
                </FormField>
                <LeaderLabel>Allowance</LeaderLabel>
                <QuotaFields draft={quota} onChange={setQuota} errors={limitsError?.fields} />
                {limitsError && limitsError.fieldEntries.length === 0 && <PageError error={limitsError} />}
              </Card>
            </NumberedSection>

            <NumberedSection
              index={3}
              title="Resources"
              caption="Everything the reseller answers for, and which client holds it."
              actions={
                writable && (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={Plus}
                    onClick={() => {
                      setAssignError(null);
                      setAssigning(true);
                    }}
                  >
                    Assign
                  </Button>
                )
              }
            >
              <OwnedResourcesTable
                rows={resources.data ?? []}
                loading={resources.isLoading}
                error={resources.error}
                onRetry={() => void resources.refetch()}
                showOwner
                releaseLabel="Release to the fleet"
                onRelease={writable ? setReleasing : undefined}
                empty={{
                  title: "Nothing assigned",
                  description: "Assign existing sites, domains, mailboxes or databases nobody owns yet.",
                }}
              />
            </NumberedSection>

            <NumberedSection index={4} title="Clients" caption="Managed by the reseller; read-only here.">
              <DataTable
                label="Clients of this reseller"
                density="compact"
                columns={clientColumns}
                rows={clients.data ?? []}
                loading={clients.isLoading}
                getRowId={(c) => c.id}
                columnVisibility={false}
                error={clients.error ? <PageError error={clients.error} context="Clients" /> : undefined}
                empty={<EmptyState size="sm" title="No clients yet" description="The reseller invites its own clients." />}
              />
            </NumberedSection>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                setBrandingError(null);
                saveBranding.mutate();
              }}
            >
              <NumberedSection
                index={5}
                title="Branding"
                caption="Shown to the reseller and its clients."
                actions={
                  writable && (
                    <Button type="submit" variant="primary" size="sm" loading={saveBranding.isPending}>
                      Save branding
                    </Button>
                  )
                }
              >
                <Card padding="lg">
                  <BrandingForm draft={branding} onChange={setBranding} error={brandingError} disabled={!writable} />
                </Card>
              </NumberedSection>
            </form>
          </>
        )}
      </PageBody>

      <AssignResourceDialog
        open={assigning}
        onOpenChange={setAssigning}
        title={`Assign to ${data?.name ?? "reseller"}`}
        description="Only resources nobody owns are offered. It must be on one of the reseller's servers and fit its allowance."
        useCandidates={useCandidates}
        onAssign={(input) => assign.mutate(input)}
        pending={assign.isPending}
        error={assignError}
      />
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(open) => !open && setReleasing(null)}
        title={`Release ${releasing?.label ?? ""}?`}
        description="The reseller (and any client holding it) loses access. Nothing on the server changes."
        confirmLabel="Release"
        destructive={false}
        loading={release.isPending}
        onConfirm={() => releasing && release.mutate(releasing)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Remove ${data?.name ?? "this reseller"}?`}
        description="Their account is deleted and what they owned returns to the fleet. A reseller with clients cannot be removed — suspend it instead."
        confirmLabel="Remove reseller"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
