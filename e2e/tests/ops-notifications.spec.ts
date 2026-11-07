import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { closedPort, endpoint, owner, type Endpoint } from "../support/secops.js";
import { sectionNamed } from "../support/ui.js";

/* ------------------------------------------------------------------ *
 * Notifications — channels, and a test send that reports what the far
 * end actually said.
 *
 * The far end here is real: an HTTP listener on loopback that records
 * every request, answers whatever the test tells it to, or is not there
 * at all. "Send test" is only correct if the panel then repeats that
 * answer word for word — a 500 body, a refused connection, a missing
 * mail server — rather than a generic "delivery failed".
 * ------------------------------------------------------------------ */

interface Channel {
  id: string;
  name: string;
  kind: "email" | "webhook" | "slack";
  target: string;
  events: string[];
  enabled: boolean;
  secret?: string | null;
}

let hook: Endpoint;

test.beforeAll(async () => {
  hook = await endpoint();
});
test.afterAll(async () => {
  await hook.close();
});

async function channels(): Promise<Channel[]> {
  const settings = await (await owner()).get<{ notifications: { channels: Channel[] } }>("/settings");
  return settings.notifications.channels;
}

/** Replaces the channel list, keeping whatever is already there. */
async function setChannels(extra: Channel[]): Promise<void> {
  const keep = (await channels()).filter((c) => !extra.some((e) => e.name === c.name));
  await (await owner()).ok("PATCH", "/settings", {
    notifications: {
      channels: [
        ...keep.map(({ id, name, kind, target, events, enabled }) => ({ id, name, kind, target, events, enabled })),
        ...extra,
      ],
    },
  });
}

function channel(name: string, kind: Channel["kind"], target: string): Channel {
  return { id: randomUUID(), name, kind, target, events: ["job_failed"], enabled: true };
}

/** The "Send test" result line for the channel with this name. */
async function sendTest(page: Page, name: string): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/administration/settings");
  const section = sectionNamed(page, "Notifications");
  const names = section.getByRole("textbox", { name: /^Channel \d+ name$/ });
  await expect(names.first()).toBeVisible();
  const values = await names.evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
  const index = values.indexOf(name);
  expect(index, `no channel named ${name} on the page (${values.join(", ")})`).toBeGreaterThan(-1);
  const test = section.getByRole("button", { name: "Send test" }).nth(index);
  await test.click();
  return test.locator("xpath=..");
}

