import { expect, test } from "@playwright/test";
import { missingId } from "../support/config.js";
import {
  api,
  drawerJob,
  expectJobStatus,
  field,
  get,
  rowWith,
  settledJob,
  type JobRow,
} from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — deployments.
 *
 * A deployment is a row with its own lifecycle (queued → building →
 * succeeded) driven by a job. The journeys follow both: the job pill in
 * the drawer and the deployment row it is meant to move. A rollback is
 * itself a deployment, so it has to finish like one — a rollback row
 * left "queued" counts as in flight and blocks every later deploy of
 * the site, which is the failure the second half of this file exists
 * to catch.
 * ------------------------------------------------------------------ */

interface SiteRow {
  id: string;
  name: string;
}

interface DeploymentRow {
  id: string;
  site_id: string;
  status: string;
  commit_sha: string | null;
  job_id: string | null;
  triggered_by_name: string | null;
  created_at: string;
}

async function site(name: string): Promise<SiteRow> {
  const rows = await get<SiteRow[]>(`/sites?q=${name}`);
  const found = rows.find((s) => s.name === name);
  if (!found) throw new Error(`no site ${name}`);
  return found;
}

async function deploymentsOf(siteId: string): Promise<DeploymentRow[]> {
  return get<DeploymentRow[]>(`/deployments?site_id=${siteId}&per_page=100`);
}

/** Waits until nothing for the site is queued or running, so journeys do not race. */
async function quiet(siteId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await deploymentsOf(siteId)).filter((d) =>
          ["queued", "building", "deploying"].includes(d.status),
        ).length,
      { message: "a deployment for the site never finished", timeout: 60_000 },
    )
    .toBe(0);
}

/* ------------------------------ trigger ------------------------------ */

test("a deploy runs as a job, moves its row to succeeded and keeps its log", async ({ page }) => {
  const www = await site("futureforge-www");
  await quiet(www.id);
  const before = await deploymentsOf(www.id);

  await page.goto(`/websites/sites/${www.id}`);
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Deploy futureforge-www" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Branch").fill("main");
  await dialog.getByRole("button", { name: "Start deployment" }).click();
  await expect(dialog).toBeHidden();

  await expectJobStatus(drawerJob(page, "Deploy", "futureforge-www"), "Succeeded");
  await page.keyboard.press("Escape");

  /* One new deployment, and it finished — not merely its job. */
  const after = await deploymentsOf(www.id);
  expect(after).toHaveLength(before.length + 1);
  const newest = after.find((d) => !before.some((b) => b.id === d.id))!;
  await expect
    .poll(async () => (await get<DeploymentRow>(`/deployments/${newest.id}`)).status)
    .toBe("succeeded");
  expect(newest.triggered_by_name).toBeTruthy();

  /* The site's own history shows it on top. */
  await page.getByRole("tab", { name: /Deployments/ }).click();
  const history = page.getByRole("table", { name: "Deployments" });
  await expect(history.locator("tbody tr").first()).toContainText("Succeeded");

  /* And the run's page carries the job's log. */
  await page.goto(`/websites/deployments/${newest.id}`);
  await expect(page.getByText("Succeeded").first()).toBeVisible();
  await expect(page.getByRole("log").first()).toContainText("deployment started");
});

