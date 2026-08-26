"use client";

import * as React from "react";
import { PageHeader } from "@kaname/ui";
import { PageError } from "@/components/PageError";

/*
 * The segment error boundary. Anything that escapes a page's own error
 * handling lands here rather than blanking the shell, so the sidebar,
 * the palette and the job drawer stay usable while the operator decides
 * what to do.
 */
export default function PanelError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("kaname: unhandled render error", error);
  }, [error]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="This page did not render" subtitle={error.digest ?? undefined} />
      <div className="px-6 py-4">
        <PageError error={error} onRetry={reset} />
      </div>
    </div>
  );
}
