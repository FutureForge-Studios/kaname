"use client";

import * as React from "react";
import type { CertKeyType, Domain, IssueCertificateInput } from "@kaname/contract";
import { Combobox, FormField, Input, Select, Switch, Tag, type ComboboxOption } from "@kaname/ui";
import { useCan, useServers, useSession } from "@/lib/queries";
import { FormDialog, fieldErrors } from "./FormDialog";
import { useDomains, useIssueCertificate } from "./queries";

/* ------------------------------------------------------------------ *
 * Issue a certificate.
 *
 * ACME runs on the host, so this queues a job and the dialog closes
 * onto its pill (KD-008). The two decisions that actually cost
 * something are made here rather than discovered in a failed run: a
 * dns-01 challenge needs an API-driven zone, and a first attempt
 * against the staging directory does not spend the weekly rate limit.
 * ------------------------------------------------------------------ */

const KEY_TYPES = [
  { value: "ecdsa", label: "ECDSA P-256" },
  { value: "rsa", label: "RSA 2048" },
];

const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

type Challenge = IssueCertificateInput["challenge"];

interface FormState {
  domainId: string;
  serverId: string;
  sans: string;
  challenge: Challenge;
  keyType: CertKeyType;
  contactEmail: string;
  autoRenew: boolean;
  staging: boolean;
}

export interface CertificateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pins the dialog to one domain — from a site or a domain page. */
  domain?: Domain | null;
  /** Preselects the domain without pinning it, for a site's primary name. */
  defaultDomainId?: string | null;
  defaultServerId?: string | null;
}

