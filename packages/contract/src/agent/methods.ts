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
  fileEntry,
  firewallRuleInfo,
  imageInfo,
  logRecord,
  logSource,
  mailAliasEntry,
  mailCertificateStatus,
  mailCheck,
  mailDeployResult,
  mailDnsRecord,
  mailDomainEntry,
  mailServerStatusInfo,
  mailboxEntry,
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

/* ------------------------- managed containers ------------------------ */

/**
 * Where every managed app container's bind mounts live, one directory per
 * install. Outside the agent's own state directory on purpose: that one
 * holds the enrolled key and is denied to every file verb.
 */
export const MANAGED_APPS_ROOT = "/var/lib/kaname-apps";

/** An install id as the agent names things after it: a UUID in practice. */
export const managedInstallId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * An image reference with an explicit tag or digest. `latest` by omission
 * is refused: what an install runs should be what its recipe says.
 */
export const containerImageRef = z
  .string()
  .max(255)
  .regex(
    /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64}|:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}@sha256:[a-f0-9]{64})$/,
    "must be an image reference with a tag or digest",
  );

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

/**
 * The whole of what can be said about a managed container. There is no
 * field for privileged mode, capabilities, devices, host namespaces,
 * a command, an entrypoint or a host IP: the agent fixes those itself.
 */
