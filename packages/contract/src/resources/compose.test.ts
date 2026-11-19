import { describe, expect, it } from "vitest";
import { managedContainerSpec } from "../agent/methods.js";
import { appInstallSteps, appSource, installAppInput } from "./apps.js";
import {
  COMPOSE_APP_ID,
  COMPOSE_MAX_ISSUES,
  composeContainerSpec,
  composeRecipe,
  composeSource,
  interpolate,
  translateCompose,
} from "./compose.js";

const APP_AND_DB = `services:
  web:
    image: ghcr.io/example/app:1.4
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD:-s3cret-pass}@db:5432/app
      PRICE: "$$5"
    ports:
      - "8080:3000"
    depends_on:
      db:
        condition: service_healthy
    command: ["serve", "--port=3000"]
  db:
    image: postgres:16
    environment:
      - POSTGRES_PASSWORD=s3cret-pass
      - POSTGRES_DB=app
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
volumes:
  pgdata:
`;

const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe("translateCompose", () => {
  it("translates an app, its Postgres and a named volume, database first", () => {
    const t = translateCompose(APP_AND_DB);
    // `--port=3000` starts with "-", which the agent's argument rule refuses.
    expect(t.refused).toEqual([
      expect.objectContaining({ service: "web", line: lineOf(APP_AND_DB, "command"), message: expect.stringContaining("Command argument 2 isn't allowed") }),
    ]);
    expect(t.refused[0]!.message).not.toContain("--port");
    const fixed = translateCompose(APP_AND_DB.replace('["serve", "--port=3000"]', '["serve", "port=3000"]'));
    expect(fixed.refused).toEqual([]);
    expect(fixed.services.map((s) => s.name)).toEqual(["db", "web"]);
    const [db, web] = fixed.services;
    expect(db!.volumes).toEqual([{ name: "pgdata", target: "/var/lib/postgresql/data", read_only: false }]);
    expect(db!.environment).toEqual({ POSTGRES_PASSWORD: "s3cret-pass", POSTGRES_DB: "app" });
    expect(web!.environment).toEqual({ DATABASE_URL: "postgres://app:s3cret-pass@db:5432/app", PRICE: "$5" });
    expect(web!.command).toEqual(["serve", "port=3000"]);
    expect(web!.ports).toEqual([3000]);
    expect(fixed.web).toEqual({ service: "web", port: 3000 });
    // Ignored keys, host ports and the health condition are explained, not refused.
    const notices = fixed.notices.map((n) => n.message).join("\n");
    expect(notices).toMatch(/restart/);
    expect(notices).toMatch(/Host ports aren't published/);
    expect(notices).toMatch(/conditions are ignored/);
    // No issue ever carries an environment value.
    expect(JSON.stringify([...fixed.notices, ...t.refused])).not.toContain("s3cret-pass");
  });

  it("produces specs the agent's own schema accepts", () => {
    const t = translateCompose(APP_AND_DB.replace('["serve", "--port=3000"]', '["serve", "port=3000"]'));
    for (const s of t.services) {
      const port = s.name === t.web!.service ? { container_port: t.web!.port, host_port: 20001 } : null;
      const spec = composeContainerSpec("abcdef12-3456-4789-8abc-def012345678", s, s.environment, port);
      expect(managedContainerSpec.safeParse(spec).success, s.name).toBe(true);
    }
    const db = composeContainerSpec("abc", t.services[0]!, {}, null);
    expect(db.mounts[0]!.source).toBe("/var/lib/kaname-apps/abc/volumes/pgdata");
    expect(db.ports).toEqual([]);
  });

  it.each([
    ["privileged: true", "    privileged: true", /privileged/],
    ["the Docker socket", "    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock", /\/var\/run\/docker\.sock is a host path/],
    ["a relative bind mount", "    volumes:\n      - ./data:/data", /\.\/data is a host path/],
    ["a long-form bind mount", "    volumes:\n      - type: bind\n        source: /etc\n        target: /etc", /\/etc is a host path/],
    ["build:", "    build: .", /can't be built/],
    ["cap_add", "    cap_add: [SYS_ADMIN]", /capabilities/],
    ["devices", "    devices: [/dev/kvm]", /devices/],
    ["network_mode: host", "    network_mode: host", /private network/],
    ["pid: host", "    pid: host", /namespaces/],
    ["ipc: host", "    ipc: host", /namespaces/],
    ["entrypoint", "    entrypoint: /bin/sh", /entrypoint/],
    ["an unknown key", "    gpus: all", /`gpus` isn't supported/],
  ])("refuses %s on its own line", (_label, extra, message) => {
    const text = `services:\n  app:\n    image: nginx:1.27\n${extra}\n    ports: ["80"]\n`;
    const t = translateCompose(text);
    const issue = t.refused.find((r) => message.test(r.message));
    expect(issue, JSON.stringify(t.refused)).toBeDefined();
    expect(issue!.line).toBe(4 + (extra.includes("\n") ? 1 : 0));
    expect(issue!.service).toBe("app");
  });

  it("refuses an untagged image, a variable with no value and a bad service name", () => {
    expect(translateCompose("services:\n  app:\n    image: postgres\n").refused[0]!.message).toMatch(/Pin a tag.*postgres:16/);
    const missing = translateCompose("services:\n  app:\n    image: nginx:1\n    environment:\n      TOKEN: ${API_TOKEN}\n");
    expect(missing.refused).toEqual([{ line: 5, service: "app", message: expect.stringContaining("Set a value for API_TOKEN") }]);
    const named = translateCompose("services:\n  My-App:\n    image: nginx:1\n");
    expect(named.refused[0]).toMatchObject({ line: 2, message: expect.stringMatching(/Rename service `My-App`/) });
  });

  it("asks for the web entry when no service lists a port, and takes the one chosen", () => {
    const text = "services:\n  app:\n    image: nginx:1.27\n";
    const t = translateCompose(text);
    expect(t.refused).toEqual([]);
    expect(t.web).toBeNull();
    expect(t.notices.map((n) => n.message).join()).toMatch(/Choose the service and port/);
    expect(translateCompose(text, { web_service: "app", web_port: 8080 }).web).toEqual({ service: "app", port: 8080 });
    expect(translateCompose(APP_AND_DB, { web_service: "web", web_port: 9999 }).refused.some((r) => /doesn't list port 9999/.test(r.message))).toBe(true);
  });

  it("refuses top-level extras, multi-document files, YAML errors and dependency cycles", () => {
    expect(translateCompose("services:\n  a:\n    image: nginx:1\nsecrets:\n  x: {}\n").refused[0]).toMatchObject({ line: 4 });
    expect(translateCompose("services:\n  a:\n    image: nginx:1\n---\nservices: {}\n").refused[0]!.message).toMatch(/one YAML document/);
    expect(translateCompose("services:\n  a: [\n").refused[0]!.message).toMatch(/YAML error/);
    expect(translateCompose("volumes:\n  v:\n    driver: local\nservices:\n  a:\n    image: nginx:1\n").refused[0]).toMatchObject({ line: 3 });
    const cycle = translateCompose(
      "services:\n  a:\n    image: nginx:1\n    depends_on: [b]\n  b:\n    image: nginx:1\n    depends_on: [a]\n",
    );
    expect(cycle.refused.some((r) => /cycle/.test(r.message))).toBe(true);
    expect(translateCompose("services:\n  a:\n    image: nginx:1\n    depends_on: [ghost]\n").refused[0]!.message).toMatch(/isn't a service/);
  });

  it("skips a profiled service and mirrors the agent's caps", () => {
    const t = translateCompose("services:\n  a:\n    image: nginx:1\n    ports: [80]\n  debug:\n    image: busybox:1\n    profiles: [debug]\n");
    expect(t.services.map((s) => s.name)).toEqual(["a"]);
    expect(t.notices.some((n) => n.service === "debug" && /skipped/.test(n.message))).toBe(true);
    const args = Array.from({ length: 17 }, (_, i) => `a${i}`).join(" ");
    expect(translateCompose(`services:\n  a:\n    image: nginx:1\n    command: ${args}\n`).refused[0]!.message).toMatch(/more than 16/);
  });

  it("interpolates defaults and escapes, and reports what needs a value", () => {
    const missing: (string | null)[] = [];
    expect(interpolate("a$${b}-${C:-c}-${D-d}-$E-${F:?no}", (n) => missing.push(n))).toBe("a${b}-c-d--");
    expect(missing).toEqual(["E", "F"]);
  });
});

describe("translateCompose: the agent's limits and what messages show", () => {
  const svc = (extra: string) => `services:\n  app:\n    image: nginx:1.27\n    ports: ["80"]\n${extra}`;
  const said = (t: ReturnType<typeof translateCompose>) => JSON.stringify([...t.refused, ...t.notices]);

  it("refuses a mount on / and the same target twice, as the agent cleans paths", () => {
    for (const target of ["/", "/.", "//"]) {
      const t = translateCompose(svc(`    volumes:\n      - data:${target}\n`));
      expect(t.refused, target).toEqual([expect.objectContaining({ line: 6, message: expect.stringMatching(/root/) })]);
    }
    const twice = translateCompose(svc("    volumes:\n      - a:/data\n      - b:/data/./\n"));
    expect(twice.refused).toEqual([expect.objectContaining({ line: 7, message: expect.stringMatching(/mounted twice/) })]);
  });

  it("counts value and target lengths in bytes, naming the variable, not the value", () => {
    const env = translateCompose(svc(`    environment:\n      BIG: "${"é".repeat(2049)}"\n`));
    expect(env.refused).toEqual([expect.objectContaining({ line: 6, message: expect.stringMatching(/BIG must be at most 4096 bytes/) })]);
    const mount = translateCompose(svc(`    volumes:\n      - data:/${"é".repeat(2048)}\n`));
    expect(mount.refused).toEqual([expect.objectContaining({ line: 6, message: expect.stringMatching(/longer than 4096 bytes/) })]);
    expect(said(env) + said(mount)).not.toContain("éé");
  });

  it("never shows a value, a default or a command argument in a message", () => {
    const text = [
      "services:",
      "  app:",
      '    image: "${REG:-hunter2a}/nginx"',
      '    ports: ["80"]',
      "    environment:",
      "      - hunter2b",
      '      - "hunter2c x=1"',
      '      - "B=${X:-${Y}hunter2d}"',
      '      - "C=${:-hunter2e}"',
      '    command: ["ok", "hunter2f;rm"]',
      "    volumes:",
      '      - "${V:-hunter2g/x}:/data"',
      '      - "data:${T:-hunter2h}"',
      "  worker:",
      "    image: nginx:1",
      '    ports: ["${P:-hunter2i}"]',
      "",
    ].join("\n");
    const t = translateCompose(text);
    expect(t.refused.length).toBeGreaterThanOrEqual(9);
    expect(t.refused.map((r) => r.message).join("\n")).toMatch(/Environment entry 1 isn't KEY=value[^]*Command argument 2 isn't allowed/);
    expect(said(t)).not.toContain("hunter2");
  });

  it("treats prototype names as plain keys", () => {
    const t = translateCompose(svc("    constructor: x\n    toString: y\n    environment:\n      __proto__: x\n      constructor: ok\n"));
    expect(t.refused.map((r) => r.message)).toEqual([
      "`constructor` isn't supported.",
      "`toString` isn't supported.",
      expect.stringMatching(/`__proto__` can't be used/),
    ]);
  });

  it("applies web_port to the service picked for it", () => {
    const one = 'services:\n  app:\n    image: nginx:1.27\n    ports: ["80", "8080"]\n';
    expect(translateCompose(one, { web_port: 8080 }).web).toEqual({ service: "app", port: 8080 });
    expect(translateCompose(one, { web_port: 9999 }).refused[0]!.message).toMatch(/doesn't list port 9999; choose one of 80, 8080\./);
    const none = translateCompose("services:\n  app:\n    image: nginx:1.27\n", { web_service: "app", web_port: 0 });
    expect(none.refused[0]!.message).toMatch(/from 1 to 65535/);
  });

  it("leaves UDP ports out of the web choice and checks port syntax", () => {
    const t = translateCompose(
      'services:\n  dns:\n    image: coredns/coredns:1.11\n    ports: ["53:53/udp", {target: 5353, protocol: udp}]\n  app:\n    image: nginx:1.27\n    ports: ["80"]\n',
    );
    expect(t.refused).toEqual([]);
    expect(t.web).toEqual({ service: "app", port: 80 });
    expect(t.services.find((s) => s.name === "dns")!.ports).toEqual([]);
    expect(t.notices.some((n) => /UDP ports aren't published/.test(n.message))).toBe(true);
    for (const bad of ['{target: "0x50"}', "{target: 80.5}", "{target: 70000}", '"1.2.3.4:1:2:80"']) {
      expect(translateCompose(`services:\n  app:\n    image: nginx:1.27\n    ports: [${bad}]\n`).refused, bad).toHaveLength(1);
    }
  });

  it("reads d:/data as volume d, C:/host:/target as a host path, and long forms like short ones", () => {
    const d = translateCompose(svc("    volumes:\n      - d:/data\n"));
    expect(d.refused).toEqual([]);
    expect(d.services[0]!.volumes).toEqual([{ name: "d", target: "/data", read_only: false }]);
    expect(d.notices.some((n) => /Volumes start empty and owned by root/.test(n.message))).toBe(true);
    expect(translateCompose(svc("    volumes:\n      - C:/host:/data\n")).refused[0]!.message).toMatch(/C:\/host is a host path/);
    expect(translateCompose(svc("    volumes:\n      - C:\\host:/data\n")).refused[0]!.message).toMatch(/host path/);
    const long = translateCompose(
      svc('    volumes:\n      - type: volume\n        source: ${V:-data}\n        target: ${T:-/data}\n        read_only: "true"\n'),
    );
    expect(long.refused).toEqual([]);
    expect(long.services[0]!.volumes).toEqual([{ name: "data", target: "/data", read_only: true }]);
    const yes = translateCompose(svc("    volumes:\n      - {source: data, target: /data, read_only: yes}\n"));
    expect(yes.refused[0]!.message).toMatch(/read_only/);
  });

  it("caps the refusals and keeps interpolation linear and strict", () => {
    const many = Array.from({ length: 60 }, (_, i) => `    k${i}: x`).join("\n");
    const t = translateCompose(`services:\n  app:\n    image: nginx:1.27\n${many}\n`);
    expect(t.refused).toHaveLength(COMPOSE_MAX_ISSUES + 1);
    expect(t.refused[COMPOSE_MAX_ISSUES]!.message).toBe("…and 10 more problems.");
    const started = Date.now();
    interpolate("${a:-".repeat(20000), () => undefined);
    expect(Date.now() - started).toBeLessThan(1000);
    const names: (string | null)[] = [];
    interpolate("${A:-${B:-x}}", (n) => names.push(n));
    expect(names).toEqual([null]);
  });

  it("gives YAML errors their line", () => {
    const dup = translateCompose("services:\n  a:\n    image: nginx:1\n    privileged: false\n    privileged: true\n");
    expect(dup.refused[0]).toMatchObject({ line: 5, message: expect.stringMatching(/YAML error/) });
  });
});

describe("compose recipe", () => {
  const t = translateCompose(APP_AND_DB.replace('["serve", "--port=3000"]', '["serve", "port=3000"]'));
  const source = composeSource(t);

  it("keeps no environment values, only their names", () => {
    expect(appSource.safeParse(source).success).toBe(true);
    expect(JSON.stringify(source)).not.toContain("s3cret-pass");
    expect(source.services.find((s) => s.name === "db")!.env_keys).toEqual(["POSTGRES_PASSWORD", "POSTGRES_DB"]);
  });

  it("runs pull, network, the other services, the web service, site, certificate and verify", () => {
    const steps = appInstallSteps(composeRecipe(source), { ssl: true });
    expect(steps.map((s) => s.id)).toEqual(["pull", "network", "db_container", "app_container", "site", "certificate", "verify"]);
    expect(steps[2]!.title).toBe("Start the services");
    expect(steps[3]!.title).toBe("Start web");
    const later = composeSource(
      translateCompose("services:\n  web:\n    image: nginx:1\n    ports: [80]\n  worker:\n    image: busybox:1\n    depends_on: [web]\n"),
    );
    const laterSteps = appInstallSteps(composeRecipe(later), { ssl: false });
    expect(laterSteps.map((s) => s.id)).not.toContain("db_container");
    expect(laterSteps.find((s) => s.id === "app_container")!.description).toMatch(/Then what depends on it: worker,/);
    const alone = composeSource(translateCompose("services:\n  a:\n    image: nginx:1\n    ports: [80]\n"));
    expect(appInstallSteps(composeRecipe(alone), { ssl: false }).map((s) => s.id)).not.toContain("db_container");
  });

  it("accepts a compose file only with the compose app id", () => {
    const base = { server_id: "11111111-1111-4111-8111-111111111111", domain: "x.example.com", admin_email: "a@example.com" };
    expect(installAppInput.safeParse({ ...base, app_id: COMPOSE_APP_ID, compose: "services: {}" }).success).toBe(true);
    expect(installAppInput.safeParse({ ...base, app_id: "ghost", compose: "services: {}" }).success).toBe(false);
    expect(installAppInput.safeParse({ ...base, app_id: COMPOSE_APP_ID }).success).toBe(false);
  });
});
