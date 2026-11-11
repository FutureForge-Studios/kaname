"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { APP_CATEGORY_LABELS, findApp } from "@kaname/contract";
import { Button, EmptyState, PageBody, PageHeader, StatusLine } from "@kaname/ui";
import { versionLabel } from "@/components/installer/AppMark";
import { InstallWizard } from "@/components/installer/InstallWizard";

/* ------------------------------------------------------------------ *
 * Install one app. The recipe comes from the contract package (the
 * same data the control plane validates against), so the form renders
 * immediately with no round trip.
 * ------------------------------------------------------------------ */

export default function InstallAppPage({ params }: { params: Promise<{ app: string }> }) {
  const { app: appId } = React.use(params);
  const router = useRouter();
  const app = findApp(appId);

  const back = (
    <Button size="sm" icon={ArrowLeft} onClick={() => router.push("/apps")}>
      Catalog
    </Button>
  );

  if (!app || app.availability !== "available") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader eyebrow="Apps" title="Install an app" actions={back} />
        <PageBody>
          <EmptyState
            title={app ? `${app.name} is coming soon` : "No such app"}
            description={app?.unavailable_reason ?? "The catalog has no app with that name."}
            action={
              <Button variant="primary" arrow onClick={() => router.push("/apps")}>
                Browse the catalog
              </Button>
            }
          />
        </PageBody>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Apps"
        title={`Install ${app.name}`}
        subtitle={`${APP_CATEGORY_LABELS[app.category]} · ${versionLabel(app.version)}`}
        status={<StatusLine tone="info">Four short steps. Nothing is created until you press Install.</StatusLine>}
        actions={back}
      />
      <PageBody width="prose">
        <InstallWizard app={app} />
      </PageBody>
    </div>
  );
}
