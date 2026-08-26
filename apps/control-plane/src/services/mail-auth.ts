import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";
import { eq, type Database } from "@kaname/db";
import { certificates, domains, mailAuthChecks, mailDomains, servers } from "@kaname/db/schema";
import {
  MAIL_AUTH_CHECK_META,
  type CheckStatus,
  type MailAuthCheck,
  type MailAuthCheckResult,
  type MailAuthReport,
  type Remediation,
} from "@kaname/contract";
import type { Logger } from "pino";
import type { AgentHub } from "../agent/hub.js";
import { notFound } from "../lib/errors.js";

/* ------------------------------------------------------------------ *
 * Mail DNS authentication (PLAN.md section 7).
 *
 * This is the module that has to be better than everyone else's. A panel
 * that dumps the DNS records it found has told the operator nothing they
 * could not get from `dig`. What actually breaks real mail setups is
 * narrower and duller than that: the mail hostname has no SPF of its own
 * so bounces fail the HELO check; the selector in DNS is not the key the
 * host signs with; the mail host sits behind an orange cloud so SMTP
 * never arrives and SPF authorises a CDN instead of the server.
 *
 * So every check here answers three things: what is wrong, what it costs
 * you in delivered mail, and the exact record to create.
 * ------------------------------------------------------------------ */

/** Report order. Roughly "can mail arrive" then "will it be believed". */
export const MAIL_AUTH_ORDER: readonly MailAuthCheck[] = [
  "mx",
  "host_spf",
  "spf",
  "dkim",
  "dmarc",
  "ptr",
  "tls",
  "proxy_exposure",
];

const DNS_TIMEOUT_MS = 4_000;
const DNS_TRIES = 2;
const RPC_TIMEOUT_MS = 10_000;
/** RFC 7208 §4.6.4. Past this, receivers return permerror. */
const SPF_LOOKUP_LIMIT = 10;
const SPF_MAX_DEPTH = 6;
/** RFC 8301: below this, receivers reject the signature outright. */
const DKIM_MIN_BITS = 1024;
const CERT_EXPIRY_WARN_DAYS = 14;

/**
 * Cloudflare's published edge ranges. Shipped as a constant rather than
 * fetched: this check has to work on an air-gapped install, and a proxy
 * range that silently fails open would make the check worthless.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const PROXY_NETWORKS: readonly { provider: string; control: string; list: BlockList }[] = [
  {
    provider: "Cloudflare",
    control: "the orange cloud next to the record in the Cloudflare dashboard",
    list: buildBlockList([...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES]),
  },
];

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface MailAuthCheckerDeps {
  db: Database;
  hub: AgentHub;
  log?: Logger;
}

export interface MailAuthRunOptions {
  /** Omit to run the whole list. */
  checks?: readonly MailAuthCheck[];
  /** Resolver address to query instead of the system resolvers. */
  resolver?: string;
}

/** One check's verdict, before it is given an id and a timestamp. */
interface CheckOutcome {
  check: MailAuthCheck;
  status: CheckStatus;
  title: string;
  detail: string;
  expected: string | null;
  actual: string | null;
  remediation: Remediation | null;
}

interface Subject {
  mailDomainId: string;
  /** The apex, e.g. example.com. */
  domain: string;
  /** The HELO / MX name, e.g. mail.example.com. NOT the apex. */
  mailHostname: string;
  dkimSelector: string;
  dkimPublicKey: string | null;
  apexProxied: boolean;
  serverId: string;
  serverName: string;
  serverAddress: string | null;
  agentOnline: boolean;
}

interface DkimKey {
  selector: string;
  public_key: string;
  key_bits: number;
  txt_value: string;
}

/* ------------------------------------------------------------------ *
 * The checker
 * ------------------------------------------------------------------ */

export class MailAuthChecker {
  constructor(private readonly deps: MailAuthCheckerDeps) {}

  /** Runs the checks, persists every verdict, and returns the full report. */
  async run(mailDomainId: string, opts: MailAuthRunOptions = {}): Promise<MailAuthReport> {
    const subject = await this.loadSubject(mailDomainId);
    const dns = new DnsView(opts.resolver);
    const wanted = opts.checks?.length
      ? MAIL_AUTH_ORDER.filter((c) => opts.checks!.includes(c))
      : MAIL_AUTH_ORDER;

    // Parallel because the checks share a memoised resolver: eight
    // sequential checks against a slow authoritative server is the
    // difference between a two-second page and a twenty-second one.
    const results = await Promise.all(
      wanted.map(async (check) => {
        const started = Date.now();
        try {
          const outcome = await this.execute(check, subject, dns);
          return { outcome, durationMs: Date.now() - started };
        } catch (err) {
          this.deps.log?.warn({ err, check, mailDomainId }, "mail auth check crashed");
          return { outcome: crashed(check, err), durationMs: Date.now() - started };
        }
      }),
    );

    await this.persist(subject, results, dns.used);
    return this.report(mailDomainId);
  }

  /** The stored report, without touching DNS or the host. */
  async report(mailDomainId: string): Promise<MailAuthReport> {
    const subject = await this.loadSubject(mailDomainId);
    const rows = await this.deps.db
      .select()
      .from(mailAuthChecks)
      .where(eq(mailAuthChecks.mailDomainId, mailDomainId));

    const byCheck = new Map(rows.map((row) => [row.check, row]));
    const checks: MailAuthCheckResult[] = [];
    for (const check of MAIL_AUTH_ORDER) {
      const row = byCheck.get(check);
      if (!row) continue;
      checks.push({
        id: row.id,
        mail_domain_id: row.mailDomainId,
        check: row.check,
        status: row.status,
        title: row.title,
        detail: row.detail,
        expected: row.expected,
        actual: row.actual,
        remediation: row.remediation ?? null,
        checked_at: row.checkedAt.toISOString(),
        duration_ms: row.durationMs ?? 0,
      });
    }

    const latest = checks.reduce<string | null>(
      (acc, c) => (acc === null || c.checked_at > acc ? c.checked_at : acc),
      null,
    );

    return {
      mail_domain_id: mailDomainId,
      domain_name: subject.domain,
      overall: worstOf(checks.map((c) => c.status)),
      checks,
      checked_at: latest ?? new Date().toISOString(),
      resolver_used: rows.find((r) => r.resolverUsed)?.resolverUsed ?? "system",
    };
  }

  /* --------------------------- dispatch ---------------------------- */

