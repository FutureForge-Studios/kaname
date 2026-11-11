"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpCircle,
  BadgeCheck,
  Download,
  ExternalLink,
  Globe,
  Mail,
  MailCheck,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Job, MailDomain, MailServer } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  IconButton,
  MenuItem,
  MenuSeparator,
  Card,
  CardInset,
  Eyebrow,
  MonoLabel,
  MonoText,
  NumberedSection,
  PageBody,
  PageHeader,
  RelativeTime,
  SectionCard,
  SectionHeader,
  Select,
  Skeleton,
  StatusLine,
  cn,
  type Tone,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { serverPrerequisite, useOpenFromQuery } from "@/components/ResourcePage";
import { formatCount, pluralize } from "@/lib/format";
import { useCan, useServers } from "@/lib/queries";
import { AppMark } from "@/components/installer/AppMark";
import { YUNORI, YunoriSetupList } from "@/components/YunoriMail";
import { HostCell } from "../_components/cells";
import { JobActivityBar } from "../_components/JobActivity";
import { DnsDrawer } from "./_components/DnsDrawer";
import {
  MAIL_JOB_TYPES,
  useForgetMailServer,
  useMailDomains,
  useMailServers,
  useRenewMailCertificate,
  useSyncMailServer,
  useUpdateMailServer,
} from "./_components/queries";
import {
  AdoptDialog,
  DeployDialog,
  FinishSetupPanel,
  type PendingSetup,
} from "./_components/ServerDialogs";
import {
  CHECK_META,
  CertificateStateBadge,
  ChecksList,
  InstallSteps,
  MailCheckBadge,
  MailServerStatusBadge,
  ServiceStates,
  checkTextClass,
  countChecks,
  verdictSentence,
  waitingStep,
} from "./_components/status";

/* ------------------------------------------------------------------ *
 * Mail servers.
 *
 * One card per host running Yunori Mail Server — a card and not a table
 * row because each one carries an install checklist, a services strip
 * and a verdict, and a fleet rarely has more than a handful. Both status
 * axes stay visible and separate: the host's own connection and health
 * from the fleet, and the mail server's verdict from Yunori's doctor.
 * A healthy mail stack on a host whose agent is gone is a different
 * problem from a reachable host whose DKIM is failing, and this page
 * must say which.
 * ------------------------------------------------------------------ */

const HEALTH_OPTIONS = [
  { value: "", label: "Any verdict" },
  { value: "fail", label: "Failing" },
  { value: "warn", label: "Warnings" },
  { value: "pass", label: "Passing" },
  { value: "unknown", label: "Not checked" },
];

