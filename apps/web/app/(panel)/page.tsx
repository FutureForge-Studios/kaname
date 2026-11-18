"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Database,
  GitBranch,
  PackageCheck,
  Plus,
  Rocket,
  Server as ServerIcon,
} from "lucide-react";
import type { Site } from "@kaname/contract";
import {
  Button,
  Card,
  Dot,
  DropdownMenu,
  EmptyState,
  MenuItem,
  MonoText,
  PageBody,
  PageHeader,
  RelativeTime,
  SearchInput,
  Skeleton,
  cn,
  type Tone,
} from "@kaname/ui";
import { GettingStarted } from "@/components/GettingStarted";
import { QuotaMeters } from "@/components/modes/shared";
import { flattenNavigation, useModes, useNavigation } from "@/lib/modes";
import { useOpenFromQuery } from "@/components/ResourcePage";
import { PageError } from "@/components/PageError";
import { YunoriSuggestion } from "@/components/YunoriMail";
import { ATTENTION_ICONS } from "@/lib/icons";
import { useCan, useDashboard, type DashboardSummary } from "@/lib/queries";
import { SiteDialog } from "./websites/_components/SiteDialog";
import { useSites } from "./websites/_components/queries";
import {
  DeploymentStatusBadge,
  RUNTIME_LABELS,
  shortSha,
  siteStatusTone,
} from "./websites/_components/status";

/* ------------------------------------------------------------------ *
 * Projects.
 *
 * The home is the list of things you deploy, newest activity first,
 * the way Vercel and Render open. Fleet health lives on Servers, and
 * certificates and backups on their own pages; here only a short
 * "Needs attention" strip appears, and only when something is wrong.
 * ------------------------------------------------------------------ */

type Attention = DashboardSummary["attention"][number];

const SEVERITY_TONE: Record<Attention["severity"], Tone> = {
  critical: "danger",
  warning: "warn",
  info: "info",
};

export default function ProjectsPage() {
  const router = useRouter();
  const can = useCan();
  const dashboard = useDashboard(can("infra.servers:read"));
  const firstLeaf = flattenNavigation(useNavigation())[0]?.href;

  // `/websites/sites?q=` redirects here with its search intact.
  const params = useSearchParams();
  const [search, setSearch] = React.useState(() => params.get("q") ?? "");
  const q = React.useDeferredValue(search.trim());
  const { audience, account, preview } = useModes();
  const canRead = can("websites.sites:read");
  // A role without projects (e.g. viewer) starts on the first page it can see.
  React.useEffect(() => {
    if (!canRead && firstLeaf && firstLeaf !== "/") router.replace(firstLeaf);
  }, [canRead, firstLeaf, router]);
  const sites = useSites(
    { per_page: 100, sort: "updated_at", order: "desc", ...(q ? { q } : {}) },
    canRead,
  );
  const rows = sites.data?.data ?? [];

  const [creating, setCreating] = React.useState(false);
  const canCreate = can("websites.sites:write");
  useOpenFromQuery("new", () => setCreating(true), canCreate);

  const firstRun = canRead && !sites.isLoading && !sites.isError && rows.length === 0 && q === "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Projects"
        actions={
          <DropdownMenu
            trigger={
              <Button variant="primary" size="md" icon={Plus}>
                Add new
              </Button>
            }
            placement="bottom-end"
            label="Add new"
          >
            <MenuItem icon={GitBranch} disabled={!canCreate} onSelect={() => setCreating(true)}>
              Deploy from Git
            </MenuItem>
            <MenuItem
              icon={PackageCheck}
              disabled={!can("apps.installs:write")}
              onSelect={() => router.push("/apps")}
            >
              Install an app
            </MenuItem>
            <MenuItem
              icon={Database}
              disabled={!can("databases.postgres:write")}
              onSelect={() => router.push("/databases/postgres")}
            >
              Add a database
            </MenuItem>
            <MenuItem
              icon={ServerIcon}
              disabled={!can("infra.servers:write")}
              onSelect={() => router.push("/infrastructure/servers?new=1")}
            >
              Add a server
            </MenuItem>
          </DropdownMenu>
        }
      />

      <PageBody>
        {/* The checklist leads only until there is a project; then the projects do. */}
        {firstRun && <GettingStarted />}
        <AttentionStrip items={dashboard.data?.attention ?? []} />

        {!canRead && (
          <EmptyState
            title="Projects aren't part of your role"
            description="Ask an owner for access. What your role can see is in the sidebar."
            size="sm"
          />
        )}

        {canRead && !firstRun && (
          <SearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch("")}
            placeholder="Search projects"
            aria-label="Search projects"
            className="max-w-sm"
          />
        )}

        {sites.isError && (
          <PageError error={sites.error} onRetry={() => void sites.refetch()} context="Projects" />
        )}

        {sites.isLoading && (
          <ProjectGrid>
            {[0, 1, 2].map((index) => (
              <li key={index} className="min-w-0">
                <Card padding="md" className="flex flex-col gap-3">
                  <Skeleton
                    className="h-4 w-40"
                    label={index === 0 ? "Loading projects" : undefined}
                  />
                  <Skeleton className="h-3 w-56" />
                  <Skeleton className="h-3 w-32" />
                </Card>
              </li>
            ))}
          </ProjectGrid>
        )}

        {firstRun && (
          <EmptyState
            icon={Rocket}
            title="No projects yet"
            description="Point Kaname at a git repository and a domain, and it serves the site from one of your servers."
            action={
              canCreate ? (
                <Button variant="primary" icon={GitBranch} onClick={() => setCreating(true)}>
                  Deploy from Git
                </Button>
              ) : undefined
            }
          />
        )}

        {!sites.isLoading && !sites.isError && rows.length === 0 && q !== "" && (
          <EmptyState
            title="No matching projects"
            description={`Nothing is named or served on "${q}".`}
            size="sm"
          />
        )}

        {rows.length > 0 && (
          <ProjectGrid>
            {rows.map((site) => (
              <ProjectCard key={site.id} site={site} />
            ))}
          </ProjectGrid>
        )}

        {!firstRun && <GettingStarted />}
        {can("infra.servers:read") && <YunoriSuggestion />}

        {/* A client's allowance, set by its reseller (KD-039). */}
        {audience === "client" && account?.usage && (
          <Card padding="md" className="flex flex-col gap-2">
            <h2 className="kn-title">Usage</h2>
            <QuotaMeters
              quota={preview ? null : (account.quota ?? null)}
              usage={account.usage}
              compact
            />
          </Card>
        )}
      </PageBody>

      <SiteDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function ProjectGrid({ children }: { children: React.ReactNode }) {
  return (
    <ul
      aria-label="Projects"
      className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3"
    >
      {children}
    </ul>
  );
}

