"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FEATURED_APP_CATEGORY_LABELS, type FeaturedServerApp } from "@kaname/contract";
import { Badge, Button, Card, CardInset, MonoLabel, StatusLine } from "@kaname/ui";
import { YunoriSetupList, runningOn, useMailPresence } from "@/components/YunoriMail";
import { AppMark } from "./AppMark";

/* ------------------------------------------------------------------ *
 * The catalog's featured card: a server app that is not a website.
 *
 * It looks like part of the gallery but installs nothing itself — the
 * pill hands off to the module that owns the deploy (for Yunori Mail
 * Server, the Email page's deploy form), and once one is running it
 * says where and links there instead. Without the deploy permission it
 * stays a read-only description.
 * ------------------------------------------------------------------ */

export interface FeaturedAppCardProps {
  app: FeaturedServerApp;
}

export function FeaturedAppCard({ app }: FeaturedAppCardProps) {
  const router = useRouter();
  const presence = useMailPresence();
  const running = presence.known && presence.count > 0;

  let action: React.ReactNode = null;
  let status: React.ReactNode = null;
  if (running) {
    status = <StatusLine tone="ok">{runningOn(presence)}</StatusLine>;
    action = (
      <Button variant="primary" size="md" arrow onClick={() => router.push(app.open_href)}>
        Open mail
      </Button>
    );
  } else if (presence.canDeploy) {
    action = (
      <Button
        variant="primary"
        size="md"
        arrow
        disabled={presence.loading}
        onClick={() => router.push(app.deploy_href)}
        aria-label={`Deploy ${app.name}`}
      >
        Deploy mail server
      </Button>
    );
  } else if (presence.known) {
    status = (
      <StatusLine tone="neutral">Not deployed · an operator deploys it from Email</StatusLine>
    );
  }

  return (
    <Card
      radius="xl"
      padding="lg"
      className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      data-testid={`featured-app-${app.id}`}
      aria-labelledby={`featured-${app.id}-name`}
    >
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center justify-between gap-3">
          <MonoLabel size="xs" tone="muted">
            Featured · {FEATURED_APP_CATEGORY_LABELS[app.category]}
          </MonoLabel>
          <Badge size="xs">Server app</Badge>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <CardInset
            grid
            className="flex h-16 w-16 shrink-0 items-center justify-center text-[var(--kn-accent-400)]"
          >
            <AppMark appId={app.id} size={40} />
          </CardInset>
          <div className="min-w-0">
            <h2
              id={`featured-${app.id}-name`}
              className="kn-title m-0 text-xl text-[var(--kn-text)]"
            >
              {app.name}
            </h2>
            <p className="m-0 mt-0.5 text-sm text-[var(--kn-text-2)]">{app.tagline}</p>
          </div>
        </div>
        <p className="m-0 mt-4 text-sm text-[var(--kn-text-2)]">{app.description}</p>
        <p className="kn-mono m-0 mt-3 text-xs text-[var(--kn-text-3)]">
          a paired host · an A record for mail.&lt;domain&gt; · outbound port 25 or a relay
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-3 pt-5">
          {action}
          <a
            href={app.homepage}
            target="_blank"
            rel="noreferrer noopener"
            className="kn-label-sm text-[var(--kn-text-3)] outline-none hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
          >
            Website
          </a>
        </div>
        {status && <div className="mt-3">{status}</div>}
      </div>
      <div className="min-w-0">
        <MonoLabel size="xs" tone="subtle">
          What Kaname sets up
        </MonoLabel>
        <div className="mt-1">
          <YunoriSetupList />
        </div>
      </div>
    </Card>
  );
}
