"use client";

import * as React from "react";
import { Users } from "lucide-react";
import { Card, EmptyState, Skeleton } from "@kaname/ui";
import { LinkButton } from "@/components/ResourcePage";
import { useModes } from "@/lib/modes";
import { PreviewNotice } from "./shared";

/**
 * The /reseller area works on the signed-in reseller's own data. For
 * anyone else it explains itself instead of drawing a 403: an owner
 * previewing sees the preview notice, any other operator is pointed at
 * Administration → Resellers.
 */
export function useResellerArea(what: string): { real: boolean; gate: React.ReactNode } {
  const { actualAudience, preview, accountQuery } = useModes();
  if (accountQuery.isLoading) return { real: false, gate: <Skeleton className="h-40 w-full" /> };
  if (actualAudience === "reseller") return { real: true, gate: null };
  if (preview === "reseller") {
    return {
      real: false,
      gate: <PreviewNotice what={what} manageHref="/administration/resellers" manageLabel="Manage resellers" />,
    };
  }
  return {
    real: false,
    gate: (
      <Card padding="none">
        <EmptyState
          icon={Users}
          title="This area is for reseller accounts"
          description="Resellers manage their own clients here. As an operator, you manage resellers from Administration."
          action={<LinkButton href="/administration/resellers">Open resellers</LinkButton>}
        />
      </Card>
    ),
  };
}
