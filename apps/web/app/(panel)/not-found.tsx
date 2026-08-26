"use client";

import { useRouter } from "next/navigation";
import { Compass } from "lucide-react";
import { Button, EmptyState, Kbd, PageHeader } from "@kaname/ui";

/*
 * A 404 inside the panel is almost always a resource that was deleted
 * or a link into a host this account cannot see, so the way out is the
 * palette rather than an apology.
 */
export default function PanelNotFound() {
  const router = useRouter();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Not found" />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-4">
        <EmptyState
          icon={Compass}
          title="There is nothing at this address"
          description="The resource may have been removed, or it belongs to a server this account is not scoped to."
          action={
            <Button variant="primary" size="sm" onClick={() => router.push("/")}>
              Go to the Command Center
            </Button>
          }
        >
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--kn-text-3)]">
            <Kbd keys="mod+k" size="xs" /> searches every resource you can reach
          </p>
        </EmptyState>
      </div>
    </div>
  );
}
