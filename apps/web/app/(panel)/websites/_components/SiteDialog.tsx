"use client";

import * as React from "react";
import type { Site, SiteRuntime } from "@kaname/contract";
import { Combobox, FormField, Input, Select, Switch, Tag, type ComboboxOption } from "@kaname/ui";
import { useAudience } from "@/lib/modes";
import { useCan, useServers } from "@/lib/queries";
import { FormDialog, fieldErrors } from "../../_components/FormDialog";
import { RUNTIME_LABELS } from "./status";
import { useCreateSite, useUpdateSite } from "./queries";

/* ------------------------------------------------------------------ *
 * Create ("New project") and edit a project.
 *
 * One form for both, because the fields are the same set minus the
 * host — a site cannot move between servers, so `server_id` is create-
 * only and everything else is editable in place. The git source is set
 * here on create and in the project's Settings tab afterwards. Up front:
 * name, server, domain and git; everything else sits under "Advanced".
 *
 * Both paths queue a job (KD-008): the row lands immediately, the vhost
 * is written by the agent, and the dialog closes onto the job pill
 * rather than pretending the file already exists.
 * ------------------------------------------------------------------ */

const RUNTIMES: SiteRuntime[] = ["static", "php", "node", "python", "proxy", "container"];

/** Runtimes whose version is the runtime itself rather than a side pool. */
const VERSIONED: readonly SiteRuntime[] = ["php", "node", "python"];
const NEEDS_UPSTREAM: readonly SiteRuntime[] = ["proxy", "container"];
/*
 * A node site's vhost is a proxy_pass to its app server too, so its
 * origin has to be settable — the field used to appear only for proxy
 * and container, which left a node app pinned to whatever port the
 * host's default was. Optional here: the host falls back to :3000.
 */
const TAKES_UPSTREAM: readonly SiteRuntime[] = [...NEEDS_UPSTREAM, "node"];

const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface FormState {
  serverId: string;
  name: string;
  primaryDomain: string;
  aliases: string;
  runtime: SiteRuntime;
  runtimeVersion: string;
  phpVersion: string;
  webroot: string;
  upstream: string;
  owner: string;
  forceHttps: boolean;
  repoUrl: string;
  branch: string;
}

function initialState(site: Site | null, defaultServerId: string | null): FormState {
  return {
    serverId: site?.server_id ?? defaultServerId ?? "",
    name: site?.name ?? "",
    primaryDomain: site?.primary_domain ?? "",
    aliases: (site?.domains ?? [])
      .map((domain) => domain.name)
      .filter((name) => name !== site?.primary_domain)
      .join(", "),
    runtime: site?.runtime ?? "static",
    runtimeVersion: site?.runtime_version ?? "",
    phpVersion: site && site.runtime !== "php" ? (site.php_version ?? "") : "",
    webroot: site?.webroot ?? "",
    upstream: site?.upstream ?? "",
    owner: site?.owner ?? "",
    forceHttps: site?.force_https ?? true,
    repoUrl: "",
    branch: "",
  };
}

/** Comma, space or newline separated; the operator should not care which. */
function parseNames(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[\s,]+/)) {
    const name = raw.trim().toLowerCase().replace(/\.$/, "");
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface SiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null creates; a site edits it in place. */
  site?: Site | null;
  defaultServerId?: string | null;
}