export function CertificateDialog({
  open,
  onOpenChange,
  domain = null,
  defaultDomainId,
  defaultServerId,
}: CertificateDialogProps) {
  const can = useCan();
  const { session } = useSession();
  const servers = useServers();
  const domains = useDomains({ per_page: 200, sort: "name", order: "asc" }, open && !domain);
  const issue = useIssueCertificate();
  const resetMutation = issue.reset;

  const [form, setForm] = React.useState<FormState>({
    domainId: "",
    serverId: "",
    sans: "",
    challenge: "http-01",
    keyType: "ecdsa",
    contactEmail: "",
    autoRenew: true,
    staging: false,
  });
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm({
      domainId: domain?.id ?? defaultDomainId ?? "",
      serverId: domain?.server_id ?? defaultServerId ?? "",
      sans: domain ? `www.${domain.name}` : "",
      challenge: "http-01",
      keyType: "ecdsa",
      contactEmail: session?.user?.email ?? "",
      autoRenew: true,
      staging: false,
    });
    setSubmitted(false);
    resetMutation();
  }, [open, domain, defaultDomainId, defaultServerId, session, resetMutation]);

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const domainRows = domains.data?.data ?? [];
  const selected = domain ?? domainRows.find((row) => row.id === form.domainId) ?? null;
  const manualZone = selected?.dns_provider === "manual";

  const domainOptions = React.useMemo<ComboboxOption[]>(
    () =>
      domainRows.map((row) => ({
        value: row.id,
        label: row.name,
        description: row.site_name ?? "Not attached to a site",
        mono: true,
      })),
    [domainRows],
  );

  const serverOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (servers.data?.data ?? [])
        .filter((server) => can("websites.ssl:write", server.id))
        .map((server) => ({
          value: server.id,
          label: server.name,
          description: server.hostname,
          mono: true,
        })),
    [can, servers.data],
  );

  const sans = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of form.sans.split(/[\s,]+/)) {
      const name = raw.trim().toLowerCase().replace(/\.$/, "");
      if (name.length === 0 || name === selected?.name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }, [form.sans, selected]);

  const remote = fieldErrors(issue.error);
  const local: Record<string, string> = {};
  if (form.domainId === "") local["domain_id"] = "Pick the domain this certificate covers.";
  if (form.serverId === "") local["server_id"] = "Pick the host that will run the challenge.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail.trim())) {
    local["contact_email"] = "Let's Encrypt sends expiry warnings here.";
  }
  for (const san of sans) {
    if (!DOMAIN_RE.test(san)) {
      local["sans"] = `"${san}" is not a domain name.`;
      break;
    }
  }
  if (form.challenge === "dns-01" && manualZone) {
    local["challenge"] =
      "A manual zone cannot publish the challenge record within the ACME timeout. Use http-01, or move the zone to an API-driven provider.";
  }

  const errorFor = (field: string): string | undefined =>
    submitted ? (local[field] ?? remote[field]) : remote[field];

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length > 0) return;

    issue.mutate(
      {
        domain_id: form.domainId,
        server_id: form.serverId,
        sans,
        challenge: form.challenge,
        key_type: form.keyType,
        contact_email: form.contactEmail.trim(),
        auto_renew: form.autoRenew,
        staging: form.staging,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={selected ? `Issue a certificate for ${selected.name}` : "Issue a certificate"}
      description="Kaname runs the ACME order on the host and installs the result as a job."
      submitLabel="Request certificate"
      submitting={issue.isPending}
      error={issue.error}
      onSubmit={submit}
      size="lg"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Domain" error={errorFor("domain_id")} required>
          {domain ? (
            <Input value={domain.name} readOnly mono />
          ) : (
            <Combobox
              options={domainOptions}
              value={form.domainId}
              onValueChange={(next) => {
                const row = domainRows.find((candidate) => candidate.id === next);
                setForm((previous) => ({
                  ...previous,
                  domainId: next ?? "",
                  serverId: row?.server_id ?? previous.serverId,
                  sans: row ? `www.${row.name}` : previous.sans,
                }));
              }}
              placeholder="Select a domain"
              emptyMessage="No domain matches that name."
              loading={domains.isLoading}
              mono
            />
          )}
        </FormField>

        <FormField
          label="Server"
          description="Where certbot runs and where the certificate is installed."
          error={errorFor("server_id")}
          required
        >
          <Combobox
            options={serverOptions}
            value={form.serverId}
            onValueChange={(next) => set("serverId", next ?? "")}
            placeholder={
              serverOptions.length === 0 ? "No host you can write to" : "Select a server"
            }
            emptyMessage="No server matches that name."
            loading={servers.isLoading}
            disabled={serverOptions.length === 0}
            mono
          />
        </FormField>
      </div>

      <FormField
        label="Additional names"
        description="Comma or space separated. The domain itself is always the subject."
        error={errorFor("sans")}
        hint={sans.length > 0 ? `${sans.length} SAN${sans.length === 1 ? "" : "s"}` : undefined}
      >
        <Input
          value={form.sans}
          onChange={(event) => set("sans", event.target.value)}
          placeholder="www.example.com"
          mono
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      {sans.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sans.map((san) => (
            <Tag key={san} size="xs" mono>
              {san}
            </Tag>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label="Challenge"
          description={
            form.challenge === "http-01"
              ? "The name must resolve to this host over plain HTTP."
              : "Kaname publishes and removes the validation record itself."
          }
          error={errorFor("challenge")}
        >
          <Select
            value={form.challenge}
            onChange={(event) => set("challenge", event.target.value as Challenge)}
            options={[
              { value: "http-01", label: "http-01 (webroot)" },
              { value: "dns-01", label: "dns-01 (DNS record)", disabled: manualZone },
            ]}
          />
        </FormField>

        <FormField label="Key type" description="ECDSA unless a client needs RSA.">
          <Select
            value={form.keyType}
            onChange={(event) => set("keyType", event.target.value as CertKeyType)}
            options={KEY_TYPES}
          />
        </FormField>
      </div>

      <FormField
        label="Contact email"
        description="Where the authority sends expiry and revocation notices."
        error={errorFor("contact_email")}
        required
      >
        <Input
          type="email"
          value={form.contactEmail}
          onChange={(event) => set("contactEmail", event.target.value)}
          placeholder="ops@example.com"
          autoComplete="off"
        />
      </FormField>

      <Switch
        checked={form.autoRenew}
        onChange={(event) => set("autoRenew", event.target.checked)}
        label="Renew automatically"
        description="Kaname renews inside the 30-day window without being asked."
      />

      <Switch
        checked={form.staging}
        onChange={(event) => set("staging", event.target.checked)}
        label="Rehearse against the staging directory"
        description="Proves the challenge works without spending the five-per-week issuance limit. The result is not trusted by browsers."
      />
    </FormDialog>
  );
}
