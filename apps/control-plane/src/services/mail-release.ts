import type { MailRelease } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Which yunori-mail release Kaname deploys.
 *
 * The agent installs exactly what it is told: a version, an archive URL
 * and the archive's SHA-256, and it verifies the download before a
 * single byte of it runs. So the one place that has to be right about
 * what the newest release is, and what its checksum is, is here, and
 * it reads the same feed the product's own installer reads
 * (yunori.email/server, see its README under "Where the bytes come
 * from"). The GitHub release the feed redirects to is the fallback for
 * when the site is unreachable; the checksum is the same either way.
 *
 * Resolution is cached for an hour: a deploy wizard polls it, and the
 * feed is somebody else's server.
 * ------------------------------------------------------------------ */

export const DEFAULT_YUNORI_FEED = "https://yunori.email/server";
const GITHUB_RELEASES = "https://github.com/FutureForge-Studios/yunori-mail/releases/download";
const CACHE_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

/** The archive each CPU architecture installs. Matches the release workflow's asset names. */
export const YUNORI_ASSETS: Record<"amd64" | "arm64", string> = {
  amd64: "yunori-mail-x86_64-linux.tar.gz",
  arm64: "yunori-mail-aarch64-linux.tar.gz",
};

/** Maps what an agent reports as `arch` onto the two release flavours. */
export function releaseArch(arch: string | null | undefined): "amd64" | "arm64" | null {
  switch ((arch ?? "").toLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "amd64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      return null;
  }
}

export interface MailReleaseServiceDeps {
  fetch?: typeof globalThis.fetch;
  /** Overrides the feed base URL (KANAME_YUNORI_FEED). */
  feed?: string;
  /** Pins the version (KANAME_YUNORI_VERSION): the feed's latest.json is not consulted. */
  pin?: string;
  now?: () => number;
}

interface LatestJson {
  version: string;
  tag?: string;
  publishedAt?: string;
  notesUrl?: string;
}

export class MailReleaseService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly feed: string;
  private readonly pin: string | null;
  private readonly now: () => number;
  private cache = new Map<string, { release: MailRelease; at: number }>();

  constructor(deps: MailReleaseServiceDeps = {}) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.feed = (deps.feed ?? DEFAULT_YUNORI_FEED).replace(/\/+$/, "");
    this.pin = deps.pin?.trim() || null;
    this.now = deps.now ?? Date.now;
  }

  /** The release a deploy without a version gets: the pin, else the feed's newest. */
  latest(): Promise<MailRelease> {
    return this.resolve(undefined);
  }

  /** A specific release, or the newest when `version` is omitted. */
  async resolve(version: string | undefined): Promise<MailRelease> {
    const wanted = normalizeVersion(version ?? this.pin ?? undefined);
    const key = wanted ?? "latest";
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.release;

    const release = wanted ? await this.describe(wanted, null) : await this.describeLatest();
    this.cache.set(key, { release, at: this.now() });
    // The newest release is also that version's release, so a later
    // pinned lookup for it needs no second round of checksum fetches.
    this.cache.set(release.version, { release, at: this.now() });
    return release;
  }

  /** Drops the cache; a deploy that failed on a bad checksum should not wait an hour. */
  invalidate(): void {
    this.cache.clear();
  }

  private async describeLatest(): Promise<MailRelease> {
    let latest: LatestJson;
    try {
      latest = await this.json<LatestJson>(`${this.feed}/latest.json`);
    } catch (feedErr) {
      // The site redirects to GitHub for the files, and the release the
      // pinned installer in each GitHub release describes is the same
      // one; latest.json is published alongside it there too.
      try {
        latest = await this.json<LatestJson>(
          `${GITHUB_RELEASES.replace(/\/download$/, "/latest/download")}/latest.json`,
        );
      } catch {
        throw new Error(
          `Could not read the yunori-mail release feed at ${this.feed}/latest.json: ${describe(feedErr)}. Set KANAME_YUNORI_VERSION to deploy a known release while the feed is unreachable.`,
        );
      }
    }
    const version = normalizeVersion(latest.version);
    if (!version) throw new Error("The yunori-mail release feed named no version.");
    return this.describe(version, latest);
  }

  private async describe(version: string, latest: LatestJson | null): Promise<MailRelease> {
    const assets: MailRelease["assets"] = {};
    for (const [arch, asset] of Object.entries(YUNORI_ASSETS) as [
      keyof typeof YUNORI_ASSETS,
      string,
    ][]) {
      assets[arch] = await this.asset(version, asset);
    }
    return {
      version,
      assets,
      published_at: latest?.publishedAt ? toIso(latest.publishedAt) : null,
      notes_url:
        latest?.notesUrl ??
        `https://github.com/FutureForge-Studios/yunori-mail/releases/tag/v${version}`,
    };
  }

  /** The URL and checksum of one archive, from the feed or, failing that, from GitHub. */
  private async asset(version: string, asset: string): Promise<{ url: string; sha256: string }> {
    const bases = [`${this.feed}/v${version}`, `${GITHUB_RELEASES}/v${version}`];
    let lastErr: unknown = null;
    for (const base of bases) {
      try {
        const text = await this.text(`${base}/${asset}.sha256`);
        const sha256 = parseSha256(text);
        if (!sha256) throw new Error(`${base}/${asset}.sha256 did not contain a SHA-256`);
        return { url: `${base}/${asset}`, sha256 };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `Could not read the checksum of ${asset} for v${version}: ${describe(lastErr)}`,
    );
  }

  private async json<T>(url: string): Promise<T> {
    const text = await this.text(url);
    return JSON.parse(text) as T;
  }

  private async text(url: string): Promise<string> {
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  }
}

/** "v0.3.1" and "0.3.1" are the same release; the feed and the tag disagree on the prefix. */
function normalizeVersion(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/^v/i, "");
  return trimmed ? trimmed : null;
}

/** `sha256sum` output ("<hex>  <file>") or a bare digest. */
export function parseSha256(text: string): string | null {
  const match = /\b([0-9a-fA-F]{64})\b/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

function toIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
