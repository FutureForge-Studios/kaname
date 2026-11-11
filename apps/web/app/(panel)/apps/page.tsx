"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { APP_CATEGORY_LABELS, type AppCategory, type AppRecipe } from "@kaname/contract";
import {
  ErrorState,
  NumberedSection,
  PageBody,
  SegmentedControl,
  Skeleton,
  StatusLine,
} from "@kaname/ui";
import { AppCard } from "@/components/installer/AppCard";
import { AppsHeader } from "@/components/installer/AppsHeader";
import { useAppCatalog, useAppInstalls } from "@/components/installer/queries";
import { pluralize } from "@/lib/format";
import { useCan } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * App catalog.
 *
 * A gallery, not a table: the person here is choosing, not operating.
 * Categories filter in place; apps that need an agent capability that
 * does not exist yet sit in their own section so the installable ones
 * lead.
 * ------------------------------------------------------------------ */

type Filter = "all" | AppCategory;

export default function AppsCatalogPage() {
  const router = useRouter();
  const can = useCan();
  const catalog = useAppCatalog();
  const installs = useAppInstalls();
  const [filter, setFilter] = React.useState<Filter>("all");

  const apps = catalog.data?.data ?? [];
  const categories = React.useMemo(() => {
    const seen = new Set<AppCategory>();
    for (const app of apps) seen.add(app.category);
    return [...seen];
  }, [apps]);

  const visible = apps.filter((app) => filter === "all" || app.category === filter);
  const ready = visible.filter((app) => app.availability === "available");
  const soon = visible.filter((app) => app.availability !== "available");
  const availableCount = apps.filter((app) => app.availability === "available").length;
  const canInstall = can("apps.installs:write");

  const onInstall = (app: AppRecipe) => router.push(`/apps/install/${app.id}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppsHeader
        view="catalog"
        installedCount={installs.data?.meta.total}
        status={
          catalog.data ? (
            <StatusLine tone="ok">
              {pluralize(availableCount, "app")} ready to install · {apps.length - availableCount} coming soon
            </StatusLine>
          ) : null
        }
      />
      <PageBody gap="lg">
        {catalog.isError ? (
          <ErrorState
            code={catalog.error.code}
            message={catalog.error.message}
            remediation={catalog.error.remediation}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl<Filter>
                label="Category"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  ...categories.map((c) => ({ value: c, label: APP_CATEGORY_LABELS[c] })),
                ]}
              />
            </div>

            <NumberedSection
              index={1}
              title="Ready to install"
              caption="Database, files, website and HTTPS in one job."
            >
              {catalog.isLoading ? (
                <Grid>
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-80 w-full" label={i === 0 ? "Loading apps" : undefined} />
                  ))}
                </Grid>
              ) : ready.length === 0 ? (
                <p className="m-0 text-sm text-[var(--kn-text-2)]">Nothing in this category can be installed yet.</p>
              ) : (
                <Grid>
                  {ready.map((app) => (
                    <AppCard key={app.id} app={app} canInstall={canInstall} onInstall={onInstall} />
                  ))}
                </Grid>
              )}
            </NumberedSection>

            {soon.length > 0 && (
              <NumberedSection
                index={2}
                title="Coming soon"
                caption="Container apps, once the agent can create containers."
              >
                <Grid>
                  {soon.map((app) => (
                    <AppCard key={app.id} app={app} canInstall={false} onInstall={onInstall} />
                  ))}
                </Grid>
              </NumberedSection>
            )}
          </>
        )}
      </PageBody>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{children}</div>;
}
