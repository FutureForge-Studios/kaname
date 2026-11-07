import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import { owner, server } from "../support/secops.js";

/* ------------------------------------------------------------------ *
 * Logs — sources, search, filters, and a live tail.
 *
 * Every line here comes from the agent at the moment it is asked; the
 * control plane caches nothing. So the assertions compare the page with
 * what the same API returns, and a live tail is only "following" if new
 * lines keep arriving after it opened.
 * ------------------------------------------------------------------ */

interface Source {
  id: string;
  label: string;
  kind: string;
  server_name: string;
}
interface Line {
  ts: string;
  level: string;
  message: string;
}

const LEVEL_RANK = ["trace", "debug", "info", "notice", "warn", "error", "fatal"];

test.describe("logs", () => {
  test("sources are listed per host, and searched lines respect level and text filters", async ({ page }) => {
    const forge = await server("forge-01");
    const api = await owner();
    const sources = await api.get<Source[]>(`/logs/sources?server_id=${forge.id}&per_page=200`);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(source.server_name).toBe("forge-01");
    const source = sources.find((s) => s.id === "journal") ?? sources[0]!;

    await page.goto(`/logs?server_id=${forge.id}&source=${encodeURIComponent(source.id)}&range=24h`);
    await expect(page.getByRole("heading", { level: 1, name: "Logs" })).toBeVisible();
    const viewer = page.getByRole("log", { name: `${source.id} log output` });
    await expect(viewer).toBeVisible();
    await expect(page.getByText(/^[\d,]+ lines$/)).not.toHaveText("0 lines");

    /* Level is pushed down to the host: nothing below it comes back. */
    await page.getByLabel("Minimum level").selectOption("warn");
    await expect(page).toHaveURL(/level=warn/);
    const warn = await api.get<Line[]>(
      `/logs/search?server_id=${forge.id}&source=${encodeURIComponent(source.id)}&level=warn&limit=200`,
    );
    expect(warn.length, "the host has warnings in its backlog").toBeGreaterThan(0);
    for (const line of warn) {
      expect(LEVEL_RANK.indexOf(line.level), line.message).toBeGreaterThanOrEqual(LEVEL_RANK.indexOf("warn"));
    }
    /* "warn and above" includes the errors, it does not mean "exactly warn". */
    const all = await api.get<Line[]>(
      `/logs/search?server_id=${forge.id}&source=${encodeURIComponent(source.id)}&limit=500&since=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`,
    );
    if (all.some((line) => line.level === "error")) {
      const worse = await api.get<Line[]>(
        `/logs/search?server_id=${forge.id}&source=${encodeURIComponent(source.id)}&level=warn&limit=500&since=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`,
      );
      // Both reads end at "now"; ignore the oldest lines, which the two
      // windows may not share, and every error in the rest must be kept.
      const shared = [...all].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 400);
      const kept = new Set(worse.map((line) => `${line.ts}|${line.message}`));
      for (const line of shared.filter((l) => l.level === "error")) {
        expect(kept.has(`${line.ts}|${line.message}`), line.message).toBe(true);
      }
    }

    /* A substring nobody logs empties the view, and says why. */
    await page.getByLabel("Minimum level").selectOption("");
    await page.getByLabel("Search log lines on the host").fill("e2e-no-such-line-9f3a");
    await expect(page).toHaveURL(/q=e2e-no-such-line-9f3a/);
    await expect(page.getByText("No log line in this range matches these filters")).toBeVisible();

    /* Filters live in the URL, so a reload keeps exactly this view. */
    await page.reload();
    await expect(page.getByLabel("Search log lines on the host")).toHaveValue("e2e-no-such-line-9f3a");
    await expect(page.getByText("No log line in this range matches these filters")).toBeVisible();
  });

  test("a live tail follows new lines and stops when asked", async ({ page }) => {
    const forge = await server("forge-01");
    const api = await owner();
    const sources = await api.get<Source[]>(`/logs/sources?server_id=${forge.id}&per_page=200`);
    const source = sources.find((s) => s.id === "journal") ?? sources[0]!;

    await page.goto(`/logs?server_id=${forge.id}&source=${encodeURIComponent(source.id)}`);
    const live = page.getByRole("button", { name: "Live tail" });
    await expect(live).toBeEnabled();
    await live.click();
    await expect(page.getByText("streaming")).toBeVisible();

    const counter = page.getByText(/^[\d,]+ lines$/);
    const count = async () => Number((await counter.innerText()).split(" ")[0]!.replace(/,/g, ""));
    await expect.poll(count, { timeout: 45_000 }).toBeGreaterThan(0);
    const first = await count();
    await expect.poll(count, { timeout: 60_000, message: "the tail opened but never followed" }).toBeGreaterThan(first);

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("streaming")).toBeHidden();
    await expect(page.getByRole("button", { name: "Live tail" })).toBeVisible();
  });

  test("a tail needs one host and one source; bad requests say what is missing", async ({ page }) => {
    await page.goto("/logs");
    await expect(page.getByRole("button", { name: "Live tail" })).toBeDisabled();

    const api = await owner();
    const forge = await server("forge-01");
    const noSource = await api.call("GET", `/logs/tail?server_id=${forge.id}`);
    expect(noSource.status).toBe(400);
    expect(noSource.error?.message).toBe("A log source is required to open a tail.");
    const noHost = await api.call("GET", `/logs/sources?server_id=${missingId}`);
    expect(noHost.status).toBe(404);
    const badLevel = await api.call("GET", `/logs/search?server_id=${forge.id}&level=loud`);
    expect(badLevel.status).toBe(422);
  });
});
