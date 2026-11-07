import { expect, test } from "@playwright/test";
import { serverNamed } from "../support/api.js";
import {
  actAs,
  call,
  contextFor,
  data,
  keyWith,
  qs,
  settle,
  unique,
  ROLE_SLUGS,
  type RoleSlug,
} from "../support/data.js";

/* ------------------------------------------------------------------ *
 * Files and databases, per system role.
 *
 * Each role is a real user invited through the API with that role, and
 * is exercised through an owner-minted API key carrying exactly the
 * role's grants — invited accounts have no way to set a password yet,
 * so a browser session for them cannot exist (reported as a gap). The
 * key is evaluated by the same `can()` a session is.
 *
 * The matrix is the contract's SYSTEM_ROLES read as behaviour: every
 * cell is a request that must be allowed or refused, and a refusal must
 * be a 403 before anything is written.
 * ------------------------------------------------------------------ */

const FILES_HOST = "forge-01";
const DB_HOST = "db-01";

type Expect = Record<RoleSlug, boolean>;
const ALL: Expect = { owner: true, operator: true, developer: true, auditor: true, viewer: true };
const only = (...roles: RoleSlug[]): Expect =>
  Object.fromEntries(ROLE_SLUGS.map((role) => [role, roles.includes(role)])) as Expect;

const tokens = {} as Record<RoleSlug, string>;
let filesServer = "";
let dbServer = "";
let pgInstance = "";
let pgDatabase = "";
let ftpAccount = "";
let workDir = "";

test.beforeAll(async () => {
  filesServer = (await serverNamed(FILES_HOST)).id;
  dbServer = (await serverNamed(DB_HOST)).id;
  for (const role of ROLE_SLUGS) tokens[role] = await actAs(role, "perm");

  workDir = `/srv/${unique("e2e-perm-")}`;
  const mk = await data<{ job: { id: string } }>("POST", "/files/mkdir", { server_id: filesServer, path: workDir });
  await settle(mk.job.id);

  const instances = await data<{ id: string; engine: string }[]>(
    "GET",
    `/db-instances?${qs({ server_id: dbServer, per_page: 100 })}`,
  );
  pgInstance = instances.find((i) => i.engine === "postgres")!.id;
  const created = await data<{ jobs: { id: string }[]; database: { id: string } }>("POST", "/databases", {
    instance_id: pgInstance,
    engine: "postgres",
    name: unique("perm_"),
  });
  for (const job of created.jobs) await settle(job.id);
  pgDatabase = created.database.id;

  const user = unique("permftp_");
  await data("POST", "/ftp-accounts", {
    server_id: filesServer,
    username: user,
    password: "p".repeat(20),
    home_dir: `/home/${user}`,
  });
  const accounts = await data<{ id: string; username: string }[]>("GET", `/ftp-accounts?${qs({ q: user })}`);
  ftpAccount = accounts.find((a) => a.username === user)!.id;
});

interface Probe {
  name: string;
  allowed: Expect;
  run: (token: string) => Promise<number>;
}

const status = async (method: string, path: string, body: unknown, token: string) =>
  (await call(method, path, body, token)).status;