export function SiteDialog({ open, onOpenChange, site = null, defaultServerId }: SiteDialogProps) {
  const editing = site !== null;
  const can = useCan();
  // Scoped accounts are refused a repository (KD-039), so they are not offered one.
  const operator = useAudience().audience === "operator";
  const servers = useServers();
  const create = useCreateSite();
  const update = useUpdateSite(site?.id ?? "");
  const mutation = editing ? update : create;

  const [form, setForm] = React.useState<FormState>(() =>
    initialState(site, defaultServerId ?? null),
  );
  const [webrootTouched, setWebrootTouched] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);

  const resetMutation = mutation.reset;

  /* A dialog reopened for a different site must not inherit the last
   * draft, nor the last failure. */
  React.useEffect(() => {
    if (!open) return;
    setForm(initialState(site, defaultServerId ?? null));
    setWebrootTouched(editing);
    setSubmitted(false);
    setAdvanced(false);
    resetMutation();
  }, [open, site, defaultServerId, editing, resetMutation]);

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const serverOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (servers.data?.data ?? [])
        .filter((server) => can("websites.sites:write", server.id))
        .map((server) => ({
          value: server.id,
          label: server.name,
          description: server.hostname,
          mono: true,
        })),
    [can, servers.data],
  );

  const aliases = parseNames(form.aliases).filter((name) => name !== form.primaryDomain.trim());
  const webroot = webrootTouched
    ? form.webroot
    : form.name.length > 0
      ? `/var/www/${form.name}`
      : "";

  const remote = fieldErrors(mutation.error);
  const local: Record<string, string> = {};
  if (!editing && form.serverId === "")
    local["server_id"] = "Pick the server this project runs on.";
  if (form.name.trim().length === 0) local["name"] = "Required.";
  else if (!NAME_RE.test(form.name.trim())) {
    local["name"] =
      "Letters, digits, dots, dashes and underscores only. It is also the config file name.";
  }
  if (!DOMAIN_RE.test(form.primaryDomain.trim())) {
    local["primary_domain"] = "Must be a domain name, for example example.com.";
  }
  for (const alias of aliases) {
    if (!DOMAIN_RE.test(alias)) {
      local["domains"] = `"${alias}" is not a domain name.`;
      break;
    }
  }
  // The folder follows the name until edited, so an empty name is the name's error, not this one.
  if ((webrootTouched || form.name.length > 0) && !webroot.startsWith("/"))
    local["webroot"] = "Must be an absolute path.";
  else if (webroot.split("/").includes("..")) local["webroot"] = "Path traversal is not allowed.";
  if (NEEDS_UPSTREAM.includes(form.runtime) && form.upstream.trim().length === 0) {
    local["upstream"] = `A ${form.runtime} project needs an address to forward to.`;
  }
  if (form.owner.trim().length > 0 && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(form.owner.trim())) {
    local["owner"] = "Must be a POSIX user name.";
  }

  const errorFor = (field: string): string | undefined =>
    submitted ? (local[field] ?? remote[field]) : remote[field];

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length > 0) return;

    const payload = {
      name: form.name.trim(),
      webroot,
      runtime: form.runtime,
      primary_domain: form.primaryDomain.trim().toLowerCase(),
      domains: aliases,
      force_https: form.forceHttps,
      ...(VERSIONED.includes(form.runtime) && form.runtimeVersion.trim()
        ? { runtime_version: form.runtimeVersion.trim() }
        : {}),
      ...(!VERSIONED.includes(form.runtime) && form.phpVersion.trim()
        ? { php_version: form.phpVersion.trim() }
        : {}),
      ...(NEEDS_UPSTREAM.includes(form.runtime) ||
      (TAKES_UPSTREAM.includes(form.runtime) && form.upstream.trim())
        ? { upstream: form.upstream.trim() }
        : {}),
      ...(form.owner.trim() ? { owner: form.owner.trim() } : {}),
    };

    const close = { onSuccess: () => onOpenChange(false) };
    if (editing) update.mutate(payload, close);
    else {
      create.mutate(
        {
          ...payload,
          server_id: form.serverId,
          ...(form.repoUrl.trim() ? { repo_url: form.repoUrl.trim() } : {}),
          ...(form.branch.trim() ? { branch: form.branch.trim() } : {}),
        },
        close,
      );
    }
  };

  const upstreamRequired = NEEDS_UPSTREAM.includes(form.runtime);
  // A rejected field must not stay folded away under Advanced.
  const advancedError = [
    "domains",
    "runtime",
    "runtime_version",
    "php_version",
    "upstream",
    "force_https",
    "webroot",
    "owner",
  ].some((field) => errorFor(field) !== undefined);

  const upstreamField = (
    <FormField
      label="Proxies to"
      description={
        upstreamRequired
          ? "The address requests are forwarded to."
          : "Where your app listens. Optional; defaults to http://127.0.0.1:3000."
      }
      error={errorFor("upstream")}
      required={upstreamRequired}
    >
      <Input
        value={form.upstream}
        onChange={(event) => set("upstream", event.target.value)}
        placeholder="http://127.0.0.1:3000"
        mono
        autoComplete="off"
        spellCheck={false}
      />
    </FormField>
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${site.name}` : "New project"}
      description={
        editing
          ? "Changes are applied on the server in the background."
          : "Kaname sets the project up on your server. Deploy it from its page once it is ready."
      }
      submitLabel={editing ? "Save changes" : "Create project"}
      submitting={mutation.isPending}
      error={mutation.error}
      onSubmit={submit}
      size="lg"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label="Project name"
          description="Unique per server. Letters, digits, dots and dashes."
          error={errorFor("name")}
          required
        >
          <Input
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="example-com"
            mono
            autoComplete="off"
            spellCheck={false}
            data-autofocus=""
          />
        </FormField>

        <FormField
          label="Domain"
          description="The address the project answers on."
          error={errorFor("primary_domain")}
          required
        >
          <Input
            value={form.primaryDomain}
            onChange={(event) => set("primaryDomain", event.target.value)}
            placeholder="example.com"
            mono
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      </div>

      {!editing && (
        <FormField label="Server" error={errorFor("server_id")} required>
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
      )}

      {!editing && operator && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FormField
            label="Git repository"
            description="Optional. You can connect one later in Settings."
            error={errorFor("repo_url")}
          >
            <Input
              value={form.repoUrl}
              onChange={(event) => set("repoUrl", event.target.value)}
              placeholder="https://github.com/you/site.git"
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Branch" error={errorFor("branch")}>
            <Input
              value={form.branch}
              onChange={(event) => set("branch", event.target.value)}
              placeholder="main"
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        </div>
      )}

      <details
        open={advanced || advancedError}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none text-sm font-medium text-[var(--kn-text-2)] hover:text-[var(--kn-text)]">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <FormField
            label="Additional domains"
            description="Comma or space separated. Each also answers on this project."
            error={errorFor("domains")}
            hint={aliases.length > 0 ? `${aliases.length} extra` : undefined}
          >
            <Input
              value={form.aliases}
              onChange={(event) => set("aliases", event.target.value)}
              placeholder="www.example.com, cdn.example.com"
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          {aliases.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {aliases.map((alias) => (
                <Tag key={alias} size="xs" mono>
                  {alias}
                </Tag>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Runtime" required>
              <Select
                value={form.runtime}
                onChange={(event) => set("runtime", event.target.value as SiteRuntime)}
                options={RUNTIMES.map((runtime) => ({
                  value: runtime,
                  label: RUNTIME_LABELS[runtime],
                }))}
              />
            </FormField>

            {VERSIONED.includes(form.runtime) && (
              <FormField
                label={`${RUNTIME_LABELS[form.runtime]} version`}
                description="Must already be installed on the host."
                error={errorFor("runtime_version")}
              >
                <Input
                  value={form.runtimeVersion}
                  onChange={(event) => set("runtimeVersion", event.target.value)}
                  placeholder={form.runtime === "php" ? "8.3" : "22"}
                  mono
                  autoComplete="off"
                />
              </FormField>
            )}
          </div>

          {TAKES_UPSTREAM.includes(form.runtime) && upstreamField}

          <Switch
            checked={form.forceHttps}
            onChange={(event) => set("forceHttps", event.target.checked)}
            label="Redirect HTTP to HTTPS"
            description="Leave on unless the project has to answer on plain HTTP."
          />

          <FormField
            label="Folder"
            description="Where the files live on the server. Created if it does not exist."
            error={errorFor("webroot")}
            required
          >
            <Input
              value={webroot}
              onChange={(event) => {
                setWebrootTouched(true);
                set("webroot", event.target.value);
              }}
              placeholder="/var/www/example-com"
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {!VERSIONED.includes(form.runtime) && (
              <FormField
                label="PHP version"
                description="Optional. Lets a static or proxy project still run PHP files."
                error={errorFor("php_version")}
              >
                <Input
                  value={form.phpVersion}
                  onChange={(event) => set("phpVersion", event.target.value)}
                  placeholder="none"
                  mono
                  autoComplete="off"
                />
              </FormField>
            )}

            <FormField
              label="Runs as"
              description="The system user that owns the folder. Optional."
              error={errorFor("owner")}
            >
              <Input
                value={form.owner}
                onChange={(event) => set("owner", event.target.value)}
                placeholder="www-data"
                mono
                autoComplete="off"
              />
            </FormField>
          </div>
        </div>
      </details>
    </FormDialog>
  );
}
