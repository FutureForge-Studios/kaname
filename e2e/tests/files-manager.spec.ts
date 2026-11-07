import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { agentStateRoot } from "../support/config.js";
import {
  binaryBytes,
  call,
  connectionOf,
  data,
  jobSucceeds,
  qs,
  settle,
  unique,
} from "../support/data.js";
import { cellAt, columnIndex } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Files — the file manager, end to end on forge-01.
 *
 * Every assertion about a mutation is checked twice: once on the page
 * (the job pill, the row that appears) and once against the host itself
 * through the API, so "the editor said saved" can never stand in for
 * "the agent holds these bytes".
 *
 * Each test works in its own directory under /srv so they cannot see
 * each other's files, and nothing here depends on another test having
 * run first.
 * ------------------------------------------------------------------ */

const HOST = "forge-01";
let serverId = "";
let root = "";

interface Listing {
  entries: {
    name: string;
    path: string;
    kind: string;
    size: number;
    mode: string;
    owner: string;
    group: string;
  }[];
}
interface Content {
  content: string;
  encoding: "utf8" | "base64";
  size: number;
}

test.beforeAll(async () => {
  serverId = (await serverNamed(HOST)).id;
  root = `/srv/${unique("e2e-files-")}`;
  const { job } = await data<{ job: { id: string } }>("POST", "/files/mkdir", {
    server_id: serverId,
    path: root,
    parents: true,
  });
  expect((await settle(job.id)).status).toBe("succeeded");
});

/* ------------------------------ helpers ------------------------------ */

async function mkdir(path: string): Promise<void> {
  const { job } = await data<{ job: { id: string } }>("POST", "/files/mkdir", {
    server_id: serverId,
    path,
    parents: true,
  });
  expect((await settle(job.id)).status).toBe("succeeded");
}

async function writeText(path: string, content: string): Promise<void> {
  const { job } = await data<{ job: { id: string } }>("POST", "/files/write", {
    server_id: serverId,
    path,
    content,
    encoding: "utf8",
    create_parents: true,
  });
  expect((await settle(job.id)).status).toBe("succeeded");
}

async function listing(path: string): Promise<Listing["entries"]> {
  return (
    await data<Listing>("GET", `/files?${qs({ server_id: serverId, path, show_hidden: true })}`)
  ).entries;
}

async function readBack(path: string): Promise<Content> {
  return data<Content>("GET", `/files/read?${qs({ server_id: serverId, path })}`);
}

async function open(page: Page, path: string): Promise<Locator> {
  await page.goto(`/files/manager?${qs({ server_id: serverId, path })}`);
  await expect(page.getByRole("heading", { level: 1, name: "File Manager" })).toBeVisible();
  const table = page.getByRole("table", { name: "Directory listing" });
  await expect(table).toBeVisible();
  /* The toolbar arms once the listing has said this account may write;
   * a file handed to the picker before then is dropped by design. */
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
  return table;
}

function rowFor(table: Locator, path: string): Locator {
  return table.locator("tbody tr").filter({ has: table.page().locator(`[title="${path}"]`) });
}

async function rowAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole("button", { name: "Row actions" }).click();
  /* A file that only downloads lists "Download" twice: as its open
   * action and as the download action. Either does the same. */
  await page.getByRole("menuitem", { name: action, exact: true }).first().click();
}

