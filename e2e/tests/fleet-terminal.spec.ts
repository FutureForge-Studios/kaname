import { expect, test } from "@playwright/test";
import { ownerCall, server, terminalSessionsFor } from "../support/fleet.js";

/* ------------------------------------------------------------------ *
 * The terminal's guarantees, beyond "it echoes" (terminal.spec.ts).
 *
 * KD-013 makes the ticket the credential for the socket: minted by an
 * authorised POST, single-use, short-lived, bound to the caller's
 * address, and never handed to an API key. KD-024 makes the pane mint
 * one per socket. These are the properties that keep a leaked URL from
 * being a root shell, so each is asserted from the browser, against the
 * real socket — not by reading the code that is supposed to enforce it.
 * ------------------------------------------------------------------ */

const HOST = "db-01";

test("a ticket opens exactly one socket; replaying it is refused", async ({ page }) => {
  const host = await server(HOST);
  await page.goto("/terminal");

  const outcome = await page.evaluate(async (serverId) => {
    const minted = await fetch("/api/v1/terminal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_id: serverId, cols: 80, rows: 24 }),
    });
    const { data } = (await minted.json()) as { data: { ws_url: string } };

    const open = (url: string) =>
      new Promise<{ opened: boolean; firstData: boolean; code: number; reason: string }>(
        (resolve) => {
          const ws = new WebSocket(url);
          let opened = false;
          ws.onopen = () => (opened = true);
          ws.onmessage = () => {
            resolve({ opened, firstData: true, code: 0, reason: "" });
            ws.close(1000, "done");
          };
          ws.onclose = (event) =>
            resolve({ opened, firstData: false, code: event.code, reason: event.reason });
        },
      );

    const first = await open(data.ws_url);
    const second = await open(data.ws_url);
    return { first, second };
  }, host.id);

  expect(outcome.first.firstData, "the first redemption should reach the shell").toBe(true);
  expect(outcome.second.firstData).toBe(false);
  expect(outcome.second.code).toBe(4401);
  expect(outcome.second.reason).toBe("ticket already used");
});

test("a made-up ticket is refused before anything reaches the host", async ({ page }) => {
  const host = await server(HOST);
  const minted = await ownerCall<{ ws_url: string }>("POST", "/terminal/sessions", {
    server_id: host.id,
    cols: 80,
    rows: 24,
  });
  const forged = minted.ws_url.replace(/kn_tty_[^?]+/, "kn_tty_thisisnotarealticketatallreally0000");
  await page.goto("/terminal");
  const closed = await page.evaluate(
    (url) =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        const ws = new WebSocket(url);
        ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
      }),
    forged,
  );
  expect(closed).toEqual({ code: 4401, reason: "unknown ticket" });
});

test("an API key can drive the API but cannot open a shell", async ({ page }) => {
  const host = await server(HOST);
  const issued = await ownerCall<{ token: string }>("POST", "/api-keys", {
    name: "e2e-fleet-terminal",
    scopes: ["terminal.session:exec", "infra.servers:read"],
  });
  const auth = { authorization: `Bearer ${issued.token}` };

  /* The key itself works... */
  const read = await page.request.get(`/api/v1/servers/${host.id}`, { headers: auth });
  expect(read.status()).toBe(200);

  /* ...and still gets no root shell, even holding the permission. */
  const refused = await page.request.post("/api/v1/terminal/sessions", {
    headers: auth,
    data: { server_id: host.id, cols: 80, rows: 24 },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
    "Terminal sessions require an interactive user session.",
  );
});

test("resizing the window resizes the pty on the same socket", async ({ page }) => {
  const host = await server(HOST);
  await page.setViewportSize({ width: 1600, height: 1000 });

  const sockets: import("@playwright/test").WebSocket[] = [];
  const resizes: string[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/terminal/")) return;
    sockets.push(ws);
    ws.on("framesent", (frame) => {
      if (typeof frame.payload === "string" && frame.payload.includes('"resize"')) {
        resizes.push(frame.payload);
      }
    });
  });

  await page.goto(`/terminal?server_id=${host.id}`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("This is a simulated host", {
    timeout: 30_000,
  });
  const geometry = page.getByText(/^\d+×\d+$/);
  const wide = (await geometry.innerText()).trim();

  await page.setViewportSize({ width: 900, height: 1000 });
  await expect(geometry).not.toHaveText(wide);
  const narrow = (await geometry.innerText()).trim();
  const [cols, rows] = narrow.split("×").map(Number);
  expect(cols).toBeLessThan(Number(wide.split("×")[0]));

  /* The new size went to the host as a control frame... */
  await expect
    .poll(() => resizes.map((r) => JSON.parse(r) as { cols: number; rows: number }).at(-1))
    .toEqual({ t: "resize", cols, rows });
  /* ...over the socket already open: resizing is not a reconnect, which
   * would spend a ticket and open a second recorded session. */
  expect(sockets).toHaveLength(1);

  /* And the shell still answers afterwards. */
  await page.locator(".xterm-screen").click();
  await page.keyboard.type("hostname");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText(".kaname.internal");
});

test("disconnecting closes the session and the history says it ended", async ({ page }) => {
  const host = await server(HOST);
  await page.goto(`/terminal?server_id=${host.id}`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText("This is a simulated host", {
    timeout: 30_000,
  });

  const open = (await terminalSessionsFor(host.id)).find((s) => s.ended_at === null);
  expect(open, "the connected session is not listed as open").toBeTruthy();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Not connected")).toBeVisible();

  /* Closed on the server too, not just hidden in the browser. */
  await expect
    .poll(async () => (await terminalSessionsFor(host.id)).find((s) => s.id === open!.id)?.ended_at)
    .not.toBeNull();

  /* The history's "Closed" filter returns closed sessions only. */
  const closed = await ownerCall<{ id: string; ended_at: string | null }[]>(
    "GET",
    `/terminal/sessions?server_id=${host.id}&active=false&per_page=50`,
  );
  expect(closed.map((s) => s.id)).toContain(open!.id);
  expect(closed.every((s) => s.ended_at !== null)).toBe(true);

  /* Reconnecting mints a fresh ticket — a new session, not a reused one. */
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".xterm-rows")).toContainText("This is a simulated host", {
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await terminalSessionsFor(host.id)).filter((s) => s.ended_at === null))
    .toHaveLength(1);
  const reopened = (await terminalSessionsFor(host.id)).find((s) => s.ended_at === null)!;
  expect(reopened.id).not.toBe(open!.id);
});