export const managedContainerSpec = z
  .object({
    install_id: managedInstallId,
    /** "app", "db": the name suffix and the alias on the install's network. */
    role: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
    image: containerImageRef,
    env: z
      .record(envName, z.string().max(4096).regex(/^[^\0]*$/))
      .refine((env) => Object.keys(env).length <= 64, { message: "at most 64 variables" })
      .default({}),
    mounts: z
      .array(
        z
          .object({
            /** Must lie under MANAGED_APPS_ROOT/<install_id>/; created if missing. */
            source: absolutePath,
            target: absolutePath,
            read_only: z.boolean().default(false),
            /** Hands the directory to the account the image runs as. */
            uid: z.number().int().min(1).max(65534).optional(),
            gid: z.number().int().min(1).max(65534).optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    /** Always published on 127.0.0.1 only. */
    ports: z
      .array(
        z
          .object({
            container_port: z.number().int().min(1).max(65535),
            host_port: z.number().int().min(1024).max(65535),
          })
          .strict(),
      )
      .max(4)
      .default([]),
    memory_bytes: z
      .number()
      .int()
      .min(64 * 1024 * 1024)
      .max(256 * 1024 * 1024 * 1024)
      .optional(),
    cpus: z.number().min(0.1).max(256).optional(),
    /** Remove a managed container of the same install and role first. */
    replace: z.boolean().default(false),
  })
  .strict();
export type ManagedContainerSpec = z.infer<typeof managedContainerSpec>;
const empty = z.object({});
const unit = z.object({ unit: z.string().min(1).max(256) });

/**
 * A transfer credential: the panel's floor, and no line break or NUL,
 * because chpasswd reads `user:password` lines from stdin and a newline
 * would smuggle a second account's password in after the first.
 */
const ftpPassword = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[^\r\n\0]*$/, "may not contain a line break or NUL");

const ftpAccountParams = z.object({
  username: identifier,
  home_dir: absolutePath,
  protocol: z.enum(["sftp", "ftps"]),
  /** 0 clears any quota; above 0 needs a quota-enabled filesystem. */
  quota_bytes: z.number().int().min(0).default(0),
  /** SFTP key authentication; one OpenSSH public key line. */
  ssh_public_key: z.string().max(4096).optional(),
});

const ftpAccountInfo = z.object({
  username: identifier,
  uid: z.number().int(),
  home_dir: z.string(),
  protocol: z.enum(["sftp", "ftps"]),
  suspended: z.boolean(),
  /** "applied": a block limit is set; "unlimited": none is. */
  quota: z.enum(["applied", "unlimited"]),
  /** The mount the limit was set on, when there is one. */
  quota_mount: z.string().nullable(),
  quota_bytes: z.number().int(),
});

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

  /*
   * Managed app containers (KD-040). The installer's only way to create a
   * container, and deliberately not a Docker API passthrough: the spec is
   * a closed shape the agent validates and turns into a create body itself.
   * Everything these verbs make carries Kaname's labels and a name derived
   * from the install id, and the destructive one acts on nothing else.
   */
  "container.image.pull": m({
    params: z.object({ image: containerImageRef }).strict(),
    result: z.object({ image: z.string(), id: z.string() }),
    stream: "response",
    requires: ["docker"],
    readOnly: false,
    summary: "Pull an image by an explicit tag or digest, narrating progress.",
  }),
  "container.network.create": m({
    params: z.object({ install_id: managedInstallId }).strict(),
    result: z.object({ name: z.string(), id: z.string(), created: z.boolean() }),
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Create (or find) an app install's private bridge network.",
  }),
  "container.create": m({
    params: managedContainerSpec,
    result: containerInfo,
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Create and start a managed app container from a closed, guarded spec.",
  }),
  "container.app.status": m({
    params: z.object({ install_id: managedInstallId }).strict(),
    result: z.object({
      containers: z.array(
        z.object({
          role: z.string(),
          name: z.string(),
          state: z.string(),
          status: z.string(),
        }),
      ),
      endpoints: z.array(
        z.object({
          role: z.string(),
          host_port: z.number().int(),
          container_port: z.number().int(),
          /** A TCP connection to 127.0.0.1:host_port succeeded. */
          reachable: z.boolean(),
          /** The status line of a plain GET /, when one came back. */
          http_status: z.number().int().nullable(),
        }),
      ),
    }),
    stream: "none",
    requires: ["docker"],
    readOnly: true,
    summary: "State of an install's managed containers and whether its loopback ports answer.",
  }),
  "container.app.remove": m({
    params: z
      .object({ install_id: managedInstallId, remove_data: z.boolean().default(false) })
      .strict(),
    result: z.object({
      containers: z.array(z.string()),
      networks: z.array(z.string()),
      data_removed: z.boolean(),
    }),
    stream: "none",
    requires: ["docker"],
    readOnly: false,
    summary: "Remove an install's Kaname-labelled containers, network and (optionally) data directory.",
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
  /*
   * Releases. A deployment writes `<root>/releases/<release>` and then
   * swaps `<root>/current` onto it in one rename, so a reader of the
   * site never sees a half-written tree; a rollback is the same swap onto
   * a release that is already there. Neither needs nginx: what serves
   * `current` (a vhost root, an app process) is the site's business.
   */
  "site.release.create": m({
    params: z.object({
      name: z.string().max(128),
      root: absolutePath,
      release: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      source: z.enum(["git", "upload"]),
      repo_url: z.string().max(512).optional(),
      branch: z.string().max(200).optional(),
      commit_sha: z
        .string()
        .regex(/^[0-9a-f]{7,40}$/)
        .optional(),
      /** Where an upload deployment's files are staged; the site's webroot when absent. */
      upload_path: absolutePath.optional(),
      /** Releases kept on disk after this one, newest first; older ones are pruned. */
      keep: z.number().int().min(1).max(50).default(5),
    }),
    result: z.object({
      release_path: z.string(),
      current_path: z.string(),
      commit_sha: z.string().nullable(),
      /** Release directories removed by retention, so the panel can forget them. */
      pruned: z.array(z.string()),
      log: z.array(z.string()),
    }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Write a release directory for a site and switch its current symlink to it.",
  }),
  "site.release.activate": m({
    params: z.object({
      name: z.string().max(128),
      root: absolutePath,
      release_path: absolutePath,
    }),
    result: z.object({
      current_path: z.string(),
      release_path: z.string(),
      previous: z.string().nullable(),
    }),
    stream: "none",
    requires: [],
    readOnly: false,
    summary: "Point a site's current symlink at a release already on disk.",
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
  /*
   * A simulated host has no internet to resolve against: its resolver
   * stands in for public DNS. Without this it served a fixed zone, so a
   * record Kaname told the operator to publish could never be seen and
   * domain verification could only ever fail on the sim. The control
   * plane hands it the zone Kaname manages — what the world would see
   * once those records are published. Gated on `simulated`, so a real
   * host never offers it and its resolver cannot be told what to answer.
   */
  "dns.publish": m({
    params: z.object({
      zone: z.string().max(253),
      records: z
        .array(
          z.object({
            name: z.string().max(253),
            type: z.string().max(10),
            content: z.string().max(4096),
            ttl: z.number().int().min(0).max(604800).optional(),
          }),
        )
        .max(1000),
    }),
    result: ok,
    stream: "none",
    requires: ["simulated"],
    readOnly: false,
    summary: "Simulated hosts only: serve the zone Kaname manages from this host's resolver.",
  }),

  /* -------------------------------- mail ------------------------------ */
  /*
   * Mail is Yunori Mail Server on the host (KD-023). Every verb below is
   * one `yunori-mail` CLI invocation with an argv slice: the one root
   * interface that product sanctions, and the one place its invariants
   * (vault-sealed secrets, audited mutations) are enforced. Nothing here
   * reaches into its database, its vault or Stalwart's API.
   */
  "mail.status": m({
    params: empty,
    result: mailServerStatusInfo,
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "Yunori Mail Server install state, version and services on this host.",
  }),
  "mail.preflight": m({
    params: z.object({ hostname: z.string().max(253).optional() }),
    result: z.object({ checks: z.array(mailCheck) }),
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "Can this server run mail? Changes nothing.",
  }),
  "mail.doctor": m({
    params: empty,
    result: z.object({ checks: z.array(mailCheck) }),
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "End-to-end health of the mail server, with fixes.",
  }),
  "mail.deploy": m({
    params: z.object({
      /** Release to install; the agent verifies the archive's sha256 before anything runs. */
      version: z.string().min(1).max(64),
      url: z.string().url().max(2048),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      domain: z.string().max(253),
      hostname: z.string().max(253),
      /** An address on another provider, for certificates and alerts. */
      admin_email: z.string().email().max(320),
      first_mailbox: identifier.default("hello"),
      sending: z.enum(["direct", "relay"]).default("direct"),
      relay: z
        .object({
          provider: z.string().max(32),
          host: z.string().max(253).optional(),
          region: z.string().max(64).optional(),
          port: z.number().int().min(1).max(65535).default(587),
          username: z.string().max(320).optional(),
          /** Handed to the installer through an environment variable, never argv. */
          password: z.string().max(1024).optional(),
        })
        .optional(),
      /** Continue past blocking preflight failures. */
      force: z.boolean().default(false),
      skip_ptr: z.boolean().default(false),
    }),
    result: mailDeployResult,
    stream: "response",
    requires: ["systemd"],
    readOnly: false,
    summary: "Install Yunori Mail Server: verified download, then the unattended installer.",
  }),
  "mail.update": m({
    params: empty,
    result: ok,
    stream: "response",
    requires: ["yunori"],
    readOnly: false,
    summary: "Update yunori-mail to the newest release (verified download, engine upgrade).",
  }),
  "mail.domain.list": m({
    params: empty,
    result: z.object({ domains: z.array(mailDomainEntry) }),
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "Mail domains on the host.",
  }),
  "mail.domain.add": m({
    params: z.object({ name: z.string().max(253) }),
    result: ok,
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Add a mail domain; DKIM keys are generated by the engine.",
  }),
  "mail.domain.remove": m({
    params: z.object({ name: z.string().max(253) }),
    result: ok,
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Remove a mail domain that has no mailboxes left.",
  }),
  "mail.domain.dns": m({
    params: z.object({ name: z.string().max(253) }),
    result: z.object({ records: z.array(mailDnsRecord), zone_file: z.string() }),
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "Expected vs published DNS records, verified against public resolvers.",
  }),
  "mail.mailbox.list": m({
    params: z.object({ domain: z.string().max(253).optional() }),
    result: z.object({ mailboxes: z.array(mailboxEntry) }),
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "Mailboxes on the host.",
  }),
  "mail.mailbox.add": m({
    params: z.object({
      address: z.string().email(),
      display_name: z.string().max(128).optional(),
      /** Omit for unlimited. */
      quota_mb: z.number().int().positive().optional(),
    }),
    result: z.object({ password: z.string() }),
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Create a mailbox. The host generates its password and returns it once.",
  }),
  "mail.mailbox.passwd": m({
    params: z.object({ address: z.string().email() }),
    result: z.object({ password: z.string() }),
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Set a new generated password on a mailbox and return it once.",
  }),
  "mail.mailbox.remove": m({
    params: z.object({ address: z.string().email() }),
    result: ok,
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Delete a mailbox and all its mail.",
  }),
  "mail.alias.list": m({
    params: z.object({ domain: z.string().max(253).optional() }),
    result: z.object({ aliases: z.array(mailAliasEntry) }),
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "Aliases on the host and the mailbox each delivers to.",
  }),
  "mail.alias.add": m({
    params: z.object({ alias: z.string().email(), mailbox: z.string().email() }),
    result: ok,
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Add an alias delivering to a mailbox.",
  }),
  "mail.alias.remove": m({
    params: z.object({ alias: z.string().email() }),
    result: ok,
    stream: "none",
    requires: ["yunori"],
    readOnly: false,
    summary: "Remove an alias.",
  }),
  "mail.certificate.status": m({
    params: empty,
    result: mailCertificateStatus,
    stream: "none",
    requires: ["yunori"],
    readOnly: true,
    summary: "The mail server's TLS certificate: state, last and next attempt.",
  }),
  "mail.certificate.renew": m({
    params: empty,
    result: z.object({ outcome: z.string() }),
    stream: "response",
    requires: ["yunori"],
    readOnly: false,
    summary: "Ask the certificate authority now.",
  }),
  "mail.logs": m({
    params: z.object({
      lines: z.number().int().min(1).max(10000).default(200),
      follow: z.boolean().default(false),
      query: z.string().max(200).optional(),
    }),
    result: z.object({ records: z.array(logRecord) }),
    stream: "response",
    requires: ["yunori"],
    readOnly: true,
    summary: "The mail engine's and yunori-mail's journal.",
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

  /* --------------------------------- ftp ------------------------------- */
  /*
   * Transfer accounts are real POSIX users: SFTP through sshd's
   * internal-sftp in a chroot, FTPS through vsftpd. Each verb needs the
   * daemon its protocol rides on, so a host with neither answers
   * `unsupported` at the gate instead of failing half-way through
   * useradd. The password travels in params only (the agent hands it to
   * chpasswd on stdin) and no result ever echoes it.
   */
  "ftp.account.create": m({
    params: ftpAccountParams.extend({ password: ftpPassword }),
    result: ftpAccountInfo,
    stream: "none",
    requires: ["sftp", "vsftpd"],
    readOnly: false,
    summary: "Create a transfer account: POSIX user, chroot home, credential and quota.",
  }),
  "ftp.account.update": m({
    params: ftpAccountParams.extend({ suspended: z.boolean().default(false) }),
    result: ftpAccountInfo,
    stream: "none",
    requires: ["sftp", "vsftpd"],
    readOnly: false,
    summary: "Re-apply a transfer account's protocol, home, quota, key and suspension.",
  }),
  "ftp.account.passwd": m({
    params: z.object({ username: identifier, password: ftpPassword }),
    result: ok,
    stream: "none",
    requires: ["sftp", "vsftpd"],
    readOnly: false,
    summary: "Set a transfer account's password (chpasswd over stdin).",
  }),
  "ftp.account.delete": m({
    params: z.object({ username: identifier }),
    result: ok,
    stream: "none",
    requires: ["sftp", "vsftpd"],
    readOnly: false,
    summary: "Remove a transfer account's POSIX user, daemon config and quota; the home stays.",
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
