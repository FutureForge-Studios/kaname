"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import type { User } from "@kaname/contract";
import { Button, Card, Eyebrow, FormField, InlineError, Input, StatusLine } from "@kaname/ui";
import { ApiError, api, isApiError } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { Hero, HeroSplit, StandaloneFrame } from "@/app/setup/_components/frame";

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
    <StandaloneFrame caption="Invitation">
      <HeroSplit
        center
        hero={
          <Hero
            as="p"
            eyebrow="Kaname"
            title="You have been invited"
            accent="to this panel."
            lede="Choose a password and you are in. The link works once, and what you can see and change was decided by whoever invited you."
          >
            <StatusLine tone="neutral" className="mt-6">
              Accepting an invitation is written to the audit trail.
            </StatusLine>
          </Hero>
        }
      >
        <Card radius="xl" padding="lg" className="mx-auto w-full max-w-md">
          <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <div className="flex flex-col items-start gap-3">
              <Eyebrow>Account</Eyebrow>
              <h1 className="kn-display m-0 text-[var(--kn-text)]">Choose your password</h1>
              <p className="m-0 text-[var(--kn-text-2)]">
                Nobody else has seen it — not even whoever invited you. Four unrelated words beat
                anything with a number on the end.
              </p>
            </div>

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
              <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-danger)] bg-[var(--kn-danger-soft)] px-4 py-3">
                <InlineError message={general.message} icon={false} className="text-base" />
                {general.remediation?.summary && (
                  <p className="m-0 mt-1 text-sm text-[var(--kn-text-2)]">
                    {general.remediation.summary}
                  </p>
                )}
              </div>
            )}

            <Button type="submit" variant="primary" size="lg" arrow={!pending} loading={pending} fullWidth>
              Set password and sign in
            </Button>
          </form>
        </Card>
      </HeroSplit>
    </StandaloneFrame>
  );
}
