"use client";

import * as React from "react";
import {
  ArrowRight,
  Bell,
  DatabaseBackup,
  Globe,
  LayoutTemplate,
  Mail,
  Send,
  UserPlus,
} from "lucide-react";
import {
  UPDATE_TIER_LABELS,
  updateCheckInterval as updateCheckIntervalEnum,
  updateTier as updateTierEnum,
  type BackupDestination,
  type BackupDestinationTarget,
  type BackupDestinationTestResult,
  type BackupSchedule,
  type DeployMailServerInput,
  type Domain,
  type Job,
  type MailSendingMode,
  type MailServer,
  type NotificationTestResult,
  type Role,
  type Server,
  type SetupState,
  type Site,
  type SmtpSecurity,
  type UpdateCheckInterval,
  type UpdateTier,
  type User,
} from "@kaname/contract";
import {
  Button,
  Checkbox,
  CopyableCode,
  FormField,
  Input,
  JobProgress,
  JobStatusPill,
  MonoText,
  Radio,
  RadioGroup,
  RelativeTime,
  Select,
  Skeleton,
  Switch,
} from "@kaname/ui";
import { domainProblem, normalizeDomain, type PanelAddress } from "@/lib/address";
import { api } from "@/lib/api";
import { useJob, useServers } from "@/lib/queries";
import {
  EMPTY_RELAY,
  FinishSetupPanel,
  LOCAL_PART,
  RelayFields,
  relayDraftValid,
  relayInput,
  type RelayDraft,
} from "@/app/(panel)/email/_components/ServerDialogs";
import { useLatestMailRelease } from "@/app/(panel)/email/_components/queries";
import {
  EMAIL_RE,
  Needs,
  Note,
  StepError,
  StepFooter,
  StepForm,
  StepHeading,
  toError,
  useAnswer,
  useStepAction,
  type StepProps,
} from "./chrome";

/* ------------------------------------------------------------------ *
 * The optional half of setup: the core of the panel, in the order an
 * operator tends to need it. Each step does its work through the same
 * route the module's own page uses — POST /sites, /mail-servers,
 * /backups/schedules, /users — and then records an answer with the
 * setup flow, which checks that the thing it claims exists. Nothing
 * here is a second implementation of anything.
 * ------------------------------------------------------------------ */

const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

function domainFieldProblem(value: string, required: boolean): string | null {
  if (value.length === 0) return required ? "Enter a domain, like example.com." : null;
  return DOMAIN_RE.test(value) ? null : "That is not a domain name. It should look like example.com.";
}

/** POST /sites, /mail-servers and friends answer 202 with the job; tolerate either envelope. */
function jobOf(response: { job: Job } | Job): Job {
  return "job" in response ? response.job : response;
}

/** Servers a step can act on: connected, newest-paired first. */
function useConnectedServers(capability?: Server["capabilities"][number]) {
  const query = useServers();
  const servers = React.useMemo(
    () =>
      (query.data?.data ?? []).filter(
        (server) =>
          server.connection === "connected" &&
          (!capability || server.capabilities.includes(capability)),
      ),
    [capability, query.data],
  );
  return { servers, loading: query.isLoading, error: query.error };
}

function ServerSelect({
  servers,
  value,
  onChange,
  description,
}: {
  servers: Server[];
  value: string | null;
  onChange: (id: string) => void;
  description?: string;
}) {
  // One server is the common first-run case; a picker with one entry
  // is a question with no choice in it.
  if (servers.length <= 1) return null;
  return (
    <FormField label="Server" description={description}>
      <Select
        size="md"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        options={servers.map((server) => ({
          value: server.id,
          label: server.simulated ? `${server.name} (simulated)` : server.name,
        }))}
      />
    </FormField>
  );
}

function useDefaultServer(servers: Server[]) {
  const [serverId, setServerId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!serverId && servers[0]) setServerId(servers[0].id);
  }, [serverId, servers]);
  const server = servers.find((candidate) => candidate.id === serverId) ?? null;
  return { serverId, setServerId, server };
}

