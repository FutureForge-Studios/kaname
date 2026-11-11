import { z } from "zod";
import { isoDate, listQuery, uuid } from "../primitives.js";

/* ------------------------------------------------------------------ *
 * Versions and updates.
 *
 * Kaname's update problem is a superset of a single self-updating app:
 * a stateful control plane with a database, plus a fleet of agents that
 * are individually numerous and may be offline, mid-job or on a flaky
 * link at exactly the moment an update is dispatched. Both are modelled
 * here, and an agent rollout is an ordinary job like everything else.
 * ------------------------------------------------------------------ */

/** Semantic version, optionally with a pre-release and build suffix. */
export const semver = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "must be a semantic version like 1.4.2",
  );

export const releaseChannel = z.enum(["stable", "beta"]);
export type ReleaseChannel = z.infer<typeof releaseChannel>;

/**
 * Update cadence. The default is `notify` because this software runs
 * other people's production infrastructure: checking is helpful,
 * applying unattended is a decision the operator has to make.
 */
export const updateTier = z.enum(["off", "notify", "auto_minor", "auto_all"]);
export type UpdateTier = z.infer<typeof updateTier>;

export const UPDATE_TIER_LABELS: Record<UpdateTier, { label: string; detail: string }> = {
  off: {
    label: "Off",
    detail: "Never check automatically. You run updates yourself.",
  },
  notify: {
    label: "Notify only",
    detail: "Check on a schedule and tell you when something is available. Nothing applies itself.",
  },
  auto_minor: {
    label: "Apply patch and minor automatically",
    detail: "Patch and minor releases apply on schedule. Major releases still ask first.",
  },
  auto_all: {
    label: "Apply everything automatically",
    detail:
      "Including major releases. A breaking release still asks before it touches the control plane.",
  },
};

export const updateCheckInterval = z.enum(["hourly", "daily", "weekly"]);
export type UpdateCheckInterval = z.infer<typeof updateCheckInterval>;

/* ------------------------------------------------------------------ *
 * The release manifest
 *
 * Published alongside releases rather than inferred from registry tags,
 * so the running instance can reason about what a release *is* — is it
 * breaking, does it migrate destructively, what does it require to
 * upgrade from — before deciding whether it may apply unattended.
 * ------------------------------------------------------------------ */

export const releaseArtifacts = z.object({
  /** Container image reference for the control plane at this version. */
  control_plane: z.string().min(1),
  web: z.string().min(1),
  /** Agent binaries keyed by `<os>-<arch>`, with a sha256 for each. */
  agent: z.record(z.string(), z.object({ url: z.string().url(), sha256: z.string().length(64) })),
});

export const release = z.object({
  version: semver,
  channel: releaseChannel.default("stable"),
  released_at: isoDate,
  /** Blocks unattended application no matter the tier (see 3.6). */
  breaking: z.boolean().default(false),
  security: z.boolean().default(false),
  summary: z.string().max(500).default(""),
  notes_url: z.string().url().optional(),
  /**
   * Oldest version that can upgrade straight to this one. An instance
   * further back has to step through an intermediate release.
   */
  min_upgrade_from: semver.optional(),
  migrations: z
    .object({
      /** Drops or rewrites data. Forces confirmation like `breaking`. */
      destructive: z.boolean().default(false),
      /** Deterministic list, not a heuristic diff (see KD-028). */
      adds_config: z.array(z.string()).default([]),
    })
    .default({ destructive: false, adds_config: [] }),
  artifacts: releaseArtifacts,
});
export type Release = z.infer<typeof release>;

export const releaseManifest = z.object({
  schema: z.literal(1),
  /** Newest first. The control plane picks the highest applicable. */
  releases: z.array(release),
});
export type ReleaseManifest = z.infer<typeof releaseManifest>;

/**
 * The facts about the NEXT release, committed as `release.json` at the
 * repository root and consumed by the release workflow. A tag message
 * can only carry one word; the migration flags and the declared config
 * keys are what the hard rule and the config merge run on, so they live
 * in a file that is reviewed with the change that made them true.
 */
export const releaseFacts = z.object({
  breaking: z.boolean().default(false),
  destructive: z.boolean().default(false),
  security: z.boolean().default(false),
  adds_config: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  min_upgrade_from: semver.nullable().default(null),
  summary: z.string().max(500).default(""),
});
export type ReleaseFacts = z.infer<typeof releaseFacts>;

/** What `release.json` is reset to once a release has consumed it. */
export const DEFAULT_RELEASE_FACTS: ReleaseFacts = {
  breaking: false,
  destructive: false,
  security: false,
  adds_config: [],
  min_upgrade_from: null,
  summary: "",
};

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

