import { domainName } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * The panel's own address.
 *
 * Deliberately not part of the settings document: applying it
 * regenerates the reverse proxy configuration and restarts the control
 * plane, which is not something that can ride along with a PATCH that
 * also changes a date format.
 * ------------------------------------------------------------------ */

export interface PanelAddress {
  domain: string | null;
  public_url: string;
  tls: boolean;
  /** False when install.sh did not put this instance here, so nothing the panel can reach owns the proxy in front of it. */
  managed: boolean;
}

/** The 202 from POST /settings/address: accepted, restart already under way. */
export interface PanelAddressApplying {
  domain: string | null;
  public_url: string;
  tls: boolean;
  applying: true;
}

/** Operators paste what is in the address bar; the field wants the name out of it. */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

/**
 * Checked against the same schema the control plane validates with, so
 * the hint here and the refusal there cannot disagree. The server still
 * decides — this only stops a restart being spent on a typo.
 */
export function domainProblem(domain: string): string | null {
  if (domain.length === 0) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)) {
    return "No certificate authority issues for an IP address, and the panel already answers on this server's IP.";
  }
  if (/:\d+$/.test(domain)) {
    return "The domain is served on 443 and cannot be moved. Enter the name without a port.";
  }
  return domainName.safeParse(domain).success
    ? null
    : "That is not a domain name. It should look like panel.example.com.";
}
