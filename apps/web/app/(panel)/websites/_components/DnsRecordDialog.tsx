"use client";

import * as React from "react";
import type { DnsRecord, DnsRecordType, Domain } from "@kaname/contract";
import { CopyableCode, FormField, Input, Select, Switch, Textarea } from "@kaname/ui";
import { FormDialog, fieldErrors } from "./FormDialog";
import {
  DNS_RECORD_TYPES,
  DNS_TYPE_SPECS,
  isProxyable,
  validateRecordName,
  validateTtl,
  zoneLine,
} from "./dnsTypes";
import { useCreateDnsRecord, useUpdateDnsRecord } from "./queries";

/* ------------------------------------------------------------------ *
 * Add and edit a DNS record.
 *
 * The form is per-type: choosing MX renames the value field, makes
 * priority required and takes the proxy switch away, because a proxied
 * MX record is a delivery failure the provider will accept silently.
 * The zone line is shown as it will be written, so what the operator
 * approves is the thing that gets published.
 * ------------------------------------------------------------------ */

const TTL_PRESETS = [
  { value: "1", label: "Automatic" },
  { value: "300", label: "5 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "1 day" },
];

interface FormState {
  type: DnsRecordType;
  name: string;
  content: string;
  ttl: string;
  priority: string;
  proxied: boolean;
}

function initialState(record: DnsRecord | null): FormState {
  return {
    type: record?.type ?? "A",
    name: record?.name ?? "@",
    content: record?.content ?? "",
    ttl: String(record?.ttl ?? 3600),
    priority: record?.priority != null ? String(record.priority) : "",
    proxied: record?.proxied ?? false,
  };
}

export interface DnsRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domain: Domain;
  /** Null adds; a record edits it. */
  record?: DnsRecord | null;
}

