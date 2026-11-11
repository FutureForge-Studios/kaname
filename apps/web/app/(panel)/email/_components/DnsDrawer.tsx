"use client";

import * as React from "react";
import { ClipboardList, RefreshCw } from "lucide-react";
import type { MailDnsRecord, MailDomain } from "@kaname/contract";
import {
  Badge,
  Button,
  CopyButton,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  MonoText,
  RelativeTime,
  Skeleton,
  cn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { pluralize } from "@/lib/format";
import { useCan } from "@/lib/queries";
import { useCheckMailDns, useMailDnsReport } from "./queries";
import { CHECK_RANK, MailCheckBadge } from "./status";

/* ------------------------------------------------------------------ *
 * The DNS checklist for one mail domain.
 *
 * This is the surface where real mail setups break, so it is built the
 * way Yunori's own console builds it: every record the host expects,
 * the exact value to publish one click from the clipboard, and what
 * public resolvers actually return when it differs. Prose about what to
 * do is kept to one line; the remedy is the record.
 * ------------------------------------------------------------------ */

/** A reading aid: what the record is for, from the name and value. */
export function recordPurpose(record: MailDnsRecord): string | null {
  const name = record.name.toLowerCase();
  const value = (record.expected ?? "").toLowerCase();
  if (name.includes("_domainkey")) return "DKIM";
  if (name.startsWith("_dmarc.")) return "DMARC";
  if (name.startsWith("_mta-sts.") || name.startsWith("mta-sts.")) return "MTA-STS";
  if (name.startsWith("_smtp._tls.")) return "TLS-RPT";
  if (value.startsWith("v=spf1")) return "SPF";
  if (name.startsWith("autoconfig.") || name.startsWith("autodiscover.") || name.startsWith("_autodiscover.")) {
    return "Autoconfig";
  }
  if (record.type === "MX") return "MX";
  if (record.type === "PTR") return "Reverse DNS";
  return null;
}

export interface DnsDrawerProps {
  domain: MailDomain | null;
  onClose: () => void;
}

export function DnsDrawer({ domain, onClose }: DnsDrawerProps) {
  const can = useCan();
  const report = useMailDnsReport(domain?.id);
  const check = useCheckMailDns();

  const records = React.useMemo(() => {
    const rows = report.data?.records ?? [];
    // Failing required records first; passing ones are the ones nobody came to see.
    return [...rows].sort((a, b) => {
      const byStatus = CHECK_RANK[a.status] - CHECK_RANK[b.status];
      if (byStatus !== 0) return byStatus;
      return Number(b.required) - Number(a.required);
    });
  }, [report.data]);

  const missing = records.filter((record) => record.required && record.status === "fail").length;

  return (
    <Drawer open={domain !== null} onOpenChange={(open) => !open && onClose()} side="right" size="lg">
      {domain && (
        <>
          <DrawerHeader
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span>DNS records for</span>
                <MonoText truncate className="min-w-0">
                  {domain.domain_name}
                </MonoText>
              </span>
            }
            description={
              report.data
                ? missing > 0
                  ? `${pluralize(missing, "required record is", "required records are")} still missing. DNS changes can take a while to spread.`
                  : "Every required record resolves."
                : "Reading what the host expects and what public resolvers return."
            }
            actions={
              <>
                {report.data && <MailCheckBadge status={report.data.overall} size="sm" />}
                <Button
                  variant="secondary"
                  size="xs"
                  icon={RefreshCw}
                  loading={check.isPending}
                  disabled={!can("email.servers:exec", domain.server_id)}
                  onClick={() => check.mutate({ id: domain.id, domain_name: domain.domain_name })}
                >
                  Check now
                </Button>
              </>
            }
          />

          <DrawerBody>
            {report.isError ? (
              <PageError error={report.error} onRetry={() => void report.refetch()} context="DNS records" />
            ) : report.isLoading ? (
              <div className="flex flex-col gap-2" aria-busy>
                <Skeleton className="h-16 rounded-[var(--kn-r-sm)]" label="Loading DNS records" />
                <Skeleton className="h-16 rounded-[var(--kn-r-sm)]" />
                <Skeleton className="h-16 rounded-[var(--kn-r-sm)]" />
              </div>
            ) : records.length === 0 ? (
              <p className="text-sm text-[var(--kn-text-3)]">
                The host has not reported any records for this domain yet. Run a check.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-[var(--kn-border)] p-0" aria-label="DNS records">
                {records.map((record) => (
                  <DnsRecordRow key={record.id} record={record} />
                ))}
              </ul>
            )}
          </DrawerBody>

          {report.data && (
            <DrawerFooter>
              <span className="mr-auto text-xs text-[var(--kn-text-3)]">
                {report.data.checked_at ? (
                  <>
                    checked <RelativeTime value={report.data.checked_at} />
                  </>
                ) : (
                  "not checked yet"
                )}
              </span>
              <span className="inline-flex items-center gap-1 text-sm text-[var(--kn-text-2)]">
                <ClipboardList size={14} aria-hidden />
                Zone file
                <CopyButton
                  value={report.data.zone_file}
                  label="Copy zone file"
                  size="sm"
                  disabled={report.data.zone_file.length === 0}
                />
              </span>
            </DrawerFooter>
          )}
        </>
      )}
    </Drawer>
  );
}

