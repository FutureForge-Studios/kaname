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
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Job, MailServer } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  IconButton,
  MenuItem,
  MenuSeparator,
  MonoText,
  PageHeader,
  RelativeTime,
  SectionCard,
  Select,
  Skeleton,
  cn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { serverPrerequisite, useOpenFromQuery } from "@/components/ResourcePage";
import { formatCount, pluralize } from "@/lib/format";
import { useCan, useServers } from "@/lib/queries";
import { HostCell } from "../_components/cells";
import { JobActivityBar } from "../_components/JobActivity";
import {
  MAIL_JOB_TYPES,
  useForgetMailServer,
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
        title="Mail servers"
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

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        {pending && <FinishSetupPanel pending={pending} onDismiss={() => setPending(null)} />}

        <JobActivityBar types={MAIL_JOB_TYPES} />

        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            aria-label="Verdict"
            value={health}
            onChange={(event) => setHealth(event.target.value)}
            boxClassName="w-40"
            options={HEALTH_OPTIONS}
          />
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {query.dataUpdatedAt > 0 && (
              <span className="hidden items-center gap-1 text-xs text-[var(--kn-text-3)] md:inline-flex">
                synced <RelativeTime value={query.dataUpdatedAt} />
              </span>
            )}
            <IconButton
              icon={RefreshCw}
              label="Refresh"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            />
          </div>
        </div>

        {query.isError ? (
          <PageError error={query.error} onRetry={() => void query.refetch()} context="Mail servers" />
        ) : query.isLoading ? (
          <div className="flex flex-col gap-4" aria-busy>
            <Skeleton className="h-40 rounded-[var(--kn-r-md)]" label="Loading mail servers" />
            <Skeleton className="h-40 rounded-[var(--kn-r-md)]" />
          </div>
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
                title={health ? "No mail server matches" : "No mail server yet"}
                description={
                  health
                    ? "No host's last check came out that way."
                    : "Kaname installs Yunori Mail Server on a host you own: Stalwart for mail, with DNS and certificates checked for you. Domains, mailboxes and aliases all live on one."
                }
                action={health || !canWrite ? undefined : deployButton}
                secondaryAction={
                  health ? (
                    <Button variant="secondary" size="sm" onClick={() => setHealth("")}>
                      Clear filter
                    </Button>
                  ) : canWrite ? (
                    <Button variant="secondary" size="sm" onClick={() => setAdopting(true)}>
                      Adopt one installed by hand
                    </Button>
                  ) : undefined
                }
              />
            )}
          </SectionCard>
        ) : (
          <ul className="flex flex-col gap-4">
            {servers.map((server) => (
              <li key={server.id}>
                <MailServerCard server={server} onForget={() => setForgetting(server)} />
              </li>
            ))}
          </ul>
        )}
      </div>

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
      <div className="flex flex-col gap-4 p-4">
        {/* The verdict: one sentence, derived from the same checks listed below. */}
        <p className={cn("font-medium", checkTextClass(server.health))}>{verdictSentence(server)}</p>

        {server.last_error && (
          <p className="text-sm text-[var(--kn-danger)]">{server.last_error}</p>
        )}

        <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-[var(--kn-text-3)]">Hostname</dt>
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

            <dt className="text-[var(--kn-text-3)]">Primary domain</dt>
            <dd>
              {server.primary_domain ? (
                <MonoText>{server.primary_domain}</MonoText>
              ) : (
                <span className="text-[var(--kn-text-3)]">—</span>
              )}
            </dd>

            <dt className="text-[var(--kn-text-3)]">Sending</dt>
            <dd>
              {server.sending_mode === "relay"
                ? `Through a relay${server.relay_provider ? ` (${server.relay_provider})` : ""}`
                : server.sending_mode === "direct"
                  ? "Direct, over port 25"
                  : "—"}
            </dd>

            <dt className="text-[var(--kn-text-3)]">Certificate</dt>
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

          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-[var(--kn-text-3)]">Services</dt>
            <dd>
              <ServiceStates services={server.services} />
            </dd>

            <dt className="text-[var(--kn-text-3)]">Hosting</dt>
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

            <dt className="text-[var(--kn-text-3)]">Checks</dt>
            <dd className="flex flex-wrap items-center gap-x-3">
              {server.checks.length === 0 ? (
                <span className="text-[var(--kn-text-3)]">none yet</span>
              ) : (
                <>
                  {counts.fail > 0 && (
                    <span className="text-[var(--kn-danger)]">{pluralize(counts.fail, "failing", "failing")}</span>
                  )}
                  {counts.warn > 0 && (
                    <span className="text-[var(--kn-warn)]">{pluralize(counts.warn, "warning")}</span>
                  )}
                  <span className="text-[var(--kn-text-2)]">{pluralize(counts.pass, "passing", "passing")}</span>
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

            <dt className="text-[var(--kn-text-3)]">Synced</dt>
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
          <div className="flex flex-col gap-2 border-t border-[var(--kn-border)] pt-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
                Install steps
              </h3>
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
          <div className="flex flex-col gap-1 border-t border-[var(--kn-border)] pt-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
              Needs a hand
            </h3>
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
