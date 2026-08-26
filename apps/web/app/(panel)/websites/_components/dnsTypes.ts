import type { DnsRecordType } from "@kaname/contract";

/* ------------------------------------------------------------------ *
 * Per-type DNS record rules.
 *
 * Every record type wants a different shape of value, and a form that
 * asks for "content" without saying what kind is how zones end up with
 * an MX pointing at an IP address. The control plane rejects those, but
 * a rejection round-trip is a worse way to learn it than a label that
 * said so before the operator typed.
 *
 * These checks are advisory and deliberately loose where DNS itself is
 * loose. The authority is still the provider's answer; this only stops
 * the mistakes that are unambiguous.
 * ------------------------------------------------------------------ */

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
  "SRV",
  "CAA",
  "PTR",
  "ALIAS",
];

/** Mirrors PROXYABLE_TYPES in the control plane's provider layer. */
const PROXYABLE: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];

export const TTL_MAX = 604_800;

export interface DnsTypeSpec {
  /** What the value column of this record actually holds. */
  contentLabel: string;
  contentPlaceholder: string;
  /** One line under the field. Says the shape, not the RFC. */
  contentHint: string;
  priority: "required" | "none";
  proxyable: boolean;
  /** Null when acceptable, otherwise the specific reason it is not. */
  validate: (content: string) => string | null;
}

const HOSTNAME =
  /^(?=.{1,253}\.?$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\.?$/i;

/** `@`, `*`, a single label, or a dotted name. Wildcards only lead. */
const RECORD_NAME =
  /^(@|\*|(\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?)$/i;

function ipv4(value: string): string | null {
  const parts = value.split(".");
  const valid =
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && !/^0\d/.test(part));
  return valid ? null : "Must be a dotted-quad IPv4 address, for example 203.0.113.10.";
}

function ipv6(value: string): string | null {
  const invalid = "Must be an IPv6 address, for example 2001:db8::1.";
  if (!value.includes(":") || !/^[0-9a-f:]+$/i.test(value)) return invalid;
  if ((value.match(/::/g) ?? []).length > 1) return invalid;

  const groups = value.split(":").filter((group) => group.length > 0);
  if (groups.length > 8 || groups.some((group) => group.length > 4)) return invalid;
  if (!value.includes("::") && value.split(":").length !== 8) return invalid;
  return null;
}

function hostname(value: string): string | null {
  if (/^\s*\d+\s+/.test(value)) {
    return "Put the priority in its own field and leave only the target host here.";
  }
  return HOSTNAME.test(value)
    ? null
    : "Must be a hostname, for example mail.example.com — not an IP address or a URL.";
}

function text(value: string): string | null {
  if (value.length > 2048) return "A TXT value cannot exceed 2048 characters.";
  return null;
}

function srv(value: string): string | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) {
    return "Must be three fields: weight, port and target, for example 10 5060 sip.example.com.";
  }
  const [weight, port, target] = parts as [string, string, string];
  if (!/^\d+$/.test(weight) || Number(weight) > 65535) return "Weight must be 0–65535.";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return "Port must be 1–65535.";
  }
  return HOSTNAME.test(target) ? null : "The target must be a hostname.";
}

function caa(value: string): string | null {
  return /^\d+\s+(issue|issuewild|iodef)\s+"[^"]*"$/i.test(value.trim())
    ? null
    : 'Must read flags, tag and a quoted value, for example 0 issue "letsencrypt.org".';
}