test("a site without a repository can only be deployed from an upload", async ({ page }) => {
  const shop = await site("legacy-shop");
  await quiet(shop.id);
  await page.goto(`/websites/sites/${shop.id}`);
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Deploy legacy-shop" });

  await dialog.getByRole("button", { name: "Start deployment" }).click();
  const refusal = dialog.getByRole("alert").filter({ hasText: "precondition_failed" });
  await expect(refusal).toContainText(
    "legacy-shop has no repository configured, so there is nothing to deploy.",
  );
  await expect(refusal.getByRole("button", { name: "Site settings" })).toBeVisible();

  await field(dialog, "Source").selectOption("upload");
  await expect(field(dialog, "Repository")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Start deployment" }).click();
  await expect(dialog).toBeHidden();
  await expectJobStatus(drawerJob(page, "Deploy", "legacy-shop"), "Succeeded");
});

test("the revision field is checked, and redeploying the running commit needs force", async ({
  page,
}) => {
  const www = await site("futureforge-www");
  await quiet(www.id);
  const running = (await deploymentsOf(www.id)).find(
    (d) => d.status === "succeeded" && d.commit_sha,
  )!;

  await page.goto(`/websites/sites/${www.id}`);
  await page.getByRole("button", { name: "Deploy", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Deploy futureforge-www" });

  await field(dialog, "Revision").fill("not-a-sha");
  await dialog.getByRole("button", { name: "Start deployment" }).click();
  await expect(
    dialog.getByText("Must be a git object id — 7 to 40 hexadecimal characters."),
  ).toBeVisible();
  /* Boundary: six characters is one short of the shortest object id. */
  await field(dialog, "Revision").fill("abcdef");
  await expect(
    dialog.getByText("Must be a git object id — 7 to 40 hexadecimal characters."),
  ).toBeVisible();

  await field(dialog, "Revision").fill(running.commit_sha!);
  await dialog.getByRole("button", { name: "Start deployment" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "conflict" })).toContainText(
    `futureforge-www already runs ${running.commit_sha}.`,
  );

  await dialog.getByLabel("Deploy even if this revision already runs").check();
  await dialog.getByRole("button", { name: "Start deployment" }).click();
  await expect(dialog).toBeHidden();
  await expectJobStatus(drawerJob(page, "Deploy", "futureforge-www"), "Succeeded");
});

/* ------------------------------ rollback ----------------------------- */

test("rolling back finishes as a deployment and leaves the site deployable", async ({ page }) => {
  const docs = await site("forgebase-docs");
  await quiet(docs.id);
  const history = await deploymentsOf(docs.id);
  /* A seeded run that succeeded and still has its release on disk. */
  const target = history.filter((d) => d.status === "succeeded" && d.commit_sha)[1]!;

  await page.goto(`/websites/deployments/${target.id}`);
  await page.getByRole("button", { name: "Roll back to this" }).click();
  const confirm = page.getByRole("dialog", { name: "Roll back to this release?" });
  await confirm.getByRole("button", { name: "Roll back" }).click();
  await expect(confirm).toBeHidden();

  await expectJobStatus(drawerJob(page, "Roll back deployment", "forgebase-docs"), "Succeeded");
  await page.keyboard.press("Escape");

  /* The rollback is the newest row, pinned to the target's revision, and
   * it finished — it is not sitting in "queued" holding the site hostage. */
  const after = await deploymentsOf(docs.id);
  expect(after).toHaveLength(history.length + 1);
  const rollback = after.find((d) => !history.some((h) => h.id === d.id))!;
  expect(rollback.commit_sha).toBe(target.commit_sha);
  await expect
    .poll(async () => (await get<DeploymentRow>(`/deployments/${rollback.id}`)).status)
    .toBe("succeeded");

  await page.goto(`/websites/deployments?site_id=${docs.id}`);
  const table = page.getByRole("table", { name: "Deployments" });
  await expect(table.locator("tbody tr").first()).toContainText("Succeeded");

  /* So the next deploy of the site is accepted rather than refused as
   * "already in flight". */
  const next = await api<{ job: JobRow }>("POST", "/deployments", { site_id: docs.id });
  expect(next.status, next.error?.message).toBe(202);
  expect((await settledJob(next.data.job.id)).status).toBe("succeeded");
});

test("a run that failed has no release to roll back to", async ({ page }) => {
  const docs = await site("forgebase-docs");
  const failed = (await deploymentsOf(docs.id)).find((d) => d.status === "failed")!;

  await page.goto(`/websites/deployments/${failed.id}`);
  await expect(page.getByText("Failed").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Roll back to this" })).toBeDisabled();

  const refused = await api("POST", `/deployments/${failed.id}/rollback`);
  expect(refused.status).toBe(409);
  expect(refused.error?.message).toContain("never finished, so there is no release to go back to.");
});

test("the deployments list filters by status and opens a run", async ({ page }) => {
  await page.goto("/websites/deployments");
  await expect(page.getByRole("heading", { level: 1, name: "Deployments" })).toBeVisible();
  const table = page.getByRole("table", { name: "Deployments" });
  await page.getByRole("combobox", { name: "Status" }).selectOption("failed");
  /* Wait for the filtered page itself, not for whatever rows were there. */
  await expect
    .poll(async () => {
      const rows = await table.locator("tbody tr").allInnerTexts();
      return rows.length > 0 && rows.every((text) => text.includes("Failed"));
    })
    .toBe(true);

  await rowWith(table, "Failed").first().getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Open build log" }).click();
  await expect(page).toHaveURL(/\/websites\/deployments\/[0-9a-f-]{36}$/);
});

test("a deployment that does not exist says so by id", async ({ page }) => {
  await page.goto(`/websites/deployments/${missingId}`);
  await expect(page.getByRole("alert").filter({ hasText: "not_found" })).toContainText(
    `Deployment ${missingId} not found.`,
  );
});
