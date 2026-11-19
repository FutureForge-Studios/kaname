import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments, type Document } from "yaml";
import { MANAGED_APPS_ROOT, containerImageRef, managedContainerSpec, type ManagedContainerSpec } from "../agent/methods.js";
import type { AppRecipe, AppSource } from "./apps.js";

/* ------------------------------------------------------------------ *
 * Docker Compose import (KD-045).
 *
 * A compose file is translated, never run: each service becomes one
 * closed `ManagedContainerSpec`, the same shape catalog apps send, and
 * anything a spec cannot say (privileged mode, host paths, host
 * namespaces, image builds) is refused with the line it is on. The web
 * dialog runs this for a live preview; the control plane runs it again
 * as the gate; the agent re-checks every spec it is sent.
 *
 * Environment values, interpolation defaults and command arguments never
 * appear in an issue message: they are often passwords, and messages are
 * shown, logged and returned in errors.
 * ------------------------------------------------------------------ */

export interface ComposeIssue {
  line: number | null;
  service: string | null;
  message: string;
}

export interface ComposeService {
  /** = the agent role, so it must match ^[a-z][a-z0-9]{0,15}$. */
  name: string;
  image: string;
  environment: Record<string, string>;
  /** Named volumes only. */
  volumes: { name: string; target: string; read_only: boolean }[];
  /** Agent argument tokens. */
  command: string[];
  /** Container ports from `ports` / `expose`, for the web picker. */
  ports: number[];
}

export interface ComposeTranslation {
  /** In start order: every service after what it depends on. */
  services: ComposeService[];
  web: { service: string; port: number } | null;
  refused: ComposeIssue[];
  notices: ComposeIssue[];
}

export const COMPOSE_APP_ID = "docker-compose";
export const COMPOSE_MAX_BYTES = 64 * 1024;
export const COMPOSE_MAX_SERVICES = 12;

const ROLE = /^[a-z][a-z0-9]{0,15}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ARG = /^[A-Za-z0-9_][A-Za-z0-9._:=+-]{0,127}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Placeholder install id for checking specs before an install exists. */
const PREVIEW_INSTALL = "00000000-0000-4000-8000-000000000000";

const IGNORED: Record<string, string> = {
  restart: "containers always restart unless stopped",
  container_name: "Kaname names containers after the project and service",
  healthcheck: "start order isn't health-gated",
  labels: "Kaname sets its own labels",
  logging: "logs use Kaname's fixed, size-capped settings",
  stop_grace_period: "Kaname's default stop timeout applies",
  hostname: "services reach each other by service name",
  networks: "every service joins the project's private network",
  mem_limit: "resource limits aren't applied yet",
  cpus: "resource limits aren't applied yet",
  deploy: "resource limits and replicas aren't applied yet",
  ulimits: "the agent sets limits itself",
};

const REFUSED: Record<string, string> = {
  build: "images can't be built yet; push the image to a registry and use `image:`",
  privileged: "privileged containers are never allowed",
  cap_add: "extra kernel capabilities are never allowed",
  cap_drop: "capability changes can't be expressed",
  devices: "host devices are never passed to a container",
  device_cgroup_rules: "host devices are never passed to a container",
  network_mode: "every service runs on the project's private network",
  pid: "host namespaces are never shared",
  ipc: "host namespaces are never shared",
  uts: "host namespaces are never shared",
  userns_mode: "host namespaces are never shared",
  cgroup_parent: "containers run in Kaname's own cgroup setup",
  security_opt: "security options are fixed by Kaname",
  sysctls: "kernel settings can't be changed from a container",
  volumes_from: "share a named volume instead",
  entrypoint: "the image's entrypoint can't be replaced; use `command` for its arguments",
  user: "the image's own user is used",
  env_file: "put the variables under `environment`",
  extends: "copy the settings into the service",
  working_dir: "the image's working directory is used",
  tmpfs: "use a named volume",
  shm_size: "it can't be changed yet",
  extra_hosts: "services resolve each other on the private network",
  dns: "services resolve each other on the private network",
  links: "services reach each other by name on the private network",
  external_links: "services reach each other by name on the private network",
  secrets: "put the value under `environment`; Kaname keeps it encrypted",
  configs: "put the value under `environment`",
};

