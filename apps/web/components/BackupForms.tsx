"use client";

import * as React from "react";
import { Check, Plug, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import type {
  BackupDestination,
  BackupDestinationTarget,
  BackupDestinationTestResult,
  BackupRetention,
  BackupRunStatus,
  BackupSchedule,
  BackupScope,
  RestorePoint,
  Server,
} from "@kaname/contract";
import {
  Badge,
  Button,
  Combobox,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Duration,
  FormField,
  IconButton,
  Input,
  MonoText,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  cn,
  type Tone,
} from "@kaname/ui";
import { api, type ApiError } from "@/lib/api";
import { CRON_PRESETS, describeCron, timeZoneOptions } from "@/lib/cron";
import { pluralize } from "@/lib/format";
import { useList, useMutationWithJob, useResourceMutation, useServers } from "@/lib/queries";
import { PageError } from "./PageError";

/* ------------------------------------------------------------------ *
 * Backup forms.
 *
 * Destinations, schedules and restores are three very different pieces
 * of work that must feel like one: the same dialog frame, the same
 * footer, the same field-level error binding off the control plane's
 * `fields` map, and the same typed confirmation for anything that
 * cannot be undone.
 *
 * Two rules from the API shape through into the UI. A destination's
 * credentials are write-only, so editing one never pretends to show
 * them back — rotating is an explicit, separate act. And a restore is
 * the one operation that writes over live data, so the dialog states
 * exactly what is about to be overwritten before it will arm.
 * ------------------------------------------------------------------ */

type DestinationKind = BackupDestination["kind"];
type ScopeKind = BackupScope["kind"];

export const DESTINATION_KIND_LABELS: Record<DestinationKind, string> = {
  s3: "S3 / compatible",
  b2: "Backblaze B2",
  sftp: "SFTP",
  local: "Local directory",
};

export const SCOPE_KIND_LABELS: Record<ScopeKind, string> = {
  files: "Files",
  databases: "Databases",
  mail: "Mail",
  config: "Configuration",
  panel: "Panel state",
};

/** What each scope covers when the operator names no selectors. */
const SCOPE_HINTS: Record<ScopeKind, string> = {
  files: "Absolute paths, one per line. Required — a files scope with no paths backs up nothing.",
  databases: "One per line, as engine:name — postgres:app, mysql:wordpress.",
  mail: "Absolute paths, one per line. Defaults to /var/vmail.",
  config: "Absolute paths, one per line. Defaults to /etc.",
  panel: "Absolute paths, one per line. Defaults to /var/lib/kaname.",
};

const DEFAULT_RETENTION: BackupRetention = {
  keep_last: 7,
  keep_daily: 7,
  keep_weekly: 4,
  keep_monthly: 6,
};

/* ----------------------------- summaries ---------------------------- */

export function describeScope(scope: readonly BackupScope[]): string {
  if (scope.length === 0) return "Nothing selected";
  return scope
    .map((entry) => {
      const label = SCOPE_KIND_LABELS[entry.kind];
      if (entry.selectors.length === 0) return `${label} (defaults)`;
      if (entry.selectors.length === 1) return `${label}: ${entry.selectors[0]}`;
      return `${label}: ${pluralize(entry.selectors.length, "entry", "entries")}`;
    })
    .join(" · ");
}

export function describeRetention(retention: BackupRetention): string {
  const parts: string[] = [];
  if (retention.keep_last > 0) parts.push(`${retention.keep_last} latest`);
  if (retention.keep_daily > 0) parts.push(`${retention.keep_daily} daily`);
  if (retention.keep_weekly > 0) parts.push(`${retention.keep_weekly} weekly`);
  if (retention.keep_monthly > 0) parts.push(`${retention.keep_monthly} monthly`);
  return parts.length > 0 ? `Keep ${parts.join(", ")}` : "Keeps nothing";
}

/** Where a destination points, never how it authenticates. */
export function describeDestination(destination: BackupDestination): string {
  const config = destination.config;
  switch (destination.kind) {
    case "s3":
      return `${config.endpoint ?? `s3.${config.region ?? "us-east-1"}.amazonaws.com`}/${config.bucket ?? ""}`;
    case "b2":
      return `b2://${config.bucket ?? ""}`;
    case "sftp":
      return `${config.host ?? ""}:${config.path ?? ""}`;
    default:
      return config.path ?? "";
  }
}

/* ------------------------------ display ----------------------------- */

const RUN_STATUS_TONES: Record<BackupRunStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "ok",
  partial: "warn",
  failed: "danger",
  cancelled: "neutral",
};

