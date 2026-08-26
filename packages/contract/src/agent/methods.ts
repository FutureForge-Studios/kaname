import { z } from "zod";
import {
  absolutePath,
  archiveFormatOrDefault,
  identifier,
  ipAddress,
  cidr,
  fileMode,
} from "./method-helpers.js";
import {
  backupSnapshotInfo,
  banEntry,
  containerInfo,
  dbDatabaseInfo,
  dbInstanceInfo,
  dbUserInfo,
  directoryListing,
  dkimKeyInfo,
  fileEntry,
  firewallRuleInfo,
  imageInfo,
  logRecord,
  logSource,
  mailQueueEntry,
  metricsSample,
  packageInfo,
  processInfo,
  ptyOpenParams,
  ptyResizeParams,
  resolvedRecord,
  serviceInfo,
  signalParams,
  sshConfigInfo,
  sshKeyInfo,
  sshSessionInfo,
  storageUsageEntry,
  systemInfo,
  threatObservation,
} from "./payloads.js";

/* ------------------------------------------------------------------ *
 * Agent method registry.
 *
 * This list IS the agent's attack surface. Every entry is an enumerated
 * verb with a validated parameter schema. There is deliberately no
 * `exec(command: string)`; the only free-form execution path is `pty.*`,
 * which is separately permissioned, ticketed and recorded.
 * ------------------------------------------------------------------ */

export type StreamMode = "none" | "response" | "bidirectional";

export interface MethodSpec {
  params: z.ZodTypeAny;
  result: z.ZodTypeAny;
  /** Streaming shape. "response" = server pushes chunks until `end`. */
  stream: StreamMode;
  /** Host capabilities required; the hub rejects the call if absent. */
  requires: readonly string[];
  /** Read-only calls may be passed through synchronously (see KD-008). */
  readOnly: boolean;
  summary: string;
}

const ok = z.object({ ok: z.literal(true) });
const empty = z.object({});
const unit = z.object({ unit: z.string().min(1).max(256) });

/**
 * Identity function that PRESERVES each method's exact params and result
 * schemas. Typing it as `(spec: MethodSpec) => MethodSpec` looks
 * equivalent but widens both to ZodTypeAny, which silently degrades
 * every MethodResult<M> to `any` — and with it every hub.call() site in
 * the control plane.
 */
function m<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(spec: {
  params: P;
  result: R;
  stream: StreamMode;
  requires: readonly string[];
  readOnly: boolean;
  summary: string;
}): {
  params: P;
  result: R;
  stream: StreamMode;
  requires: readonly string[];
  readOnly: boolean;
  summary: string;
} {
  return spec;
}

