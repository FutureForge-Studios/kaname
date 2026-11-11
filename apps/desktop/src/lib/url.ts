/* URL helpers for panel origins and panel-relative links. */

/**
 * Normalises what someone typed into the URL field to an origin:
 * adds https:// when the scheme is missing, drops a trailing slash and
 * an accidental /api/v1 suffix. Returns null when it is not a URL.
 */
export function normalizeBaseUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/api\/v1$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Joins a panel-relative href (from a remediation action) onto the
 * connection's base URL. Absolute http(s) hrefs pass through unchanged;
 * anything else with a scheme (javascript:, file:) is refused.
 */
export function joinPanelUrl(baseUrl: string, href: string): string | null {
  const target = href.trim();
  if (/^https?:\/\//i.test(target)) return target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  const base = baseUrl.replace(/\/+$/, "");
  const path = target.replace(/^\/+/, "");
  return path ? `${base}/${path}` : base;
}

/** "https://panel.example.com:8443" → "panel.example.com:8443" for compact display. */
export function displayHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host + url.pathname.replace(/\/+$/, "");
  } catch {
    return baseUrl;
  }
}