function sha(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/* ------------------------------ browsing ----------------------------- */

test("browses the seeded tree with breadcrumbs, the parent button, hidden files and reload", async ({
  page,
}) => {
  const table = await open(page, "/home/deploy/projects/storefront");

  await expect(rowFor(table, "/home/deploy/projects/storefront/README.md")).toBeVisible();
  await expect(rowFor(table, "/home/deploy/projects/storefront/package.json")).toBeVisible();

  /* The breadcrumb names every ancestor and marks where we are. */
  const crumbs = page.getByRole("navigation", { name: "Path" });
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("storefront");
  await crumbs.getByRole("button", { name: "deploy", exact: true }).click();
  await expect(page).toHaveURL(/path=%2Fhome%2Fdeploy(&|$)/);
  await expect(rowFor(table, "/home/deploy/deploy.sh")).toBeVisible();

  /* Directories sort first, and dotfiles stay hidden until asked for. */
  await expect(table.locator("tbody tr").first()).toContainText("projects");
  await expect(rowFor(table, "/home/deploy/.bashrc")).toHaveCount(0);
  await page.getByRole("switch", { name: "Hidden" }).check();
  await expect(rowFor(table, "/home/deploy/.bashrc")).toBeVisible();

  /* The tree holds the current directory selected. */
  const tree = page.getByRole("tree", { name: "Directory tree" });
  await expect(tree.getByRole("treeitem", { name: "deploy", selected: true })).toBeVisible();

  /* Row click descends; the parent button climbs. */
  await rowFor(table, "/home/deploy/projects").click();
  await expect(page).toHaveURL(/path=%2Fhome%2Fdeploy%2Fprojects(&|$)/);
  await expect(rowFor(table, "/home/deploy/projects/storefront")).toBeVisible();
  await page.getByRole("button", { name: "Parent directory" }).click();
  await expect(page).toHaveURL(/path=%2Fhome%2Fdeploy(&|$)/);

  /* A reload lands on the same directory, read fresh from the host. */
  await page.reload();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("deploy");
  await expect(rowFor(table, "/home/deploy/deploy.sh")).toBeVisible();
});

test("a path that does not exist and an empty directory each say what they are", async ({
  page,
}) => {
  const missing = `${root}/never-created`;
  await page.goto(`/files/manager?${qs({ server_id: serverId, path: missing })}`);
  const alert = page.getByRole("alert").filter({ hasText: "not_found" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("never-created");

  const empty = `${root}/${unique("empty-")}`;
  await mkdir(empty);
  await open(page, empty);
  await expect(page.getByText("This directory is empty")).toBeVisible();
  await expect(page.getByText(`Nothing lives in ${empty} yet.`)).toBeVisible();
});

/* --------------------------- create and edit ------------------------- */

test("creates a folder through the dialog, with its name validated first", async ({ page }) => {
  const table = await open(page, root);
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  const name = dialog.getByLabel(/^Name/);
  const create = dialog.getByRole("button", { name: "Create folder" });

  await name.fill("..");
  await expect(dialog.getByText("That is not a name a file can have.")).toBeVisible();
  await expect(create).toBeDisabled();

  await name.fill("a/b");
  await expect(dialog.getByText("A name cannot contain a path separator.")).toBeVisible();
  await expect(create).toBeDisabled();

  const folder = unique("releases-");
  await name.fill(folder);
  await expect(dialog.getByText(`${root}/${folder}`)).toBeVisible();
  await create.click();
  await expect(dialog).toBeHidden();

  await jobSucceeds(page, "Create directory", `${root}/${folder}`);
  await expect(rowFor(table, `${root}/${folder}`)).toBeVisible();

  const entry = (await listing(root)).find((e) => e.name === folder);
  expect(entry?.kind).toBe("directory");
});

test("creates a file, edits it in the editor and saves it byte for byte", async ({ page }) => {
  const dir = `${root}/${unique("edit-")}`;
  await mkdir(dir);
  const table = await open(page, dir);

  await page.getByRole("button", { name: "New file" }).click();
  const dialog = page.getByRole("dialog", { name: "New file" });
  await dialog.getByLabel(/^Name/).fill("app.conf");
  await dialog.getByRole("button", { name: "Create file" }).click();
  await jobSucceeds(page, "Write file", `${dir}/app.conf`);

  const row = rowFor(table, `${dir}/app.conf`);
  await expect(row).toBeVisible();
  await row.click();

  const pane = page.getByRole("region", { name: `File ${dir}/app.conf` });
  await expect(pane).toBeVisible();
  const editor = pane.locator(".cm-content");
  await expect(editor).toBeVisible();

  const text = "listen 8080;\nserver_name café.example — ünïcode ✓;\n";
  await editor.click();
  await page.keyboard.insertText(text);
  await expect(pane.getByText("unsaved")).toBeVisible();

  await pane.getByRole("button", { name: "Save" }).click();
  await jobSucceeds(page, "Write file", `${dir}/app.conf`);
  await expect(pane.getByText("unsaved")).toBeHidden();

  const stored = await readBack(`${dir}/app.conf`);
  expect(stored.encoding).toBe("utf8");
  expect(stored.content).toBe(text);
  expect(stored.size).toBe(Buffer.byteLength(text, "utf8"));

  /* Closing with unsaved edits asks first; keeping them open is the default. */
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("# draft\n");
  await pane.getByRole("button", { name: "Close file" }).click();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(pane).toBeHidden();
  expect((await readBack(`${dir}/app.conf`)).content).toBe(text);

  /* Reopening reads the host again, not the discarded draft. */
  await rowFor(table, `${dir}/app.conf`).click();
  await expect(
    page.getByRole("region", { name: `File ${dir}/app.conf` }).locator(".cm-content"),
  ).toHaveText(/listen 8080;/);
  await expect(page.getByRole("region", { name: `File ${dir}/app.conf` })).not.toContainText(
    "# draft",
  );
});

/* --------------------------- upload/download ------------------------- */

async function upload(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator('input[type="file"]').setInputFiles(files);
}

async function download(page: Page, table: Locator, path: string): Promise<Buffer> {
  const row = rowFor(table, path);
  const pending = page.waitForEvent("download");
  await rowAction(page, row, "Download");
  const file = await pending;
  const saved = await file.path();
  return readFile(saved);
}

test("uploads text and binary files and downloads both back identical", async ({ page }) => {
  const dir = `${root}/${unique("transfer-")}`;
  await mkdir(dir);
  const table = await open(page, dir);

  const text = Buffer.from("line one\r\nline two — utf-8 ✓\n\u0000tail", "utf8");
  const binary = binaryBytes(300_000);

  await upload(page, [
    { name: "notes.txt", mimeType: "text/plain", buffer: text },
    { name: "blob.bin", mimeType: "application/octet-stream", buffer: binary },
  ]);

  const uploads = page.getByRole("region", { name: "Uploads" });
  await expect(uploads.getByRole("listitem").filter({ hasText: "notes.txt" })).toContainText(
    "Uploaded",
  );
  await expect(uploads.getByRole("listitem").filter({ hasText: "blob.bin" })).toContainText(
    "Uploaded",
  );

  await expect(rowFor(table, `${dir}/notes.txt`)).toBeVisible();
  await expect(rowFor(table, `${dir}/blob.bin`)).toBeVisible();

  const entries = await listing(dir);
  expect(entries.find((e) => e.name === "notes.txt")?.size).toBe(text.length);
  expect(entries.find((e) => e.name === "blob.bin")?.size).toBe(binary.length);

  expect(sha(await download(page, table, `${dir}/notes.txt`))).toBe(sha(text));
  expect(sha(await download(page, table, `${dir}/blob.bin`))).toBe(sha(binary));

  /* Uploading the same name again does not clobber it. */
  await upload(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("other") }]);
  const second = uploads.getByRole("listitem").filter({ hasText: "notes.txt" }).last();
  await expect(second).toContainText(/already exists/);
  expect(sha(await download(page, table, `${dir}/notes.txt`))).toBe(sha(text));
});

test("a large upload streams through and comes back intact", async ({ page }) => {
  test.setTimeout(240_000);
  const dir = `${root}/${unique("large-")}`;
  await mkdir(dir);
  const table = await open(page, dir);

  const big = binaryBytes(24 * 1024 * 1024, 99);
  await upload(page, [{ name: "big.bin", mimeType: "application/octet-stream", buffer: big }]);

  const uploads = page.getByRole("region", { name: "Uploads" });
  await expect(uploads.getByRole("listitem").filter({ hasText: "big.bin" })).toContainText(
    "Uploaded",
    {
      timeout: 180_000,
    },
  );
  const entry = (await listing(dir)).find((e) => e.name === "big.bin");
  expect(entry?.size).toBe(big.length);

  /* The agent caps a materialised download at its own limit; a real
   * upload has real bytes and must come back whole. */
  expect(sha(await download(page, table, `${dir}/big.bin`))).toBe(sha(big));
});

test("a binary file is never offered to the editor as text", async ({ page }) => {
  const dir = `${root}/${unique("binary-")}`;
  await mkdir(dir);
  const table = await open(page, dir);

  /* A .txt name with bytes that are not UTF-8: the extension says text,
   * the content says otherwise, and the content has to win. */
  await upload(page, [
    { name: "mislabelled.txt", mimeType: "text/plain", buffer: binaryBytes(4096, 3) },
  ]);
  await expect(
    page
      .getByRole("region", { name: "Uploads" })
      .getByRole("listitem")
      .filter({ hasText: "mislabelled.txt" }),
  ).toContainText("Uploaded");

  await rowFor(table, `${dir}/mislabelled.txt`).click();
  const pane = page.getByRole("region", { name: `File ${dir}/mislabelled.txt` });
  await expect(pane.getByText("This file is not text")).toBeVisible();
  await expect(pane.locator(".cm-content")).toHaveCount(0);
  /* Nothing can be written back over the binary from here. */
  await expect(pane.getByRole("button", { name: "Save" })).toBeDisabled();
  await pane.getByRole("button", { name: "Close file" }).click();

  /* A file whose type is binary is a download, straight from the row. */
  await upload(page, [
    { name: "image.iso", mimeType: "application/octet-stream", buffer: binaryBytes(2048, 5) },
  ]);
  const row = rowFor(table, `${dir}/image.iso`);
  await expect(row).toBeVisible();
  const pending = page.waitForEvent("download");
  await row.click();
  const file = await pending;
  expect(sha(await readFile((await file.path())!))).toBe(sha(binaryBytes(2048, 5)));
});

/* ------------------------- rename, move, copy ------------------------ */

test("renames, copies and moves entries, and refuses to move a folder into itself", async ({
  page,
}) => {
  const dir = `${root}/${unique("shuffle-")}`;
  await writeText(`${dir}/a.txt`, "alpha\n");
  await mkdir(`${dir}/sub`);
  const table = await open(page, dir);

  /* Rename. */
  await rowAction(page, rowFor(table, `${dir}/a.txt`), "Rename");
  const rename = page.getByRole("dialog", { name: "Rename" });
  const renameButton = rename.getByRole("button", { name: "Rename" });
  await expect(renameButton).toBeDisabled(); // unchanged name
  await rename.getByLabel("New name").fill("b.txt");
  await renameButton.click();
  await jobSucceeds(page, "Move", `${dir}/a.txt`);
  await expect(rowFor(table, `${dir}/b.txt`)).toBeVisible();
  await expect(rowFor(table, `${dir}/a.txt`)).toHaveCount(0);

  /* Copy into the subdirectory: both exist afterwards. */
  await rowAction(page, rowFor(table, `${dir}/b.txt`), "Copy");
  const copy = page.getByRole("dialog", { name: "Copy" });
  const destination = copy.getByLabel("Destination directory");
  await expect(destination).toHaveValue(dir);
  await expect(copy.getByText("That is where these already are.")).toBeVisible();
  await destination.fill("relative/path");
  await expect(copy.getByText("Give an absolute path, starting at /.")).toBeVisible();
  await destination.fill(`${dir}/../etc`);
  await expect(copy.getByText("Path traversal is not allowed.")).toBeVisible();
  await expect(copy.getByRole("button", { name: "Copy" })).toBeDisabled();
  await destination.fill(`${dir}/sub`);
  await copy.getByRole("button", { name: "Copy" }).click();
  await jobSucceeds(page, "Copy", `${dir}/b.txt`);
  expect((await readBack(`${dir}/sub/b.txt`)).content).toBe("alpha\n");
  expect((await readBack(`${dir}/b.txt`)).content).toBe("alpha\n");

  /* Moving onto an existing name without overwrite fails on the host. */
  await rowAction(page, rowFor(table, `${dir}/b.txt`), "Move");
  const move = page.getByRole("dialog", { name: "Move" });
  await move.getByLabel("Destination directory").fill(`${dir}/sub`);
  await move.getByRole("button", { name: "Move" }).click();
  const drawer = page.getByRole("dialog", { name: "Job activity" });
  const failed = drawer
    .getByRole("listitem")
    .filter({ hasText: "Move" })
    .filter({ hasText: `${dir}/b.txt` })
    .first();
  await expect(failed).toContainText(/already exists/, { timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(rowFor(table, `${dir}/b.txt`)).toBeVisible();

  /* With overwrite it replaces, and the source is gone. */
  await writeText(`${dir}/b.txt`, "bravo\n");
  await page.getByRole("button", { name: "Re-read this directory" }).click();
  await rowAction(page, rowFor(table, `${dir}/b.txt`), "Move");
  await move.getByLabel("Destination directory").fill(`${dir}/sub`);
  await move.getByRole("switch", { name: "Overwrite what is already there" }).check();
  await move.getByRole("button", { name: "Move" }).click();
  await jobSucceeds(page, "Move", `${dir}/b.txt`);
  await expect(rowFor(table, `${dir}/b.txt`)).toHaveCount(0);
  expect((await readBack(`${dir}/sub/b.txt`)).content).toBe("bravo\n");

  /* A directory into its own child is refused before any job exists. */
  const intoItself = await call("POST", "/files/move", {
    server_id: serverId,
    from: `${dir}/sub`,
    to: `${dir}/sub/deeper/sub`,
  });
  expect(intoItself.status).toBe(409);
  expect(intoItself.body.error?.message).toBe(`Cannot move ${dir}/sub into itself.`);
  const same = await call("POST", "/files/move", {
    server_id: serverId,
    from: `${dir}/sub`,
    to: `${dir}/sub`,
  });
  expect(same.status).toBe(400);
  expect(same.body.error?.fields?.["to"]).toBe("must differ from `from`");
});

/* --------------------------- chmod / chown --------------------------- */

test("changes mode and ownership, with bad modes and owners refused by field", async ({ page }) => {
  const dir = `${root}/${unique("perm-")}`;
  await writeText(`${dir}/secret.key`, "k\n");
  const table = await open(page, dir);
  const row = rowFor(table, `${dir}/secret.key`);
  const modeColumn = await columnIndex(table, "Mode");
  const ownerColumn = await columnIndex(table, "Owner");
  await expect(cellAt(row, modeColumn)).toHaveText("-rw-r--r--");

  await rowAction(page, row, "Permissions");
  const chmod = page.getByRole("dialog", { name: "Permissions" });
  const mode = chmod.getByLabel("Octal mode");
  await expect(mode).toHaveValue("0644");
  for (const bad of ["999", "12", "0o644", "77777"]) {
    await mode.fill(bad);
    await expect(chmod.getByText("Modes look like 0644.")).toBeVisible();
    await expect(chmod.getByRole("button", { name: "Apply mode" })).toBeDisabled();
  }
  await mode.fill("0600");
  await expect(chmod.getByText("-rw-------")).toBeVisible();
  await chmod.getByRole("button", { name: "Apply mode" }).click();
  await jobSucceeds(page, "Change permissions", `${dir}/secret.key`);
  await expect(cellAt(row, modeColumn)).toHaveText("-rw-------");
  expect((await listing(dir)).find((e) => e.name === "secret.key")?.mode).toMatch(/^0?600$/);

  /* The API holds the same line the dialog does, by field. */
  const badMode = await call("POST", "/files/chmod", {
    server_id: serverId,
    paths: [`${dir}/secret.key`],
    mode: "0888",
  });
  expect(badMode.status).toBe(422);
  expect(badMode.body.error?.fields?.["mode"]).toBe("must be an octal mode like 0644");

  await rowAction(page, row, "Ownership");
  const chown = page.getByRole("dialog", { name: "Ownership" });
  await chown.getByLabel("Owner").fill("9bad");
  await chown.getByRole("button", { name: "Apply ownership" }).click();
  await expect(chown.getByText("must start with a letter or underscore")).toBeVisible();
  await expect(chown).toBeVisible();

  await chown.getByLabel("Owner").fill("www-data");
  await chown.getByLabel("Group").fill("deploy");
  await chown.getByRole("button", { name: "Apply ownership" }).click();
  await jobSucceeds(page, "Change ownership", `${dir}/secret.key`);
  await expect(cellAt(row, ownerColumn)).toHaveText("www-data:deploy");

  const neither = await call("POST", "/files/chown", {
    server_id: serverId,
    paths: [`${dir}/secret.key`],
  });
  expect(neither.status).toBe(422);
  expect(JSON.stringify(neither.body.error?.fields)).toContain(
    "specify an owner, a group, or both",
  );
});

/* -------------------------- archive / extract ------------------------ */

for (const format of ["tar.gz", "tar.zst", "zip"] as const) {
  test(`compresses a folder to ${format} and extracts it again`, async ({ page }) => {
    const dir = `${root}/${unique("arch-")}`;
    await writeText(`${dir}/site/index.html`, "<h1>hi</h1>\n");
    const table = await open(page, dir);

    await rowAction(page, rowFor(table, `${dir}/site`), "Compress");
    const dialog = page.getByRole("dialog", { name: "Compress" });
    await dialog.getByLabel("Format").selectOption(format);
    await expect(dialog.getByLabel("Archive name")).toHaveValue(`site.${format}`);
    await dialog.getByRole("button", { name: "Create archive" }).click();
    await jobSucceeds(page, "Create archive", `${dir}/site.${format}`);

    const archive = rowFor(table, `${dir}/site.${format}`);
    await expect(archive).toBeVisible();
    expect((await listing(dir)).find((e) => e.name === `site.${format}`)?.size).toBeGreaterThan(0);

    await rowAction(page, archive, "Extract");
    const extract = page.getByRole("dialog", { name: "Extract" });
    await extract.getByLabel("Destination directory").fill(`${dir}/out`);
    await extract.getByRole("button", { name: "Extract" }).click();
    await jobSucceeds(page, "Extract archive", `${dir}/site.${format}`);

    const out = await listing(`${dir}/out`);
    expect(out.map((e) => e.name)).toContain("site");
    const inner = await listing(`${dir}/out/site`);
    expect(inner.length).toBeGreaterThan(0);

    /* Extracting again over the same files without overwrite stops. */
    await rowAction(page, archive, "Extract");
    await extract.getByLabel("Destination directory").fill(`${dir}/out`);
    await extract.getByRole("button", { name: "Extract" }).click();
    const drawer = page.getByRole("dialog", { name: "Job activity" });
    await expect(
      drawer
        .getByRole("listitem")
        .filter({ hasText: "Extract archive" })
        .filter({ hasText: `${dir}/site.${format}` })
        .first(),
    ).toContainText(/already exists/, { timeout: 30_000 });
    await page.keyboard.press("Escape");
  });
}

/* ------------------------------- delete ------------------------------ */

test("deletes only after the name is typed, and warns about a directory's contents", async ({
  page,
}) => {
  const dir = `${root}/${unique("del-")}`;
  await writeText(`${dir}/doomed.txt`, "x");
  await writeText(`${dir}/tree/leaf.txt`, "y");
  const table = await open(page, dir);

  await rowAction(page, rowFor(table, `${dir}/doomed.txt`), "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete doomed.txt?" });
  const button = confirm.getByRole("button", { name: "Delete" });
  await expect(button).toBeDisabled();
  await confirm.getByLabel(/Type .* to confirm/).fill("doomed");
  await expect(button).toBeDisabled();
  await confirm.getByLabel(/Type .* to confirm/).fill("doomed.txt");
  await button.click();
  await jobSucceeds(page, "Delete", `${dir}/doomed.txt`);
  await expect(rowFor(table, `${dir}/doomed.txt`)).toHaveCount(0);
  expect((await listing(dir)).map((e) => e.name)).not.toContain("doomed.txt");

  /* Cancelling leaves everything where it was. */
  await rowAction(page, rowFor(table, `${dir}/tree`), "Delete");
  const tree = page.getByRole("dialog", { name: "Delete tree?" });
  await expect(
    tree.getByText("One of these is a directory and will be removed with everything inside."),
  ).toBeVisible();
  await tree.getByRole("button", { name: "Cancel" }).click();
  await expect(tree).toBeHidden();
  expect((await listing(dir)).map((e) => e.name)).toContain("tree");

  await rowAction(page, rowFor(table, `${dir}/tree`), "Delete");
  await tree.getByLabel(/Type .* to confirm/).fill("tree");
  await tree.getByRole("button", { name: "Delete" }).click();
  await jobSucceeds(page, "Delete", `${dir}/tree`);
  expect((await listing(dir)).map((e) => e.name)).not.toContain("tree");
});

test("a system directory cannot be deleted from the file manager", async ({ page }) => {
  const table = await open(page, "/");
  await rowAction(page, rowFor(table, "/etc"), "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete etc?" });
  await confirm.getByLabel(/Type .* to confirm/).fill("etc");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(
    confirm.getByText("/etc is a system directory and cannot be deleted from the file manager."),
  ).toBeVisible();
  expect((await listing("/")).map((e) => e.name)).toContain("etc");
});

/* ------------------------- refusals at the edge ---------------------- */

test("traversal and the agent's own key directory are refused at every verb", async ({ page }) => {
  /* Traversal never reaches the agent: the contract refuses it by field. */
  const traversal = await call("GET", `/files?${qs({ server_id: serverId, path: "/srv/../etc" })}`);
  expect(traversal.status).toBe(422);
  expect(traversal.body.error?.fields?.["path"]).toBe("path traversal is not allowed");

  const relative = await call("POST", "/files/write", {
    server_id: serverId,
    path: "etc/passwd",
    content: "x",
  });
  expect(relative.status).toBe(422);
  expect(relative.body.error?.fields?.["path"]).toBe("must be an absolute path");

  const nul = await call("POST", "/files/mkdir", { server_id: serverId, path: "/srv/a\u0000b" });
  expect(nul.status).toBe(422);
  expect(nul.body.error?.fields?.["path"]).toBe("path may not contain a null byte");

  /* The agent's state directory holds its enrollment key. The agent's
   * own guard refuses it whatever the panel does. */
  const keyDir = join(agentStateRoot, HOST);
  const listed = await call("GET", `/files?${qs({ server_id: serverId, path: keyDir })}`);
  expect(listed.status).toBe(403);
  expect(listed.body.error?.message).toContain("path is reserved by the agent");

  const read = await call(
    "GET",
    `/files/read?${qs({ server_id: serverId, path: `${keyDir}/agent.key` })}`,
  );
  expect(read.status).toBe(403);

  const dl = await call(
    "GET",
    `/files/download?${qs({ server_id: serverId, path: `${keyDir}/agent.key` })}`,
  );
  expect(dl.status).toBe(403);

  /* A write is a job; the job fails on the guard, and nothing lands. */
  const { job } = await data<{ job: { id: string } }>("POST", "/files/write", {
    server_id: serverId,
    path: `${keyDir}/agent.key`,
    content: "overwritten",
    create_parents: true,
  });
  const settled = await settle(job.id);
  expect(settled.status).toBe("failed");
  expect(settled.error?.code).toBe("permission_denied");

  /* Archiving the key into somewhere readable is the same refusal. */
  const { job: archiveJob } = await data<{ job: { id: string } }>("POST", "/files/archive", {
    server_id: serverId,
    paths: [keyDir],
    destination: `${root}/stolen.tar.gz`,
    format: "tar.gz",
  });
  expect((await settle(archiveJob.id)).status).toBe("failed");
  expect((await listing(root)).map((e) => e.name)).not.toContain("stolen.tar.gz");

  /* And the browser is told the same, specifically. */
  await page.goto(`/files/manager?${qs({ server_id: serverId, path: keyDir })}`);
  const alert = page.getByRole("alert").filter({ hasText: "forbidden" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("path is reserved by the agent");
});

test("a directory cannot be downloaded or read as a file", async () => {
  const dl = await call("GET", `/files/download?${qs({ server_id: serverId, path: "/etc" })}`);
  expect(dl.status).toBe(409);
  expect(dl.body.error?.message).toBe("/etc is a directory.");
  expect(dl.body.error?.remediation?.summary).toBe("Archive it first, then download the archive.");

  const read = await call("GET", `/files/read?${qs({ server_id: serverId, path: "/etc" })}`);
  expect(read.status).toBe(400);
  expect(read.body.error?.fields?.["path"]).toBe("expected a file");
});

test("a write too large for one agent request fails on its own and leaves the host connected", async () => {
  /* The editor opens files up to 1 MiB, but one agent request is capped
   * at 512 KiB. Sending more used to make the agent drop its whole
   * connection, failing everything else in flight on the host. */
  const path = `${root}/${unique("huge-")}.txt`;
  const { job } = await data<{ job: { id: string } }>("POST", "/files/write", {
    server_id: serverId,
    path,
    content: "x".repeat(700 * 1024),
  });
  const settled = await settle(job.id);
  expect(settled.status).toBe("failed");
  expect(settled.error?.code).toBe("invalid_params");
  expect(settled.error?.message).toMatch(/the agent accepts at most \d+ bytes in one request/);

  expect(await connectionOf(serverId)).toBe("connected");
  expect((await listing(root)).map((e) => e.path)).not.toContain(path);
});