export default function MailServersPage() {
  const can = useCan();
  const [health, setHealth] = React.useState("");
  const params = React.useMemo(
    () => ({ per_page: 100, sort: "server_name", order: "asc", health: health || undefined }),
    [health],
  );
  const query = useMailServers(params);

  const [deploying, setDeploying] = React.useState(false);
  const [adopting, setAdopting] = React.useState(false);
  const [pending, setPending] = usePendingSetup();
  const [forgetting, setForgetting] = React.useState<MailServer | null>(null);

  const forget = useForgetMailServer();
  const servers = query.data?.data ?? [];
  const canWrite = can("email.servers:write");

  // Deep links from Getting Started and the other Email pages.
  useOpenFromQuery("deploy", () => setDeploying(true), canWrite);
  useOpenFromQuery("adopt", () => setAdopting(true), canWrite);

  // Yunori runs on a managed host; with none paired there is nothing to deploy to.
  const fleet = useServers();
  const noHost = serverPrerequisite(
    { servers: fleet.data?.data ?? [], isLoading: fleet.isLoading },
    "Yunori Mail Server runs on a host Kaname manages.",
  );

  const deployButton = (
    <Button
      variant="primary"
      size="sm"
      icon={Plus}
      onClick={() => setDeploying(true)}
      disabled={!can("email.servers:write")}
    >
      Deploy Yunori Mail Server
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Email"
        title="Mail servers"
        lede="Yunori Mail Server on hosts you own: Kaname installs it, checks its DNS and certificates, and keeps domains, mailboxes and aliases in one place."
        status={fleetStatus(servers)}
        subtitle={
          servers.length > 0
            ? `${pluralize(servers.length, "host")} running Yunori Mail Server`
            : "Yunori Mail Server on your own hosts"
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              onClick={() => setAdopting(true)}
              disabled={!can("email.servers:write")}
            >
              Adopt existing
            </Button>
            {deployButton}
          </>
        }
      />

      <PageBody className="*:shrink-0">
        {/* shrink-0: this column is a flex container with min-h-0, and with
         * more than one server card the panel (overflow-hidden) was squeezed
         * to nothing, its Reveal button with it. */}
        {pending && (
          <div className="shrink-0">
            <FinishSetupPanel pending={pending} onDismiss={() => setPending(null)} />
          </div>
        )}

        {/* shrink-0 for the same reason as the setup panel: squeezed to a hairline otherwise. */}
        <JobActivityBar types={MAIL_JOB_TYPES} className="shrink-0" />

        <SectionHeader
          index={1}
          title="Servers"
          caption="One card per host, with both status axes: the host's agent, and Yunori's own verdict."
          actions={
            <>
              {query.dataUpdatedAt > 0 && (
                <span className="kn-mono hidden items-center gap-1 text-2xs text-[var(--kn-text-3)] md:inline-flex">
                  synced <RelativeTime value={query.dataUpdatedAt} />
                </span>
              )}
              <Select
                size="sm"
                aria-label="Verdict"
                value={health}
                onChange={(event) => setHealth(event.target.value)}
                boxClassName="w-36"
                options={HEALTH_OPTIONS}
              />
              <IconButton
                icon={RefreshCw}
                label="Refresh"
                size="sm"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              />
            </>
          }
        />

        {query.isError ? (
          <PageError
            error={query.error}
            onRetry={() => void query.refetch()}
            context="Mail servers"
          />
        ) : query.isLoading ? (
          <div className="flex flex-col gap-4" aria-busy>
            <Skeleton className="h-40 rounded-[var(--kn-r-md)]" label="Loading mail servers" />
            <Skeleton className="h-40 rounded-[var(--kn-r-md)]" />
          </div>
        ) : servers.length === 0 && !health && !noHost ? (
          <HostYourOwnMail
            canWrite={canWrite}
            deployButton={deployButton}
            onAdopt={() => setAdopting(true)}
          />
        ) : servers.length === 0 ? (
          <SectionCard>
            {!health && noHost ? (
              <EmptyState
                icon={noHost.icon}
                title={noHost.title}
                description={noHost.description}
                action={noHost.action}
              />
            ) : (
              <EmptyState
                icon={MailCheck}
                title="No mail server matches"
                description="No host's last check came out that way."
                secondaryAction={
                  <Button variant="secondary" size="sm" onClick={() => setHealth("")}>
                    Clear filter
                  </Button>
                }
              />
            )}
          </SectionCard>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {servers.map((server) => (
              <li key={server.id}>
                <MailServerCard server={server} onForget={() => setForgetting(server)} />
              </li>
            ))}
          </ul>
        )}

        {servers.length > 0 && (
          <>
            <DomainsOverview />
            <NumberedSection
              index={3}
              title="Deliverability"
              caption="What receivers will make of your mail, and what the engine is doing now."
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <OverviewLink
                  href={`/email/health${servers[0] ? `?server_id=${servers[0].server_id}` : ""}`}
                  icon={BadgeCheck}
                  title="Mail health"
                  description="Every doctor check with the fix beside it, the TLS certificate, and an on-demand preflight of port 25, reverse DNS and blocklists."
                />
                <OverviewLink
                  href={`/email/logs${servers[0] ? `?server_id=${servers[0].server_id}` : ""}`}
                  icon={ScrollText}
                  title="Mail logs"
                  description="A live tail of the mail engine's log, read straight off the host and filtered there."
                />
              </div>
            </NumberedSection>
          </>
        )}
      </PageBody>

      <DeployDialog
        open={deploying}
        onOpenChange={setDeploying}
        onQueued={(job: Job, serverId: string) => setPending({ job, serverId })}
      />
      <AdoptDialog open={adopting} onOpenChange={setAdopting} />

      <ConfirmDialog
        open={forgetting !== null}
        onOpenChange={(open) => !open && setForgetting(null)}
        title={`Forget the mail server on ${forgetting?.server_name ?? "this host"}?`}
        description="Kaname drops its record of this server, its domains, mailboxes and aliases. Nothing on the host changes: Yunori keeps running and delivering mail. Adopt it again to bring it back."
        confirmText={forgetting?.server_name}
        confirmLabel="Forget"
        loading={forget.isPending}
        onConfirm={() => {
          if (!forgetting) return;
          forget.mutate(
            { id: forgetting.id, server_name: forgetting.server_name },
            { onSuccess: () => setForgetting(null) },
          );
        }}
      />
    </div>
  );
}

