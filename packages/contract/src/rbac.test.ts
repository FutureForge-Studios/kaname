import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  buildEffectiveGrants,
  can,
  scopeFor,
  type RoleGrant,
} from "./rbac.js";
import { JOB_SPECS, JOB_TYPES } from "./jobs.js";

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";

describe("permission taxonomy", () => {
  it("has no duplicates", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("uses the module.resource:action shape throughout", () => {
    for (const p of PERMISSIONS) {
      expect(p).toMatch(/^[a-z_]+\.[a-z_]+:(read|write|delete|exec|approve)$/);
    }
  });

  it("gives every job type a permission that actually exists", () => {
    for (const type of JOB_TYPES) {
      expect(PERMISSIONS).toContain(JOB_SPECS[type].permission);
    }
  });

  it("never marks a non-idempotent job as retryable", () => {
    for (const type of JOB_TYPES) {
      const spec = JOB_SPECS[type];
      if (!spec.idempotent) expect(spec.maxAttempts).toBe(1);
    }
  });
});

describe("system roles", () => {
  it("gives Owner everything", () => {
    expect(SYSTEM_ROLES.owner.permissions).toEqual(PERMISSIONS);
  });

  it("keeps Operator out of administration and restores", () => {
    const perms = SYSTEM_ROLES.operator.permissions;
    expect(perms.some((p) => p.startsWith("admin."))).toBe(false);
    expect(perms).not.toContain("backups.restore:exec");
    expect(perms).toContain("infra.services:exec");
  });

  it("keeps Developer out of the terminal, security and email", () => {
    const perms = SYSTEM_ROLES.developer.permissions;
    expect(perms).not.toContain("terminal.session:exec");
    expect(perms.some((p) => p.startsWith("security."))).toBe(false);
    expect(perms.some((p) => p.startsWith("email."))).toBe(false);
    expect(perms).toContain("websites.deployments:exec");
  });

  it("makes Auditor strictly read-only", () => {
    for (const p of SYSTEM_ROLES.auditor.permissions) {
      expect(p.endsWith(":read")).toBe(true);
    }
    expect(SYSTEM_ROLES.auditor.permissions).toContain("security.audit:read");
  });
});

describe("grant evaluation", () => {
  const scoped: RoleGrant[] = [
    { permission: "infra.services:exec", scope: { kind: "servers", server_ids: [SERVER_A] } },
    { permission: "infra.servers:read", scope: { kind: "global" } },
  ];

  it("allows a scoped permission only on the listed servers", () => {
    const grants = buildEffectiveGrants(scoped);
    expect(can(grants, "infra.services:exec", SERVER_A)).toBe(true);
    expect(can(grants, "infra.services:exec", SERVER_B)).toBe(false);
  });

  it("allows a global permission on any server", () => {
    const grants = buildEffectiveGrants(scoped);
    expect(can(grants, "infra.servers:read", SERVER_B)).toBe(true);
  });

  it("denies anything not granted", () => {
    const grants = buildEffectiveGrants(scoped);
    expect(can(grants, "admin.users:write", SERVER_A)).toBe(false);
    expect(can(grants, "terminal.session:exec")).toBe(false);
  });

  it("lets global win over a narrower grant for the same permission", () => {
    const grants = buildEffectiveGrants([
      { permission: "files.manager:read", scope: { kind: "servers", server_ids: [SERVER_A] } },
      { permission: "files.manager:read", scope: { kind: "global" } },
    ]);
    expect(scopeFor(grants, "files.manager:read")).toBe("global");
    expect(can(grants, "files.manager:read", SERVER_B)).toBe(true);
  });

  it("unions server lists across roles", () => {
    const grants = buildEffectiveGrants([
      { permission: "logs.streams:read", scope: { kind: "servers", server_ids: [SERVER_A] } },
      { permission: "logs.streams:read", scope: { kind: "servers", server_ids: [SERVER_B] } },
    ]);
    expect(scopeFor(grants, "logs.streams:read")).toEqual(
      expect.arrayContaining([SERVER_A, SERVER_B]),
    );
  });

  it("treats an omitted serverId as 'anywhere at all', not as a bypass", () => {
    const grants = buildEffectiveGrants([
      { permission: "infra.containers:exec", scope: { kind: "servers", server_ids: [SERVER_A] } },
    ]);
    // Correct for nav visibility...
    expect(can(grants, "infra.containers:exec")).toBe(true);
    // ...but a specific server is still checked.
    expect(can(grants, "infra.containers:exec", SERVER_B)).toBe(false);
  });

  it("returns null scope for a permission that was never granted", () => {
    const grants = buildEffectiveGrants([]);
    expect(scopeFor(grants, "admin.settings:write")).toBeNull();
  });
});
