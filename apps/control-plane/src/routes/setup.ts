import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, sql } from "@kaname/db";
import {
  backupSchedules,
  domains,
  jobs,
  mailServers,
  notificationChannels,
  servers,
  settings,
  sites,
  users,
} from "@kaname/db/schema";
import {
  assessPassword,
  createOwnerInput,
  optionalSetupStep,
  passwordContext,
  setInstanceNameInput,
  setupAddressInput,
  setupEmailDeployInput,
  setupPreferencesInput,
  setupStepInput,
  setupTokenInput,
  type OptionalSetupStep,
} from "@kaname/contract";
import { z } from "zod";
import { item, parseBody, parseParams } from "../http/plugin.js";
import { ApiException, conflict } from "../lib/errors.js";
import {
  claimSetupToken,
  clearSetupCookie,
  createOwner,
  hasOwner,
  isSetupAuthorized,
  issueSetupCookie,
  loadProgress,
  readSetupHealth,
  readSetupState,
  recordOutcome,
  requireNoOwner,
  requireSetupOpen,
  saveProgress,
} from "../services/setup.js";
import type { AppContext } from "../context.js";
import { setSessionCookie } from "./auth.js";
import { issueEnrollmentToken } from "./servers.js";
import { saveSmtpSettings } from "../services/notifications.js";
import { DEFAULT_NOTIFICATION_EVENTS } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Onboarding.
 *
 * Every one of these is guarded on the server. Hiding the route in the
 * browser would be theatre: on a fresh install these endpoints are the
 * ones that decide who owns the fleet, and they are reachable by anyone
 * who can reach the port.
 * ------------------------------------------------------------------ */