export const AGENT_METHODS = {
  /* ------------------------------ system ----------------------------- */
  "system.info": m({
    params: empty,
    result: systemInfo,
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Host identity, hardware and agent version.",
  }),
  "system.metrics": m({
    params: empty,
    result: metricsSample,
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "One point-in-time resource sample.",
  }),
  "system.reboot": m({
    params: z.object({ delay_seconds: z.number().int().min(0).max(3600).default(0) }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Reboot the host.",
  }),
  "system.packages.list": m({
    params: z.object({ upgradable_only: z.boolean().default(false) }),
    result: z.object({ packages: z.array(packageInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Installed and upgradable packages.",
  }),
  "system.packages.upgrade": m({
    params: z.object({
      names: z.array(z.string().max(128)).max(500).default([]),
      security_only: z.boolean().default(false),
    }),
    result: z.object({ upgraded: z.array(z.string()), reboot_required: z.boolean() }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Apply package upgrades, streaming progress.",
  }),
  "system.self_update": m({
    params: z.object({
      version: z.string().min(1).max(64),
      url: z.string().url(),
      /** Verified before the downloaded binary is made executable. */
      sha256: z.string().length(64),
    }),
    result: z.object({
      previous_version: z.string(),
      version: z.string(),
      /**
       * Always true on success. The process that answers this call is the
       * one about to be replaced, so it cannot honestly report that the
       * new build came back — reconnecting at the new version is what
       * the control plane treats as success.
       */
      restarting: z.boolean(),
      /** Kept so a bad build can be put back by hand. */
      previous_binary_path: z.string(),
    }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Replace the agent binary with a verified build and restart.",
  }),

  /* ----------------------------- services ---------------------------- */
  "service.list": m({
    params: z.object({
      pattern: z.string().max(128).optional(),
      state: z.string().max(32).optional(),
    }),
    result: z.object({ services: z.array(serviceInfo) }),
    stream: "none",
    requires: ["systemd"],
    readOnly: true,
    summary: "Enumerate systemd units.",
  }),
  "service.status": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: true,
    summary: "One unit's current state.",
  }),
  "service.start": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: false,
    summary: "Start a unit.",
  }),
  "service.stop": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: false,
    summary: "Stop a unit.",
  }),
  "service.restart": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: false,
    summary: "Restart a unit.",
  }),
  "service.reload": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: false,
    summary: "Reload a unit's configuration.",
  }),
  "service.enable": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: false,
    summary: "Enable a unit at boot.",
  }),
  "service.disable": m({
    params: unit,
    result: serviceInfo,
    stream: "none",
    requires: ["systemd"],
    readOnly: false,
    summary: "Disable a unit at boot.",
  }),
  "service.logs": m({
    params: z.object({
      unit: z.string().max(256),
      lines: z.number().int().min(1).max(10000).default(200),
      follow: z.boolean().default(false),
      since: z.string().optional(),
    }),
    result: z.object({ records: z.array(logRecord) }),
    stream: "response",
    requires: ["systemd"],
    readOnly: true,
    summary: "Journal for a unit, optionally followed.",
  }),

  /* ---------------------------- processes ---------------------------- */
  "process.list": m({
    params: z.object({
      sort: z.enum(["cpu", "memory", "pid", "name"]).default("cpu"),
      limit: z.number().int().min(1).max(2000).default(200),
      user: identifier.optional(),
    }),
    result: z.object({ processes: z.array(processInfo), total: z.number().int() }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Live process table.",
  }),
  "process.tree": m({
    params: z.object({ pid: z.number().int().positive().optional() }),
    result: z.object({ processes: z.array(processInfo.extend({ depth: z.number().int() })) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Process hierarchy.",
  }),
  "process.signal": m({
    params: signalParams,
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Send a signal to a pid.",
  }),

  /* ---------------------------- containers --------------------------- */
  "container.list": m({
    params: z.object({ all: z.boolean().default(true), with_stats: z.boolean().default(false) }),
    result: z.object({ containers: z.array(containerInfo) }),
    stream: "none",
    requires: ["docker"],
    readOnly: true,
    summary: "Enumerate containers.",
  }),
  "container.inspect": m({
    params: z.object({ id: z.string().max(128) }),
    result: z.object({ container: containerInfo, raw: z.unknown() }),
    stream: "none",
    requires: ["docker"],
    readOnly: true,
    summary: "Full container definition.",
  }),
  "container.start": m({
    params: z.object({ id: z.string().max(128) }),
    result: containerInfo,
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Start a container.",
  }),
  "container.stop": m({
    params: z.object({
      id: z.string().max(128),
      timeout_seconds: z.number().int().min(0).max(600).default(10),
    }),
    result: containerInfo,
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Stop a container.",
  }),
  "container.restart": m({
    params: z.object({
      id: z.string().max(128),
      timeout_seconds: z.number().int().min(0).max(600).default(10),
    }),
    result: containerInfo,
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Restart a container.",
  }),
  "container.remove": m({
    params: z.object({
      id: z.string().max(128),
      force: z.boolean().default(false),
      remove_volumes: z.boolean().default(false),
    }),
    result: ok,
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Remove a container.",
  }),
  "container.logs": m({
    params: z.object({
      id: z.string().max(128),
      lines: z.number().int().min(1).max(10000).default(200),
      follow: z.boolean().default(false),
      since: z.string().optional(),
    }),
    result: z.object({ records: z.array(logRecord) }),
    stream: "response",
    requires: ["docker"],
    readOnly: true,
    summary: "Container logs, optionally followed.",
  }),
  "container.exec": m({
    params: z.object({
      id: z.string().max(128),
      cols: z.number().int().default(80),
      rows: z.number().int().default(24),
    }),
    result: ok,
    stream: "bidirectional",
    requires: ["docker"],
    readOnly: false,
    summary: "Attach an interactive shell to a container.",
  }),
  "container.images.list": m({
    params: empty,
    result: z.object({ images: z.array(imageInfo) }),
    stream: "none",
    requires: ["docker"],
    readOnly: true,
    summary: "Local images.",
  }),
  "container.prune": m({
    params: z.object({
      include_images: z.boolean().default(false),
      include_volumes: z.boolean().default(false),
    }),
    result: z.object({ reclaimed_bytes: z.number().int(), removed: z.array(z.string()) }),
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Reclaim unused container resources.",
  }),

  /* ------------------------------- files ----------------------------- */
  "fs.list": m({
    params: z.object({
      path: absolutePath,
      show_hidden: z.boolean().default(true),
      limit: z.number().int().min(1).max(5000).default(1000),
    }),
    result: directoryListing,
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "List a directory.",
  }),
  "fs.stat": m({
    params: z.object({ path: absolutePath }),
    result: fileEntry,
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Stat one path.",
  }),
  "fs.read": m({
    params: z.object({
      path: absolutePath,
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1024 * 1024)
        .default(1024 * 1024),
    }),
    result: z.object({
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]),
      truncated: z.boolean(),
      size: z.number().int(),
    }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Read a file for inline editing or preview.",
  }),
  "fs.write": m({
    params: z.object({
      path: absolutePath,
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      mode: fileMode.optional(),
      create_parents: z.boolean().default(false),
    }),
    result: fileEntry,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Write a file atomically (temp + rename).",
  }),
  "fs.mkdir": m({
    params: z.object({
      path: absolutePath,
      mode: fileMode.optional(),
      parents: z.boolean().default(true),
    }),
    result: fileEntry,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Create a directory.",
  }),
  "fs.move": m({
    params: z.object({
      from: absolutePath,
      to: absolutePath,
      overwrite: z.boolean().default(false),
    }),
    result: fileEntry,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Move or rename.",
  }),
  "fs.copy": m({
    params: z.object({
      from: absolutePath,
      to: absolutePath,
      overwrite: z.boolean().default(false),
    }),
    result: fileEntry,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Copy recursively.",
  }),
  "fs.remove": m({
    params: z.object({
      paths: z.array(absolutePath).min(1).max(500),
      recursive: z.boolean().default(false),
    }),
    result: z.object({ removed: z.number().int() }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Delete paths.",
  }),
  "fs.chmod": m({
    params: z.object({
      paths: z.array(absolutePath).min(1).max(500),
      mode: fileMode,
      recursive: z.boolean().default(false),
    }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Change permissions.",
  }),
  "fs.chown": m({
    params: z.object({
      paths: z.array(absolutePath).min(1).max(500),
      owner: identifier.optional(),
      group: identifier.optional(),
      recursive: z.boolean().default(false),
    }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Change ownership.",
  }),
  "fs.archive": m({
    params: z.object({
      paths: z.array(absolutePath).min(1).max(500),
      destination: absolutePath,
      format: archiveFormatOrDefault,
    }),
    result: fileEntry,
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Create an archive.",
  }),
  "fs.extract": m({
    params: z.object({
      path: absolutePath,
      destination: absolutePath,
      overwrite: z.boolean().default(false),
    }),
    result: z.object({ extracted: z.number().int() }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Extract an archive.",
  }),
  "fs.download": m({
    params: z.object({ path: absolutePath }),
    result: z.object({ size: z.number().int(), mime: z.string() }),
    stream: "response",
    requires: [],
    readOnly: true,
    summary: "Stream a file to the control plane.",
  }),
  "fs.upload": m({
    params: z.object({
      path: absolutePath,
      size: z.number().int(),
      mode: fileMode.optional(),
      overwrite: z.boolean().default(false),
    }),
    result: fileEntry,
    stream: "bidirectional",
    requires: [],
    readOnly: false,
    summary: "Stream a file onto the host.",
  }),
  "fs.usage": m({
    params: z.object({
      path: absolutePath.default("/"),
      depth: z.number().int().min(1).max(4).default(1),
    }),
    result: z.object({ entries: z.array(storageUsageEntry), total: z.number().int() }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Disk usage breakdown.",
  }),

  /* ------------------------------- sites ----------------------------- */
  "site.list": m({
    params: empty,
    result: z.object({
      sites: z.array(
        z.object({
          name: z.string(),
          webroot: z.string(),
          server_names: z.array(z.string()),
          runtime: z.string(),
          runtime_version: z.string().nullable(),
          enabled: z.boolean(),
          config_path: z.string(),
        }),
      ),
    }),
    stream: "none",
    requires: ["nginx"],
    readOnly: true,
    summary: "Web server virtual hosts.",
  }),
  "site.create": m({
    params: z.object({
      name: z.string().max(128),
      server_names: z.array(z.string()).min(1).max(50),
      webroot: absolutePath,
      runtime: z.enum(["static", "php", "node", "python", "proxy", "container"]),
      runtime_version: z.string().max(32).optional(),
      upstream: z.string().max(256).optional(),
      force_https: z.boolean().default(true),
      owner: identifier.optional(),
    }),
    result: z.object({ config_path: z.string() }),
    stream: "none",
    requires: ["nginx"],
    readOnly: false,
    summary: "Render and enable a virtual host.",
  }),
  "site.update": m({
    params: z.object({
      name: z.string().max(128),
      server_names: z.array(z.string()).optional(),
      webroot: absolutePath.optional(),
      runtime_version: z.string().max(32).optional(),
      upstream: z.string().max(256).optional(),
      force_https: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }),
    result: z.object({ config_path: z.string() }),
    stream: "none",
    requires: ["nginx"],
    readOnly: false,
    summary: "Update a virtual host.",
  }),
  "site.remove": m({
    params: z.object({ name: z.string().max(128), delete_webroot: z.boolean().default(false) }),
    result: ok,
    stream: "none",
    requires: ["nginx"],
    readOnly: false,
    summary: "Remove a virtual host.",
  }),
  "site.test_config": m({
    params: empty,
    result: z.object({ valid: z.boolean(), output: z.string() }),
    stream: "none",
    requires: ["nginx"],
    readOnly: true,
    summary: "Validate the web server configuration.",
  }),
  "site.reload": m({
    params: empty,
    result: ok,
    stream: "none",
    requires: ["nginx"],
    readOnly: false,
    summary: "Reload the web server.",
  }),

  /* ---------------------------- certificates -------------------------- */
  "cert.list": m({
    params: empty,
    result: z.object({
      certificates: z.array(
        z.object({
          subject: z.string(),
          sans: z.array(z.string()),
          issuer: z.string(),
          not_before: z.string(),
          not_after: z.string(),
          path: z.string(),
          key_type: z.string(),
        }),
      ),
    }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Installed certificates.",
  }),
  "cert.issue": m({
    params: z.object({
      domains: z.array(z.string()).min(1).max(100),
      challenge: z.enum(["http-01", "dns-01"]),
      email: z.string().email(),
      webroot: absolutePath.optional(),
      key_type: z.enum(["ecdsa", "rsa"]).default("ecdsa"),
      staging: z.boolean().default(false),
    }),
    result: z.object({
      subject: z.string(),
      sans: z.array(z.string()),
      not_after: z.string(),
      path: z.string(),
    }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Obtain a certificate from the ACME provider.",
  }),
  "cert.renew": m({
    params: z.object({ subject: z.string().max(253), force: z.boolean().default(false) }),
    result: z.object({ not_after: z.string() }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Renew an existing certificate.",
  }),
  "cert.revoke": m({
    params: z.object({
      subject: z.string().max(253),
      reason: z.string().max(64).default("unspecified"),
    }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Revoke a certificate.",
  }),
  "cert.install": m({
    params: z.object({
      subject: z.string().max(253),
      certificate_pem: z.string().max(64 * 1024),
      key_pem: z.string().max(64 * 1024),
      chain_pem: z
        .string()
        .max(64 * 1024)
        .optional(),
    }),
    result: z.object({ path: z.string() }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Install an externally-issued certificate.",
  }),

  /* -------------------------------- dns ------------------------------- */
  "dns.resolve": m({
    params: z.object({
      name: z.string().max(253),
      type: z.string().max(10),
      resolver: z.string().max(64).optional(),
    }),
    result: z.object({ records: z.array(resolvedRecord) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Resolve a record from the host's vantage point.",
  }),

  /* -------------------------------- mail ------------------------------ */
  "mail.mailbox.list": m({
    params: z.object({ domain: z.string().max(253).optional() }),
    result: z.object({
      mailboxes: z.array(
        z.object({
          address: z.string(),
          quota_bytes: z.number().int(),
          used_bytes: z.number().int(),
          active: z.boolean(),
          last_login: z.string().nullable(),
        }),
      ),
    }),
    stream: "none",
    requires: ["mail"],
    readOnly: true,
    summary: "Mailboxes known to the mail stack.",
  }),
  "mail.mailbox.create": m({
    params: z.object({
      address: z.string().email(),
      password: z.string().min(12).max(256),
      quota_bytes: z.number().int().nonnegative().default(0),
      display_name: z.string().max(128).optional(),
    }),
    result: ok,
    stream: "none",
    requires: ["mail"],
    readOnly: false,
    summary: "Create a mailbox.",
  }),
  "mail.mailbox.update": m({
    params: z.object({
      address: z.string().email(),
      quota_bytes: z.number().int().nonnegative().optional(),
      active: z.boolean().optional(),
      display_name: z.string().max(128).optional(),
    }),
    result: ok,
    stream: "none",
    requires: ["mail"],
    readOnly: false,
    summary: "Update a mailbox.",
  }),
  "mail.mailbox.delete": m({
    params: z.object({ address: z.string().email(), delete_maildir: z.boolean().default(false) }),
    result: ok,
    stream: "none",
    requires: ["mail"],
    readOnly: false,
    summary: "Delete a mailbox.",
  }),
  "mail.mailbox.password": m({
    params: z.object({ address: z.string().email(), password: z.string().min(12).max(256) }),
    result: ok,
    stream: "none",
    requires: ["mail"],
    readOnly: false,
    summary: "Set a mailbox password.",
  }),
  "mail.alias.apply": m({
    params: z.object({
      domain: z.string().max(253),
      aliases: z
        .array(z.object({ address: z.string(), destinations: z.array(z.string()).min(1) }))
        .max(2000),
    }),
    result: ok,
    stream: "none",
    requires: ["mail"],
    readOnly: false,
    summary: "Replace the alias map for a domain.",
  }),
  "mail.forwarder.apply": m({
    params: z.object({
      domain: z.string().max(253),
      forwarders: z
        .array(z.object({ source: z.string(), destination: z.string(), keep_copy: z.boolean() }))
        .max(2000),
    }),
    result: ok,
    stream: "none",
    requires: ["mail"],
    readOnly: false,
    summary: "Replace the forwarder map for a domain.",
  }),
  "mail.dkim.read": m({
    params: z.object({ domain: z.string().max(253) }),
    result: dkimKeyInfo,
    stream: "none",
    requires: ["mail"],
    readOnly: true,
    summary: "Read the host's DKIM public key so DNS can be compared against it.",
  }),
  "mail.queue.list": m({
    params: z.object({ limit: z.number().int().min(1).max(1000).default(200) }),
    result: z.object({ entries: z.array(mailQueueEntry) }),
    stream: "none",
    requires: ["mail"],
    readOnly: true,
    summary: "Deferred mail queue.",
  }),
  "mail.logs": m({
    params: z.object({
      lines: z.number().int().min(1).max(10000).default(200),
      follow: z.boolean().default(false),
      query: z.string().max(200).optional(),
    }),
    result: z.object({ records: z.array(logRecord) }),
    stream: "response",
    requires: ["mail"],
    readOnly: true,
    summary: "Mail transport log.",
  }),

  /* ------------------------------ databases ---------------------------- */
  "db.instance.list": m({
    params: empty,
    result: z.object({ instances: z.array(dbInstanceInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Database engines present on the host.",
  }),
  "db.database.list": m({
    params: z.object({ engine: z.enum(["mysql", "mariadb", "postgres"]) }),
    result: z.object({ databases: z.array(dbDatabaseInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Databases in an instance.",
  }),
  "db.database.create": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      name: identifier,
      encoding: z.string().max(32).optional(),
      collation: z.string().max(64).optional(),
      owner: identifier.optional(),
    }),
    result: dbDatabaseInfo,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Create a database.",
  }),
  "db.database.delete": m({
    params: z.object({ engine: z.enum(["mysql", "mariadb", "postgres"]), name: identifier }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Drop a database.",
  }),
  "db.user.list": m({
    params: z.object({ engine: z.enum(["mysql", "mariadb", "postgres"]) }),
    result: z.object({ users: z.array(dbUserInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Database users.",
  }),
  "db.user.create": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      username: identifier,
      password: z.string().min(12).max(256),
      host_pattern: z.string().max(64).default("localhost"),
    }),
    result: dbUserInfo,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Create a database user.",
  }),
  "db.user.update": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      username: identifier,
      host_pattern: z.string().max(64).default("localhost"),
      password: z.string().min(12).max(256).optional(),
      can_login: z.boolean().optional(),
    }),
    result: dbUserInfo,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Update a database user.",
  }),
  "db.user.delete": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      username: identifier,
      host_pattern: z.string().max(64).default("localhost"),
    }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Drop a database user.",
  }),
  "db.grant.apply": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      database: identifier,
      username: identifier,
      host_pattern: z.string().max(64).default("localhost"),
      privileges: z.array(z.string().max(24)).max(32),
    }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Replace a user's grants on one database.",
  }),
  "db.size": m({
    params: z.object({ engine: z.enum(["mysql", "mariadb", "postgres"]), name: identifier }),
    result: z.object({ size_bytes: z.number().int(), table_count: z.number().int() }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Database size.",
  }),
  "db.dump": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      name: identifier,
      destination: absolutePath,
      compress: z.boolean().default(true),
    }),
    result: z.object({ path: z.string(), size_bytes: z.number().int() }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Dump a database to a file on the host.",
  }),
  "db.restore": m({
    params: z.object({
      engine: z.enum(["mysql", "mariadb", "postgres"]),
      name: identifier,
      source: absolutePath,
      drop_existing: z.boolean().default(false),
    }),
    result: ok,
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Restore a database from a dump.",
  }),

  /* ------------------------------ firewall ----------------------------- */
  "fw.status": m({
    params: empty,
    result: z.object({
      backend: z.string(),
      enabled: z.boolean(),
      default_inbound: z.string(),
      default_outbound: z.string(),
      rule_count: z.number().int(),
    }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Firewall backend and defaults.",
  }),
  "fw.list": m({
    params: empty,
    result: z.object({ rules: z.array(firewallRuleInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Active firewall rules.",
  }),
  "fw.apply": m({
    params: z.object({
      default_inbound: z.enum(["allow", "deny"]).default("deny"),
      default_outbound: z.enum(["allow", "deny"]).default("allow"),
      rules: z
        .array(
          z.object({
            priority: z.number().int(),
            action: z.enum(["allow", "deny", "reject"]),
            direction: z.enum(["inbound", "outbound"]),
            protocol: z.enum(["tcp", "udp", "icmp", "any"]),
            port_spec: z.string().max(64).nullable(),
            source: z.string().max(64).nullable(),
            destination: z.string().max(64).nullable(),
            comment: z.string().max(200).nullable(),
          }),
        )
        .max(1000),
      /** Apply, then revert unless confirmed within N seconds. Stops lockouts. */
      rollback_seconds: z.number().int().min(0).max(300).default(60),
    }),
    result: z.object({ applied: z.number().int(), rollback_token: z.string().nullable() }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Replace the firewall rule set with a lockout-safe rollback window.",
  }),
  "fw.confirm": m({
    params: z.object({ rollback_token: z.string().max(128) }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Confirm a rule set before its rollback window expires.",
  }),
  "fw.ban": m({
    params: z.object({
      target: cidr.or(ipAddress),
      duration_seconds: z.number().int().min(0).max(31536000).default(0),
      reason: z.string().max(200).optional(),
    }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Block an address or range.",
  }),
  "fw.unban": m({
    params: z.object({ target: cidr.or(ipAddress) }),
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Unblock an address or range.",
  }),
  "fw.bans.list": m({
    params: empty,
    result: z.object({ bans: z.array(banEntry) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Currently blocked addresses.",
  }),
  "fw.threats": m({
    params: z.object({
      since: z.string().optional(),
      limit: z.number().int().min(1).max(2000).default(500),
    }),
    result: z.object({ observations: z.array(threatObservation) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Recent intrusion observations.",
  }),

  /* --------------------------------- ssh ------------------------------- */
  "ssh.keys.list": m({
    params: z.object({ user: identifier.optional() }),
    result: z.object({ keys: z.array(sshKeyInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Authorized keys on the host.",
  }),
  "ssh.keys.apply": m({
    params: z.object({
      user: identifier,
      keys: z
        .array(z.object({ public_key: z.string().max(4096), comment: z.string().max(200) }))
        .max(200),
    }),
    result: z.object({ applied: z.number().int() }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Replace a user's authorized_keys.",
  }),
  "ssh.config.read": m({
    params: empty,
    result: sshConfigInfo,
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Effective sshd configuration.",
  }),
  "ssh.config.apply": m({
    params: sshConfigInfo
      .partial()
      .extend({ rollback_seconds: z.number().int().min(0).max(300).default(60) }),
    result: z.object({ rollback_token: z.string().nullable() }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Apply sshd configuration with a rollback window.",
  }),
  "ssh.sessions.list": m({
    params: empty,
    result: z.object({ sessions: z.array(sshSessionInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Active SSH sessions.",
  }),

  /* ------------------------------- backups ----------------------------- */
  "backup.run": m({
    params: z.object({
      repository: z.string().max(512),
      password_ref: z.string().max(128),
      paths: z.array(absolutePath).max(200),
      exclude: z.array(z.string().max(256)).max(200).default([]),
      tags: z.array(z.string().max(64)).max(20).default([]),
      databases: z
        .array(z.object({ engine: z.string(), name: z.string() }))
        .max(200)
        .default([]),
    }),
    result: backupSnapshotInfo,
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Run a backup into a repository.",
  }),
  "backup.list": m({
    params: z.object({ repository: z.string().max(512), password_ref: z.string().max(128) }),
    result: z.object({ snapshots: z.array(backupSnapshotInfo) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Snapshots in a repository.",
  }),
  "backup.restore": m({
    params: z.object({
      repository: z.string().max(512),
      password_ref: z.string().max(128),
      snapshot_id: z.string().max(128),
      target: absolutePath,
      include: z.array(z.string().max(512)).max(500).default([]),
      overwrite: z.boolean().default(false),
    }),
    result: z.object({ restored_files: z.number().int(), bytes: z.number().int() }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Restore from a snapshot.",
  }),
  "backup.verify": m({
    params: z.object({
      repository: z.string().max(512),
      password_ref: z.string().max(128),
      snapshot_id: z.string().max(128),
    }),
    result: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
    stream: "response",
    requires: [],
    readOnly: true,
    summary: "Verify snapshot integrity.",
  }),
  "backup.prune": m({
    params: z.object({
      repository: z.string().max(512),
      password_ref: z.string().max(128),
      keep_last: z.number().int().min(0).default(0),
      keep_daily: z.number().int().min(0).default(0),
      keep_weekly: z.number().int().min(0).default(0),
      keep_monthly: z.number().int().min(0).default(0),
    }),
    result: z.object({ removed: z.number().int(), reclaimed_bytes: z.number().int() }),
    stream: "response",
    requires: [],
    readOnly: false,
    summary: "Apply a retention policy.",
  }),

  /* --------------------------------- logs ------------------------------ */
  "log.sources": m({
    params: empty,
    result: z.object({ sources: z.array(logSource) }),
    stream: "none",
    requires: [],
    readOnly: true,
    summary: "Log streams available on the host.",
  }),
  "log.tail": m({
    params: z.object({
      source: z.string().max(256),
      lines: z.number().int().min(1).max(10000).default(200),
      follow: z.boolean().default(true),
      level: z.string().max(16).optional(),
      query: z.string().max(200).optional(),
      since: z.string().optional(),
    }),
    result: z.object({ records: z.array(logRecord) }),
    stream: "response",
    requires: [],
    readOnly: true,
    summary: "Tail a log source with server-side filtering.",
  }),

  /* --------------------------------- pty ------------------------------- */
  "pty.open": m({
    params: ptyOpenParams,
    result: z.object({ pid: z.number().int() }),
    stream: "bidirectional",
    requires: [],
    readOnly: false,
    summary: "Open an interactive shell. Recorded and audited.",
  }),
  "pty.resize": m({
    params: ptyResizeParams,
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Resize an open PTY.",
  }),
  "pty.close": m({
    params: empty,
    result: ok,
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Close an open PTY.",
  }),
} as const satisfies Record<string, MethodSpec>;

export type AgentMethod = keyof typeof AGENT_METHODS;
export const AGENT_METHOD_NAMES = Object.keys(AGENT_METHODS) as AgentMethod[];

export type MethodParams<M extends AgentMethod> = z.infer<(typeof AGENT_METHODS)[M]["params"]>;
export type MethodResult<M extends AgentMethod> = z.infer<(typeof AGENT_METHODS)[M]["result"]>;

export function isAgentMethod(name: string): name is AgentMethod {
  return Object.prototype.hasOwnProperty.call(AGENT_METHODS, name);
}

/** Methods safe to call synchronously from a request handler (see KD-008). */
export const READ_ONLY_METHODS = AGENT_METHOD_NAMES.filter((n) => AGENT_METHODS[n].readOnly);
