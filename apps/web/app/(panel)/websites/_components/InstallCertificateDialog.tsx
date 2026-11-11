"use client";

import * as React from "react";
import type { Job } from "@kaname/contract";
import { Combobox, FormField, Textarea, type ComboboxOption } from "@kaname/ui";
import { useCan, useServers } from "@/lib/queries";
import { FormDialog, FormSection, fieldErrors } from "./FormDialog";
import { useDomains, useInstallCertificate } from "./queries";

/* ------------------------------------------------------------------ *
 * Install a certificate issued somewhere else.
 *
 * The agent always had `cert.install`; nothing in the panel reached it.
 * The checks that need the PEM itself — it parses, the key belongs to
 * the certificate, it has not expired, it covers the domain — run on
 * the control plane and come back as field messages on the two boxes
 * below, so a bad paste is corrected here rather than discovered when
 * nginx refuses the pair. The key is sent once and never shown again.
 * ------------------------------------------------------------------ */

interface FormState {
  domainId: string;
  serverId: string;
  certificatePem: string;
  keyPem: string;
}

const EMPTY: FormState = { domainId: "", serverId: "", certificatePem: "", keyPem: "" };

export interface InstallCertificateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultServerId?: string | null;
  onQueued?: (job: Job) => void;
}

export function InstallCertificateDialog({
  open,
  onOpenChange,
  defaultServerId,
  onQueued,
}: InstallCertificateDialogProps) {
  const can = useCan();
  const servers = useServers();
  const domains = useDomains({ per_page: 200, sort: "name", order: "asc" }, open);
  const install = useInstallCertificate();
  const resetMutation = install.reset;

  const [form, setForm] = React.useState<FormState>(EMPTY);
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    // The key must not outlive the dialog in component state.
    setForm({ ...EMPTY, serverId: defaultServerId ?? "" });
    setSubmitted(false);
    resetMutation();
  }, [open, defaultServerId, resetMutation]);

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const domainRows = domains.data?.data ?? [];
  const selected = domainRows.find((row) => row.id === form.domainId) ?? null;

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

  const remote = fieldErrors(install.error);
  const local: Record<string, string> = {};
  if (form.domainId === "") local["domain_id"] = "Pick the domain this certificate covers.";
  if (form.serverId === "") local["server_id"] = "Pick the host that will serve it.";
  if (form.certificatePem.trim() === "") {
    local["certificate_pem"] = "Paste the certificate chain, leaf first.";
  } else if (!form.certificatePem.includes("-----BEGIN CERTIFICATE-----")) {
    local["certificate_pem"] =
      "No certificate found. Paste the PEM that starts with -----BEGIN CERTIFICATE-----.";
  }
  if (form.keyPem.trim() === "") {
    local["key_pem"] = "Paste the private key that belongs to the certificate.";
  } else if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(form.keyPem)) {
    local["key_pem"] =
      "Not a PEM private key. Paste the key that starts with -----BEGIN PRIVATE KEY----- (or BEGIN EC / RSA PRIVATE KEY).";
  }

  const errorFor = (field: string): string | undefined =>
    submitted ? (local[field] ?? remote[field]) : remote[field];

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length > 0) return;
    install.mutate(
      {
        domain_id: form.domainId,
        server_id: form.serverId,
        certificate_pem: form.certificatePem,
        key_pem: form.keyPem,
      },
      {
        onSuccess: (jobs) => {
          setForm(EMPTY);
          onOpenChange(false);
          if (jobs[0]) onQueued?.(jobs[0]);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Install certificate"
      description="For a certificate issued by another authority. Kaname checks the pair here, then writes it to the host as a job."
      submitLabel="Install certificate"
      submitting={install.isPending}
      error={install.error}
      onSubmit={submit}
      size="lg"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Domain" error={errorFor("domain_id")} required>
          <Combobox
            options={domainOptions}
            value={form.domainId}
            onValueChange={(next) => {
              const row = domainRows.find((candidate) => candidate.id === next);
              setForm((previous) => ({
                ...previous,
                domainId: next ?? "",
                serverId: row?.server_id ?? previous.serverId,
              }));
            }}
            placeholder="Select a domain"
            emptyMessage="No domain matches that name."
            loading={domains.isLoading}
            mono
          />
        </FormField>

        <FormField
          label="Server"
          description="The host whose vhost serves the domain."
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
        label="Certificate chain"
        description={
          selected
            ? `PEM, the certificate for ${selected.name} first, then its intermediates.`
            : "PEM, the leaf certificate first, then its intermediates."
        }
        error={errorFor("certificate_pem")}
        required
      >
        <Textarea
          value={form.certificatePem}
          onChange={(event) => set("certificatePem", event.target.value)}
          placeholder="-----BEGIN CERTIFICATE-----"
          rows={6}
          mono
          spellCheck={false}
          autoComplete="off"
        />
      </FormField>

      <FormField
        label="Private key"
        description="PEM, unencrypted. Sealed for the job that installs it, then discarded; it is never shown again."
        error={errorFor("key_pem")}
        required
      >
        <Textarea
          value={form.keyPem}
          onChange={(event) => set("keyPem", event.target.value)}
          placeholder="-----BEGIN PRIVATE KEY-----"
          rows={5}
          mono
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
        />
      </FormField>
    </FormDialog>
  );
}
