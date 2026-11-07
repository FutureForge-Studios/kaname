"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import type { User } from "@kaname/contract";
import { Button, FormField, InlineError, Input } from "@kaname/ui";
import { ApiError, api, isApiError } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { Wordmark } from "@/components/Logo";

/* ------------------------------------------------------------------ *
 * Accept an invitation.
 *
 * POST /users hands the inviter a link to /invite/<token>, and until
 * this page existed that link was a 404: an invited account had no way
 * to set a password, so nobody but the bootstrap owner could ever sign
 * in. The invitee chooses the password here; the control plane checks
 * its strength, spends the token, and signs the new account in.
 * ------------------------------------------------------------------ */

export default function InvitePage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = decodeURIComponent(params?.token ?? "");
  const { refresh } = useSession();

  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  const mismatch =
    confirmation.length === 0
      ? "Type the password again."
      : confirmation !== password
        ? "The two passwords do not match."
        : null;
  const tooShort = password.length < 12 ? "Use at least 12 characters." : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (tooShort || mismatch) return;
    setPending(true);
    setError(null);
    try {
      await api.post<{ status: "ok"; user: User }>(
        "/auth/invite/accept",
        { token, password },
        { allowUnauthenticated: true },
      );
      await refresh();
      router.replace("/");
    } catch (err) {
      setError(
        isApiError(err)
          ? err
          : new ApiError({ code: "internal_error", message: String(err), status: 0 }),
      );
    } finally {
      setPending(false);
    }
  };

  const passwordError = (submitted ? tooShort : null) ?? error?.fields["password"];
  const general = error && !error.fields["password"] ? error : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--kn-bg)] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Wordmark size={28} />
          <p className="text-[var(--kn-text-3)]">You have been invited to this panel.</p>
        </div>

        <div className="rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-5">
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">
              Choose your password
            </h1>
            <p className="text-[var(--kn-text-2)]">
              Nobody else has seen it — not even whoever invited you. Four unrelated words beat
              anything with a number on the end.
            </p>

            <FormField label="Password" error={passwordError} required>
              <Input
                type="password"
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
                size="md"
              />
            </FormField>

            <FormField
              label="Confirm password"
              error={submitted ? (mismatch ?? undefined) : undefined}
              required
            >
              <Input
                type="password"
                name="password_confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                size="md"
              />
            </FormField>

            {general && (
              <div className="rounded-[var(--kn-r-sm)] border border-[var(--kn-danger)] bg-[var(--kn-danger-soft)] px-3 py-2">
                <InlineError message={general.message} icon={false} className="text-base" />
                {general.remediation?.summary && (
                  <p className="mt-1 text-xs text-[var(--kn-text-2)]">
                    {general.remediation.summary}
                  </p>
                )}
              </div>
            )}

            <Button type="submit" variant="primary" size="md" loading={pending} fullWidth>
              Set password and sign in
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
