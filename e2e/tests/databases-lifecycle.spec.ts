import { expect, test, type Locator, type Page } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import { call, codeBlock, data, jobSucceeds, qs, settle, unique } from "../support/data.js";

/* ------------------------------------------------------------------ *
 * Databases — MySQL/MariaDB and PostgreSQL, the same journeys on both.
 *
 * db-01's simulated host runs MariaDB on 3306 and PostgreSQL on 5432.
 * The panel caches databases and users (KD-012) and reconciles them
 * against the host on Sync, which deletes any cached row the host does
 * not report. That is what makes Sync the independent check here: a
 * database that survives a sync exists on the host, and one that is gone
 * after a sync is gone from the host.
 * ------------------------------------------------------------------ */

const HOST = "db-01";

interface Instance {
  id: string;
  engine: string;
  version: string;
  port: number;
  status: string;
}
interface DatabaseRow {
  id: string;
  name: string;
  size_bytes: number;
  table_count: number;
  users: { username: string; privileges: string[] }[];
}
interface DbUserRow {
  id: string;
  username: string;
  host_pattern: string;
  can_login: boolean;
  grants: { database_name: string; privileges: string[] }[];
}

const ENGINES = [
  { group: "mysql", engine: "mariadb", title: "MySQL / MariaDB", port: 3306, scheme: "mysql", hostPatterns: true },
  { group: "postgres", engine: "postgres", title: "PostgreSQL", port: 5432, scheme: "postgresql", hostPatterns: false },
] as const;

let serverId = "";
test.beforeAll(async () => {
  serverId = (await serverNamed(HOST)).id;
});

async function instanceFor(engine: string): Promise<Instance> {
  const rows = await data<Instance[]>("GET", `/db-instances?${qs({ server_id: serverId, per_page: 100 })}`);
  const found = rows.find((row) => row.engine === engine);
  if (!found) throw new Error(`no ${engine} instance on ${HOST}`);
  return found;
}

async function sync(instanceId: string): Promise<void> {
  await data("POST", `/db-instances/${instanceId}/sync`);
}

async function databasesOn(instanceId: string): Promise<DatabaseRow[]> {
  return data<DatabaseRow[]>("GET", `/databases?${qs({ instance_id: instanceId, per_page: 200 })}`);
}

async function usersOn(instanceId: string): Promise<DbUserRow[]> {
  return data<DbUserRow[]>("GET", `/db-users?${qs({ instance_id: instanceId, per_page: 200 })}`);
}

/** A database made through the API, settled, for journeys that start from one. */
async function seedDatabase(instance: Instance, name: string): Promise<DatabaseRow> {
  const res = await data<{ jobs: { id: string }[]; database: DatabaseRow }>("POST", "/databases", {
    instance_id: instance.id,
    engine: instance.engine,
    name,
  });
  for (const job of res.jobs) expect((await settle(job.id)).status).toBe("succeeded");
  return res.database;
}

async function openSection(page: Page, group: string, view?: "users"): Promise<Locator> {
  await page.goto(`/databases/${group}?${qs({ server_id: serverId, view })}`);
  const table = page.getByRole("table", { name: view === "users" ? "Database users" : "Databases" });
  await expect(table).toBeVisible();
  return table;
}

async function rowAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

