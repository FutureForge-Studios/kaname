"use client";

import * as React from "react";
import { KeyRound, Laptop, LogOut, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
import type { Session, TotpSetupResponse, User } from "@kaname/contract";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyableCode,
  DataTable,
  DetailLayout,
  EmptyState,
  FormField,
  Input,
  MonoText,
  PageHeader,
  PropertyList,
  PropertyRow,
  RelativeTime,
  SectionCard,
  StatusBadge,
  Tag,
  cn,
  type DataTableColumn,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { api, type ApiError } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { encodeQr } from "@/lib/qr";
import { useList, useResourceMutation, useSession } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Your account.
 *
 * Everything here is self-scoped: no permission gates reading your own
 * sessions, because a permission that could be revoked to hide a stolen
 * session from its owner would be worse than none.
 *
 * The two credential flows follow the same rule as an API token — the
 * recovery codes and the TOTP secret exist on screen once, at enrolment,
 * and the page says so rather than implying they can be looked up again.
 * ------------------------------------------------------------------ */

const SESSION_PAGE_SIZE = 20;

export default function AccountPage() {
  const { session, isLoading, error, refresh } = useSession();
  const user = session?.user ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Account" subtitle={user?.email} />

      <div className="flex min-w-0 flex-col gap-4 px-6 py-4">
        {error && <PageError error={error} onRetry={refresh} context="Session" />}

        {session?.totp_required && (
          <div className="flex items-start gap-2 rounded-[var(--kn-r-md)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] p-3">
            <TriangleAlert
              size={14}
              className="mt-0.5 shrink-0 text-[var(--kn-warn)]"
              aria-hidden
            />
            <p className="text-[var(--kn-text)]">
              <span className="font-medium">This install requires two-factor authentication.</span>{" "}
              Enrol an authenticator below — until you do, this account is running on a policy
              exception.
            </p>
          </div>
        )}

        <DetailLayout rail={<ProfileCard user={user} loading={isLoading} />}>
          <PasswordCard />
          <TotpCard user={user} onChanged={refresh} />
          <SessionsCard />
        </DetailLayout>
      </div>
    </div>
  );
}

/* ------------------------------- profile ---------------------------- */

function ProfileCard({ user, loading }: { user: User | null; loading: boolean }) {
  return (
    <SectionCard title="Profile" icon={UserRound}>
      {loading && !user ? (
        <p className="text-[var(--kn-text-2)]">Loading your account…</p>
      ) : !user ? (
        <p className="text-[var(--kn-text-2)]">
          This request is authenticated with an API key, which has no profile of its own.
        </p>
      ) : (
        <PropertyList dense labelWidth="sm">
          <PropertyRow label="Name">{user.name}</PropertyRow>
          <PropertyRow label="Email" mono copyValue={user.email}>
            {user.email}
          </PropertyRow>
          <PropertyRow label="Status">
            <StatusBadge tone={user.status === "active" ? "ok" : "warn"} size="sm">
              {user.status}
            </StatusBadge>
          </PropertyRow>
          <PropertyRow label="Roles">
            <span className="flex flex-wrap gap-1">
              {user.roles.map((role) => (
                <Tag key={role.id} size="xs">
                  {role.name}
                </Tag>
              ))}
            </span>
          </PropertyRow>
          <PropertyRow label="Two-factor">
            {user.totp_enabled ? (
              <Badge tone="ok" size="xs" icon={KeyRound}>
                enabled
              </Badge>
            ) : (
              <Badge tone="warn" size="xs">
                not enrolled
              </Badge>
            )}
          </PropertyRow>
          <PropertyRow label="Last sign-in">
            <RelativeTime value={user.last_login_at} fallback="never" />
          </PropertyRow>
          <PropertyRow label="From" mono>
            {user.last_login_ip ?? "—"}
          </PropertyRow>
        </PropertyList>
      )}
      <p className="mt-3 text-sm text-[var(--kn-text-3)]">
        Name, email and roles are changed by an administrator in Administration → Users, so an
        account can never quietly rename itself in the audit trail.
      </p>
    </SectionCard>
  );
}