const PROBES: Probe[] = [
  {
    name: "browse files",
    allowed: only("owner", "operator", "developer", "auditor"),
    run: (t) => status("GET", `/files?${qs({ server_id: filesServer, path: "/etc" })}`, undefined, t),
  },
  {
    name: "read a file",
    allowed: only("owner", "operator", "developer", "auditor"),
    run: (t) => status("GET", `/files/read?${qs({ server_id: filesServer, path: "/etc/hostname" })}`, undefined, t),
  },
  {
    name: "download a file",
    allowed: only("owner", "operator", "developer", "auditor"),
    run: (t) => status("GET", `/files/download?${qs({ server_id: filesServer, path: "/etc/hostname" })}`, undefined, t),
  },
  {
    name: "create a folder",
    allowed: only("owner", "operator", "developer"),
    run: (t) => status("POST", "/files/mkdir", { server_id: filesServer, path: `${workDir}/${unique("d")}` }, t),
  },
  {
    name: "write a file",
    allowed: only("owner", "operator", "developer"),
    run: (t) => status("POST", "/files/write", { server_id: filesServer, path: `${workDir}/${unique("f")}`, content: "x" }, t),
  },
  {
    name: "chmod",
    allowed: only("owner", "operator", "developer"),
    run: (t) => status("POST", "/files/chmod", { server_id: filesServer, paths: [workDir], mode: "0755" }, t),
  },
  {
    name: "delete a file",
    allowed: only("owner", "operator"),
    run: (t) => status("POST", "/files/delete", { server_id: filesServer, paths: [`${workDir}/${unique("gone")}`] }, t),
  },
  {
    name: "read storage",
    allowed: only("owner", "operator", "developer", "auditor"),
    run: (t) => status("GET", `/storage?${qs({ server_id: filesServer })}`, undefined, t),
  },
  {
    name: "list FTP accounts",
    allowed: only("owner", "operator", "auditor"),
    run: (t) => status("GET", "/ftp-accounts", undefined, t),
  },
  {
    name: "create an FTP account",
    allowed: only("owner", "operator"),
    run: (t) => {
      const user = unique("rbac_");
      return status("POST", "/ftp-accounts", { server_id: filesServer, username: user, password: "r".repeat(20), home_dir: `/home/${user}` }, t);
    },
  },
  {
    name: "reset an FTP password",
    allowed: only("owner", "operator"),
    run: (t) => status("POST", `/ftp-accounts/${ftpAccount}/reset-password`, { password: "n".repeat(20) }, t),
  },
  {
    name: "list databases",
    allowed: only("owner", "operator", "developer", "auditor"),
    run: (t) => status("GET", `/databases?${qs({ instance_id: pgInstance })}`, undefined, t),
  },
  {
    name: "read a database's live size",
    allowed: only("owner", "operator", "developer", "auditor"),
    run: (t) => status("GET", `/databases/${pgDatabase}/size`, undefined, t),
  },
  {
    name: "create a database",
    allowed: only("owner", "operator", "developer"),
    run: (t) => status("POST", "/databases", { instance_id: pgInstance, engine: "postgres", name: unique("rbac_") }, t),
  },
  {
    name: "create a database user",
    allowed: only("owner", "operator", "developer"),
    run: (t) => status("POST", "/db-users", { instance_id: pgInstance, username: unique("rbac_") }, t),
  },
  {
    /* A dump writes a file at a path of the caller's choosing on the
     * host. "Reads everything, changes nothing" cannot include that. */
    name: "dump a database to the host",
    allowed: only("owner", "operator", "developer"),
    run: (t) => status("POST", `/databases/${pgDatabase}/dump`, { destination: `/var/backups/kaname/${unique("rbac-")}.sql` }, t),
  },
  {
    name: "restore a database",
    allowed: only("owner", "operator", "developer"),
    run: async (t) => {
      const db = await data<{ name: string }>("GET", `/databases/${pgDatabase}`);
      return status("POST", `/databases/${pgDatabase}/restore`, { source: "/var/backups/kaname/none.sql", database_name: db.name, confirm_name: db.name }, t);
    },
  },
];

for (const role of ROLE_SLUGS) {
  test(`${role}: every files and databases verb is allowed or refused as the role says`, async () => {
    const wrong: string[] = [];
    for (const probe of PROBES) {
      const code = await probe.run(tokens[role]);
      const allowed = code < 400;
      if (allowed !== probe.allowed[role]) {
        wrong.push(`${probe.name}: got ${code}, expected ${probe.allowed[role] ? "allowed" : "403"}`);
      } else if (!allowed) {
        expect(code, `${role} ${probe.name}`).toBe(403);
      }
    }
    expect(wrong, `${role} disagrees with SYSTEM_ROLES`).toEqual([]);
  });
}

test("dropping databases and deleting FTP accounts is for owner and operator only", async () => {
  for (const role of ROLE_SLUGS) {
    const created = await data<{ jobs: { id: string }[]; database: { id: string } }>("POST", "/databases", {
      instance_id: pgInstance,
      engine: "postgres",
      name: unique("dropme_"),
    });
    for (const job of created.jobs) await settle(job.id);
    const drop = await call("DELETE", `/databases/${created.database.id}`, undefined, tokens[role]);
    expect(drop.status, `${role} drop database`).toBe(only("owner", "operator")[role] ? 202 : 403);

    const user = unique("delftp_");
    await data("POST", "/ftp-accounts", { server_id: filesServer, username: user, password: "d".repeat(20), home_dir: `/home/${user}` });
    const id = (await data<{ id: string; username: string }[]>("GET", `/ftp-accounts?${qs({ q: user })}`)).find((a) => a.username === user)!.id;
    const del = await call("DELETE", `/ftp-accounts/${id}`, undefined, tokens[role]);
    expect(del.status, `${role} delete ftp`).toBe(only("owner", "operator")[role] ? 202 : 403);
  }
});

test("a refused create leaves nothing behind in the panel", async () => {
  const name = unique("refused_");
  const res = await call("POST", "/databases", { instance_id: pgInstance, engine: "postgres", name }, tokens.auditor);
  expect(res.status).toBe(403);
  const rows = await data<{ name: string }[]>("GET", `/databases?${qs({ instance_id: pgInstance, q: name })}`);
  expect(rows.map((r) => r.name)).not.toContain(name);
});

test("a PostgreSQL-only grant is enough to manage PostgreSQL", async () => {
  /* A custom role scoped to one engine — the shape a DBA for one stack
   * gets. Nothing about a PostgreSQL job needs a MySQL permission. */
  const token = await keyWith("pg-only", [
    "infra.servers:read",
    "databases.postgres:read",
    "databases.postgres:write",
    "databases.postgres:delete",
  ]);
  const name = unique("pgonly_");
  const created = await call<{ jobs: { id: string }[]; database: { id: string } }>(
    "POST",
    "/databases",
    { instance_id: pgInstance, engine: "postgres", name },
    token,
  );
  expect(created.status, JSON.stringify(created.body.error)).toBe(202);
  for (const job of created.body.data!.jobs) expect((await settle(job.id)).status).toBe("succeeded");

  const drop = await call("DELETE", `/databases/${created.body.data!.database.id}`, undefined, token);
  expect(drop.status).toBe(202);

  /* And it is not a MySQL grant in disguise. */
  const instances = await data<{ id: string; engine: string }[]>("GET", `/db-instances?${qs({ server_id: dbServer })}`);
  const maria = instances.find((i) => i.engine === "mariadb")!.id;
  const refused = await call("POST", "/databases", { instance_id: maria, engine: "mariadb", name: unique("nope_") }, token);
  expect(refused.status).toBe(403);
});

