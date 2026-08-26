#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseManifest } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Builds versions.json.
 *
 *   node scripts/release-manifest.mjs 0.2.0 --breaking --summary "..."
 *
 * The manifest is published data, not something inferred from registry
 * tags: a running instance has to know whether a release is breaking
 * BEFORE it decides whether it may apply itself (KD-028).
 * ------------------------------------------------------------------ */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const REGISTRY = process.env.KANAME_REGISTRY ?? "ghcr.io/futureforge-studios";
const RELEASE_BASE =
  process.env.KANAME_RELEASE_BASE ??
  "https://github.com/FutureForge-Studios/kaname/releases/download";
const TARGETS = ["linux-amd64", "linux-arm64"];

function parseArgs(argv) {
  const version = argv.find((a) => !a.startsWith("-"));
  if (!version) {
    console.error("usage: node scripts/release-manifest.mjs <version> [--breaking] [--security]");
    console.error(
      "                                          [--destructive] [--adds-config KEY,KEY]",
    );
    console.error("                                          [--summary '...'] [--min-from 0.1.0]");
    process.exit(2);
  }

  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    version,
    breaking: flag("breaking"),
    security: flag("security"),
    destructive: flag("destructive"),
    addsConfig: (value("adds-config") ?? "").split(",").filter(Boolean),
    summary: value("summary") ?? "",
    minFrom: value("min-from"),
    notesUrl: value("notes-url"),
  };
}

/**
 * Digests whatever agent builds are present. A target with no binary is
 * omitted rather than given a placeholder hash — the control plane
 * refuses to update a host it has no verified build for, which is the
 * right answer.
 */
function agentArtifacts(version) {
  const artifacts = {};
  for (const target of TARGETS) {
    const path = join(ROOT, "agent", "bin", `kanamed-${target}`);
    if (!existsSync(path)) {
      console.warn(`  no build for ${target}; leaving it out of the manifest`);
      continue;
    }
    artifacts[target] = {
      url: `${RELEASE_BASE}/v${version}/kanamed-${target}`,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  }
  return artifacts;
}

export function buildRelease(options) {
  return {
    version: options.version,
    channel: options.version.includes("-") ? "beta" : "stable",
    released_at: new Date().toISOString(),
    breaking: options.breaking,
    security: options.security,
    summary: options.summary,
    ...(options.notesUrl ? { notes_url: options.notesUrl } : {}),
    ...(options.minFrom ? { min_upgrade_from: options.minFrom } : {}),
    migrations: { destructive: options.destructive, adds_config: options.addsConfig },
    artifacts: {
      control_plane: `${REGISTRY}/kaname-control-plane:${options.version}`,
      web: `${REGISTRY}/kaname-web:${options.version}`,
      agent: agentArtifacts(options.version),
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = join(ROOT, "versions.json");

  const existing = existsSync(target)
    ? releaseManifest.parse(JSON.parse(readFileSync(target, "utf8")))
    : { schema: 1, releases: [] };

  const release = buildRelease(options);
  const releases = [release, ...existing.releases.filter((r) => r.version !== release.version)];

  const manifest = releaseManifest.parse({ schema: 1, releases });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`wrote ${target} with ${manifest.releases.length} release(s)`);
  console.log(`  ${release.version}${release.breaking ? " (breaking)" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
