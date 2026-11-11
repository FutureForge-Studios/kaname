"use client";

import { Globe, Mail, MailCheck, Plus } from "lucide-react";
import { LinkButton, type ResourcePrerequisite } from "@/components/ResourcePage";
import { Card, CheckItem, CheckList } from "@kaname/ui";
import { useCan } from "@/lib/queries";
import { useMailDomains, useMailServers, useMailboxes } from "./queries";

/* ------------------------------------------------------------------ *
 * What an Email list needs before it can have rows.
 *
 * Mail is a chain: a Yunori Mail Server, then a domain on it, then a
 * mailbox on the domain, then an alias for the mailbox. An empty list
 * whose parent does not exist yet points at the parent, because its
 * own create form would have nothing to offer.
 * ------------------------------------------------------------------ */

export type MailLevel = "server" | "domain" | "mailbox";

const ONE: { per_page: number } = { per_page: 1 };

export function useMailPrerequisite(needs: MailLevel): ResourcePrerequisite | null {
  const can = useCan();
  const servers = useMailServers();
  const domains = useMailDomains(ONE, needs !== "server");
  const mailboxes = useMailboxes(ONE, needs === "mailbox");

  const none = (query: { isLoading: boolean; isError: boolean; data?: { data: unknown[] } }) =>
    !query.isLoading && !query.isError && (query.data?.data.length ?? 0) === 0;

  if (none(servers)) {
    const canDeploy = can("email.servers:write");
    return {
      icon: MailCheck,
      title: "Deploy a mail server first",
      description:
        "Everything in Email lives on a Yunori Mail Server on one of your hosts. Deploy one, or adopt one you installed by hand.",
      action: canDeploy ? (
        <LinkButton href="/email?deploy=1" icon={Plus}>
          Deploy Yunori Mail Server
        </LinkButton>
      ) : undefined,
      secondaryAction: canDeploy ? (
        <LinkButton href="/email?adopt=1" variant="secondary">
          Adopt one installed by hand
        </LinkButton>
      ) : undefined,
    };
  }

  if (needs === "server") return null;

  if (none(domains)) {
    return {
      icon: Globe,
      title: "Add a mail domain first",
      description:
        "A mailbox is an address on a domain the mail server accepts mail for. Add one and Yunori tells you the DNS records to publish.",
      action: can("email.mailboxes:write") ? (
        <LinkButton href="/email/domains?new=1" icon={Plus}>
          Add mail domain
        </LinkButton>
      ) : undefined,
    };
  }

  if (needs === "domain") return null;

  if (none(mailboxes)) {
    return {
      icon: Mail,
      title: "Create a mailbox first",
      description:
        "An alias delivers into a mailbox on the same domain, so it needs one to point at.",
      action: can("email.mailboxes:write") ? (
        <LinkButton href="/email/mailboxes?new=1" icon={Plus}>
          Create mailbox
        </LinkButton>
      ) : undefined,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * The chain, drawn.
 * ------------------------------------------------------------------ */

const CHAIN: { level: MailLevel | "alias"; title: string; description: string }[] = [
  {
    level: "server",
    title: "A Yunori Mail Server",
    description: "Deployed on one of your hosts, or adopted from a hand install.",
  },
  {
    level: "domain",
    title: "A mail domain",
    description: "A domain the server accepts mail for, with its DNS records published.",
  },
  {
    level: "mailbox",
    title: "A mailbox",
    description: "An account people sign in to, on that domain.",
  },
  {
    level: "alias",
    title: "An alias",
    description: "A second address that delivers into a mailbox.",
  },
];

const ORDER = ["server", "domain", "mailbox", "alias"] as const;

/**
 * Where this list sits in the mail chain while something before it is
 * missing: what exists (done), the link to make next (current), and
 * what waits on it (todo). Renders nothing once the chain is complete.
 */
export function MailChainChecklist({
  needs,
  prerequisite,
}: {
  /** The level this page lists. */
  needs: "domain" | "mailbox" | "alias";
  prerequisite: ResourcePrerequisite | null;
}) {
  if (!prerequisite) return null;
  const missing = prerequisite.icon === MailCheck ? 0 : prerequisite.icon === Globe ? 1 : 2;
  const upTo = ORDER.indexOf(needs);
  return (
    <Card padding="none" className="px-4">
      <CheckList divided="between" aria-label="What email needs first">
        {CHAIN.slice(0, upTo + 1).map((step, index) => (
          <CheckItem
            key={step.level}
            className="py-2.5"
            state={index < missing ? "done" : index === missing ? "current" : "todo"}
            title={step.title}
            description={step.description}
          />
        ))}
      </CheckList>
    </Card>
  );
}
