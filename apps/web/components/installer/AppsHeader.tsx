"use client";

import * as React from "react";
import { PageHeader } from "@kaname/ui";

/* ------------------------------------------------------------------ *
 * The Apps module's header, shared by the catalog and Installed. The
 * Catalog / Installed tabs are the shell's section tab row (SectionTabs).
 * ------------------------------------------------------------------ */

export interface AppsHeaderProps {
  status?: React.ReactNode;
  actions?: React.ReactNode;
}

export function AppsHeader({ status, actions }: AppsHeaderProps) {
  return (
    <PageHeader
      title="Apps"
      lede="Install an app on your server in one go: files, database, domain and HTTPS."
      actions={actions}
      status={status}
    />
  );
}
