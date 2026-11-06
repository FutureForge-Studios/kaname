import type { Logger } from "pino";
import type { Database, DbHandle } from "@kaname/db";
import type { Config } from "./config.js";
import { AgentCa } from "./agent/ca.js";
import { AgentHub } from "./agent/hub.js";
import { JobQueue } from "./jobs/queue.js";
import { JobWorker } from "./jobs/worker.js";
import { AuditService } from "./services/audit.js";
import { AuthService } from "./services/auth.js";
import { EventBus } from "./services/events.js";
import { MailReleaseService, type MailReleaseServiceDeps } from "./services/mail-release.js";
import { MailSecretStore } from "./services/mail-secrets.js";
import { NotificationService, type NotificationServiceDeps } from "./services/notifications.js";
import { UpdateService, type UpdateServiceDeps } from "./services/updates.js";

/* ------------------------------------------------------------------ *
 * The application context.
 *
 * Constructed once at boot and threaded through every route. Routes
 * never reach for a module-level singleton, which is what makes the
 * whole thing testable against an in-memory PGlite instance.
 * ------------------------------------------------------------------ */

export interface AppContext {
  config: Config;
  log: Logger;
  db: Database;
  dbHandle: DbHandle;
  hub: AgentHub;
  ca: AgentCa;
  queue: JobQueue;
  worker: JobWorker;
  events: EventBus;
  audit: AuditService;
  auth: AuthService;
  updates: UpdateService;
  notifications: NotificationService;
  /** Which yunori-mail release a deploy installs. */
  mailReleases: MailReleaseService;
  /** Once-only hand-offs for the mail module; shared by routes and job handlers. */
  mailSecrets: MailSecretStore;
}

export function createContext(
  deps: {
    config: Config;
    log: Logger;
    dbHandle: DbHandle;
  },
  updateDeps: UpdateServiceDeps = {},
  notificationDeps: NotificationServiceDeps = {},
  mailReleaseDeps: MailReleaseServiceDeps = {},
): AppContext {
  const { config, log, dbHandle } = deps;
  const db = dbHandle.db;

  const hub = new AgentHub(log.child({ component: "agent-hub" }));
  const ca = new AgentCa(db, config);
  const queue = new JobQueue(db);
  const events = new EventBus();
  const audit = new AuditService(db);
  const auth = new AuthService(db, config);

  const mailReleases = new MailReleaseService({
    feed: config.KANAME_YUNORI_FEED,
    pin: config.KANAME_YUNORI_VERSION,
    ...mailReleaseDeps,
  });
  const mailSecrets = new MailSecretStore();

  const worker = new JobWorker({
    db,
    hub,
    queue,
    events,
    audit,
    config,
    log: log.child({ component: "job-worker" }),
    mailReleases,
    mailSecrets,
  });

  // The update service reads and writes through the context it belongs
  // to, so it is attached after the object exists rather than taking a
  // half-built one through its constructor.
  const ctx: AppContext = {
    config,
    log,
    db,
    dbHandle,
    hub,
    ca,
    queue,
    worker,
    events,
    audit,
    auth,
    updates: null as unknown as UpdateService,
    notifications: null as unknown as NotificationService,
    mailReleases,
    mailSecrets,
  };
  ctx.updates = new UpdateService(ctx, updateDeps);
  ctx.notifications = new NotificationService(ctx, notificationDeps);
  return ctx;
}
