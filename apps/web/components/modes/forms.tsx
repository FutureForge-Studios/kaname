"use client";

import * as React from "react";
import { Undo2 } from "lucide-react";
import {
  RESOURCE_KINDS,
  RESOURCE_KIND_LABELS,
  type OwnedResource,
  type ResellerBranding,
  type ResourceKind,
} from "@kaname/contract";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  EmptyState,
  FormField,
  Input,
  MonoLabel,
  MonoText,
  SegmentedControl,
  Select,
  Tag,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import type { ApiError } from "@/lib/api";
import { BrandMark } from "../Sidebar";

/* ------------------------------------------------------------------ *
 * Forms shared by the reseller's own pages and the operator's
 * reseller pages: branding, handing a resource over, and the table of
 * what an account owns.
 * ------------------------------------------------------------------ */

export interface BrandingDraft {
  display_name: string;
  logo_text: string;
  support_email: string;
  support_url: string;
}

export function brandingDraft(branding: ResellerBranding | null | undefined, fallbackName = ""): BrandingDraft {
  return {
    display_name: branding?.display_name ?? fallbackName,
    logo_text: branding?.logo_text ?? "",
    support_email: branding?.support_email ?? "",
    support_url: branding?.support_url ?? "",
  };
}

export function brandingPayload(draft: BrandingDraft) {
  return {
    display_name: draft.display_name.trim(),
    logo_text: draft.logo_text.trim() || null,
    support_email: draft.support_email.trim(),
    support_url: draft.support_url.trim(),
  };
}

/** Branding fields with a live preview of the sidebar mark. */
export function BrandingForm({
  draft,
  onChange,
  error,
  disabled,
}: {
  draft: BrandingDraft;
  onChange: (draft: BrandingDraft) => void;
  error?: ApiError | null;
  disabled?: boolean;
}) {
  const set = (key: keyof BrandingDraft) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [key]: event.target.value });
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Display name" required error={error?.fields.display_name} description="Shown at the top of your clients' sidebar.">
          <Input value={draft.display_name} maxLength={64} onChange={set("display_name")} disabled={disabled} />
        </FormField>
        <FormField label="Logo text" hint="up to 4" error={error?.fields.logo_text} description="Initials drawn in the mark. Empty uses the name's initials.">
          <Input mono value={draft.logo_text} maxLength={4} onChange={set("logo_text")} disabled={disabled} />
        </FormField>
        <FormField label="Support email" error={error?.fields.support_email}>
          <Input mono type="email" value={draft.support_email} onChange={set("support_email")} disabled={disabled} />
        </FormField>
        <FormField label="Support URL" error={error?.fields.support_url}>
          <Input mono type="url" placeholder="https://" value={draft.support_url} onChange={set("support_url")} disabled={disabled} />
        </FormField>
      </div>
      <div className="flex flex-col gap-2">
        <MonoLabel tone="muted">Your clients see</MonoLabel>
        <Card flat padding="md" className="flex flex-col gap-3">
          <BrandMark
            branding={{
              display_name: draft.display_name.trim() || "Your company",
              logo_text: draft.logo_text.trim() || null,
              support_email: null,
              support_url: null,
            }}
          />
          {(draft.support_email || draft.support_url) && (
            <MonoText muted truncate className="text-sm">
              Support · {draft.support_email || draft.support_url}
            </MonoText>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ----------------------------- ownership ----------------------------- */

const KIND_OPTIONS = RESOURCE_KINDS.map((kind) => ({
  value: kind,
  label: RESOURCE_KIND_LABELS[kind].many,
}));

/** What an account owns, with an optional take-back action per row. */
export function OwnedResourcesTable({
  rows,
  loading,
  error,
  onRetry,
  showOwner = false,
  releaseLabel,
  onRelease,
  empty,
}: {
  rows: readonly OwnedResource[];
  loading?: boolean;
  error?: ApiError | null;
  onRetry?: () => void;
  showOwner?: boolean;
  releaseLabel?: string;
  onRelease?: (row: OwnedResource) => void;
  empty: { title: string; description: string; action?: React.ReactNode };
}) {
  const columns = React.useMemo<DataTableColumn<OwnedResource>[]>(() => {
    const out: DataTableColumn<OwnedResource>[] = [
      {
        id: "kind",
        header: "Kind",
        width: 120,
        cell: (row) => <Tag size="xs">{RESOURCE_KIND_LABELS[row.kind].one}</Tag>,
      },
      { id: "label", header: "Name", minWidth: 220, mono: true, accessor: (row) => row.label },
      {
        id: "server",
        header: "Server",
        width: 160,
        mono: true,
        hideBelow: "md",
        accessor: (row) => row.server_name ?? "—",
      },
    ];
    if (showOwner) {
      out.push({ id: "owner", header: "Held by", width: 180, accessor: (row) => row.owner_name ?? "—" });
    }
    return out;
  }, [showOwner]);

  if (error) return <PageError error={error} onRetry={onRetry} context="Resources" />;

  return (
    <DataTable
      label="Resources"
      density="compact"
      columns={columns}
      rows={rows}
      loading={loading}
      getRowId={(row) => `${row.kind}:${row.id}`}
      columnVisibility={false}
      rowActions={
        onRelease
          ? (row) => [{ id: "release", label: releaseLabel ?? "Take back", icon: Undo2, onSelect: onRelease }]
          : undefined
      }
      empty={<EmptyState size="sm" title={empty.title} description={empty.description} action={empty.action} />}
    />
  );
}

/**
 * Picks one resource from `candidates(kind)` and hands it over. The
 * candidates are whatever the caller may give: the reseller's pool, or
 * the operator's unowned resources.
 */
export function AssignResourceDialog({
  open,
  onOpenChange,
  title,
  description,
  useCandidates,
  onAssign,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  useCandidates: (kind: ResourceKind) => { rows: OwnedResource[]; loading: boolean; error: ApiError | null };
  onAssign: (input: { kind: ResourceKind; resource_id: string }) => void;
  pending: boolean;
  error: ApiError | null;
}) {
  const [kind, setKind] = React.useState<ResourceKind>("site");
  const [resourceId, setResourceId] = React.useState("");
  const candidates = useCandidates(kind);

  React.useEffect(() => {
    if (open) setResourceId("");
  }, [open, kind]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" dismissible={!pending}>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (resourceId) onAssign({ kind, resource_id: resourceId });
        }}
      >
        <DialogHeader title={title} description={description} />
        <DialogBody>
          {error && error.fieldEntries.length === 0 && <PageError error={error} className="mb-4" />}
          <div className="flex flex-col gap-4">
            <SegmentedControl label="Kind" options={KIND_OPTIONS} value={kind} onValueChange={setKind} />
            <FormField
              label={RESOURCE_KIND_LABELS[kind].one}
              required
              error={error?.fields.resource_id}
              description={
                candidates.loading
                  ? "Loading…"
                  : candidates.rows.length === 0
                    ? `Nothing to hand over: no ${RESOURCE_KIND_LABELS[kind].many.toLowerCase()} are available.`
                    : undefined
              }
            >
              <Select
                mono
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
                placeholder={`Choose a ${RESOURCE_KIND_LABELS[kind].one.toLowerCase()}`}
                options={candidates.rows.map((row) => ({
                  value: row.id,
                  label: row.server_name ? `${row.label} — ${row.server_name}` : row.label,
                }))}
                disabled={candidates.loading || candidates.rows.length === 0}
              />
            </FormField>
            {candidates.error && <PageError error={candidates.error} />}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!resourceId}>
            Assign
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
