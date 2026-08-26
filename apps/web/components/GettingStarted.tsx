"use client";

import * as React from "react";
import Link from "next/link";
import { Globe, Server, ShieldCheck, Users, X } from "lucide-react";
import { GETTING_STARTED_HINT, type Permission, type UserPreferences } from "@kaname/contract";
import { IconButton, cn } from "@kaname/ui";
import { api } from "@/lib/api";
import { useCan, useResourceMutation, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * The one nudge.
 *
 * Shown once, after onboarding, and then never again. It is dismissed
 * against the account rather than the browser, so it does not reappear
 * on the next machine — and once closed it does not come back at all,
 * because a suggestion that keeps returning stops being a suggestion.
 * ------------------------------------------------------------------ */

interface Suggestion {
  id: string;
  label: string;
  detail: string;
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  permission: Permission;
}

const SUGGESTIONS: Suggestion[] = [
  {
    id: "servers",
    label: "Add another server",
    detail: "One command on the host. The agent dials out; nothing listens inbound.",
    href: "/infrastructure/servers",
    icon: Server,
    permission: "infra.servers:write",
  },
  {
    id: "sites",
    label: "Publish a site",
    detail: "A vhost, a certificate and a deployment, in one form.",
    href: "/websites/sites",
    icon: Globe,
    permission: "websites.sites:write",
  },
  {
    id: "backups",
    label: "Schedule a backup",
    detail: "Before you need one, not after.",
    href: "/backups",
    icon: ShieldCheck,
    permission: "backups.schedules:write",
  },
  {
    id: "users",
    label: "Invite your team",
    detail: "Roles are scoped per server, so access can be narrow by default.",
    href: "/administration/users",
    icon: Users,
    permission: "admin.users:write",
  },
];

export function GettingStarted() {
  const { session, refresh } = useSession();
  const can = useCan();
  const [hidden, setHidden] = React.useState(false);

  const dismissed = session?.preferences?.dismissed_hints ?? [];
  const visible = SUGGESTIONS.filter((suggestion) => can(suggestion.permission));

  const dismiss = useResourceMutation<void, UserPreferences>({
    mutationFn: () =>
      api.patch<UserPreferences>("/auth/preferences", {
        dismissed_hints: [...dismissed, GETTING_STARTED_HINT],
      }),
    onDone: () => void refresh(),
  });

  if (hidden || dismissed.includes(GETTING_STARTED_HINT) || visible.length === 0) return null;

  return (
    <section
      className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]"
      aria-labelledby="getting-started-heading"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--kn-border)] px-4 py-2">
        <h2 id="getting-started-heading" className="truncate font-medium text-[var(--kn-text)]">
          Next steps
        </h2>
        <IconButton
          icon={X}
          label="Dismiss these suggestions"
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

      <ul className="grid grid-cols-1 gap-px bg-[var(--kn-border)] sm:grid-cols-2 lg:grid-cols-4">
        {visible.map(({ id, label, detail, href, icon: Icon }) => (
          <li key={id} className="bg-[var(--kn-surface)]">
            <Link
              href={href}
              className={cn(
                "flex h-full min-w-0 flex-col gap-1 px-4 py-3 transition-colors duration-150",
                "hover:bg-[var(--kn-surface-2)] focus-visible:bg-[var(--kn-surface-2)]",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--kn-accent)]",
              )}
            >
              <span className="flex items-center gap-2">
                <Icon size={13} className="shrink-0 text-[var(--kn-text-3)]" />
                <span className="truncate text-[var(--kn-text)]">{label}</span>
              </span>
              <span className="text-sm text-[var(--kn-text-3)]">{detail}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Exported for the Command Center's own tests. */
export const GETTING_STARTED_SUGGESTIONS = SUGGESTIONS;
