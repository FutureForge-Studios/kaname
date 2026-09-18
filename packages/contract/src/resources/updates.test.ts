import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASE_FACTS,
  compareVersions,
  releaseFacts,
  selectUpgrade,
  versionStep,
  type ReleaseManifest,
} from "./updates.js";

/* ------------------------------------------------------------------ *
 * Version arithmetic is shared between the scheduler's decision to
 * apply and the panel's description of it; a disagreement here is an
 * instance that never sees the release it is waiting for.
 * ------------------------------------------------------------------ */

describe("compareVersions", () => {
  it("orders releases numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  it("sorts a pre-release below its own release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("compares numeric prerelease identifiers as numbers", () => {
    expect(compareVersions("0.2.0-rc.9", "0.2.0-rc.10")).toBe(-1);
    expect(compareVersions("0.2.0-rc.10", "0.2.0-rc.9")).toBe(1);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.10")).toBe(-1);
  });

  it("follows semver precedence across identifier kinds", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(
        compareVersions(ordered[i]!, ordered[i + 1]!),
        `${ordered[i]} < ${ordered[i + 1]}`,
      ).toBe(-1);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBe(1);
    }
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });

  it("sorts a version that does not parse below everything", () => {
    expect(compareVersions("dev", "0.0.1")).toBe(-1);
    expect(compareVersions("0.0.1", "unknown")).toBe(1);
    expect(compareVersions("", "0.1.0")).toBe(-1);
    expect(compareVersions("dev", "unknown")).toBe(0);
  });
});

describe("selectUpgrade", () => {
  const manifest: ReleaseManifest = {
    schema: 1,
    releases: ["0.2.0-rc.10", "0.2.0-rc.9"].map((version) => ({
      version,
      channel: "beta" as const,
      released_at: "2026-01-01T00:00:00.000Z",
      breaking: false,
      security: false,
      summary: "",
      migrations: { destructive: false, adds_config: [] },
      artifacts: { control_plane: "cp", web: "web", agent: {} },
    })),
  };

  it("offers rc.10 to an instance on rc.9", () => {
    expect(selectUpgrade("0.2.0-rc.9", manifest, "beta")?.version).toBe("0.2.0-rc.10");
    expect(selectUpgrade("0.2.0-rc.10", manifest, "beta")).toBeNull();
  });

  it("describes the step the same way", () => {
    expect(versionStep("0.2.0-rc.9", "0.2.0-rc.10")).toBe("patch");
    expect(versionStep("0.2.0-rc.10", "0.2.0-rc.9")).toBe("none");
  });
});

describe("release facts", () => {
  it("fills in every default so an empty file is a quiet release", () => {
    expect(releaseFacts.parse({})).toEqual(DEFAULT_RELEASE_FACTS);
  });

  it("refuses a configuration key that is not an environment variable name", () => {
    expect(releaseFacts.safeParse({ adds_config: ["lowercase"] }).success).toBe(false);
    expect(releaseFacts.safeParse({ adds_config: ["KANAME_NEW_SECRET"] }).success).toBe(true);
  });

  it("refuses a floor that is not a version", () => {
    expect(releaseFacts.safeParse({ min_upgrade_from: "latest" }).success).toBe(false);
    expect(releaseFacts.parse({ min_upgrade_from: "0.1.0" }).min_upgrade_from).toBe("0.1.0");
  });
});