const MAPPED = new Set(["image", "environment", "volumes", "depends_on", "command", "ports", "expose", "profiles"]);

type Path = (string | number)[];
type Obj = Record<string, unknown>;

/** Refusals past this many are summed up in one line, so errors and the preview stay small. */
export const COMPOSE_MAX_ISSUES = 50;
/** The agent's limits, in bytes (zod counts UTF-16 units). */
const MAX_VALUE_BYTES = 4096;

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isEmpty = (v: unknown) =>
  v === null || v === false || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

/** A scalar as compose reads it; undefined for a list or map. */
function scalar(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * `$$` → `$`, `${X:-d}` / `${X-d}` → d; anything that needs a value from
 * outside is reported by name, and a malformed or nested `${` with null.
 * Defaults can't hold `{`, `}` or `$`, which keeps the scan linear.
 */
export function interpolate(raw: string, missing: (name: string | null) => void): string {
  return raw.replace(/\$\$|\$\{([^{}$]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\{/g, (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    if (braced === undefined && bare === undefined) {
      missing(null);
      return "";
    }
    const inner = braced ?? bare ?? "";
    const parts = /^([A-Za-z_][A-Za-z0-9_]*)(:?-)([\s\S]*)$/.exec(inner);
    if (parts) return parts[3]!;
    missing(/^[A-Za-z_][A-Za-z0-9_]*/.exec(inner)?.[0] ?? null);
    return "";
  });
}

/** Where a named volume of an install lives on the host. */
export function composeVolumePath(installId: string, name: string): string {
  return `${MANAGED_APPS_ROOT}/${installId}/volumes/${name}`;
}

/** The one spec a compose service becomes. Shared by the preview check and the install job. */
export function composeContainerSpec(
  installId: string,
  service: Pick<ComposeService, "name" | "image" | "volumes" | "command">,
  env: Record<string, string>,
  port: { container_port: number; host_port: number } | null,
): ManagedContainerSpec {
  return {
    install_id: installId,
    role: service.name,
    image: service.image,
    env,
    mounts: service.volumes.map((v) => ({
      source: composeVolumePath(installId, v.name),
      target: v.target,
      read_only: v.read_only,
    })),
    ports: port ? [port] : [],
    args: service.command,
    files: [],
    replace: true,
  };
}

/** A port entry's container port, from `ports` (short or long form) or `expose`. Errors never quote the entry. */
function parsePort(entry: unknown): { port: number | null; udp: boolean; error: string | null } {
  let target: string | null | undefined;
  let udp = false;
  if (isObj(entry)) {
    target = scalar(entry.target);
    udp = String(entry.protocol ?? "tcp").toLowerCase() === "udp";
    if (target == null || !/^\d+$/.test(target)) return { port: null, udp, error: "a long-form port needs a numeric `target`" };
  } else {
    const text = scalar(entry);
    if (text == null) return { port: null, udp, error: "a port must be a number or a string" };
    udp = /\/udp$/i.test(text);
    const parts = text.replace(/\/(tcp|udp)$/i, "").split(":");
    // shortcut: an IPv6 host IP ([::1]:80:80) splits into extra segments and is refused; strip [..] if files need it.
    if (parts.length > 3) return { port: null, udp, error: "a port is at most host_ip:host_port:container_port" };
    target = parts[parts.length - 1]!;
    if (target.includes("-")) return { port: null, udp, error: "port ranges aren't supported" };
  }
  const port = Number(target);
  return /^\d+$/.test(target) && port >= 1 && port <= 65535
    ? { port, udp, error: null }
    : { port: null, udp, error: "the container port must be a number from 1 to 65535" };
}

const isHostPath = (source: string) =>
  /^[/.~]/.test(source) || source.includes("/") || source.includes("\\") || /^[A-Za-z]:/.test(source);

/** Turns a compose file into container specs Kaname can run, or says line by line why not. */
export function translateCompose(
  text: string,
  choice: { web_service?: string; web_port?: number } = {},
): ComposeTranslation {
  const out = translate(text, choice);
  const more = out.refused.length - COMPOSE_MAX_ISSUES;
  if (more > 0) {
    out.refused.splice(COMPOSE_MAX_ISSUES, more, { line: null, service: null, message: `…and ${more} more problems.` });
  }
  return out;
}

function translate(text: string, choice: { web_service?: string; web_port?: number }): ComposeTranslation {
  const refused: ComposeIssue[] = [];
  const notices: ComposeIssue[] = [];
  const out: ComposeTranslation = { services: [], web: null, refused, notices };

  if (bytes(text) > COMPOSE_MAX_BYTES) {
    refused.push({ line: null, service: null, message: "The file is larger than 64 KiB." });
    return out;
  }
  const counter = new LineCounter();
  const docs = parseAllDocuments(text, { lineCounter: counter, merge: true, prettyErrors: false });
  if (!Array.isArray(docs) || docs.length === 0) {
    refused.push({ line: null, service: null, message: "The file is empty." });
    return out;
  }
  if (docs.length > 1) {
    const second = docs[1]!.range[0];
    refused.push({ line: counter.linePos(second).line, service: null, message: "Only one YAML document is allowed; remove the `---` separator." });
    return out;
  }
  const doc = docs[0] as Document;
  for (const err of doc.errors) {
    refused.push({ line: counter.linePos(err.pos[0]).line, service: null, message: `YAML error: ${err.message}` });
  }
  if (refused.length > 0) return out;

  let root: unknown;
  try {
    root = doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    refused.push({ line: null, service: null, message: `YAML error: ${err instanceof Error ? err.message : String(err)}` });
    return out;
  }

  /** Each YAML map's pairs by key, indexed once, so finding a line doesn't rescan the map. */
  const indexed = new WeakMap<object, Map<string, { key: unknown; value: unknown }>>();
  const pairAt = (map: { items: { key: unknown; value: unknown }[] }, key: string) => {
    let byKey = indexed.get(map);
    if (!byKey) {
      byKey = new Map();
      for (const p of map.items) {
        const k = String(isScalar(p.key) ? p.key.value : p.key);
        if (!byKey.has(k)) byKey.set(k, p);
      }
      indexed.set(map, byKey);
    }
    return byKey.get(key);
  };
  /** The line of the deepest node the path reaches (aliases and merges stop at their key). */
  const lineAt = (path: Path): number | null => {
    let node: unknown = doc.contents;
    let line: number | null = null;
    for (const key of path) {
      let next: { at: unknown; value: unknown } | undefined;
      if (isMap(node)) {
        const pair = pairAt(node, String(key));
        next = pair && { at: pair.key, value: pair.value };
      } else if (isSeq(node) && typeof key === "number") {
        const item = node.items[key];
        next = item === undefined ? undefined : { at: item, value: item };
      }
      if (!next) break;
      const range = (next.at as { range?: [number, number, number] } | null)?.range;
      if (range) line = counter.linePos(range[0]).line;
      node = next.value;
    }
    return line;
  };
  // Past the cap the issue is only counted, so its line isn't looked up.
  const refuse = (path: Path, service: string | null, message: string) =>
    refused.push({ line: refused.length < COMPOSE_MAX_ISSUES ? lineAt(path) : null, service, message });
  const notice = (path: Path, service: string | null, message: string) =>
    notices.push({ line: lineAt(path), service, message });

  if (!isObj(root)) {
    refuse([], null, "The file must be a map with a `services:` key.");
    return out;
  }

  /* ---------------------------- top level ---------------------------- */
  for (const [key, value] of Object.entries(root)) {
    if (key === "version" || key === "name" || key.startsWith("x-") || key === "services") continue;
    if (key === "volumes" && (value === null || isObj(value))) {
      for (const [name, def] of Object.entries(value ?? {})) {
        if (isEmpty(def)) continue;
        for (const field of isObj(def) ? Object.keys(def) : ["value"]) {
          refuse(["volumes", name, field], null, `Volume ${name}: \`${field}\` isn't supported; volumes are folders in the project's directory on the server.`);
        }
      }
      continue;
    }
    if (key === "networks" && (value === null || isObj(value))) {
      let ignored = false;
      for (const [name, def] of Object.entries(value ?? {})) {
        if (isEmpty(def)) ignored = true;
        else refuse(["networks", name], null, `Network ${name}: external networks and network drivers aren't supported; every service joins the project's own private network.`);
      }
      if (ignored) notice(["networks"], null, "Networks are ignored: every service joins the project's own private network.");
      continue;
    }
    refuse([key], null, `\`${key}\` isn't supported.`);
  }

  const servicesValue = root.services;
  if (!isObj(servicesValue) || Object.keys(servicesValue).length === 0) {
    refuse(["services"], null, "The file needs a `services:` map with at least one service.");
    return out;
  }
  const entries = Object.entries(servicesValue);
  if (entries.length > COMPOSE_MAX_SERVICES) {
    refuse(["services"], null, `At most ${COMPOSE_MAX_SERVICES} services are supported; this file has ${entries.length}.`);
    return out;
  }

  /* ----------------------------- services ---------------------------- */
  const parsed: ComposeService[] = [];
  const dependsOn = new Map<string, { names: string[]; path: Path }>();
  let conditionNoticed = false;
  let portsNoticed = false;
  let udpNoticed = false;

  for (const [name, def] of entries) {
    const at = (...rest: Path): Path => ["services", name, ...rest];
    if (!ROLE.test(name)) {
      refuse(at(), name, `Rename service \`${name}\` to lowercase letters and digits, starting with a letter (at most 16).`);
      continue;
    }
    if (!isObj(def)) {
      refuse(at(), name, `Service ${name} must be a map.`);
      continue;
    }
    if (def.profiles !== undefined && !isEmpty(def.profiles)) {
      notice(at("profiles"), name, `${name} is skipped: it belongs to a profile, which Compose only starts when asked.`);
      continue;
    }

    // Messages name variables, never values or defaults: those are often passwords.
    const missing = (path: Path) => (variable: string | null) =>
      refuse(path, name, variable
        ? `Set a value for ${variable}: Kaname doesn't read variables from a .env file or the shell.`
        : "Only `${NAME}`, `${NAME:-default}` and `$$` are supported here; nested or unclosed `${` isn't.");
    const service: ComposeService = { name, image: "", environment: {}, volumes: [], command: [], ports: [] };

    for (const [key, value] of Object.entries(def)) {
      if (MAPPED.has(key)) continue;
      if (Object.hasOwn(IGNORED, key)) notice(at(key), name, `\`${key}\` is ignored: ${IGNORED[key]}.`);
      else if (Object.hasOwn(REFUSED, key)) {
        if (!isEmpty(value)) refuse(at(key), name, `\`${key}\` isn't allowed: ${REFUSED[key]}.`);
      } else refuse(at(key), name, `\`${key}\` isn't supported.`);
    }

    /* image (stored as written; shown only if no interpolation shaped it) */
    const rawImage = scalar(def.image);
    if (!rawImage) {
      refuse(at(def.build !== undefined ? "build" : "image"), name, `${name} needs an \`image:\`.`);
    } else {
      const image = interpolate(rawImage, missing(at("image")));
      const shown = rawImage.includes("$") ? "the image" : image;
      const lastPart = image.split("/").pop() ?? "";
      if (!lastPart.includes(":") && !image.includes("@")) {
        refuse(at("image"), name, `Pin a tag for ${shown}, e.g. postgres:16; an untagged image could change under you.`);
      } else if (!containerImageRef.safeParse(image).success) {
        refuse(at("image"), name, `${shown} isn't a valid image reference (lowercase name, then :tag or @sha256:digest).`);
      } else service.image = image;
    }

    /* environment */
    const env = def.environment;
    /** `label` names the entry when its name can't be shown (it may be a value). */
    const setEnv = (key: string, raw: string | null | undefined, path: Path, label: string) => {
      if (!ENV_NAME.test(key)) return refuse(path, name, `${label} isn't a valid variable name.`);
      if (key === "__proto__") return refuse(path, name, "`__proto__` can't be used as a variable name.");
      if (raw === undefined) return refuse(path, name, `${key} must be a single value.`);
      if (raw === null) return missing(path)(key);
      const value = interpolate(raw, missing(path));
      if (bytes(value) > MAX_VALUE_BYTES || value.includes("\0")) {
        return refuse(path, name, `${key} must be at most ${MAX_VALUE_BYTES} bytes, with no NUL character.`);
      }
      service.environment[key] = value;
    };
    if (Array.isArray(env)) {
      env.forEach((item, i) => {
        const text = scalar(item);
        const eq = text == null ? -1 : text.indexOf("=");
        if (text == null || eq < 0) return refuse(at("environment", i), name, `Environment entry ${i + 1} isn't KEY=value.`);
        setEnv(text.slice(0, eq), text.slice(eq + 1), at("environment", i), `Environment entry ${i + 1}`);
      });
    } else if (isObj(env)) {
      for (const [key, value] of Object.entries(env)) setEnv(key, scalar(value), at("environment", key), `\`${key}\``);
    } else if (env !== undefined && env !== null) {
      refuse(at("environment"), name, "`environment` must be a map or a list of KEY=value.");
    }
    if (Object.keys(service.environment).length > 64) {
      refuse(at("environment"), name, `${name} sets more than 64 environment variables.`);
    }

    /* volumes */
    /** `echo` is false when interpolation shaped the text: a default could be a secret. */
    const addVolume = (source: string, target: string, readOnly: boolean, echo: boolean, path: Path) => {
      if (isHostPath(source)) return refuse(path, name, `${echo ? source : "The source"} is a host path; only named volumes are allowed.`);
      if (!VOLUME_NAME.test(source)) return refuse(path, name, `${echo ? `\`${source}\`` : "The source"} isn't a valid volume name.`);
      if (bytes(target) > MAX_VALUE_BYTES) return refuse(path, name, `The mount target is longer than ${MAX_VALUE_BYTES} bytes.`);
      if (!target.startsWith("/") || target.split("/").includes("..") || target.includes("\0")) {
        return refuse(path, name, `The mount target${echo ? ` \`${target}\`` : ""} must be an absolute path inside the container.`);
      }
      // As the agent cleans it: no empty or `.` segments, no trailing slash.
      const clean = `/${target.split("/").filter((s) => s !== "" && s !== ".").join("/")}`;
      if (clean === "/") return refuse(path, name, "A volume can't be mounted on the container's root `/`.");
      if (service.volumes.some((v) => v.target === clean)) {
        return refuse(path, name, `${echo ? clean : "This target"} is mounted twice in ${name}.`);
      }
      service.volumes.push({ name: source, target: clean, read_only: readOnly });
    };
    const volumes = def.volumes;
    if (Array.isArray(volumes)) {
      volumes.forEach((item, i) => {
        const path = at("volumes", i);
        if (isObj(item)) {
          const type = item.type ?? "volume";
          if (type === "bind") {
            const shown = typeof item.source === "string" && !item.source.includes("$") ? item.source : "A bind mount";
            return refuse(path, name, `${shown} is a host path; only named volumes are allowed.`);
          }
          if (type !== "volume") return refuse(path, name, `\`type: ${String(type)}\` mounts aren't supported; only named volumes are allowed.`);
          for (const key of Object.keys(item)) {
            if (!["type", "source", "target", "read_only"].includes(key)) refuse(path, name, `Volume option \`${key}\` isn't supported.`);
          }
          const source = scalar(item.source);
          const target = scalar(item.target);
          if (!source) return refuse(path, name, "Anonymous volumes aren't supported; give the volume a name.");
          if (!target) return refuse(path, name, "The volume needs a `target`.");
          const ro = item.read_only;
          if (ro !== undefined && ro !== null && ![true, false, "true", "false"].includes(ro as boolean | string)) {
            return refuse(path, name, "`read_only` must be true or false.");
          }
          const echo = !`${source}${target}`.includes("$");
          return addVolume(interpolate(source, missing(path)), interpolate(target, missing(path)), ro === true || ro === "true", echo, path);
        }
        const text = scalar(item);
        if (text == null) return refuse(path, name, "Each volume must be name:/path or a long-form map.");
        const spec = interpolate(text, missing(path));
        const echo = !text.includes("$");
        // `C:/host:/target` is a Windows path; `d:/data` is volume `d`, as Compose on Linux reads it.
        if (/^[A-Za-z]:[\\/][^:]*:/.test(spec)) {
          return refuse(path, name, `${echo ? spec.split(":").slice(0, 2).join(":") : "The source"} is a host path; only named volumes are allowed.`);
        }
        const [source = "", target, mode, ...rest] = spec.split(":");
        if (target === undefined) {
          return isHostPath(source) && !source.startsWith("/")
            ? refuse(path, name, `${echo ? source : "The source"} is a host path; only named volumes are allowed.`)
            : refuse(path, name, `Anonymous volumes aren't supported; name it${echo ? `, e.g. data:${source}` : ""}.`);
        }
        const modes = (mode ?? "rw").split(",");
        const bad = [...modes.filter((m) => m !== "ro" && m !== "rw"), ...rest];
        if (bad.length > 0 && !isHostPath(source)) {
          return refuse(path, name, echo ? `Volume option \`${bad.join(",")}\` isn't supported.` : "Only the ro and rw volume options are supported.");
        }
        addVolume(source, target, modes.includes("ro"), echo, path);
      });
    } else if (volumes !== undefined && volumes !== null) {
      refuse(at("volumes"), name, "`volumes` must be a list.");
    }
    if (service.volumes.length > 8) refuse(at("volumes"), name, `${name} mounts more than 8 volumes.`);

    /* command (stored as written: arguments aren't sealed, so they're never echoed either) */
    const command = def.command;
    const tokens: { token: string; path: Path }[] = [];
    if (Array.isArray(command)) {
      command.forEach((item, i) => {
        const text = scalar(item);
        if (text == null) refuse(at("command", i), name, `Command argument ${i + 1} must be a single value.`);
        else tokens.push({ token: interpolate(text, missing(at("command", i))), path: at("command", i) });
      });
    } else if (typeof command === "string") {
      for (const token of interpolate(command, missing(at("command"))).split(/\s+/).filter(Boolean)) {
        tokens.push({ token, path: at("command") });
      }
    } else if (command !== undefined && command !== null) {
      refuse(at("command"), name, "`command` must be a string or a list.");
    }
    tokens.forEach(({ token, path }, i) => {
      if (ARG.test(token)) service.command.push(token);
      else {
        refuse(path, name, `Command argument ${i + 1} isn't allowed: each argument starts with a letter, digit or underscore and uses only letters, digits and . _ : = + - (no shell, quotes or spaces).`);
      }
    });
    if (service.command.length > 16) refuse(at("command"), name, `${name}'s command has more than 16 arguments.`);

    /* ports and expose */
    for (const key of ["ports", "expose"] as const) {
      const list = def[key];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) {
        refuse(at(key), name, `\`${key}\` must be a list.`);
        continue;
      }
      list.forEach((item, i) => {
        const { port, udp, error } = parsePort(item);
        if (error) refuse(at(key, i), name, `${name}: \`${key}\` entry ${i + 1}: ${error}.`);
        else if (udp) {
          if (!udpNoticed) notice(at(key, i), name, "UDP ports aren't published or proxied; services reach each other on the project's private network only.");
          udpNoticed = true;
        } else if (port !== null && !service.ports.includes(port)) service.ports.push(port);
      });
      if (key === "ports" && list.length > 0 && !portsNoticed) {
        portsNoticed = true;
        notice(at(key), name, "Host ports aren't published: the website is served on its domain over HTTPS, and other services are reachable only by service name on the project's private network.");
      }
    }

    /* depends_on */
    const deps = def.depends_on;
    if (Array.isArray(deps)) {
      dependsOn.set(name, { names: deps.map((d) => String(d)), path: at("depends_on") });
    } else if (isObj(deps)) {
      dependsOn.set(name, { names: Object.keys(deps), path: at("depends_on") });
      if (!conditionNoticed && Object.values(deps).some((d) => isObj(d) && d.condition !== undefined)) {
        conditionNoticed = true;
        notice(at("depends_on"), name, "depends_on conditions are ignored: services start in dependency order without waiting for health, and a container that fails restarts.");
      }
    } else if (deps !== undefined && deps !== null) {
      refuse(at("depends_on"), name, "`depends_on` must be a list or a map.");
    }

    if (service.image) parsed.push(service);
  }

  if (parsed.some((s) => s.volumes.length > 0)) {
    notices.push({
      line: null,
      service: null,
      message: "Volumes start empty and owned by root. An image that runs as another user and doesn't set up its own data folder may fail to write to it.",
    });
  }

  /* ---------------------------- start order -------------------------- */
  const known = new Set(entries.map(([n]) => n));
  for (const [name, { names, path }] of dependsOn) {
    for (const dep of names) {
      if (!known.has(dep)) refuse(path, name, `${name} depends on \`${dep}\`, which isn't a service in this file.`);
      else if (!parsed.some((s) => s.name === dep) && !refused.some((r) => r.service === dep)) {
        refuse(path, name, `${name} depends on ${dep}, which is skipped.`);
      }
    }
  }
  const ordered: ComposeService[] = [];
  const pending = [...parsed];
  while (pending.length > 0) {
    const index = pending.findIndex((s) =>
      (dependsOn.get(s.name)?.names ?? []).every((d) => ordered.some((o) => o.name === d) || !pending.some((p) => p.name === d)),
    );
    if (index < 0) {
      const names = pending.map((s) => s.name).join(", ");
      refuse(dependsOn.get(pending[0]!.name)?.path ?? ["services"], pending[0]!.name, `depends_on forms a cycle between ${names}.`);
      ordered.push(...pending);
      break;
    }
    ordered.push(...pending.splice(index, 1));
  }
  out.services = ordered;

  /* ------------------------------ web entry -------------------------- */
  const withPorts = ordered.filter((s) => s.ports.length > 0);
  const web =
    choice.web_service !== undefined
      ? ordered.find((s) => s.name === choice.web_service)
      : withPorts.length === 1 ? withPorts[0] : undefined;
  const webPort = choice.web_port;
  if (choice.web_service !== undefined && !web) {
    refuse(["services"], null, `There is no service named \`${choice.web_service}\` to serve the website.`);
  } else if (!web) {
    notice(["services"], null, withPorts.length === 0
      ? "No service lists a port. Choose the service and port that serve the website."
      : "Several services list ports. Choose the one that serves the website.");
  } else if (webPort !== undefined) {
    if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) {
      refuse(["services", web.name], web.name, "The website's port must be a number from 1 to 65535.");
    } else if (web.ports.length > 0 && !web.ports.includes(webPort)) {
      refuse(["services", web.name], web.name, `${web.name} doesn't list port ${webPort}; choose one of ${web.ports.join(", ")}.`);
    } else out.web = { service: web.name, port: webPort };
  } else if (web.ports.length > 0) {
    out.web = { service: web.name, port: web.ports[0]! };
  } else {
    notice(["services", web.name], web.name, `Choose the port ${web.name} listens on.`);
  }

  /* ----------------- the agent's own rules, checked early ------------- */
  for (const service of ordered) {
    const port = out.web?.service === service.name ? { container_port: out.web.port, host_port: 20000 } : null;
    const check = managedContainerSpec.safeParse(composeContainerSpec(PREVIEW_INSTALL, service, service.environment, port));
    if (!check.success) {
      for (const issue of check.error.issues) {
        refuse(["services", service.name], service.name, `${issue.path.join(".") || "spec"}: ${issue.message}`);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The recipe an install keeps: the translation without its values.
 * ------------------------------------------------------------------ */

export type ComposeSource = Extract<AppSource, { kind: "compose" }>;

/** What is stored on the install row: everything but environment values. */
export function composeSource(t: ComposeTranslation): ComposeSource {
  if (!t.web) throw new Error("a compose install needs a web entry");
  return {
    kind: "compose",
    services: t.services.map((s) => ({
      name: s.name,
      image: s.image,
      env_keys: Object.keys(s.environment),
      volumes: s.volumes,
      command: s.command,
    })),
    web: t.web,
  };
}

/** Environment values per service, sealed apart from the recipe. */
export function composeEnvironment(t: ComposeTranslation): Record<string, Record<string, string>> {
  return Object.fromEntries(t.services.map((s) => [s.name, s.environment]));
}

/** A compose project as a recipe, so the installer's steps, job and views handle it like any app. */
export function composeRecipe(source: ComposeSource): AppRecipe {
  return {
    id: COMPOSE_APP_ID,
    name: "Docker Compose",
    tagline: "A project imported from a docker-compose file.",
    description: "Services from a compose file, each a managed container on the project's private network.",
    category: "developer",
    version: "compose",
    homepage: "https://docs.docker.com/compose/",
    license: "n/a",
    availability: "available",
    unavailable_reason: null,
    requirements: {
      runtime: "container",
      runtime_version: null,
      capabilities: ["nginx", "docker"],
      database: null,
      min_memory_mb: 512,
      min_disk_mb: 1024,
    },
    source,
    config: "none",
    writable_paths: [],
    finish: `Open the site to check that ${source.web.service} answers.`,
  };
}
