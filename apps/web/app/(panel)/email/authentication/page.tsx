"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BadgeCheck, ChevronRight, CircleHelp, Globe, RefreshCw, ShieldCheck } from "lucide-react";
import {
  MAIL_AUTH_CHECK_META,
  mailAuthCheck,
  type CheckStatus,
  type Job,
  type MailAuthCheckResult,
  type MailAuthReport,
  type MailDomain,
  type RemediationAction,
} from "@kaname/contract";
import {
  Button,
  CopyableCode,
  Duration,
  EmptyState,
  JobProgress,
  JobStatusPill,
  MonoText,
  PageHeader,
  RelativeTime,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  cn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { formatCount } from "@/lib/format";
import { useCan, useJob, useJobLogs } from "@/lib/queries";
import { HostCell } from "../../_components/cells";
import { JobActivityBar } from "../../_components/JobActivity";
import { useMailAuthReport, useMailDomains, useRunMailAuthCheck } from "../_components/queries";
import { CHECK_META, CHECK_RANK, CheckStatusBadge, checkTextClass } from "../_components/status";

/* ------------------------------------------------------------------ *
 * DNS authentication.
 *
 * This is the page the module exists for. Every panel can print the DNS
 * records it found; that tells an operator nothing `dig` would not. What
 * actually breaks real mail is narrower and duller: the mail hostname
 * has no SPF of its own, so bounces fail the HELO check; the selector in
 * DNS is not the key the host signs with; the mail host sits behind an
 * orange cloud, so SMTP never arrives and SPF authorises a CDN.
 *
 * So each row answers three questions in order — what is wrong, what it
 * costs in delivered mail, and the exact record to publish — and the
 * record is always one click from the clipboard. Nothing here is a raw
 * zone dump.
 * ------------------------------------------------------------------ */

const AUTH_JOB_TYPES = ["mail.auth."] as const;
/** Report order: "can mail arrive" first, then "will it be believed". */
const CHECK_ORDER = mailAuthCheck.options;

type StatusFilter = "" | CheckStatus;

export default function MailAuthenticationPage() {
  const router = useRouter();
  const pathname = usePathname() ?? "/email/authentication";
  const searchParams = useSearchParams();

  const domains = useMailDomains();
  const domainList = React.useMemo(() => domains.data?.data ?? [], [domains.data]);

  const fromUrl = searchParams.get("mail_domain_id");
  const selectedId =
    fromUrl && domainList.some((domain) => domain.id === fromUrl)
      ? fromUrl
      : (domainList[0]?.id ?? null);
  const domain = domainList.find((entry) => entry.id === selectedId) ?? null;

  const select = React.useCallback(
    (mailDomainId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("mail_domain_id", mailDomainId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const can = useCan();
  const report = useMailAuthReport(selectedId);
  const recheck = useRunMailAuthCheck();
  const job = recheck.data?.[0] ?? null;
  const canRecheck = Boolean(domain) && can("email.auth:exec", domain?.server_id);

  const runCheck = React.useCallback(() => {
    if (!domain) return;
    recheck.mutate({ mail_domain_id: domain.id, domain: domain.domain_name });
  }, [domain, recheck]);

  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [seededFor, setSeededFor] = React.useState<string | null>(null);

  /* Anything that is not passing opens itself: the operator came here
   * because something is wrong, not to admire the green rows. */
  React.useEffect(() => {
    const data = report.data;
    if (!data || seededFor === data.mail_domain_id) return;
    setSeededFor(data.mail_domain_id);
    setExpanded(
      new Set(data.checks.filter((check) => check.status !== "pass").map((check) => check.check)),
    );
  }, [report.data, seededFor]);

  const toggle = React.useCallback((check: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(check)) next.delete(check);
      else next.add(check);
      return next;
    });
  }, []);

  const reveal = React.useCallback((check: string) => {
    setExpanded((current) => new Set(current).add(check));
    window.requestAnimationFrame(() => {
      document.getElementById(`check-${check}`)?.scrollIntoView({ block: "center" });
    });
  }, []);

  const ordered = React.useMemo(() => {
    const checks = report.data?.checks ?? [];
    const position = new Map(CHECK_ORDER.map((check, index) => [check, index] as const));
    return [...checks].sort(
      (a, b) => (position.get(a.check) ?? 99) - (position.get(b.check) ?? 99),
    );
  }, [report.data]);

  const noDomains = !domains.isLoading && domainList.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="DNS Authentication"
        subtitle={
          domain ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{domain.domain_name}</span>
              <span className="text-[var(--kn-text-3)]">signed and delivered by</span>
              <HostCell serverId={domain.server_id} serverName={domain.server_name} />
            </span>
          ) : undefined
        }
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={RefreshCw}
            disabled={!canRecheck || recheck.isPending}
            loading={recheck.isPending}
            onClick={runCheck}
          >
            Re-check
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
        <JobActivityBar types={AUTH_JOB_TYPES} title="Checks" />

        {noDomains ? (
          <SectionCard>
            <EmptyState
              icon={BadgeCheck}
              title="No domain hosts mail yet"
              description="These checks describe a domain whose mail this fleet carries. Add mail hosting to a domain and its records get checked from then on."
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => router.push("/websites/domains")}
                >
                  Open domains
                </Button>
              }
            />
          </SectionCard>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[288px_minmax(0,1fr)]">
            <DomainRail
              domains={domainList}
              loading={domains.isLoading}
              selectedId={selectedId}
              onSelect={select}
            />

            <div className="flex min-w-0 flex-col gap-4">
              {report.isError && (
                <PageError
                  error={report.error}
                  onRetry={() => void report.refetch()}
                  context={domain?.domain_name}
                />
              )}

              {job && <RecheckProgress job={job} />}

              {report.isLoading && <ReportSkeleton />}

              {report.data && ordered.length === 0 && (
                <SectionCard>
                  <EmptyState
                    icon={BadgeCheck}
                    title={`${report.data.domain_name} has never been checked`}
                    description="Kaname resolves these records from the control plane and reads the signing key off the host. Nothing has run for this domain yet, so there is nothing to report."
                    action={
                      <Button
                        variant="primary"
                        size="sm"
                        icon={RefreshCw}
                        disabled={!canRecheck || recheck.isPending}
                        loading={recheck.isPending}
                        onClick={runCheck}
                      >
                        Run the checks
                      </Button>
                    }
                  />
                </SectionCard>
              )}

              {report.data && ordered.length > 0 && (
                <>
                  <ReportSummary report={report.data} />

                  <div className="flex items-center justify-between gap-3">
                    <h2 className="font-medium text-[var(--kn-text)]">
                      {formatCount(ordered.length)} checks
                    </h2>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setExpanded(new Set(ordered.map((check) => check.check)))}
                      >
                        Expand all
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setExpanded(new Set())}>
                        Collapse all
                      </Button>
                    </div>
                  </div>

                  <ul className="flex flex-col gap-2">
                    {ordered.map((check) => (
                      <CheckRow
                        key={check.check}
                        check={check}
                        expanded={expanded.has(check.check)}
                        onToggle={() => toggle(check.check)}
                        onReveal={reveal}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Domain rail
 * ------------------------------------------------------------------ */

function DomainRail({
  domains,
  loading,
  selectedId,
  onSelect,
}: {
  domains: readonly MailDomain[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<StatusFilter>("");

  const visible = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    return domains
      .filter((domain) => {
        if (needle && !domain.domain_name.toLowerCase().includes(needle)) return false;
        if (filter && domain.auth_summary.worst !== filter) return false;
        return true;
      })
      .sort((a, b) => {
        const rank = CHECK_RANK[a.auth_summary.worst] - CHECK_RANK[b.auth_summary.worst];
        return rank !== 0 ? rank : a.domain_name.localeCompare(b.domain_name);
      });
  }, [domains, filter, search]);

  return (
    <aside className="flex min-h-0 flex-col">
      <SectionCard
        title="Domains"
        icon={Globe}
        padded={false}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex flex-col gap-2 border-b border-[var(--kn-border)] p-2">
          <SearchInput
            data-kn-list-search=""
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch("")}
            placeholder="Filter domains"
            aria-label="Filter mail domains"
            size="sm"
          />
          <Select
            size="sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value as StatusFilter)}
            aria-label="Worst verdict"
            options={[
              { value: "", label: "Any verdict" },
              { value: "fail", label: "Failing" },
              { value: "warn", label: "Warning" },
              { value: "unknown", label: "Unknown" },
              { value: "pass", label: "Passing" },
            ]}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <ul>
              {[0, 1, 2, 3].map((index) => (
                <li key={index} className="border-b border-[var(--kn-border-subtle)] px-3 py-2">
                  <Skeleton
                    className="h-3 w-32"
                    label={index === 0 ? "Loading mail domains" : undefined}
                  />
                  <Skeleton className="mt-1.5 h-2 w-20" />
                </li>
              ))}
            </ul>
          )}

          {!loading && visible.length === 0 && (
            <EmptyState
              icon={Globe}
              title="No matching domain"
              description="Nothing here matches that filter."
              size="sm"
            />
          )}

          <ul>
            {visible.map((domain) => {
              const summary = domain.auth_summary;
              const selected = domain.id === selectedId;
              return (
                <li
                  key={domain.id}
                  className="border-b border-[var(--kn-border-subtle)] last:border-b-0"
                >
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelect(domain.id)}
                    className={cn(
                      "flex w-full flex-col gap-1 px-3 py-2 text-left outline-none",
                      "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
                      "hover:bg-[var(--kn-surface-2)]",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
                      selected && "bg-[var(--kn-accent-soft)]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <MonoText truncate className="min-w-0 flex-1 text-[var(--kn-text)]">
                        {domain.domain_name}
                      </MonoText>
                      <CheckStatusBadge status={summary.worst} />
                    </span>
                    <span className="flex items-center gap-2 text-xs text-[var(--kn-text-3)]">
                      <span className={cn("kn-num", summary.fail > 0 && checkTextClass("fail"))}>
                        {summary.fail} fail
                      </span>
                      <span className={cn("kn-num", summary.warn > 0 && checkTextClass("warn"))}>
                        {summary.warn} warn
                      </span>
                      <span className="kn-num">{summary.pass} pass</span>
                      <span className="ml-auto">
                        {summary.checked_at ? (
                          <RelativeTime value={summary.checked_at} />
                        ) : (
                          "never checked"
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </SectionCard>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

function ReportSummary({ report }: { report: MailAuthReport }) {
  const counts = React.useMemo(() => {
    const tally: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, unknown: 0 };
    for (const check of report.checks) tally[check.status] += 1;
    return tally;
  }, [report.checks]);

  const meta = CHECK_META[report.overall];

  return (
    <SectionCard padded>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--kn-r-md)]",
              report.overall === "fail" && "bg-[var(--kn-danger-soft)] text-[var(--kn-danger)]",
              report.overall === "warn" && "bg-[var(--kn-warn-soft)] text-[var(--kn-warn)]",
              report.overall === "pass" && "bg-[var(--kn-ok-soft)] text-[var(--kn-ok)]",
              report.overall === "unknown" && "bg-[var(--kn-neutral-soft)] text-[var(--kn-text-2)]",
            )}
          >
            <meta.icon size={16} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-[var(--kn-text)]">
              {report.overall === "pass"
                ? "Everything checks out"
                : report.overall === "fail"
                  ? "Mail is being lost or is spoofable"
                  : report.overall === "warn"
                    ? "Delivering, with something that will bite later"
                    : "Not enough answers to judge"}
            </p>
            <p className="text-[var(--kn-text-2)]">{meta.description}</p>
          </div>
        </div>

        <dl className="flex items-center gap-4">
          <Tally label="Fail" value={counts.fail} status="fail" />
          <Tally label="Warn" value={counts.warn} status="warn" />
          <Tally label="Unknown" value={counts.unknown} status="unknown" />
          <Tally label="Pass" value={counts.pass} status="pass" />
        </dl>

        <div className="ml-auto flex flex-col items-end gap-0.5 text-xs text-[var(--kn-text-3)]">
          <span>
            checked <RelativeTime value={report.checked_at} />
          </span>
          <span
            title="Kaname asked this resolver. Your own machine may cache a different answer for a while, or see a split-horizon zone."
            className="flex items-center gap-1"
          >
            via <MonoText muted>{report.resolver_used}</MonoText>
          </span>
        </div>
      </div>
    </SectionCard>
  );
}

function Tally({ label, value, status }: { label: string; value: number; status: CheckStatus }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-[var(--kn-text-3)]">{label}</dt>
      <dd
        className={cn(
          "kn-num text-lg font-medium",
          value > 0 ? checkTextClass(status) : "text-[var(--kn-text-3)]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      <Skeleton
        className="h-16 rounded-[var(--kn-r-md)]"
        label="Running the authentication checks"
      />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
        <Skeleton key={index} className="h-12 rounded-[var(--kn-r-md)]" />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One check
 * ------------------------------------------------------------------ */

interface CheckRowProps {
  check: MailAuthCheckResult;
  expanded: boolean;
  onToggle: () => void;
  onReveal: (check: string) => void;
}

function CheckRow({ check, expanded, onToggle, onReveal }: CheckRowProps) {
  const meta = MAIL_AUTH_CHECK_META[check.check];
  const remediation = check.remediation;
  const actions = remediation?.actions ?? [];
  const copyActions = actions.filter(
    (action): action is RemediationAction & { copy: string } =>
      typeof action.copy === "string" && action.copy.length > 0,
  );
  const linkActions = actions.filter((action) => !action.copy && action.href);
  /* The expected record is often the same string a "Copy record" action
   * carries; showing it twice would read as two different records. */
  const expectedIsDuplicated = copyActions.some((action) => action.copy === check.expected);

  return (
    <li
      id={`check-${check.check}`}
      className={cn(
        "overflow-hidden rounded-[var(--kn-r-md)] border bg-[var(--kn-surface)]",
        check.status === "fail" ? "border-[var(--kn-danger)]" : "border-[var(--kn-border)]",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`check-body-${check.check}`}
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2 text-left outline-none",
          "transition-colors duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
          "hover:bg-[var(--kn-surface-2)]",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--kn-ring)]",
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={cn(
            "shrink-0 text-[var(--kn-text-3)] transition-transform duration-[var(--kn-dur-fast)] ease-[var(--kn-ease)]",
            expanded && "rotate-90",
          )}
        />
        <CheckStatusBadge status={check.status} />
        <span className="w-40 shrink-0 font-medium text-[var(--kn-text)]">{check.title}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--kn-text-2)]">{check.detail}</span>
        <MonoText muted className="hidden shrink-0 text-xs md:inline">
          {check.check}
        </MonoText>
      </button>

      {expanded && (
        <div
          id={`check-body-${check.check}`}
          className="flex flex-col gap-3 border-t border-[var(--kn-border)] px-3 py-3"
        >
          <Section title="Why this check exists">
            <p className="text-[var(--kn-text-2)]">{meta.why}</p>
          </Section>

          <Section title="What Kaname found">
            <p className="text-[var(--kn-text)]">{check.detail}</p>
          </Section>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Section title="Expected">
              {check.expected ? (
                expectedIsDuplicated ? (
                  <MonoText className="block break-all text-[var(--kn-text-2)]">
                    {check.expected}
                  </MonoText>
                ) : (
                  <CopyableCode value={check.expected} label="Record to publish" />
                )
              ) : (
                <p className="text-[var(--kn-text-3)]">
                  Nothing specific — this check has no single record to compare against.
                </p>
              )}
            </Section>

            <Section title="Found in DNS">
              {check.actual ? (
                <MonoText className="block break-all text-[var(--kn-text)]">
                  {check.actual}
                </MonoText>
              ) : (
                <p className="text-[var(--kn-text-3)]">
                  Nothing. The name answered with no record.
                </p>
              )}
            </Section>
          </div>

          {check.check === "proxy_exposure" && <ProxyExplainer onReveal={onReveal} />}

          {remediation && (
            <Section title="How to fix it">
              <p className="text-[var(--kn-text)]">{remediation.summary}</p>
              {copyActions.map((action) => (
                <CopyableCode
                  key={`${action.label}:${action.copy}`}
                  value={action.copy}
                  label={action.label}
                  className="mt-2"
                />
              ))}
              {linkActions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {linkActions.map((action) => (
                    <Link
                      key={action.label}
                      href={action.href ?? "#"}
                      className="inline-flex h-7 items-center rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] px-2.5 text-sm font-medium text-[var(--kn-text)] outline-none transition-colors duration-[var(--kn-dur-fast)] hover:bg-[var(--kn-surface-3)]"
                    >
                      {action.label}
                    </Link>
                  ))}
                </div>
              )}
            </Section>
          )}

          <div className="flex items-center gap-3 text-xs text-[var(--kn-text-3)]">
            <span>
              checked <RelativeTime value={check.checked_at} />
            </span>
            <span aria-hidden>·</span>
            <span>
              took <Duration ms={check.duration_ms} units={1} />
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--kn-text-3)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Always rendered, pass or fail. The two facts below are the ones that
 * cost people weeks: a proxied mail hostname cannot receive SMTP at all,
 * and the apex's SPF does not cover the mail host — and neither is
 * visible from the DNS panel where the mistake was made.
 */
function ProxyExplainer({ onReveal }: { onReveal: (check: string) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] p-3">
      <h3 className="flex items-center gap-1.5 font-medium text-[var(--kn-text)]">
        <ShieldCheck size={14} aria-hidden className="text-[var(--kn-accent-400)]" />
        The two rules for a mail host behind a CDN
      </h3>

      <div>
        <p className="font-medium text-[var(--kn-text)]">1. The mail hostname must be DNS-only.</p>
        <p className="text-[var(--kn-text-2)]">
          A proxy — Cloudflare&rsquo;s orange cloud and its equivalents — forwards HTTP and HTTPS
          and nothing else. A sending server that opens port 25 to a proxied address reaches nothing
          at all, so inbound mail for the domain fails and receivers doing a callback refuse your
          outbound. Turn the proxy off for the mail hostname so the record resolves straight to the
          server. The apex can stay proxied for the website; only the mail name has to be grey.
        </p>
      </div>

      <div>
        <p className="font-medium text-[var(--kn-text)]">
          2. The mail hostname needs its own SPF record, separate from the apex.
        </p>
        <p className="text-[var(--kn-text-2)]">
          Bounces and delivery-status notifications are sent from the mail hostname itself, and
          receivers check that hostname&rsquo;s SPF rather than the domain&rsquo;s. On top of that,
          an apex SPF written as <MonoText muted>v=spf1 a mx …</MonoText> authorises whatever the
          apex resolves to — which, while it is proxied, is tens of thousands of CDN machines and
          not your server. So the mail host carries a TXT record of its own, typically{" "}
          <MonoText muted>v=spf1 a -all</MonoText>.
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={() => onReveal("host_spf")}
          className="rounded-[var(--kn-r-xs)] text-xs text-[var(--kn-accent-400)] outline-none hover:underline"
        >
          Jump to the mail host SPF check
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Re-check progress
 * ------------------------------------------------------------------ */

const MAX_LOG_LINES = 8;

/**
 * The checks run as a job so this page can show progress and keep the
 * log: when a verdict disagrees with the operator's own resolver, the
 * line that says which name was queried is the whole answer.
 */
function RecheckProgress({ job }: { job: Job }) {
  const query = useJob(job.id);
  const current = query.data ?? job;
  const logs = useJobLogs(job.id);
  const lines = logs.data ?? [];
  const tail = lines.slice(-MAX_LOG_LINES);

  return (
    <SectionCard
      title="Re-checking"
      icon={RefreshCw}
      padded={false}
      actions={
        <JobStatusPill status={current.status} size="xs" blockedReason={current.blocked_reason} />
      }
    >
      <div className="flex flex-col gap-2 p-3">
        <JobProgress
          value={current.progress}
          status={current.status}
          label="Authentication check progress"
        />

        {tail.length === 0 ? (
          <p className="text-sm text-[var(--kn-text-3)]">
            Waiting for the first result. Each check is one DNS query or one read from the host.
          </p>
        ) : (
          <ol className="kn-mono flex flex-col text-sm leading-5">
            {tail.map((line) => (
              <li key={`${line.seq}-${line.ts}`} className="flex gap-2">
                <span className="shrink-0 text-[var(--kn-text-3)]">{line.ts.slice(11, 19)}</span>
                <span
                  className={cn(
                    "min-w-0 break-words",
                    line.level === "error"
                      ? "text-[var(--kn-danger)]"
                      : line.level === "warn"
                        ? "text-[var(--kn-warn)]"
                        : "text-[var(--kn-text-2)]",
                  )}
                >
                  {line.message}
                </span>
              </li>
            ))}
          </ol>
        )}

        {current.error && (
          <p className="text-sm text-[var(--kn-danger)]">
            <MonoText>{current.error.code}</MonoText> — {current.error.message}
          </p>
        )}

        {current.status === "succeeded" && (
          <p className="flex items-center gap-1.5 text-sm text-[var(--kn-text-2)]">
            <CircleHelp size={12} aria-hidden className="text-[var(--kn-text-3)]" />
            Verdicts below are from this run.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