export function DnsRecordDialog({
  open,
  onOpenChange,
  domain,
  record = null,
}: DnsRecordDialogProps) {
  const editing = record !== null;
  const create = useCreateDnsRecord();
  const update = useUpdateDnsRecord();
  const mutation = editing ? update : create;
  const resetMutation = mutation.reset;

  const [form, setForm] = React.useState<FormState>(() => initialState(record));
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm(initialState(record));
    setSubmitted(false);
    resetMutation();
  }, [open, record, resetMutation]);

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const spec = DNS_TYPE_SPECS[form.type];
  const proxyable = isProxyable(form.type) && domain.dns_provider === "cloudflare";
  const ttl = Number.parseInt(form.ttl, 10);
  const priority = form.priority.trim() === "" ? null : Number.parseInt(form.priority, 10);

  const remote = fieldErrors(mutation.error);
  const local: Record<string, string> = {};

  const nameError = validateRecordName(form.name);
  if (nameError) local["name"] = nameError;

  if (form.content.trim().length === 0) local["content"] = "Required.";
  else {
    const contentError = spec.validate(form.content.trim());
    if (contentError) local["content"] = contentError;
  }

  const ttlError = validateTtl(ttl);
  if (ttlError) local["ttl"] = ttlError;

  if (spec.priority === "required") {
    if (priority === null || !Number.isFinite(priority)) {
      local["priority"] = `An ${form.type} record needs a priority. Lower numbers are tried first.`;
    } else if (priority < 0 || priority > 65535) {
      local["priority"] = "Priority must be 0–65535.";
    }
  }

  const errorFor = (field: string): string | undefined =>
    submitted ? (local[field] ?? remote[field]) : remote[field];

  const fullName =
    form.name.trim() === "@" || form.name.trim() === ""
      ? domain.name
      : form.name.trim().endsWith(`.${domain.name}`) || form.name.trim().endsWith(".")
        ? form.name.trim().replace(/\.$/, "")
        : `${form.name.trim()}.${domain.name}`;

  const preview = zoneLine({
    name: fullName,
    ttl: Number.isFinite(ttl) ? ttl : 3600,
    type: form.type,
    content: form.content.trim(),
    priority: spec.priority === "required" ? priority : null,
  });

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length > 0) return;

    const payload = {
      type: form.type,
      name: form.name.trim(),
      content: form.content.trim(),
      ttl,
      proxied: proxyable && form.proxied,
      ...(spec.priority === "required" && priority !== null ? { priority } : {}),
    };

    const close = { onSuccess: () => onOpenChange(false) };
    if (editing) update.mutate({ id: record.id, input: payload }, close);
    else create.mutate({ ...payload, domain_id: domain.id }, close);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${record.type} ${record.name}` : `Add record to ${domain.name}`}
      description={
        domain.dns_provider === "manual"
          ? "This zone has no API, so Kaname records your intent and shows you the line to publish."
          : `Written straight to the zone at ${domain.dns_provider === "cloudflare" ? "Cloudflare" : "the provider"}.`
      }
      submitLabel={editing ? "Save record" : "Add record"}
      submitting={mutation.isPending}
      error={mutation.error}
      onSubmit={submit}
      size="lg"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[104px_minmax(0,1fr)]">
        <FormField label="Type" required>
          <Select
            value={form.type}
            onChange={(event) => set("type", event.target.value as DnsRecordType)}
            options={DNS_RECORD_TYPES.map((type) => ({ value: type, label: type }))}
            mono
          />
        </FormField>

        <FormField
          label="Name"
          description={`@ is ${domain.name}. A bare label is appended to it.`}
          error={errorFor("name")}
          required
        >
          <Input
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="@"
            mono
            autoComplete="off"
            spellCheck={false}
            data-autofocus=""
          />
        </FormField>
      </div>

      <FormField
        label={spec.contentLabel}
        description={spec.contentHint}
        error={errorFor("content")}
        required
      >
        {form.type === "TXT" ? (
          <Textarea
            value={form.content}
            onChange={(event) => set("content", event.target.value)}
            placeholder={spec.contentPlaceholder}
            rows={3}
            mono
            spellCheck={false}
          />
        ) : (
          <Input
            value={form.content}
            onChange={(event) => set("content", event.target.value)}
            placeholder={spec.contentPlaceholder}
            mono
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </FormField>

      <div
        className={
          spec.priority === "required"
            ? "grid grid-cols-1 gap-3 sm:grid-cols-3"
            : "grid grid-cols-1 gap-3 sm:grid-cols-2"
        }
      >
        <FormField label="Cache for" description="How long resolvers may keep the answer.">
          <Select
            value={TTL_PRESETS.some((preset) => preset.value === form.ttl) ? form.ttl : "custom"}
            onChange={(event) => {
              if (event.target.value !== "custom") set("ttl", event.target.value);
            }}
            options={[...TTL_PRESETS, { value: "custom", label: "Custom" }]}
          />
        </FormField>

        <FormField
          label="TTL in seconds"
          description="1 or below lets the provider choose."
          error={errorFor("ttl")}
        >
          <Input
            type="number"
            min={0}
            max={604800}
            value={form.ttl}
            onChange={(event) => set("ttl", event.target.value)}
            mono
          />
        </FormField>

        {spec.priority === "required" && (
          <FormField
            label="Priority"
            description="Lower is tried first."
            error={errorFor("priority")}
            required
          >
            <Input
              type="number"
              min={0}
              max={65535}
              value={form.priority}
              onChange={(event) => set("priority", event.target.value)}
              placeholder="10"
              mono
            />
          </FormField>
        )}
      </div>

      {isProxyable(form.type) && (
        <Switch
          checked={proxyable && form.proxied}
          onChange={(event) => set("proxied", event.target.checked)}
          disabled={!proxyable}
          label="Serve through the provider's edge"
          description={
            proxyable
              ? "Hides the origin address. Never enable it on a name that carries mail."
              : `${domain.dns_provider === "manual" ? "A manual zone" : "This provider"} cannot proxy records.`
          }
        />
      )}

      <CopyableCode value={preview} label="Zone line" block />
    </FormDialog>
  );
}