const RUN_STATUS_HINTS: Record<BackupRunStatus, string> = {
  queued: "Waiting for a worker, or for the agent to reconnect.",
  running: "The agent is writing to the destination now.",
  succeeded: "Everything in scope reached the destination.",
  partial: "Some of the scope was written; the rest failed. Check the job log.",
  failed: "Nothing usable was written. This schedule is not protecting anything yet.",
  cancelled: "Stopped before it finished.",
};

/**
 * A backup run is not a job — `partial` has no equivalent on the job
 * lifecycle — so it gets its own badge rather than being squeezed into
 * a JobStatusPill that would have to lie about it.
 */
export function RunStatusBadge({
  status,
  size = "sm",
}: {
  status: BackupRunStatus | null;
  size?: "xs" | "sm";
}) {
  if (!status) return <span className="text-[var(--kn-text-3)]">never run</span>;
  return (
    <StatusBadge tone={RUN_STATUS_TONES[status]} size={size} title={RUN_STATUS_HINTS[status]}>
      {status}
    </StatusBadge>
  );
}

/* --------------------------- error binding -------------------------- */

function fieldError(error: ApiError | null, ...keys: string[]): string | undefined {
  if (!error) return undefined;
  for (const key of keys) {
    const message = error.fields[key];
    if (message) return message;
  }
  return undefined;
}

/** Shown above the fields when the failure was not about one field. */
function FormError({ error, onRetry }: { error: ApiError | null; onRetry: () => void }) {
  if (!error || error.fieldEntries.length > 0) return null;
  return <PageError error={error} onRetry={onRetry} className="mb-4" />;
}

/* ------------------------------------------------------------------ *
 * Destination
 * ------------------------------------------------------------------ */

interface DestinationDraft {
  name: string;
  kind: DestinationKind;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  host: string;
  port: string;
  username: string;
  path: string;
  authMethod: "password" | "key";
  password: string;
  privateKey: string;
  passphrase: string;
  serverId: string;
}

function emptyDraft(destination: BackupDestination | null): DestinationDraft {
  return {
    name: destination?.name ?? "",
    kind: destination?.kind ?? "s3",
    endpoint: destination?.config.endpoint ?? "",
    region: destination?.config.region ?? "us-east-1",
    bucket: destination?.config.bucket ?? "",
    prefix: "",
    accessKeyId: "",
    secretAccessKey: "",
    host: destination?.config.host ?? "",
    port: "22",
    username: "",
    path: destination?.config.path ?? "",
    authMethod: "password",
    password: "",
    privateKey: "",
    passphrase: "",
    serverId: "",
  };
}

function buildTarget(draft: DestinationDraft): BackupDestinationTarget {
  switch (draft.kind) {
    case "s3":
      return {
        kind: "s3",
        ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
        region: draft.region.trim(),
        bucket: draft.bucket.trim(),
        prefix: draft.prefix.trim(),
        access_key_id: draft.accessKeyId.trim(),
        secret_access_key: draft.secretAccessKey,
      };
    case "b2":
      return {
        kind: "b2",
        bucket: draft.bucket.trim(),
        prefix: draft.prefix.trim(),
        access_key_id: draft.accessKeyId.trim(),
        secret_access_key: draft.secretAccessKey,
      };
    case "sftp":
      return {
        kind: "sftp",
        host: draft.host.trim(),
        port: Number(draft.port) || 22,
        username: draft.username.trim(),
        path: draft.path.trim(),
        auth:
          draft.authMethod === "password"
            ? { method: "password", password: draft.password }
            : {
                method: "key",
                private_key: draft.privateKey,
                ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
              },
      };
    default:
      return { kind: "local", server_id: draft.serverId, path: draft.path.trim() };
  }
}

