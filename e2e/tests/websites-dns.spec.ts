import { expect, test, type Page } from "@playwright/test";
import { api, dismissToasts, field, get, rowWith, unique } from "../support/websites.js";

/* ------------------------------------------------------------------ *
 * Websites — DNS.
 *
 * The zone lives at a registrar, not on a host, so record writes are
 * control-plane mutations that return the record. For a manual zone
 * Kaname applies nothing and says so: it keeps the intended records and
 * shows the exact zone line to publish. For an API-driven zone it
 * writes through the provider — and when it cannot (no token), the
 * operator must be told that, not shown a record that never left the
 * panel.
 * ------------------------------------------------------------------ */

interface DomainRow {
  id: string;
  name: string;
  record_count: number;
}

interface RecordRow {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority: number | null;
}

async function manualZone(): Promise<DomainRow> {
  const res = await api<DomainRow>("POST", "/domains", { name: `${unique("zone")}.e2e.test` });
  expect(res.status, res.error?.message).toBe(201);
  return res.data;
}

async function records(domainId: string): Promise<RecordRow[]> {
  return get<RecordRow[]>(`/dns?domain_id=${domainId}&per_page=200`);
}

async function openZone(page: Page, domain: DomainRow) {
  await page.goto(`/websites/dns?domain_id=${domain.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "DNS" })).toBeVisible();
  await expect(page.getByText(domain.name).first()).toBeVisible();
}

async function openAddRecord(page: Page, domain: DomainRow) {
  await page.getByRole("button", { name: "Add record" }).first().click();
  const dialog = page.getByRole("dialog", { name: `Add record to ${domain.name}` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/* ---------------------------- manual zone ---------------------------- */

test("a manual zone's records are created, edited and deleted from the DNS page", async ({
  page,
}) => {
  const domain = await manualZone();
  await openZone(page, domain);

  /* Empty, and honest about why there is nothing to sync from. */
  await expect(page.getByText("No records in this zone")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync zone" })).toBeDisabled();

  const dialog = await openAddRecord(page, domain);
  await field(dialog, "Name").fill("@");
  await dialog.getByLabel("IPv4 address").fill("203.0.113.10");
  await field(dialog, "TTL in seconds").fill("300");
  /* The line to publish is shown before anything is saved. */
  await expect(dialog.getByText(`${domain.name}. 300 IN A 203.0.113.10`)).toBeVisible();
  await dialog.getByRole("button", { name: "Add record" }).click();
  await expect(dialog).toBeHidden();

  const table = page.getByRole("table", { name: "DNS records" });
  const row = rowWith(table, "203.0.113.10");
  await expect(row).toBeVisible();
  await expect(row).toContainText("A");
  expect(await records(domain.id)).toEqual([
    expect.objectContaining({ type: "A", content: "203.0.113.10", ttl: 300 }),
  ]);
  await expect
    .poll(async () => (await get<DomainRow>(`/domains/${domain.id}`)).record_count)
    .toBe(1);

  /* The same record twice is refused rather than duplicated. */
  const again = await openAddRecord(page, domain);
  await field(again, "Name").fill("@");
  await again.getByLabel("IPv4 address").fill("203.0.113.10");
  await again.getByRole("button", { name: "Add record" }).click();
  await expect(again.getByRole("alert").filter({ hasText: "conflict" })).toContainText(
    `${domain.name} already has that exact A record.`,
  );
  await again.getByRole("button", { name: "Cancel" }).click();

  /* Edit in place. */
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Edit record" }).click();
  const edit = page.getByRole("dialog", { name: /^Edit A / });
  await expect(edit.getByLabel("IPv4 address")).toHaveValue("203.0.113.10");
  await edit.getByLabel("IPv4 address").fill("203.0.113.20");
  await dismissToasts(page);
  await edit.getByRole("button", { name: "Save record" }).click();
  await expect(edit).toBeHidden();
  await expect(rowWith(table, "203.0.113.20")).toBeVisible();
  await expect(rowWith(table, "203.0.113.10")).toHaveCount(0);
  expect((await records(domain.id))[0]?.content).toBe("203.0.113.20");

  /* And delete. */
  await rowWith(table, "203.0.113.20").getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Delete record" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this record?" });
  await expect(confirm).toContainText("203.0.113.20");
  await confirm.getByRole("button", { name: "Delete record" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText("No records in this zone")).toBeVisible();
  expect(await records(domain.id)).toEqual([]);
});

test("each record type is checked for the shape it needs", async ({ page }) => {
  const domain = await manualZone();
  await openZone(page, domain);
  const dialog = await openAddRecord(page, domain);
  const add = dialog.getByRole("button", { name: "Add record" });

  await field(dialog, "Name").fill("");
  await add.click();
  await expect(dialog.getByText("A record needs a name. Use @ for the zone apex.")).toBeVisible();
  await expect(dialog.getByText("Required.", { exact: true })).toBeVisible();

  await field(dialog, "Name").fill("www.*");
  await expect(
    dialog.getByText(
      "Use @ for the apex, a label such as www, or a full name. Wildcards may only lead.",
    ),
  ).toBeVisible();
  await field(dialog, "Name").fill("www");

  await dialog.getByLabel("IPv4 address").fill("203.0.113.256");
  await expect(
    dialog.getByText("Must be a dotted-quad IPv4 address, for example 203.0.113.10."),
  ).toBeVisible();
  await dialog.getByLabel("IPv4 address").fill("203.0.113.1");

  /* Boundary: 604800 seconds is the longest TTL the contract allows. */
  await field(dialog, "TTL in seconds").fill("604801");
  await expect(dialog.getByText("TTL cannot exceed 604800 seconds (7 days).")).toBeVisible();
  await field(dialog, "TTL in seconds").fill("604800");
  await expect(dialog.getByText("TTL cannot exceed 604800 seconds (7 days).")).toBeHidden();

  await field(dialog, "Type").selectOption("AAAA");
  await dialog.getByLabel("IPv6 address").fill("2001:db8::1::2");
  await expect(dialog.getByText("Must be an IPv6 address, for example 2001:db8::1.")).toBeVisible();

  /* MX: the host only, the priority in its own field. */
  await field(dialog, "Type").selectOption("MX");
  await dialog.getByLabel("Mail host").fill("10 mail.example.com");
  await expect(
    dialog.getByText("Put the priority in its own field and leave only the target host here."),
  ).toBeVisible();
  await dialog.getByLabel("Mail host").fill("mail.example.com");
  await expect(
    dialog.getByText("An MX record needs a priority. Lower numbers are tried first."),
  ).toBeVisible();
  await field(dialog, "Priority").fill("65536");
  await expect(dialog.getByText("Priority must be 0–65535.")).toBeVisible();
  await field(dialog, "Priority").fill("10");

  await field(dialog, "Type").selectOption("CAA");
  await dialog.getByLabel("Authorisation").fill("issue letsencrypt.org");
  await expect(
    dialog.getByText(
      'Must read flags, tag and a quoted value, for example 0 issue "letsencrypt.org".',
    ),
  ).toBeVisible();

  await field(dialog, "Type").selectOption("SRV");
  await dialog.getByLabel("Weight, port and target").fill("10 70000 sip.example.com");
  await expect(dialog.getByText("Port must be 1–65535.")).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await records(domain.id)).toEqual([]);

  /* The API applies the same rule without the form in front of it. */
  const bare = await api("POST", "/dns", {
    domain_id: domain.id,
    type: "MX",
    name: "@",
    content: "mail.example.com",
  });
  expect(bare.status).toBe(422);
  expect(bare.error?.message).toBe("An MX record needs a priority.");
});

/* -------------------------- API-driven zone -------------------------- */

test("a Cloudflare zone with no token refuses writes and syncs, and says why", async ({ page }) => {
  const domains = await get<(DomainRow & { dns_provider: string })[]>(
    "/domains?q=docs.forgebase.dev",
  );
  const docs = domains.find((d) => d.name === "docs.forgebase.dev")!;
  expect(docs.dns_provider).toBe("cloudflare");
  const before = await records(docs.id);

  await openZone(page, docs);
  await expect(page.getByText("Cloudflare").first()).toBeVisible();

  const dialog = await openAddRecord(page, docs);
  await expect(dialog).toContainText("Written straight to the zone at Cloudflare.");
  await field(dialog, "Name").fill("e2e");
  await dialog.getByLabel("IPv4 address").fill("203.0.113.77");
  await dialog.getByRole("button", { name: "Add record" }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "precondition_failed" })).toContainText(
    "No Cloudflare API token is stored for docs.forgebase.dev.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  /* Nothing was recorded as if it had been written. */
  expect(await records(docs.id)).toHaveLength(before.length);

  await page.getByRole("button", { name: "Sync zone" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "No Cloudflare API token" }).first(),
  ).toContainText("No Cloudflare API token is stored for docs.forgebase.dev.");
});

test("the drift filter means what it says in both directions", async ({ page }) => {
  const domains = await get<DomainRow[]>("/domains?q=docs.forgebase.dev");
  const docs = domains.find((d) => d.name === "docs.forgebase.dev")!;
  const seeded = await records(docs.id);
  expect(seeded.length).toBeGreaterThan(0);

  await openZone(page, docs);
  const table = page.getByRole("table", { name: "DNS records" });
  await expect(table.locator("tbody tr")).toHaveCount(seeded.length);

  /* None of the seeded records has drifted, so "in sync" is all of them… */
  await page.getByRole("combobox", { name: "Drift" }).selectOption("false");
  await expect(table.locator("tbody tr")).toHaveCount(seeded.length);
  await expect(page.getByText("No matches")).toHaveCount(0);

  /* …and "drifted" is none. */
  await page.getByRole("combobox", { name: "Drift" }).selectOption("true");
  await expect(page.getByText("No matches")).toBeVisible();
});

test("an unknown zone in the URL is not a crash", async ({ page }) => {
  await page.goto(`/websites/dns?domain_id=00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole("heading", { level: 1, name: "DNS" })).toBeVisible();
  /* No zone matched, so nothing can be added to it. */
  await expect(page.getByRole("button", { name: "Add record" }).first()).toBeDisabled();
});
