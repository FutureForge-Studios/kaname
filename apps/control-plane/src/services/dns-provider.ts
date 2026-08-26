import { inArray, type Database } from "@kaname/db";
import { secrets } from "@kaname/db/schema";
import {
  dnsRecordType,
  type DnsProvider as DnsProviderKind,
  type DnsRecordType,
} from "@kaname/contract";
import type { Config } from "../config.js";
import { open } from "../lib/crypto.js";
import { ApiException } from "../lib/errors.js";

/* ------------------------------------------------------------------ *
 * DNS providers.
 *
 * Authoritative DNS is the one mutation that does not cross the agent:
 * the zone lives at the registrar, not on a managed host, so `dns.*` on
 * the agent is read-only by design (PLAN.md 2.4). Everything below the
 * interface returns typed results — no upstream JSON escapes this file,
 * so a provider's error vocabulary can never leak into our contract.
 * ------------------------------------------------------------------ */

export interface ProviderZone {
  id: string;
  name: string;
  nameservers: string[];
}

export interface ProviderRecordDraft {
  type: DnsRecordType;
  /** Fully qualified. Providers disagree about relative names; we do not. */
  name: string;
  content: string;
  ttl: number;
  priority: number | null;
  proxied: boolean;
}

export interface ProviderRecord extends ProviderRecordDraft {
  /** The provider's own id. Null when nothing at the provider owns it yet. */
  external_id: string | null;
}

/** What the operator has to do by hand when Kaname cannot write the zone. */
export interface ManualInstruction {
  action: "create" | "update" | "delete";
  record: ProviderRecord;
  /** Zone-file line to paste at the registrar. */
  zone_line: string;
}

export interface ProviderWrite {
  record: ProviderRecord;
  /** Non-null when the operator, not Kaname, still has to apply the change. */
  manual: ManualInstruction | null;
}

export interface ProviderZoneRecords {
  records: ProviderRecord[];
  /** Types Kaname does not model. Left untouched, and reported rather than hidden. */
  unsupported: { type: string; name: string }[];
}

export interface DnsProvider {
  readonly kind: DnsProviderKind;
  /** False when Kaname can only tell the operator what to change. */
  readonly authoritative: boolean;
  zone(): Promise<ProviderZone>;
  listRecords(): Promise<ProviderZoneRecords>;
  createRecord(draft: ProviderRecordDraft): Promise<ProviderWrite>;
  updateRecord(externalId: string | null, draft: ProviderRecordDraft): Promise<ProviderWrite>;
  deleteRecord(externalId: string | null, record: ProviderRecordDraft): Promise<ProviderWrite>;
}

/** The slice of a domain row a provider needs. */
export interface DnsProviderTarget {
  id: string;
  name: string;
  dnsProvider: DnsProviderKind;
  dnsZoneId: string | null;
}

/* ------------------------------------------------------------------ *
 * Manual
 * ------------------------------------------------------------------ */

/**
 * The fallback for a registrar Kaname has no API for. It applies
 * nothing and hands back the exact line to paste, which is strictly
 * better than pretending a write succeeded.
 */
export class ManualProvider implements DnsProvider {
  readonly kind = "manual" as const;
  readonly authoritative = false;

  constructor(private readonly target: DnsProviderTarget) {}

  async zone(): Promise<ProviderZone> {
    return {
      id: this.target.dnsZoneId ?? this.target.name,
      name: this.target.name,
      nameservers: [],
    };
  }

  /** Throws rather than returning [], so a caller that skips the
   *  `authoritative` check cannot mistake "no API" for "empty zone". */
  async listRecords(): Promise<ProviderZoneRecords> {
    throw new ApiException(
      "precondition_failed",
      `${this.target.name} is managed by hand, so Kaname has no authoritative zone to read.`,
      {
        remediation: {
          summary:
            "Kaname holds the intended records for a manual domain; there is nothing to compare them against. Move the zone to a supported provider to get drift detection and automatic dns-01 challenges.",
          actions: [{ label: "Domain settings", href: `/websites/domains/${this.target.id}` }],
        },
      },
    );
  }

  async createRecord(draft: ProviderRecordDraft): Promise<ProviderWrite> {
    return this.instruct("create", draft, null);
  }

  async updateRecord(
    externalId: string | null,
    draft: ProviderRecordDraft,
  ): Promise<ProviderWrite> {
    return this.instruct("update", draft, externalId);
  }

  async deleteRecord(
    externalId: string | null,
    record: ProviderRecordDraft,
  ): Promise<ProviderWrite> {
    return this.instruct("delete", record, externalId);
  }