/*
 * The first-run state: what Yunori Mail Server is, in the same factual
 * terms the installer's featured card uses, and what Kaname sets up for
 * it. Only someone who can deploy gets the pills.
 */
function HostYourOwnMail({
  canWrite,
  deployButton,
  onAdopt,
}: {
  canWrite: boolean;
  deployButton: React.ReactNode;
  onAdopt: () => void;
}) {
  return (
    <Card
      radius="xl"
      padding="lg"
      className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      aria-labelledby="host-your-own-mail"
    >
      <div className="flex min-w-0 flex-col items-start">
        <Eyebrow>Host your own mail</Eyebrow>
        <div className="mt-5 flex items-center gap-4">
          <CardInset
            grid
            className="flex h-16 w-16 shrink-0 items-center justify-center text-[var(--kn-accent-400)]"
          >
            <AppMark appId={YUNORI.id} size={40} />
          </CardInset>
          <div className="min-w-0">
            <h3 id="host-your-own-mail" className="kn-title m-0 text-xl text-[var(--kn-text)]">
              No mail server yet
            </h3>
            <p className="m-0 mt-0.5 text-sm text-[var(--kn-text-2)]">{YUNORI.tagline}</p>
          </div>
        </div>
        <p className="m-0 mt-5 max-w-prose text-sm text-[var(--kn-text-2)]">{YUNORI.description}</p>
        <p className="m-0 mt-2 max-w-prose text-sm text-[var(--kn-text-2)]">
          It needs an A record for <MonoText>mail.&lt;your domain&gt;</MonoText> pointed at the host,
          and outbound port 25 open or a sending relay.
        </p>
        {canWrite ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {deployButton}
            <Button variant="secondary" size="sm" onClick={onAdopt}>
              Adopt one installed by hand
            </Button>
          </div>
        ) : (
          <div className="mt-6">
            <StatusLine tone="neutral">Deploying one needs Email server access</StatusLine>
          </div>
        )}
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

/*
 * The deploy's once-only secrets wait in the control plane for fifteen
 * minutes, but the panel that offers them lived only in component state:
 * a reload, or a click to another page and back, lost the only way to
 * reveal them. The job and host ids (never the secrets) are kept for the
 * tab's lifetime so the panel comes back until it is dismissed.
 */
const PENDING_SETUP_KEY = "kaname.email.pending-setup";

function usePendingSetup(): [PendingSetup | null, (next: PendingSetup | null) => void] {
  const [pending, setPendingState] = React.useState<PendingSetup | null>(null);
  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(PENDING_SETUP_KEY);
      if (raw) setPendingState(JSON.parse(raw) as PendingSetup);
    } catch {
      /* storage unavailable: the panel simply does not survive a reload */
    }
  }, []);
  const setPending = React.useCallback((next: PendingSetup | null) => {
    setPendingState(next);
    try {
      if (next) window.sessionStorage.setItem(PENDING_SETUP_KEY, JSON.stringify(next));
      else window.sessionStorage.removeItem(PENDING_SETUP_KEY);
    } catch {
      /* as above */
    }
  }, []);
  return [pending, setPending];
}

