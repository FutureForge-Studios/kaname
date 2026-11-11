"use client";

import * as React from "react";
import { PageHero } from "@kaname/ui";
import { ViewTabs } from "@/components/ViewTabs";

/* ------------------------------------------------------------------ *
 * The Apps module's header: an in-panel hero (this is the friendliest
 * door into the product, and the one Simplified mode leads with) over
 * the Catalog / Installed tabs.
 * ------------------------------------------------------------------ */

export type AppsView = "catalog" | "installed";

export interface AppsHeaderProps {
  view: AppsView;
  installedCount?: number;
  status?: React.ReactNode;
  actions?: React.ReactNode;
}

export function AppsHeader({ view, installedCount, status, actions }: AppsHeaderProps) {
  return (
    <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 pt-8">
      <PageHero
        size="md"
        eyebrow="Apps"
        title="Install an app"
        lede="Pick an app, a server and a domain. Kaname creates the database, the files or the containers, the website and its HTTPS certificate in one go, and shows you every step."
        actions={actions}
        status={status}
      />
      <ViewTabs
        className="-mb-px mt-6"
        label="App views"
        current={view}
        tabs={[
          { id: "catalog", label: "Catalog", href: "/apps" },
          {
            id: "installed",
            label: "Installed",
            href: "/apps/installed",
            badge: installedCount ? installedCount : undefined,
          },
        ]}
      />
    </header>
  );
}