  private instruct(
    action: ManualInstruction["action"],
    draft: ProviderRecordDraft,
    externalId: string | null,
  ): ProviderWrite {
    const record: ProviderRecord = {
      ...draft,
      name: fqdn(this.target.name, draft.name),
      external_id: externalId,
    };
    return { record, manual: { action, record, zone_line: zoneLine(record) } };
  }
}

/* ------------------------------------------------------------------ *
 * Cloudflare
 * ------------------------------------------------------------------ */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_TIMEOUT_MS = 15_000;
const CLOUDFLARE_PAGE_SIZE = 100;
/** The only records any CDN can proxy; asking for the rest is silently ignored. */
export const PROXYABLE_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME"];
/** Cloudflare's sentinel for "let us pick the TTL". */
const CLOUDFLARE_AUTO_TTL = 1;
const CLOUDFLARE_COMMENT = "managed by Kaname";

interface CloudflareError {
  code: number;
  message: string;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  errors?: CloudflareError[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

interface CloudflareZone {
  id: string;
  name: string;
  name_servers?: string[];
}

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
}

export class CloudflareProvider implements DnsProvider {
  readonly kind = "cloudflare" as const;
  readonly authoritative = true;

  private cachedZone: ProviderZone | null = null;

  constructor(
    private readonly target: DnsProviderTarget,
    private readonly token: string,
  ) {}

  async zone(): Promise<ProviderZone> {
    if (this.cachedZone) return this.cachedZone;

    if (this.target.dnsZoneId) {
      const zone = await this.request<CloudflareZone>(`/zones/${this.target.dnsZoneId}`, {
        method: "GET",
      });
      this.cachedZone = { id: zone.id, name: zone.name, nameservers: zone.name_servers ?? [] };
      return this.cachedZone;
    }

    const matches = await this.request<CloudflareZone[]>(
      `/zones?name=${encodeURIComponent(this.target.name)}&per_page=1`,
      { method: "GET" },
    );
    const zone = matches[0];
    if (!zone) {
      throw new ApiException(
        "not_found",
        `${this.target.name} is not a zone on this Cloudflare account.`,
        {
          remediation: {
            summary: `Add ${this.target.name} to Cloudflare and point the registrar at Cloudflare's nameservers, or switch the domain to manual DNS in Kaname.`,
            actions: [
              { label: "Domain settings", href: `/websites/domains/${this.target.id}` },
              { label: "Copy domain", copy: this.target.name },
            ],
          },
        },
      );
    }
    this.cachedZone = { id: zone.id, name: zone.name, nameservers: zone.name_servers ?? [] };
    return this.cachedZone;
  }

  async listRecords(): Promise<ProviderZoneRecords> {
    const zone = await this.zone();
    const records: ProviderRecord[] = [];
    const unsupported: { type: string; name: string }[] = [];

    let page = 1;
    let totalPages = 1;
    do {
      const batch = await this.request<CloudflareRecord[]>(
        `/zones/${zone.id}/dns_records?per_page=${CLOUDFLARE_PAGE_SIZE}&page=${page}`,
        { method: "GET" },
        (info) => {
          totalPages = info?.total_pages ?? 1;
        },
      );
      for (const raw of batch) {
        const parsed = this.toRecord(raw);
        if (parsed) records.push(parsed);
        else unsupported.push({ type: raw.type, name: raw.name });
      }
      page += 1;
    } while (page <= totalPages);

    return { records, unsupported };
  }

  async createRecord(draft: ProviderRecordDraft): Promise<ProviderWrite> {
    const zone = await this.zone();
    const created = await this.request<CloudflareRecord>(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: this.toBody(zone, draft),
    });
    return { record: this.requireRecord(created, draft), manual: null };
  }

  async updateRecord(
    externalId: string | null,
    draft: ProviderRecordDraft,
  ): Promise<ProviderWrite> {
    const zone = await this.zone();
    if (!externalId) return this.createRecord(draft);

    const updated = await this.request<CloudflareRecord>(
      `/zones/${zone.id}/dns_records/${externalId}`,
      {
        method: "PUT",
        body: this.toBody(zone, draft),
      },
    );
    return { record: this.requireRecord(updated, draft), manual: null };
  }

  async deleteRecord(
    externalId: string | null,
    record: ProviderRecordDraft,
  ): Promise<ProviderWrite> {
    const zone = await this.zone();
    const name = fqdn(zone.name, record.name);
    if (!externalId) {
      // Nothing at Cloudflare ever owned this row, so there is nothing to remove.
      return { record: { ...record, name, external_id: null }, manual: null };
    }

    await this.request<{ id: string } | null>(`/zones/${zone.id}/dns_records/${externalId}`, {
      method: "DELETE",
    });
    return { record: { ...record, name, external_id: externalId }, manual: null };
  }