export interface DestinationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present means edit; the kind is then immutable. */
  destination?: BackupDestination | null;
}

export function DestinationDialog({
  open,
  onOpenChange,
  destination = null,
}: DestinationDialogProps) {
  const editing = destination !== null;
  const [draft, setDraft] = React.useState<DestinationDraft>(() => emptyDraft(destination));
  const [rotate, setRotate] = React.useState(!editing);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [test, setTest] = React.useState<BackupDestinationTestResult | null>(null);
  const [testing, setTesting] = React.useState(false);

  const servers = useServers();

  React.useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft(destination));
    setRotate(!editing);
    setError(null);
    setTest(null);
  }, [destination, editing, open]);

  const patch = React.useCallback(
    (next: Partial<DestinationDraft>) => setDraft((prev) => ({ ...prev, ...next })),
    [],
  );

  const save = useResourceMutation<void, BackupDestination>({
    mutationFn: () =>
      editing
        ? api.patch<BackupDestination>(`/backups/destinations/${destination.id}`, {
            name: draft.name.trim(),
            ...(rotate ? { target: buildTarget(draft) } : {}),
          })
        : api.post<BackupDestination>("/backups/destinations", {
            name: draft.name.trim(),
            target: buildTarget(draft),
          }),
    invalidates: ["backups/destinations"],
    successMessage: (row) => `Destination "${row.name}" ${editing ? "updated" : "created"}.`,
    onDone: () => onOpenChange(false),
    onFailed: setError,
  });

  const runTest = React.useCallback(async () => {
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const body =
        editing && !rotate ? { destination_id: destination.id } : { target: buildTarget(draft) };
      setTest(await api.post<BackupDestinationTestResult>("/backups/destinations/test", body));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setTesting(false);
    }
  }, [destination, draft, editing, rotate]);

  const secretsShown = !editing || rotate;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" dismissible={!save.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <DialogHeader
          title={editing ? `Edit ${destination.name}` : "New backup destination"}
          description={
            editing
              ? "Credentials are write-only. Rotating them replaces what is stored; leaving them alone keeps it."
              : "Where snapshots are written. Credentials are stored envelope-encrypted and are never readable again."
          }
        />

        <DialogBody>
          <FormError error={error} onRetry={() => save.mutate()} />

          <div className="flex flex-col gap-4">
            <FormField label="Name" required error={fieldError(error, "name")}>
              <Input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="offsite-s3"
                autoComplete="off"
                data-autofocus=""
              />
            </FormField>

            <FormField
              label="Kind"
              required
              description={
                editing
                  ? "A destination's kind is fixed — a different transport is a different destination."
                  : undefined
              }
            >
              <Select
                value={draft.kind}
                disabled={editing}
                onChange={(event) => patch({ kind: event.target.value as DestinationKind })}
                options={(Object.keys(DESTINATION_KIND_LABELS) as DestinationKind[]).map(
                  (kind) => ({ value: kind, label: DESTINATION_KIND_LABELS[kind] }),
                )}
              />
            </FormField>

            {editing && (
              <Switch
                checked={rotate}
                onChange={(event) => setRotate(event.target.checked)}
                label="Replace credentials"
                description="Sending a target again is the only way to rotate a stored credential."
              />
            )}

            {draft.kind === "local" && (
              <>
                <FormField label="Server" required error={fieldError(error, "target.server_id")}>
                  <Combobox
                    options={
                      servers.data?.data.map((server) => ({
                        value: server.id,
                        label: server.name,
                        description: server.hostname,
                        mono: true,
                      })) ?? []
                    }
                    value={draft.serverId}
                    onValueChange={(next) => patch({ serverId: next ?? "" })}
                    loading={servers.isLoading}
                    placeholder="Select a server"
                    emptyMessage="No server matches that name."
                    mono
                  />
                </FormField>
                <FormField
                  label="Directory"
                  required
                  description="Only schedules on this same server can write here."
                  error={fieldError(error, "target.path")}
                >
                  <Input
                    mono
                    value={draft.path}
                    onChange={(event) => patch({ path: event.target.value })}
                    placeholder="/var/backups/kaname"
                  />
                </FormField>
              </>
            )}

            {(draft.kind === "s3" || draft.kind === "b2") && (
              <>
                {draft.kind === "s3" && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <FormField
                      label="Endpoint"
                      description="Leave empty for AWS."
                      error={fieldError(error, "target.endpoint")}
                    >
                      <Input
                        mono
                        value={draft.endpoint}
                        onChange={(event) => patch({ endpoint: event.target.value })}
                        placeholder="s3.eu-central-1.wasabisys.com"
                      />
                    </FormField>
                    <FormField label="Region" required error={fieldError(error, "target.region")}>
                      <Input
                        mono
                        value={draft.region}
                        onChange={(event) => patch({ region: event.target.value })}
                      />
                    </FormField>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Bucket" required error={fieldError(error, "target.bucket")}>
                    <Input
                      mono
                      value={draft.bucket}
                      onChange={(event) => patch({ bucket: event.target.value })}
                    />
                  </FormField>
                  <FormField
                    label="Prefix"
                    description="Repositories are created under it, one per schedule."
                    error={fieldError(error, "target.prefix")}
                  >
                    <Input
                      mono
                      value={draft.prefix}
                      onChange={(event) => patch({ prefix: event.target.value })}
                      placeholder="kaname"
                    />
                  </FormField>
                </div>

                {secretsShown && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <FormField
                      label={draft.kind === "b2" ? "Key ID" : "Access key ID"}
                      required
                      error={fieldError(error, "target.access_key_id")}
                    >
                      <Input
                        mono
                        autoComplete="off"
                        value={draft.accessKeyId}
                        onChange={(event) => patch({ accessKeyId: event.target.value })}
                      />
                    </FormField>
                    <FormField
                      label={draft.kind === "b2" ? "Application key" : "Secret access key"}
                      required
                      error={fieldError(error, "target.secret_access_key")}
                    >
                      <Input
                        mono
                        type="password"
                        autoComplete="new-password"
                        value={draft.secretAccessKey}
                        onChange={(event) => patch({ secretAccessKey: event.target.value })}
                      />
                    </FormField>
                  </div>
                )}
              </>
            )}

            {draft.kind === "sftp" && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_96px]">
                  <FormField label="Host" required error={fieldError(error, "target.host")}>
                    <Input
                      mono
                      value={draft.host}
                      onChange={(event) => patch({ host: event.target.value })}
                      placeholder="backup.example.com"
                    />
                  </FormField>
                  <FormField label="Port" required error={fieldError(error, "target.port")}>
                    <Input
                      mono
                      inputMode="numeric"
                      value={draft.port}
                      onChange={(event) => patch({ port: event.target.value })}
                    />
                  </FormField>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Username" required error={fieldError(error, "target.username")}>
                    <Input
                      mono
                      autoComplete="off"
                      value={draft.username}
                      onChange={(event) => patch({ username: event.target.value })}
                    />
                  </FormField>
                  <FormField label="Path" required error={fieldError(error, "target.path")}>
                    <Input
                      mono
                      value={draft.path}
                      onChange={(event) => patch({ path: event.target.value })}
                      placeholder="/srv/backups"
                    />
                  </FormField>
                </div>

                {secretsShown && (
                  <>
                    <FormField label="Authentication" required>
                      <Select
                        value={draft.authMethod}
                        onChange={(event) =>
                          patch({ authMethod: event.target.value as "password" | "key" })
                        }
                        options={[
                          { value: "password", label: "Password" },
                          { value: "key", label: "Private key" },
                        ]}
                      />
                    </FormField>

                    {draft.authMethod === "password" ? (
                      <FormField
                        label="Password"
                        required
                        error={fieldError(error, "target.auth.password")}
                      >
                        <Input
                          type="password"
                          autoComplete="new-password"
                          value={draft.password}
                          onChange={(event) => patch({ password: event.target.value })}
                        />
                      </FormField>
                    ) : (
                      <>
                        <FormField
                          label="Private key"
                          required
                          description="PEM, including the BEGIN and END lines."
                          error={fieldError(error, "target.auth.private_key")}
                        >
                          <Textarea
                            mono
                            rows={4}
                            spellCheck={false}
                            value={draft.privateKey}
                            onChange={(event) => patch({ privateKey: event.target.value })}
                          />
                        </FormField>
                        <FormField
                          label="Passphrase"
                          error={fieldError(error, "target.auth.passphrase")}
                        >
                          <Input
                            type="password"
                            autoComplete="new-password"
                            value={draft.passphrase}
                            onChange={(event) => patch({ passphrase: event.target.value })}
                          />
                        </FormField>
                      </>
                    )}
                  </>
                )}
              </>
            )}

            <TestResult result={test} />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={Plug}
            loading={testing}
            onClick={() => void runTest()}
          >
            Test connection
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? "Save changes" : "Create destination"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function TestResult({ result }: { result: BackupDestinationTestResult | null }) {
  if (!result) return null;

  return (
    <div
      className={cn(
        "rounded-[var(--kn-r-sm)] border p-3",
        result.ok
          ? "border-[var(--kn-ok)] bg-[var(--kn-ok-soft)]"
          : "border-[var(--kn-danger)] bg-[var(--kn-danger-soft)]",
      )}
    >
      <div className="flex items-center gap-2">
        {result.ok ? (
          <Check size={14} className="text-[var(--kn-ok)]" aria-hidden />
        ) : (
          <X size={14} className="text-[var(--kn-danger)]" aria-hidden />
        )}
        <span className="font-medium text-[var(--kn-text)]">
          {result.ok ? "Reachable" : "Not reachable"}
        </span>
        {result.latency_ms !== null && (
          <Badge tone="neutral" size="xs" mono>
            <Duration ms={result.latency_ms} units={1} />
          </Badge>
        )}
        {result.writable && (
          <Badge tone="ok" size="xs">
            writable
          </Badge>
        )}
      </div>
      {result.error && <p className="mt-1.5 text-[var(--kn-text)]">{result.error}</p>}
      {result.remediation?.summary && (
        <p className="mt-1.5 text-sm text-[var(--kn-text-2)]">{result.remediation.summary}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

interface ScopeDraft {
  kind: ScopeKind;
  selectors: string;
}

interface ScheduleDraft {
  name: string;
  serverId: string;
  destinationId: string;
  cron: string;
  timezone: string;
  encryption: boolean;
  enabled: boolean;
  keepLast: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  scope: ScopeDraft[];
}

function scheduleDraft(schedule: BackupSchedule | null, defaultServerId: string): ScheduleDraft {
  return {
    name: schedule?.name ?? "",
    serverId: schedule?.server_id ?? defaultServerId,
    destinationId: schedule?.destination_id ?? "",
    cron: schedule?.cron ?? "30 2 * * *",
    timezone: schedule?.timezone ?? "UTC",
    encryption: schedule?.encryption ?? true,
    enabled: schedule?.enabled ?? true,
    keepLast: String(schedule?.retention.keep_last ?? DEFAULT_RETENTION.keep_last),
    keepDaily: String(schedule?.retention.keep_daily ?? DEFAULT_RETENTION.keep_daily),
    keepWeekly: String(schedule?.retention.keep_weekly ?? DEFAULT_RETENTION.keep_weekly),
    keepMonthly: String(schedule?.retention.keep_monthly ?? DEFAULT_RETENTION.keep_monthly),
    scope: (schedule?.scope ?? [{ kind: "files", selectors: [] }]).map((entry) => ({
      kind: entry.kind,
      selectors: entry.selectors.join("\n"),
    })),
  };
}

function toRetention(draft: ScheduleDraft): BackupRetention {
  return {
    keep_last: Number(draft.keepLast) || 0,
    keep_daily: Number(draft.keepDaily) || 0,
    keep_weekly: Number(draft.keepWeekly) || 0,
    keep_monthly: Number(draft.keepMonthly) || 0,
  };
}

function toScope(draft: ScheduleDraft): BackupScope[] {
  return draft.scope.map((entry) => ({
    kind: entry.kind,
    selectors: entry.selectors
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  }));
}

export interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: BackupSchedule | null;
  /** Preselected host when the dialog is opened from a server-scoped view. */
  defaultServerId?: string;
}

export function ScheduleDialog({
  open,
  onOpenChange,
  schedule = null,
  defaultServerId = "",
}: ScheduleDialogProps) {
  const editing = schedule !== null;
  const [draft, setDraft] = React.useState<ScheduleDraft>(() =>
    scheduleDraft(schedule, defaultServerId),
  );
  const [error, setError] = React.useState<ApiError | null>(null);

  const servers = useServers();
  const destinations = useList<BackupDestination>(
    "backups/destinations",
    { per_page: 200, sort: "name", order: "asc" },
    { enabled: open },
  );

  React.useEffect(() => {
    if (!open) return;
    setDraft(scheduleDraft(schedule, defaultServerId));
    setError(null);
  }, [defaultServerId, open, schedule]);

  const patch = React.useCallback(
    (next: Partial<ScheduleDraft>) => setDraft((prev) => ({ ...prev, ...next })),
    [],
  );

  const save = useResourceMutation<void, BackupSchedule>({
    mutationFn: () => {
      const common = {
        name: draft.name.trim(),
        scope: toScope(draft),
        cron: draft.cron.trim(),
        timezone: draft.timezone,
        destination_id: draft.destinationId,
        retention: toRetention(draft),
        encryption: draft.encryption,
        enabled: draft.enabled,
      };
      return editing
        ? api.patch<BackupSchedule>(`/backups/schedules/${schedule.id}`, common)
        : api.post<BackupSchedule>("/backups/schedules", {
            ...common,
            server_id: draft.serverId,
          });
    },
    invalidates: ["backups/schedules"],
    successMessage: (row) => `Schedule "${row.name}" ${editing ? "updated" : "created"}.`,
    onDone: () => onOpenChange(false),
    onFailed: setError,
  });

  const zones = React.useMemo(() => timeZoneOptions(), []);
  const destination = destinations.data?.data.find((row) => row.id === draft.destinationId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" dismissible={!save.isPending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <DialogHeader
          title={editing ? `Edit ${schedule.name}` : "New backup schedule"}
          description={
            editing
              ? "A schedule belongs to the host it protects; re-targeting it means creating a new one."
              : "What to back up, from which host, how often, and how long to keep it."
          }
        />

        <DialogBody>
          <FormError error={error} onRetry={() => save.mutate()} />

          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Name" required error={fieldError(error, "name")}>
                <Input
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="web-01 nightly"
                  autoComplete="off"
                  data-autofocus=""
                />
              </FormField>

              <FormField
                label="Server"
                required
                description={editing ? "Fixed for the life of the schedule." : undefined}
                error={fieldError(error, "server_id")}
              >
                <Combobox
                  options={
                    servers.data?.data.map((server) => ({
                      value: server.id,
                      label: server.name,
                      description: server.hostname,
                      mono: true,
                    })) ?? []
                  }
                  value={editing ? schedule.server_id : draft.serverId}
                  onValueChange={(next) => patch({ serverId: next ?? "" })}
                  disabled={editing}
                  loading={servers.isLoading}
                  placeholder="Select a server"
                  emptyMessage="No server matches that name."
                  mono
                />
              </FormField>
            </div>

            <FormField
              label="Destination"
              required
              description={
                destination?.kind === "local"
                  ? "A local destination is a directory on one host, so only schedules on that same host can write to it."
                  : undefined
              }
              error={fieldError(error, "destination_id")}
            >
              <Combobox
                options={
                  destinations.data?.data.map((row) => ({
                    value: row.id,
                    label: row.name,
                    description: `${DESTINATION_KIND_LABELS[row.kind]} · ${describeDestination(row)}`,
                  })) ?? []
                }
                value={draft.destinationId}
                onValueChange={(next) => patch({ destinationId: next ?? "" })}
                loading={destinations.isLoading}
                placeholder="Select a destination"
                emptyMessage="No destination matches that name."
              />
            </FormField>

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1 font-medium text-[var(--kn-text)]">Scope</legend>
              {draft.scope.map((entry, index) => (
                <div
                  key={index}
                  className="grid grid-cols-1 items-start gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] p-2 sm:grid-cols-[160px_minmax(0,1fr)_28px]"
                >
                  <Select
                    value={entry.kind}
                    aria-label={`Scope ${index + 1} kind`}
                    onChange={(event) => {
                      const next = [...draft.scope];
                      next[index] = { ...entry, kind: event.target.value as ScopeKind };
                      patch({ scope: next });
                    }}
                    options={(Object.keys(SCOPE_KIND_LABELS) as ScopeKind[]).map((kind) => ({
                      value: kind,
                      label: SCOPE_KIND_LABELS[kind],
                    }))}
                  />
                  <Textarea
                    mono
                    rows={2}
                    spellCheck={false}
                    aria-label={`Scope ${index + 1} selectors`}
                    placeholder={SCOPE_HINTS[entry.kind]}
                    value={entry.selectors}
                    onChange={(event) => {
                      const next = [...draft.scope];
                      next[index] = { ...entry, selectors: event.target.value };
                      patch({ scope: next });
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    label={`Remove scope ${index + 1}`}
                    size="sm"
                    disabled={draft.scope.length === 1}
                    onClick={() =>
                      patch({ scope: draft.scope.filter((_, position) => position !== index) })
                    }
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-[var(--kn-text-2)]">
                  {SCOPE_HINTS[draft.scope[draft.scope.length - 1]?.kind ?? "files"]}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  icon={Plus}
                  onClick={() =>
                    patch({ scope: [...draft.scope, { kind: "files", selectors: "" }] })
                  }
                >
                  Add scope
                </Button>
              </div>
              {fieldError(error, "scope") && (
                <p role="alert" className="text-xs text-[var(--kn-danger)]">
                  {fieldError(error, "scope")}
                </p>
              )}
            </fieldset>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <FormField
                label="Cron expression"
                required
                description={describeCron(draft.cron, draft.timezone)}
                error={fieldError(error, "cron")}
              >
                <Input
                  mono
                  value={draft.cron}
                  onChange={(event) => patch({ cron: event.target.value })}
                  placeholder="30 2 * * *"
                  spellCheck={false}
                />
              </FormField>

              <FormField label="Time zone" required error={fieldError(error, "timezone")}>
                <Select
                  mono
                  value={draft.timezone}
                  onChange={(event) => patch({ timezone: event.target.value })}
                  options={zones.map((zone) => ({ value: zone, label: zone }))}
                />
              </FormField>
            </div>

            <FormField label="Common schedules">
              <Select
                value=""
                aria-label="Apply a common schedule"
                onChange={(event) => {
                  if (event.target.value) patch({ cron: event.target.value });
                }}
                placeholder="Pick one to fill the expression"
                options={CRON_PRESETS.map((preset) => ({
                  value: preset.value,
                  label: preset.label,
                }))}
              />
            </FormField>

            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-1 font-medium text-[var(--kn-text)]">Retention</legend>
              <p className="mb-2 text-sm text-[var(--kn-text-2)]">
                {describeRetention(toRetention(draft))}. Everything else is pruned from the
                destination.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <FormField label="Latest">
                  <Input
                    mono
                    inputMode="numeric"
                    value={draft.keepLast}
                    onChange={(event) => patch({ keepLast: event.target.value })}
                  />
                </FormField>
                <FormField label="Daily">
                  <Input
                    mono
                    inputMode="numeric"
                    value={draft.keepDaily}
                    onChange={(event) => patch({ keepDaily: event.target.value })}
                  />
                </FormField>
                <FormField label="Weekly">
                  <Input
                    mono
                    inputMode="numeric"
                    value={draft.keepWeekly}
                    onChange={(event) => patch({ keepWeekly: event.target.value })}
                  />
                </FormField>
                <FormField label="Monthly">
                  <Input
                    mono
                    inputMode="numeric"
                    value={draft.keepMonthly}
                    onChange={(event) => patch({ keepMonthly: event.target.value })}
                  />
                </FormField>
              </div>
              {fieldError(error, "retention") && (
                <p role="alert" className="mt-1 text-xs text-[var(--kn-danger)]">
                  {fieldError(error, "retention")}
                </p>
              )}
            </fieldset>

            <div className="flex flex-col gap-3">
              <Switch
                checked={draft.encryption}
                onChange={(event) => patch({ encryption: event.target.checked })}
                label="Encrypt the repository"
                description="Kaname generates and holds the repository password; a restore goes through the panel."
              />
              <Switch
                checked={draft.enabled}
                onChange={(event) => patch({ enabled: event.target.checked })}
                label="Enabled"
                description="A disabled schedule has no next run and is never picked up by the worker."
              />
            </div>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? "Save changes" : "Create schedule"}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

export interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  point: RestorePoint | null;
  servers: readonly Server[];
}

export function RestoreDialog({ open, onOpenChange, point, servers }: RestoreDialogProps) {
  const [targetServerId, setTargetServerId] = React.useState("");
  const [targetPath, setTargetPath] = React.useState("/");
  const [include, setInclude] = React.useState("");
  const [overwrite, setOverwrite] = React.useState(false);

  React.useEffect(() => {
    if (!open || !point) return;
    setTargetServerId(point.server_id);
    setTargetPath("/");
    setInclude("");
    setOverwrite(false);
  }, [open, point]);

  const restore = useMutationWithJob<void>({
    mutationFn: () =>
      api.post("/backups/restore", {
        restore_point_id: point!.id,
        target_server_id: targetServerId,
        target_path: targetPath.trim(),
        include: include
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        overwrite,
        confirm_label: point!.label,
      }),
    invalidates: ["backups/restore-points", "files", "databases"],
    describe: () => `Restore ${point?.label ?? ""}`,
    onQueued: () => onOpenChange(false),
  });

  const target = servers.find((server) => server.id === targetServerId);
  const targetName = target?.name ?? "the selected server";

  if (!point) return null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Restore from a snapshot"
      description={`Snapshot "${point.label}", taken from ${point.server_name}.`}
      confirmText={point.label}
      confirmLabel="Restore"
      loading={restore.isPending}
      onConfirm={() => restore.mutate()}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] p-3">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--kn-warn)]" aria-hidden />
          <p className="text-[var(--kn-text)]">
            {overwrite ? (
              <>
                Files already under{" "}
                <MonoText className="text-[var(--kn-text)]">{targetPath || "/"}</MonoText> on{" "}
                <span className="font-medium">{targetName}</span> will be replaced by the contents
                of this snapshot. There is no undo.
              </>
            ) : (
              <>
                Only files missing under{" "}
                <MonoText className="text-[var(--kn-text)]">{targetPath || "/"}</MonoText> on{" "}
                <span className="font-medium">{targetName}</span> will be written. Anything already
                there is left as it is.
              </>
            )}
          </p>
        </div>

        <FormField label="Restore onto" required>
          <Combobox
            options={servers.map((server) => ({
              value: server.id,
              label: server.name,
              description: server.hostname,
              mono: true,
            }))}
            value={targetServerId}
            onValueChange={(next) => setTargetServerId(next ?? "")}
            placeholder="Select a server"
            emptyMessage="No server matches that name."
            mono
          />
        </FormField>

        <FormField
          label="Target directory"
          required
          description="Paths from the snapshot are written under this directory."
        >
          <Input mono value={targetPath} onChange={(event) => setTargetPath(event.target.value)} />
        </FormField>

        <FormField
          label="Restore only these paths"
          description="One per line. Leave empty to restore the whole snapshot."
        >
          <Textarea
            mono
            rows={2}
            spellCheck={false}
            value={include}
            onChange={(event) => setInclude(event.target.value)}
            placeholder="/etc/nginx"
          />
        </FormField>

        <Switch
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
          label="Overwrite existing files"
          description="Off is the safe default: existing files win and only gaps are filled."
        />
      </div>
    </ConfirmDialog>
  );
}
