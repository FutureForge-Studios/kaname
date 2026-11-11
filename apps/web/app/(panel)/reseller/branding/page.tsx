"use client";

import * as React from "react";
import type { ResellerBranding } from "@kaname/contract";
import { Button, Card, NumberedSection, PageBody, PageHeader, Skeleton } from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { BrandingForm, brandingDraft, brandingPayload, type BrandingDraft } from "@/components/modes/forms";
import { useResellerArea } from "@/components/modes/ResellerGate";
import { ACCOUNT_FAMILIES, useMyBranding } from "@/lib/accounts";
import { api, type ApiError } from "@/lib/api";
import { useSession, useResourceMutation } from "@/lib/queries";

export default function ResellerBrandingPage() {
  const { session } = useSession();
  const { real, gate } = useResellerArea("Branding");
  const branding = useMyBranding(real);
  const [draft, setDraft] = React.useState<BrandingDraft>(brandingDraft(null));
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (branding.isSuccess) setDraft(brandingDraft(branding.data, session?.user?.name ?? ""));
  }, [branding.isSuccess, branding.data, session?.user?.name]);

  const save = useResourceMutation<void, ResellerBranding>({
    mutationFn: () => api.put("/reseller/branding", brandingPayload(draft)),
    invalidates: ACCOUNT_FAMILIES,
    successMessage: () => "Branding saved. Your clients see it on their next page load.",
    onFailed: setError,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Reseller"
        title="Branding"
        lede="The name, mark and support contact your clients see in their panel."
      />
      <PageBody width="prose">
        {gate ??
          (branding.error ? (
            <PageError error={branding.error} onRetry={() => void branding.refetch()} context="Branding" />
          ) : branding.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                save.mutate();
              }}
            >
              <NumberedSection
                index={1}
                title="Identity"
                caption="Shown to you and your clients; operators see Kaname."
                actions={
                  <Button type="submit" variant="primary" size="sm" loading={save.isPending}>
                    Save branding
                  </Button>
                }
              >
                <Card padding="lg">
                  <BrandingForm draft={draft} onChange={setDraft} error={error} />
                </Card>
              </NumberedSection>
            </form>
          ))}
      </PageBody>
    </div>
  );
}
