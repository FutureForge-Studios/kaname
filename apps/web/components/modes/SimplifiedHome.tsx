"use client";

import * as React from "react";
import { Archive, Globe, Mail, PackageCheck } from "lucide-react";
import {
  Button,
  CheckItem,
  CheckList,
  NumberedSection,
  PageBody,
  PageHero,
  Skeleton,
  StatusLine,
  type Tone,
} from "@kaname/ui";
import { formatCount } from "@/lib/format";
import { useCan, useDashboard, useSession } from "@/lib/queries";
import { useViewMode } from "@/lib/modes";
import { YUNORI, useMailPresence } from "@/components/YunoriMail";
import { TaskCard } from "./shared";

/* ------------------------------------------------------------------ *
 * Simplified home: the four things most people came to do, and one
 * sentence on whether anything is wrong. The Command Center is one
 * click away in Advanced; nothing here is a different API.
 * ------------------------------------------------------------------ */

export function SimplifiedHome() {
  const can = useCan();
  const { session } = useSession();
  const { setViewMode } = useViewMode();
  const dashboard = useDashboard();
  const summary = dashboard.data;
  const first = session?.user?.name?.split(/\s+/)[0];
  const mail = useMailPresence();

  const tasks = [
    {
      href: "/websites/sites?new=1",
      icon: Globe,
      title: "Create a website",
      description: "Point a domain at a new site. Kaname writes the server config and the certificate.",
      show: can("websites.sites:write"),
    },
    {
      href: "/apps",
      icon: PackageCheck,
      title: "Install an app",
      description: "WordPress, DokuWiki and more in one step: site, database and HTTPS together.",
      show: true,
    },
    // With no mail server yet, the mail task is deploying one; a mailbox
    // needs a server to live on.
    mail.known && mail.count === 0
      ? {
          href: YUNORI.deploy_href,
          icon: Mail,
          title: "Host your own mail",
          description: "Deploy Yunori Mail Server on a host you manage. Kaname checks its DNS for you.",
          show: mail.canDeploy,
        }
      : {
          href: "/email/mailboxes?new=1",
          icon: Mail,
          title: "Add a mailbox",
          description: "A new address on one of your mail domains, with its password shown once.",
          show: can("email.mailboxes:write"),
        },
    {
      href: "/backups",
      icon: Archive,
      title: "Back up now",
      description: "See when everything was last saved and run a backup before a big change.",
      show: can("backups.schedules:read"),
    },
  ].filter((task) => task.show);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="simplified-home">
      <header className="kn-crosshairs shrink-0 border-b border-[var(--kn-border)] px-6 py-8">
        <PageHero
          size="md"
          eyebrow="Home"
          title={first ? `Hello, ${first}.` : "Hello."}
          accent="What would you like to do?"
          lede="The everyday tasks, one click each. Switch to Advanced in the top bar for the full Command Center."
          status={summary ? <HealthLine summary={summary} /> : <Skeleton className="h-4 w-64" />}
        />
      </header>

      <PageBody gap="lg">
        <NumberedSection index={1} title="Get things done" caption="Each opens the right form.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tasks.map((task) => (
              <TaskCard
                key={task.href}
                href={task.href}
                icon={task.icon}
                title={task.title}
                description={task.description}
              />
            ))}
          </div>
        </NumberedSection>

        <NumberedSection
          index={2}
          title="Health"
          caption="Anything that needs you shows up here."
          actions={
            <Button size="sm" variant="ghost" arrow onClick={() => setViewMode("advanced")}>
              Switch to Advanced
            </Button>
          }
        >
          {summary ? (
            <CheckList divided="between">
              <CheckItem
                state={summary.fleet.servers_connected === summary.fleet.servers_total ? "done" : "warning"}
                title="Servers"
                description={`${formatCount(summary.fleet.servers_connected)} of ${formatCount(summary.fleet.servers_total)} connected${summary.fleet.servers_unhealthy > 0 ? ` · ${summary.fleet.servers_unhealthy} unhealthy` : ""}`}
              />
              <CheckItem
                state={summary.certificates_expiring.length === 0 ? "done" : "warning"}
                title="Certificates"
                description={
                  summary.certificates_expiring.length === 0
                    ? "Nothing expiring soon. Renewal is automatic."
                    : `${summary.certificates_expiring.length} expiring soon — the soonest in ${Math.min(...summary.certificates_expiring.map((c) => c.days_left))} days.`
                }
              />
              <CheckItem
                state={summary.backups.failing_schedules === 0 ? "done" : "warning"}
                title="Backups"
                description={
                  summary.backups.failing_schedules === 0
                    ? summary.backups.last_success_at
                      ? "Every schedule's last run succeeded."
                      : "No backup has run yet."
                    : `${summary.backups.failing_schedules} schedule${summary.backups.failing_schedules === 1 ? " is" : "s are"} failing.`
                }
              />
              <CheckItem
                state={summary.fleet.open_alerts === 0 ? "done" : "warning"}
                title="Alerts"
                description={
                  summary.fleet.open_alerts === 0
                    ? "No open alerts."
                    : `${summary.fleet.open_alerts} open — see Monitoring.`
                }
              />
            </CheckList>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </NumberedSection>
      </PageBody>
    </div>
  );
}

function HealthLine({ summary }: { summary: NonNullable<ReturnType<typeof useDashboard>["data"]> }) {
  const { fleet, attention } = summary;
  const critical = attention.some((item) => item.severity === "critical");
  const tone: Tone =
    critical || fleet.servers_unhealthy > 0
      ? "danger"
      : attention.length > 0 || fleet.open_alerts > 0
        ? "warn"
        : "ok";
  return (
    <StatusLine tone={tone} pulse={tone === "ok"}>
      {tone === "ok"
        ? "Everything is running normally"
        : `${formatCount(attention.length || fleet.open_alerts)} thing${(attention.length || fleet.open_alerts) === 1 ? "" : "s"} to look at`}
    </StatusLine>
  );
}
