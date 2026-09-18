#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_RELEASE_FACTS, releaseFacts, releaseManifest } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Builds versions.json.
 *
 *   node scripts/release-manifest.mjs 0.2.0 [--from release.json] [--breaking] ...
 *
 * The manifest is published data, not something inferred from registry
 * tags: a running instance has to know whether a release is breaking
 * BEFORE it decides whether it may apply itself (KD-028).
 *
 * The facts about the release — breaking, destructive, the config keys
 * it adds — come from release.json, committed alongside the change
 * that made them true, so the release workflow does not have to infer
 * them from a tag message. Flags override the file for a one-off.
 * ------------------------------------------------------------------ */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const REGISTRY = process.env.KANAME_REGISTRY ?? "ghcr.io/futureforge-studios";
const RELEASE_BASE =
  process.env.KANAME_RELEASE_BASE ??
  "https://github.com/FutureForge-Studios/kaname/releases/download";
const TARGETS = ["linux-amd64", "linux-arm64"];

function parseArgs(argv) {
  // Positional: the version is the FIRST token, and only if it is not a
  // flag. `find` would otherwise happily take a flag's value -- so
  // omitting the version entirely produced a manifest named after the
  // summary rather than the usage message.
  const version = argv[0]?.startsWith("-") ? undefined : argv[0];
  if (!version) {
    console.error("usage: node scripts/release-manifest.mjs <version> [--from release.json]");
    console.error(
      "                                          [--breaking] [--security] [--destructive]",
    );
    console.error(
      "                                          [--adds-config KEY,KEY] [--min-from 0.1.0]",
    );
    console.error("                                          [--summary '...'] [--reset-facts]");
    process.exit(2);
  }

  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const facts = loadFacts(value("from") ?? FACTS_FILE);

  return {
    version,
    // A flag can only add: `--breaking` on a release whose file says
    // otherwise is a person noticing late, never the other way round.
    breaking: flag("breaking") || facts.breaking,
    security: flag("security") || facts.security,
    destructive: flag("destructive") || facts.destructive,
    addsConfig: value("adds-config")
      ? value("adds-config").split(",").filter(Boolean)
      : facts.adds_config,
    // The file's summary is written with the change; the tag subject
    // the workflow passes is what stands in when nobody wrote one.
    summary: facts.summary || value("summary") || "",
    minFrom: value("min-from") ?? facts.min_upgrade_from ?? undefined,
    notesUrl: value("notes-url"),
    resetFacts: flag("reset-facts"),
  };
}

const FACTS_FILE = join(ROOT, "release.json");

/** A missing file is a quiet release; a malformed one is a stopped build. */
function loadFacts(path) {
  if (!existsSync(path)) {
    console.warn(`  no ${path}; treating this as a release with nothing to declare`);
    return DEFAULT_RELEASE_FACTS;
  }
  const parsed = releaseFacts.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    console.error(`${path} is not valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    process.exit(2);
  }
  return parsed.data;
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

  // The facts have been consumed: main starts the next cycle with
  // nothing declared, so a flag never carries over to a release it
  // was not written for.
  if (options.resetFacts) {
    writeFileSync(FACTS_FILE, `${JSON.stringify(DEFAULT_RELEASE_FACTS, null, 2)}\n`);
    console.log(`reset ${FACTS_FILE}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