test.describe("notifications", () => {
  test("a webhook channel is added in the panel and its test is signed and delivered", async ({ page }) => {
    await page.goto("/administration/settings");
    const section = sectionNamed(page, "Notifications");
    await expect(section).toBeVisible();
    const before = await section.getByRole("textbox", { name: /^Channel \d+ name$/ }).count();
    const n = before + 1;

    await section.getByRole("button", { name: "Add channel" }).click();
    await section.getByLabel(`Channel ${n} name`).fill("e2e webhook");
    await section.getByLabel(`Channel ${n} kind`).selectOption("webhook");

    /* A webhook needs an http(s) URL; the section refuses to save without one. */
    await section.getByLabel(`Channel ${n} target`).fill("ftp://example.com/hook");
    await section.getByRole("button", { name: "Save" }).click();
    await expect(section.getByText("A webhook channel needs an http(s) URL to POST to.")).toBeVisible();

    await section.getByLabel(`Channel ${n} target`).fill(`${hook.url}/kaname`);
    await section.getByLabel(`Channel ${n} signing secret`).fill("e2e-signing-secret");
    await section.getByRole("button", { name: "Save" }).click();
    await expect(section.getByRole("button", { name: "Save" })).toBeDisabled();
    expect((await channels()).find((c) => c.name === "e2e webhook")).toMatchObject({
      kind: "webhook",
      target: `${hook.url}/kaname`,
    });

    hook.received.length = 0;
    hook.respond.status = 200;
    const status = await sendTest(page, "e2e webhook");
    await expect(status).toContainText(/Delivered in \d+ ms\./);

    expect(hook.received).toHaveLength(1);
    const delivery = hook.received[0]!;
    expect(delivery.path).toBe("/kaname");
    const body = JSON.parse(delivery.body) as { event: string; title: string; data: { test: boolean } };
    expect(body.data.test).toBe(true);
    expect(body.title).toMatch(/^Test notification from /);
    const ts = String(delivery.headers["x-kaname-timestamp"]);
    const expected = createHmac("sha256", "e2e-signing-secret").update(`${ts}.${delivery.body}`).digest("hex");
    expect(delivery.headers["x-kaname-signature"]).toBe(`sha256=${expected}`);

    /* Now the far end refuses, and the panel repeats exactly what it said. */
    hook.respond.status = 503;
    hook.respond.body = "maintenance window, try later";
    const refused = await sendTest(page, "e2e webhook");
    await expect(refused).toContainText("The endpoint answered 503: maintenance window, try later.");
    /* ...and remembers it after a reload, as the channel's last error. */
    await page.reload();
    await expect(sectionNamed(page, "Notifications")).toContainText(
      "Last delivery failed: The endpoint answered 503: maintenance window, try later.",
    );
    hook.respond.status = 200;
    hook.respond.body = "ok";
  });

  test("each transport's own failure reaches the operator verbatim", async ({ page }) => {
    const port = await closedPort();
    await setChannels([
      channel("e2e refused hook", "webhook", `http://127.0.0.1:${port}/nothing`),
      channel("e2e slack", "slack", `${hook.url}/slack`),
      channel("e2e no-dns hook", "webhook", "http://kaname-e2e.invalid/hook"),
      channel("e2e email", "email", "ops@example.com"),
    ]);

    const refused = await sendTest(page, "e2e refused hook");
    await expect(refused).toContainText(
      `connect ECONNREFUSED 127.0.0.1:${port} — nothing is listening at that address.`,
    );

    const noDns = await sendTest(page, "e2e no-dns hook");
    await expect(noDns).toContainText(/kaname-e2e\.invalid/);
    await expect(noDns).not.toContainText("fetch failed");

    hook.received.length = 0;
    const slack = await sendTest(page, "e2e slack");
    await expect(slack).toContainText(/Delivered in \d+ ms\./);
    expect(hook.received[0]?.path).toBe("/slack");
    expect((JSON.parse(hook.received[0]!.body) as { text: string }).text).toMatch(/^\*Test notification from /);

    /* Email with no outgoing server configured says exactly that. */
    const mail = await (await owner()).get<{ notifications: { smtp: { host: string | null } } }>("/settings");
    if (!mail.notifications.smtp.host) {
      const email = await sendTest(page, "e2e email");
      await expect(email).toContainText(
        "No outgoing mail server is configured. Set one under Administration > Settings > Notifications.",
      );
    }
  });

  test("the outgoing mail test reports the mail server's real answer", async ({ page }) => {
    const port = await closedPort();
    const api = await owner();
    const result = await api.ok<{ ok: boolean; error: string | null }>(
      "POST",
      "/settings/notifications/smtp/test",
      { to: "ops@example.com", smtp: { host: "127.0.0.1", port, security: "none", from_address: "kaname@example.com" } },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");

    await page.goto("/administration/settings");
    await expect(page.getByRole("button", { name: "Send test email" })).toBeVisible();
  });

  test("channel targets are validated by kind", async () => {
    const api = await owner();
    const cases: [Channel["kind"], string, string][] = [
      ["email", "not-an-address", "An email channel needs an email address to send to."],
      ["slack", "hooks.slack.com/services/x", "A Slack channel needs its incoming-webhook URL."],
      ["webhook", "javascript:alert(1)", "A webhook channel needs an http(s) URL to POST to."],
    ];
    for (const [kind, target, message] of cases) {
      const res = await api.call("PATCH", "/settings", {
        notifications: { channels: [channel(`bad ${kind}`, kind, target)] },
      });
      expect(res.status, kind).toBe(422);
      expect(Object.values(res.error?.fields ?? {}), kind).toContain(message);
    }
    /* Testing a channel that does not exist is an answer, not a crash. */
    const missing = await api.ok<{ ok: boolean; error: string }>(
      "POST",
      `/settings/notifications/${randomUUID()}/test`,
    );
    expect(missing).toMatchObject({ ok: false, error: "That channel no longer exists." });
  });
});
