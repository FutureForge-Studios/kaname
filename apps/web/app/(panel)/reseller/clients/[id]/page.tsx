"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { CircleCheck, CircleSlash, Plus, Trash2 } from "lucide-react";
import type { Client, OwnedResource, ResourceKind } from "@kaname/contract";
import {
  Button,
  Card,
  ConfirmDialog,
  NumberedSection,
  PageBody,
  PageHeader,
  Skeleton,
  StatusBadge,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { STATUS_TONES } from "@/components/modes/columns";
import { AssignResourceDialog, OwnedResourcesTable } from "@/components/modes/forms";
import { useResellerArea } from "@/components/modes/ResellerGate";
import {
  QuotaFields,
  QuotaMeters,
  QuotaStatus,
  draftFromQuota,
  quotaFromDraft,
  type QuotaDraft,
} from "@/components/modes/shared";
import { ACCOUNT_FAMILIES, useMyClient, useMyClientResources, useMyPool } from "@/lib/accounts";
import { api, type ApiError } from "@/lib/api";
import { useModes } from "@/lib/modes";
import { useResourceMutation } from "@/lib/queries";

export default function ResellerClientPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { account } = useModes();
  const { real, gate } = useResellerArea("Client details");
  const client = useMyClient(id, real);
  const resources = useMyClientResources(id, real);
  const pool = useMyPool(real);

  const [assigning, setAssigning] = React.useState(false);
  const [assignError, setAssignError] = React.useState<ApiError | null>(null);
  const [releasing, setReleasing] = React.useState<OwnedResource | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [quota, setQuota] = React.useState<QuotaDraft>(draftFromQuota(null));
  const [quotaError, setQuotaError] = React.useState<ApiError | null>(null);

  const data = client.data;
  React.useEffect(() => {
    if (data) setQuota(draftFromQuota(data.quota));
  }, [data]);

  const assign = useResourceMutation<{ kind: ResourceKind; resource_id: string }, OwnedResource[]>({
    mutationFn: (input) => api.post(`/reseller/clients/${id}/resources`, input),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Handed over.",
    onDone: () => setAssigning(false),
    onFailed: setAssignError,
    toastErrors: false,
  });

  const release = useResourceMutation<OwnedResource, void>({
    mutationFn: (row) => api.del(`/reseller/clients/${id}/resources/${row.kind}/${row.id}`),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: (_r, row) => `${row.label} is back in your pool.`,
    onDone: () => setReleasing(null),
  });

  const saveQuota = useResourceMutation<void, Client>({
    mutationFn: () => api.patch(`/reseller/clients/${id}`, { quota: quotaFromDraft(quota) }),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Allowance saved.",
    onFailed: setQuotaError,
  });

  const setStatus = useResourceMutation<"active" | "suspended", Client>({
    mutationFn: (status) => api.patch(`/reseller/clients/${id}`, { status }),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: (_r, status) => (status === "active" ? "Client activated." : "Client suspended."),
  });

  const remove = useResourceMutation<void, void>({
    mutationFn: () => api.del(`/reseller/clients/${id}`),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Client removed. What they held is back in your pool.",
    onDone: () => router.push("/reseller/clients"),
  });

  /* Candidates: anything in the reseller's pool not already this client's. */
  const useCandidates = (kind: ResourceKind) => ({
    rows: (pool.data ?? []).filter((row) => row.kind === kind && row.owner_id !== id),
    loading: pool.isLoading,
    error: pool.error ?? null,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Client"
        title={data?.name ?? (real && client.isLoading ? "Loading…" : "Client")}
        subtitle={data?.email}
        status={data ? <QuotaStatus quota={data.quota} usage={data.usage} /> : undefined}
        actions={
          data && (
            <>
              <StatusBadge tone={STATUS_TONES[data.status]}>{data.status}</StatusBadge>
              {data.status === "suspended" ? (
                <Button icon={CircleCheck} onClick={() => setStatus.mutate("active")} loading={setStatus.isPending}>
                  Activate
                </Button>
              ) : (
                data.status === "active" && (
                  <Button icon={CircleSlash} onClick={() => setStatus.mutate("suspended")} loading={setStatus.isPending}>
                    Suspend
                  </Button>
                )
              )}
              <Button variant="danger-subtle" icon={Trash2} onClick={() => setDeleting(true)}>
                Remove
              </Button>
            </>
          )
        }
      />
      <PageBody>
        {gate ??
          (client.error ? (
            <PageError error={client.error} onRetry={() => void client.refetch()} context="Client" />
          ) : !data ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <NumberedSection index={1} title="Usage" caption="Against the share you set.">
                <Card padding="none" className="px-4">
                  <QuotaMeters quota={data.quota} usage={data.usage} />
                </Card>
              </NumberedSection>

              <NumberedSection
                index={2}
                title="Resources"
                caption="What this client can see and manage."
                actions={
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
                }
              >
                <OwnedResourcesTable
                  rows={resources.data ?? []}
                  loading={resources.isLoading}
                  error={resources.error}
                  onRetry={() => void resources.refetch()}
                  releaseLabel="Take back"
                  onRelease={setReleasing}
                  empty={{
                    title: "Nothing assigned",
                    description: "Hand over a website, domain, mailbox or database from your pool.",
                  }}
                />
              </NumberedSection>

              <NumberedSection
                index={3}
                title="Allowance"
                caption="Empty means no limit of its own; your allowance still applies."
                actions={
                  <Button
                    variant="primary"
                    size="sm"
                    loading={saveQuota.isPending}
                    onClick={() => {
                      setQuotaError(null);
                      saveQuota.mutate();
                    }}
                  >
                    Save allowance
                  </Button>
                }
              >
                <Card padding="lg">
                  <QuotaFields
                    draft={quota}
                    onChange={setQuota}
                    ceiling={account?.quota ?? null}
                    errors={quotaError?.fields}
                  />
                </Card>
              </NumberedSection>
            </>
          ))}
      </PageBody>

      <AssignResourceDialog
        open={assigning}
        onOpenChange={setAssigning}
        title={`Assign to ${data?.name ?? "client"}`}
        description="It moves from your pool to this client. It still counts against your allowance."
        useCandidates={useCandidates}
        onAssign={(input) => assign.mutate(input)}
        pending={assign.isPending}
        error={assignError}
      />
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(open) => !open && setReleasing(null)}
        title={`Take back ${releasing?.label ?? ""}?`}
        description="The client loses access to it. Nothing on the server changes; it returns to your pool."
        confirmLabel="Take back"
        destructive={false}
        loading={release.isPending}
        onConfirm={() => releasing && release.mutate(releasing)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Remove ${data?.name ?? "this client"}?`}
        description="Their account is deleted. Everything they held returns to your pool; no site, mailbox or database is deleted."
        confirmLabel="Remove client"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
