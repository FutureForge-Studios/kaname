"use client";

import * as React from "react";
import { PageBody } from "@kaname/ui";
import { AppsHeader } from "@/components/installer/AppsHeader";
import { InstalledList } from "@/components/installer/InstalledList";

export default function InstalledAppsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppsHeader />
      <PageBody>
        <InstalledList />
      </PageBody>
    </div>
  );
}
