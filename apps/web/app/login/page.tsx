"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import type { LoginResponse, User } from "@kaname/contract";
import { Button, FormField, Input, InlineError, Checkbox, Skeleton, cn } from "@kaname/ui";
import { ApiError, api, isApiError } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { Wordmark } from "@/components/Logo";

/* ------------------------------------------------------------------ *
 * Sign in.
 *
 * Calm and centred, and specific about failures: the control plane
 * distinguishes a wrong password from a locked account from an expired
 * two-factor challenge, and each one carries its own remediation. The
 * screen renders what it is told rather than flattening everything into
 * "invalid credentials".
 *
 * The second leg is a separate step rather than a field that appears,
 * because the challenge is bound to the address that started it and an
 * operator needs to know they are past the password.
 * ------------------------------------------------------------------ */

type Stage = { kind: "password" } | { kind: "totp"; challenge: string };

/** A recovery code is not six digits, so the field accepts both. */
const CODE_PATTERN = "[0-9A-Za-z-]{6,32}";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const { refresh } = useSession();

  const [stage, setStage] = React.useState<Stage>({ kind: "password" });
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [remember, setRemember] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  const fieldError = (name: string): string | undefined => error?.fields[name];

  /*
   * The session probe that ran when this screen mounted answered "not
   * signed in", and that answer is cached for the whole app. Navigating
   * without replacing it hands the shell a stale 401 and it bounces
   * straight back here, so the new session is read before we move.
   */
  const enter = async (): Promise<void> => {
    await refresh();
    router.replace(next);
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await api.post<LoginResponse>(
        "/auth/login",
        { email, password, remember },
        { allowUnauthenticated: true },
      );
      if (result.status === "totp_required") {
        setStage({ kind: "totp", challenge: result.challenge });
        setPassword("");
        return;
      }
      await enter();
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

  const submitTotp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (stage.kind !== "totp") return;
    setPending(true);
    setError(null);
    try {
      await api.post<{ status: "ok"; user: User }>(
        "/auth/totp",
        { challenge: stage.challenge, code: code.trim() },
        { allowUnauthenticated: true },
      );
      await enter();
    } catch (err) {
      const apiError = isApiError(err)
        ? err
        : new ApiError({ code: "internal_error", message: String(err), status: 0 });
      setError(apiError);
      setCode("");
      // An expired or forged challenge cannot be retried; start over.
      if (apiError.code === "unauthenticated" && apiError.message.includes("expired")) {
        setStage({ kind: "password" });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <LoginFrame>
      <div className="rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-5">
        {stage.kind === "password" ? (
          <form onSubmit={submitPassword} noValidate className="flex flex-col gap-4">
            <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">Sign in</h1>

            <FormField label="Email" error={fieldError("email")} required>
              <Input
                type="email"
                name="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoFocus
                required
                size="md"
                mono
                placeholder="you@example.com"
              />
            </FormField>

            <FormField label="Password" error={fieldError("password")} required>
              <Input
                type="password"
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
                size="md"
              />
            </FormField>

            <Checkbox
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              label="Keep me signed in on this browser"
            />

            <AuthError error={error} exclude={["email", "password"]} />

            <Button type="submit" variant="primary" size="md" loading={pending} fullWidth>
              Sign in
            </Button>
          </form>
        ) : (
          <form onSubmit={submitTotp} noValidate className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]">
                <ShieldCheck size={14} aria-hidden />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">
                  Two-factor code
                </h1>
                <p className="mt-0.5 text-[var(--kn-text-2)]">
                  Enter the six-digit code from your authenticator, or one of the recovery codes
                  you saved.
                </p>
              </div>
            </div>

            <FormField label="Code" error={fieldError("code")} required>
              <Input
                name="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="text"
                autoComplete="one-time-code"
                pattern={CODE_PATTERN}
                autoFocus
                required
                size="md"
                mono
                placeholder="000000"
                className={cn("tracking-[0.2em]")}
              />
            </FormField>

            <AuthError error={error} exclude={["code"]} />

            <Button type="submit" variant="primary" size="md" loading={pending} fullWidth>
              Verify
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={ArrowLeft}
              onClick={() => {
                setStage({ kind: "password" });
                setError(null);
                setCode("");
              }}
            >
              Use a different account
            </Button>
          </form>
        )}
      </div>
    </LoginFrame>
  );
}

function LoginFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--kn-bg)] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <Wordmark size={28} />
          <p className="text-[var(--kn-text-3)]">The control plane for your infrastructure.</p>
        </div>

        {children}

        <p className="mt-4 text-center text-xs text-[var(--kn-text-3)]">
          Every sign-in attempt, successful or not, is written to the audit trail.
        </p>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */

/*
 * useSearchParams() opts the subtree into client rendering, so the page
 * shell stays prerenderable only if the form sits behind a Suspense
 * boundary. The fallback matches the card's real dimensions rather than
 * flashing a spinner.
 */
export default function LoginPage() {
  return (
    <React.Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginFallback() {
  return (
    <LoginFrame>
      <div
        className="rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-5"
        aria-busy="true"
      >
        <Skeleton className="h-5 w-20" label="Loading sign-in" />
        <Skeleton className="mt-5 h-8 w-full" />
        <Skeleton className="mt-4 h-8 w-full" />
        <Skeleton className="mt-5 h-8 w-full" />
      </div>
    </LoginFrame>
  );
}

/** Only same-site paths are honoured, so `?next=` cannot be an open redirect. */
function safeNext(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function AuthError({ error, exclude }: { error: ApiError | null; exclude: string[] }) {
  if (!error) return null;

  // Field-level messages are already rendered under their inputs.
  const onlyFieldErrors =
    error.fieldEntries.length > 0 && error.fieldEntries.every(([key]) => exclude.includes(key));
  if (onlyFieldErrors) return null;

  return (
    <div className="rounded-[var(--kn-r-sm)] border border-[var(--kn-danger)] bg-[var(--kn-danger-soft)] px-3 py-2">
      <InlineError message={error.message} icon={false} className="text-base" />
      {error.remediation?.summary && (
        <p className="mt-1 text-xs text-[var(--kn-text-2)]">{error.remediation.summary}</p>
      )}
    </div>
  );
}