/** "Already here" — shown when a step finds its work done on a resume. */
function ExistingList({ title, rows }: { title: string; rows: { key: string; primary: string; secondary?: React.ReactNode }[] }) {
  return (
    <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)]">
      <p className="border-b border-[var(--kn-border)] px-4 py-2 text-sm text-[var(--kn-text-2)]">{title}</p>
      <ul className="divide-y divide-[var(--kn-border)]">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-3 px-4 py-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--kn-ok)]" aria-hidden />
            <MonoText className="min-w-0 truncate text-[var(--kn-text)]">{row.primary}</MonoText>
            {row.secondary && (
              <span className="ml-auto shrink-0 text-sm text-[var(--kn-text-3)]">{row.secondary}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Follows one job: the pill, the bar, and the error if it fails. */
function JobLine({ job: initial }: { job: Job }) {
  const query = useJob(initial.id);
  const job = query.data ?? initial;
  return (
    <div className="flex flex-col gap-2 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <JobStatusPill status={job.status} size="xs" blockedReason={job.blocked_reason} />
        <span className="min-w-0 truncate text-[var(--kn-text)]">{job.label}</span>
        {job.server_name && (
          <MonoText muted className="ml-auto text-xs">
            {job.server_name}
          </MonoText>
        )}
      </div>
      <JobProgress value={job.progress} status={job.status} label={job.label} />
      {job.error && (
        <p className="text-sm text-[var(--kn-danger)]">
          <MonoText>{job.error.code}</MonoText> — {job.error.message}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Panel address and HTTPS
 * ------------------------------------------------------------------ */

export function AddressStep({ state, onAdvance, onStale }: StepProps) {
  const [panel, setPanel] = React.useState<PanelAddress | null | "unavailable">(null);
  const [domain, setDomain] = React.useState(state.pending_domain ?? "");
  const [acme, setAcme] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const save = useStepAction(onStale);
  const skip = useAnswer({ onAdvance, onStale }, "address");

  React.useEffect(() => {
    let cancelled = false;
    void api
      .get<PanelAddress>("/settings/address")
      .then((result) => !cancelled && setPanel(result))
      // An instance that cannot answer this cannot change its own
      // address either, so the field is simply not offered.
      .catch(() => !cancelled && setPanel("unavailable"));
    return () => {
      cancelled = true;
    };
  }, []);

  const offerDomain = panel !== null && panel !== "unavailable" && panel.managed && !panel.domain;
  const normalized = normalizeDomain(domain);
  const domainError = offerDomain ? domainProblem(normalized) : null;
  const acmeError = acme.trim() && !EMAIL_RE.test(acme.trim()) ? "Enter a full email address." : null;
  const nothingEntered = (!offerDomain || normalized.length === 0) && acme.trim().length === 0;

  const submit = async () => {
    setSubmitted(true);
    if (domainError || acmeError) return;
    if (nothingEntered) {
      await skip.answer("skipped");
      return;
    }
    const next = await save.run(() =>
      api.post<SetupState>("/setup/address", {
        ...(offerDomain && normalized ? { panel_domain: normalized } : {}),
        ...(acme.trim() ? { acme_email: acme.trim() } : {}),
      }),
    );
    if (next) onAdvance(next);
  };

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={Globe}
        title="Give the panel an address"
        hint="A name of its own, served over HTTPS with a certificate Kaname renews. Without one the panel stays on this server's IP over plain HTTP, which works but sends your session unencrypted."
      />

      {panel === null && <Skeleton className="h-16 rounded-[var(--kn-r-md)]" label="Reading the panel's address" />}

      {panel !== null && panel !== "unavailable" && panel.domain && (
        <Note>
          The panel already answers on <MonoText>{panel.public_url}</MonoText>
          {panel.tls ? " with a certificate." : "."} Change it later in Administration → Settings →
          Address.
        </Note>
      )}

      {panel !== null && (panel === "unavailable" || !panel.managed) && (
        <Note>
          This panel was not deployed by the installer, so whatever runs it owns its address and
          certificate. The certificate contact below is still used for the certificates Kaname issues for
          your websites.
        </Note>
      )}

      {offerDomain && (
        <>
          <Needs
            items={[
              <>
                An A record for the name, pointed at this server&rsquo;s IP. You are on{" "}
                <MonoText>{window.location.host}</MonoText> now.
              </>,
              "Ports 80 and 443 open to the internet, so the certificate can be issued.",
              "Nothing else. The IP address keeps working, and the change is applied when you finish setup, not now.",
            ]}
          />
          <FormField
            label="Panel domain"
            error={submitted || normalized.length > 3 ? (domainError ?? save.error?.fields.panel_domain) : undefined}
          >
            <Input
              mono
              size="md"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              onBlur={() => setDomain(normalized)}
              placeholder="panel.example.com"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </FormField>
        </>
      )}

      <FormField
        label="Certificate contact"
        description="Let's Encrypt writes here before a certificate expires and it could not be renewed. Used for the panel and every website."
        error={(submitted && acmeError) || save.error?.fields.acme_email || undefined}
      >
        <Input
          type="email"
          mono
          size="md"
          value={acme}
          onChange={(event) => setAcme(event.target.value)}
          placeholder="ops@example.com"
          autoFocus={!offerDomain}
        />
      </FormField>

      <StepError error={save.error ?? skip.error} exclude={["panel_domain", "acme_email"]} />

      <StepFooter
        primary={nothingEntered ? "Continue" : "Save and continue"}
        icon={ArrowRight}
        pending={save.pending || (nothingEntered && skip.pending)}
        later={nothingEntered ? undefined : () => void skip.answer("skipped")}
        laterPending={skip.pending}
      />
    </StepForm>
  );
}

/* ------------------------------------------------------------------ *
 * 6. First website or domain
 * ------------------------------------------------------------------ */

type WebsiteKind = "static" | "php" | "proxy" | "domain";

const WEBSITE_KINDS: { value: WebsiteKind; label: string; description: string }[] = [
  {
    value: "static",
    label: "Static files",
    description: "HTML, CSS and images served straight from a folder.",
  },
  { value: "php", label: "PHP", description: "WordPress, Laravel and anything else PHP runs." },
  {
    value: "proxy",
    label: "An app on a port",
    description: "Node, Python or a container already listening locally; Kaname puts HTTPS in front.",
  },
  {
    value: "domain",
    label: "Just the domain for now",
    description: "Registers the name for DNS and email, without a website yet.",
  },
];

export function WebsiteStep({ onAdvance, onStale }: StepProps) {
  const { servers, loading } = useConnectedServers();
  const { serverId, setServerId, server } = useDefaultServer(servers);
  const [existing, setExisting] = React.useState<{ sites: Site[]; domains: Domain[] } | null>(null);
  const [domain, setDomain] = React.useState("");
  const [kind, setKind] = React.useState<WebsiteKind>("static");
  const [upstream, setUpstream] = React.useState("http://127.0.0.1:3000");
  const [submitted, setSubmitted] = React.useState(false);
  const [job, setJob] = React.useState<Job | null>(null);
  const [created, setCreated] = React.useState<string | null>(null);
  const create = useStepAction(onStale);
  const answer = useAnswer({ onAdvance, onStale }, "website");

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.list<Site>("/sites", { params: { per_page: 5 } }),
      api.list<Domain>("/domains", { params: { per_page: 5 } }),
    ])
      .then(([sites, domains]) => !cancelled && setExisting({ sites: sites.data, domains: domains.data }))
      .catch(() => !cancelled && setExisting({ sites: [], domains: [] }));
    return () => {
      cancelled = true;
    };
  }, []);

  const name = normalizeDomain(domain);
  const domainError = domainFieldProblem(name, true);
  const upstreamError =
    kind === "proxy" && !/^https?:\/\/[^\s]+$/.test(upstream.trim())
      ? "Enter where the app listens, like http://127.0.0.1:3000."
      : null;

  const already = existing && (existing.sites.length > 0 || existing.domains.length > 0) && !created;
  const done = Boolean(created);

  const submit = async () => {
    if (done || already) {
      await answer.answer("done");
      return;
    }
    setSubmitted(true);
    if (domainError || upstreamError || !server) return;
    const result = await create.run(async () => {
      if (kind === "domain") {
        await api.post<Domain>("/domains", { name, server_id: server.id });
        return null;
      }
      return jobOf(
        await api.post<{ job: Job } | Job>("/sites", {
          server_id: server.id,
          name,
          webroot: `/var/www/${name}`,
          runtime: kind,
          primary_domain: name,
          domains: [],
          force_https: true,
          ...(kind === "proxy" ? { upstream: upstream.trim() } : {}),
        }),
      );
    });
    if (result === undefined) return;
    setJob(result);
    setCreated(name);
  };

  const serverIp = server?.address ?? null;

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={LayoutTemplate}
        title="Put your first website on it"
        hint="Kaname writes the web server configuration, creates the folder and issues the certificate. You can add more, and change any of this, under Websites."
      />

      {(existing === null || loading) && <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Looking for websites" />}

      {existing !== null && !loading && already && (
        <ExistingList
          title="Already on this panel"
          rows={[
            ...existing.sites.map((site) => ({
              key: site.id,
              primary: site.primary_domain ?? site.name,
              secondary: site.server_name,
            })),
            ...existing.domains
              .filter((d) => !existing.sites.some((site) => site.primary_domain === d.name))
              .map((d) => ({ key: d.id, primary: d.name, secondary: "Domain" })),
          ].slice(0, 5)}
        />
      )}

      {existing !== null && !loading && !already && servers.length === 0 && (
        <Note tone="warn">
          No server is connected right now, so there is nowhere to put a website. Come back to it
          from Websites once the agent is online.
        </Note>
      )}

      {existing !== null && !loading && !already && servers.length > 0 && !done && (
        <>
          <Needs
            items={[
              <>
                An A record for the domain pointed at{" "}
                {serverIp ? <MonoText>{serverIp}</MonoText> : "the server"}. The site is created
                either way; the certificate follows once the name resolves.
              </>,
              "Ports 80 and 443 open on the server.",
            ]}
          />

          <FormField
            label="Domain"
            required
            error={(submitted || name.length > 3) && domainError ? domainError : create.error?.fields.primary_domain ?? create.error?.fields.name}
          >
            <Input
              mono
              size="md"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              onBlur={() => setDomain(name)}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </FormField>

          <FormField label="What it runs">
            <RadioGroup value={kind} onValueChange={(next) => setKind(next as WebsiteKind)} aria-label="What it runs">
              {WEBSITE_KINDS.map((option) => (
                <Radio key={option.value} value={option.value} label={option.label} description={option.description} />
              ))}
            </RadioGroup>
          </FormField>

          {kind === "proxy" && (
            <FormField
              label="App address"
              required
              description="Where the app already listens on the server."
              error={(submitted && upstreamError) || create.error?.fields.upstream || undefined}
            >
              <Input
                mono
                size="md"
                value={upstream}
                onChange={(event) => setUpstream(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
          )}

          <ServerSelect
            servers={servers}
            value={serverId}
            onChange={setServerId}
            description="Where the website lives."
          />

          {kind !== "domain" && name && !domainError && (
            <p className="text-sm text-[var(--kn-text-3)]">
              Files go in <MonoText>/var/www/{name}</MonoText>
              {server ? (
                <>
                  {" "}
                  on <MonoText>{server.name}</MonoText>
                </>
              ) : null}
              .
            </p>
          )}
        </>
      )}

      {done && created && <CreatedWebsite name={created} job={job} />}

      <StepError
        error={create.error ?? answer.error}
        exclude={["primary_domain", "name", "upstream"]}
      />

      <StepFooter
        primary={done || already ? "Continue" : kind === "domain" ? "Add domain" : "Create website"}
        icon={done || already ? ArrowRight : undefined}
        pending={create.pending || answer.pending}
        disabled={!done && !already && servers.length === 0 && existing !== null && !loading}
        primaryAutoFocus={Boolean(done || already)}
        later={done || already ? undefined : () => void answer.answer("skipped")}
        laterLabel="Add a website later"
      />
    </StepForm>
  );
}

/** What happened to the website just created, in words that follow its job. */
function CreatedWebsite({ name, job: initial }: { name: string; job: Job | null }) {
  const query = useJob(initial?.id ?? null);
  const job = query.data ?? initial;
  const failed = job && ["failed", "cancelled", "timed_out"].includes(job.status);
  return (
    <>
      <Note tone={failed ? "warn" : "neutral"}>
        <MonoText className="text-[var(--kn-text)]">{name}</MonoText>{" "}
        {!job
          ? "is registered. Add a website for it from Websites whenever you are ready."
          : job.status === "succeeded"
            ? "is set up. Put your files in its folder, or deploy to it from Websites."
            : failed
              ? "could not be set up on the server. The reason is below; fix it and retry from Websites. The rest of setup does not depend on it."
              : "is being set up on the server. You can carry on; the job finishes on its own."}
      </Note>
      {job && <JobLine job={job} />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 7. Email — Yunori Mail Server
 *
 * Deploys through POST /mail-servers with deployMailServerInput, the
 * same call the Email module's dialog makes, and shows the outcome
 * with that module's FinishSetupPanel: the once-only setup link and
 * first mailbox password appear here exactly as they do there.
 * ------------------------------------------------------------------ */

export function EmailStep({ state, onAdvance, onStale }: StepProps) {
  const { servers, loading } = useConnectedServers("systemd");
  const { serverId, setServerId, server } = useDefaultServer(servers);
  const [mailServers, setMailServers] = React.useState<MailServer[] | null>(null);
  const [domains, setDomains] = React.useState<Domain[]>([]);
  const [domain, setDomain] = React.useState("");
  const [hostname, setHostname] = React.useState("");
  const [hostnameTouched, setHostnameTouched] = React.useState(false);
  const [adminEmail, setAdminEmail] = React.useState("");
  const [firstMailbox, setFirstMailbox] = React.useState("hello");
  const [sending, setSending] = React.useState<MailSendingMode>("direct");
  const [relay, setRelay] = React.useState<RelayDraft>(EMPTY_RELAY);
  const [submitted, setSubmitted] = React.useState(false);
  const deploy = useStepAction(onStale);
  const answer = useAnswer({ onAdvance, onStale }, "email");

  const tracked = state.email_deploy;
  const trackedJob = useJob(tracked?.job_id ?? null);
  // The deploy job resolves the same feed; when it cannot be read the job
  // can only fail, so the step says so instead of starting one.
  const release = useLatestMailRelease(!tracked);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.list<MailServer>("/mail-servers", { params: { per_page: 100 } }),
      api.list<Domain>("/domains", { params: { per_page: 50, sort: "created_at", order: "desc" } }),
    ])
      .then(([mail, known]) => {
        if (cancelled) return;
        setMailServers(mail.data);
        setDomains(known.data);
        // The website step's domain is the likeliest mail domain.
        const first = known.data[0]?.name;
        if (first) setDomain((current) => current || first);
      })
      .catch(() => !cancelled && setMailServers([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const name = normalizeDomain(domain);
  const suggestedHostname = name ? `mail.${name}` : "";
  const effectiveHostname = hostnameTouched ? normalizeDomain(hostname) : suggestedHostname;
  const onThisServer = mailServers?.find((row) => row.server_id === serverId) ?? null;
  const anyMailServer = mailServers?.[0] ?? null;

  const problems = {
    domain: domainFieldProblem(name, true),
    hostname: domainFieldProblem(effectiveHostname, false),
    admin_email: !EMAIL_RE.test(adminEmail.trim())
      ? "Enter an address on another provider, like you@gmail.com."
      : name && adminEmail.trim().toLowerCase().endsWith(`@${name}`)
        ? `That address is on ${name}, the domain this server will host. If the mail server were down, its own alerts could not reach you. Use one elsewhere.`
        : null,
    first_mailbox: !LOCAL_PART.test(firstMailbox.trim())
      ? "Use letters, digits, dots, dashes or underscores."
      : null,
    relay: sending === "relay" && !relayDraftValid(relay) ? "Fill in the relay's details." : null,
  };
  const show = (key: keyof typeof problems, typed: boolean) =>
    (submitted || typed) && problems[key] ? problems[key] : undefined;

  const submit = async () => {
    if (tracked) {
      const job = trackedJob.data;
      const failed = job && ["failed", "cancelled", "timed_out"].includes(job.status);
      await answer.answer(failed ? "skipped" : "done");
      return;
    }
    if (onThisServer || (anyMailServer && servers.length === 0)) {
      await answer.answer("done");
      return;
    }
    if (!server || release.isError) {
      await answer.answer("skipped");
      return;
    }
    setSubmitted(true);
    if (Object.values(problems).some(Boolean)) return;

    const next = await deploy.run(async () => {
      // deployMailServerInput takes a Kaname domain; reuse the row the
      // website step made, or register the name the way Domains does.
      const found = await api.list<Domain>("/domains", { params: { q: name, per_page: 20 } });
      const row =
        found.data.find((candidate) => candidate.name === name) ??
        (await api.post<Domain>("/domains", { name, server_id: server.id }));

      const input: DeployMailServerInput = {
        server_id: server.id,
        domain_id: row.id,
        ...(effectiveHostname ? { hostname: effectiveHostname } : {}),
        admin_email: adminEmail.trim(),
        first_mailbox: firstMailbox.trim().toLowerCase(),
        sending,
        force: false,
        skip_ptr: false,
        ...(sending === "relay" ? { relay: relayInput(relay) } : {}),
      };
      const job = jobOf(await api.post<{ job: Job } | Job>("/mail-servers", input));
      return api.post<SetupState>("/setup/email/deploy", { job_id: job.id, server_id: server.id });
    });
    if (next) onAdvance(next);
  };

  /* ---------------------- a deploy is under way ---------------------- */

  if (tracked) {
    const job = trackedJob.data;
    const failed = job && ["failed", "cancelled", "timed_out"].includes(job.status);
    const succeeded = job?.status === "succeeded";
    return (
      <StepForm onSubmit={() => void submit()}>
        <StepHeading
          icon={Mail}
          title={succeeded ? "Your mail server is ready" : failed ? "The mail server did not finish" : "Installing your mail server"}
          hint={
            succeeded
              ? "Copy the two things below before you move on. Kaname shows them once and does not keep them."
              : failed
                ? "Nothing else in setup depends on it. The job log under Email has the step that failed, and you can deploy again from there."
                : "Yunori Mail Server is being installed. This usually takes a few minutes; you can carry on and it finishes on its own."
          }
        />

        {trackedJob.isLoading && <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Loading the deploy" />}
        {trackedJob.error && <StepError error={toError(trackedJob.error)} />}
        {job && <FinishSetupPanel pending={{ job, serverId: tracked.server_id }} />}

        {!succeeded && !failed && (
          <p className="text-sm text-[var(--kn-text-3)]">
            Continuing now is fine, but the setup link and first password can only be shown here
            or on the Email page while the job is fresh — within fifteen minutes of it finishing.
          </p>
        )}

        <StepError error={answer.error} />
        <StepFooter
          primary={failed ? "Continue without email" : "Continue"}
          icon={ArrowRight}
          pending={answer.pending}
          primaryAutoFocus
        />
      </StepForm>
    );
  }

  /* ---------------------------- the form ---------------------------- */

  const ready = mailServers !== null && !loading;

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={Mail}
        title="Give it email"
        hint="Kaname can install Yunori Mail Server on your server: mailboxes for your domain, spam filtering, and the DNS records it needs checked for you. Optional, and easy to do later from Email."
      />

      {!ready && <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Looking for mail servers" />}

      {ready && onThisServer && (
        <ExistingList
          title={`${onThisServer.server_name} already runs a mail server`}
          rows={[
            {
              key: onThisServer.id,
              primary: onThisServer.hostname ?? onThisServer.server_name,
              secondary: onThisServer.status,
            },
          ]}
        />
      )}

      {ready && !onThisServer && servers.length === 0 && (
        <Note tone="warn">
          No connected server with systemd is available to install it on, so this can wait. Deploy
          it from Email once a server is online.
          {anyMailServer && (
            <>
              {" "}
              <MonoText>{anyMailServer.hostname ?? anyMailServer.server_name}</MonoText> already
              runs one.
            </>
          )}
        </Note>
      )}

      {ready && !onThisServer && server && (
        <>
          {server.simulated ? (
            <Note>
              <MonoText>{server.name}</MonoText> is a simulated server. The deploy runs against the
              simulator, so you will see every step and a setup link, but nothing is installed and no
              mail is sent or received.
            </Note>
          ) : (
            <Needs
              title="What this needs"
              items={[
                <>
                  An A record for <MonoText>{effectiveHostname || "mail.<your domain>"}</MonoText>{" "}
                  pointed at{" "}
                  {server.address ? <MonoText>{server.address}</MonoText> : <MonoText>{server.name}</MonoText>}
                  , before you start.
                </>,
                "Outbound port 25 open at your provider — many block it on new accounts — or a sending relay such as Amazon SES or Postmark.",
                "A server with nothing else on ports 25, 80, 443, 465, 587 or 993. A fresh one is best.",
              ]}
            />
          )}

          {release.isError && (
            <Note tone="warn">
              The yunori-mail release feed could not be read, so a deploy cannot start right now:{" "}
              {release.error.message} Continue without email and deploy it later from Email.
            </Note>
          )}

          <FormField
            label="Mail domain"
            required
            description="The part after the @ in your addresses."
            error={show("domain", name.length > 3) ?? deploy.error?.fields.domain_id}
          >
            <Input
              mono
              size="md"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              onBlur={() => setDomain(name)}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </FormField>
          {domains.length > 1 && (
            <div className="-mt-3 flex flex-wrap gap-1.5">
              {domains.slice(0, 4).map((known) => (
                <Button
                  key={known.id}
                  type="button"
                  variant={known.name === name ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setDomain(known.name)}
                >
                  {known.name}
                </Button>
              ))}
            </div>
          )}

          <FormField
            label="Mail hostname"
            description="What mail apps connect to and what the certificate is for."
            error={show("hostname", hostnameTouched) ?? deploy.error?.fields.hostname}
          >
            <Input
              mono
              size="md"
              value={effectiveHostname}
              placeholder="mail.example.com"
              onChange={(event) => {
                setHostnameTouched(true);
                setHostname(event.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          <FormField
            label="Your email elsewhere"
            required
            description="On another provider. Certificate and alert mail about this server goes here, so it still arrives if this server is down."
            error={show("admin_email", adminEmail.includes("@")) ?? deploy.error?.fields.admin_email}
          >
            <Input
              type="email"
              mono
              size="md"
              value={adminEmail}
              placeholder="you@gmail.com"
              onChange={(event) => setAdminEmail(event.target.value)}
              autoComplete="email"
              spellCheck={false}
            />
          </FormField>

          <FormField
            label="First mailbox"
            required
            hint={name ? <MonoText muted>{`${firstMailbox || "…"}@${name}`}</MonoText> : undefined}
            description="Created at the end of the install. Its password is shown once, here."
            error={show("first_mailbox", firstMailbox.length > 0) ?? deploy.error?.fields.first_mailbox}
          >
            <Input
              mono
              size="md"
              value={firstMailbox}
              onChange={(event) => setFirstMailbox(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          <FormField label="Sending" error={deploy.error?.fields.sending}>
            <RadioGroup
              value={sending}
              onValueChange={(next) => setSending(next === "relay" ? "relay" : "direct")}
              aria-label="Sending mode"
            >
              <Radio
                value="direct"
                label="Directly from this server"
                description="Needs outbound port 25 open and reverse DNS set at your provider."
              />
              <Radio
                value="relay"
                label="Through a relay"
                description="For providers that block port 25. Outgoing mail goes via a sending service; incoming still arrives here."
              />
            </RadioGroup>
          </FormField>

          {sending === "relay" && (
            <RelayFields value={relay} onChange={setRelay} fields={submitted && problems.relay ? { "relay.password": relay.password ? "" : "Required.", ...deploy.error?.fields } : (deploy.error?.fields ?? {})} />
          )}

          <ServerSelect
            servers={servers}
            value={serverId}
            onChange={setServerId}
            description="Where Yunori is installed."
          />
        </>
      )}

      <StepError
        error={deploy.error ?? answer.error}
        exclude={["domain_id", "hostname", "admin_email", "first_mailbox", "sending"]}
      />

      <StepFooter
        primary={
          !ready || onThisServer || !server
            ? "Continue"
            : release.isError
              ? "Continue without email"
              : "Deploy mail server"
        }
        icon={!ready || onThisServer || !server || release.isError ? ArrowRight : undefined}
        pending={deploy.pending || answer.pending}
        disabled={!ready || (Boolean(server) && !onThisServer && release.isLoading)}
        primaryAutoFocus={ready && (Boolean(onThisServer) || !server)}
        later={
          ready && !onThisServer && server && !release.isError
            ? () => void answer.answer("skipped")
            : undefined
        }
        laterLabel="Set up email later"
      />
    </StepForm>
  );
}

/* ------------------------------------------------------------------ *
 * 8. Backups
 * ------------------------------------------------------------------ */

type DestinationKind = "s3" | "b2" | "local";

const DESTINATION_OPTIONS: { value: DestinationKind; label: string; description: string }[] = [
  {
    value: "s3",
    label: "S3-compatible storage",
    description: "Amazon S3, Cloudflare R2, Wasabi, MinIO — anything that speaks S3.",
  },
  { value: "b2", label: "Backblaze B2", description: "Inexpensive and off-site." },
  {
    value: "local",
    label: "A folder on the server",
    description: "Quick to set up, but it goes down with the server. Better than nothing; not a real backup.",
  },
];

interface DestinationDraft {
  kind: DestinationKind;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secret: string;
  path: string;
}

export function BackupsStep({ onAdvance, onStale }: StepProps) {
  const { servers, loading } = useConnectedServers();
  const { serverId, setServerId, server } = useDefaultServer(servers);
  const [existing, setExisting] = React.useState<BackupSchedule[] | null>(null);
  const [draft, setDraft] = React.useState<DestinationDraft>({
    kind: "s3",
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    accessKeyId: "",
    secret: "",
    path: "/var/backups/kaname",
  });
  const [scope, setScope] = React.useState({ files: true, databases: true, mail: false });
  const [submitted, setSubmitted] = React.useState(false);
  const [test, setTest] = React.useState<BackupDestinationTestResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [destination, setDestination] = React.useState<BackupDestination | null>(null);
  const [created, setCreated] = React.useState<BackupSchedule | null>(null);
  const save = useStepAction(onStale);
  const answer = useAnswer({ onAdvance, onStale }, "backups");

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.list<BackupSchedule>("/backups/schedules", { params: { per_page: 5 } }),
      api.list<MailServer>("/mail-servers", { params: { per_page: 1 } }).catch(() => null),
    ])
      .then(([schedules, mail]) => {
        if (cancelled) return;
        setExisting(schedules.data);
        if (mail && mail.data.length > 0) setScope((current) => ({ ...current, mail: true }));
      })
      .catch(() => !cancelled && setExisting([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof DestinationDraft>(key: K, value: DestinationDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTest(null);
  };

  const problems = {
    bucket: draft.kind !== "local" && !draft.bucket.trim() ? "Enter the bucket name." : null,
    accessKeyId: draft.kind !== "local" && !draft.accessKeyId.trim() ? "Enter the access key ID." : null,
    secret: draft.kind !== "local" && !draft.secret ? "Enter the secret key." : null,
    path:
      draft.kind === "local" && !/^\/[^\0]*$/.test(draft.path.trim())
        ? "Enter an absolute path, like /var/backups/kaname."
        : null,
    region: draft.kind === "s3" && !draft.region.trim() ? "Enter the region, like us-east-1." : null,
    scope: !scope.files && !scope.databases && !scope.mail ? "Choose at least one thing to back up." : null,
  };
  const err = (key: keyof typeof problems) => (submitted && problems[key]) || undefined;

  const target = (): BackupDestinationTarget | null => {
    if (!server) return null;
    if (draft.kind === "local") return { kind: "local", server_id: server.id, path: draft.path.trim() };
    if (draft.kind === "b2") {
      return {
        kind: "b2",
        bucket: draft.bucket.trim(),
        prefix: "",
        access_key_id: draft.accessKeyId.trim(),
        secret_access_key: draft.secret,
      };
    }
    return {
      kind: "s3",
      ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
      region: draft.region.trim(),
      bucket: draft.bucket.trim(),
      prefix: "",
      access_key_id: draft.accessKeyId.trim(),
      secret_access_key: draft.secret,
    };
  };

  const runTest = async () => {
    setSubmitted(true);
    const value = target();
    if (!value || Object.entries(problems).some(([key, p]) => key !== "scope" && p)) return;
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.post<BackupDestinationTestResult>("/backups/destinations/test", { target: value }));
    } catch (error) {
      setTest({
        ok: false,
        writable: false,
        latency_ms: null,
        used_bytes: null,
        error: toError(error).message,
        checked_at: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  };

  const already = existing !== null && existing.length > 0 && !created;
  const done = Boolean(created);
  const timezone = React.useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const submit = async () => {
    if (done || already) {
      await answer.answer("done");
      return;
    }
    setSubmitted(true);
    const value = target();
    if (!value || !server || Object.values(problems).some(Boolean)) return;

    const schedule = await save.run(async () => {
      // A destination that saved before the schedule failed is reused on
      // the retry, rather than tripping over its own unique name.
      const dest =
        destination ??
        (await api.post<BackupDestination>("/backups/destinations", {
          name: draft.kind === "local" ? `${server.name} local` : draft.bucket.trim().slice(0, 64),
          target: value,
        }));
      setDestination(dest);
      return api.post<BackupSchedule>("/backups/schedules", {
        name: `Nightly ${server.name}`.slice(0, 64),
        server_id: server.id,
        scope: [
          ...(scope.files ? [{ kind: "files", selectors: [] }] : []),
          ...(scope.databases ? [{ kind: "databases", selectors: [] }] : []),
          ...(scope.mail ? [{ kind: "mail", selectors: [] }] : []),
        ],
        cron: "0 3 * * *",
        timezone,
        destination_id: dest.id,
        retention: { keep_last: 3, keep_daily: 7, keep_weekly: 4, keep_monthly: 6 },
        encryption: true,
        enabled: true,
      });
    });
    if (schedule) setCreated(schedule);
  };

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={DatabaseBackup}
        title="Back it up every night"
        hint="Encrypted, deduplicated snapshots of your websites and databases, kept for months. Restores happen from Backups, file by file or all at once."
      />

      {(existing === null || loading) && <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Looking for backups" />}

      {existing !== null && already && (
        <ExistingList
          title="Already backing up"
          rows={existing.map((schedule) => ({
            key: schedule.id,
            primary: schedule.name,
            secondary: schedule.next_run_at ? <>next <RelativeTime value={schedule.next_run_at} /></> : schedule.destination_name,
          }))}
        />
      )}

      {existing !== null && !loading && !already && !done && servers.length === 0 && (
        <Note tone="warn">No server is connected, so there is nothing to back up yet. Set this up from Backups later.</Note>
      )}

      {existing !== null && !loading && !already && !done && server && (
        <>
          <FormField label="Where backups go">
            <RadioGroup value={draft.kind} onValueChange={(next) => set("kind", next as DestinationKind)} aria-label="Where backups go">
              {DESTINATION_OPTIONS.map((option) => (
                <Radio key={option.value} value={option.value} label={option.label} description={option.description} />
              ))}
            </RadioGroup>
          </FormField>

          {draft.kind === "local" ? (
            <FormField label="Folder" required error={err("path") ?? save.error?.fields["target.path"]}>
              <Input mono size="md" value={draft.path} onChange={(e) => set("path", e.target.value)} spellCheck={false} />
            </FormField>
          ) : (
            <>
              {draft.kind === "s3" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_10rem]">
                  <FormField label="Endpoint" description="Empty for Amazon S3.">
                    <Input mono size="md" value={draft.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://…r2.cloudflarestorage.com" spellCheck={false} autoComplete="off" />
                  </FormField>
                  <FormField label="Region" required error={err("region")}>
                    <Input mono size="md" value={draft.region} onChange={(e) => set("region", e.target.value)} spellCheck={false} autoComplete="off" />
                  </FormField>
                </div>
              )}
              <FormField label="Bucket" required error={err("bucket") ?? save.error?.fields["target.bucket"]}>
                <Input mono size="md" value={draft.bucket} onChange={(e) => set("bucket", e.target.value)} spellCheck={false} autoComplete="off" autoFocus />
              </FormField>
              <FormField
                label={draft.kind === "b2" ? "Key ID" : "Access key ID"}
                required
                error={err("accessKeyId")}
              >
                <Input mono size="md" value={draft.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} spellCheck={false} autoComplete="off" />
              </FormField>
              <FormField
                label={draft.kind === "b2" ? "Application key" : "Secret access key"}
                required
                description="Stored encrypted. Kaname never shows it again."
                error={err("secret")}
              >
                <Input
                  type="password"
                  mono
                  size="md"
                  value={draft.secret}
                  onChange={(e) => set("secret", e.target.value)}
                  autoComplete="off"
                />
              </FormField>
            </>
          )}

          <FormField label="What to back up" error={err("scope")}>
            <div className="flex flex-col gap-2">
              <Checkbox checked={scope.files} onChange={(e) => setScope({ ...scope, files: e.target.checked })} label="Website files" />
              <Checkbox checked={scope.databases} onChange={(e) => setScope({ ...scope, databases: e.target.checked })} label="Databases" />
              <Checkbox checked={scope.mail} onChange={(e) => setScope({ ...scope, mail: e.target.checked })} label="Mail" />
            </div>
          </FormField>

          <p className="text-sm text-[var(--kn-text-3)]">
            Every night at 03:00 ({timezone}). Keeps 7 daily, 4 weekly and 6 monthly snapshots,
            encrypted with a key only Kaname holds. All of it can be changed under Backups.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" size="sm" icon={Send} loading={testing} onClick={() => void runTest()}>
              Test the connection
            </Button>
            {test &&
              (test.ok ? (
                <span className="text-sm text-[var(--kn-ok)]">
                  Reachable and writable{test.latency_ms !== null ? ` · ${test.latency_ms} ms` : ""}.
                </span>
              ) : (
                <span className="text-sm text-[var(--kn-danger)]">{test.error ?? "Not reachable."}</span>
              ))}
          </div>

          <ServerSelect servers={servers} value={serverId} onChange={setServerId} description="The server to back up." />
        </>
      )}

      {created && (
        <ExistingList
          title="Backups are scheduled"
          rows={[
            {
              key: created.id,
              primary: created.name,
              secondary: created.next_run_at ? <>first run <RelativeTime value={created.next_run_at} /></> : created.destination_name,
            },
          ]}
        />
      )}

      <StepError error={save.error ?? answer.error} />

      <StepFooter
        primary={done || already ? "Continue" : "Schedule backups"}
        icon={done || already ? ArrowRight : undefined}
        pending={save.pending || answer.pending}
        disabled={!done && !already && (existing === null || loading || !server)}
        primaryAutoFocus={done || already}
        later={done || already ? undefined : () => void answer.answer("skipped")}
        laterLabel="Set up backups later"
      />
    </StepForm>
  );
}

/* ------------------------------------------------------------------ *
 * 9. Notifications and updates
 * ------------------------------------------------------------------ */

interface SmtpDraft {
  host: string;
  port: string;
  security: SmtpSecurity;
  username: string;
  password: string;
  from_address: string;
}

const EMPTY_SMTP: SmtpDraft = {
  host: "",
  port: "587",
  security: "starttls",
  username: "",
  password: "",
  from_address: "",
};

const CHECK_INTERVAL_LABELS: Record<UpdateCheckInterval, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekly: "Every week",
};

type AlertKind = "email" | "webhook" | "none";

export function NotificationsStep({ onAdvance, onStale }: StepProps) {
  const [kind, setKind] = React.useState<AlertKind>("email");
  const [address, setAddress] = React.useState("");
  const [webhook, setWebhook] = React.useState("");
  const [smtp, setSmtp] = React.useState<SmtpDraft>(EMPTY_SMTP);
  const [mailHost, setMailHost] = React.useState<string | null>(null);
  const [tier, setTier] = React.useState<UpdateTier>("notify");
  const [checkInterval, setCheckInterval] = React.useState<UpdateCheckInterval>("daily");
  const [smtpTest, setSmtpTest] = React.useState<NotificationTestResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const save = useStepAction(onStale);
  const answer = useAnswer({ onAdvance, onStale }, "notifications");

  // A mail server set up on the step before is the obvious way out.
  React.useEffect(() => {
    void api
      .list<MailServer>("/mail-servers", { params: { per_page: 1 } })
      .then((result) => setMailHost(result.data[0]?.hostname ?? null))
      .catch(() => setMailHost(null));
  }, []);

  const port = Number.parseInt(smtp.port, 10);
  const problems = {
    address: kind === "email" && !EMAIL_RE.test(address.trim()) ? "Enter the address alerts go to." : null,
    webhook: kind === "webhook" && !/^https?:\/\/\S+$/.test(webhook.trim()) ? "Enter the full URL, starting with https://." : null,
    port: kind === "email" && smtp.host.trim() && !(port >= 1 && port <= 65535) ? "Enter a port between 1 and 65535." : null,
    from: kind === "email" && smtp.from_address.trim() && !EMAIL_RE.test(smtp.from_address.trim()) ? "The sender must be an email address." : null,
  };
  const err = (key: keyof typeof problems, typed = false) => ((submitted || typed) && problems[key]) || undefined;

  const smtpBody = () => ({
    host: smtp.host.trim(),
    port,
    security: smtp.security,
    username: smtp.username.trim(),
    // A sender was not asked for separately: the address that receives
    // the mail is a fine default until Settings says otherwise.
    from_address: smtp.from_address.trim() || address.trim(),
    from_name: "Kaname",
    ...(smtp.password ? { password: smtp.password } : {}),
  });

  const testSmtp = async () => {
    setSubmitted(true);
    if (problems.address || problems.port || !smtp.host.trim()) return;
    setTesting(true);
    setSmtpTest(null);
    try {
      setSmtpTest(
        await api.post<NotificationTestResult>("/settings/notifications/smtp/test", {
          to: address.trim(),
          smtp: smtpBody(),
        }),
      );
    } catch (error) {
      setSmtpTest({ ok: false, error: toError(error).message, duration_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setSubmitted(true);
    if (Object.values(problems).some(Boolean)) return;
    const next = await save.run(() =>
      api.post<SetupState>("/setup/preferences", {
        update_tier: tier,
        // "Off" has no cadence; the contract's default stands.
        ...(tier !== "off" ? { update_interval: checkInterval } : {}),
        notification:
          kind === "email"
            ? { kind: "email", address: address.trim() }
            : kind === "webhook"
              ? { kind: "webhook", url: webhook.trim() }
              : { kind: "none" },
        ...(kind === "email" && smtp.host.trim() ? { smtp: smtpBody() } : {}),
      }),
    );
    if (next) onAdvance(next);
  };

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={Bell}
        title="Hear about it when something breaks"
        hint="Kaname tells you about failed jobs, a server going offline, a failed backup, a certificate about to expire and an update waiting — and stays quiet otherwise."
      />

      <FormField label="Send alerts to">
        <RadioGroup value={kind} onValueChange={(next) => setKind(next as AlertKind)} aria-label="Send alerts to" orientation="horizontal">
          <Radio value="email" label="Email" />
          <Radio value="webhook" label="A webhook" />
          <Radio value="none" label="Nowhere yet" />
        </RadioGroup>
      </FormField>

      {kind === "email" && (
        <>
          <FormField label="Address" required error={err("address") ?? save.error?.fields["notification.address"]}>
            <Input
              type="email"
              mono
              size="md"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="ops@example.com"
              autoFocus
            />
          </FormField>

          <fieldset className="flex flex-col gap-4 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] p-4">
            <legend className="px-1 text-sm font-medium text-[var(--kn-text)]">Outgoing mail server</legend>
            <p className="-mt-1 text-sm text-[var(--kn-text-2)]">
              Nothing is emailed until one is set.{" "}
              {mailHost ? (
                <>
                  Your new mail server works: host <MonoText>{mailHost}</MonoText>, port 587, and a
                  mailbox on it as the username.
                </>
              ) : (
                "Your provider's SMTP details, or leave this for Settings."
              )}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_6rem_8rem]">
              <FormField label="Host">
                <Input mono size="md" placeholder={mailHost ?? "smtp.example.com"} spellCheck={false} autoComplete="off" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
              </FormField>
              <FormField label="Port" error={err("port", true)}>
                <Input mono size="md" inputMode="numeric" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
              </FormField>
              <FormField label="Security">
                <Select
                  size="md"
                  value={smtp.security}
                  onChange={(e) => setSmtp({ ...smtp, security: e.target.value as SmtpSecurity })}
                  options={[
                    { value: "starttls", label: "STARTTLS" },
                    { value: "tls", label: "TLS" },
                    { value: "none", label: "None" },
                  ]}
                />
              </FormField>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Username">
                <Input mono size="md" spellCheck={false} autoComplete="off" value={smtp.username} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} />
              </FormField>
              <FormField label="Password" description="Stored encrypted; never shown again.">
                <Input type="password" mono size="md" autoComplete="new-password" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} />
              </FormField>
            </div>
            <FormField label="Sender" description="Defaults to the address above." error={err("from", true)}>
              <Input mono size="md" type="email" spellCheck={false} autoComplete="off" value={smtp.from_address} onChange={(e) => setSmtp({ ...smtp, from_address: e.target.value })} />
            </FormField>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" size="sm" icon={Send} loading={testing} disabled={!smtp.host.trim()} onClick={() => void testSmtp()}>
                Send a test email
              </Button>
              {smtpTest &&
                (smtpTest.ok ? (
                  <span className="text-sm text-[var(--kn-ok)]">Delivered in {smtpTest.duration_ms} ms.</span>
                ) : (
                  <span className="text-sm text-[var(--kn-danger)]">{smtpTest.error}</span>
                ))}
            </div>
          </fieldset>
        </>
      )}

      {kind === "webhook" && (
        <FormField
          label="Webhook URL"
          required
          description="Receives a JSON body for each alert. Add a signing secret later in Settings."
          error={err("webhook") ?? save.error?.fields["notification.url"]}
        >
          <Input mono size="md" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://hooks.example.com/kaname" spellCheck={false} autoComplete="off" autoFocus />
        </FormField>
      )}

      <FormField label="Kaname updates" description={UPDATE_TIER_LABELS[tier].detail}>
        <div className="flex flex-wrap gap-2">
          <Select
            size="md"
            boxClassName="min-w-0 flex-1"
            aria-label="What to do with updates"
            value={tier}
            onChange={(event) => setTier(event.target.value as UpdateTier)}
            options={updateTierEnum.options
              // Applying everything unattended is a decision to make
              // deliberately in Settings, not to click past on day one.
              .filter((option) => option !== "auto_all")
              .map((option) => ({ value: option, label: UPDATE_TIER_LABELS[option].label }))}
          />
          {tier !== "off" && (
            <Select
              size="md"
              boxClassName="w-40"
              aria-label="How often to check for updates"
              value={checkInterval}
              onChange={(event) => setCheckInterval(event.target.value as UpdateCheckInterval)}
              options={updateCheckIntervalEnum.options.map((option) => ({ value: option, label: CHECK_INTERVAL_LABELS[option] }))}
            />
          )}
        </div>
      </FormField>

      <StepError error={save.error ?? answer.error} exclude={["notification.address", "notification.url"]} />

      <StepFooter
        primary="Save and continue"
        icon={ArrowRight}
        pending={save.pending}
        later={() => void answer.answer("skipped")}
        laterPending={answer.pending}
        laterLabel="Use the defaults"
      />
    </StepForm>
  );
}

/* ------------------------------------------------------------------ *
 * 10. Invite a teammate
 * ------------------------------------------------------------------ */

type InvitedUser = User & { invite: { url: string; expires_at: string } };

export function TeamStep({ onAdvance, onStale }: StepProps) {
  const [roles, setRoles] = React.useState<Role[] | null>(null);
  const [others, setOthers] = React.useState<User[]>([]);
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [roleId, setRoleId] = React.useState("");
  const [sendInvite, setSendInvite] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [invited, setInvited] = React.useState<InvitedUser | null>(null);
  const invite = useStepAction(onStale);
  const answer = useAnswer({ onAdvance, onStale }, "team");

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.list<Role>("/roles", { params: { per_page: 100 } }),
      api.list<User>("/users", { params: { per_page: 10 } }),
    ])
      .then(([roleList, userList]) => {
        if (cancelled) return;
        // Owner is the account you just made; a second one is a decision
        // for Administration, not a default in a wizard.
        const offered = roleList.data.filter((role) => role.slug !== "owner");
        setRoles(offered);
        setRoleId((current) => current || (offered.find((r) => r.slug === "admin") ?? offered[0])?.id || "");
        setOthers(userList.data.filter((user) => !user.roles?.some((role) => role.slug === "owner")));
      })
      .catch(() => !cancelled && setRoles([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const problems = {
    email: !EMAIL_RE.test(email.trim()) ? "Enter their email address." : null,
    name: !name.trim() ? "Enter their name." : null,
    role: !roleId ? "Choose what they may do." : null,
  };
  const err = (key: keyof typeof problems, typed = false) => ((submitted || typed) && problems[key]) || undefined;
  const already = others.length > 0 && !invited;

  const submit = async () => {
    if (invited || already) {
      await answer.answer("done");
      return;
    }
    setSubmitted(true);
    if (Object.values(problems).some(Boolean)) return;
    const user = await invite.run(() =>
      api.post<InvitedUser>("/users", {
        email: email.trim(),
        name: name.trim(),
        role_ids: [roleId],
        send_invite: sendInvite,
      }),
    );
    if (user) setInvited(user);
  };

  const role = roles?.find((candidate) => candidate.id === roleId);

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={UserPlus}
        title="Invite a teammate"
        hint="They choose their own password from a link. Nobody, including you, ever knows another person's credential. Roles can be narrowed to particular servers later."
      />

      {roles === null && <Skeleton className="h-24 rounded-[var(--kn-r-md)]" label="Loading roles" />}

      {roles !== null && already && (
        <ExistingList
          title="Already on this panel"
          rows={others.slice(0, 5).map((user) => ({ key: user.id, primary: user.email, secondary: user.status }))}
        />
      )}

      {roles !== null && !already && !invited && (
        <>
          <FormField label="Email" required error={err("email", email.includes("@")) ?? invite.error?.fields.email}>
            <Input type="email" mono size="md" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" autoFocus placeholder="sam@example.com" />
          </FormField>
          <FormField label="Name" required error={err("name") ?? invite.error?.fields.name}>
            <Input size="md" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </FormField>
          <FormField label="Role" required description={role?.description} error={err("role") ?? invite.error?.fields.role_ids}>
            <Select
              size="md"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              options={roles.map((r) => ({ value: r.id, label: r.name }))}
            />
          </FormField>
          <Switch
            checked={sendInvite}
            onChange={(e) => setSendInvite(e.target.checked)}
            label="Email the invitation"
            description="Needs the outgoing mail server from the previous step. Off, you get the link to send yourself."
          />
        </>
      )}

      {invited && (
        <div className="flex flex-col gap-2">
          <CopyableCode value={invited.invite.url} label={`Invitation link for ${invited.email}`} block />
          <p className="text-sm text-[var(--kn-text-2)]">
            Shown once. Expires <RelativeTime value={invited.invite.expires_at} />. Send it over a
            channel you already trust — whoever holds it sets the password for this account.
          </p>
        </div>
      )}

      <StepError error={invite.error ?? answer.error} exclude={["email", "name", "role_ids"]} />

      <StepFooter
        primary={invited || already ? "Continue" : "Send invitation"}
        icon={invited || already ? ArrowRight : undefined}
        pending={invite.pending || answer.pending}
        disabled={roles === null}
        primaryAutoFocus={Boolean(invited || already)}
        later={invited || already ? undefined : () => void answer.answer("skipped")}
        laterLabel="Not now"
      />
    </StepForm>
  );
}
