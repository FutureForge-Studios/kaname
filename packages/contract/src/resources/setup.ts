import { z } from "zod";
import { emailAddress, isoDate, uuid } from "../primitives.js";
import { updateCheckInterval, updateTier } from "./updates.js";
import { setAddressInput, smtpSettingsInput } from "./platform.js";

/* ------------------------------------------------------------------ *
 * First-run setup.
 *
 * Runs exactly once, the first time anyone opens the panel while no
 * owner account exists. Every guard here is server-side: hiding the
 * route on the client would leave the real endpoints open on a fresh
 * install, which is the worst possible moment to be wrong about it.
 * ------------------------------------------------------------------ */

export const setupStep = z.enum(["welcome", "owner", "instance", "server", "preferences", "done"]);
export type SetupStep = z.infer<typeof setupStep>;

export const SETUP_STEPS: readonly SetupStep[] = [
  "welcome",
  "owner",
  "instance",
  "server",
  "preferences",
  "done",
];

export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  welcome: "Check the install",
  owner: "Create your account",
  instance: "Name this instance",
  server: "Confirm your first server",
  preferences: "Preferences",
  done: "Done",
};

/* --------------------------- health --------------------------- */

export const componentHealth = z.enum(["healthy", "degraded", "unreachable", "unknown"]);
export type ComponentHealth = z.infer<typeof componentHealth>;

export const setupHealth = z.object({
  control_plane: z.object({
    status: componentHealth,
    version: z.string(),
    database: z.enum(["pglite", "postgres"]),
    detail: z.string(),
  }),
  agent: z.object({
    status: componentHealth,
    /** Null until a first agent has ever enrolled. */
    server_id: uuid.nullable(),
    server_name: z.string().nullable(),
    hostname: z.string().nullable(),
    version: z.string().nullable(),
    detail: z.string(),
    /** Shown verbatim when the agent has not paired (spec 2.2 screen 1). */
    remediation: z.string().nullable(),
  }),
  /** Whether the installer paired an agent on this same box. */
  all_in_one: z.boolean(),
});
export type SetupHealth = z.infer<typeof setupHealth>;

/* --------------------------- state ---------------------------- */

export const setupState = z.object({
  /** False once an owner exists — the flow never reopens after that. */
  needs_onboarding: z.boolean(),
  /** Where a resumed session should pick up (spec 2.3). */
  step: setupStep,
  completed_at: isoDate.nullable(),
  instance_name: z.string().nullable(),
  has_owner: z.boolean(),
  servers_registered: z.number().int(),
  servers_connected: z.number().int(),
  /** True when the caller presented a valid setup token or a session. */
  authorized: z.boolean(),
  /** True until an owner exists: every step before that needs the installer's token. */
  token_required: z.boolean(),
  /**
   * False once the token has expired unclaimed. It is still required —
   * a restart of the control plane mints a fresh one.
   */
  token_live: z.boolean(),
  /** A domain chosen on the preferences step, applied by the last one. */
  pending_domain: z.string().nullable(),
});
export type SetupState = z.infer<typeof setupState>;

/* --------------------------- inputs --------------------------- */

export const setupTokenInput = z.object({
  token: z.string().min(16).max(200),
});

export const createOwnerInput = z
  .object({
    name: z.string().min(1).max(120),
    email: emailAddress,
    password: z.string().min(12).max(256),
    password_confirmation: z.string().min(12).max(256),
  })
  .refine((v) => v.password === v.password_confirmation, {
    message: "The two passwords do not match.",
    path: ["password_confirmation"],
  });
export type CreateOwnerInput = z.infer<typeof createOwnerInput>;

export const setInstanceNameInput = z.object({
  instance_name: z.string().min(1).max(80),
});

export const setupPreferencesInput = z.object({
  update_tier: updateTier.default("notify"),
  update_interval: updateCheckInterval.default("daily"),
  acme_email: emailAddress.optional(),
  notification: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("email"), address: emailAddress }),
      z.object({ kind: z.literal("webhook"), url: z.string().url() }),
    ])
    .default({ kind: "none" }),
  /** The outgoing mail server an email channel needs. Optional here; Settings has it too. */
  smtp: smtpSettingsInput.optional(),
  /**
   * Validated now, applied by the last step: the restart it costs should
   * interrupt setup once, at the end, and never be spent on a typo.
   */
  panel_domain: setAddressInput.shape.domain.optional(),
});
export type SetupPreferencesInput = z.infer<typeof setupPreferencesInput>;

/**
 * What a password must not contain, derived once for both tiers so the
 * meter in the browser and the verdict on the control plane cannot
 * disagree about the same input.
 */
export function passwordContext(name: string, email: string): string[] {
  const lower = email.trim().toLowerCase();
  return [name, lower, lower.split("@")[0] ?? ""];
}

/**
 * Password strength, evaluated server-side. A regex that only runs in
 * the browser is decoration; this is the check that counts.
 */
export interface PasswordAssessment {
  ok: boolean;
  score: number;
  problems: string[];
}

const COMMON_PASSWORDS = [
  "password",
  "passw0rd",
  "letmein",
  "changeme",
  "administrator",
  "qwertyuiop",
  "iloveyou",
  "welcome123",
  "kaname",
];

export function assessPassword(password: string, context: string[] = []): PasswordAssessment {
  const lower = password.toLowerCase();

  /*
   * Two kinds of problem. A composition rule ("mix upper and lower
   * case") is a proxy for entropy and a long varied passphrase has
   * already satisfied what it was proxying for. A disqualifying problem
   * is not a proxy for anything: a password containing the account's own
   * address is guessed first no matter how long it is.
   */
  const disqualifying: string[] = [];
  const composition: string[] = [];

  if (password.length < 12) disqualifying.push("Use at least 12 characters.");
  if (COMMON_PASSWORDS.some((c) => lower.includes(c))) {
    disqualifying.push("This contains a very common password.");
  }
  for (const hint of context) {
    const trimmed = hint.trim().toLowerCase();
    if (trimmed.length >= 4 && lower.includes(trimmed)) {
      disqualifying.push("Do not reuse your name or email in the password.");
      break;
    }
  }

  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    composition.push("Mix upper and lower case.");
  }
  if (!/\d/.test(password) && !/[^A-Za-z0-9]/.test(password)) {
    composition.push("Include a number or a symbol.");
  }

  const passphrase = password.length >= 20 && new Set(password).size >= 12;
  const problems = passphrase ? disqualifying : [...disqualifying, ...composition];

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const score = Math.max(
    0,
    Math.min(4, variety + (password.length >= 16 ? 1 : 0) - problems.length),
  );
  return { ok: problems.length === 0, score, problems };
}

/* ------------------------- pairing ---------------------------- */

/** The copyable one-liner shown when adding a server (spec 1.3). */
export const pairingInstructions = z.object({
  server_id: uuid,
  server_name: z.string(),
  token: z.string(),
  expires_at: isoDate,
  command: z.string(),
  control_plane_url: z.string(),
});
export type PairingInstructions = z.infer<typeof pairingInstructions>;