  private execute(check: MailAuthCheck, s: Subject, dns: DnsView): Promise<CheckOutcome> {
    switch (check) {
      case "mx":
        return this.checkMx(s, dns);
      case "host_spf":
        return this.checkHostSpf(s, dns);
      case "spf":
        return this.checkSpf(s, dns);
      case "dkim":
        return this.checkDkim(s, dns);
      case "dmarc":
        return this.checkDmarc(s, dns);
      case "ptr":
        return this.checkPtr(s, dns);
      case "tls":
        return this.checkTls(s, dns);
      case "proxy_exposure":
        return this.checkProxyExposure(s, dns);
    }
  }

  /* ------------------------------ mx ------------------------------- */

  private async checkMx(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.mx.title;
    const expected = record(s.domain, "MX", `10 ${s.mailHostname}.`);
    const answer = await dns.mx(s.domain);

    if (answer.error && !isAbsent(answer.error)) {
      return {
        check: "mx",
        status: "unknown",
        title,
        detail: `Looking up the MX of ${s.domain} returned ${answer.error} instead of an answer. That is the zone failing to respond, not a missing record — every other DNS check below is reading the same broken delegation, so fix this first or their verdicts mean nothing.`,
        expected,
        actual: null,
        remediation: {
          summary: `Confirm the nameservers listed for ${s.domain} at its registrar are actually serving the zone, then re-run this check.`,
          actions: [{ label: "Open DNS", href: "/websites/dns" }],
        },
      };
    }

    if (answer.values.length === 0) {
      return {
        check: "mx",
        status: "fail",
        title,
        detail: `${s.domain} has no MX record, so nothing tells a sender where its mail goes. Senders either bounce the message immediately or fall back to the apex A record — which on this setup is the web server, not ${s.mailHostname}, so mail is delivered to a host with no mail stack and disappears.`,
        expected,
        actual: null,
        remediation: {
          summary: `Add an MX record for ${s.domain} pointing at ${s.mailHostname}, and make sure ${s.mailHostname} has an A record of its own.`,
          actions: [
            { label: "Copy record", copy: expected },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const sorted = [...answer.values].sort((a, b) => a.priority - b.priority);
    const actual = sorted.map((v) => `${v.priority} ${v.exchange}`).join(", ");
    const primary = sorted[0]!;
    const primaryAddresses = await this.addressesOf(dns, primary.exchange);

    if (primaryAddresses.length === 0) {
      const fix = record(
        primary.exchange,
        "A",
        s.serverAddress ?? "<this server's public address>",
      );
      return {
        check: "mx",
        status: "fail",
        title,
        detail: `The lowest-preference MX for ${s.domain} is ${primary.exchange}, and that name has no A or AAAA record. A sending server resolves the MX, finds no address to connect to, and gives up: every message to this domain bounces before it ever reaches ${s.serverName}.`,
        expected: fix,
        actual,
        remediation: {
          summary: `Give ${primary.exchange} an address record, or repoint the MX at ${s.mailHostname} if that name was a typo.`,
          actions: [
            { label: "Copy record", copy: fix },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    if (!sorted.some((v) => sameHost(v.exchange, s.mailHostname))) {
      return {
        check: "mx",
        status: "warn",
        title,
        detail: `Mail for ${s.domain} is delivered to ${sorted.map((v) => v.exchange).join(", ")}, not to ${s.mailHostname}. That is correct if this domain receives at an external provider and ${s.serverName} only sends — but then the mailboxes Kaname manages here will never receive anything, because inbound mail is going somewhere else entirely.`,
        expected,
        actual,
        remediation: {
          summary: `If ${s.serverName} should receive this domain's mail, repoint the MX at ${s.mailHostname}. If an external provider is intentional, this warning is the reminder that the mailboxes on this host are send-only.`,
          actions: [
            { label: "Copy record", copy: expected },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    return {
      check: "mx",
      status: "pass",
      title,
      detail: `${s.domain} delivers to ${primary.exchange} at preference ${primary.priority}, which resolves to ${primaryAddresses.join(", ")}.`,
      expected,
      actual,
      remediation: null,
    };
  }

  /* ---------------------------- host_spf --------------------------- */

  private async checkHostSpf(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.host_spf.title;
    const expected = record(s.mailHostname, "TXT", `"v=spf1 a -all"`);
    const answer = await dns.txt(s.mailHostname);
    const records = answer.values.filter(isSpf);

    if (answer.error && !isAbsent(answer.error)) {
      return unknownLookup("host_spf", title, s.mailHostname, "TXT", answer.error, expected);
    }

    if (records.length === 0) {
      return {
        check: "host_spf",
        status: "fail",
        title,
        detail: `${s.mailHostname} publishes no SPF record of its own, separate from the one on ${s.domain}. This matters for a specific class of message: a bounce or delivery-status notification leaves with an empty envelope sender, so the receiver has no MAIL FROM domain to evaluate and falls back to the HELO identity — which is ${s.mailHostname}, not ${s.domain}. With nothing published there the HELO check returns "none", and receivers that require an authenticated identity (Outlook.com most visibly) treat those messages as unauthenticated no matter how correct ${s.domain}'s own SPF is.`,
        expected,
        actual: null,
        remediation: {
          summary: `Add a TXT record on the mail hostname itself. "a" authorises whatever ${s.mailHostname} resolves to, so it stays correct if the server's address changes; "-all" refuses everything else. This is a second record, not a replacement for the one on ${s.domain}.`,
          actions: [
            { label: "Copy record", copy: `v=spf1 a -all` },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const actual = records.join(" | ");
    if (records.length > 1) {
      return {
        check: "host_spf",
        status: "fail",
        title,
        detail: `${s.mailHostname} publishes ${records.length} SPF records. RFC 7208 makes more than one a permanent error, so receivers stop evaluating and treat the HELO identity as unauthenticated — the same outcome as publishing nothing, reached by a route that looks like it should work.`,
        expected,
        actual,
        remediation: {
          summary: `Delete all but one TXT record starting with "v=spf1" on ${s.mailHostname}.`,
          actions: [
            { label: "Copy record", copy: `v=spf1 a -all` },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const qualifier = allQualifier(records[0]!);
    if (qualifier === "+") {
      return {
        check: "host_spf",
        status: "fail",
        title,
        detail: `${s.mailHostname} publishes "+all", which authorises every host on the internet to use this name in HELO. It is strictly worse than having no record: it converts a "none" result into an explicit pass for spammers.`,
        expected,
        actual,
        remediation: {
          summary: `Replace "+all" with "-all" on ${s.mailHostname}.`,
          actions: [{ label: "Copy record", copy: `v=spf1 a -all` }],
        },
      };
    }
    if (qualifier === "?" || qualifier === null) {
      return {
        check: "host_spf",
        status: "warn",
        title,
        detail: `${s.mailHostname} has an SPF record but ${qualifier === "?" ? `it ends in "?all", which tells receivers to draw no conclusion` : `it has no "all" mechanism, so anything it does not list is neutral`}. The record documents your sender without protecting the name, so a forged HELO from elsewhere still evaluates as neutral rather than fail.`,
        expected,
        actual,
        remediation: {
          summary: `End the record with "-all" once you have confirmed nothing else sends using this hostname.`,
          actions: [{ label: "Copy record", copy: `v=spf1 a -all` }],
        },
      };
    }

    return {
      check: "host_spf",
      status: "pass",
      title,
      detail: `${s.mailHostname} publishes its own SPF record, so bounces and delivery-status notifications from this host pass the HELO check.`,
      expected,
      actual,
      remediation: null,
    };
  }

  /* ------------------------------ spf ------------------------------ */

  private async checkSpf(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.spf.title;
    const sender = s.serverAddress ? `ip4:${s.serverAddress}` : `a:${s.mailHostname}`;
    const proposal = `v=spf1 ${sender} -all`;
    const expected = record(s.domain, "TXT", `"${proposal}"`);
    const answer = await dns.txt(s.domain);
    const records = answer.values.filter(isSpf);

    if (answer.error && !isAbsent(answer.error)) {
      return unknownLookup("spf", title, s.domain, "TXT", answer.error, expected);
    }

    if (records.length === 0) {
      return {
        check: "spf",
        status: "fail",
        title,
        detail: `${s.domain} publishes no SPF record, so receivers have no list of hosts allowed to send as it. Two things follow: your own mail is judged on reputation alone and lands in spam far more often, and anyone can send mail claiming to be from ${s.domain} without contradicting a single DNS record.`,
        expected,
        actual: null,
        remediation: {
          summary: `Publish a TXT record on ${s.domain}. Start with "~all" instead of "-all" if other systems (a CRM, a newsletter tool) also send as this domain, then tighten it once DMARC reports show who they are.`,
          actions: [
            { label: "Copy record", copy: proposal },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const actual = records.join(" | ");

    if (records.length > 1) {
      const merged = mergeSpf(records);
      return {
        check: "spf",
        status: "fail",
        title,
        detail: `${s.domain} publishes ${records.length} SPF records. RFC 7208 requires receivers to return permerror when they find more than one, and most treat permerror as a failure — so every message you send is evaluated against no usable SPF at all, even though each record on its own is fine. This is the single most common way a working setup breaks: a second record gets added for a new sending service instead of merging into the first.`,
        expected: record(s.domain, "TXT", `"${merged}"`),
        actual,
        remediation: {
          summary: `Merge them into one record and delete the rest. Kaname's merge keeps every mechanism in order and uses the most permissive "all" of the set, so nothing that passes today starts failing.`,
          actions: [
            { label: "Copy merged record", copy: merged },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const record0 = records[0]!;
    const qualifier = allQualifier(record0);

    if (qualifier === "+") {
      return {
        check: "spf",
        status: "fail",
        title,
        detail: `${s.domain}'s SPF ends in "+all", which authorises the entire internet to send as this domain. Spam sent in your name passes SPF, and because DMARC alignment is satisfied by that pass, a DMARC policy will not stop it either.`,
        expected,
        actual,
        remediation: {
          summary: `Replace "+all" with "-all" (or "~all" while you confirm every legitimate sender is listed).`,
          actions: [{ label: "Copy record", copy: proposal }],
        },
      };
    }

    const seen = new Set<string>([s.domain.toLowerCase()]);
    const lookups = await this.spfLookups(dns, record0, seen, 0);
    if (lookups.total > SPF_LOOKUP_LIMIT) {
      const heaviest = [...lookups.breakdown].sort((a, b) => b.cost - a.cost).slice(0, 3);
      const worst = heaviest[0]!;
      return {
        check: "spf",
        status: "fail",
        title,
        detail: `Evaluating this record costs ${lookups.total} DNS lookups; RFC 7208 caps it at ${SPF_LOOKUP_LIMIT}. Past the cap receivers return permerror and stop, so the record fails for everyone — including the senders listed before the cap was reached. The heaviest terms are ${heaviest.map((h) => `${h.term} (${h.cost})`).join(", ")}.`,
        expected: null,
        actual: `${actual} — ${lookups.total} lookups`,
        remediation: {
          summary: `Flatten or drop the heaviest include. "${worst.term}" alone costs ${worst.cost} lookups; replacing it with the ip4/ip6 ranges it currently publishes removes that cost entirely, at the price of having to refresh them when that provider changes.`,
          actions: [{ label: "Open DNS", href: "/websites/dns" }],
        },
      };
    }

    if (qualifier === "?" || qualifier === null) {
      return {
        check: "spf",
        status: "warn",
        title,
        detail: `${s.domain}'s SPF ${qualifier === "?" ? `ends in "?all", which explicitly tells receivers to draw no conclusion about hosts it does not list` : `has no "all" mechanism, so unlisted hosts are neutral by default`}. The record enumerates your senders but gives a receiver no reason to reject anyone else, and DMARC cannot act on a neutral result.`,
        expected,
        actual,
        remediation: {
          summary: `End the record with "~all" (soft fail) and move to "-all" once DMARC reports show no legitimate sender is missing.`,
          actions: [{ label: "Copy record", copy: proposal }],
        },
      };
    }

    return {
      check: "spf",
      status: "pass",
      title,
      detail: `${s.domain} publishes one SPF record ending in "${qualifier}all", evaluated in ${lookups.total} of the ${SPF_LOOKUP_LIMIT} permitted DNS lookups.`,
      expected,
      actual,
      remediation: null,
    };
  }

  /** Counts what a receiver must resolve, including nested includes. */
  private async spfLookups(
    dns: DnsView,
    spfRecord: string,
    seen: Set<string>,
    depth: number,
  ): Promise<{ total: number; breakdown: { term: string; cost: number }[] }> {
    const breakdown: { term: string; cost: number }[] = [];
    if (depth > SPF_MAX_DEPTH) return { total: 0, breakdown };

    let total = 0;
    for (const raw of spfRecord.split(/\s+/).slice(1)) {
      const term = raw.replace(/^[+\-~?]/, "");
      const lower = term.toLowerCase();
      let cost = 0;

      if (lower.startsWith("include:") || lower.startsWith("redirect=")) {
        cost = 1;
        const target = term.slice(lower.startsWith("include:") ? 8 : 9).trim();
        const key = target.toLowerCase();
        // A cycle would otherwise resolve forever; receivers cut it too.
        if (target && !seen.has(key)) {
          seen.add(key);
          const nested = (await dns.txt(target)).values.find(isSpf);
          if (nested) cost += (await this.spfLookups(dns, nested, seen, depth + 1)).total;
        }
      } else if (/^(a|mx|ptr|exists)([:/]|$)/.test(lower)) {
        cost = 1;
      }

      if (cost > 0) {
        total += cost;
        breakdown.push({ term, cost });
      }
    }
    return { total, breakdown };
  }

  /* ----------------------------- dkim ------------------------------ */

  private async checkDkim(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.dkim.title;
    const name = `${s.dkimSelector}._domainkey.${s.domain}`;
    const answer = await dns.txt(name);
    const published = answer.values.find((v) => /(^|;)\s*p=/.test(v) || /v=dkim1/i.test(v));
    const hostKey = await this.readDkimKey(s);
    const expected = hostKey
      ? record(name, "TXT", `"${hostKey.txt_value}"`)
      : record(name, "TXT", `"v=DKIM1; k=rsa; p=<the public key held by ${s.serverName}>"`);

    if (answer.error && !isAbsent(answer.error) && !published) {
      return unknownLookup("dkim", title, name, "TXT", answer.error, expected);
    }

    if (!published) {
      return {
        check: "dkim",
        status: "fail",
        title,
        detail: hostKey
          ? `${s.serverName} signs every outbound message for ${s.domain} with selector "${s.dkimSelector}", but ${name} does not exist. Receivers fetch that name to get the key, find nothing, and record the signature as unverifiable — so the signing is pure cost, and DMARC alignment falls back to SPF alone, which breaks the moment a message is forwarded.`
          : `${name} does not exist, so nothing can verify the signatures ${s.serverName} attaches to outbound mail. Kaname could not read the host's own key to show you the exact value — the agent is offline or the mail stack is not installed — so bring the agent back and re-run this check to get the record to paste.`,
        expected,
        actual: null,
        remediation: {
          summary: hostKey
            ? `Publish this TXT record on ${name}. The value is read from ${s.serverName}, so it is the key that host actually signs with, not a template.`
            : `Reconnect the agent on ${s.serverName} and re-run the check; Kaname will then show the exact selector record to publish.`,
          actions: hostKey
            ? [
                { label: "Copy record", copy: hostKey.txt_value },
                { label: "Open DNS", href: "/websites/dns" },
              ]
            : [{ label: "Check agent", action: "servers.ping" }],
        },
      };
    }

    const publishedKey = normalizeKey(tagValue(published, "p") ?? "");
    if (publishedKey === "") {
      return {
        check: "dkim",
        status: "fail",
        title,
        detail: `${name} exists but publishes an empty "p=" value. In DKIM that is not an empty field, it is a revocation: receivers read it as "this key is withdrawn" and treat every signature made with selector "${s.dkimSelector}" as a hard failure.`,
        expected,
        actual: published,
        remediation: {
          summary: hostKey
            ? `Replace the record with the key ${s.serverName} is signing with, below.`
            : `Republish the selector with the host's real public key, or rotate to a new selector.`,
          actions: hostKey ? [{ label: "Copy record", copy: hostKey.txt_value }] : [],
        },
      };
    }

    if (!hostKey) {
      return {
        check: "dkim",
        status: "unknown",
        title,
        detail: `${name} publishes a key, but Kaname could not read the key ${s.serverName} actually signs with — the agent is offline or the host has no mail stack — so the two cannot be compared. A published selector that does not match the signing key fails harder than no selector at all, which is exactly why this check refuses to report a pass on DNS alone.`,
        expected: null,
        actual: published,
        remediation: {
          summary: `Reconnect the agent on ${s.serverName} and re-run the check.`,
          actions: [{ label: "Check agent", action: "servers.ping" }],
        },
      };
    }

    const hostPublic = normalizeKey(tagValue(hostKey.txt_value, "p") ?? hostKey.public_key);
    if (hostPublic && publishedKey !== hostPublic) {
      return {
        check: "dkim",
        status: "fail",
        title,
        detail: `The selector exists but publishes a different key than the one ${s.serverName} signs with. This is worse than a missing record: a receiver finds a key, verifies the signature against it, and gets an explicit failure — so DMARC sees "dkim=fail" rather than "dkim=none", and a policy of quarantine or reject acts on it. It usually means the key was rotated on the host without republishing DNS, or the record was copied from a different server.`,
        expected,
        actual: published,
        remediation: {
          summary: `Replace the TXT record on ${name} with the value below, which Kaname read from ${s.serverName} just now. Allow for the old record's TTL before signatures start verifying.`,
          actions: [
            { label: "Copy record", copy: hostKey.txt_value },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    if (hostKey.key_bits > 0 && hostKey.key_bits < DKIM_MIN_BITS) {
      return {
        check: "dkim",
        status: "fail",
        title,
        detail: `The published key matches the host, but it is ${hostKey.key_bits}-bit. RFC 8301 sets ${DKIM_MIN_BITS} bits as the floor and Google and Microsoft reject shorter keys outright, so the signature is treated as absent by exactly the receivers that matter most.`,
        expected,
        actual: `${published} (${hostKey.key_bits}-bit)`,
        remediation: {
          summary: `Generate a 2048-bit key on ${s.serverName} under a new selector, publish it, then switch signing to the new selector so no mail is signed with a key that is not yet in DNS.`,
          actions: [{ label: "Open DNS", href: "/websites/dns" }],
        },
      };
    }

    return {
      check: "dkim",
      status: "pass",
      title,
      detail: `${name} publishes the same ${hostKey.key_bits}-bit key that ${s.serverName} signs with, so signatures verify at the receiver.`,
      expected,
      actual: published,
      remediation: null,
    };
  }

  /** The host is the authority on its own key, so the panel's copy follows it. */
  private async readDkimKey(s: Subject): Promise<DkimKey | null> {
    if (!s.agentOnline) return null;
    try {
      const key = await this.deps.hub.call(
        s.serverId,
        "mail.dkim.read",
        { domain: s.domain },
        { timeoutMs: RPC_TIMEOUT_MS },
      );
      if (key.public_key && key.public_key !== s.dkimPublicKey) {
        await this.deps.db
          .update(mailDomains)
          .set({ dkimPublicKey: key.public_key, updatedAt: new Date() })
          .where(eq(mailDomains.id, s.mailDomainId));
      }
      return key;
    } catch (err) {
      this.deps.log?.debug({ err, serverId: s.serverId }, "dkim key read unavailable");
      return null;
    }
  }

  /* ----------------------------- dmarc ----------------------------- */

  private async checkDmarc(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.dmarc.title;
    const name = `_dmarc.${s.domain}`;
    const proposal = `v=DMARC1; p=none; rua=mailto:dmarc@${s.domain}; fo=1; adkim=r; aspf=r`;
    const expected = record(name, "TXT", `"${proposal}"`);
    const answer = await dns.txt(name);
    const records = answer.values.filter((v) => /^v=dmarc1\b/i.test(v.trim()));

    if (answer.error && !isAbsent(answer.error)) {
      return unknownLookup("dmarc", title, name, "TXT", answer.error, expected);
    }

    if (records.length === 0) {
      return {
        check: "dmarc",
        status: "fail",
        title,
        detail: `${s.domain} has no DMARC record. Receivers are left to guess what to do when SPF and DKIM fail, which in practice means delivering the message to spam rather than rejecting it — and you never find out, because there is no address for the reports that would have told you who is sending as your domain.`,
        expected,
        actual: null,
        remediation: {
          summary: `Publish the record below and leave it at "p=none" for two weeks. Read the aggregate reports, confirm every legitimate sender aligns, then move to "p=quarantine" and finally "p=reject". Starting at reject is how a domain silently loses its own mail.`,
          actions: [
            { label: "Copy record", copy: proposal },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const actual = records.join(" | ");
    if (records.length > 1) {
      return {
        check: "dmarc",
        status: "fail",
        title,
        detail: `${name} publishes ${records.length} DMARC records. A receiver that finds more than one discards all of them, so the domain has no policy at all — the appearance of DMARC with none of the effect.`,
        expected,
        actual,
        remediation: {
          summary: `Keep exactly one TXT record starting "v=DMARC1" on ${name} and delete the rest.`,
          actions: [
            { label: "Copy record", copy: proposal },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const tags = parseTags(records[0]!);
    const policy = tags.get("p");
    if (!policy) {
      return {
        check: "dmarc",
        status: "fail",
        title,
        detail: `The DMARC record on ${name} has no "p=" tag. The policy tag is mandatory and must come first, so receivers reject the whole record as malformed and fall back to no DMARC at all.`,
        expected,
        actual,
        remediation: {
          summary: `Add the policy tag immediately after "v=DMARC1".`,
          actions: [{ label: "Copy record", copy: proposal }],
        },
      };
    }
    if (!["none", "quarantine", "reject"].includes(policy)) {
      return {
        check: "dmarc",
        status: "fail",
        title,
        detail: `The DMARC record on ${name} sets "p=${policy}", which is not one of none, quarantine or reject. Receivers treat the record as syntactically invalid and ignore it entirely.`,
        expected,
        actual,
        remediation: {
          summary: `Set p= to none, quarantine or reject.`,
          actions: [{ label: "Copy record", copy: proposal }],
        },
      };
    }

    const rua = tags.get("rua");
    if (policy === "none" && !rua) {
      return {
        check: "dmarc",
        status: "fail",
        title,
        detail: `${s.domain} publishes "p=none" with no "rua=" address. That combination does nothing at all: it asks receivers to take no action and sends the reports nowhere, so you get neither enforcement against spoofing nor the visibility that would let you turn enforcement on.`,
        expected,
        actual,
        remediation: {
          summary: `Add an rua address so aggregate reports start arriving, read them for two weeks, then raise the policy to quarantine.`,
          actions: [
            { label: "Copy record", copy: proposal },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const pct = Number(tags.get("pct") ?? "100");
    if (Number.isFinite(pct) && pct < 100) {
      return {
        check: "dmarc",
        status: "warn",
        title,
        detail: `The policy is "p=${policy}" but "pct=${pct}", so it is applied to only ${pct}% of failing mail. That is the right setting while ramping up, and the wrong one to leave in place — the remaining ${100 - pct}% of spoofed mail is delivered untouched.`,
        expected,
        actual,
        remediation: {
          summary: `Remove the pct tag (it defaults to 100) once the reports show no legitimate sender failing.`,
          actions: [{ label: "Open DNS", href: "/websites/dns" }],
        },
      };
    }

    return {
      check: "dmarc",
      status: "pass",
      title,
      detail:
        policy === "none"
          ? `${s.domain} publishes "p=none" with reports going to ${rua}. Monitoring is working; once the reports show every legitimate sender aligned, raise the policy to quarantine and then reject — none on its own stops nothing.`
          : `${s.domain} publishes "p=${policy}"${rua ? `, with aggregate reports going to ${rua}` : " (consider adding an rua address so you keep seeing who fails)"}.`,
      expected,
      actual,
      remediation: null,
    };
  }

  /* ------------------------------ ptr ------------------------------ */

  private async checkPtr(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.ptr.title;
    const addresses = await this.addressesOf(dns, s.mailHostname);
    const ip = s.serverAddress ?? addresses.find(isIPv4) ?? addresses[0];

    if (!ip) {
      return {
        check: "ptr",
        status: "unknown",
        title,
        detail: `Kaname does not know which address ${s.serverName} sends from: the server record has no address and ${s.mailHostname} does not resolve, so there is no IP whose reverse DNS could be checked.`,
        expected: null,
        actual: null,
        remediation: {
          summary: `Set the public address on the server record, or give ${s.mailHostname} an A record.`,
          actions: [{ label: "Open server", href: `/infrastructure/servers/${s.serverId}` }],
        },
      };
    }

    const proxy = proxyProviderFor(ip);
    const expected = `${reverseName(ip)}.\t3600\tIN\tPTR\t${s.mailHostname}.`;
    const answer = await dns.reverse(ip);

    if (answer.values.length === 0) {
      return {
        check: "ptr",
        status: "fail",
        title,
        detail: `${ip} has no PTR record. Every large receiver treats a missing reverse name as a spam signal on its own — Gmail throttles it, Outlook.com refuses the connection outright with "attempted to send mail from a host without reverse DNS". This is also the one record you cannot fix in your own zone: it is delegated to whoever owns the address block.${proxy ? ` Note that ${ip} belongs to ${proxy.provider}, which means you are checking the proxy's address rather than the server's — see the proxy exposure check.` : ""}`,
        expected,
        actual: null,
        remediation: {
          summary: `Set the reverse DNS for ${ip} to ${s.mailHostname} in your hosting provider's console (usually next to the IP, labelled rDNS or PTR). It cannot be added to ${s.domain}'s zone.`,
          actions: [{ label: "Copy value", copy: s.mailHostname }],
        },
      };
    }

    const actual = answer.values.join(", ");
    if (!answer.values.some((n) => sameHost(n, s.mailHostname))) {
      return {
        check: "ptr",
        status: "fail",
        title,
        detail: `${ip} reverses to ${actual}, which is not the name this host announces in HELO (${s.mailHostname}). Receivers compare the two and a mismatch is scored as forged or misconfigured — a default provider name like the one above is a strong spam signal because it is what an unconfigured box looks like.`,
        expected,
        actual,
        remediation: {
          summary: `Change the reverse DNS for ${ip} to ${s.mailHostname} at your hosting provider, and make sure ${s.mailHostname} resolves back to ${ip} so the pair confirms in both directions.`,
          actions: [{ label: "Copy value", copy: s.mailHostname }],
        },
      };
    }

    const forward = await this.addressesOf(dns, s.mailHostname);
    if (!forward.includes(ip)) {
      return {
        check: "ptr",
        status: "warn",
        title,
        detail: `${ip} reverses to ${s.mailHostname} correctly, but ${s.mailHostname} resolves to ${forward.join(", ") || "nothing"} rather than back to ${ip}. Receivers that require forward-confirmed reverse DNS resolve the PTR name and check the address matches; a half-configured pair fails that test even though the PTR itself looks right.`,
        expected,
        actual,
        remediation: {
          summary: `Point ${s.mailHostname} at ${ip} so the forward and reverse records agree.`,
          actions: [
            { label: "Copy record", copy: record(s.mailHostname, "A", ip) },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    return {
      check: "ptr",
      status: "pass",
      title,
      detail: `${ip} reverses to ${s.mailHostname} and that name resolves back to ${ip}, so forward-confirmed reverse DNS holds.`,
      expected,
      actual,
      remediation: null,
    };
  }

  /* ------------------------------ tls ------------------------------ */

  private async checkTls(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.tls.title;
    const rows = await this.deps.db
      .select()
      .from(certificates)
      .where(eq(certificates.serverId, s.serverId));

    const covering = rows.filter(
      (row) =>
        row.status !== "revoked" &&
        [row.subject, ...row.sans].some((n) => coversHost(n, s.mailHostname)),
    );
    const mtaSts = (await dns.txt(`_mta-sts.${s.domain}`)).values.find((v) =>
      /^v=stsv1\b/i.test(v.trim()),
    );
    const stsNote = mtaSts
      ? ` ${s.domain} also publishes MTA-STS, which turns a name mismatch from a downgrade into a refusal: a receiver honouring the policy will not deliver over an untrusted session at all.`
      : "";

    if (covering.length === 0) {
      const known = rows.map((r) => r.subject).join(", ") || "none";
      return {
        check: "tls",
        status: "fail",
        title,
        detail: `No certificate on ${s.serverName} covers ${s.mailHostname}; the certificates Kaname knows about here are: ${known}. Postfix will still offer STARTTLS, but it presents a certificate for the wrong name, so a verifying receiver either falls back to plaintext or defers the message.${stsNote}`,
        expected: `A certificate whose subject or SAN list includes ${s.mailHostname}`,
        actual: `No covering certificate (${known})`,
        remediation: {
          summary: `Issue a certificate for ${s.mailHostname} on ${s.serverName} and point Postfix and Dovecot at it. A single certificate can carry the web names and the mail hostname together.`,
          actions: [
            { label: "Issue certificate", action: "certificates.issue" },
            { label: "Open SSL", href: "/websites/ssl" },
          ],
        },
      };
    }

    const best = covering.reduce((a, b) =>
      (b.expiresAt?.getTime() ?? 0) > (a.expiresAt?.getTime() ?? 0) ? b : a,
    );
    const expiresAt = best.expiresAt;
    const days = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
    const actual = `${best.subject}${expiresAt ? ` (expires ${expiresAt.toISOString().slice(0, 10)})` : ""}`;

    if (days !== null && days < 0) {
      return {
        check: "tls",
        status: "fail",
        title,
        detail: `The certificate covering ${s.mailHostname} expired ${Math.abs(days)} days ago. Receivers that verify the session reject or defer the message, and clients configured for this mailbox will refuse to connect rather than downgrade.${stsNote}`,
        expected: `A valid certificate covering ${s.mailHostname}`,
        actual,
        remediation: {
          summary: `Renew it now — renewal is a job, so it will retry on its own if the host is busy.`,
          actions: [
            { label: "Renew certificate", action: "certificates.renew" },
            { label: "Open SSL", href: "/websites/ssl" },
          ],
        },
      };
    }

    if (days !== null && days <= CERT_EXPIRY_WARN_DAYS) {
      return {
        check: "tls",
        status: "warn",
        title,
        detail: `The certificate covering ${s.mailHostname} expires in ${days} days. Mail is the surface where an expiry is noticed last, because nobody browses to a mail server — the first symptom is deferred mail.${stsNote}`,
        expected: `A valid certificate covering ${s.mailHostname}`,
        actual,
        remediation: {
          summary: `Confirm auto-renew is on for ${best.subject}, or renew it now.`,
          actions: [
            { label: "Renew certificate", action: "certificates.renew" },
            { label: "Open SSL", href: "/websites/ssl" },
          ],
        },
      };
    }

    return {
      check: "tls",
      status: "pass",
      title,
      detail: `${best.subject} covers ${s.mailHostname}${days !== null ? ` and is valid for another ${days} days` : ""}, so STARTTLS presents a name the receiver can verify.${mtaSts ? ` MTA-STS is published for ${s.domain}, which requires exactly this.` : ""}`,
      expected: null,
      actual,
      remediation: null,
    };
  }

  /* ------------------------- proxy_exposure ------------------------ */

  private async checkProxyExposure(s: Subject, dns: DnsView): Promise<CheckOutcome> {
    const title = MAIL_AUTH_CHECK_META.proxy_exposure.title;
    const addresses = await this.addressesOf(dns, s.mailHostname);
    const target = s.serverAddress ?? "<this server's public address>";
    const expected = `${record(s.mailHostname, "A", target)}   ; DNS only, never proxied`;

    if (addresses.length === 0) {
      return {
        check: "proxy_exposure",
        status: "unknown",
        title,
        detail: `${s.mailHostname} has no A or AAAA record, so there is no address to inspect for proxy exposure. Fix the addressing first — the MX check above says what is missing.`,
        expected,
        actual: null,
        remediation: {
          summary: `Give ${s.mailHostname} a DNS-only A record pointing at ${target}.`,
          actions: [
            { label: "Copy record", copy: expected },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    const proxied = addresses
      .map((ip) => ({ ip, network: proxyProviderFor(ip) }))
      .filter((entry): entry is { ip: string; network: (typeof PROXY_NETWORKS)[number] } =>
        Boolean(entry.network),
      );

    // A wildcard is invisible from the record list, so it is probed: if a
    // name that cannot exist answers with the same addresses, the mail
    // host has no record of its own and is being covered by `*`.
    const probe = `kaname-probe-${randomBytes(5).toString("hex")}.${s.domain}`;
    const probeAddresses = await this.addressesOf(dns, probe);
    const wildcardCovered = probeAddresses.length > 0 && sameSet(probeAddresses, addresses);
    const actual = `${addresses.join(", ")}${proxied.length ? ` (${proxied[0]!.network.provider})` : ""}${wildcardCovered ? ` — answered by *.${s.domain}` : ""}`;

    if (proxied.length > 0) {
      const provider = proxied[0]!.network;
      return {
        check: "proxy_exposure",
        status: "fail",
        title,
        detail: `${s.mailHostname} resolves to ${proxied.map((p) => p.ip).join(", ")}, which belongs to ${provider.provider}'s proxy network${wildcardCovered ? `, and it does so through the proxied wildcard *.${s.domain} rather than a record of its own` : ""}. Two separate things break. First, ${provider.provider} proxies HTTP and HTTPS only: a sending server that opens port 25 to that address reaches nothing, so inbound mail for ${s.domain} fails and outbound connections are refused by receivers doing a callback. Second, the addresses published are the proxy's, not ${s.serverName}'s — so an SPF record authorising "a" or "mx" for this name authorises tens of thousands of ${provider.provider} machines while ${s.serverAddress ?? "the real sending address"} is not authorised at all, which is a spoofing hole and a delivery failure in the same record.`,
        expected,
        actual,
        remediation: {
          summary: wildcardCovered
            ? `Create an explicit DNS-only A record for ${s.mailHostname} pointing at ${target}. Turning off the proxy on the wildcard is not enough on its own if the wildcard is meant to stay proxied for web traffic — the mail host needs its own record so it stops inheriting one.`
            : `Turn the proxy off for this record: click ${provider.control} so it goes DNS-only. The record must resolve to ${target} directly for SMTP to reach the host, and for SPF to authorise the right address.`,
          actions: [
            { label: "Copy record", copy: expected },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    if (wildcardCovered) {
      return {
        check: "proxy_exposure",
        status: "warn",
        title,
        detail: `${s.mailHostname} has no address record of its own — it is answered by the wildcard *.${s.domain}, which currently points at ${addresses.join(", ")}. Nothing is proxied today, so mail works, but the mail host's addressing is now a side effect of a record that exists for something else: the next time that wildcard is repointed or switched to a proxy, SMTP for this domain breaks with no change to anything that looks mail-related.`,
        expected,
        actual,
        remediation: {
          summary: `Create an explicit A record for ${s.mailHostname} pointing at ${target}, so the mail host stops depending on the wildcard.`,
          actions: [
            { label: "Copy record", copy: expected },
            { label: "Open DNS", href: "/websites/dns" },
          ],
        },
      };
    }

    return {
      check: "proxy_exposure",
      status: "pass",
      title,
      detail: `${s.mailHostname} resolves directly to ${addresses.join(", ")} with no CDN or proxy in front of it${s.apexProxied ? `, which is the right arrangement: ${s.domain} itself is proxied for web traffic while the mail hostname is DNS-only` : ""}.`,
      expected,
      actual,
      remediation: null,
    };
  }

  /* ---------------------------- plumbing --------------------------- */

  private async addressesOf(dns: DnsView, name: string): Promise<string[]> {
    const [v4, v6] = await Promise.all([dns.a(name), dns.aaaa(name)]);
    return [...v4.values, ...v6.values];
  }

  private async loadSubject(mailDomainId: string): Promise<Subject> {
    const rows = await this.deps.db
      .select({ mailDomain: mailDomains, domain: domains, server: servers })
      .from(mailDomains)
      .innerJoin(domains, eq(mailDomains.domainId, domains.id))
      .innerJoin(servers, eq(mailDomains.serverId, servers.id))
      .where(eq(mailDomains.id, mailDomainId))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound("Mail domain", mailDomainId);

    return {
      mailDomainId: row.mailDomain.id,
      domain: row.domain.name,
      mailHostname: row.mailDomain.mailHostname,
      dkimSelector: row.mailDomain.dkimSelector,
      dkimPublicKey: row.mailDomain.dkimPublicKey,
      apexProxied: row.domain.proxied,
      serverId: row.server.id,
      serverName: row.server.name,
      serverAddress: row.server.address,
      agentOnline: this.deps.hub.isConnected(row.server.id),
    };
  }

  private async persist(
    subject: Subject,
    results: { outcome: CheckOutcome; durationMs: number }[],
    resolverUsed: string,
  ): Promise<void> {
    const now = new Date();
    for (const { outcome, durationMs } of results) {
      await this.deps.db
        .insert(mailAuthChecks)
        .values({
          mailDomainId: subject.mailDomainId,
          check: outcome.check,
          status: outcome.status,
          title: outcome.title,
          detail: outcome.detail,
          expected: outcome.expected,
          actual: outcome.actual,
          remediation: outcome.remediation,
          resolverUsed,
          durationMs,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [mailAuthChecks.mailDomainId, mailAuthChecks.check],
          set: {
            status: outcome.status,
            title: outcome.title,
            detail: outcome.detail,
            expected: outcome.expected,
            actual: outcome.actual,
            remediation: outcome.remediation,
            resolverUsed,
            durationMs,
            checkedAt: now,
            updatedAt: now,
          },
        });
    }

    await this.deps.db
      .update(mailDomains)
      .set({ lastAuthCheckAt: now, updatedAt: now })
      .where(eq(mailDomains.id, subject.mailDomainId));
  }
}

/* ------------------------------------------------------------------ *
 * DNS
 * ------------------------------------------------------------------ */

interface Answer<T> {
  values: T[];
  /** Resolver error code, e.g. ENOTFOUND or SERVFAIL. Null on success. */
  error: string | null;
}

/**
 * A memoised view of DNS for one run. Memoising matters because several
 * checks want the same names (the mail host's addresses are needed by
 * ptr and proxy_exposure) and running the checks in parallel would
 * otherwise triple the query load on someone's authoritative server.
 */
class DnsView {
  readonly used: string;
  private readonly resolver: Resolver;
  private readonly cache = new Map<string, Promise<Answer<never>>>();

  constructor(server?: string) {
    this.resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
    if (server) this.resolver.setServers([server]);
    this.used = this.resolver.getServers().join(", ") || "system";
  }

  txt(name: string): Promise<Answer<string>> {
    return this.query(`TXT:${name}`, async () => {
      // A TXT record longer than 255 bytes arrives as several strings.
      const chunks = await this.resolver.resolveTxt(name);
      return chunks.map((parts) => parts.join(""));
    });
  }

  mx(name: string): Promise<Answer<{ priority: number; exchange: string }>> {
    return this.query(`MX:${name}`, () => this.resolver.resolveMx(name));
  }

  a(name: string): Promise<Answer<string>> {
    return this.query(`A:${name}`, () => this.resolver.resolve4(name));
  }

  aaaa(name: string): Promise<Answer<string>> {
    return this.query(`AAAA:${name}`, () => this.resolver.resolve6(name));
  }

  reverse(ip: string): Promise<Answer<string>> {
    return this.query(`PTR:${ip}`, () => this.resolver.reverse(ip));
  }

  private query<T>(key: string, run: () => Promise<T[]>): Promise<Answer<T>> {
    const cached = this.cache.get(key);
    if (cached) return cached as unknown as Promise<Answer<T>>;

    const promise = run()
      .then((values) => ({ values, error: null }))
      .catch((err: unknown) => ({
        values: [] as T[],
        error: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN",
      }));
    this.cache.set(key, promise as unknown as Promise<Answer<never>>);
    return promise;
  }
}

/** The record is genuinely absent, as opposed to the zone being broken. */
function isAbsent(code: string): boolean {
  return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function buildBlockList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of cidrs) {
    const [address, prefix] = entry.split("/");
    if (!address || !prefix) continue;
    list.addSubnet(address, Number(prefix), isIPv4(address) ? "ipv4" : "ipv6");
  }
  return list;
}

function proxyProviderFor(ip: string): (typeof PROXY_NETWORKS)[number] | null {
  const family = isIPv4(ip) ? "ipv4" : "ipv6";
  for (const network of PROXY_NETWORKS) {
    if (network.list.check(ip, family)) return network;
  }
  return null;
}

/** Zone-file shaped, so the value can be pasted straight into a provider. */
function record(name: string, type: string, value: string): string {
  return `${name}.\t3600\tIN\t${type}\t${value}`;
}

function sameHost(a: string, b: string): boolean {
  return a.replace(/\.$/, "").toLowerCase() === b.replace(/\.$/, "").toLowerCase();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((value) => left.has(value));
}

function isSpf(value: string): boolean {
  return /^v=spf1\b/i.test(value.trim());
}

/** The qualifier on the trailing `all`, or null when there is none. */
function allQualifier(spfRecord: string): "+" | "-" | "~" | "?" | null {
  const match = /(^|\s)([+\-~?]?)all(\s|$)/i.exec(spfRecord);
  if (!match) return null;
  return (match[2] || "+") as "+" | "-" | "~" | "?";
}

const ALL_PERMISSIVENESS: Record<string, number> = { "-": 0, "~": 1, "?": 2, "+": 3 };

/**
 * Union of the mechanisms, keeping the most permissive `all` of the set
 * (never `+all`): merging must not turn a sender that passes today into
 * one that fails tomorrow.
 */
function mergeSpf(records: readonly string[]): string {
  const mechanisms: string[] = [];
  let all: "+" | "-" | "~" | "?" = "-";

  for (const spfRecord of records) {
    for (const term of spfRecord.split(/\s+/).slice(1)) {
      if (/^[+\-~?]?all$/i.test(term)) {
        const qualifier = (term.replace(/all$/i, "") || "+") as "+" | "-" | "~" | "?";
        if (ALL_PERMISSIVENESS[qualifier]! > ALL_PERMISSIVENESS[all]!) all = qualifier;
        continue;
      }
      if (!mechanisms.some((m) => m.toLowerCase() === term.toLowerCase())) mechanisms.push(term);
    }
  }

  return ["v=spf1", ...mechanisms, `${all === "+" ? "~" : all}all`].join(" ");
}

function parseTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of value.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    tags.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
  }
  return tags;
}

function tagValue(value: string, tag: string): string | null {
  return parseTags(value).get(tag) ?? null;
}

/** DKIM keys are reassembled from TXT chunks, so whitespace is noise. */
function normalizeKey(value: string): string {
  return value.replace(/\s+/g, "");
}

function reverseName(ip: string): string {
  if (isIPv4(ip)) return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
  return `the ip6.arpa name for ${ip}`;
}

/** Exact match, or a single-label wildcard covering it. */
function coversHost(certName: string, host: string): boolean {
  const name = certName.replace(/\.$/, "").toLowerCase();
  const target = host.replace(/\.$/, "").toLowerCase();
  if (name === target) return true;
  if (!name.startsWith("*.")) return false;
  const parent = name.slice(2);
  const index = target.indexOf(".");
  return index > 0 && target.slice(index + 1) === parent;
}

function worstOf(statuses: readonly CheckStatus[]): CheckStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("unknown") || statuses.length === 0) return "unknown";
  return "pass";
}

function unknownLookup(
  check: MailAuthCheck,
  title: string,
  name: string,
  type: string,
  code: string,
  expected: string | null,
): CheckOutcome {
  return {
    check,
    status: "unknown",
    title,
    detail: `Looking up the ${type} record at ${name} returned ${code} rather than an answer, so this check has no verdict. ${code === "ETIMEOUT" ? "The authoritative nameservers did not respond in time." : "That is usually a broken delegation or a resolver that cannot reach the zone."}`,
    expected,
    actual: null,
    remediation: {
      summary: `Confirm the zone for ${name} is being served, then re-run the check.`,
      actions: [{ label: "Open DNS", href: "/websites/dns" }],
    },
  };
}

function crashed(check: MailAuthCheck, err: unknown): CheckOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return {
    check,
    status: "unknown",
    title: MAIL_AUTH_CHECK_META[check].title,
    detail: `Kaname could not complete this check: ${message}. The other checks in this report are unaffected.`,
    expected: null,
    actual: null,
    remediation: {
      summary:
        "Re-run the check. If it keeps failing the control plane's log carries the full error.",
      actions: [{ label: "Re-run checks", action: "mail.auth.check" }],
    },
  };
}