for (const meta of ENGINES) {
  test.describe(meta.title, () => {
    test("the instance header reflects the host once synced", async ({ page }) => {
      const instance = await instanceFor(meta.engine);
      await openSection(page, meta.group);

      const header = page.locator("section").filter({ has: page.getByRole("heading", { name: new RegExp(`^${meta.engine} `) }) }).first();
      await expect(header).toContainText(`127.0.0.1:${meta.port}`);
      await expect(header).toContainText("reachable");

      await header.getByRole("button", { name: "Sync" }).click();
      await expect(page.getByText(`Re-read ${meta.engine} on ${HOST}.`)).toBeVisible();

      /* The version is now the engine's own answer, not the seed's. */
      const synced = await instanceFor(meta.engine);
      expect(synced.id).toBe(instance.id);
      await expect(page.getByRole("heading", { name: `${meta.engine} ${synced.version}` })).toBeVisible();

      /* And every database the host reports is in the table. */
      const live = await databasesOn(instance.id);
      const table = page.getByRole("table", { name: "Databases" });
      for (const db of live.slice(0, 5)) {
        await page.getByPlaceholder("Search databases").fill(db.name);
        await expect(table.locator("tbody tr").filter({ hasText: db.name }).first()).toBeVisible();
      }
    });

    test("creates a database with its own user and shows the credential exactly once", async ({ page }) => {
      const instance = await instanceFor(meta.engine);
      const table = await openSection(page, meta.group);
      const name = unique("shop_");
      const username = `${name}_app`;

      await page.getByRole("button", { name: "New database" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New database" });
      const submit = dialog.getByRole("button", { name: "Create database" });

      /* Identifiers are checked before anything is sent. */
      await dialog.getByLabel(/^Name/).fill("1shop");
      await expect(dialog.getByText("must start with a letter or underscore, then letters, digits, _ or -")).toBeVisible();
      await expect(submit).toBeDisabled();
      await dialog.getByLabel(/^Name/).fill("shop db");
      await expect(submit).toBeDisabled();
      await dialog.getByLabel(/^Name/).fill(name);

      await dialog.getByLabel("Username").fill(username);
      if (meta.hostPatterns) await expect(dialog.getByLabel("Host pattern")).toHaveValue("localhost");
      else await expect(dialog.getByLabel("Host pattern")).toHaveCount(0);

      /* A hand-typed password has a floor too. */
      await dialog.getByRole("switch", { name: "Generate a password" }).uncheck();
      await dialog.getByLabel(/^Password( \(required\))?$/).fill("short-password");
      await expect(dialog.getByText("at least 16 characters")).toBeVisible();
      await expect(submit).toBeDisabled();
      await dialog.getByRole("switch", { name: "Generate a password" }).check();
      await expect(submit).toBeEnabled();
      await submit.click();

      const credentials = page.getByRole("dialog", { name: "Credentials — shown once" });
      await expect(credentials).toBeVisible();
      const password = ((await codeBlock(credentials, "Password").textContent()) ?? "").trim();
      expect(password.length).toBeGreaterThanOrEqual(16);
      const connection = ((await codeBlock(credentials, "Connection string").textContent()) ?? "").trim();
      expect(connection).toBe(`${meta.scheme}://${username}:${password}@127.0.0.1:${meta.port}/${name}`);
      await credentials.getByRole("button", { name: "I have copied it" }).click();
      await expect(credentials).toBeHidden();

      /* Database, user and grant: three jobs, one operator action. */
      await jobSucceeds(page, "Create database", name);
      const drawer = page.getByRole("dialog", { name: "Job activity" });
      await page.getByRole("button", { name: /^Job activity/ }).first().click();
      for (const label of ["Create database user", "Apply database grants"]) {
        const row = drawer.getByRole("listitem").filter({ hasText: label }).filter({ hasText: username }).first();
        await expect(row.locator('span[title^="Succeeded."]')).toBeVisible({ timeout: 60_000 });
      }
      await page.keyboard.press("Escape");

      await page.getByPlaceholder("Search databases").fill(name);
      const row = table.locator("tbody tr").filter({ hasText: name });
      await expect(row).toBeVisible();
      await expect(row).toContainText(username);

      /* It survives a sync, so the host has it; the password is nowhere in the API. */
      await sync(instance.id);
      const live = (await databasesOn(instance.id)).find((db) => db.name === name);
      expect(live).toBeDefined();
      expect(JSON.stringify(await call("GET", `/databases/${live!.id}`))).not.toContain(password);
      const user = (await usersOn(instance.id)).find((u) => u.username === username);
      expect(user?.grants.map((g) => g.database_name)).toContain(name);
      expect(JSON.stringify(await call("GET", `/db-users/${user!.id}`))).not.toContain(password);

      /* A second database with the same name is refused by the panel, not the host. */
      const dup = await call("POST", "/databases", { instance_id: instance.id, engine: meta.engine, name });
      expect(dup.status).toBe(409);
      expect(dup.body.error?.message).toBe(`${HOST} already has a ${meta.engine} database named "${name}".`);
    });

    test("the create endpoint holds identifiers, engine and password by field", async () => {
      const instance = await instanceFor(meta.engine);
      const spaced = await call("POST", "/databases", { instance_id: instance.id, engine: meta.engine, name: "has space" });
      expect(spaced.status).toBe(422);
      expect(spaced.body.error?.fields?.["name"]).toBe("must start with a letter or underscore");

      const long = await call("POST", "/databases", { instance_id: instance.id, engine: meta.engine, name: `a${"b".repeat(63)}` });
      expect(long.status).toBe(422);
      expect(long.body.error?.fields?.["name"]).toMatch(/at most 63/);

      const other = meta.engine === "postgres" ? "mariadb" : "postgres";
      const wrong = await call("POST", "/databases", { instance_id: instance.id, engine: other, name: unique("x_") });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error?.fields?.["engine"]).toBe(`must be "${meta.engine}" for this instance`);

      const weak = await call("POST", "/db-users", {
        instance_id: instance.id,
        username: unique("weak_"),
        password: "x".repeat(15),
      });
      expect(weak.status).toBe(422);
      expect(weak.body.error?.fields?.["password"]).toMatch(/at least 16/);
    });

    test("creates a user with a grant, edits the grant, rotates its password and drops it", async ({ page }) => {
      const instance = await instanceFor(meta.engine);
      const dbName = unique("grants_");
      await seedDatabase(instance, dbName);
      const username = unique("ro_");
      const table = await openSection(page, meta.group, "users");

      await page.getByRole("button", { name: "New user" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New database user" });
      await dialog.getByLabel("Username").fill("bad name");
      await expect(dialog.getByText("must start with a letter or underscore, then letters, digits, _ or -")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Create user" })).toBeDisabled();
      await dialog.getByLabel("Username").fill(username);
      await expect(dialog.getByText("No grants. The user will exist and be able to authenticate, but reach nothing.")).toBeVisible();

      await dialog.getByLabel("Add a database grant").click();
      await dialog.getByLabel("Add a database grant").fill(dbName);
      await page.getByRole("option", { name: dbName }).click();
      await expect(dialog.getByLabel(`Privileges on ${dbName}`)).toBeVisible();
      await dialog.getByRole("button", { name: "Create user" }).click();

      const credentials = page.getByRole("dialog", { name: "Credentials — shown once" });
      await expect(credentials).toBeVisible();
      await expect(codeBlock(credentials, "User")).toHaveText(meta.hostPatterns ? `${username}@localhost` : username);
      await credentials.getByRole("button", { name: "I have copied it" }).click();
      await jobSucceeds(page, "Create database user", username);

      await page.getByPlaceholder("Search users").fill(username);
      const row = table.locator("tbody tr").filter({ hasText: username });
      await expect(row).toContainText(meta.hostPatterns ? `${username}@localhost` : username);
      await expect(row).toContainText(`${dbName}: ALL`);

      /* Narrow the grant to SELECT. */
      await rowAction(page, row, "Edit grants");
      const grants = page.getByRole("dialog", { name: `Grants for ${username}` });
      const privileges = grants.getByLabel(`Privileges on ${dbName}`);
      await privileges.click();
      await page.getByRole("option", { name: "ALL", exact: true }).click();
      await page.getByRole("option", { name: "SELECT", exact: true }).click();
      await page.keyboard.press("Escape");
      await grants.getByRole("button", { name: "Apply grants" }).click();
      await jobSucceeds(page, "Apply database grants", username);
      await expect(row).toContainText(`${dbName}: SELECT`);
      const stored = (await usersOn(instance.id)).find((u) => u.username === username);
      expect(stored?.grants).toEqual([expect.objectContaining({ database_name: dbName, privileges: ["SELECT"] })]);

      /* Removing every grant revokes on the host, and the dialog says so first. */
      await rowAction(page, row, "Edit grants");
      await grants.getByRole("button", { name: "Remove" }).click();
      await expect(grants.getByText(`Revoking access to ${dbName}.`)).toBeVisible();
      await grants.getByRole("button", { name: "Apply grants" }).click();
      await jobSucceeds(page, "Apply database grants", `revoke ${username} on ${dbName}`);
      await expect(row).toContainText("no databases");

      /* Rotate: short is refused, a good one is shown back once. */
      await rowAction(page, row, "Rotate password");
      const rotate = page.getByRole("dialog", { name: `Rotate password for ${username}` });
      await rotate.getByLabel("New password").fill("too-short");
      await expect(rotate.getByText("at least 16 characters")).toBeVisible();
      await expect(rotate.getByRole("button", { name: "Rotate password" })).toBeDisabled();
      const fresh = `rotated-${unique("")}-passphrase`;
      await rotate.getByLabel("New password").fill(fresh);
      await rotate.getByRole("button", { name: "Rotate password" }).click();
      const shown = page.getByRole("dialog", { name: "Credentials — shown once" });
      await expect(codeBlock(shown, "Password")).toHaveText(fresh);
      await shown.getByRole("button", { name: "I have copied it" }).click();
      await jobSucceeds(page, "Update database user", username);

      /* Drop: typed confirmation, then the host no longer has it. */
      await rowAction(page, row, "Drop user");
      const confirm = page.getByRole("dialog", { name: `Drop ${username}?` });
      await expect(confirm.getByRole("button", { name: "Drop" })).toBeDisabled();
      await confirm.getByLabel(/Type .* to confirm/).fill(username);
      await confirm.getByRole("button", { name: "Drop" }).click();
      await jobSucceeds(page, "Drop database user", username);
      await expect(row).toHaveCount(0);
      await sync(instance.id);
      expect((await usersOn(instance.id)).map((u) => u.username)).not.toContain(username);
    });

    test("updating a user's host pattern in place is refused with the way forward", async () => {
      const instance = await instanceFor(meta.engine);
      const res = await data<{ jobs: { id: string }[]; db_user: DbUserRow }>("POST", "/db-users", {
        instance_id: instance.id,
        username: unique("pattern_"),
      });
      for (const job of res.jobs) await settle(job.id);
      const moved = await call("PATCH", `/db-users/${res.db_user.id}`, { host_pattern: "%" });
      expect(moved.status).toBe(412);
      expect(moved.body.error?.code).toBe("precondition_failed");
    });

    test("samples size live, dumps to a file on the host and restores from it", async ({ page }) => {
      const instance = await instanceFor(meta.engine);
      const name = unique("dump_");
      const database = await seedDatabase(instance, name);

      await page.goto(`/databases/${meta.group}/${database.id}`);
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

      /* Size is a live read: the endpoint answers from the engine. */
      const size = await data<{ size_bytes: number; table_count: number }>("GET", `/databases/${database.id}/size`);
      const sizeCard = page.locator("section").filter({ has: page.getByRole("heading", { name: "Size and tables" }) });
      await sizeCard.getByRole("button", { name: "Sample now" }).first().click();
      await expect(sizeCard.getByRole("img").or(sizeCard.getByText(/One sample|samples/)).first()).toBeVisible();
      expect(size.size_bytes).toBeGreaterThan(0);

      /* Dump. */
      await page.getByRole("button", { name: "Dump", exact: true }).click();
      const dump = page.getByRole("dialog", { name: `Dump ${name}` });
      const destination = dump.getByLabel("Destination path on the host");
      const stamp = new Date().toISOString().slice(0, 10);
      await expect(destination).toHaveValue(`/var/backups/kaname/${name}-${stamp}.sql.gz`);
      await dump.getByRole("switch", { name: "Compress with gzip" }).uncheck();
      await expect(destination).toHaveValue(`/var/backups/kaname/${name}-${stamp}.sql`);
      await destination.fill("var/backups/relative.sql");
      await expect(dump.getByText("must be an absolute path")).toBeVisible();
      await expect(dump.getByRole("button", { name: "Dump" })).toBeDisabled();
      const file = `/var/backups/kaname/${name}.sql`;
      await destination.fill(file);
      await dump.getByRole("button", { name: "Dump" }).click();
      await jobSucceeds(page, "Dump database", name);

      const written = await data<{ entries: { name: string; size: number }[] }>(
        "GET",
        `/files?${qs({ server_id: serverId, path: "/var/backups/kaname" })}`,
      );
      expect(written.entries.find((entry) => entry.name === `${name}.sql`)).toBeDefined();

      const history = page.getByRole("table", { name: "Backup history" });
      await expect(history.locator("tbody tr").filter({ hasText: "Dump" }).first()).toBeVisible();

      /* Restore needs the path and the name typed. */
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      const restore = page.getByRole("dialog", { name: `Restore into ${name}` });
      await restore.getByLabel("Source path on the host").fill(file);
      const armed = restore.getByRole("button", { name: "Restore" });
      await expect(armed).toBeDisabled();
      await restore.getByLabel(/to confirm/).fill(name.slice(0, -1));
      await expect(armed).toBeDisabled();
      await restore.getByLabel(/to confirm/).fill(name);
      await armed.click();
      await jobSucceeds(page, "Restore database", name);
      await expect(history.locator("tbody tr").filter({ hasText: "Restore" }).first()).toBeVisible();

      /* A restore from a file that is not there fails on the host, visibly. */
      const missing = await data<{ job: { id: string } }>("POST", `/databases/${database.id}/restore`, {
        source: `/var/backups/kaname/${name}-missing.sql`,
        database_name: name,
        confirm_name: name,
      });
      const failed = await settle(missing.job.id);
      expect(failed.status).toBe("failed");
      expect(failed.error?.code).toBe("not_found");

      /* The confirmation is bound to the name on the server too. */
      const mismatch = await call("POST", `/databases/${database.id}/restore`, {
        source: file,
        database_name: name,
        confirm_name: "something-else",
      });
      expect(mismatch.status).toBe(422);
      expect(mismatch.body.error?.fields?.["confirm_name"]).toBe("confirmation must match the database name exactly");
      const stale = await call("POST", `/databases/${database.id}/restore`, {
        source: file,
        database_name: "other_db",
        confirm_name: "other_db",
      });
      expect(stale.status).toBe(412);
    });

    test("drops a database only after its name is typed, and the host loses it", async ({ page }) => {
      const instance = await instanceFor(meta.engine);
      const name = unique("drop_");
      await seedDatabase(instance, name);
      const table = await openSection(page, meta.group);
      await page.getByPlaceholder("Search databases").fill(name);
      const row = table.locator("tbody tr").filter({ hasText: name });

      await rowAction(page, row, "Drop database");
      const confirm = page.getByRole("dialog", { name: `Drop ${name}?` });
      await expect(confirm).toContainText(`Every table, row and index is destroyed on ${HOST}.`);
      await expect(confirm).toContainText("This database has never been backed up by Kaname.");
      await expect(confirm.getByRole("button", { name: "Drop" })).toBeDisabled();
      await confirm.getByLabel(/Type .* to confirm/).fill(name);
      await confirm.getByRole("button", { name: "Drop" }).click();
      await jobSucceeds(page, "Drop database", name);
      await expect(row).toHaveCount(0);

      await sync(instance.id);
      expect((await databasesOn(instance.id)).map((db) => db.name)).not.toContain(name);
    });
  });
}
