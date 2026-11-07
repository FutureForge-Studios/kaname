import { expect, test, type Page } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import {
  binaryBytes,
  data,
  jobSucceeds,
  qs,
  settle,
  unique,
  uploadBytes,
} from "../support/data.js";
import { sectionNamed } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Files — storage usage.
 *
 * The breakdown is a cached sample (KD-012), so it is allowed to be old
 * — but it must say how old, and taking a sample has to replace it with
 * what the host reports now. The second half is checked with a file of
 * known size written just for the purpose: if the sample cannot see it,
 * the page is showing something other than the host.
 * ------------------------------------------------------------------ */

const HOST = "forge-01";
let serverId = "";

interface Breakdown {
  sampled_at: string;
  total: number;
  used: number;
  mounts: { mount: string }[];
  categories: { label: string; path: string; bytes: number }[];
  largest: { path: string; bytes: number }[];
}

test.beforeAll(async () => {
  serverId = (await serverNamed(HOST)).id;
});

async function openStorage(page: Page): Promise<void> {
  await page.goto(`/files/storage?${qs({ server_id: serverId })}`);
  await expect(page.getByRole("heading", { level: 1, name: "Storage" })).toBeVisible();
}

test("shows capacity, mounts, categories and the largest directories with the sample's age", async ({
  page,
}) => {
  await openStorage(page);
  const breakdown = await data<Breakdown>("GET", `/storage?${qs({ server_id: serverId })}`);

  await expect(page.getByText("Capacity", { exact: true })).toBeVisible();
  await expect(page.getByText(/^sampled /)).toBeVisible();

  const mounts = page.getByRole("table", { name: "Mounted filesystems" });
  for (const mount of breakdown.mounts) {
    await expect(mounts.locator("tbody tr").filter({ hasText: mount.mount }).first()).toBeVisible();
  }

  const categories = sectionNamed(page, "What the space is spent on");
  for (const category of breakdown.categories) {
    await expect(categories.getByText(category.label, { exact: true }).first()).toBeVisible();
  }

  const largest = page.getByRole("table", { name: "Largest directories" });
  await expect(largest.locator("tbody tr").first()).toBeVisible();
  await page.getByLabel("Filter largest directories").fill("no-such-path-anywhere");
  await expect(page.getByText("No matching paths")).toBeVisible();
});

test("taking a sample replaces the breakdown with what the host reports now", async ({ page }) => {
  const before = await data<Breakdown>("GET", `/storage?${qs({ server_id: serverId })}`);
  await openStorage(page);

  await page.getByRole("button", { name: "Take a sample" }).click();
  await jobSucceeds(page, "Compute storage usage", HOST);

  /* The cached sample moved: newer than the one we started with, and
   * shaped like forge-01's simulated disks rather than the seed's. */
  await expect
    .poll(
      async () =>
        (await data<Breakdown>("GET", `/storage?${qs({ server_id: serverId })}`)).sampled_at,
      {
        message: "a finished sample never replaced the cached breakdown",
        timeout: 20_000,
      },
    )
    .not.toBe(before.sampled_at);

  const after = await data<Breakdown>("GET", `/storage?${qs({ server_id: serverId })}`);
  expect(Date.now() - Date.parse(after.sampled_at)).toBeLessThan(5 * 60_000);
  const live = await data<{ latest: { disks: { mount: string }[] } | null }>(
    "GET",
    `/servers/${serverId}`,
  );
  expect(after.largest.length).toBeGreaterThan(0);
  expect(after.mounts.map((m) => m.mount).sort()).toEqual(
    (live.latest?.disks ?? []).map((m) => m.mount).sort(),
  );

  await page.reload();
  await expect(
    page.getByText(/^sampled (just now|\d+s ago|\d+ seconds? ago|a few seconds ago)/),
  ).toBeVisible();
});

test("a subtree sample sees a file written just before it", async ({ page }) => {
  const dir = `/srv/${unique("e2e-storage-")}`;
  const size = 3 * 1024 * 1024;
  /* Real bytes, uploaded: the sample must account for them. */
  const mk = await data<{ job: { id: string } }>("POST", "/files/mkdir", {
    server_id: serverId,
    path: dir,
  });
  expect((await settle(mk.job.id)).status).toBe("succeeded");
  expect(await uploadBytes(serverId, dir, "payload.bin", binaryBytes(size))).toBe(201);

  await openStorage(page);
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitem", { name: "Sample a subtree…" }).click();
  const dialog = page.getByRole("dialog", { name: "Sample a subtree" });

  const start = dialog.getByLabel("Start at");
  await start.fill("/srv/../etc");
  await expect(dialog.getByText("Give an absolute path with no traversal segments.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Take sample" })).toBeDisabled();
  await start.fill("srv");
  await expect(dialog.getByRole("button", { name: "Take sample" })).toBeDisabled();

  await start.fill("/srv");
  await dialog.getByLabel("Depth").selectOption("1");
  await dialog.getByRole("button", { name: "Take sample" }).click();
  await jobSucceeds(page, "Compute storage usage", HOST);

  await expect
    .poll(
      async () =>
        (await data<Breakdown>("GET", `/storage?${qs({ server_id: serverId })}`)).largest.find(
          (entry) => entry.path === dir,
        )?.bytes ?? -1,
      { message: `the sample never reported ${dir}`, timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(size);

  await page.reload();
  const largest = page.getByRole("table", { name: "Largest directories" });
  await page.getByLabel("Filter largest directories").fill(dir);
  await expect(largest.locator("tbody tr").filter({ hasText: dir })).toBeVisible();
});