const SETUP_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } } as const;

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ state ----------------------------- */

  app.get("/setup/state", async (req, reply) => {
    // Public by necessity: the panel has to be able to ask "do I need
    // onboarding" before anyone can possibly be signed in. It reports
    // shape, never secrets.
    return item(reply, await readSetupState(req.ctx, { authorized: await isSetupAuthorized(req) }));
  });

  app.get("/setup/health", async (req, reply) => {
    if (!(await isSetupAuthorized(req))) {
      const progress = await loadProgress(req.ctx);
      if (progress.completed_at || (await hasOwner(req.ctx))) throw setupClosed();
    }
    return item(reply, await readSetupHealth(req.ctx));
  });

  /* ------------------------------ token ----------------------------- */

  app.post("/setup/token", SETUP_RATE_LIMIT, async (req, reply) => {
    await requireNoOwnerRegardlessOfToken(req);
    const body = parseBody(req, setupTokenInput);

    const tokenHash = await claimSetupToken(req.ctx, body.token.trim(), req.ip ?? null);
    issueSetupCookie(req, reply, tokenHash);

    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ----------------------------- welcome ---------------------------- */

  app.post("/setup/welcome", async (req, reply) => {
    await requireSetupOpen(req, reply);

    const health = await readSetupHealth(req.ctx);
    // Screen one is not skippable past a failure (spec 2.2). On an
    // all-in-one install everything downstream assumes a managed server,
    // so continuing past a dead agent would just move the confusion.
    if (health.all_in_one && health.agent.status !== "healthy") {
      throw new ApiException("precondition_failed", "The agent on this host has not connected.", {
        detail: health.agent,
        remediation: {
          summary:
            health.agent.remediation ??
            "The installer paired an agent on this host; it has to be running before setup continues.",
          actions: [],
        },
      });
    }

    await saveProgress(req.ctx, { welcome_ack: true });
    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ------------------------------ owner ----------------------------- */

  app.post("/setup/owner", SETUP_RATE_LIMIT, async (req, reply) => {
    await requireNoOwner(req, reply);
    const body = parseBody(req, createOwnerInput);

    const email = body.email.trim().toLowerCase();
    // Server-side, always. A client-side regex is a hint to the person
    // typing; this is the check that decides.
    const assessment = assessPassword(body.password, passwordContext(body.name, body.email));
    if (!assessment.ok) {
      throw new ApiException("validation_failed", "That password is not strong enough.", {
        fields: { password: assessment.problems.join(" ") },
        detail: { score: assessment.score, problems: assessment.problems },
      });
    }

    const owner = await createOwner(
      req.ctx,
      {
        email,
        name: body.name.trim(),
        passwordHash: await req.ctx.auth.hashPassword(body.password),
      },
      req.ip ?? null,
    );
    clearSetupCookie(req, reply);

    const session = await req.ctx.auth.createSession(owner.id, {
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      mfaSatisfied: true,
    });
    setSessionCookie(req, reply, session.token, session.expiresAt, true);

    await req.ctx.audit.record({
      actor: { type: "user", id: owner.id, name: owner.name, ip: req.ip ?? null },
      action: "setup.owner_created",
      targetType: "user",
      targetId: owner.id,
      targetLabel: owner.email,
      metadata: { email: owner.email },
    });

    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ---------------------------- instance ---------------------------- */

  app.post("/setup/instance", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);
    const body = parseBody(req, setInstanceNameInput);

    const current = await req.ctx.db
      .select()
      .from(settings)
      .where(eq(settings.key, "panel"))
      .limit(1);
    const panel = { ...((current[0]?.value as Record<string, unknown>) ?? {}) };
    panel.name = body.instance_name.trim();

    await req.ctx.db
      .insert(settings)
      .values({ key: "panel", value: panel })
      .onConflictDoUpdate({ target: settings.key, set: { value: panel, updatedAt: new Date() } });
    await saveProgress(req.ctx, { instance_named: true });

    await req.ctx.audit.record({
      actor: actor(req),
      action: "setup.instance_named",
      targetType: "settings",
      targetId: null,
      targetLabel: String(panel.name),
    });

    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ----------------------------- server ----------------------------- */

  const registerServerInput = z.object({
    name: z.string().min(1).max(120).default("server-01"),
    hostname: z.string().min(1).max(253).optional(),
  });

  /**
   * The installer's own pairing call, for the all-in-one case. It runs
   * before any account exists — there is nobody to sign in as yet — so
   * it is authorised by the setup token and refuses the moment an owner
   * exists, at which point ordinary enrollment takes over.
   */
  app.post("/setup/pair", SETUP_RATE_LIMIT, async (req, reply) => {
    await requireNoOwner(req, reply);
    const body = parseBody(req, registerServerInput);

    const name = body.name.trim();
    const existing = await req.ctx.db.select().from(servers).where(eq(servers.name, name)).limit(1);

    const server =
      existing[0] ??
      (
        await req.ctx.db
          .insert(servers)
          .values({ name, hostname: body.hostname?.trim() || name, connection: "never_enrolled" })
          .returning()
      )[0];
    if (!server) throw new Error("failed to register the server");

    const issued = await issueEnrollmentToken(req.ctx, server.id, null);

    await req.ctx.audit.record({
      actor: { type: "system", id: null, name: "installer", ip: req.ip ?? null },
      action: "setup.local_agent_paired",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
    });

    return item(reply, {
      server_id: server.id,
      server_name: server.name,
      token: issued.token,
      expires_at: issued.expiresAt.toISOString(),
      command: issued.command,
      control_plane_url: issued.controlPlaneUrl,
    });
  });

  app.post("/setup/server", async (req, reply) => {
    await requireSetupOpen(req, reply);
    const principal = await requireSignedIn(req);
    const body = parseBody(req, registerServerInput);

    const name = body.name.trim();
    const clash = await req.ctx.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.name, name))
      .limit(1);
    if (clash[0]) {
      throw conflict(`A server called "${name}" is already registered.`, {
        summary: "Pick another name, or pair the existing one from Infrastructure > Servers.",
        actions: [{ label: "Servers", href: "/infrastructure/servers" }],
      });
    }

    const [server] = await req.ctx.db
      .insert(servers)
      .values({ name, hostname: body.hostname?.trim() || name, connection: "never_enrolled" })
      .returning({ id: servers.id, name: servers.name });
    if (!server) throw new Error("failed to register the server");

    const issued = await issueEnrollmentToken(req.ctx, server.id, principal.id);

    await req.ctx.audit.record({
      actor: actor(req),
      action: "setup.server_registered",
      targetType: "server",
      targetId: server.id,
      targetLabel: server.name,
      serverId: server.id,
    });
    req.ctx.events.publish("servers", "server.created", { server_id: server.id }, server.id);

    return item(reply, {
      server_id: server.id,
      server_name: server.name,
      token: issued.token,
      expires_at: issued.expiresAt.toISOString(),
      command: issued.command,
      control_plane_url: issued.controlPlaneUrl,
    });
  });

  app.post("/setup/server/confirm", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);

    const state = await readSetupState(req.ctx, { authorized: true });
    if (state.servers_registered === 0) {
      throw new ApiException("precondition_failed", "No server has been registered yet.", {
        remediation: {
          summary:
            "Kaname manages servers through an agent that dials out from the host. Run the pairing command on the box you want to manage, then continue.",
          actions: [],
        },
      });
    }

    await saveProgress(req.ctx, { server_ack: true });
    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ----------------------------- address ---------------------------- */

  app.post("/setup/address", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);
    const body = parseBody(req, setupAddressInput);

    if (body.acme_email) await saveAcmeEmail(req.ctx, body.acme_email);

    // Applied on the last screen, not here: naming the panel restarts the
    // control plane, and that should interrupt setup once, at the end.
    // Kept server-side so a reload in between does not lose it.
    await recordOutcome(req.ctx, "address", "done", {
      pending_domain: body.panel_domain?.trim().toLowerCase() || null,
    });

    await req.ctx.audit.record({
      actor: actor(req),
      action: "setup.address_saved",
      targetType: "settings",
      targetId: null,
      targetLabel: "onboarding",
      metadata: { panel_domain: body.panel_domain ?? null, acme: Boolean(body.acme_email) },
    });

    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ------------------------------ email ----------------------------- */

  /**
   * The email step deploys through POST /mail-servers like the Email
   * module does; this only remembers which job that was, so a reload
   * resumes the progress view instead of offering a second deploy.
   */
  app.post("/setup/email/deploy", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);
    const body = parseBody(req, setupEmailDeployInput);

    const job = await req.ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, body.job_id),
          eq(jobs.type, "mail.server.deploy"),
          eq(jobs.serverId, body.server_id),
        ),
      )
      .limit(1);
    if (!job[0]) {
      throw new ApiException("not_found", "That is not a mail server deploy on this server.", {
        fields: { job_id: "not a mail.server.deploy job for this server" },
        remediation: {
          summary: "Start the deploy from this step, or from Email, and it is recorded here.",
          actions: [],
        },
      });
    }

    await saveProgress(req.ctx, { email_deploy: { job_id: body.job_id, server_id: body.server_id } });
    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ------------------------- optional steps ------------------------- */

  /**
   * Answers one optional step. The work behind "done" happened through
   * the module's own route — a site, a mail server, a schedule, an
   * invitation — so this checks that it exists rather than trusting the
   * browser's word, and a skip needs nothing at all.
   */
  app.post("/setup/steps/:step", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);
    const { step } = parseParams(req, z.object({ step: optionalSetupStep }));
    const body = parseBody(req, setupStepInput);

    if (body.outcome === "done") {
      if (step === "address" || step === "notifications") {
        throw new ApiException(
          "bad_request",
          `The ${step} step is saved by its own form, not marked done.`,
          {
            remediation: {
              summary:
                step === "address"
                  ? "POST /setup/address with the domain and ACME address, or skip the step."
                  : "POST /setup/preferences with the channel, or skip the step.",
              actions: [],
            },
          },
        );
      }
      if (!(await stepHasEvidence(req.ctx, step))) throw nothingToShow(step);
    }

    await recordOutcome(req.ctx, step, body.outcome);
    await req.ctx.audit.record({
      actor: actor(req),
      action: `setup.step_${body.outcome}`,
      targetType: "settings",
      targetId: null,
      targetLabel: step,
    });
    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* --------------------------- preferences -------------------------- */

  app.post("/setup/preferences", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);
    const body = parseBody(req, setupPreferencesInput);

    await req.ctx.updates.savePolicy({ tier: body.update_tier, interval: body.update_interval });

    if (body.acme_email) await saveAcmeEmail(req.ctx, body.acme_email);

    if (body.smtp) {
      await saveSmtpSettings(
        req.ctx,
        body.smtp,
        req.principal?.kind === "user" ? req.principal.id : null,
      );
    }

    if (body.notification.kind !== "none") {
      const target =
        body.notification.kind === "email" ? body.notification.address : body.notification.url;
      const name = body.notification.kind === "email" ? "Operators" : "Webhook";
      // Re-running the step (the browser was closed, the request was
      // retried) must not stack up duplicate channels.
      const existing = await req.ctx.db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(eq(notificationChannels.name, name))
        .limit(1);
      const values = {
        name,
        kind: body.notification.kind,
        config: { target },
        // Enough to be useful on day one without being noisy: the things
        // an operator would want a phone call about.
        events: [...DEFAULT_NOTIFICATION_EVENTS],
        enabled: true,
      };
      if (existing[0]) {
        await req.ctx.db
          .update(notificationChannels)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(notificationChannels.id, existing[0].id));
      } else {
        await req.ctx.db.insert(notificationChannels).values(values);
      }
      req.ctx.notifications.invalidate();
    }

    // This is the notifications step now; the address has a step of its
    // own. A domain sent here is still honoured (older clients sent it
    // with everything else), but an absent one must not clear what the
    // address step saved.
    await recordOutcome(
      req.ctx,
      "notifications",
      "done",
      body.panel_domain ? { pending_domain: body.panel_domain.trim().toLowerCase() } : {},
    );

    await req.ctx.audit.record({
      actor: actor(req),
      action: "setup.preferences_saved",
      targetType: "settings",
      targetId: null,
      targetLabel: "onboarding",
      metadata: { update_tier: body.update_tier, notification: body.notification.kind },
    });

    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });

  /* ---------------------------- complete ---------------------------- */

  app.post("/setup/complete", async (req, reply) => {
    await requireSetupOpen(req, reply);
    await requireSignedIn(req);

    const completedAt = new Date().toISOString();
    await saveProgress(req.ctx, {
      welcome_ack: true,
      server_ack: true,
      preferences_done: true,
      // Handed to /settings/address by the last screen; not an intent
      // to carry past the flow that recorded it.
      pending_domain: null,
      completed_at: completedAt,
    });

    await req.ctx.audit.record({
      actor: actor(req),
      action: "setup.completed",
      targetType: "settings",
      targetId: null,
      targetLabel: "onboarding",
    });

    return item(reply, await readSetupState(req.ctx, { authorized: true }));
  });
}

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/**
 * The steps after the account exists are ordinary authenticated work,
 * so they need a session rather than the installer's token. Without
 * this, a stale setup cookie could keep renaming the instance long
 * after someone else had claimed it.
 */
