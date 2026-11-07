import { createHmac } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { apiUrl, ownerEmail, ownerPassword, webUrl } from "./config.js";

/* ------------------------------------------------------------------ *
 * Platform helpers: accounts, roles, API keys and TOTP.
 *
 * Everything here goes through the public API exactly as an operator's
 * script would — nothing is written to the database behind the panel's
 * back. Accounts are invited by the owner and redeemed with the
 * invitation token the invite response carries, so a role journey
 * exercises the same path a real teammate takes.
 *
 * Calls that could trip the login rate limit (10 a minute per address)
 * carry their own X-Forwarded-For: the control plane trusts the proxy
 * header, so each helper sign-in gets a bucket of its own and a spec
 * that tests the limit cannot starve the specs after it.
 * ------------------------------------------------------------------ */

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    remediation?: { summary: string };
    detail?: unknown;
  };
}

export interface Caller {
  cookie?: string;
  bearer?: string;
  /** Spoofed client address, for a rate-limit bucket of its own. */
  ip?: string;
}

let ipCounter = Math.floor(Math.random() * 200);
/** A fresh documentation-range address per call site. */
export function freshIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  options: Caller & { body?: unknown } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers["cookie"] = options.cookie;
  if (options.bearer) headers["authorization"] = `Bearer ${options.bearer}`;
  if (options.ip) headers["x-forwarded-for"] = options.ip;
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