export const componentKind = z.enum(["control_plane", "agent"]);
export type ComponentKind = z.infer<typeof componentKind>;

export const updateRunStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "needs_attention",
]);
export type UpdateRunStatus = z.infer<typeof updateRunStatus>;

export const updateRun = z.object({
  id: uuid,
  kind: componentKind,
  server_id: uuid.nullable(),
  server_name: z.string().nullable(),
  from_version: z.string(),
  to_version: z.string(),
  status: updateRunStatus,
  trigger: z.enum(["manual", "scheduled", "onboarding"]),
  breaking: z.boolean(),
  started_at: isoDate.nullable(),
  finished_at: isoDate.nullable(),
  duration_ms: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Full stdout/stderr, not a success boolean (see 3.3 step 8). */
  log: z.string(),
  job_id: uuid.nullable(),
  started_by: uuid.nullable(),
  started_by_name: z.string().nullable(),
  created_at: isoDate,
});
export type UpdateRun = z.infer<typeof updateRun>;

export const agentVersionRow = z.object({
  server_id: uuid,
  server_name: z.string(),
  hostname: z.string(),
  connection: z.string(),
  agent_version: z.string().nullable(),
  last_seen_at: isoDate.nullable(),
  up_to_date: z.boolean(),
  /** Set while a rollout is in flight or recently finished for this host. */
  run: updateRun.nullable(),
});
export type AgentVersionRow = z.infer<typeof agentVersionRow>;

export const updateOverview = z.object({
  control_plane: z.object({
    current_version: z.string(),
    latest_version: z.string().nullable(),
    update_available: z.boolean(),
    /** True when the pending release is breaking or migrates destructively. */
    requires_confirmation: z.boolean(),
    blocked_reason: z.string().nullable(),
    pending: release.nullable(),
    run: updateRun.nullable(),
  }),
  agents: z.array(agentVersionRow),
  settings: z.object({
    tier: updateTier,
    interval: updateCheckInterval,
    channel: releaseChannel,
    manifest_url: z.string(),
    last_checked_at: isoDate.nullable(),
    last_check_error: z.string().nullable(),
    /** Retry time after a failed check, the schedule otherwise. */
    next_check_at: isoDate.nullable(),
    /**
     * Why the scheduler's last unattended apply was refused. Without it
     * an instance set to apply itself that cannot — no recent backup,
     * host helper gone — looks exactly like one that has not got round
     * to it yet.
     */
    last_apply_error: z
      .object({ version: z.string(), message: z.string(), at: isoDate })
      .nullable(),
  }),
});
export type UpdateOverview = z.infer<typeof updateOverview>;

export const updatePolicyInput = z.object({
  tier: updateTier.optional(),
  interval: updateCheckInterval.optional(),
  channel: releaseChannel.optional(),
  manifest_url: z.string().url().optional(),
  /**
   * Required to move to `auto_all`. The tier applies major releases
   * without asking, so it is deliberately not one click from `notify`.
   */
  acknowledge_unattended_majors: z.boolean().optional(),
});
export type UpdatePolicyInput = z.infer<typeof updatePolicyInput>;

export const applyControlPlaneUpdateInput = z.object({
  to_version: semver,
  /** Must be true when the release is breaking or migrates destructively. */
  confirm_breaking: z.boolean().default(false),
  /** Skip the "there is a recent backup" precondition. Audited. */
  skip_backup_check: z.boolean().default(false),
});

export const applyAgentUpdateInput = z.object({
  to_version: semver,
  /** Empty means the whole fleet. */
  server_ids: z.array(uuid).default([]),
});

export const updateRunListQuery = listQuery.extend({
  kind: componentKind.optional(),
  status: updateRunStatus.optional(),
  server_id: uuid.optional(),
});

/* ------------------------------------------------------------------ *
 * Operating-system packages
 *
 * Not Kaname's own releases: the host's apt/dnf/apk/pacman updates, as
 * the agent reports them through `system.packages.list`. The control
 * plane caches the last answer per server (KD-041) so a page never fans
 * a package-manager run across the fleet; a refresh is explicit, and a
 * background pass keeps the cache from going stale.
 * ------------------------------------------------------------------ */

export const osPackageUpdate = z.object({
  name: z.string(),
  installed_version: z.string(),
  available_version: z.string(),
  security: z.boolean(),
});
export type OsPackageUpdate = z.infer<typeof osPackageUpdate>;

/**
 * - `unknown`: never checked (or the host has not been reachable).
 * - `current`: checked, nothing to install.
 * - `pending`: checked, updates waiting.
 * - `unsupported`: the host has no package manager the agent drives.
 * - `error`: the last check failed; `error` says why, and the previous
 *   package list (if any) is kept.
 */
