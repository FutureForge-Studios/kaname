"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import {
  FEATURED_SERVER_APPS,
  GETTING_STARTED_HINT,
  YUNORI_MAIL_HINT,
  type FeaturedServerApp,
  type MailServer,
  type UserPreferences,
} from "@kaname/contract";
import {
  Button,
  Card,
  CardInset,
  CheckItem,
  CheckList,
  Eyebrow,
  IconButton,
  StatusLine,
} from "@kaname/ui";
import { AppMark } from "@/components/installer/AppMark";
import { api } from "@/lib/api";
import { useCan, useDashboard, useList, useResourceMutation, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Yunori Mail Server, as the rest of the panel mentions it.
 *
 * Mail is its own module (KD-034); these are the few places outside it
 * that say it exists: the installer's featured card, the Simplified
 * home's mail task, a one-time suggestion on the Command Center. The
 * copy comes from the contract's FEATURED_SERVER_APPS entry so every
 * mention says the same factual things.
 *
 * Every call to action is behind `email.servers:write`, the permission
 * the deploy itself needs; whether a server exists is read with the
 * same list query (same cache key) the Email page uses.
 * ------------------------------------------------------------------ */

export const YUNORI: FeaturedServerApp = FEATURED_SERVER_APPS.find(
  (app) => app.id === "yunori-mail",
)!;

export interface MailPresence {
  /** The caller may read mail servers at all. */
  readable: boolean;
  /** The caller may deploy one. */
  canDeploy: boolean;
  /** Still finding out; render nothing that depends on it. */
  loading: boolean;
  /** Known for certain: false while loading, unreadable or failed. */
  known: boolean;
  count: number;
  first: MailServer | null;
}

export function useMailPresence(): MailPresence {
  const can = useCan();
  const readable = can("email.servers:read");
  const query = useList<MailServer>(
    "mail-servers",
    { per_page: 1, sort: "server_name", order: "asc" },
    { enabled: readable },
  );
  return {
    readable,
    canDeploy: can(YUNORI.permission),
    loading: readable && query.isLoading,
    known: readable && query.isSuccess,
    count: query.data?.meta.total ?? 0,
    first: query.data?.data[0] ?? null,
  };
}

/** "Running on mail-01", or the count when there is more than one. */
export function runningOn(presence: MailPresence): string {
  if (presence.count > 1) return `Running on ${presence.count} hosts`;
  return `Running on ${presence.first?.server_name ?? "one host"}`;
}

/** What Kaname does for a Yunori Mail Server, as the ffstudios check list. */
export function YunoriSetupList({ divided = "between" }: { divided?: boolean | "between" }) {
  return (
    <CheckList divided={divided}>
      {YUNORI.setup.map((item) => (
        <CheckItem key={item.title} title={item.title} description={item.description} />
      ))}
    </CheckList>
  );
}

/**
 * The Command Center's one-time suggestion: only with no mail server,
 * only for someone who can deploy one, and gone for good once closed
 * (kept on the account, like Getting Started). While Getting Started
 * is on the page with its own "Set up email" step, that step says it
 * and this stays away, so the page never asks twice.
 */
export function YunoriSuggestion() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const presence = useMailPresence();
  const [hidden, setHidden] = React.useState(false);
  const dashboard = useDashboard();
  const dismissed = session?.preferences?.dismissed_hints ?? [];
  const checklistHasMail =
    !dismissed.includes(GETTING_STARTED_HINT) &&
    (dashboard.data?.onboarding ?? []).some((step) => step.id === "mail_server_installed");

  const dismiss = useResourceMutation<void, UserPreferences>({
    mutationFn: () =>
      api.patch<UserPreferences>("/auth/preferences", {
        dismissed_hints: [...dismissed, YUNORI_MAIL_HINT],
      }),
    onDone: () => void refresh(),
  });

  if (
    hidden ||
    !session ||
    dismissed.includes(YUNORI_MAIL_HINT) ||
    !dashboard.data ||
    checklistHasMail ||
    !presence.canDeploy ||
    !presence.known ||
    presence.count > 0
  ) {
    return null;
  }

  return (
    <Card
      padding="md"
      className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center"
      aria-labelledby="yunori-suggestion-title"
      data-testid="yunori-suggestion"
    >
      <CardInset
        grid
        className="hidden h-16 w-16 shrink-0 items-center justify-center text-[var(--kn-accent-400)] sm:flex"
      >
        <AppMark appId={YUNORI.id} size={36} />
      </CardInset>
      <div className="min-w-0 flex-1">
        <Eyebrow>Host your own mail</Eyebrow>
        <p id="yunori-suggestion-title" className="kn-title m-0 mt-2 text-md text-[var(--kn-text)]">
          {YUNORI.name} runs on a host you already manage.
        </p>
        <p className="m-0 mt-0.5 text-sm text-[var(--kn-text-2)]">
          Kaname deploys it, then keeps its domains, mailboxes, aliases and DNS checklist here.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="primary" size="sm" arrow onClick={() => router.push(YUNORI.deploy_href)}>
          Deploy mail server
        </Button>
        <IconButton
          icon={X}
          label="Dismiss mail server suggestion"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => {
            setHidden(true);
            dismiss.mutate();
          }}
        />
      </div>
    </Card>
  );
}

/**
 * Running state for a card or hero: the host it is on, or nothing while
 * that is unknown.
 */
export function YunoriRunningLine({ presence }: { presence: MailPresence }) {
  if (!presence.known || presence.count === 0) return null;
  return <StatusLine tone="ok">{runningOn(presence)}</StatusLine>;
}
