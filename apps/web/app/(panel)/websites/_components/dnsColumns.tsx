"use client";

import * as React from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import type { DnsRecord } from "@kaname/contract";
import {
  Badge,
  Button,
  CopyButton,
  MonoText,
  RelativeTime,
  type DataTableColumn,
} from "@kaname/ui";
import { formatTtl } from "./dnsTypes";
import { DriftIndicator, ManagedByBadge, ProxiedBadge } from "./status";

/* ------------------------------------------------------------------ *
 * The DNS record table's columns.
 *
 * The zone manager and a domain's detail page show the same records and
 * must show them identically, so the column set is defined once and the
 * two pages differ only in the shell around it — a full ResourcePage
 * with search and paging, or an inline card.
 * ------------------------------------------------------------------ */

export interface DnsColumnOptions {
  /** Keeps Kaname's value, or adopts what the zone actually serves. */
  onReconcile: (record: DnsRecord, direction: "kaname" | "zone") => void;
  /** The record currently being written back, so its button shows it. */
  reconcilingId?: string | null;
  canWrite: (record: DnsRecord) => boolean;
  /** Adds a zone column, for a list that spans more than one domain. */
  showDomain?: boolean;
}

export function useDnsColumns({
  onReconcile,
  reconcilingId = null,
  canWrite,
  showDomain = false,
}: DnsColumnOptions): DataTableColumn<DnsRecord>[] {
  return React.useMemo<DataTableColumn<DnsRecord>[]>(() => {
    const columns: DataTableColumn<DnsRecord>[] = [
      {
        id: "type",
        header: "Type",
        sortable: true,
        width: 76,
        cell: (record) => (
          <Badge tone="neutral" size="xs" mono>
            {record.type}
          </Badge>
        ),
      },
      {
        id: "name",
        header: "Name",
        sortable: true,
        locked: true,
        minWidth: 176,
        cell: (record) => (
          <MonoText truncate className="min-w-0 text-[var(--kn-text)]">
            {record.name}
          </MonoText>
        ),
      },
      {
        id: "content",
        header: "Value",
        sortable: true,
        minWidth: 240,
        cell: (record) => (
          <span className="group/value flex min-w-0 items-center gap-1">
            <MonoText truncate className="min-w-0" title={record.content}>
              {record.content}
            </MonoText>
            <span className="shrink-0 opacity-0 transition-opacity duration-[var(--kn-dur-fast)] group-hover/value:opacity-100 group-focus-within/value:opacity-100">
              <CopyButton value={record.content} label={`Copy ${record.type} value`} size="xs" />
            </span>
          </span>
        ),
      },
      {
        id: "ttl",
        header: "TTL",
        sortable: true,
        width: 76,
        align: "right",
        mono: true,
        accessor: (record) => formatTtl(record.ttl),
      },
      {
        id: "priority",
        header: "Priority",
        width: 80,
        align: "right",
        mono: true,
        hideBelow: "lg",
        accessor: (record) => (record.priority == null ? "—" : String(record.priority)),
      },
      {
        id: "proxied",
        header: "Edge",
        width: 88,
        hideBelow: "md",
        cell: (record) => <ProxiedBadge proxied={record.proxied} />,
      },
      {
        id: "managed_by",
        header: "Managed by",
        width: 116,
        hideBelow: "md",
        cell: (record) => <ManagedByBadge managedBy={record.managed_by} />,
      },
      {
        id: "drift",
        header: "Drift",
        width: 188,
        cell: (record) =>
          record.drift ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <DriftIndicator drift={record.drift} />
              <Button
                variant="ghost"
                size="xs"
                icon={RotateCcw}
                disabled={!canWrite(record)}
                loading={reconcilingId === record.id}
                onClick={() => onReconcile(record, "kaname")}
                title={`Write "${record.drift.expected}" back to the zone.`}
              >
                Reconcile
              </Button>
            </span>
          ) : (
            <span className="text-[var(--kn-text-3)]">In sync</span>
          ),
      },
      {
        id: "last_synced_at",
        header: "Synced",
        sortable: true,
        width: 104,
        align: "right",
        hideBelow: "lg",
        cell: (record) => <RelativeTime value={record.last_synced_at} />,
      },
    ];

    if (showDomain) {
      columns.splice(1, 0, {
        id: "domain",
        header: "Zone",
        minWidth: 148,
        hideBelow: "lg",
        cell: (record) => (
          <Link
            href={`/websites/dns?domain_id=${record.domain_id}`}
            className="kn-mono min-w-0 truncate rounded-[var(--kn-r-xs)] text-[var(--kn-accent-400)] outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--kn-ring)]"
          >
            {record.domain_name}
          </Link>
        ),
      });
    }

    return columns;
  }, [canWrite, onReconcile, reconcilingId, showDomain]);
}
