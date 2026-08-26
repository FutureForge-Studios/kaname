"use client";

import * as React from "react";
import {
  Archive,
  ArrowUpCircle,
  Bell,
  Globe,
  Plus,
  RadioTower,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  UPDATE_TIER_LABELS,
  notificationChannelKind,
  notificationEvent,
  releaseChannel as releaseChannelEnum,
  updateCheckInterval as updateCheckIntervalEnum,
  updateTier as updateTierEnum,
  type BackupDestination,
  type NotificationChannel,
  type NotificationEvent,
  type ReleaseChannel,
  type SettingsDocument,
  type UpdateCheckInterval,
  type UpdateOverview,
  type UpdateTier,
} from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  FieldRow,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  cn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import {
  domainProblem,
  normalizeDomain,
  type PanelAddress,
  type PanelAddressApplying,
} from "@/lib/address";
import { api, type ApiError } from "@/lib/api";
import type { IconComponent } from "@/lib/icons";
import { timeZoneOptions } from "@/lib/cron";
import { pluralize } from "@/lib/format";
import { useCan, useList, useResource, useResourceMutation } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Settings.
 *
 * One save button per section, never one for the page. That is
 * deliberate: a single "Save everything" would let a stray keystroke in
 * the ACME block ride along with a deliberate change to session
 * lifetime, and the audit entry would record both as one act.
 *
 * The rows are FieldRow rather than stacked FormFields because settings
 * are read far more often than they are edited — a dense two-column
 * list is scannable, a column of large labelled inputs is not.
 * ------------------------------------------------------------------ */

const EVENT_LABELS: Record<NotificationEvent, string> = {
  job_failed: "Job failed",
  server_offline: "Server went offline",
  service_failed: "Service failed",
  certificate_expiring: "Certificate expiring",
  backup_failed: "Backup failed",
  threat_detected: "Threat detected",
  alert_firing: "Alert firing",
  deployment_failed: "Deployment failed",
};