function DnsRecordRow({ record }: { record: MailDnsRecord }) {
  const purpose = recordPurpose(record);
  const differs =
    record.expected !== null &&
    record.status !== "pass" &&
    record.actual.length > 0 &&
    !record.actual.includes(record.expected);

  return (
    <li
      id={`dns-${record.id}`}
      data-record-type={record.type}
      data-record-status={record.status}
      className="flex flex-col gap-2 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MailCheckBadge status={record.status} />
        <Badge mono size="xs" tone="neutral">
          {record.type}
        </Badge>
        {purpose && purpose !== record.type && (
          <Badge size="xs" tone="neutral" title="What this record is for">
            {purpose}
          </Badge>
        )}
        {!record.required && <span className="kn-label-sm text-[var(--kn-text-3)]">optional</span>}
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]" title={record.name}>
            {record.name}
          </MonoText>
          <CopyButton value={record.name} label={`Copy name ${record.name}`} size="xs" />
        </span>
      </div>

      {record.expected !== null ? (
        <div className="flex items-start gap-2 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] py-1.5 pl-3 pr-1.5">
          <span className="kn-label-sm shrink-0 pt-0.5 text-[var(--kn-text-3)]">Value</span>
          <code
            data-record-expected=""
            className="kn-mono min-w-0 flex-1 select-all break-all pt-px text-[var(--kn-text)]"
          >
            {record.expected}
          </code>
          <CopyButton value={record.expected} label={`Copy record value`} size="xs" />
        </div>
      ) : (
        <p className="text-xs text-[var(--kn-text-3)]">
          Resolves as expected; the host did not restate the value.
        </p>
      )}

      {differs && (
        <div className="flex flex-col gap-0.5 rounded-[var(--kn-r-md)] border border-[color-mix(in_srgb,var(--kn-danger)_35%,transparent)] bg-[var(--kn-danger-soft)] px-3 py-1.5 text-xs">
          <span className="text-[var(--kn-text-3)]">found:</span>
          {record.actual.map((value, index) => (
            <code
              key={`${index}-${value}`}
              className={cn("kn-mono break-all text-[var(--kn-text-2)]")}
            >
              {value}
            </code>
          ))}
        </div>
      )}
      {record.status === "fail" && record.actual.length === 0 && (
        <p className="kn-mono m-0 text-2xs text-[var(--kn-danger)]">found: nothing — public resolvers return no record.</p>
      )}
    </li>
  );
}
