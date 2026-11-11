"use client";

import * as React from "react";
import Link from "next/link";
import { Database, Globe, Link2, Mail, PackageCheck } from "lucide-react";
import type { QuotaUsage } from "@kaname/contract";
import {
  Card,
  MonoLabel,
  NumberedSection,
  PageBody,
  PageHero,
  Skeleton,
  StatusLine,
} from "@kaname/ui";
import { formatCount } from "@/lib/format";
import { useCan, useList } from "@/lib/queries";
import type { IconComponent } from "@/lib/icons";
import { useModes } from "@/lib/modes";
import { Fact, QuotaMeters, QuotaStatus, TaskCard } from "./shared";

/* ------------------------------------------------------------------ *
 * Client home: what you have, how much of your allowance it uses, and
 * who to ask for help. Counts come from the ordinary list routes,
 * which already filter by owner for a client (KD-039), so a preview by
 * an operator simply shows the operator's own view of the same lists.
 * ------------------------------------------------------------------ */

function useTotal(resource: string, enabled: boolean): number | null {
  const query = useList<unknown>(resource, { per_page: 1 }, { enabled });
  return query.data ? query.data.meta.total : null;
}

export function ClientHome() {
  const can = useCan();
  const { account, branding, preview } = useModes();

  const sites = useTotal("sites", can("websites.sites:read"));
  const domains = useTotal("domains", can("websites.domains:read"));
  const mailboxes = useTotal("mailboxes", can("email.mailboxes:read"));
  const databases = useTotal("databases", can("databases.mysql:read") || can("databases.postgres:read"));

  const usage: QuotaUsage = account?.usage ?? {
    sites: sites ?? 0,
    domains: domains ?? 0,
    mailboxes: mailboxes ?? 0,
    databases: databases ?? 0,
    disk_mb: 0,
  };
  const quota = preview ? null : (account?.quota ?? null);
  const provider = branding?.display_name ?? null;

  const services: { href: string; icon: IconComponent; label: string; count: number | null }[] = [
    { href: "/websites/sites", icon: Globe, label: "Websites", count: sites },
    { href: "/websites/domains", icon: Link2, label: "Domains", count: domains },
    { href: "/email/mailboxes", icon: Mail, label: "Mailboxes", count: mailboxes },
    { href: "/databases/mysql", icon: Database, label: "Databases", count: databases },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="client-home">
      <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 py-8">
        <PageHero
          size="md"
          eyebrow={provider ?? "Your account"}
          title="Your hosting,"
          accent="at a glance."
          lede={
            provider
              ? `Websites, email and databases ${provider} runs for you. Everything here is yours alone.`
              : "Your websites, email and databases. Everything here is yours alone."
          }
          status={
            account || preview ? (
              <QuotaStatus quota={quota} usage={usage} />
            ) : (
              <Skeleton className="h-4 w-64" />
            )
          }
        />
      </header>

      <PageBody gap="lg">
        <NumberedSection index={1} title="Your services" caption="Open one to manage it.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {services.map((service) => (
              <ServiceTile key={service.href} {...service} />
            ))}
          </div>
        </NumberedSection>

        <NumberedSection
          index={2}
          title="Usage"
          caption={quota ? "Against the allowance your provider set." : "No allowance is set on this account."}
        >
          <Card padding="none" className="px-4">
            <QuotaMeters quota={quota} usage={usage} />
          </Card>
        </NumberedSection>

        <NumberedSection index={3} title="Do more" caption="Common next steps.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <TaskCard
              href="/apps"
              icon={PackageCheck}
              title="Install an app"
              description="A ready-made site with its database and HTTPS, in one step."
            />
            <TaskCard
              href="/websites/sites?new=1"
              icon={Globe}
              title="Create a website"
              description="Point one of your domains at a new site."
            />
            <TaskCard
              href="/email/mailboxes?new=1"
              icon={Mail}
              title="Add a mailbox"
              description="A new address on one of your domains."
            />
          </div>
        </NumberedSection>

        {(branding?.support_email || branding?.support_url) && (
          <NumberedSection index={4} title="Need help?" caption={`${provider} supports this account.`}>
            <Card padding="md" className="max-w-xl">
              {branding.support_email && (
                <Fact label="Email">
                  <a className="kn-mono text-[var(--kn-accent-400)] hover:underline" href={`mailto:${branding.support_email}`}>
                    {branding.support_email}
                  </a>
                </Fact>
              )}
              {branding.support_url && (
                <Fact label="Help centre">
                  <a className="kn-mono text-[var(--kn-accent-400)] hover:underline" href={branding.support_url} target="_blank" rel="noreferrer">
                    {branding.support_url.replace(/^https?:\/\//, "")}
                  </a>
                </Fact>
              )}
            </Card>
          </NumberedSection>
        )}

        {preview && (
          <StatusLine tone="info">
            Preview: counts are your operator account's view of the same lists; a client sees only
            what it owns.
          </StatusLine>
        )}
      </PageBody>
    </div>
  );
}

function ServiceTile({
  href,
  icon: Icon,
  label,
  count,
}: {
  href: string;
  icon: IconComponent;
  label: string;
  count: number | null;
}) {
  return (
    <Link
      href={href}
      className="block rounded-[var(--kn-r-lg)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
    >
      <Card interactive padding="md" className="flex flex-col gap-2">
        <span className="flex items-center justify-between">
          <MonoLabel tone="muted">{label}</MonoLabel>
          <Icon size={15} aria-hidden className="text-[var(--kn-text-3)]" />
        </span>
        <span className="text-[28px] font-medium leading-none tracking-[-0.035em] text-[var(--kn-text)]">
          {count === null ? <Skeleton className="h-7 w-10" /> : formatCount(count)}
        </span>
      </Card>
    </Link>
  );
}
