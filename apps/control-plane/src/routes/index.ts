import type { FastifyInstance } from "fastify";

import { authRoutes } from "./auth.js";
import { serverRoutes } from "./servers.js";
import { serviceRoutes } from "./services.js";
import { processRoutes } from "./processes.js";
import { containerRoutes } from "./containers.js";
import { siteRoutes } from "./sites.js";
import { domainRoutes } from "./domains.js";
import { dnsRoutes } from "./dns.js";
import { certificateRoutes } from "./certificates.js";
import { deploymentRoutes } from "./deployments.js";
import { fileRoutes } from "./files.js";
import { ftpRoutes } from "./ftp.js";
import { storageRoutes } from "./storage.js";
import { mailRoutes } from "./mail.js";
import { databaseRoutes } from "./databases.js";
import { securityRoutes } from "./security.js";
import { backupRoutes } from "./backups.js";
import { monitoringRoutes } from "./monitoring.js";
import { logRoutes } from "./logs.js";
import { terminalRoutes } from "./terminal.js";
import { adminRoutes } from "./admin.js";
import { jobRoutes } from "./jobs.js";
import { eventRoutes } from "./events.js";
import { searchRoutes } from "./search.js";
import { dashboardRoutes } from "./dashboard.js";
import { setupRoutes } from "./setup.js";
import { updateRoutes } from "./updates.js";

/* ------------------------------------------------------------------ *
 * /api/v1 — one module per nav section.
 * ------------------------------------------------------------------ */

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // Setup is first: it is the only module reachable before an account
  // exists, and it refuses itself once one does.
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(dashboardRoutes);

  await app.register(serverRoutes);
  await app.register(serviceRoutes);
  await app.register(processRoutes);
  await app.register(containerRoutes);

  await app.register(siteRoutes);
  await app.register(domainRoutes);
  await app.register(dnsRoutes);
  await app.register(certificateRoutes);
  await app.register(deploymentRoutes);

  await app.register(fileRoutes);
  await app.register(ftpRoutes);
  await app.register(storageRoutes);

  await app.register(mailRoutes);
  await app.register(databaseRoutes);
  await app.register(securityRoutes);
  await app.register(backupRoutes);

  await app.register(monitoringRoutes);
  await app.register(logRoutes);
  await app.register(terminalRoutes);

  await app.register(adminRoutes);
  await app.register(updateRoutes);
  await app.register(jobRoutes);
  await app.register(eventRoutes);
  await app.register(searchRoutes);
}