async function requireSignedIn(req: FastifyRequest): Promise<{ id: string; name: string }> {
  const principal = req.principal;
  if (!principal || principal.kind !== "user") {
    throw new ApiException("unauthenticated", "Sign in to continue setting up this instance.", {
      remediation: {
        summary: "The first account has been created, so the rest of setup runs as that account.",
        actions: [{ label: "Sign in", href: "/login" }],
      },
    });
  }
  return { id: principal.id, name: principal.name };
}

/** Refuses the token exchange itself once the instance has been claimed. */
async function requireNoOwnerRegardlessOfToken(req: FastifyRequest): Promise<void> {
  const progress = await loadProgress(req.ctx);
  if (progress.completed_at || (await hasOwner(req.ctx))) throw setupClosed();
}

function actor(req: FastifyRequest) {
  const principal = req.principal;
  return {
    type: "user" as const,
    id: principal?.id ?? null,
    name: principal?.name ?? "setup",
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function saveAcmeEmail(ctx: AppContext, email: string): Promise<void> {
  const current = await ctx.db.select().from(settings).where(eq(settings.key, "acme")).limit(1);
  const acme = { ...((current[0]?.value as Record<string, unknown>) ?? {}) };
  acme.email = email;
  await ctx.db
    .insert(settings)
    .values({ key: "acme", value: acme })
    .onConflictDoUpdate({ target: settings.key, set: { value: acme, updatedAt: new Date() } });
}

async function countOf(
  ctx: AppContext,
  table: typeof sites | typeof domains | typeof mailServers | typeof backupSchedules | typeof users,
): Promise<number> {
  const rows = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table);
  return rows[0]?.n ?? 0;
}

/** Whether what a step says it set up is really there. */
async function stepHasEvidence(ctx: AppContext, step: OptionalSetupStep): Promise<boolean> {
  switch (step) {
    case "website":
      return (await countOf(ctx, sites)) + (await countOf(ctx, domains)) > 0;
    case "email":
      return (await countOf(ctx, mailServers)) > 0;
    case "backups":
      return (await countOf(ctx, backupSchedules)) > 0;
    case "team":
      // The owner is the first account; a teammate is any other.
      return (await countOf(ctx, users)) > 1;
    default:
      return false;
  }
}

const STEP_EVIDENCE: Record<OptionalSetupStep, string> = {
  address: "",
  website: "No site or domain exists yet.",
  email: "No mail server exists yet.",
  backups: "No backup schedule exists yet.",
  notifications: "",
  team: "Nobody has been invited yet.",
};

const nothingToShow = (step: OptionalSetupStep) =>
  new ApiException("precondition_failed", STEP_EVIDENCE[step], {
    remediation: {
      summary: "Finish the form on this step first, or choose to do it later.",
      actions: [],
    },
  });

const setupClosed = () =>
  new ApiException("conflict", "This instance has already been set up.", {
    remediation: {
      summary: "Onboarding runs exactly once, when no account exists. Sign in instead.",
      actions: [{ label: "Sign in", href: "/login" }],
    },
  });
