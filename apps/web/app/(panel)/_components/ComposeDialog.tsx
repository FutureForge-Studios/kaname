"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  COMPOSE_APP_ID,
  COMPOSE_MAX_BYTES,
  translateCompose,
  type ComposeIssue,
  type ComposeTranslation,
  type InstallAppInput,
} from "@kaname/contract";
import {
  Button,
  Combobox,
  FormField,
  Input,
  Select,
  Switch,
  Tag,
  Textarea,
  type ComboboxOption,
} from "@kaname/ui";
import { useInstallApp, usePlanInstall } from "@/components/installer/queries";
import { useCan, useServers, useSession } from "@/lib/queries";
import { FormDialog, fieldErrors } from "./FormDialog";

/* ------------------------------------------------------------------ *
 * Install a project from a docker-compose file.
 *
 * The file is pasted or loaded from a public GitHub repository, and
 * translated in the browser with the same function the control plane
 * runs, so what will run and what is refused show while typing. Submit
 * runs the dry run and the install back to back, then hands off to the
 * install progress page the catalog apps use.
 * ------------------------------------------------------------------ */

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Every segment plain, none "." or ".." — the URL can never leave the repository. */
function safePath(value: string): boolean {
  return value.split("/").every((seg) => SEGMENT_RE.test(seg) && seg !== "." && seg !== "..");
}