/** Signs in over the API and returns the session cookie pair. */
export async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in as ${email} failed (${res.status}): ${await res.text()}`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error(`sign-in as ${email} set no cookie`);
  return cookie;
}

let owner: string | null = null;
/** The bootstrap owner's own API session, separate from the browser's. */
export async function ownerCookie(): Promise<string> {
  owner ??= await login(ownerEmail, ownerPassword);
  return owner;
}

export async function asOwner<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return call<T>(method, path, { cookie: await ownerCookie(), body });
}

/** `data` of a 2xx response, or a failure that says what came back. */
export function data<T>(result: ApiResult<unknown>, what: string): T {
  expect(result.status, `${what}: ${JSON.stringify(result.body)}`).toBeLessThan(300);
  return (result.body as { data: T }).data;
}

/* ------------------------------- roles ------------------------------ */

export interface RoleRow {
  id: string;
  slug: string;
  name: string;
  is_system: boolean;
}

export async function roleBySlug(slug: string): Promise<RoleRow> {
  const roles = data<RoleRow[]>(await asOwner("GET", "/roles?per_page=200"), "list roles");
  const role = roles.find((candidate) => candidate.slug === slug);
  if (!role) throw new Error(`no role with slug ${slug}`);
  return role;
}

export interface Grant {
  permission: string;
  scope: { kind: "global" } | { kind: "servers"; server_ids: string[] };
}

export async function createRole(name: string, grants: Grant[]): Promise<RoleRow> {
  return data<RoleRow>(
    await asOwner("POST", "/roles", { name, description: "e2e", grants }),
    `create role ${name}`,
  );
}

/* ------------------------------ accounts ---------------------------- */

/** Passes the control plane's strength check and contains no address. */
export const STRONG_PASSWORD = "Tidal-Basalt-Orchard-47";

export interface Account {
  id: string;
  email: string;
  name: string;
  password: string;
}

let accountCounter = 0;
export function uniqueEmail(tag: string): string {
  accountCounter += 1;
  return `${tag}-${Date.now().toString(36)}-${accountCounter}@example.com`;
}

export interface InvitedUser {
  id: string;
  email: string;
  invite: { url: string; expires_at: string };
}

/** Invites an account with the given roles and returns the raw token. */
export async function invite(
  tag: string,
  roleIds: string[],
): Promise<{ user: InvitedUser; token: string }> {
  const email = uniqueEmail(tag);
  const user = data<InvitedUser>(
    await asOwner("POST", "/users", {
      email,
      name: `E2E ${tag}`,
      role_ids: roleIds,
      send_invite: false,
    }),
    `invite ${email}`,
  );
  const token = decodeURIComponent(new URL(user.invite.url).pathname.split("/invite/")[1] ?? "");
  expect(token, "the invitation link carries a token").not.toBe("");
  return { user, token };
}

export async function acceptInvite(token: string, password: string): Promise<ApiResult> {
  return call("POST", "/auth/invite/accept", {
    ip: freshIp(),
    body: { token, password, password_confirmation: password },
  });
}

/** An active account holding exactly these roles, with a known password. */
export async function accountWith(tag: string, roleSlugs: string[]): Promise<Account> {
  const roleIds = await Promise.all(roleSlugs.map(async (slug) => (await roleBySlug(slug)).id));
  return accountWithRoleIds(tag, roleIds);
}

export async function accountWithRoleIds(tag: string, roleIds: string[]): Promise<Account> {
  const { user, token } = await invite(tag, roleIds);
  const accepted = await acceptInvite(token, STRONG_PASSWORD);
  expect(accepted.status, `accept invite: ${JSON.stringify(accepted.body)}`).toBeLessThan(300);
  return { id: user.id, email: user.email, name: `E2E ${tag}`, password: STRONG_PASSWORD };
}

/* ----------------------------- browsers ----------------------------- */

/**
 * A browser context signed in as `account`, through the panel's own
 * sign-in form so the cookie is exactly the one a person would hold.
 */
export async function signedInContext(
  browser: Browser,
  account: Pick<Account, "email" | "password">,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: webUrl,
    storageState: { cookies: [], origins: [] },
    // A rate-limit bucket of its own (see the header comment).
    extraHTTPHeaders: { "x-forwarded-for": freshIp() },
  });
  const page = await context.newPage();
  await signInThroughForm(page, account.email, account.password);
  await expect(page).not.toHaveURL(/\/login/);
  return { context, page };
}

export async function signInThroughForm(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The cookie a browser context holds, ready to replay over the API. */
export async function contextCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(webUrl);
  const session = cookies.find((cookie) => cookie.name.includes("kaname"));
  if (!session) throw new Error(`no session cookie in context: ${cookies.map((c) => c.name)}`);
  return `${session.name}=${session.value}`;
}

/* -------------------------------- TOTP ------------------------------ */

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238, SHA-1, six digits, 30-second steps — what otpauth issues. */
export function totp(secret: string, at = Date.now(), stepOffset = 0): string {
  const counter = Math.floor(at / 30_000) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return binary.toString().padStart(6, "0");
}

/** A six-digit code that is guaranteed wrong for this secret right now. */
export function wrongTotp(secret: string): string {
  const valid = new Set([-1, 0, 1].map((offset) => totp(secret, Date.now(), offset)));
  for (let n = 0; n < 1_000_000; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

/* ------------------------------ sidebar ----------------------------- */

/**
 * What the primary navigation shows, as "Section" for a top-level link
 * and "Section › Leaf" for a grouped one, in display order.
 */
export async function sidebarEntries(page: Page): Promise<string[]> {
  const nav = page.getByRole("navigation", { name: "Primary" }).first();
  await expect(nav.getByRole("link").first()).toBeVisible();
  return nav.evaluate((root) => {
    const out: string[] = [];
    for (const child of Array.from(root.children)) {
      const group = child.getAttribute("role") === "group" ? child : null;
      if (!group) {
        const link = child.querySelector("a");
        if (link) out.push((link.textContent ?? "").trim());
        continue;
      }
      const labelId = group.getAttribute("aria-labelledby");
      const label = labelId ? (document.getElementById(labelId)?.textContent ?? "").trim() : "?";
      for (const link of Array.from(group.querySelectorAll("a"))) {
        out.push(`${label} › ${(link.textContent ?? "").trim()}`);
      }
    }
    return out;
  });
}
