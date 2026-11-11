"use client";

import * as React from "react";
import { APP_CATEGORY_LABELS, type AppRecipe } from "@kaname/contract";
import { Badge, Button, Card, CardInset, MonoLabel, Tooltip } from "@kaname/ui";
import { AppMark, versionLabel } from "./AppMark";

/* ------------------------------------------------------------------ *
 * One catalog tile: the line mark on a blueprint inset, the name, one
 * sentence, what it needs, and the pill. An app the agent cannot
 * provision yet stays visible — people should know it is coming — with
 * the reason one hover away and no button that pretends otherwise.
 * ------------------------------------------------------------------ */

export interface AppCardProps {
  app: AppRecipe;
  canInstall: boolean;
  onInstall: (app: AppRecipe) => void;
}

export function AppCard({ app, canInstall, onInstall }: AppCardProps) {
  const available = app.availability === "available";
  const req = app.requirements;
  const needs = [
    req.runtime === "php" ? `PHP ${req.runtime_version ?? ""}`.trim() : req.runtime,
    req.database ? req.database.engines.join(" / ") : "no database",
  ];

  return (
    <Card
      radius="xl"
      padding="md"
      className="flex min-w-0 flex-col"
      data-testid={`app-card-${app.id}`}
      aria-labelledby={`app-${app.id}-name`}
    >
      <CardInset
        grid
        className={
          available
            ? "flex h-32 items-center justify-center text-[var(--kn-accent-400)]"
            : "flex h-32 items-center justify-center text-[var(--kn-text-3)]"
        }
      >
        <AppMark appId={app.id} size={56} />
      </CardInset>

      <div className="mt-4 flex items-center justify-between gap-2">
        <MonoLabel size="xs" tone="muted">
          {APP_CATEGORY_LABELS[app.category]}
        </MonoLabel>
        {available ? (
          <Badge mono size="xs">
            {versionLabel(app.version)}
          </Badge>
        ) : (
          <Badge tone="info" size="xs">
            Coming soon
          </Badge>
        )}
      </div>
      <h3 id={`app-${app.id}-name`} className="kn-title m-0 mt-1.5 text-lg text-[var(--kn-text)]">
        {app.name}
      </h3>
      <p className="m-0 mt-1 flex-1 text-sm text-[var(--kn-text-2)]">{app.tagline}</p>

      <p className="kn-mono m-0 mt-3 truncate text-xs text-[var(--kn-text-3)]">{needs.join(" · ")}</p>

      <div className="mt-4 flex items-center justify-between gap-2">
        {available ? (
          <Button
            variant="primary"
            size="sm"
            arrow
            disabled={!canInstall}
            onClick={() => onInstall(app)}
            aria-label={`Install ${app.name}`}
          >
            Install
          </Button>
        ) : (
          <Tooltip content={app.unavailable_reason ?? "Not available yet."}>
            <span tabIndex={0} className="inline-flex">
              <Button size="sm" disabled aria-label={`${app.name} is coming soon`}>
                Coming soon
              </Button>
            </span>
          </Tooltip>
        )}
        <a
          href={app.homepage}
          target="_blank"
          rel="noreferrer noopener"
          className="kn-label-sm text-[var(--kn-text-3)] outline-none hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
        >
          Website
        </a>
      </div>
    </Card>
  );
}