export const osUpdateState = z.enum(["unknown", "current", "pending", "unsupported", "error"]);
export type OsUpdateState = z.infer<typeof osUpdateState>;

export const serverOsUpdatesSummary = z.object({
  server_id: uuid,
  server_name: z.string(),
  hostname: z.string(),
  connection: z.string(),
  simulated: z.boolean(),
  state: osUpdateState,
  checked_at: isoDate.nullable(),
  error: z.string().nullable(),
  total: z.number().int(),
  security: z.number().int(),
  /**
   * Only known after an upgrade: the agent reports it from that run
   * (`/var/run/reboot-required` and friends), so it is a fact about the
   * last upgrade rather than a live probe. Cleared when the host
   * reconnects after a reboot.
   */
  reboot_required: z.boolean(),
  reboot_required_since: isoDate.nullable(),
  last_upgrade_at: isoDate.nullable(),
  /** Apply security-only upgrades automatically, at most once a day. */
  auto_security: z.boolean(),
});
export type ServerOsUpdatesSummary = z.infer<typeof serverOsUpdatesSummary>;

export const serverOsUpdates = serverOsUpdatesSummary.extend({
  packages: z.array(osPackageUpdate),
});
export type ServerOsUpdates = z.infer<typeof serverOsUpdates>;

export const osUpdatesFleet = z.object({
  totals: z.object({
    servers: z.number().int(),
    servers_with_updates: z.number().int(),
    servers_with_security_updates: z.number().int(),
    packages: z.number().int(),
    security: z.number().int(),
    reboot_required: z.number().int(),
    unchecked: z.number().int(),
  }),
  servers: z.array(serverOsUpdatesSummary),
});
export type OsUpdatesFleet = z.infer<typeof osUpdatesFleet>;

export const upgradeOsPackagesInput = z.object({
  /** Only packages the package manager marks as security fixes. */
  security_only: z.boolean().default(false),
});
export type UpgradeOsPackagesInput = z.infer<typeof upgradeOsPackagesInput>;

export const bulkUpgradeOsPackagesInput = upgradeOsPackagesInput.extend({
  server_ids: z.array(uuid).min(1).max(500),
});
export type BulkUpgradeOsPackagesInput = z.infer<typeof bulkUpgradeOsPackagesInput>;

export const osUpdateSettingsInput = z.object({
  auto_security: z.boolean(),
});
export type OsUpdateSettingsInput = z.infer<typeof osUpdateSettingsInput>;

/* ------------------------------------------------------------------ *
 * Version arithmetic
 *
 * Shared so the control plane's decision to apply and the UI's
 * description of it can never disagree.
 * ------------------------------------------------------------------ */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim().replace(/^v/, ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * -1, 0 or 1. A pre-release sorts below its own release, and a version
 * that does not parse ("dev", "unknown", "") sorts below everything: an
 * agent reporting no real version is the one most in need of an update,
 * not one that is up to date.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Semver §11: dot-separated identifiers, compared one by one. Numeric
 * identifiers compare as numbers — which is what makes rc.10 newer than
 * rc.9 — and sort below alphanumeric ones; a shorter list that is a
 * prefix of the other sorts lower (1.0.0-alpha < 1.0.0-alpha.1).
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i]!;
    const y = right[i]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

export type VersionStep = "none" | "patch" | "minor" | "major";

export function versionStep(from: string, to: string): VersionStep {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b || compareVersions(from, to) >= 0) return "none";
  if (b.major !== a.major) return "major";
  if (b.minor !== a.minor) return "minor";
  return "patch";
}

/**
 * The single authority on "may this apply without a human". A breaking
 * release or a destructive migration always answers false, whatever the
 * tier — silent majors are not an acceptable failure mode (spec 3.6).
 */
export function mayApplyUnattended(tier: UpdateTier, from: string, candidate: Release): boolean {
  if (candidate.breaking || candidate.migrations.destructive) return false;
  const step = versionStep(from, candidate.version);
  if (step === "none") return false;
  switch (tier) {
    case "off":
    case "notify":
      return false;
    case "auto_minor":
      return step === "patch" || step === "minor";
    case "auto_all":
      return true;
  }
}

/** Newest release the instance is allowed to move to, or null. */
export function selectUpgrade(
  from: string,
  manifest: ReleaseManifest,
  channel: ReleaseChannel,
): Release | null {
  const candidates = manifest.releases
    .filter((r) => (channel === "beta" ? true : r.channel === "stable"))
    .filter((r) => compareVersions(from, r.version) < 0)
    .filter((r) => !r.min_upgrade_from || compareVersions(from, r.min_upgrade_from) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] ?? null;
}