/* ------------------------------ in the panel ------------------------- */

test("the file manager arms exactly the buttons each role may use", async ({ browser }) => {
  for (const role of ["developer", "auditor"] as const) {
    const context = await contextFor(browser, tokens[role]);
    const page = await context.newPage();
    await page.goto(`/files/manager?${qs({ server_id: filesServer, path: "/etc" })}`);
    const table = page.getByRole("table", { name: "Directory listing" });
    const row = table.locator("tbody tr").filter({ has: page.locator('[title="/etc/hostname"]') });
    await expect(row).toBeVisible();

    const write = role === "developer";
    for (const button of ["New folder", "New file", "Upload"]) {
      const locator = page.getByRole("button", { name: button, exact: true });
      if (write) await expect(locator, `${role} ${button}`).toBeEnabled();
      else await expect(locator, `${role} ${button}`).toBeDisabled();
    }
    if (!write) await expect(page.getByText("read-only", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Row actions" }).click();
    const menuDelete = page.getByRole("menuitem", { name: "Delete" });
    const menuRename = page.getByRole("menuitem", { name: "Rename" });
    await expect(menuDelete).toBeDisabled(); // neither may delete
    if (write) await expect(menuRename).toBeEnabled();
    else await expect(menuRename).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: "Download" }).first()).toBeEnabled();
    await page.keyboard.press("Escape");
    await context.close();
  }

  /* A viewer cannot read files anywhere, and is told so rather than shown an empty tree. */
  const context = await contextFor(browser, tokens.viewer);
  const page = await context.newPage();
  await page.goto(`/files/manager?${qs({ server_id: filesServer })}`);
  await expect(
    page.getByText("No host in scope").or(page.getByRole("alert").filter({ hasText: "forbidden" })).first(),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Directory listing" }).locator('[title="/etc"]')).toHaveCount(0);
  await context.close();
});

test("the database pages arm exactly the actions each role may use", async ({ browser }) => {
  const db = await data<{ name: string }>("GET", `/databases/${pgDatabase}`);
  for (const role of ["developer", "auditor"] as const) {
    const context = await contextFor(browser, tokens[role]);
    const page = await context.newPage();
    await page.goto(`/databases/postgres?${qs({ server_id: dbServer })}`);
    const table = page.getByRole("table", { name: "Databases" });
    await page.getByPlaceholder("Search databases").fill(db.name);
    const row = table.locator("tbody tr").filter({ hasText: db.name });
    await expect(row).toBeVisible();

    const newDb = page.getByRole("button", { name: "New database" }).first();
    if (role === "developer") await expect(newDb).toBeEnabled();
    else await expect(newDb).toBeDisabled();

    await row.getByRole("button", { name: "Row actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Drop database" })).toBeDisabled();
    const restore = page.getByRole("menuitem", { name: "Restore from file" });
    const dump = page.getByRole("menuitem", { name: "Dump to file" });
    if (role === "developer") {
      await expect(restore).toBeEnabled();
      await expect(dump).toBeEnabled();
    } else {
      await expect(restore).toBeDisabled();
      await expect(dump).toBeDisabled();
    }
    await page.keyboard.press("Escape");
    await context.close();
  }

  const context = await contextFor(browser, tokens.viewer);
  const page = await context.newPage();
  await page.goto(`/databases/postgres?${qs({ server_id: dbServer })}`);
  await expect(page.getByRole("table", { name: "Databases" }).locator("tbody tr").filter({ hasText: db.name })).toHaveCount(0);
  await context.close();
});

test("an FTP page for a role without FTP access shows no accounts", async ({ browser }) => {
  const context = await contextFor(browser, tokens.developer);
  const page = await context.newPage();
  await page.goto(`/files/ftp?${qs({ server_id: filesServer })}`);
  await expect(page.getByRole("heading", { level: 1, name: "FTP / SFTP" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Transfer accounts" }).locator("tbody tr").filter({ hasText: "permftp_" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New account" }).first()).toBeDisabled();
  await context.close();
});

test("an invited member cannot sign in until they have set a password", async ({ request }) => {
  const role = (await data<{ id: string; slug: string }[]>("GET", "/roles?per_page=100")).find((r) => r.slug === "developer")!;
  const email = `${unique("invitee-")}@e2e.kaname.local`;
  await data("POST", "/users", { email, name: "Invitee", role_ids: [role.id], send_invite: false });
  const res = await request.post("/api/v1/auth/login", { data: { email, password: "anything-at-all-123" } });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
});
