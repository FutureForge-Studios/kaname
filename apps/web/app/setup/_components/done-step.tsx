"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronRight, Globe, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  OPTIONAL_SETUP_STEPS,
  SETUP_STEP_LABELS,
  type BackupSchedule,
  type Domain,
  type MailServer,
  type OptionalSetupStep,
  type SettingsDocument,
  type SetupState,
  type Site,
  type User,
} from "@kaname/contract";
import { Badge, Button, MonoText, Skeleton } from "@kaname/ui";
import type { PanelAddressApplying } from "@/lib/address";
import { api, type ListResult } from "@/lib/api";
import { Card, StepError, StepHeading, toError, useStepAction } from "./chrome";

/* ------------------------------------------------------------------ *
 * 11. Done — what was set up, read back from the modules themselves
 *
 * The summary is not the wizard's memory of what it did: each line is
 * the module's own list, so a site that was created and then failed,
 * or a schedule somebody deleted in another tab, reads as it really is.
 * ------------------------------------------------------------------ */

const AREA_LINKS: Record<OptionalSetupStep, { href: string; label: string }> = {
  address: { href: "/administration/settings", label: "Settings" },
  website: { href: "/websites/sites", label: "Websites" },
  email: { href: "/email", label: "Email" },
  backups: { href: "/backups", label: "Backups" },
  notifications: { href: "/administration/settings", label: "Settings" },
  team: { href: "/administration/users", label: "Users" },
};

