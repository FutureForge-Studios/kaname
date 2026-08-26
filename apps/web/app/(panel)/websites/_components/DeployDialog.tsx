"use client";

import * as React from "react";
import type { DeploymentSource, Site } from "@kaname/contract";
import { Combobox, FormField, Input, Select, Switch, type ComboboxOption } from "@kaname/ui";
import { FormDialog, fieldErrors } from "./FormDialog";
import { useSites, useTriggerDeployment } from "./queries";

/* ------------------------------------------------------------------ *
 * Trigger a deployment.
 *
 * The run happens on the host, so this queues a `deployment.run` job
 * and the build log streams on the deployment's own page. Repository
 * and branch fall back to what the site already carries, so the common
 * case is two clicks and no typing.
 * ------------------------------------------------------------------ */

const SHA_RE = /^[0-9a-f]{7,40}$/;

interface FormState {
  siteId: string;
  source: DeploymentSource;
  repoUrl: string;
  branch: string;
  commitSha: string;
  force: boolean;
}

export interface DeployDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pins the dialog to one site — from its detail page or a row action. */
  site?: Site | null;
  /** Pre-fills the revision, for "deploy this again". */
  commitSha?: string | null;
}

export function DeployDialog({
  open,
  onOpenChange,
  site = null,
  commitSha = null,
}: DeployDialogProps) {
  const sites = useSites({ per_page: 200, sort: "name", order: "asc" }, open && !site);
  const trigger = useTriggerDeployment();
  const resetMutation = trigger.reset;

  const [form, setForm] = React.useState<FormState>({
    siteId: "",
    source: "git",
    repoUrl: "",
    branch: "",
    commitSha: "",
    force: false,
  });
  const [submitted, setSubmitted] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setForm({
      siteId: site?.id ?? "",
      source: "git",
      repoUrl: "",
      branch: "",
      commitSha: commitSha ?? "",
      force: commitSha !== null,
    });
    setSubmitted(false);
    resetMutation();
  }, [open, site, commitSha, resetMutation]);

  const set = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  }, []);

  const siteOptions = React.useMemo<ComboboxOption[]>(
    () =>
      (sites.data?.data ?? []).map((row) => ({
        value: row.id,
        label: row.name,
        description: row.primary_domain ?? row.server_name,
        mono: true,
      })),
    [sites.data],
  );

  const remote = fieldErrors(trigger.error);
  const local: Record<string, string> = {};
  if (form.siteId === "") local["site_id"] = "Pick the site to deploy.";
  if (form.commitSha.trim() && !SHA_RE.test(form.commitSha.trim().toLowerCase())) {
    local["commit_sha"] = "Must be a git object id — 7 to 40 hexadecimal characters.";
  }
  if (form.repoUrl.trim().length > 512) local["repo_url"] = "Too long for a repository URL.";

  const errorFor = (field: string): string | undefined =>
    submitted ? (local[field] ?? remote[field]) : remote[field];

  const submit = () => {
    setSubmitted(true);
    if (Object.keys(local).length > 0) return;

    trigger.mutate(
      {
        site_id: form.siteId,
        source: form.source,
        force: form.force,
        ...(form.repoUrl.trim() ? { repo_url: form.repoUrl.trim() } : {}),
        ...(form.branch.trim() ? { branch: form.branch.trim() } : {}),
        ...(form.commitSha.trim() ? { commit_sha: form.commitSha.trim().toLowerCase() } : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={site ? `Deploy ${site.name}` : "Deploy a site"}
      description="Queues a build on the host. The log streams on the deployment page as it runs."
      submitLabel="Start deployment"
      submitting={trigger.isPending}
      error={trigger.error}
      onSubmit={submit}
    >
      {!site && (
        <FormField label="Site" error={errorFor("site_id")} required>
          <Combobox
            options={siteOptions}
            value={form.siteId}
            onValueChange={(next) => set("siteId", next ?? "")}
            placeholder="Select a site"
            emptyMessage="No site matches that name."
            loading={sites.isLoading}
            mono
          />
        </FormField>
      )}

      <FormField label="Source" description="An upload deployment needs no repository.">
        <Select
          value={form.source}
          onChange={(event) => set("source", event.target.value as DeploymentSource)}
          options={[
            { value: "git", label: "Git repository" },
            { value: "upload", label: "Uploaded build" },
          ]}
        />
      </FormField>

      {form.source === "git" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField
            label="Repository"
            description="Leave blank to use the one on the site."
            error={errorFor("repo_url")}
          >
            <Input
              value={form.repoUrl}
              onChange={(event) => set("repoUrl", event.target.value)}
              placeholder="From the site"
              mono
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>

          <FormField
            label="Branch"
            description="Defaults to the site's branch."
            error={errorFor("branch")}
          >
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

      <FormField
        label="Revision"
        description="Pin the run to one commit, or leave blank to take the branch head."
        error={errorFor("commit_sha")}
      >
        <Input
          value={form.commitSha}
          onChange={(event) => set("commitSha", event.target.value)}
          placeholder="Branch head"
          mono
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <Switch
        checked={form.force}
        onChange={(event) => set("force", event.target.checked)}
        label="Deploy even if this revision already runs"
        description="Without this, redeploying the running commit is refused as a no-op."
      />
    </FormDialog>
  );
}