/** The raw file URL for a public GitHub repo, or null when any part is unsafe. */
export function rawGitHubUrl(repo: string, branch: string, path: string): string | null {
  const match = REPO_RE.exec(repo.trim());
  if (!match || !safePath(match[2]!) || !safePath(branch) || !safePath(path)) return null;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${branch}/${path}`;
}

const EMPTY: ComposeTranslation = { services: [], web: null, refused: [], notices: [] };

function translate(text: string, service: string, port: string): ComposeTranslation {
  if (text.trim() === "") return EMPTY;
  try {
    return translateCompose(text, {
      ...(service ? { web_service: service } : {}),
      ...(port ? { web_port: Number(port) } : {}),
    });
  } catch (err) {
    // The parser should report problems as `refused`; never let it take the dialog down.
    return { ...EMPTY, refused: [{ line: null, service: null, message: String(err) }] };
  }
}

interface FormState {
  yaml: string;
  repo: string;
  branch: string;
  path: string;
  serverId: string;
  domain: string;
  adminEmail: string;
  ssl: boolean;
  webService: string;
  webPort: string;
}

function initialState(email: string): FormState {
  return {
    yaml: "",
    repo: "",
    branch: "main",
    path: "docker-compose.yml",
    serverId: "",
    domain: "",
    adminEmail: email,
    ssl: true,
    webService: "",
    webPort: "",
  };
}

export interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComposeDialog({ open, onOpenChange }: ComposeDialogProps) {
  const router = useRouter();
  const can = useCan();
  const { session } = useSession();
  const email = session?.user?.email ?? "";
  const servers = useServers();
  const plan = usePlanInstall();
  const install = useInstallApp();

  const [form, setForm] = React.useState<FormState>(() => initialState(email));
  const [submitted, setSubmitted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // A newer Load cancels an older one; a second submit waits for the first.
  const loadAbort = React.useRef<AbortController | null>(null);
  const busy = React.useRef(false);

  const resetPlan = plan.reset;
  const resetInstall = install.reset;
  React.useEffect(() => {
    if (!open) return;
    setForm(initialState(email));
    setSubmitted(false);
    setLoadError(null);
    busy.current = false;
    resetPlan();
    resetInstall();
  }, [open, email, resetPlan, resetInstall]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  // Both are checked server-side too; offering a host that would refuse is just noise.
  const serverOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (servers.data?.data ?? [])
        .filter(
          (server) =>
            can("apps.installs:write", server.id) && can("infra.containers:exec", server.id),
        )
        .map((server) => ({
          value: server.id,
          label: server.name,
          description: server.hostname,
          mono: true,
        })),
    [can, servers.data],
  );

  const yaml = React.useDeferredValue(form.yaml);
  const translation = React.useMemo(
    () => translate(yaml, form.webService, form.webPort),
    [yaml, form.webService, form.webPort],
  );
  const withPorts = translation.services.filter((service) => service.ports.length > 0);
  // A choice for a service the file no longer has would refuse the install; start over.
  const chosenGone =
    form.webService !== "" &&
    translation.services.length > 0 &&
    !translation.services.some((service) => service.name === form.webService);
  React.useEffect(() => {
    if (chosenGone) setForm((previous) => ({ ...previous, webService: "", webPort: "" }));
  }, [chosenGone]);
  const showPicker =
    translation.services.length > 0 &&
    (form.webService !== "" || translation.web === null || withPorts.length > 1);

  const loadFromGitHub = async () => {
    const url = rawGitHubUrl(form.repo, form.branch.trim(), form.path.trim());
    if (!url) {
      setLoadError("Use https://github.com/owner/repo with a plain branch name and file path.");
      return;
    }
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(url, { credentials: "omit", cache: "no-store", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(String(response.status));
      // Read no more than the translator accepts, whatever the server claims.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      let size = 0;
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        size += chunk.value.length;
        if (size > COMPOSE_MAX_BYTES) {
          controller.abort();
          throw new Error("larger than 64 KiB");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      if (loadAbort.current !== controller) return;
      setForm((previous) => ({ ...previous, yaml: text, webService: "", webPort: "" }));
    } catch (err) {
      if (loadAbort.current !== controller) return;
      setLoadError(
        `Couldn't load that file from GitHub (${err instanceof Error ? err.message : "network error"}). Check that the repository is public and the branch and path are right.`,
      );
    } finally {
      if (loadAbort.current === controller) setLoading(false);
    }
  };

  const domain = form.domain.trim().toLowerCase();
  const local: Record<string, string> = {};
  if (form.serverId === "") local["server_id"] = "Pick the server this project runs on.";
  if (!DOMAIN_RE.test(domain)) local["domain"] = "Enter a domain such as app.example.com.";
  if (!EMAIL_RE.test(form.adminEmail.trim())) local["admin_email"] = "Enter an email address.";

  const remote = fieldErrors(install.error ?? plan.error);
  const errorFor = (field: string): string | undefined =>
    remote[field] ?? (submitted ? local[field] : undefined);

  // Install sends the deferred text the preview shows, so it can't run ahead of it.
  const runnable =
    yaml.trim() !== "" && translation.refused.length === 0 && translation.web !== null;

  const input = (planId?: string): InstallAppInput => ({
    app_id: COMPOSE_APP_ID,
    compose: yaml,
    ...(form.webService ? { web_service: form.webService } : {}),
    ...(form.webPort ? { web_port: Number(form.webPort) } : {}),
    server_id: form.serverId,
    domain,
    admin_email: form.adminEmail.trim(),
    ssl: form.ssl,
    system_user: "www-data",
    ...(planId ? { plan_id: planId } : {}),
  });

  const submit = () => {
    setSubmitted(true);
    if (busy.current || Object.keys(local).length > 0 || !runnable) return;
    busy.current = true;
    const release = () => {
      busy.current = false;
    };
    install.reset();
    plan.mutate(input(), {
      onError: release,
      onSuccess: (result) =>
        install.mutate(input(result.plan_id), {
          onSettled: release,
          onSuccess: ({ install: row }) => {
            onOpenChange(false);
            router.push(`/apps/installs/${row.id}`);
          },
        }),
    });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Docker Compose"
      description="Paste a compose file or load one from GitHub. Kaname runs its services on your server behind the domain you choose."
      submitLabel="Install"
      submitting={plan.isPending || install.isPending}
      canSubmit={runnable}
      error={install.error ?? plan.error}
      onSubmit={submit}
      size="lg"
    >
      <FormField
        label="Load from GitHub"
        description="Optional. A public repository; the file fills the box below."
        error={loadError ?? undefined}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto]">
          <Input
            value={form.repo}
            onChange={(event) => set("repo", event.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-label="Repository"
            mono
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            value={form.branch}
            onChange={(event) => set("branch", event.target.value)}
            placeholder="main"
            aria-label="Branch"
            mono
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            value={form.path}
            onChange={(event) => set("path", event.target.value)}
            placeholder="docker-compose.yml"
            aria-label="File path"
            mono
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="button"
            loading={loading}
            disabled={form.repo.trim() === ""}
            onClick={() => void loadFromGitHub()}
          >
            Load
          </Button>
        </div>
      </FormField>

      <FormField label="Compose file" error={remote["compose"]} required>
        <Textarea
          value={form.yaml}
          onChange={(event) => set("yaml", event.target.value)}
          placeholder={"services:\n  web:\n    image: nginx:1.27\n    ports:\n      - 8080:80"}
          rows={12}
          mono
          spellCheck={false}
          data-autofocus=""
        />
      </FormField>

      <ComposePreview translation={translation} />

      {showPicker && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <FormField
            label="Web service"
            description="The service the domain sends visitors to."
            error={remote["web_service"]}
          >
            <Select
              value={form.webService || translation.web?.service || ""}
              onChange={(event) => {
                const name = event.target.value;
                const ports = translation.services.find((s) => s.name === name)?.ports ?? [];
                setForm((previous) => ({
                  ...previous,
                  webService: name,
                  webPort: ports[0] !== undefined ? String(ports[0]) : "",
                }));
              }}
              placeholder="Choose a service"
              options={translation.services.map((service) => ({
                value: service.name,
                label: service.name,
              }))}
              mono
            />
          </FormField>
          <FormField label="Port" error={remote["web_port"]}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.webPort || (translation.web ? String(translation.web.port) : "")}
              // A port belongs to a service: pin the shown one, and wait for one to be chosen.
              disabled={!form.webService && !translation.web}
              onChange={(event) => {
                const port = event.target.value;
                setForm((previous) => ({
                  ...previous,
                  webService: previous.webService || translation.web?.service || "",
                  webPort: port,
                }));
              }}
              placeholder="80"
              mono
            />
          </FormField>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Server" error={errorFor("server_id")} required>
          <Combobox
            options={serverOptions}
            value={form.serverId}
            onValueChange={(next) => set("serverId", next ?? "")}
            placeholder={
              serverOptions.length === 0 ? "No host you can run containers on" : "Select a server"
            }
            emptyMessage="No server matches that name."
            loading={servers.isLoading}
            disabled={serverOptions.length === 0}
            mono
          />
        </FormField>
        <FormField
          label="Domain"
          description="Point its DNS at the server first, so HTTPS can be issued."
          error={errorFor("domain")}
          required
        >
          <Input
            value={form.domain}
            onChange={(event) => set("domain", event.target.value)}
            placeholder="app.example.com"
            mono
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
      </div>

      <FormField
        label="Your email"
        description="Let's Encrypt writes here before a certificate would expire."
        error={errorFor("admin_email")}
        required
      >
        <Input
          type="email"
          value={form.adminEmail}
          onChange={(event) => set("adminEmail", event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
      </FormField>

      <Switch
        checked={form.ssl}
        onChange={(event) => set("ssl", event.target.checked)}
        label="Secure it with HTTPS"
        description="Issue a free Let's Encrypt certificate and renew it automatically."
      />
    </FormDialog>
  );
}

/** What will run and what was refused. Environment values are never shown: they are often secrets. */
function ComposePreview({ translation }: { translation: ComposeTranslation }) {
  const { services, web, refused, notices } = translation;
  if (services.length === 0 && refused.length === 0 && notices.length === 0) return null;

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {services.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-sm font-medium text-[var(--kn-text-2)]">Will run</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {services.map((service) => (
              <li
                key={service.name}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
              >
                <span className="font-mono text-[var(--kn-text)]">{service.name}</span>
                <span className="min-w-0 truncate font-mono text-[var(--kn-text-3)]">
                  {service.image}
                </span>
                {web?.service === service.name && (
                  <Tag size="xs" mono>
                    web :{web.port}
                  </Tag>
                )}
                {service.volumes.map((volume) => (
                  <Tag key={`${volume.name}:${volume.target}`} size="xs" mono>
                    {volume.name} → {volume.target}
                    {volume.read_only ? " (ro)" : ""}
                  </Tag>
                ))}
              </li>
            ))}
          </ul>
          {web === null && refused.length === 0 && (
            <p className="m-0 text-sm text-[var(--kn-warn)]">
              Choose which service serves the website.
            </p>
          )}
        </div>
      )}

      {refused.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Refused">
          {refused.map((issue, index) => (
            <li key={index} className="text-sm text-[var(--kn-danger)]">
              {issueLabel(issue)}
            </li>
          ))}
        </ul>
      )}

      {notices.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Notices">
          {notices.map((issue, index) => (
            <li key={index} className="text-sm text-[var(--kn-text-3)]">
              {issueLabel(issue)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function issueLabel(issue: ComposeIssue): string {
  return [issue.line !== null ? `line ${issue.line}` : null, issue.service, issue.message]
    .filter(Boolean)
    .join(" · ");
}
