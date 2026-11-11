"use client";

import * as React from "react";
import { PageBody } from "@kaname/ui";
import { AppsHeader } from "@/components/installer/AppsHeader";
import { InstalledList } from "@/components/installer/InstalledList";
import { useAppInstalls } from "@/components/installer/queries";

export default function InstalledAppsPage() {
  const installs = useAppInstalls();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppsHeader view="installed" installedCount={installs.data?.meta.total} />
      <PageBody>
        <InstalledList />
      </PageBody>
    </div>
  );
}
