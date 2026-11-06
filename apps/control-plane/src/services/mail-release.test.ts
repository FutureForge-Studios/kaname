import { describe, expect, it } from "vitest";
import { MailReleaseService, parseSha256, releaseArch } from "./mail-release.js";

/* ------------------------------------------------------------------ *
 * The yunori-mail release resolver, against a scripted fetch.
 *
 * What matters: the checksum the agent verifies against comes from the
 * same place as the archive, the GitHub release stands in when the site
 * does not answer, a pin skips the feed entirely, and nothing is
 * fetched twice within the hour.
 * ------------------------------------------------------------------ */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const FEED = "https://feed.example/server";
const GITHUB = "https://github.com/FutureForge-Studios/yunori-mail/releases/download";

/** URL -> body, or a status code for a refusal. Records every request. */
function scripted(routes: Record<string, string | number>) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const hit = routes[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (typeof hit === "number") return new Response("refused", { status: hit });
    return new Response(hit, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("MailReleaseService", () => {
  it("reads latest.json, then each archive's checksum from the feed", async () => {
    const { fetch, requests } = scripted({
      [`${FEED}/latest.json`]: JSON.stringify({
        version: "v0.3.1",
        publishedAt: "2026-10-01T12:00:00Z",
        notesUrl: "https://example.com/notes",
      }),
      [`${FEED}/v0.3.1/yunori-mail-x86_64-linux.tar.gz.sha256`]: `${SHA_A}  yunori-mail-x86_64-linux.tar.gz\n`,
      [`${FEED}/v0.3.1/yunori-mail-aarch64-linux.tar.gz.sha256`]: SHA_B,
    });
    const service = new MailReleaseService({ fetch, feed: FEED });

    const release = await service.latest();
    expect(release).toEqual({
      version: "0.3.1",
      assets: {
        amd64: { url: `${FEED}/v0.3.1/yunori-mail-x86_64-linux.tar.gz`, sha256: SHA_A },
        arm64: { url: `${FEED}/v0.3.1/yunori-mail-aarch64-linux.tar.gz`, sha256: SHA_B },
      },
      published_at: "2026-10-01T12:00:00.000Z",
      notes_url: "https://example.com/notes",
    });

    // Cached: a second call, and a pinned lookup of the same version, fetch nothing.
    const before = requests.length;
    await service.latest();
    await service.resolve("0.3.1");
    expect(requests).toHaveLength(before);
  });

  it("falls back to the GitHub release for an archive the feed cannot serve", async () => {
    const { fetch } = scripted({
      [`${FEED}/latest.json`]: JSON.stringify({ version: "0.4.0" }),
      [`${FEED}/v0.4.0/yunori-mail-x86_64-linux.tar.gz.sha256`]: SHA_A,
      [`${FEED}/v0.4.0/yunori-mail-aarch64-linux.tar.gz.sha256`]: 502,
      [`${GITHUB}/v0.4.0/yunori-mail-aarch64-linux.tar.gz.sha256`]: SHA_B,
    });
    const release = await new MailReleaseService({ fetch, feed: FEED }).latest();
    expect(release.assets.amd64?.url).toBe(`${FEED}/v0.4.0/yunori-mail-x86_64-linux.tar.gz`);
    expect(release.assets.arm64).toEqual({
      url: `${GITHUB}/v0.4.0/yunori-mail-aarch64-linux.tar.gz`,
      sha256: SHA_B,
    });
    expect(release.published_at).toBeNull();
    expect(release.notes_url).toContain("/releases/tag/v0.4.0");
  });

  it("deploys the pinned version without consulting latest.json", async () => {
    const { fetch, requests } = scripted({
      [`${FEED}/v0.2.9/yunori-mail-x86_64-linux.tar.gz.sha256`]: SHA_A,
      [`${FEED}/v0.2.9/yunori-mail-aarch64-linux.tar.gz.sha256`]: SHA_B,
    });
    const release = await new MailReleaseService({ fetch, feed: FEED, pin: "v0.2.9" }).latest();
    expect(release.version).toBe("0.2.9");
    expect(requests.some((u) => u.endsWith("latest.json"))).toBe(false);
  });

  it("says what to do when neither the feed nor GitHub answers", async () => {
    const { fetch } = scripted({});
    await expect(new MailReleaseService({ fetch, feed: FEED }).latest()).rejects.toThrow(
      /KANAME_YUNORI_VERSION/,
    );
  });

  it("refuses a checksum file that holds no digest", async () => {
    const { fetch } = scripted({
      [`${FEED}/latest.json`]: JSON.stringify({ version: "0.5.0" }),
      [`${FEED}/v0.5.0/yunori-mail-x86_64-linux.tar.gz.sha256`]: "<html>maintenance</html>",
    });
    await expect(new MailReleaseService({ fetch, feed: FEED }).latest()).rejects.toThrow(
      /checksum/,
    );
  });
});

describe("helpers", () => {
  it("accepts sha256sum output and bare digests, in either case", () => {
    expect(parseSha256(`${SHA_A}  file.tar.gz`)).toBe(SHA_A);
    expect(parseSha256(SHA_B.toUpperCase())).toBe(SHA_B);
    expect(parseSha256("nope")).toBeNull();
  });

  it("maps what agents report as arch onto the two release flavours", () => {
    expect(releaseArch("x86_64")).toBe("amd64");
    expect(releaseArch("amd64")).toBe("amd64");
    expect(releaseArch("aarch64")).toBe("arm64");
    expect(releaseArch("arm64")).toBe("arm64");
    expect(releaseArch("riscv64")).toBeNull();
    expect(releaseArch(null)).toBeNull();
  });
});