export const DNS_TYPE_SPECS: Record<DnsRecordType, DnsTypeSpec> = {
  A: {
    contentLabel: "IPv4 address",
    contentPlaceholder: "203.0.113.10",
    contentHint: "The address this name resolves to.",
    priority: "none",
    proxyable: true,
    validate: ipv4,
  },
  AAAA: {
    contentLabel: "IPv6 address",
    contentPlaceholder: "2001:db8::1",
    contentHint: "The IPv6 address this name resolves to.",
    priority: "none",
    proxyable: true,
    validate: ipv6,
  },
  CNAME: {
    contentLabel: "Target hostname",
    contentPlaceholder: "example.com",
    contentHint: "A CNAME cannot sit at the zone apex or alongside any other record.",
    priority: "none",
    proxyable: true,
    validate: hostname,
  },
  MX: {
    contentLabel: "Mail host",
    contentPlaceholder: "mail.example.com",
    contentHint:
      "The host that accepts mail. It needs its own address record and must be DNS-only.",
    priority: "required",
    proxyable: false,
    validate: hostname,
  },
  TXT: {
    contentLabel: "Text value",
    contentPlaceholder: "v=spf1 a mx -all",
    contentHint: "Quotes are added for you. One SPF record per name, never two.",
    priority: "none",
    proxyable: false,
    validate: text,
  },
  NS: {
    contentLabel: "Nameserver",
    contentPlaceholder: "ns1.example.com",
    contentHint: "Delegates this name to another nameserver.",
    priority: "none",
    proxyable: false,
    validate: hostname,
  },
  SRV: {
    contentLabel: "Weight, port and target",
    contentPlaceholder: "10 5060 sip.example.com",
    contentHint: "Priority is the separate field; weight, port and target go here.",
    priority: "required",
    proxyable: false,
    validate: srv,
  },
  CAA: {
    contentLabel: "Authorisation",
    contentPlaceholder: '0 issue "letsencrypt.org"',
    contentHint:
      "Restricts which authorities may issue for this name. Omitting Let's Encrypt blocks renewals.",
    priority: "none",
    proxyable: false,
    validate: caa,
  },
  PTR: {
    contentLabel: "Target hostname",
    contentPlaceholder: "host.example.com",
    contentHint: "Reverse lookups usually live at the address holder, not here.",
    priority: "none",
    proxyable: false,
    validate: hostname,
  },
  ALIAS: {
    contentLabel: "Target hostname",
    contentPlaceholder: "example.com",
    contentHint: "A provider-side CNAME that is legal at the apex. Support varies by provider.",
    priority: "none",
    proxyable: true,
    validate: hostname,
  },
};

export function isProxyable(type: DnsRecordType): boolean {
  return PROXYABLE.includes(type);
}

export function validateRecordName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A record needs a name. Use @ for the zone apex.";
  if (trimmed.length > 253) return "A name cannot exceed 253 characters.";
  return RECORD_NAME.test(trimmed)
    ? null
    : "Use @ for the apex, a label such as www, or a full name. Wildcards may only lead.";
}

export function validateTtl(ttl: number): string | null {
  if (!Number.isInteger(ttl) || ttl < 0) return "TTL must be a whole number of seconds.";
  if (ttl > TTL_MAX) return "TTL cannot exceed 604800 seconds (7 days).";
  return null;
}

export interface ZoneLineInput {
  name: string;
  ttl: number;
  type: DnsRecordType;
  content: string;
  priority: number | null;
}

/** The exact line to paste into a zone file, matching what the API prints. */
export function zoneLine(record: ZoneLineInput): string {
  const name = record.name.endsWith(".") ? record.name : `${record.name}.`;
  const value = record.type === "TXT" ? JSON.stringify(record.content) : record.content;
  const priority =
    (record.type === "MX" || record.type === "SRV") && record.priority !== null
      ? `${record.priority} `
      : "";
  return `${name} ${record.ttl || 300} IN ${record.type} ${priority}${value}`;
}

/** 0 and 1 are "let the provider decide" at every provider we support. */
export function formatTtl(ttl: number): string {
  if (ttl <= 1) return "auto";
  if (ttl % 86_400 === 0) return `${ttl / 86_400}d`;
  if (ttl % 3_600 === 0) return `${ttl / 3_600}h`;
  if (ttl % 60 === 0) return `${ttl / 60}m`;
  return `${ttl}s`;
}
