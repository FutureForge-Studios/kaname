import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  api,
  choose,
  drawerJob,
  expectJobStatus,
  get,
  person,
  roleId,
  rowWith,
  signInAs,
  unique,
  type Person,
  serverNamed,
} from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — who may do what.
 *
 * The system roles in packages/contract/src/rbac.ts are a promise about
 * the panel, and both halves have to keep it: the control plane refuses
 * the request, and the panel does not offer a button that can only be
 * refused. Each role is a real invited user who accepted the invitation
 * and holds a real session; the owner never sets their password.
 *
 * Scope is the part most panels get wrong, so the last journey grants
 * every Websites permission on forge-01 alone and checks that edge-01's
 * site is neither listed nor writable.
 * ------------------------------------------------------------------ */

test.use({ storageState: { cookies: [], origins: [] } });

const people: Record<string, Person> = {};
let forgeId = "";
let edgeSiteId = "";
let forgeSiteId = "";

test.beforeAll(async () => {
  const forge = await serverNamed("forge-01");
  forgeId = forge.id;
  for (const slug of ["operator", "developer", "auditor", "viewer"]) {
    people[slug] = await person(slug, [await roleId(slug)]);
  }

  const websites = [
    "websites.sites:read",
    "websites.sites:write",
    "websites.sites:delete",
    "websites.domains:read",
    "websites.domains:write",
    "websites.ssl:read",
    "websites.ssl:write",
    "websites.deployments:read",
    "websites.deployments:exec",
    "infra.servers:read",
  ];
  const role = await api<{ id: string }>("POST", "/roles", {
    name: unique("Forge web operator"),
    description: "Websites on forge-01 only.",
    grants: websites.map((permission) => ({
      permission,
      scope: { kind: "servers", server_ids: [forge.id] },
    })),
  });
  expect(role.status, role.error?.message).toBe(201);
  people["scoped"] = await person("scoped", [role.data.id]);

  const sites = await get<{ id: string; name: string }[]>("/sites?per_page=200");
  edgeSiteId = sites.find((s) => s.name === "kaname-panel")!.id;
  forgeSiteId = sites.find((s) => s.name === "futureforge-www")!.id;
});

/** The Projects home, searched down to the project a journey needs ("" for all). */
async function projectsPage(page: Page, search = "") {
  await page.goto(`/?q=${encodeURIComponent(search)}`);
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
}

/** A card on the Projects home grid, found by the name of its project. */
function projectCard(page: Page, name: string): Locator {
  return page.getByRole("list", { name: "Projects" }).getByRole("listitem").filter({ hasText: name });
}

/* ------------------------------- viewer ------------------------------ */

test("a viewer is not shown Websites and is refused at the URL", async ({ page, context }) => {
  await signInAs(context, people["viewer"]!);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" }).first();
  await expect(nav.getByRole("link", { name: "Servers" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Projects" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Domains" })).toHaveCount(0);

  await page.goto("/websites/ssl");
  await expect(page.getByRole("alert").filter({ hasText: "forbidden" })).toContainText(
    "You do not have websites.ssl:read",
  );

  const res = await api("GET", "/certificates", undefined, people["viewer"]!.cookie);
  expect(res.status).toBe(403);
});

/* ------------------------------- auditor ----------------------------- */