/**
 * The whole card opens the project; the name link stretches over it, so
 * the domain link inside stays a separate, working anchor.
 */
function ProjectCard({ site }: { site: Site }) {
  const last = site.last_deployment;
  const sha = shortSha(last?.commit_sha ?? null);

  return (
    <li className="min-w-0">
      <Card
        padding="md"
        interactive
        className="relative flex h-full min-w-0 flex-col gap-3"
        data-testid="project-card"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Dot
            tone={siteStatusTone(site.status)}
            pulse={site.status === "provisioning"}
            label={site.status}
          />
          <Link
            href={`/websites/sites/${site.id}`}
            className={cn(
              "min-w-0 truncate font-medium text-[var(--kn-text)] outline-none",
              "after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:outline-2 focus-visible:after:outline-[var(--kn-ring)]",
            )}
          >
            {site.name}
          </Link>
          {site.status !== "active" && (
            <span className="shrink-0 text-xs text-[var(--kn-text-3)]">{site.status}</span>
          )}
        </div>

        {site.primary_domain ? (
          <a
            href={`https://${site.primary_domain}`}
            target="_blank"
            rel="noreferrer"
            className="relative z-[1] min-w-0 self-start truncate text-sm text-[var(--kn-text-2)] hover:underline"
          >
            <MonoText>{site.primary_domain}</MonoText>
          </a>
        ) : (
          <span className="text-sm text-[var(--kn-text-3)]">No domain</span>
        )}

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--kn-text-2)]">
          {last ? (
            <>
              <DeploymentStatusBadge status={last.status} />
              {sha && <MonoText>{sha}</MonoText>}
              {last.branch && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranch size={12} aria-hidden className="shrink-0" />
                  <MonoText truncate>{last.branch}</MonoText>
                </span>
              )}
              <RelativeTime value={last.created_at} className="text-[var(--kn-text-3)]" />
            </>
          ) : (
            <span className="text-[var(--kn-text-3)]">Not deployed yet</span>
          )}
        </div>

        <div className="mt-auto flex min-w-0 items-center gap-2 text-xs text-[var(--kn-text-3)]">
          <span>
            {RUNTIME_LABELS[site.runtime]}
            {site.runtime_version ? ` ${site.runtime_version}` : ""}
          </span>
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{site.server_name}</span>
        </div>
      </Card>
    </li>
  );
}

/** Shown only when something is wrong; each row opens the thing to fix. */
function AttentionStrip({ items }: { items: readonly Attention[] }) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="needs-attention" className="flex min-w-0 flex-col gap-2">
      <h2 id="needs-attention" className="text-sm font-medium text-[var(--kn-text)]">
        Needs attention <span className="text-[var(--kn-text-3)]">{items.length}</span>
      </h2>
      {/* About five rows, then it scrolls, so a long list never pushes the projects away. */}
      <Card padding="none" className="max-h-52 overflow-y-auto">
        <ul className="m-0 list-none p-0">
          {items.map((item, position) => {
            const Icon = ATTENTION_ICONS[item.kind];
            const tone = SEVERITY_TONE[item.severity];
            return (
              <li
                key={`${item.kind}-${item.server_id ?? "fleet"}-${position}`}
                className="border-b border-[var(--kn-border-subtle)] last:border-b-0"
              >
                <Link
                  href={item.href}
                  className="flex min-w-0 items-center gap-3 px-4 py-2 text-sm outline-none hover:bg-[var(--kn-surface-2)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
                >
                  <Icon
                    size={14}
                    aria-hidden
                    className={cn(
                      "shrink-0",
                      tone === "danger" && "text-[var(--kn-danger)]",
                      tone === "warn" && "text-[var(--kn-warn)]",
                      tone === "info" && "text-[var(--kn-info)]",
                    )}
                  />
                  <span className="min-w-0 truncate font-medium text-[var(--kn-text)]">
                    {item.title}
                  </span>
                  <span className="hidden min-w-0 flex-1 truncate text-[var(--kn-text-3)] md:inline">
                    {item.detail}
                  </span>
                  <RelativeTime
                    value={item.since}
                    className="ml-auto shrink-0 text-xs text-[var(--kn-text-3)]"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}
