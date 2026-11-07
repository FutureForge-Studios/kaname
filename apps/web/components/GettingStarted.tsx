"use client";

import * as React from "react";
import Link from "next/link";
import {
  Archive,
  ArrowRight,
  Bell,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Circle,
  Database,
  Globe,
  Mail,
  Server,
  Shield,
  Users,
  X,
} from "lucide-react";
import {
  GETTING_STARTED_HINT,
  type OnboardingStepId,
  type Permission,
  type UserPreferences,
} from "@kaname/contract";
import { IconButton, Progress, cn } from "@kaname/ui";
import { api } from "@/lib/api";
import type { IconComponent } from "@/lib/icons";
import { useCan, useDashboard, useResourceMutation, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Getting Started.
 *
 * A checklist across the whole panel, not a tour. Every tick is a fact
 * the control plane read from its own rows (GET /dashboard → onboarding),
 * so it moves when the operator does the thing anywhere — the CLI, the
 * API, another tab — and it never claims progress the fleet lacks.
 *
 * Two filters decide what is shown. The control plane leaves out steps
 * the caller cannot read; this component then hides steps the caller
 * cannot act on, because a to-do nobody here can do is noise.
 *
 * Collapsed once complete. Hidden for good when the account says so —
 * stored on the account, so it stays hidden on the next machine too.
 * ------------------------------------------------------------------ */

type Area =
  | "Infrastructure"
  | "Websites"
  | "Email"
  | "Databases"
  | "Security"
  | "Backups"
  | "Monitoring"
  | "Administration";

interface StepCopy {
  id: OnboardingStepId;
  area: Area;
  label: string;
  /** One sentence: why this step is worth doing. */
  why: string;
  /** Where the step is done: the page, and where one exists the dialog. */
  href: (can: Can) => string;
  /** Needed to act on the step; without it the step is hidden. */
  permission: Permission | ((can: Can) => boolean) | null;
}

type Can = (permission: Permission) => boolean;

const AREA_ICONS: Record<Area, IconComponent> = {
  Infrastructure: Server,
  Websites: Globe,
  Email: Mail,
  Databases: Database,
  Security: Shield,
  Backups: Archive,
  Monitoring: Bell,
  Administration: Users,
};

const STEPS: readonly StepCopy[] = [
  {
    id: "server_paired",
    area: "Infrastructure",
    label: "Pair a server",
    why: "Its agent dials out to Kaname, so nothing on the host listens inbound.",
    href: () => "/infrastructure/servers?new=1",
    permission: "infra.servers:write",
  },
  {
    id: "agents_connected",
    area: "Infrastructure",
    label: "Get every agent connected",
    why: "A host whose agent is offline can be neither changed nor vouched for.",
    href: () => "/infrastructure/servers",
    permission: "infra.servers:read",
  },
  {
    id: "domain_added",
    area: "Websites",
    label: "Add a domain",
    why: "DNS records, certificates and mail routing all hang off a domain.",
    href: () => "/websites/domains?new=1",
    permission: "websites.domains:write",
  },
  {
    id: "site_created",
    area: "Websites",
    label: "Create a site",
    why: "A vhost Kaname writes and reloads for you, pointing a domain at a webroot.",
    href: () => "/websites/sites?new=1",
    permission: "websites.sites:write",
  },
  {
    id: "certificate_issued",
    area: "Websites",
    label: "Issue a certificate",
    why: "ACME runs on the host, so the site is served over HTTPS and renews itself.",
    href: () => "/websites/ssl?new=1",
    permission: "websites.ssl:write",
  },
  {
    id: "mail_server_installed",
    area: "Email",
    label: "Set up email",
    why: "Yunori Mail Server installs on a host you own, with DNS and certificates checked for you.",
    href: () => "/email?deploy=1",
    permission: "email.servers:write",
  },
  {
    id: "mailbox_created",
    area: "Email",
    label: "Create the first mailbox",
    why: "Its password is generated on the host and shown to you exactly once.",
    href: () => "/email/mailboxes?new=1",
    permission: "email.mailboxes:write",
  },
  {
    id: "database_created",
    area: "Databases",
    label: "Create a database",
    why: "Each one gets its own user and password, never a shared superuser login.",
    href: (can) =>
      can("databases.mysql:write") ? "/databases/mysql?new=1" : "/databases/postgres?new=1",
    permission: (can) => can("databases.mysql:write") || can("databases.postgres:write"),
  },
  {
    id: "firewall_applied",
    area: "Security",
    label: "Apply a firewall",
    why: "Rules are staged here and applied with an automatic rollback if they lock you out.",
    href: () => "/security/firewall",
    permission: "security.firewall:write",
  },
  {
    id: "ssh_key_added",
    area: "Security",
    label: "Register an SSH key",
    why: "Kaname writes authorized_keys from this list, so password logins can go.",
    href: () => "/security/ssh?new=1",
    permission: "security.ssh:write",
  },
  {
    id: "backup_destination_added",
    area: "Backups",
    label: "Add a backup destination",
    why: "Somewhere off the host for encrypted snapshots: an object store or an SFTP server.",
    href: () => "/backups?tab=destinations&new=1",
    permission: "backups.schedules:write",
  },
  {
    id: "backup_succeeded",
    area: "Backups",
    label: "Take a first backup",
    why: "A schedule protects nothing until one run has actually succeeded.",
    href: () => "/backups?new=1",
    permission: "backups.schedules:write",
  },
  {
    id: "alert_rule_created",
    area: "Monitoring",
    label: "Create an alert rule",
    why: "A rule watches a metric against a threshold and fires when it stays there.",
    href: () => "/monitoring?tab=rules&new=1",
    permission: "monitoring.alerts:write",
  },
  {
    id: "notification_channel_added",
    area: "Monitoring",
    label: "Configure notifications",
    why: "An alert nobody receives is only a row on this page.",
    href: () => "/administration/settings#notifications",
    permission: "admin.settings:write",
  },
  {
    id: "teammate_invited",
    area: "Administration",
    label: "Add a teammate",
    why: "Roles can be scoped per server, so their access can start narrow.",
    href: () => "/administration/users?invite=1",
    permission: "admin.users:write",
  },
  {
    id: "two_factor_enabled",
    area: "Administration",
    label: "Turn on two-factor",
    why: "A stolen password on its own no longer opens this panel.",
    href: () => "/account#two-factor",
    permission: null,
  },
];

const COLLAPSE_KEY = "kn:getting-started:collapsed";

function readCollapsed(): boolean | null {
  try {
    const value = window.localStorage.getItem(COLLAPSE_KEY);
    return value === null ? null : value === "1";
  } catch {
    return null;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  } catch {
    // A private window keeps the choice for this page view only.
  }
}

interface VisibleStep extends StepCopy {
  done: boolean;
  target: string;
}

export function GettingStarted() {
  const { session, refresh } = useSession();
  const can = useCan();
  const dashboard = useDashboard();
  const [hidden, setHidden] = React.useState(false);
  const [userCollapsed, setUserCollapsed] = React.useState<boolean | null>(null);

  React.useEffect(() => setUserCollapsed(readCollapsed()), []);

  const dismissed = session?.preferences?.dismissed_hints ?? [];

  const steps = React.useMemo<VisibleStep[]>(() => {
    const reported = new Map((dashboard.data?.onboarding ?? []).map((s) => [s.id, s.done]));
    const check: Can = (permission) => can(permission);
    return STEPS.flatMap((step) => {
      const done = reported.get(step.id);
      if (done === undefined) return [];
      const allowed =
        step.permission === null
          ? true
          : typeof step.permission === "function"
            ? step.permission(check)
            : can(step.permission);
      if (!allowed) return [];
      return [{ ...step, done, target: step.href(check) }];
    });
  }, [can, dashboard.data]);

  const groups = React.useMemo(() => {
    const byArea = new Map<Area, VisibleStep[]>();
    for (const step of steps) byArea.set(step.area, [...(byArea.get(step.area) ?? []), step]);
    return [...byArea.entries()];
  }, [steps]);

  const dismiss = useResourceMutation<void, UserPreferences>({
    mutationFn: () =>
      api.patch<UserPreferences>("/auth/preferences", {
        dismissed_hints: [...dismissed, GETTING_STARTED_HINT],
      }),
    onDone: () => void refresh(),
  });

  if (hidden || dismissed.includes(GETTING_STARTED_HINT) || steps.length === 0) return null;

  const doneCount = steps.filter((step) => step.done).length;
  const complete = doneCount === steps.length;
  // Complete collapses by default; an explicit choice wins either way.
  const collapsed = userCollapsed ?? complete;

  const toggle = () => {
    setUserCollapsed(!collapsed);
    writeCollapsed(!collapsed);
  };

  return (
    <section
      className="overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)] shadow-[var(--kn-shadow-sm)]"
      aria-labelledby="getting-started-heading"
    >
      <div
        className={cn(
          "flex min-h-9 items-center gap-3 px-4 py-2",
          !collapsed && "border-b border-[var(--kn-border)]",
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls="getting-started-body"
          className="flex min-w-0 items-center gap-2 rounded-[var(--kn-r-xs)] text-left outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--kn-ring)]"
        >
          {collapsed ? (
            <ChevronRight size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
          )}
          <h2 id="getting-started-heading" className="truncate font-medium text-[var(--kn-text)]">
            Getting started
          </h2>
        </button>

        <span className="kn-num shrink-0 text-sm text-[var(--kn-text-2)]">
          {complete ? `All ${steps.length} done` : `${doneCount} of ${steps.length} done`}
        </span>
        <Progress
          value={doneCount}
          max={steps.length}
          size="sm"
          label={`Getting started: ${doneCount} of ${steps.length} done`}
          className="hidden w-32 sm:block"
        />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <IconButton
            icon={X}
            label="Hide Getting started for this account"
            size="xs"
            loading={dismiss.isPending}
            onClick={() => {
              // Hidden immediately: waiting on a round trip to close
              // something the operator asked to close reads as broken.
              setHidden(true);
              dismiss.mutate();
            }}
          />
        </div>
      </div>

      {!collapsed && (
        <div
          id="getting-started-body"
          className="grid grid-cols-1 gap-px bg-[var(--kn-border)] md:grid-cols-2 xl:grid-cols-4"
        >
          {groups.map(([area, items]) => (
            <AreaGroup key={area} area={area} items={items} />
          ))}
          {/* Fill the last row so the hairline grid does not show a hole. */}
          {Array.from({ length: (4 - (groups.length % 4)) % 4 }, (_, index) => (
            <div key={`pad-${index}`} className="hidden bg-[var(--kn-surface)] xl:block" />
          ))}
        </div>
      )}
    </section>
  );
}

function AreaGroup({ area, items }: { area: Area; items: VisibleStep[] }) {
  const Icon = AREA_ICONS[area];
  const done = items.filter((item) => item.done).length;
  const headingId = `getting-started-${area.toLowerCase()}`;

  return (
    <div className="flex min-w-0 flex-col bg-[var(--kn-surface)]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <Icon size={13} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
        <h3 id={headingId} className="truncate text-sm font-medium text-[var(--kn-text-2)]">
          {area}
        </h3>
        <span className="kn-num ml-auto text-xs text-[var(--kn-text-3)]">
          {done}/{items.length}
        </span>
      </div>
      <ul aria-labelledby={headingId} className="flex flex-col pb-2">
        {items.map((item) => (
          <StepRow key={item.id} step={item} />
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step }: { step: VisibleStep }) {
  return (
    <li>
      <Link
        href={step.target}
        className={cn(
          "group/step flex items-start gap-2.5 px-4 py-2 outline-none",
          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          "hover:bg-[var(--kn-surface-2)] focus-visible:bg-[var(--kn-surface-2)]",
          "focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-[var(--kn-ring)]",
        )}
      >
        {step.done ? (
          <CircleCheck size={14} className="mt-0.5 shrink-0 text-[var(--kn-ok)]" aria-hidden />
        ) : (
          <Circle size={14} className="mt-0.5 shrink-0 text-[var(--kn-text-3)]" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "truncate",
                step.done ? "text-[var(--kn-text-2)]" : "font-medium text-[var(--kn-text)]",
              )}
            >
              {step.label}
            </span>
            <span
              className={cn(
                "shrink-0 text-xs",
                step.done ? "text-[var(--kn-ok)]" : "text-[var(--kn-text-3)]",
              )}
            >
              {step.done ? "Done" : "To do"}
            </span>
          </span>
          <span className="mt-0.5 block text-sm text-[var(--kn-text-3)]">{step.why}</span>
        </span>
        <ArrowRight
          size={12}
          className="mt-1 shrink-0 text-[var(--kn-text-3)] opacity-0 transition-opacity duration-[var(--kn-dur-fast)] group-hover/step:opacity-100 group-focus-visible/step:opacity-100"
          aria-hidden
        />
      </Link>
    </li>
  );
}

/** Exported for the Command Center's own tests. */
export const GETTING_STARTED_STEPS = STEPS;