  /* ----------------------------- internals ---------------------------- */

  private toBody(zone: ProviderZone, draft: ProviderRecordDraft): Record<string, unknown> {
    const proxied = PROXYABLE_TYPES.includes(draft.type) && draft.proxied;
    return {
      type: draft.type,
      name: fqdn(zone.name, draft.name),
      content: draft.content,
      // A proxied record is served from Cloudflare's edge, so its TTL is theirs.
      ttl: proxied || draft.ttl <= CLOUDFLARE_AUTO_TTL ? CLOUDFLARE_AUTO_TTL : draft.ttl,
      proxied,
      comment: CLOUDFLARE_COMMENT,
      ...(draft.type === "MX" || draft.type === "SRV" ? { priority: draft.priority ?? 10 } : {}),
    };
  }

  private toRecord(raw: CloudflareRecord): ProviderRecord | null {
    const type = dnsRecordType.safeParse(raw.type);
    if (!type.success) return null;
    return {
      external_id: raw.id,
      type: type.data,
      name: raw.name,
      content: raw.content,
      ttl: raw.ttl,
      priority: typeof raw.priority === "number" ? raw.priority : null,
      proxied: raw.proxied === true,
    };
  }

  /** Cloudflare accepting a type it then reports as something else would
   *  silently desynchronise the zone, so refuse instead of guessing. */
  private requireRecord(raw: CloudflareRecord, draft: ProviderRecordDraft): ProviderRecord {
    const parsed = this.toRecord(raw);
    if (!parsed) {
      throw new ApiException(
        "upstream_error",
        `Cloudflare stored the ${draft.type} record for ${this.target.name} as an unrecognised "${raw.type}".`,
        {
          remediation: {
            summary:
              "Kaname only tracks the record types in its contract. Sync the zone to see what Cloudflare actually holds, then remove the record at Cloudflare if it is wrong.",
            actions: [{ label: "Sync zone", action: "dns.sync" }],
          },
        },
      );
    }
    return parsed;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown },
    onPageInfo?: (info: CloudflareEnvelope<T>["result_info"]) => void,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${CLOUDFLARE_API}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiException(
        "upstream_error",
        `Kaname could not reach the Cloudflare API while working on ${this.target.name}.`,
        {
          detail: err instanceof Error ? err.message : String(err),
          remediation: {
            summary:
              "The control plane needs outbound HTTPS to api.cloudflare.com. Check the panel host's egress rules and its own DNS resolution, then retry.",
            actions: [{ label: "Retry", action: "dns.sync" }],
          },
        },
      );
    }

    const envelope = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;
    if (!response.ok || !envelope?.success) {
      throw this.failure(response.status, envelope?.errors ?? []);
    }

    onPageInfo?.(envelope.result_info);
    return envelope.result;
  }

  private failure(status: number, errors: CloudflareError[]): ApiException {
    const first = errors[0];
    const detail = errors.map((e) => `${e.code}: ${e.message}`);

    if (status === 401 || status === 403 || first?.code === 9109 || first?.code === 10000) {
      return new ApiException(
        "forbidden",
        `Cloudflare rejected the API token for ${this.target.name}.`,
        {
          detail,
          remediation: {
            summary: `The token needs Zone:Read and DNS:Edit on ${this.target.name}. Create one under Cloudflare's My Profile - API Tokens, then save it in Kaname's settings.`,
            actions: [
              { label: "DNS provider settings", href: "/administration/settings" },
              { label: "Domain settings", href: `/websites/domains/${this.target.id}` },
            ],
          },
        },
      );
    }

    if (status === 429) {
      return new ApiException(
        "rate_limited",
        `Cloudflare is rate limiting changes to ${this.target.name}.`,
        {
          detail,
          remediation: {
            summary:
              "Cloudflare allows 1200 API calls per five minutes per token. Wait a minute and retry, or apply the records in smaller batches.",
            actions: [{ label: "Retry", action: "dns.sync" }],
          },
        },
      );
    }

    if (first?.code === 81057 || first?.code === 81058) {
      return new ApiException(
        "conflict",
        `Cloudflare already serves that exact record in ${this.target.name}.`,
        {
          detail,
          remediation: {
            summary:
              "Sync the zone so Kaname adopts the record that already exists instead of creating a duplicate, then edit it here.",
            actions: [{ label: "Sync zone", action: "dns.sync" }],
          },
        },
      );
    }

    if (status === 404) {
      return new ApiException(
        "not_found",
        `Cloudflare no longer has that record in ${this.target.name}.`,
        {
          detail,
          remediation: {
            summary:
              "It was removed outside Kaname. Sync the zone to pick up the provider's current copy.",
            actions: [{ label: "Sync zone", action: "dns.sync" }],
          },
        },
      );
    }

    return new ApiException(
      "upstream_error",
      `Cloudflare refused the change to ${this.target.name}: ${first?.message ?? `HTTP ${status}`}`,
      {
        detail,
        remediation: {
          summary: `Cloudflare error ${first?.code ?? status}. Check the record against Cloudflare's constraints for ${this.target.name} — proxied records must be A, AAAA or CNAME, and an apex CNAME is flattened.`,
          actions: [
            { label: "Validate zone", action: "dns.validate" },
            { label: "Domain settings", href: `/websites/domains/${this.target.id}` },
          ],
        },
      },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/** Fleet-wide token; a `dns.cloudflare:<domain_id>` secret overrides it. */
const CLOUDFLARE_SECRET_REF = "dns.cloudflare";

export interface DnsProviderDeps {
  db: Database;
  config: Config;
}

export async function dnsProviderFor(
  deps: DnsProviderDeps,
  target: DnsProviderTarget,
): Promise<DnsProvider> {
  switch (target.dnsProvider) {
    case "cloudflare":
      return new CloudflareProvider(target, await cloudflareToken(deps, target));
    case "manual":
      return new ManualProvider(target);
    default:
      throw new ApiException(
        "precondition_failed",
        `Kaname does not drive ${target.dnsProvider} DNS yet, so it cannot change ${target.name}.`,
        {
          remediation: {
            summary:
              "Cloudflare and manual are the providers implemented today. Switch the domain to manual to keep managing its records here and apply them at the registrar by hand.",
            actions: [{ label: "Domain settings", href: `/websites/domains/${target.id}` }],
          },
        },
      );
  }
}

async function cloudflareToken(deps: DnsProviderDeps, target: DnsProviderTarget): Promise<string> {
  const refs = [`${CLOUDFLARE_SECRET_REF}:${target.id}`, CLOUDFLARE_SECRET_REF];
  const rows = await deps.db.select().from(secrets).where(inArray(secrets.ref, refs));
  // Listed most-specific first, so the per-domain token wins.
  const row = refs.map((ref) => rows.find((s) => s.ref === ref)).find((s) => s !== undefined);

  if (!row) {
    throw new ApiException(
      "precondition_failed",
      `No Cloudflare API token is stored for ${target.name}.`,
      {
        remediation: {
          summary: `Create a token with Zone:Read and DNS:Edit scoped to ${target.name}, then save it in Kaname's settings. It is sealed with a per-row data key and never reaches the audit trail.`,
          actions: [
            { label: "Add a token", href: "/administration/settings" },
            { label: "Use manual DNS instead", href: `/websites/domains/${target.id}` },
          ],
        },
      },
    );
  }

  try {
    return open(
      {
        wrappedKey: row.wrappedKey,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        keyVersion: row.keyVersion,
      },
      deps.config.masterKey,
    );
  } catch {
    throw new ApiException(
      "precondition_failed",
      `The stored Cloudflare token for ${target.name} could not be decrypted.`,
      {
        remediation: {
          summary:
            "KANAME_MASTER_KEY has changed since the token was saved, so its data key no longer unwraps. Re-enter the token to seal it with the current key.",
          actions: [{ label: "Re-enter token", href: "/administration/settings" }],
        },
      },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/**
 * Records are stored fully qualified so a zone rename cannot silently
 * re-target them, and lower-cased because DNS names are case-insensitive
 * — without that, "WWW.example.com" and "www.example.com" would be two
 * rows for one record and drift detection would never converge.
 */
export function fqdn(zoneName: string, name: string): string {
  const zone = zoneName.trim().replace(/\.$/, "").toLowerCase();
  const trimmed = name.trim().replace(/\.$/, "").toLowerCase();
  if (trimmed === "" || trimmed === "@" || trimmed === zone) return zone;
  return trimmed.endsWith(`.${zone}`) ? trimmed : `${trimmed}.${zone}`;
}

/** The exact line an operator pastes into a zone file or a registrar form. */
export function zoneLine(record: ProviderRecordDraft): string {
  const name = record.name.endsWith(".") ? record.name : `${record.name}.`;
  const value = record.type === "TXT" ? JSON.stringify(record.content) : record.content;
  const priority =
    (record.type === "MX" || record.type === "SRV") && record.priority !== null
      ? `${record.priority} `
      : "";
  return `${name} ${record.ttl || 300} IN ${record.type} ${priority}${value}`;
}
