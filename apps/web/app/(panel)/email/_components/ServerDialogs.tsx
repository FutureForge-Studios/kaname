"use client";

import * as React from "react";
import { ExternalLink, KeyRound, Link2, TriangleAlert } from "lucide-react";
import type {
  Domain,
  Job,
  MailRelayInput,
  MailRelayProvider,
  MailSendingMode,
  Server,
} from "@kaname/contract";
import {
  Button,
  Combobox,
  CopyableCode,
  FormField,
  Input,
  JobProgress,
  JobStatusPill,
  MonoText,
  Radio,
  RadioGroup,
  SectionCard,
  Select,
  Skeleton,
  type ComboboxOption,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useJob, useList, useServers } from "@/lib/queries";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { PasswordField } from "../../_components/password";
import {
  useAdoptMailServer,
  useDeployMailServer,
  useLatestMailRelease,
  useMailServers,
  useRevealDeploySecrets,
} from "./queries";
import { RELAY_PROVIDERS, RELAY_PROVIDER_LABELS } from "./status";

/* ------------------------------------------------------------------ *
 * Deploying and adopting a Yunori Mail Server.
 *
 * The deploy dialog asks exactly what Yunori's own installer asks —
 * domain, hostname, alerts address, first mailbox, direct or relay —
 * and nothing else, because the installer already has sensible answers
 * for everything else and verifies the rest against public DNS itself.
 *
 * What comes back is a job. Only when it succeeds does the panel ask the
 * control plane for the deploy secrets, which it hands over once: the
 * setup link that claims the Yunori console, and the first mailbox's
 * password. Both are shown here and nowhere else, ever (KD-024).
 * ------------------------------------------------------------------ */

export const LOCAL_PART = /^[A-Za-z0-9._%+-]+$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Providers whose SMTP host follows from the region, so the field is hidden. */
const REGION_PROVIDERS = new Set<MailRelayProvider>(["ses", "resend"]);
const HOST_HIDDEN_PROVIDERS = new Set<MailRelayProvider>(["ses"]);
/** Resend's username is fixed; it must not be asked for. */
const FIXED_USERNAME_PROVIDERS = new Set<MailRelayProvider>(["resend"]);

/* ----------------------------- host picker --------------------------- */

interface HostPickerProps {
  value: string | null;
  onChange: (serverId: string | null) => void;
  /** Hosts without this capability cannot be chosen. */
  capability: Server["capabilities"][number];
  /** Keep hosts whose agent is away out of the list; the job would only queue. */
  connectedOnly?: boolean;
  id?: string;
}

/**
 * Not the page-level ServerPicker, which writes to the URL: a choice
 * inside a dialog belongs to the dialog.
 */
function HostPicker({ value, onChange, capability, connectedOnly = false, id }: HostPickerProps) {
  const query = useServers();
  const servers = React.useMemo(
    () =>
      (query.data?.data ?? []).filter((server) => {
        if (!server.capabilities.includes(capability)) return false;
        if (connectedOnly && server.connection !== "connected") return false;
        return true;
      }),
    [capability, connectedOnly, query.data],
  );

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      servers.map((server) => ({
        value: server.id,
        label: server.name,
        description: server.hostname,
        mono: true,
      })),
    [servers],
  );

  if (query.isLoading) {
    return <Skeleton className="h-8 w-full rounded-[var(--kn-r-md)]" label="Loading servers" />;
  }

  return (
    <Combobox
      id={id}
      size="md"
      options={options}
      value={value ?? ""}
      onValueChange={(next) => onChange(next && next.length > 0 ? next : null)}
      placeholder={servers.length === 0 ? "No eligible server" : "Select a server"}
      emptyMessage="No server matches that name."
      disabled={servers.length === 0}
      mono
      aria-label="Server"
    />
  );
}

/* ----------------------------- domain picker ------------------------- */

