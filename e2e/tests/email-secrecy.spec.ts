import { expect, test } from "@playwright/test";
import {
  fleetServer,
  kanameDomain,
  mailDomainNamed,
  mailServerOn,
  noteSecret,
  openDatabase,
  owner,
  processLog,
  readSecrets,
  startFeed,
  stopFeed,
  unique,
  withControlPlaneStopped,
  type JobRow,
} from "../support/email.js";

/* ------------------------------------------------------------------ *
 * Email — credentials cross one response and are never persisted
 * (KD-035).
 *
 * Every secret the Email specs were shown (mailbox passwords, deploy
 * setup links and first-mailbox passwords, relay passwords they typed)
 * is in the ledger; this spec adds its own, then looks for every one of
 * them where they must not be: the jobs and their logs, the audit trail,
 * the control plane's and the agents' process logs, and finally the
 * database itself, read directly with the control plane stopped. A
 * positive control in each place proves the search can see what is
 * there. Restarting the control plane also proves the other half of the
 * rule: deploy secrets nobody read are gone, not recovered.
 * ------------------------------------------------------------------ */

const SETUP_TOKEN = /#token=sim-[0-9a-f]{16}/;
const RELAY_PASSWORD = `relay-secret-${Math.random().toString(36).slice(2, 12)}`;
const DEPLOY_HOST = "edge-01";
const DEPLOY_DOMAIN = "panel.futureforge.dev";

test.describe.configure({ mode: "serial" });

let local = "";
let edgeMailServerId = "";

test.afterAll(async () => {
  await stopFeed().catch(() => undefined);
});

test("this spec's own credentials: a mailbox, a reset and a relay deploy nobody reveals", async () => {
  const api = await owner();
  const domain = (await mailDomainNamed(api, "futureforge.dev"))!;
  local = unique("secret-box");

  const created = await api.post<{ mailbox: { id: string }; password: string }>("/mailboxes", {
    mail_domain_id: domain.id,
    local_part: local,
  });
  expect(created.status, created.text).toBe(201);
  noteSecret("mailbox_password", created.body.data!.password);
  const reset = await api.post<{ password: string }>(`/mailboxes/${created.body.data!.mailbox.id}/reset-password`);
  expect(reset.status).toBe(200);
  expect(reset.body.data!.password).not.toBe(created.body.data!.password);
  noteSecret("mailbox_password", reset.body.data!.password);

  await startFeed();
  const edge = await fleetServer(api, DEPLOY_HOST);
  const target = await kanameDomain(api, DEPLOY_DOMAIN);
  noteSecret("relay_password", RELAY_PASSWORD);
  const deploy = await api.post<{ job: JobRow }>("/mail-servers", {
    server_id: edge.id,
    domain_id: target.id,
    admin_email: "alerts@example.org",
    sending: "relay",
    relay: { provider: "postmark", host: "smtp.postmarkapp.com", port: 587, password: RELAY_PASSWORD },
  });
  expect(deploy.status, deploy.text).toBe(202);
  expect(deploy.text).not.toContain(RELAY_PASSWORD);
  expect((await api.job(deploy.body.data!.job.id)).status).toBe("succeeded");
  edgeMailServerId = (await mailServerOn(api, DEPLOY_HOST))!.id;
});

test("no credential appears in any job, job log or audit event", async () => {
  const api = await owner();
  const secrets = readSecrets();
  expect(secrets.length).toBeGreaterThanOrEqual(3);

  const jobs = await api.get<JobRow[]>("/jobs?per_page=200");
  expect(jobs.status).toBe(200);
  const mailJobs = (jobs.body.data ?? []).filter((job) => job.type.startsWith("mail."));
  expect(mailJobs.length).toBeGreaterThan(0);
  const logs = (await Promise.all(mailJobs.map((job) => api.jobLog(job.id)))).join("\n");
  const trail = await api.auditTrail();

  /* Positive controls: the search sees the rows that are there. */
  expect(jobs.text).toContain("mail.server.deploy");
  expect(trail).toContain("password_ref");
  expect(logs).toContain("available once from the panel for 15 minutes");
  expect(trail).toContain(`${local}@futureforge.dev`);
  expect(trail).toContain("mailbox.password_reset");

  for (const { kind, value } of secrets) {
    expect(jobs.text, `${kind} in jobs`).not.toContain(value);
    expect(logs, `${kind} in job logs`).not.toContain(value);
    expect(trail, `${kind} in the audit trail`).not.toContain(value);
  }
  for (const text of [jobs.text, logs, trail]) expect(text).not.toMatch(SETUP_TOKEN);
});

test("no credential appears in the control plane's or the agents' own logs", async () => {
  const secrets = readSecrets();
  const control = processLog("control-plane");
  expect(control.length).toBeGreaterThan(0);
  const agents = ["mail-01", "forge-01", "db-01", "edge-01"].map((name) => processLog(`agent-${name}`)).join("\n");
  expect(agents.length).toBeGreaterThan(0);

  for (const { kind, value } of secrets) {
    expect(control, `${kind} in the control-plane log`).not.toContain(value);
    expect(agents, `${kind} in an agent log`).not.toContain(value);
  }
  expect(control).not.toMatch(SETUP_TOKEN);
  expect(agents).not.toMatch(SETUP_TOKEN);
});

test("the database holds none of them, and deploy secrets nobody read do not survive a restart", async () => {
  test.setTimeout(300_000);
  const secrets = readSecrets();
  /* edge-01's deploy secrets were never read: they wait in the old
   * process's memory, and the only read is made after the restart. */
  expect(edgeMailServerId).not.toBe("");

  const dump = await withControlPlaneStopped(async () => {
    const db = await openDatabase();
    try {
      const tables = await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
      );
      const parts: string[] = [];
      for (const { table_name } of tables.rows) {
        const rows = await db.query<{ row: string }>(`select t::text as row from "${table_name}" t`);
        parts.push(`== ${table_name}\n${rows.rows.map((r) => r.row).join("\n")}`);
      }
      return parts.join("\n");
    } finally {
      await db.close();
    }
  });

  /* Positive controls: rows these specs wrote are in the dump. */
  expect(dump).toContain("== jobs");
  expect(dump).toContain("== audit_events");
  expect(dump).toContain(`${local}@futureforge.dev`);
  expect(dump).toContain("password_ref");

  for (const { kind, value } of secrets) {
    expect(dump.includes(value), `${kind} is stored in the database`).toBe(false);
  }
  expect(dump).not.toMatch(SETUP_TOKEN);

  /* The once-only hand-off lived in the old process only. */
  const fresh = await owner();
  const lost = await fresh.get(`/mail-servers/${edgeMailServerId}/deploy-secrets`);
  expect(lost.status).toBe(404);
  expect(lost.body.error?.message).toBe("The deploy secrets are not available (shown once, or expired).");
  expect(lost.body.error?.remediation?.summary).toContain("sudo yunori-mail setup-token");
});