/* ------------------------------ password ---------------------------- */

function PasswordCard() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;

  const change = useResourceMutation<void, { status: string; session_expires_at: string }>({
    mutationFn: () =>
      api.post<{ status: string; session_expires_at: string }>("/auth/password", {
        current_password: current,
        new_password: next,
      }),
    successMessage: () => "Password changed. Every other session was signed out.",
    onDone: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
    },
    onFailed: setError,
  });

  return (
    <SectionCard
      title="Password"
      icon={KeyRound}
      description="Changing it ends every session, including this one — the panel hands this tab a fresh cookie so you stay signed in here."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (mismatch) return;
          setError(null);
          change.mutate();
        }}
      >
        {error && error.fieldEntries.length === 0 && (
          <PageError error={error} onRetry={() => change.mutate()} context="Password" />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="Current password" required error={error?.fields.current_password}>
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </FormField>
          <FormField
            label="New password"
            required
            description="At least 12 characters."
            error={error?.fields.new_password}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
          </FormField>
          <FormField
            label="Repeat it"
            required
            error={mismatch ? "The two entries do not match." : undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </FormField>
        </div>

        <div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={change.isPending}
            disabled={current.length === 0 || next.length === 0 || mismatch}
          >
            Change password
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

/* -------------------------------- TOTP ------------------------------ */

function TotpCard({ user, onChanged }: { user: User | null; onChanged: () => void }) {
  const [setup, setSetup] = React.useState<TotpSetupResponse | null>(null);
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [disabling, setDisabling] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const start = useResourceMutation<void, TotpSetupResponse>({
    mutationFn: () => api.post<TotpSetupResponse>("/auth/totp/setup"),
    onDone: (result) => {
      setError(null);
      setCode("");
      setSetup(result);
    },
    onFailed: setError,
  });

  const verify = useResourceMutation<void, User>({
    mutationFn: () => api.post<User>("/auth/totp/verify", { code }),
    successMessage: () => "Two-factor authentication is on.",
    onDone: () => {
      setSetup(null);
      setCode("");
      onChanged();
    },
    onFailed: setError,
  });

  const disable = useResourceMutation<void, User>({
    mutationFn: () => api.post<User>("/auth/totp/disable", { password }),
    successMessage: () => "Two-factor authentication is off.",
    onDone: () => {
      setDisabling(false);
      setPassword("");
      onChanged();
    },
    onFailed: setError,
  });

  const enabled = user?.totp_enabled ?? false;

  return (
    <SectionCard
      title="Two-factor authentication"
      icon={ShieldCheck}
      description="A time-based code from an authenticator app, checked on every sign-in."
      actions={
        enabled ? (
          <Badge tone="ok" size="sm" icon={ShieldCheck}>
            enabled
          </Badge>
        ) : (
          <Badge tone="warn" size="sm">
            not enrolled
          </Badge>
        )
      }
    >
      {error && error.fieldEntries.length === 0 && (
        <PageError error={error} context="Two-factor" className="mb-4" />
      )}

      {enabled && !setup && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[var(--kn-text-2)]">
            Sign-in asks for a six-digit code. Recovery codes were shown once at enrolment; if you
            no longer have them, turn two-factor off and enrol again.
          </p>
          <Button variant="danger-subtle" size="sm" onClick={() => setDisabling(true)}>
            Turn off
          </Button>
        </div>
      )}

      {!enabled && !setup && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[var(--kn-text-2)]">
            A stolen password alone is enough to reach every server in this panel. An authenticator
            app closes that.
          </p>
          <Button
            variant="primary"
            size="sm"
            icon={ShieldCheck}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            Set up
          </Button>
        </div>
      )}

      {setup && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <QrCode value={setup.otpauth_url} />

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div>
                <p className="font-medium text-[var(--kn-text)]">1. Scan this in your app</p>
                <p className="text-[var(--kn-text-2)]">
                  Or enter the secret by hand if the camera is not an option.
                </p>
              </div>
              <CopyableCode value={setup.secret} label="Secret" />

              <div>
                <p className="font-medium text-[var(--kn-text)]">2. Save the recovery codes</p>
                <p className="text-[var(--kn-text-2)]">
                  Each one signs you in once if you lose the device. They are shown here and nowhere
                  else, ever.
                </p>
              </div>
              <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {setup.recovery_codes.map((recovery) => (
                  <li
                    key={recovery}
                    className="rounded-[var(--kn-r-xs)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-2 py-1"
                  >
                    <MonoText className="select-all">{recovery}</MonoText>
                  </li>
                ))}
              </ul>
              <CopyableCode
                value={setup.recovery_codes.join("\n")}
                label="All recovery codes"
                block
              />
            </div>
          </div>

          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              verify.mutate();
            }}
          >
            <FormField
              label="3. Enter the code your app shows"
              required
              error={error?.fields.code}
              className="w-44"
            >
              <Input
                mono
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </FormField>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={verify.isPending}
              disabled={code.length !== 6}
            >
              Turn on
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSetup(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={disabling}
        onOpenChange={(open) => {
          if (!open) {
            setDisabling(false);
            setPassword("");
          }
        }}
        title="Turn off two-factor authentication?"
        description="Your password alone will be enough to sign in. If this install requires two-factor, the change is refused."
        confirmLabel="Turn it off"
        loading={disable.isPending}
        onConfirm={() => {
          setError(null);
          disable.mutate();
        }}
      >
        <FormField label="Confirm with your password" required error={error?.fields.password}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            data-autofocus=""
          />
        </FormField>
      </ConfirmDialog>
    </SectionCard>
  );
}

/*
 * A QR code is a scanner target rather than a themed surface: it has to
 * read as dark-on-light in both themes, so these two values are fixed
 * instead of tokenised. Drawn as one path so a version-7 symbol is one
 * DOM node rather than a thousand rects.
 */
const QR_LIGHT = "#ffffff";
const QR_DARK = "#0b0c0e";
const QR_QUIET_ZONE = 4;

function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const matrix = React.useMemo(() => encodeQr(value), [value]);

  if (!matrix) {
    return (
      <p className="text-[var(--kn-warn)]">
        This enrolment URI is too long to render as a QR code — enter the secret by hand instead.
      </p>
    );
  }

  const total = matrix.size + QR_QUIET_ZONE * 2;
  let path = "";
  for (let y = 0; y < matrix.size; y += 1) {
    const row = matrix.modules[y]!;
    for (let x = 0; x < matrix.size; x += 1) {
      if (row[x]) path += `M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      role="img"
      aria-label="Scan this code with an authenticator app"
      shapeRendering="crispEdges"
      className={cn("shrink-0 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)]")}
    >
      <rect width={total} height={total} fill={QR_LIGHT} />
      <path d={path} fill={QR_DARK} />
    </svg>
  );
}

/* ------------------------------ sessions ---------------------------- */

function SessionsCard() {
  const [page, setPage] = React.useState(1);
  const [revoking, setRevoking] = React.useState<Session | null>(null);
  const [revokingOthers, setRevokingOthers] = React.useState(false);

  const query = useList<Session>(
    "me-sessions",
    { page, per_page: SESSION_PAGE_SIZE, sort: "last_seen_at", order: "desc" },
    { path: "/me/sessions" },
  );

  const revoke = useResourceMutation<Session, void>({
    mutationFn: (session) => api.del(`/me/sessions/${session.id}`),
    invalidates: ["me-sessions"],
    successMessage: () => "Session revoked.",
    onDone: (_result, session) => {
      setRevoking(null);
      // Revoking the session you are using is a sign-out, so act like one.
      if (session.current) window.location.assign("/login");
    },
  });

  const revokeOthers = useResourceMutation<void, { revoked: number }>({
    mutationFn: () => api.del<{ revoked: number }>("/me/sessions"),
    invalidates: ["me-sessions"],
    successMessage: (result) =>
      `${formatCount(result.revoked)} other session${result.revoked === 1 ? "" : "s"} signed out.`,
    onDone: () => setRevokingOthers(false),
  });

  const columns = React.useMemo<DataTableColumn<Session>[]>(
    () => [
      {
        id: "device",
        header: "Device",
        locked: true,
        minWidth: 220,
        cell: (session) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[var(--kn-text)]" title={session.user_agent}>
              {describeAgent(session.user_agent)}
            </span>
            {session.current && (
              <Badge tone="accent" size="xs">
                this device
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "ip",
        header: "Address",
        width: 152,
        mono: true,
        accessor: (session) => session.ip,
      },
      {
        id: "last_seen_at",
        header: "Last seen",
        width: 120,
        align: "right",
        sortable: true,
        cell: (session) => <RelativeTime value={session.last_seen_at} />,
      },
      {
        id: "created_at",
        header: "Signed in",
        width: 120,
        align: "right",
        sortable: true,
        hideBelow: "md",
        cell: (session) => <RelativeTime value={session.created_at} />,
      },
      {
        id: "expires_at",
        header: "Expires",
        width: 120,
        align: "right",
        sortable: true,
        hideBelow: "lg",
        cell: (session) => <RelativeTime value={session.expires_at} />,
      },
    ],
    [],
  );

  return (
    <SectionCard
      title="Active sessions"
      icon={Laptop}
      padded={false}
      description="Every browser currently holding a valid cookie for this account."
      actions={
        <Button
          variant="secondary"
          size="xs"
          icon={LogOut}
          disabled={(query.data?.meta.total ?? 0) <= 1}
          onClick={() => setRevokingOthers(true)}
        >
          Sign out everywhere else
        </Button>
      }
    >
      <DataTable<Session>
        columns={columns}
        rows={query.data?.data ?? []}
        getRowId={(session) => session.id}
        label="Active sessions"
        density="compact"
        columnVisibility={false}
        page={page}
        perPage={SESSION_PAGE_SIZE}
        total={query.data?.meta.total}
        onPageChange={setPage}
        loading={query.isLoading}
        skeletonRows={3}
        rowActions={(session) => [
          {
            id: "revoke",
            label: session.current ? "Sign out this device" : "Revoke",
            icon: LogOut,
            destructive: true,
            onSelect: () => setRevoking(session),
          },
        ]}
        error={
          query.isError ? (
            <PageError
              error={query.error}
              onRetry={() => void query.refetch()}
              context="Sessions"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            icon={Laptop}
            title="No other sessions"
            description="Only this browser is signed in to this account."
            size="sm"
          />
        }
        className="rounded-none border-0"
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={revoking?.current ? "Sign out of this device?" : "Revoke this session?"}
        description={
          revoking?.current
            ? "You will be returned to the sign-in page."
            : `Whatever is signed in from ${revoking?.ip ?? "that address"} is cut off on its next request.`
        }
        confirmLabel={revoking?.current ? "Sign out" : "Revoke session"}
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />

      <ConfirmDialog
        open={revokingOthers}
        onOpenChange={setRevokingOthers}
        title="Sign out everywhere else?"
        description="Every other browser signed in as you is cut off immediately. This one stays."
        confirmLabel="Sign out other sessions"
        loading={revokeOthers.isPending}
        onConfirm={() => revokeOthers.mutate()}
      />
    </SectionCard>
  );
}

/** Enough of a user agent to recognise your own laptop in a list. */
function describeAgent(userAgent: string): string {
  if (!userAgent) return "Unknown device";

  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : /Firefox\//.test(userAgent)
            ? "Firefox"
            : "Browser";

  const platform = /Windows/.test(userAgent)
    ? "Windows"
    : /Macintosh|Mac OS/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "unknown platform";

  return `${browser} on ${platform}`;
}
