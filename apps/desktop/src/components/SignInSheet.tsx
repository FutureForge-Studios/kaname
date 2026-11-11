import { useState, type FormEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Sheet } from "./Sheet";
import { ErrorNotice } from "./ErrorNotice";
import {
  authLogin,
  authTotp,
  fieldError,
  toDesktopError,
  type Connection,
  type DesktopError,
  type LoginResult,
} from "../lib/ipc";
import { displayHost } from "../lib/url";

interface SignInSheetProps {
  connection: Connection;
  /** Why the sheet opened, e.g. "Your session expired." */
  reason?: string | null;
  onClose(): void;
  onSignedIn(session: unknown): void;
}

export function SignInSheet({ connection, reason, onClose, onSignedIn }: SignInSheetProps) {
  const [email, setEmail] = useState(connection.email ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DesktopError | null>(null);

  function handle(result: LoginResult) {
    if (result.status === "ok") onSignedIn(result.session);
    else {
      setChallenge(result.challenge);
      setCode("");
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) handle(await authTotp(connection.id, challenge, code.replace(/\s+/g, "")));
      else handle(await authLogin(connection.id, email.trim(), password, remember));
    } catch (err) {
      setError(toDesktopError(err));
      setBusy(false);
    }
  }

  return (
    <Sheet
      eyebrow={displayHost(connection.base_url)}
      title={challenge ? "Two-factor code" : `Sign in to ${connection.name}`}
      onClose={onClose}
      width={400}
      footer={
        <>
          {challenge && (
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                setChallenge(null);
                setError(null);
              }}
            >
              Back
            </button>
          )}
          <span className="spacer" />
          <button
            className="btn btn-primary"
            type="submit"
            form="signin-form"
            disabled={busy || (challenge ? code.trim().length < 6 : !email.trim() || !password)}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {challenge ? "Verify" : "Sign in"}
          </button>
        </>
      }
    >
      <form id="signin-form" className="form" onSubmit={submit}>
        {reason && !challenge && <p className="sheet-note">{reason}</p>}
        {challenge ? (
          <>
            <p className="sheet-note">
              <ShieldCheck size={14} /> Enter the 6-digit code from your authenticator app, or a recovery code.
            </p>
            <label className="field">
              <span className="field-label">Code</span>
              <input
                key="totp"
                className="mono otp"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                autoFocus
                aria-invalid={fieldError(error, "code") ? true : undefined}
              />
              {fieldError(error, "code") && <span className="field-error">{fieldError(error, "code")}</span>}
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus={!email}
                aria-invalid={fieldError(error, "email") ? true : undefined}
              />
              {fieldError(error, "email") && <span className="field-error">{fieldError(error, "email")}</span>}
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus={!!email}
                aria-invalid={fieldError(error, "password") ? true : undefined}
              />
              {fieldError(error, "password") && (
                <span className="field-error">{fieldError(error, "password")}</span>
              )}
            </label>
            <label className="check-row">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Keep me signed in on this computer
            </label>
            {!remember && (
              <span className="field-hint">You will be signed out when Kaname Desktop quits.</span>
            )}
          </>
        )}
        {error && <ErrorNotice error={error} compact baseUrl={connection.base_url} hideFields />}
      </form>
    </Sheet>
  );
}