export default function SettingsPage() {
  const can = useCan();
  const readOnly = !can("admin.settings:write");
  const settings = useResource<SettingsDocument>("settings", "document", { path: "/settings" });
  const doc = settings.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Settings"
        subtitle={doc?.panel.url}
        actions={
          readOnly && (
            <Badge tone="neutral" size="sm">
              read only
            </Badge>
          )
        }
      />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        {settings.isError && (
          <PageError
            error={settings.error}
            onRetry={() => void settings.refetch()}
            context="Settings"
          />
        )}

        {settings.isLoading && (
          <>
            {[0, 1, 2].map((index) => (
              <Skeleton
                key={index}
                className="h-56 rounded-[var(--kn-r-md)]"
                label={index === 0 ? "Loading settings" : undefined}
              />
            ))}
          </>
        )}

        {doc && (
          <>
            <PanelSection value={doc.panel} readOnly={readOnly} />
            <AddressSection readOnly={readOnly} />
            <UpdatesSection readOnly={readOnly} />
            <SecuritySection value={doc.security} readOnly={readOnly} />
            <AgentsSection value={doc.agents} readOnly={readOnly} />
            <AcmeSection value={doc.acme} readOnly={readOnly} />
            <BackupsSection value={doc.backups} readOnly={readOnly} />
            <NotificationsSection value={doc.notifications.channels} readOnly={readOnly} />
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Section plumbing
 * ------------------------------------------------------------------ */

interface SectionState<T> {
  draft: T;
  setDraft: React.Dispatch<React.SetStateAction<T>>;
  patch: (next: Partial<T>) => void;
  dirty: boolean;
  reset: () => void;
  commit: (saved: T) => void;
}

/**
 * Baselines against the serialised server value rather than object
 * identity: a refetch that returns the same settings must not light up
 * every "unsaved changes" marker on the page.
 */
function useSection<T>(value: T): SectionState<T> {
  const [draft, setDraft] = React.useState<T>(value);
  const baseline = React.useRef(JSON.stringify(value));

  React.useEffect(() => {
    const next = JSON.stringify(value);
    if (next === baseline.current) return;
    baseline.current = next;
    setDraft(value);
  }, [value]);

  return {
    draft,
    setDraft,
    patch: (next) => setDraft((prev) => ({ ...prev, ...next })),
    dirty: JSON.stringify(draft) !== baseline.current,
    reset: () => setDraft(JSON.parse(baseline.current) as T),
    commit: (saved) => {
      baseline.current = JSON.stringify(saved);
    },
  };
}

interface SettingsSectionProps {
  title: string;
  description: string;
  icon: IconComponent;
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  error: ApiError | null;
  onSave: () => void;
  onReset: () => void;
  children: React.ReactNode;
}

function SettingsSection({
  title,
  description,
  icon: Icon,
  dirty,
  saving,
  readOnly,
  error,
  onSave,
  onReset,
  children,
}: SettingsSectionProps) {
  return (
    <section className="overflow-hidden rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface)]">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-[var(--kn-border)] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={14} className="shrink-0 text-[var(--kn-text-3)]" aria-hidden />
          <div className="min-w-0">
            <h2 className="truncate font-medium text-[var(--kn-text)]">{title}</h2>
            <p className="mt-0.5 text-sm text-[var(--kn-text-2)]">{description}</p>
          </div>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-1.5">
            {dirty && (
              <Button variant="ghost" size="xs" onClick={onReset} disabled={saving}>
                Discard
              </Button>
            )}
            <Button
              variant="primary"
              size="xs"
              icon={Save}
              disabled={!dirty}
              loading={saving}
              onClick={onSave}
            >
              Save
            </Button>
          </div>
        )}
      </div>

      <div className="px-4 py-1">
        {error && (
          <div className="py-3">
            <PageError error={error} onRetry={onSave} context={title} />
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/**
 * One PATCH shape for every section, so the audit entries line up, and
 * one place that re-baselines the draft against what the server
 * actually stored rather than against what was sent.
 */
function useSectionSave<T>(
  section: SectionState<T>,
  patchBody: () => Record<string, unknown>,
  read: (document: SettingsDocument) => T,
  label: string,
) {
  const [error, setError] = React.useState<ApiError | null>(null);

  const mutation = useResourceMutation<void, SettingsDocument>({
    mutationFn: () => api.patch<SettingsDocument>("/settings", patchBody()),
    invalidates: ["settings"],
    successMessage: () => `${label} saved.`,
    onDone: (result) => section.commit(read(result)),
    onFailed: setError,
  });

  return {
    error,
    saving: mutation.isPending,
    save: () => {
      setError(null);
      mutation.mutate();
    },
  };
}

interface NumberFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "size"
> {
  value: number;
  onValueChange: (next: number) => void;
  suffix?: string;
  width?: string;
}

/** Forwards the id and description wiring FieldRow injects into its child. */
function NumberField({ value, onValueChange, suffix, width = "w-24", ...rest }: NumberFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <Input
        mono
        type="number"
        min={0}
        inputMode="numeric"
        boxClassName={width}
        value={String(value)}
        onFocus={(event) => event.target.select()}
        onChange={(event) => onValueChange(Number(event.target.value))}
        {...rest}
      />
      {suffix && <span className="text-sm text-[var(--kn-text-3)]">{suffix}</span>}
    </div>
  );
}

/* ------------------------------- panel ------------------------------ */

function PanelSection({
  value,
  readOnly,
}: {
  value: SettingsDocument["panel"];
  readOnly: boolean;
}) {
  const section = useSection(value);
  const { error, saving, save } = useSectionSave(
    section,
    () => ({ panel: section.draft }),
    (document) => document.panel,
    "Panel",
  );
  const zones = React.useMemo(() => timeZoneOptions(), []);

  return (
    <SettingsSection
      title="Panel"
      description="How this installation identifies itself and renders time."
      icon={SettingsIcon}
      dirty={section.dirty}
      saving={saving}
      readOnly={readOnly}
      error={error}
      onSave={save}
      onReset={section.reset}
    >
      <FieldRow label="Name" description="Shown in the sidebar and in TOTP enrolment codes.">
        <Input
          boxClassName="w-64"
          disabled={readOnly}
          value={section.draft.name}
          onChange={(event) => section.patch({ name: event.target.value })}
        />
      </FieldRow>

      <FieldRow
        label="Public URL"
        description="Where agents dial in and where invitation links point. Changing it does not move anything."
      >
        <Input
          mono
          boxClassName="w-80"
          disabled={readOnly}
          value={section.draft.url}
          onChange={(event) => section.patch({ url: event.target.value })}
        />
      </FieldRow>

      <FieldRow label="Time zone" description="Used for absolute timestamps and cron previews.">
        <Select
          mono
          boxClassName="w-64"
          disabled={readOnly}
          value={section.draft.timezone}
          onChange={(event) => section.patch({ timezone: event.target.value })}
          options={zones.map((zone) => ({ value: zone, label: zone }))}
        />
      </FieldRow>

      <FieldRow label="Date format" divided={false}>
        <Select
          boxClassName="w-48"
          disabled={readOnly}
          value={section.draft.date_format}
          onChange={(event) =>
            section.patch({ date_format: event.target.value as typeof section.draft.date_format })
          }
          options={[
            { value: "iso", label: "ISO 8601" },
            { value: "us", label: "US (MM/DD)" },
            { value: "eu", label: "European (DD/MM)" },
            { value: "relative", label: "Relative" },
          ]}
        />
      </FieldRow>
    </SettingsSection>
  );
}

/* ------------------------------ address ----------------------------- */

/**
 * Not a settings write. Naming the panel regenerates the reverse proxy
 * configuration and restarts the control plane, so it has its own
 * endpoint and its own typed confirmation — and it only ever *adds* the
 * HTTPS site. The plain site on :80 stays, which is what makes this
 * safe to try: a name whose A record is not in place yet cannot take
 * away the address the operator is reading this page on.
 */
function AddressSection({ readOnly }: { readOnly: boolean }) {
  const address = useResource<PanelAddress>("address", "panel", { path: "/settings/address" });
  const [draft, setDraft] = React.useState<string | null>(null);
  const [applied, setApplied] = React.useState<PanelAddressApplying | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const current = address.data ?? null;
  const stored = (applied ? applied.domain : current?.domain) ?? "";
  const publicUrl = applied?.public_url ?? current?.public_url ?? "";
  const raw = draft ?? stored;
  const domain = normalizeDomain(raw);
  const problem = domainProblem(domain);

  const mutation = useResourceMutation<string, PanelAddressApplying>({
    mutationFn: (next) => api.post<PanelAddressApplying>("/settings/address", { domain: next }),
    /*
     * Nothing is invalidated on purpose: the control plane is going down
     * as this resolves, so a refetch would replace a successful apply
     * with a connection error and tell the operator the opposite of
     * what happened.
     */
    successMessage: () => "Applying. The control plane is restarting.",
    onDone: (result) => {
      setApplied(result);
      setDraft(null);
      setConfirming(false);
    },
    onFailed: (failure) => {
      setError(failure);
      setConfirming(false);
    },
  });

  const managed = current?.managed ?? false;

  return (
    <>
      <SettingsSection
        title="Address"
        description="Where this panel answers, and how to give it a name."
        icon={Globe}
        dirty={managed && domain !== stored && problem === null}
        saving={mutation.isPending}
        readOnly={readOnly || !managed}
        error={error}
        onSave={() => {
          setError(null);
          setConfirming(true);
        }}
        onReset={() => {
          setDraft(null);
          setError(null);
        }}
      >
        {address.isLoading && (
          <div className="py-3">
            <Skeleton className="h-16" label="Loading the panel address" />
          </div>
        )}

        {address.isError && (
          <div className="py-3">
            <PageError
              error={address.error}
              onRetry={() => void address.refetch()}
              context="Address"
            />
          </div>
        )}

        {applied && (
          <div
            role="status"
            className="mt-3 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-3 py-2 text-sm text-[var(--kn-text-2)]"
          >
            {applied.domain
              ? `Applying ${applied.public_url}. The control plane is restarting and the certificate is being requested — reload this page in a minute.`
              : "Removing the domain. The control plane is restarting — reload this page in a minute."}
          </div>
        )}

        {current && (
          <>
            <FieldRow
              label="Current address"
              description={
                current.tls
                  ? "Served over HTTPS on the domain, and still over plain HTTP on this server's IP address."
                  : "Served over plain HTTP on port 80. On an untrusted network the session cookie is readable in transit."
              }
            >
              <span className="font-mono text-sm text-[var(--kn-text-2)]">{publicUrl}</span>
            </FieldRow>

            {managed ? (
              <>
                <FieldRow
                  label="Domain"
                  description="Empty means the IP address only. Setting it adds an HTTPS site for the name; it does not take the IP one away."
                  error={problem ?? undefined}
                >
                  <Input
                    mono
                    boxClassName="w-80"
                    placeholder="panel.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={readOnly}
                    value={raw}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => setDraft(domain)}
                  />
                </FieldRow>

                <div className="flex flex-col gap-2 py-3 text-sm text-[var(--kn-text-2)]">
                  <p>
                    Two things have to be true before the name resolves here: an A record for it
                    points at this server, and ports 80 and 443 are reachable from the internet.
                    Port 80 is how the certificate authority proves the name is yours; 443 is how
                    the panel is served once it has.
                  </p>
                  <p>
                    Applying restarts the control plane, so the panel is unavailable for a few
                    seconds. The plain HTTP site on port 80 is kept either way &mdash; if the
                    certificate never issues, this address still answers.
                  </p>
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2 py-3 text-sm text-[var(--kn-text-2)]">
                <p>
                  This instance was not installed by{" "}
                  <code className="font-mono text-[var(--kn-text)]">install.sh</code>, so Kaname
                  does not own the proxy in front of it and will not rewrite a configuration it did
                  not write. The address is whatever your own proxy, ingress or compose file says it
                  is.
                </p>
                <p>
                  Terminate TLS there and point{" "}
                  <code className="font-mono text-[var(--kn-text)]">KANAME_PUBLIC_URL</code> at the
                  address you serve it on.
                </p>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={domain ? `Serve this panel at ${domain}` : "Remove the domain"}
        confirmText={domain || "remove domain"}
        confirmLabel={domain ? "Apply" : "Remove it"}
        destructive={domain.length === 0}
        loading={mutation.isPending}
        onConfirm={() => mutation.mutate(domain)}
      >
        <div className="flex flex-col gap-2 text-[var(--kn-text-2)]">
          {domain ? (
            <>
              <p>
                Kaname keeps the plain site on port 80 and adds{" "}
                <span className="font-mono text-[var(--kn-text)]">{domain}</span> beside it, then
                asks the certificate authority for a certificate. If the A record is not pointing
                here yet, that request keeps failing until it is &mdash; nothing else breaks, and
                nothing has to be re-applied once you fix the record.
              </p>
              <p>
                The control plane restarts to pick this up. The panel is unavailable for a few
                seconds and requests in flight are lost; sessions are not.
              </p>
            </>
          ) : (
            <>
              <p>
                The panel goes back to plain HTTP on this server&rsquo;s IP address. Anything
                pointed at <span className="font-mono text-[var(--kn-text)]">{stored}</span> &mdash;
                a bookmark, an agent, a webhook &mdash; stops resolving to this panel.
              </p>
              <p>The control plane restarts to pick this up.</p>
            </>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------ security ---------------------------- */

function SecuritySection({
  value,
  readOnly,
}: {
  value: SettingsDocument["security"];
  readOnly: boolean;
}) {
  const section = useSection(value);
  const { error, saving, save } = useSectionSave(
    section,
    () => ({ security: section.draft }),
    (document) => document.security,
    "Security",
  );
  const lockout = section.draft.failed_login_lockout;

  const patchLockout = (next: Partial<typeof lockout>) =>
    section.setDraft((prev) => ({
      ...prev,
      failed_login_lockout: { ...prev.failed_login_lockout, ...next },
    }));

  return (
    <SettingsSection
      title="Security"
      description="Session lifetime, two-factor policy, terminal recording and lockout."
      icon={ShieldCheck}
      dirty={section.dirty}
      saving={saving}
      readOnly={readOnly}
      error={error}
      onSave={save}
      onReset={section.reset}
    >
      <FieldRow
        label="Session lifetime"
        description="How long a sign-in stays valid without re-authenticating."
      >
        <NumberField
          value={section.draft.session_ttl_hours}
          disabled={readOnly}
          suffix="hours"
          onValueChange={(next) => section.patch({ session_ttl_hours: next })}
        />
      </FieldRow>

      <FieldRow
        label="Require two-factor"
        description="Every account must enrol TOTP before it can use the panel."
      >
        <Switch
          checked={section.draft.require_totp}
          disabled={readOnly}
          aria-label="Require two-factor authentication"
          onChange={(event) => section.patch({ require_totp: event.target.checked })}
        />
      </FieldRow>

      <FieldRow
        label="Record terminal sessions"
        description={
          section.draft.terminal_recording ? (
            "The compensating control for the one place shell strings are allowed. Turning it off is itself an audited change."
          ) : (
            <span className="flex items-start gap-1 text-[var(--kn-warn)]">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
              Root shells on every host will run unrecorded. The open and close stay audited; what
              happens in between does not.
            </span>
          )
        }
      >
        <Switch
          checked={section.draft.terminal_recording}
          disabled={readOnly}
          aria-label="Record terminal sessions"
          onChange={(event) => section.patch({ terminal_recording: event.target.checked })}
        />
      </FieldRow>

      <FieldRow
        label="Lock out failed sign-ins"
        description="Refuses further attempts for an address that keeps getting the password wrong."
      >
        <Switch
          checked={lockout.enabled}
          disabled={readOnly}
          aria-label="Lock out failed sign-ins"
          onChange={(event) => patchLockout({ enabled: event.target.checked })}
        />
      </FieldRow>

      <FieldRow label="Attempts before lockout" divided={lockout.enabled}>
        <NumberField
          value={lockout.threshold}
          disabled={readOnly || !lockout.enabled}
          suffix="attempts"
          onValueChange={(next) => patchLockout({ threshold: next })}
        />
      </FieldRow>

      {lockout.enabled && (
        <>
          <FieldRow label="Counting window">
            <NumberField
              value={lockout.window_minutes}
              disabled={readOnly}
              suffix="minutes"
              onValueChange={(next) => patchLockout({ window_minutes: next })}
            />
          </FieldRow>
          <FieldRow label="Lockout duration" divided={false}>
            <NumberField
              value={lockout.lockout_minutes}
              disabled={readOnly}
              suffix="minutes"
              onValueChange={(next) => patchLockout({ lockout_minutes: next })}
            />
          </FieldRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ------------------------------- agents ----------------------------- */

function AgentsSection({
  value,
  readOnly,
}: {
  value: SettingsDocument["agents"];
  readOnly: boolean;
}) {
  const section = useSection(value);
  const { error, saving, save } = useSectionSave(
    section,
    () => ({ agents: section.draft }),
    (document) => document.agents,
    "Agents",
  );

  return (
    <SettingsSection
      title="Agents"
      description="Heartbeat cadence, when a host counts as gone, and how long samples are kept."
      icon={RadioTower}
      dirty={section.dirty}
      saving={saving}
      readOnly={readOnly}
      error={error}
      onSave={save}
      onReset={section.reset}
    >
      <FieldRow label="Heartbeat interval" description="How often a connected agent reports in.">
        <NumberField
          value={section.draft.heartbeat_seconds}
          disabled={readOnly}
          suffix="seconds"
          onValueChange={(next) => section.patch({ heartbeat_seconds: next })}
        />
      </FieldRow>

      <FieldRow
        label="Offline after"
        description="Silence for this long moves a host from degraded to disconnected."
      >
        <NumberField
          value={section.draft.offline_after_seconds}
          disabled={readOnly}
          suffix="seconds"
          onValueChange={(next) => section.patch({ offline_after_seconds: next })}
        />
      </FieldRow>

      <FieldRow
        label="Metrics retention"
        description="Older samples are pruned. Charts beyond this window read the rollup."
        divided={false}
      >
        <NumberField
          value={section.draft.metrics_retention_days}
          disabled={readOnly}
          suffix="days"
          onValueChange={(next) => section.patch({ metrics_retention_days: next })}
        />
      </FieldRow>
    </SettingsSection>
  );
}

/* -------------------------------- ACME ------------------------------ */

function AcmeSection({ value, readOnly }: { value: SettingsDocument["acme"]; readOnly: boolean }) {
  const section = useSection(value);
  const { error, saving, save } = useSectionSave(
    section,
    () => ({ acme: section.draft }),
    (document) => document.acme,
    "ACME",
  );

  return (
    <SettingsSection
      title="ACME"
      description="Where certificates are issued from, and who the directory contacts."
      icon={ShieldCheck}
      dirty={section.dirty}
      saving={saving}
      readOnly={readOnly}
      error={error}
      onSave={save}
      onReset={section.reset}
    >
      <FieldRow
        label="Account email"
        description="Expiry warnings from the certificate authority go here."
      >
        <Input
          mono
          type="email"
          boxClassName="w-72"
          disabled={readOnly}
          value={section.draft.email}
          onChange={(event) => section.patch({ email: event.target.value })}
        />
      </FieldRow>

      <FieldRow label="Directory URL" description="The ACME endpoint issuance runs against.">
        <Input
          mono
          boxClassName="w-96"
          disabled={readOnly}
          value={section.draft.directory_url}
          onChange={(event) => section.patch({ directory_url: event.target.value })}
        />
      </FieldRow>

      <FieldRow
        label="Staging"
        description="Issues untrusted certificates against the staging directory. Use it to test a challenge without spending rate limit."
        divided={false}
      >
        <Switch
          checked={section.draft.staging}
          disabled={readOnly}
          aria-label="Use the ACME staging directory"
          onChange={(event) => section.patch({ staging: event.target.checked })}
        />
      </FieldRow>
    </SettingsSection>
  );
}

/* ------------------------------ backups ----------------------------- */

function BackupsSection({
  value,
  readOnly,
}: {
  value: SettingsDocument["backups"];
  readOnly: boolean;
}) {
  const section = useSection(value);
  const { error, saving, save } = useSectionSave(
    section,
    () => ({ backups: section.draft }),
    (document) => document.backups,
    "Backups",
  );
  const destinations = useList<BackupDestination>("backups/destinations", {
    per_page: 200,
    sort: "name",
    order: "asc",
  });

  return (
    <SettingsSection
      title="Backups"
      description="Defaults applied when a new schedule does not name a destination."
      icon={Archive}
      dirty={section.dirty}
      saving={saving}
      readOnly={readOnly}
      error={error}
      onSave={save}
      onReset={section.reset}
    >
      <FieldRow
        label="Default destination"
        description="Preselected in the schedule form. Existing schedules are untouched."
        divided={false}
      >
        <Combobox
          options={(destinations.data?.data ?? []).map((destination) => ({
            value: destination.id,
            label: destination.name,
            description: destination.kind,
          }))}
          value={section.draft.default_destination_id ?? ""}
          onValueChange={(next) => section.patch({ default_destination_id: next || null })}
          loading={destinations.isLoading}
          disabled={readOnly}
          clearable
          placeholder="No default"
          emptyMessage="No destination matches that name."
          className="w-64"
        />
      </FieldRow>
    </SettingsSection>
  );
}

/* --------------------------- notifications -------------------------- */

function NotificationsSection({
  value,
  readOnly,
}: {
  value: readonly NotificationChannel[];
  readOnly: boolean;
}) {
  const section = useSection<NotificationChannel[]>([...value]);
  const { error, saving, save } = useSectionSave(
    section,
    () => ({ notifications: { channels: section.draft } }),
    (document) => document.notifications.channels,
    "Notifications",
  );

  const update = (index: number, next: Partial<NotificationChannel>) =>
    section.setDraft((prev) =>
      prev.map((channel, position) => (position === index ? { ...channel, ...next } : channel)),
    );

  const add = () =>
    section.setDraft((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: "",
        kind: "email",
        target: "",
        events: ["job_failed", "server_offline", "backup_failed"],
        enabled: true,
      },
    ]);

  return (
    <SettingsSection
      title="Notifications"
      description="Where Kaname sends the things worth waking someone for. The list here is the whole set — removing a row deletes the channel."
      icon={Bell}
      dirty={section.dirty}
      saving={saving}
      readOnly={readOnly}
      error={error}
      onSave={save}
      onReset={section.reset}
    >
      <div className="flex flex-col gap-3 py-3">
        {section.draft.length === 0 && (
          <p className="text-[var(--kn-text-2)]">
            No channel is configured, so nothing is delivered anywhere. Alerts and failed jobs are
            still recorded in the panel.
          </p>
        )}

        {section.draft.map((channel, index) => (
          <div
            key={channel.id}
            className={cn(
              "grid grid-cols-1 gap-3 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] p-3",
              "sm:grid-cols-[minmax(0,1fr)_128px_minmax(0,1.4fr)_28px]",
            )}
          >
            <Input
              aria-label={`Channel ${index + 1} name`}
              placeholder="Ops on-call"
              disabled={readOnly}
              value={channel.name}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <Select
              aria-label={`Channel ${index + 1} kind`}
              disabled={readOnly}
              value={channel.kind}
              onChange={(event) =>
                update(index, { kind: event.target.value as NotificationChannel["kind"] })
              }
              options={notificationChannelKind.options.map((kind) => ({
                value: kind,
                label: kind,
              }))}
            />
            <Input
              mono
              aria-label={`Channel ${index + 1} target`}
              placeholder={
                channel.kind === "email" ? "ops@example.com" : "https://hooks.example.com/…"
              }
              disabled={readOnly}
              value={channel.target}
              onChange={(event) => update(index, { target: event.target.value })}
            />
            <IconButton
              icon={Trash2}
              label={`Remove channel ${index + 1}`}
              size="sm"
              disabled={readOnly}
              onClick={() =>
                section.setDraft((prev) => prev.filter((_, position) => position !== index))
              }
            />

            <div className="sm:col-span-4">
              <Combobox
                multiple
                options={notificationEvent.options.map((event) => ({
                  value: event,
                  label: EVENT_LABELS[event],
                }))}
                value={channel.events}
                onValueChange={(next) => update(index, { events: next as NotificationEvent[] })}
                disabled={readOnly}
                placeholder="Every event"
                emptyMessage="No event matches that name."
                aria-label={`Channel ${index + 1} events`}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-sm text-[var(--kn-text-3)]">
                  {pluralize(channel.events.length, "event")} selected
                </span>
                <Switch
                  checked={channel.enabled}
                  disabled={readOnly}
                  label="Enabled"
                  onChange={(event) => update(index, { enabled: event.target.checked })}
                />
              </div>
            </div>
          </div>
        ))}

        {!readOnly && (
          <div>
            <Button variant="secondary" size="sm" icon={Plus} onClick={add}>
              Add channel
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

/* ------------------------------ updates ----------------------------- */

/**
 * The cadence lives on its own endpoint rather than in the settings
 * document, because it is the one setting that decides whether this
 * software changes itself while nobody is watching, and it is audited
 * as its own act. Moving to "apply everything" asks first; the API
 * refuses it without an acknowledgement either way, so the dialog is
 * not the security control - it is the explanation.
 */
function UpdatesSection({ readOnly }: { readOnly: boolean }) {
  const overview = useResource<UpdateOverview>("updates", "overview", { path: "/updates" });
  const [draft, setDraft] = React.useState<UpdateOverview["settings"] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const stored = overview.data?.settings ?? null;
  const value = draft ?? stored;

  const mutation = useResourceMutation<{ acknowledge: boolean }, UpdateOverview>({
    mutationFn: (vars) =>
      api.patch<UpdateOverview>("/updates/policy", {
        tier: value?.tier,
        interval: value?.interval,
        channel: value?.channel,
        manifest_url: value?.manifest_url,
        ...(vars.acknowledge ? { acknowledge_unattended_majors: true } : {}),
      }),
    invalidates: ["updates"],
    successMessage: () => "Updates saved.",
    onDone: () => setDraft(null),
    onFailed: setError,
  });

  if (overview.isLoading || !value) {
    return <Skeleton className="h-56 rounded-[var(--kn-r-md)]" label="Loading update settings" />;
  }

  const dirty =
    draft !== null && stored !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const patch = (next: Partial<UpdateOverview["settings"]>) =>
    setDraft({ ...(draft ?? value), ...next });

  const save = () => {
    setError(null);
    if (value.tier === "auto_all" && stored?.tier !== "auto_all") {
      setConfirming(true);
      return;
    }
    mutation.mutate({ acknowledge: false });
  };

  return (
    <>
      <SettingsSection
        title="Updates"
        description="How this installation gets new versions of itself."
        icon={ArrowUpCircle}
        dirty={dirty}
        saving={mutation.isPending}
        readOnly={readOnly}
        error={error}
        onSave={save}
        onReset={() => {
          setDraft(null);
          setError(null);
        }}
      >
        <FieldRow label="Cadence" description={UPDATE_TIER_LABELS[value.tier].detail}>
          <Select
            boxClassName="w-72"
            disabled={readOnly}
            value={value.tier}
            onChange={(event) => patch({ tier: event.target.value as UpdateTier })}
            options={updateTierEnum.options.map((option) => ({
              value: option,
              label: UPDATE_TIER_LABELS[option].label,
            }))}
          />
        </FieldRow>

        <FieldRow
          label="Check every"
          description="How often Kaname reads the release manifest. Checking never applies anything on its own."
        >
          <Select
            boxClassName="w-40"
            disabled={readOnly || value.tier === "off"}
            value={value.interval}
            onChange={(event) => patch({ interval: event.target.value as UpdateCheckInterval })}
            options={updateCheckIntervalEnum.options.map((option) => ({
              value: option,
              label: option,
            }))}
          />
        </FieldRow>

        <FieldRow
          label="Channel"
          description="Beta releases exist to be tested. They are not what you want under production traffic."
        >
          <Select
            boxClassName="w-40"
            disabled={readOnly}
            value={value.channel}
            onChange={(event) => patch({ channel: event.target.value as ReleaseChannel })}
            options={releaseChannelEnum.options.map((option) => ({
              value: option,
              label: option,
            }))}
          />
        </FieldRow>

        <FieldRow
          label="Manifest"
          description="Where release metadata is published. Point it at your own mirror for an air-gapped fleet."
        >
          <Input
            mono
            boxClassName="w-96"
            disabled={readOnly}
            value={value.manifest_url}
            onChange={(event) => patch({ manifest_url: event.target.value })}
          />
        </FieldRow>

        <FieldRow label="Last checked" description={value.last_check_error ?? undefined}>
          <span className={cn("text-sm", value.last_check_error && "text-[var(--kn-danger)]")}>
            {value.last_checked_at ? new Date(value.last_checked_at).toLocaleString() : "never"}
          </span>
        </FieldRow>
      </SettingsSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Apply everything automatically"
        confirmText="apply everything"
        confirmLabel="Turn it on"
        destructive
        loading={mutation.isPending}
        onConfirm={() => {
          mutation.mutate({ acknowledge: true });
          setConfirming(false);
        }}
      >
        <div className="flex flex-col gap-2 text-[var(--kn-text-2)]">
          <p>
            At this cadence, major releases install themselves on a schedule with nobody watching.
            Kaname will still refuse to apply a release marked as breaking, or one whose migration
            rewrites data, without asking you first &mdash; but nothing else will wait.
          </p>
          <p>
            On infrastructure other people depend on, &ldquo;apply patch and minor
            automatically&rdquo; is usually the furthest worth going.
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