interface Facts {
  sites: ListResult<Site> | null;
  domains: ListResult<Domain> | null;
  mail: ListResult<MailServer> | null;
  schedules: ListResult<BackupSchedule> | null;
  settings: SettingsDocument | null;
  users: ListResult<User> | null;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function describe(step: OptionalSetupStep, facts: Facts, pendingDomain: string): React.ReactNode {
  switch (step) {
    case "address":
      return pendingDomain ? (
        <>
          <MonoText>{pendingDomain}</MonoText>, applied when you finish
        </>
      ) : facts.settings?.acme.email ? (
        <>
          Certificate contact <MonoText>{facts.settings.acme.email}</MonoText>
        </>
      ) : (
        "On this server's address"
      );
    case "website": {
      const site = facts.sites?.data[0];
      if (site) {
        const more = (facts.sites?.meta.total ?? 1) - 1;
        return (
          <>
            <MonoText>{site.primary_domain ?? site.name}</MonoText>
            {more > 0 ? ` and ${plural(more, "more site")}` : ` · ${site.status}`}
          </>
        );
      }
      const domain = facts.domains?.data[0];
      return domain ? (
        <>
          <MonoText>{domain.name}</MonoText>, no website yet
        </>
      ) : (
        "Nothing yet"
      );
    }
    case "email": {
      const server = facts.mail?.data[0];
      return server ? (
        <>
          <MonoText>{server.hostname ?? server.server_name}</MonoText> · {server.status}
        </>
      ) : (
        "No mail server"
      );
    }
    case "backups": {
      const schedule = facts.schedules?.data[0];
      return schedule ? (
        <>
          {schedule.name} to {schedule.destination_name}
        </>
      ) : (
        "Nothing is backed up"
      );
    }
    case "notifications": {
      const channels = facts.settings?.notifications.channels ?? [];
      if (channels.length === 0) return "No channel — alerts show in the panel only";
      const first = channels[0]!;
      return (
        <>
          <MonoText>{first.target}</MonoText>
          {channels.length > 1 ? ` and ${plural(channels.length - 1, "more")}` : ""}
          {first.kind === "email" && !facts.settings?.notifications.smtp.host
            ? " · no mail server set yet"
            : ""}
        </>
      );
    }
    case "team": {
      const others = Math.max(0, (facts.users?.meta.total ?? 1) - 1);
      return others > 0 ? plural(others, "teammate") + " invited" : "Just you";
    }
  }
}

function useFacts(): Facts | null {
  const [facts, setFacts] = React.useState<Facts | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    // Each read is independent: one module refusing must not blank the
    // whole summary.
    const soft = <T,>(promise: Promise<T>) => promise.catch(() => null);
    void Promise.all([
      soft(api.list<Site>("/sites", { params: { per_page: 1 } })),
      soft(api.list<Domain>("/domains", { params: { per_page: 1 } })),
      soft(api.list<MailServer>("/mail-servers", { params: { per_page: 1 } })),
      soft(api.list<BackupSchedule>("/backups/schedules", { params: { per_page: 1 } })),
      soft(api.get<SettingsDocument>("/settings")),
      soft(api.list<User>("/users", { params: { per_page: 1 } })),
    ]).then(([sites, domains, mail, schedules, settings, users]) => {
      if (!cancelled) setFacts({ sites, domains, mail, schedules, settings, users });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return facts;
}

export function DoneStep({ state, onStale }: { state: SetupState; onStale: () => void }) {
  const router = useRouter();
  const facts = useFacts();
  const { pending, error, run } = useStepAction(onStale);
  const [completed, setCompleted] = React.useState(false);
  const [applied, setApplied] = React.useState<PanelAddressApplying | null>(null);
  // Read once: /setup/complete clears it on the server, and "Try again"
  // after a failed apply still needs to know what to apply.
  const [domain] = React.useState(state.pending_domain ?? "");

  const finish = async () => {
    await run(async () => {
      // Completing first, because applying the address takes the control
      // plane down: a /setup/complete sent into that restart is the one
      // request that decides whether this instance counts as set up.
      if (!completed) {
        await api.post<SetupState>("/setup/complete");
        setCompleted(true);
      }
      if (domain) {
        setApplied(await api.post<PanelAddressApplying>("/settings/address", { domain }));
        return;
      }
      router.replace("/");
    });
  };

  if (applied) {
    return (
      <Card>
        <div className="flex flex-col gap-5">
          <StepHeading
            icon={Globe}
            title={`Setting up ${applied.domain}`}
            hint="Kaname is restarting to pick up the name and asking the certificate authority for a certificate. That usually lands inside a minute."
          />
          <p className="text-[var(--kn-text-2)]">
            The address you are on keeps answering throughout, so nothing depends on the certificate
            arriving. Once it does, <MonoText className="text-[var(--kn-text)]">{applied.public_url}</MonoText>{" "}
            answers too — and if the A record is not pointing here yet, correct it and the request
            retries on its own. The new name asks you to sign in once.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kn-border)] pt-5">
            <Button type="button" variant="ghost" size="md" onClick={() => router.replace("/")}>
              Stay on this address
            </Button>
            <Button
              type="button"
              variant="primary"
              size="md"
              iconRight={ArrowRight}
              autoFocus
              onClick={() => window.location.assign(applied.public_url)}
            >
              Open {applied.domain ?? applied.public_url}
            </Button>
          </div>
          <MasterKeyNote />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void finish();
        }}
      >
        <StepHeading
          icon={ShieldCheck}
          title={`${state.instance_name ?? "Kaname"} is ready`}
          hint={`${
            state.servers_connected === 1
              ? "One server is connected."
              : `${state.servers_connected} servers are connected.`
          } Here is what was set up. Every action from now on is recorded in the audit trail.`}
        />

        {facts === null ? (
          <Skeleton className="h-64 rounded-[var(--kn-r-md)]" label="Reading what was set up" />
        ) : (
          <ul className="divide-y divide-[var(--kn-border)] overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)]">
            {OPTIONAL_SETUP_STEPS.map((step) => {
              const outcome = state.outcomes[step];
              const link = AREA_LINKS[step];
              return (
                <li key={step}>
                  <Link
                    href={link.href}
                    className="group flex items-center gap-3 px-4 py-3 outline-none transition-colors duration-[var(--kn-dur-fast)] hover:bg-[var(--kn-surface-3)] focus-visible:bg-[var(--kn-surface-3)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-[var(--kn-text)]">{SETUP_STEP_LABELS[step]}</p>
                      <p className="truncate text-sm text-[var(--kn-text-2)]">
                        {describe(step, facts, domain)}
                      </p>
                    </div>
                    <Badge tone={outcome === "done" ? "ok" : "neutral"} size="xs">
                      {outcome === "done" ? "Set up" : "Later"}
                    </Badge>
                    <span className="sr-only">Open {link.label}</span>
                    <ChevronRight
                      size={14}
                      aria-hidden
                      className="shrink-0 text-[var(--kn-text-3)] group-hover:text-[var(--kn-text-2)]"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        {domain && (
          <p className="text-sm text-[var(--kn-text-2)]">
            Finishing names this panel <MonoText className="text-[var(--kn-text)]">{domain}</MonoText>.
            Kaname restarts once to apply it, and this address keeps working while it does.
          </p>
        )}

        <StepError error={error ? toError(error) : null} />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kn-border)] pt-5">
          <div>
            {error && completed && (
              <Button type="button" variant="ghost" size="md" onClick={() => router.replace("/")}>
                Continue without the domain
              </Button>
            )}
          </div>
          <Button type="submit" variant="primary" size="md" iconRight={ArrowRight} loading={pending} autoFocus>
            {error && completed ? "Try again" : "Open the Command Center"}
          </Button>
        </div>

        <MasterKeyNote />
      </form>
    </Card>
  );
}

function MasterKeyNote() {
  return (
    <p className="flex items-start gap-2 text-sm text-[var(--kn-text-3)]">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
      <span>
        Back up <MonoText>KANAME_MASTER_KEY</MonoText> from the environment file the installer wrote.
        Without it, every credential Kaname stores for you is unrecoverable.
      </span>
    </p>
  );
}