/* ------------------------------------------------------------------ *
 * One server
 * ------------------------------------------------------------------ */

function MailServerCard({ server, onForget }: { server: MailServer; onForget: () => void }) {
  const can = useCan();
  const sync = useSyncMailServer();
  const update = useUpdateMailServer();
  const renew = useRenewMailCertificate();

  const vars = { id: server.id, server_name: server.server_name };
  const counts = countChecks(server.checks);
  const waiting = waitingStep(server.steps);
  const healthLabel =
    server.health === "pass"
      ? "Healthy"
      : server.health === "unknown" && server.checks.length === 0
        ? "Not checked"
        : CHECK_META[server.health].label;

  const canExec = can("email.servers:exec", server.server_id);
  const canRead = can("email.servers:read", server.server_id);

  return (
    <SectionCard
      padded={false}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <HostCell serverId={server.server_id} serverName={server.server_name} />
          {server.version && (
            <Badge mono size="xs" title="yunori-mail version on the host">
              {server.version}
            </Badge>
          )}
          <MailServerStatusBadge status={server.status} />
          <MailCheckBadge status={server.health} label={healthLabel} />
        </span>
      }
      actions={
        <>
          <Button
            variant="secondary"
            size="xs"
            icon={RefreshCw}
            loading={sync.isPending}
            disabled={!canRead}
            onClick={() => sync.mutate(vars)}
          >
            Check now
          </Button>
          <DropdownMenu
            label={`Actions for ${server.server_name}`}
            trigger={<IconButton icon={MoreHorizontal} label="More actions" size="sm" />}
          >
            <MenuItem icon={ArrowUpCircle} disabled={!canExec} onSelect={() => update.mutate(vars)}>
              Update yunori-mail
            </MenuItem>
            <MenuItem icon={ShieldCheck} disabled={!canExec} onSelect={() => renew.mutate(vars)}>
              Renew certificate
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              destructive
              disabled={!can("email.servers:write", server.server_id)}
              onSelect={onForget}
            >
              Forget
            </MenuItem>
          </DropdownMenu>
        </>
      }
    >
      <div className="flex flex-col gap-5 p-5">
        {/* The verdict: one sentence, derived from the same checks listed below. */}
        <StatusLine
          tone={verdictTone(server)}
          className="text-sm font-medium text-[var(--kn-text)]"
        >
          {verdictSentence(server)}
        </StatusLine>

        {server.last_error && (
          <p className="text-sm text-[var(--kn-danger)]">{server.last_error}</p>
        )}

        <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          <dl className="m-0 grid grid-cols-[7.5rem_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
            <dt className={TERM}>Hostname</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2">
              {server.hostname ? (
                <MonoText truncate className="min-w-0">
                  {server.hostname}
                </MonoText>
              ) : (
                <span className="text-[var(--kn-text-3)]">Not reported yet</span>
              )}
              {server.console_url && (
                <a
                  href={server.console_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
                >
                  Open Yunori console
                  <ExternalLink size={10} aria-hidden />
                </a>
              )}
            </dd>

            <dt className={TERM}>Primary domain</dt>
            <dd>
              {server.primary_domain ? (
                <MonoText>{server.primary_domain}</MonoText>
              ) : (
                <span className="text-[var(--kn-text-3)]">—</span>
              )}
            </dd>

            <dt className={TERM}>Sending</dt>
            <dd>
              {server.sending_mode === "relay"
                ? `Through a relay${server.relay_provider ? ` (${server.relay_provider})` : ""}`
                : server.sending_mode === "direct"
                  ? "Direct, over port 25"
                  : "—"}
            </dd>

            <dt className={TERM}>Certificate</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {server.certificate ? (
                <>
                  <CertificateStateBadge state={server.certificate.state} />
                  {server.certificate.days_left != null && (
                    <span className="kn-num text-[var(--kn-text-2)]">
                      {server.certificate.days_left <= 0
                        ? "expired"
                        : `${formatCount(server.certificate.days_left)} days left`}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-[var(--kn-text-3)]">—</span>
              )}
            </dd>
          </dl>

          <dl className="m-0 grid grid-cols-[7.5rem_1fr] items-baseline gap-x-3 gap-y-2 text-sm">
            <dt className={TERM}>Services</dt>
            <dd>
              <ServiceStates services={server.services} />
            </dd>

            <dt className={TERM}>Hosting</dt>
            <dd className="flex flex-wrap items-center gap-x-3">
              <Link
                href={`/email/domains?server_id=${server.server_id}`}
                className="inline-flex items-center gap-1 rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
              >
                <Globe size={12} aria-hidden />
                {pluralize(server.domain_count, "domain")}
              </Link>
              <Link
                href={`/email/mailboxes?server_id=${server.server_id}`}
                className="inline-flex items-center gap-1 rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
              >
                <Mail size={12} aria-hidden />
                {pluralize(server.mailbox_count, "mailbox", "mailboxes")}
              </Link>
            </dd>

            <dt className={TERM}>Checks</dt>
            <dd className="flex flex-wrap items-center gap-x-3">
              {server.checks.length === 0 ? (
                <span className="text-[var(--kn-text-3)]">none yet</span>
              ) : (
                <>
                  {counts.fail > 0 && (
                    <span className="text-[var(--kn-danger)]">
                      {pluralize(counts.fail, "failing", "failing")}
                    </span>
                  )}
                  {counts.warn > 0 && (
                    <span className="text-[var(--kn-warn)]">
                      {pluralize(counts.warn, "warning")}
                    </span>
                  )}
                  <span className="text-[var(--kn-text-2)]">
                    {pluralize(counts.pass, "passing", "passing")}
                  </span>
                </>
              )}
              <Link
                href={`/email/health?server_id=${server.server_id}`}
                className="inline-flex items-center gap-1 rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
              >
                <BadgeCheck size={12} aria-hidden />
                Health
              </Link>
            </dd>

            <dt className={TERM}>Synced</dt>
            <dd className="text-[var(--kn-text-2)]">
              {server.last_synced_at ? (
                <RelativeTime value={server.last_synced_at} />
              ) : (
                <span className="text-[var(--kn-text-3)]">never — the host has not been read</span>
              )}
            </dd>
          </dl>
        </div>

        {!server.install_complete && (
          <div className="flex flex-col gap-1 border-t border-[var(--kn-border)] pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <MonoLabel as="h3" size="xs" tone="muted">
                Install steps
              </MonoLabel>
              {waiting && (
                <span className="text-xs text-[var(--kn-warn)]">
                  Waiting for you: {waiting.title}
                </span>
              )}
            </div>
            <InstallSteps steps={server.steps} />
          </div>
        )}

        {server.install_complete && counts.fail + counts.warn > 0 && (
          <div className="flex flex-col gap-1 border-t border-[var(--kn-border)] pt-4">
            <MonoLabel as="h3" size="xs" tone="muted">
              Needs a hand
            </MonoLabel>
            <ChecksList
              checks={server.checks.filter(
                (check) => check.status === "fail" || check.status === "warn",
              )}
            />
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * Overview helpers
 * ------------------------------------------------------------------ */

const TERM = "kn-label-sm pt-px text-[var(--kn-text-3)]";

function verdictTone(server: MailServer): Tone {
  if (server.status === "error") return "danger";
  if (server.status === "deploying" || server.status === "installing") return "info";
  if (!server.install_complete) return "warn";
  if (server.checks.length === 0) return "neutral";
  const counts = countChecks(server.checks);
  if (counts.fail > 0) return "danger";
  if (counts.warn > 0) return "warn";
  return "ok";
}

/** The fleet in one sentence, for the header. */
function fleetStatus(servers: readonly MailServer[]): React.ReactNode {
  if (servers.length === 0) return undefined;
  const tones = servers.map(verdictTone);
  const failing = tones.filter((tone) => tone === "danger").length;
  const warning = tones.filter((tone) => tone === "warn").length;
  if (failing > 0) {
    return (
      <StatusLine tone="danger">
        {pluralize(failing, "server needs", "servers need")} a hand ·{" "}
        {pluralize(servers.length, "host")} in all
      </StatusLine>
    );
  }
  if (warning > 0) {
    return (
      <StatusLine tone="warn">
        {pluralize(warning, "server wants", "servers want")} attention ·{" "}
        {pluralize(servers.length, "host")} in all
      </StatusLine>
    );
  }
  return (
    <StatusLine>Every mail server checks out · {pluralize(servers.length, "host")}</StatusLine>
  );
}

const DOMAIN_PREVIEW = 8;

/**
 * The domains every server hosts, with the one thing that breaks mail
 * setups — their DNS — one click from its records. The full list, with
 * filters and actions, lives on the Domains page.
 */
function DomainsOverview() {
  const query = useMailDomains();
  const [dnsFor, setDnsFor] = React.useState<MailDomain | null>(null);
  const domains = query.data?.data ?? [];
  const shown = domains.slice(0, DOMAIN_PREVIEW);

  // Out of scope or failing: the Domains page says why; this summary steps aside.
  if (query.isError) return null;

  return (
    <NumberedSection
      index={2}
      title="Domains"
      caption="Every domain your servers accept mail for, and whether its DNS resolves."
      actions={
        <Link
          href="/email/domains"
          className="kn-label-sm rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
        >
          All domains →
        </Link>
      }
    >
      {query.isLoading ? (
        <Skeleton className="h-24 rounded-[var(--kn-r-lg)]" label="Loading mail domains" />
      ) : domains.length === 0 ? (
        <Card padding="md" className="text-sm text-[var(--kn-text-2)]">
          No domain hosts mail yet.{" "}
          <Link href="/email/domains?new=1" className="text-[var(--kn-accent-400)] hover:underline">
            Add one
          </Link>{" "}
          and Yunori tells you the DNS records to publish.
        </Card>
      ) : (
        <Card padding="none">
          <ul className="m-0 list-none p-0" aria-label="Mail domains overview">
            {shown.map((domain) => (
              <li
                key={domain.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--kn-border)] px-4 py-2.5 last:border-b-0"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Globe size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
                  <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
                    {domain.domain_name}
                  </MonoText>
                  {domain.is_primary && (
                    <Badge size="xs" tone="neutral">
                      primary
                    </Badge>
                  )}
                </span>
                <MonoText muted className="hidden text-xs md:inline">
                  {domain.server_name}
                </MonoText>
                <span className="kn-num w-28 text-right text-xs text-[var(--kn-text-2)]">
                  {pluralize(domain.mailbox_count, "mailbox", "mailboxes")}
                </span>
                <MailCheckBadge
                  status={domain.dns_status}
                  label={`DNS ${CHECK_META[domain.dns_status].label.toLowerCase()}`}
                />
                <Button variant="ghost" size="xs" onClick={() => setDnsFor(domain)}>
                  Records
                </Button>
              </li>
            ))}
          </ul>
          {domains.length > shown.length && (
            <p className="kn-mono m-0 border-t border-[var(--kn-border)] px-4 py-2 text-2xs text-[var(--kn-text-3)]">
              {pluralize(domains.length - shown.length, "more domain")} on the Domains page
            </p>
          )}
        </Card>
      )}
      <DnsDrawer domain={dnsFor} onClose={() => setDnsFor(null)} />
    </NumberedSection>
  );
}

function OverviewLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-[var(--kn-r-lg)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
    >
      <Card interactive padding="md" className="flex h-full items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--kn-r-md)] border border-[var(--kn-border)] text-[var(--kn-text-2)]">
          <Icon size={14} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="kn-title block text-md text-[var(--kn-text)]">
            {title}
            <span
              aria-hidden
              className="ml-1.5 inline-block text-[var(--kn-text-3)] transition-transform duration-[var(--kn-dur)] ease-[var(--kn-ease)] group-hover:translate-x-0.5"
            >
              →
            </span>
          </span>
          <span className="mt-0.5 block text-sm text-[var(--kn-text-2)]">{description}</span>
        </span>
      </Card>
    </Link>
  );
}
