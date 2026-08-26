"use client";

import * as React from "react";
import type { DnsProvider, Domain } from "@kaname/contract";
import { Combobox, FormField, Input, Select, Switch, type ComboboxOption } from "@kaname/ui";
import { useCan, useServers } from "@/lib/queries";
import { FormDialog, fieldErrors } from "./FormDialog";
import { DNS_PROVIDER_LABELS } from "./status";
import { useCreateDomain, useSites, useUpdateDomain } from "./queries";

/* ------------------------------------------------------------------ *
 * Add and edit a domain.
 *
 * A domain row is control-plane state — nothing here touches a host —
 * so this form resolves inline rather than queuing a job. The one field
 * that is create-only is the name: records, certificates and mail
 * routing are all keyed to it, so the API refuses a rename and the form
 * does not offer one.
 * ------------------------------------------------------------------ */

const PROVIDERS: DnsProvider[] = ["cloudflare", "route53", "digitalocean", "manual"];
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

interface FormState {
  name: string;
  siteId: string;
  serverId: string;
  provider: DnsProvider;
  zoneId: string;
  proxied: boolean;
  registrar: string;
}

function initialState(domain: Domain | null): FormState {
  return {
    name: domain?.name ?? "",
    siteId: domain?.site_id ?? "",
    serverId: domain?.server_id ?? "",
    provider: domain?.dns_provider ?? "manual",
    zoneId: domain?.dns_zone_id ?? "",
    proxied: domain?.proxied ?? false,
    registrar: domain?.registrar ?? "",
  };
}

export interface DomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null adds; a domain edits it. */
  domain?: Domain | null;
  defaultSiteId?: string | null;
  defaultServerId?: string | null;
}

export function DomainDialog({
  open,
  onOpenChange,
  domain = null,
  defaultSiteId,
  defaultServerId,
}: DomainDialogProps) {
  const editing = domain !== null;
  const can = useCan();
  const servers = useServers();
  const sites = useSites({ per_page: 200, sort: "name", order: "asc" }, open);
  const create = useCreateDomain();
  const update = useUpdateDomain(domain?.id ?? "");
  const mutation = editing ? update : create;
  const resetMutation = mutation.reset;

  const [form, setForm] = React.useState<FormState>(() => initialState(domain));
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const base = initialState(domain);
    setForm({
      ...base,
      siteId: base.siteId || (defaultSiteId ?? ""),
      serverId: base.serverId || (defaultServerId ?? ""),
    });
    setSubmitted(false);
    resetMutation();
  }, [open, domain, defaultSiteId, defaultServerId, resetMutation]);

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const siteOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (sites.data?.data ?? []).map((site) => ({
        value: site.id,
        label: site.name,
        description: site.server_name,
        mono: true,
      })),
    [sites.data],
  );

  const serverOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (servers.data?.data ?? [])
        .filter((server) => can("websites.domains:write", server.id))
        .map((server) => ({
          value: server.id,
          label: server.name,
          description: server.hostname,
          mono: true,
        })),
    [can, servers.data],
  );

  /* Attaching to a site pins the host too — a vhost only answers where
   * it is written. */
  const siteServerId = sites.data?.data.find((site) => site.id === form.siteId)?.server_id ?? null;
  const effectiveServerId = form.siteId ? (siteServerId ?? form.serverId) : form.serverId;

  const remote = fieldErrors(mutation.error);
  const local: Record<string, string> = {};
  if (!editing && !DOMAIN_RE.test(form.name.trim())) {
    local["name"] = "Must be a domain name, for example example.com.";
  }
  if (form.provider !== "manual" && form.proxied && form.provider !== "cloudflare") {
    local["proxied"] = `${DNS_PROVIDER_LABELS[form.provider]} does not proxy records.`;
  }

  const errorFor = (field: string): string | undefined =>
    submitted ? (local[field] ?? remote[field]) : remote[field];

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length > 0) return;

    const payload = {
      site_id: form.siteId || null,
      server_id: effectiveServerId || null,
      dns_provider: form.provider,
      proxied: form.proxied,
      ...(form.zoneId.trim() ? { dns_zone_id: form.zoneId.trim() } : {}),
      ...(form.registrar.trim() ? { registrar: form.registrar.trim() } : {}),
    };

    const close = { onSuccess: () => onOpenChange(false) };
    if (editing) update.mutate(payload, close);
    else create.mutate({ ...payload, name: form.name.trim().toLowerCase() }, close);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${domain.name}` : "Add domain"}
      description={
        editing
          ? "A domain cannot be renamed — its records, certificates and mail routing are keyed to the name."
          : "Registers the name in Kaname. Nothing is published until you add records or issue a certificate."
      }
      submitLabel={editing ? "Save changes" : "Add domain"}
      submitting={mutation.isPending}
      error={mutation.error}
      onSubmit={submit}
    >
      {!editing && (
        <FormField
          label="Domain name"
          description="One row per name, so records and certificates never split across two entries."
          error={errorFor("name")}
          required
        >
          <Input
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="example.com"
            mono
            autoComplete="off"
            spellCheck={false}
            data-autofocus=""
          />
        </FormField>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label="Site"
          description="The site this name answers on. Optional."
          error={errorFor("site_id")}
        >
          <Combobox
            options={siteOptions}
            value={form.siteId}
            onValueChange={(next) => set("siteId", next ?? "")}
            placeholder="Not attached"
            emptyMessage="No site matches that name."
            loading={sites.isLoading}
            clearable
            mono
          />
        </FormField>

        <FormField
          label="Server"
          description={
            form.siteId
              ? "Taken from the site this domain answers on."
              : "Where verification resolves from. Optional."
          }
          error={errorFor("server_id")}
        >
          <Combobox
            options={serverOptions}
            value={effectiveServerId}
            onValueChange={(next) => set("serverId", next ?? "")}
            placeholder="Not attached"
            emptyMessage="No server matches that name."
            loading={servers.isLoading}
            disabled={Boolean(form.siteId && siteServerId)}
            clearable
            mono
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label="DNS provider"
          description="An API-driven provider gets drift detection and dns-01 challenges."
        >
          <Select
            value={form.provider}
            onChange={(event) => set("provider", event.target.value as DnsProvider)}
            options={PROVIDERS.map((provider) => ({
              value: provider,
              label: DNS_PROVIDER_LABELS[provider],
            }))}
          />
        </FormField>

        <FormField
          label="Registrar"
          description="Who the name is registered with. Optional."
          error={errorFor("registrar")}
        >
          <Input
            value={form.registrar}
            onChange={(event) => set("registrar", event.target.value)}
            placeholder="Gandi"
            autoComplete="off"
          />
        </FormField>
      </div>

      {form.provider !== "manual" && (
        <FormField
          label="Zone identifier"
          description="Left blank, Kaname looks the zone up by name on the first sync."
          error={errorFor("dns_zone_id")}
        >
          <Input
            value={form.zoneId}
            onChange={(event) => set("zoneId", event.target.value)}
            placeholder="Discovered on sync"
            mono
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      )}

      <Switch
        checked={form.proxied}
        onChange={(event) => set("proxied", event.target.checked)}
        label="Proxy web traffic through the provider"
        description="Never proxy a name that carries mail: SMTP does not traverse an HTTP proxy."
        disabled={form.provider === "manual"}
      />
      {errorFor("proxied") && (
        <p role="alert" className="text-xs text-[var(--kn-danger)]">
          {errorFor("proxied")}
        </p>
      )}
    </FormDialog>
  );
}