test("an auditor reads every Websites page and is offered no change", async ({ page, context }) => {
  await signInAs(context, people["auditor"]!);
  await projectsPage(page, "futureforge-www");
  await expect(projectCard(page, "futureforge-www")).toBeVisible();
  /* Add new is open to them; the Deploy from Git item inside it is not. */
  await page.getByRole("button", { name: "Add new" }).first().click();
  await expect(page.getByRole("menuitem", { name: "Deploy from Git" })).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto(`/websites/sites/${forgeSiteId}`);
  await expect(page.getByRole("button", { name: "Redeploy", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: /Settings/ }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: /Domains/ }).click();
  await expect(page.getByRole("button", { name: "Issue certificate", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "More actions" }).click();
  for (const label of ["Reload", "Delete project"]) {
    await expect(page.getByRole("menuitem", { name: label })).toBeDisabled();
  }
  await page.keyboard.press("Escape");

  for (const [path, heading, action] of [
    ["/websites/domains", "Domains", "Add domain"],
    ["/websites/ssl", "SSL / TLS", "Issue certificate"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("button", { name: action }).first()).toBeDisabled();
  }
  await page.goto("/websites/deployments");
  await expect(
    page.getByRole("table", { name: "Deployments" }).locator("tbody tr").first(),
  ).toBeVisible();

  /* Read-only is enforced, not just drawn. */
  const write = await api(
    "PATCH",
    `/sites/${forgeSiteId}`,
    { force_https: false },
    people["auditor"]!.cookie,
  );
  expect(write.status).toBe(403);
  expect(write.error?.message).toContain("websites.sites:write");
});

/* ------------------------------ developer ---------------------------- */

test("a developer ships sites but does not delete them or touch domains and TLS", async ({
  page,
  context,
}) => {
  const dev = people["developer"]!;
  await signInAs(context, dev);
  await projectsPage(page);

  /* Creating is theirs. */
  const name = unique("e2e-dev");
  await page.getByRole("button", { name: "Add new" }).first().click();
  await page.getByRole("menuitem", { name: "Deploy from Git" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await choose(page, dialog.getByLabel("Server"), "forge-01");
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByLabel("Domain", { exact: true }).fill(`${name}.e2e.test`);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expectJobStatus(drawerJob(page, "Create site", name), "Succeeded");
  await page.keyboard.press("Escape");

  const created = (await get<{ id: string; name: string }[]>(`/sites?q=${name}`))[0]!;
  await page.goto(`/websites/sites/${created.id}`);
  await expect(page.getByText("Active").first()).toBeVisible();

  /* Editing and deploying are theirs; deleting and TLS are not. */
  await page.getByRole("tab", { name: /Settings/ }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /Deployments/ }).click();
  await expect(page.getByRole("button", { name: "Deploy", exact: true }).last()).toBeEnabled();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Delete project" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: /Domains/ }).click();
  await expect(page.getByRole("button", { name: "Issue certificate", exact: true })).toBeDisabled();

  await page.goto("/websites/domains");
  await expect(page.getByRole("button", { name: "Add domain" }).first()).toBeDisabled();

  const del = await api("DELETE", `/sites/${created.id}`, undefined, dev.cookie);
  expect(del.status).toBe(403);
  const domain = await api("POST", "/domains", { name: `${unique("dev")}.e2e.test` }, dev.cookie);
  expect(domain.status).toBe(403);
});

/* ------------------------------- operator ---------------------------- */

test("an operator holds every Websites action", async ({ page, context }) => {
  const op = people["operator"]!;
  await signInAs(context, op);
  await page.goto(`/websites/sites/${forgeSiteId}`);
  await expect(page.getByRole("button", { name: "Redeploy", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "More actions" }).click();
  for (const label of ["Reload", "Delete project"]) {
    await expect(page.getByRole("menuitem", { name: label })).toBeEnabled();
  }
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: /Domains/ }).click();
  await expect(page.getByRole("button", { name: "Issue certificate", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /Settings/ }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeEnabled();

  /* And uses one: a domain added by an operator lands. */
  await page.goto("/websites/domains");
  await page.getByRole("button", { name: "Add domain" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add domain" });
  const name = `${unique("op")}.e2e.test`;
  await dialog.getByLabel("Domain name").fill(name);
  await dialog.getByRole("button", { name: "Add domain" }).click();
  await expect(dialog).toBeHidden();
  await expect(rowWith(page.getByRole("table", { name: "Domains" }), name)).toBeVisible();

  /* Panel administration is still not theirs. */
  expect((await api("GET", "/users", undefined, op.cookie)).status).toBe(403);
});

/* ----------------------------- server scope -------------------------- */

test("a role scoped to forge-01 sees and changes only forge-01's sites", async ({
  page,
  context,
}) => {
  const scoped = people["scoped"]!;
  await signInAs(context, scoped);
  await projectsPage(page, "futureforge-www");
  await expect(projectCard(page, "futureforge-www")).toBeVisible();
  await projectsPage(page, "kaname-panel");
  await expect(projectCard(page, "kaname-panel")).toHaveCount(0);
  const listed = await get<{ server_name: string }[]>("/sites?per_page=200");
  const own = await api<{ server_name: string }[]>(
    "GET",
    "/sites?per_page=200",
    undefined,
    scoped.cookie,
  );
  expect(own.data.length).toBeLessThan(listed.length);
  expect(new Set(own.data.map((s) => s.server_name))).toEqual(new Set(["forge-01"]));

  /* The create form only offers the host they can write to. */
  await page.getByRole("button", { name: "Add new" }).first().click();
  await page.getByRole("menuitem", { name: "Deploy from Git" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Server").click();
  const options = page.getByRole("listbox").getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("forge-01");
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  /* Out of scope by URL and by API. */
  await page.goto(`/websites/sites/${edgeSiteId}`);
  await expect(page.getByRole("alert").filter({ hasText: "forbidden" })).toBeVisible();
  const patch = await api("PATCH", `/sites/${edgeSiteId}`, { force_https: false }, scoped.cookie);
  expect(patch.status).toBe(403);
  const create = await api(
    "POST",
    "/sites",
    {
      server_id: (await serverNamed("edge-01")).id,
      name: unique("e2e-out"),
      webroot: "/var/www/out",
      runtime: "static",
      primary_domain: `${unique("out")}.e2e.test`,
    },
    scoped.cookie,
  );
  expect(create.status).toBe(403);

  /* In scope is fully theirs, including the job. */
  const own2 = await api<{ job: { id: string } }>(
    "POST",
    `/sites/${forgeSiteId}/reload`,
    undefined,
    scoped.cookie,
  );
  expect(own2.status).toBe(202);
  expect(forgeId).not.toBe("");
});