function KanameDomainPicker({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (domain: Domain | null) => void;
  id?: string;
}) {
  const query = useList<Domain>("domains", { per_page: 200, sort: "name", order: "asc" });
  const domains = query.data?.data ?? [];

  const options = React.useMemo<ComboboxOption[]>(
    () =>
      domains.map((domain) => ({
        value: domain.id,
        label: domain.name,
        description: domain.verified ? "Control verified" : "Control not yet verified",
        mono: true,
      })),
    [domains],
  );

  if (query.isLoading) {
    return <Skeleton className="h-8 w-full rounded-[var(--kn-r-md)]" label="Loading domains" />;
  }

  return (
    <Combobox
      id={id}
      size="md"
      options={options}
      value={value ?? ""}
      onValueChange={(next) => onChange(domains.find((domain) => domain.id === next) ?? null)}
      placeholder={domains.length === 0 ? "No domain in Kaname yet" : "Select a domain"}
      emptyMessage="No domain matches that name."
      disabled={domains.length === 0}
      mono
      aria-label="Domain"
    />
  );
}

/* ------------------------------- deploy ------------------------------ */

export interface DeployDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the queued job and the host it targets. */
  onQueued: (job: Job, serverId: string) => void;
}

export interface RelayDraft {
  provider: MailRelayProvider;
  region: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

export const EMPTY_RELAY: RelayDraft = {
  provider: "ses",
  region: "",
  host: "",
  port: "587",
  username: "",
  password: "",
};

export function DeployDialog({ open, onOpenChange, onQueued }: DeployDialogProps) {
  const deploy = useDeployMailServer();
  const release = useLatestMailRelease(open);
  const servers = useServers();

  const [serverId, setServerId] = React.useState<string | null>(null);
  const [domain, setDomain] = React.useState<Domain | null>(null);
  const [hostname, setHostname] = React.useState("");
  const [hostnameTouched, setHostnameTouched] = React.useState(false);
  const [adminEmail, setAdminEmail] = React.useState("");
  const [firstMailbox, setFirstMailbox] = React.useState("hello");
  const [sending, setSending] = React.useState<MailSendingMode>("direct");
  const [relay, setRelay] = React.useState<RelayDraft>(EMPTY_RELAY);

  React.useEffect(() => {
    if (open) return;
    setServerId(null);
    setDomain(null);
    setHostname("");
    setHostnameTouched(false);
    setAdminEmail("");
    setFirstMailbox("hello");
    setSending("direct");
    setRelay(EMPTY_RELAY);
    deploy.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on close
  }, [open]);

  /* mail.<domain> is what Yunori suggests too; the operator can still
   * type something else, and we stop suggesting once they have. */
  const suggestedHostname = domain ? `mail.${domain.name}` : "";
  const effectiveHostname = hostnameTouched ? hostname : suggestedHostname;

  const fields = fieldErrors(deploy.error);
  const hostnameValid = effectiveHostname.length === 0 || HOSTNAME.test(effectiveHostname);
  const emailValid = EMAIL.test(adminEmail);
  const emailOnOwnDomain =
    domain !== null && adminEmail.toLowerCase().endsWith(`@${domain.name.toLowerCase()}`);
  const mailboxValid = LOCAL_PART.test(firstMailbox);
  const relayValid = sending === "direct" || relayDraftValid(relay);

  const canSubmit =
    serverId !== null &&
    domain !== null &&
    hostnameValid &&
    emailValid &&
    !emailOnOwnDomain &&
    mailboxValid &&
    relayValid;

  const submit = () => {
    if (!serverId || !domain) return;
    const serverName = servers.data?.data.find((server) => server.id === serverId)?.name ?? "the host";
    deploy.mutate(
      {
        server_id: serverId,
        server_name: serverName,
        domain_id: domain.id,
        ...(effectiveHostname ? { hostname: effectiveHostname.toLowerCase() } : {}),
        admin_email: adminEmail.trim(),
        first_mailbox: firstMailbox.trim().toLowerCase(),
        sending,
        force: false,
        skip_ptr: false,
        ...(sending === "relay" ? { relay: relayInput(relay) } : {}),
      },
      {
        onSuccess: (jobs) => {
          const first = jobs[0];
          onOpenChange(false);
          if (first) onQueued(first, serverId);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Deploy Yunori Mail Server"
      description="Kaname installs the yunori-mail binary on the host and runs its installer with these answers. Steps that need you — pointing DNS here, setting reverse DNS — pause and show up on the server card."
      submitLabel="Deploy"
      submitting={deploy.isPending}
      canSubmit={canSubmit}
      error={deploy.error}
      onSubmit={submit}
      size="lg"
      footerExtra={
        <span className="text-xs text-[var(--kn-text-3)]">
          {release.data ? (
            <>
              Installs yunori-mail <MonoText>{release.data.version}</MonoText>
              {release.data.notes_url && (
                <>
                  {" · "}
                  <a
                    href={release.data.notes_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[var(--kn-accent-400)] hover:underline"
                  >
                    Release notes
                    <ExternalLink size={10} aria-hidden />
                  </a>
                </>
              )}
            </>
          ) : release.isError ? (
            "The release feed could not be read; the control plane installs the newest version it knows."
          ) : (
            "Looking up the latest release…"
          )}
        </span>
      }
    >
      <FormField
        label="Server"
        required
        description="A connected host with systemd. Yunori wants a fresh server: nothing else listening on 25, 80, 443, 465, 587 or 993."
        error={fields["server_id"]}
      >
        <HostPicker value={serverId} onChange={setServerId} capability="systemd" connectedOnly />
      </FormField>

      <FormField
        label="Domain"
        required
        description="Becomes the primary mail domain. The A record for the mail hostname should already point at the host."
        error={fields["domain_id"]}
      >
        <KanameDomainPicker value={domain?.id ?? null} onChange={setDomain} />
      </FormField>

      <FormField
        label="Mail hostname"
        description="What mail apps connect to and what the certificate is issued for."
        error={
          fields["hostname"] ?? (!hostnameValid ? "Enter a fully qualified hostname." : undefined)
        }
      >
        <Input
          mono
          value={effectiveHostname}
          placeholder={domain ? `mail.${domain.name}` : "mail.example.com"}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setHostnameTouched(true);
            setHostname(event.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField
        label="Admin email"
        required
        description="On another provider — this address receives certificate and alert mail about this server. If it lived on this server, an outage would take its own alerts down with it."
        error={
          fields["admin_email"] ??
          (emailOnOwnDomain
            ? `That address is on ${domain?.name}, the domain this server will host. Use one elsewhere.`
            : adminEmail.length > 0 && !emailValid
              ? "Enter a full email address."
              : undefined)
        }
      >
        <Input
          type="email"
          mono
          value={adminEmail}
          placeholder="you@gmail.com"
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAdminEmail(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField
        label="First mailbox"
        required
        description="Created at the end of the install. Its password is shown once, here, when the deploy finishes."
        hint={domain ? <MonoText muted>{`${firstMailbox || "…"}@${domain.name}`}</MonoText> : undefined}
        error={
          fields["first_mailbox"] ??
          (firstMailbox.length > 0 && !mailboxValid
            ? "Use letters, digits, dots, dashes or underscores."
            : undefined)
        }
      >
        <Input
          mono
          value={firstMailbox}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setFirstMailbox(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField
        label="Sending"
        description="Relay is the answer when the provider blocks outbound port 25. DKIM is still signed on the host either way."
        error={fields["sending"]}
      >
        <RadioGroup
          value={sending}
          onValueChange={(next) => setSending(next === "relay" ? "relay" : "direct")}
          aria-label="Sending mode"
        >
          <Radio
            value="direct"
            label="Direct"
            description="This host delivers mail itself over port 25. Needs outbound 25 open and reverse DNS set at the provider."
          />
          <Radio
            value="relay"
            label="Through a relay"
            description="Outbound mail goes to a sending service; inbound still arrives here."
          />
        </RadioGroup>
      </FormField>

      {sending === "relay" && (
        <RelayFields value={relay} onChange={setRelay} fields={fields} />
      )}
    </FormDialog>
  );
}

/** Whether a relay draft has everything its provider needs. */
export function relayDraftValid(relay: RelayDraft): boolean {
  const port = Number.parseInt(relay.port, 10);
  return (
    relay.password.length > 0 &&
    Number.isFinite(port) &&
    port >= 1 &&
    port <= 65535 &&
    (!REGION_PROVIDERS.has(relay.provider) || relay.region.trim().length > 0) &&
    (HOST_HIDDEN_PROVIDERS.has(relay.provider) ||
      REGION_PROVIDERS.has(relay.provider) ||
      relay.host.trim().length > 0)
  );
}

/** The `relay` part of deployMailServerInput, from a draft. */
export function relayInput(relay: RelayDraft): MailRelayInput {
  return {
    provider: relay.provider,
    port: Number.parseInt(relay.port, 10),
    ...(REGION_PROVIDERS.has(relay.provider) && relay.region.trim()
      ? { region: relay.region.trim() }
      : {}),
    ...(!HOST_HIDDEN_PROVIDERS.has(relay.provider) && relay.host.trim()
      ? { host: relay.host.trim() }
      : {}),
    ...(!FIXED_USERNAME_PROVIDERS.has(relay.provider) && relay.username.trim()
      ? { username: relay.username.trim() }
      : {}),
    password: relay.password,
  };
}

export interface RelayFieldsProps {
  value: RelayDraft;
  onChange: (next: RelayDraft) => void;
  fields: Record<string, string>;
}

export function RelayFields({ value, onChange, fields }: RelayFieldsProps) {
  const set = <K extends keyof RelayDraft>(key: K, next: RelayDraft[K]) =>
    onChange({ ...value, [key]: next });

  const showRegion = REGION_PROVIDERS.has(value.provider);
  const showHost = !HOST_HIDDEN_PROVIDERS.has(value.provider);
  const showUsername = !FIXED_USERNAME_PROVIDERS.has(value.provider);

  return (
    <fieldset className="flex flex-col gap-3 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] p-3">
      <legend className="px-1 text-xs font-medium text-[var(--kn-text-2)]">Relay</legend>

      <FormField label="Provider" required error={fields["relay.provider"]}>
        <Select
          value={value.provider}
          onChange={(event) => set("provider", event.target.value as MailRelayProvider)}
          options={RELAY_PROVIDERS.map((provider) => ({
            value: provider,
            label: RELAY_PROVIDER_LABELS[provider],
          }))}
        />
      </FormField>

      {showRegion && (
        <FormField
          label="Region"
          required
          description={
            value.provider === "ses"
              ? "The SMTP host follows the region, e.g. eu-west-1."
              : "Resend's bounce records are filled in for this region."
          }
          error={fields["relay.region"]}
        >
          <Input
            mono
            value={value.region}
            placeholder={value.provider === "ses" ? "eu-west-1" : "us-east-1"}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => set("region", event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
        {showHost && (
          <FormField
            label="SMTP host"
            required={!showRegion}
            description={showRegion ? "Leave empty to use the provider's host for the region." : undefined}
            error={fields["relay.host"]}
          >
            <Input
              mono
              value={value.host}
              placeholder="smtp.example.com"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => set("host", event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        )}
        <FormField label="Port" required error={fields["relay.port"]}>
          <Input
            mono
            inputMode="numeric"
            value={value.port}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => set("port", event.target.value)}
            autoComplete="off"
          />
        </FormField>
      </div>

      {showUsername && (
        <FormField
          label="Username"
          description={
            value.provider === "ses"
              ? "The SMTP credential's access key, not an AWS access key for the account."
              : "Leave empty if the provider uses the API key alone."
          }
          error={fields["relay.username"]}
        >
          <Input
            mono
            value={value.username}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => set("username", event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      )}

      <PasswordField
        label={value.provider === "resend" || value.provider === "postmark" ? "API key" : "Password"}
        value={value.password}
        onChange={(next) => set("password", next)}
        description="Travels to the host once and is never stored by Kaname. Paste the provider's SMTP password or token."
        error={fields["relay.password"]}
      />
    </fieldset>
  );
}

/* -------------------------------- adopt ------------------------------ */

export interface AdoptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * For a server where someone already ran Yunori's one-line installer by
 * hand. Kaname only records it and reads it; nothing is reinstalled.
 */
export function AdoptDialog({ open, onOpenChange }: AdoptDialogProps) {
  const adopt = useAdoptMailServer();
  const servers = useServers();
  const existing = useMailServers();

  const [serverId, setServerId] = React.useState<string | null>(null);
  const [hostname, setHostname] = React.useState("");
  const [adminEmail, setAdminEmail] = React.useState("");

  React.useEffect(() => {
    if (open) return;
    setServerId(null);
    setHostname("");
    setAdminEmail("");
    adopt.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on close
  }, [open]);

  const fields = fieldErrors(adopt.error);
  const alreadyManaged =
    serverId !== null && (existing.data?.data ?? []).some((row) => row.server_id === serverId);
  const hostnameValid = hostname.length === 0 || HOSTNAME.test(hostname);
  const emailValid = adminEmail.length === 0 || EMAIL.test(adminEmail);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adopt an existing Yunori Mail Server"
      description="For a host where yunori-mail was installed by hand. Kaname records it and reads its status, domains and mailboxes; nothing on the host changes."
      submitLabel="Adopt"
      submitting={adopt.isPending}
      canSubmit={serverId !== null && !alreadyManaged && hostnameValid && emailValid}
      error={adopt.error}
      onSubmit={() => {
        if (!serverId) return;
        const serverName = servers.data?.data.find((server) => server.id === serverId)?.name ?? "the host";
        adopt.mutate(
          {
            server_id: serverId,
            server_name: serverName,
            ...(hostname ? { hostname: hostname.toLowerCase() } : {}),
            ...(adminEmail ? { admin_email: adminEmail.trim() } : {}),
          },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
    >
      <FormField
        label="Server"
        required
        description="Only hosts whose agent reports the yunori capability are listed."
        error={
          fields["server_id"] ??
          (alreadyManaged ? "Kaname already manages the mail server on this host." : undefined)
        }
      >
        <HostPicker value={serverId} onChange={setServerId} capability="yunori" />
      </FormField>

      <FormField
        label="Mail hostname"
        description="Optional. Left empty, Kaname reads it from the host."
        error={fields["hostname"] ?? (!hostnameValid ? "Enter a fully qualified hostname." : undefined)}
      >
        <Input
          mono
          value={hostname}
          placeholder="mail.example.com"
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setHostname(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField
        label="Admin email"
        description="Optional. Where certificate and alert mail about this server goes."
        error={fields["admin_email"] ?? (!emailValid ? "Enter a full email address." : undefined)}
      >
        <Input
          type="email"
          mono
          value={adminEmail}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAdminEmail(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>
    </FormDialog>
  );
}

/* ---------------------------- finish setup --------------------------- */

export interface PendingSetup {
  job: Job;
  /** The host the deploy targeted; the mail server row is found through it. */
  serverId: string;
}

export interface FinishSetupPanelProps {
  pending: PendingSetup;
  /**
   * Omitted where something around the panel owns moving on (the setup
   * wizard), so the card does not offer a second way out.
   */
  onDismiss?: () => void;
}

/**
 * Follows the deploy job and, once it has succeeded, offers the two
 * secrets the install produced. They are fetched on a click rather than
 * on arrival so that a panel left open on another tab does not spend the
 * one read while nobody is looking.
 */
export function FinishSetupPanel({ pending, onDismiss }: FinishSetupPanelProps) {
  const jobQuery = useJob(pending.job.id);
  const job = jobQuery.data ?? pending.job;
  const servers = useMailServers();
  const mailServer = servers.data?.data.find((row) => row.server_id === pending.serverId) ?? null;
  const reveal = useRevealDeploySecrets();

  const succeeded = job.status === "succeeded";
  const failed = job.status === "failed" || job.status === "cancelled" || job.status === "timed_out";

  return (
    <SectionCard
      title="Finish setup"
      icon={KeyRound}
      description={
        succeeded
          ? "The install finished. Two things were produced that Kaname shows once and does not keep."
          : failed
            ? "The deploy did not finish. The job log has the step that failed."
            : "Yunori is being installed. This panel fills in when the job finishes."
      }
      actions={
        onDismiss && (
          <Button variant="ghost" size="xs" onClick={onDismiss}>
            {succeeded && reveal.data ? "Done" : "Dismiss"}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <JobStatusPill status={job.status} size="xs" blockedReason={job.blocked_reason} />
          <span className="min-w-0 truncate text-[var(--kn-text)]">{job.label}</span>
          {job.server_name && (
            <MonoText muted className="text-xs">
              {job.server_name}
            </MonoText>
          )}
        </div>
        {!succeeded && !failed && (
          <JobProgress value={job.progress} status={job.status} label="Deploy progress" />
        )}
        {job.error && (
          <p className="text-sm text-[var(--kn-danger)]">
            <MonoText>{job.error.code}</MonoText> — {job.error.message}
          </p>
        )}

        {succeeded && !reveal.data && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-[var(--kn-text-2)]">
              The setup link claims the Yunori console and the first mailbox's password opens its
              inbox. Reveal them when you are ready to copy them: the control plane hands them over
              exactly once.
            </p>
            {reveal.error && <PageError error={reveal.error} context="Deploy secrets" />}
            <div>
              <Button
                variant="primary"
                size="sm"
                icon={KeyRound}
                loading={reveal.isPending}
                disabled={!mailServer}
                onClick={() => mailServer && reveal.mutate(mailServer.id)}
              >
                Reveal setup link and password
              </Button>
              {!mailServer && !servers.isLoading && (
                <p className="mt-1 text-xs text-[var(--kn-text-3)]">
                  Waiting for the mail server record to appear.
                </p>
              )}
            </div>
          </div>
        )}

        {reveal.data && (
          <div className="flex flex-col gap-3">
            {reveal.data.setup_url ? (
              <div className="flex flex-col gap-1.5">
                <CopyableCode value={reveal.data.setup_url} label="Console setup link" />
                <p className="flex items-start gap-1.5 text-sm text-[var(--kn-warn)]">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
                  Anyone with this link can claim the console until you do. Open it now, create the
                  owner account, and it stops working.
                </p>
                <a
                  href={reveal.data.setup_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 self-start text-sm text-[var(--kn-accent-400)] hover:underline"
                >
                  <Link2 size={12} aria-hidden />
                  Open the setup link
                </a>
              </div>
            ) : (
              <p className="text-sm text-[var(--kn-text-2)]">
                No setup link was produced — the console was already claimed on this host.
              </p>
            )}

            {reveal.data.first_mailbox && reveal.data.first_mailbox_password ? (
              <div className="flex flex-col gap-1.5">
                <CopyableCode value={reveal.data.first_mailbox} label="First mailbox" />
                <CopyableCode
                  value={reveal.data.first_mailbox_password}
                  label={`Password for ${reveal.data.first_mailbox}`}
                />
                <p className="text-sm text-[var(--kn-text-2)]">
                  Store it in your password manager now; Kaname does not keep it. A reset from the
                  Mailboxes page is the only way to get another.
                </p>
              </div>
            ) : (
              <p className="text-sm text-[var(--kn-text-2)]">
                The first mailbox was not created by this deploy. Create one from the Mailboxes page.
              </p>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
