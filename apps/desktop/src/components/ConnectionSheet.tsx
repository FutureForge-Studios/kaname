import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { Sheet } from "./Sheet";
import { ErrorNotice } from "./ErrorNotice";
import {
  connectionDelete,
  connectionSave,
  connectionTest,
  fieldError,
  toDesktopError,
  type AuthKind,
  type Connection,
  type ConnectionTestResult,
  type DesktopError,
} from "../lib/ipc";
import { normalizeBaseUrl } from "../lib/url";

function FieldError({ message }: { message: string | undefined }) {
  return message ? <span className="field-error">{message}</span> : null;
}

export const CONNECTION_COLORS = [
  "#5B76F7",
  "#4FE3CB",
  "#7CB7FF",
  "#A98DF8",
  "#FBB13C",
  "#F45B69",
  "#8E8D8B",
];

interface ConnectionSheetProps {
  existing?: Connection;
  onClose(): void;
  onSaved(connection: Connection, isNew: boolean): void;
  onDeleted(id: string): void;
}

export function ConnectionSheet({ existing, onClose, onSaved, onDeleted }: ConnectionSheetProps) {
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.base_url ?? "");
  const [authKind, setAuthKind] = useState<AuthKind>(existing?.auth_kind ?? "session");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [apiKey, setApiKey] = useState("");
  const [color, setColor] = useState(existing?.color ?? CONNECTION_COLORS[0]!);
  const [insecure, setInsecure] = useState(existing?.accept_invalid_certs ?? false);

  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<DesktopError | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const baseUrl = normalizeBaseUrl(url);
  const urlChanged = !!existing && !!baseUrl && baseUrl !== existing.base_url;
  const fe = {
    name: fieldError(error, "name"),
    url: fieldError(error, "base_url", "url"),
    email: fieldError(error, "email"),
    apiKey: fieldError(error, "api_key"),
  };
  const keyRequired = authKind === "api_key" && !(existing?.auth_kind === "api_key" && existing.has_credential);

  async function runTest() {
    if (!baseUrl) {
      setError({ code: "invalid_input", message: "Enter the panel's address, e.g. https://panel.example.com.", status: null, remediation: null });
      return;
    }
    setBusy("test");
    setError(null);
    setTest(null);
    try {
      setTest(await connectionTest(baseUrl, insecure));
    } catch (err) {
      const e = toDesktopError(err);
      if (e.code === "not_found" && !e.remediation) {
        e.remediation = {
          summary: "Something answered at this address, but it is not a Kaname panel. Check the URL.",
          actions: [],
        };
      }
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!baseUrl) {
      setError({ code: "invalid_input", message: "Enter the panel's address, e.g. https://panel.example.com.", status: null, remediation: null });
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const saved = await connectionSave({
        ...(existing ? { id: existing.id } : {}),
        name: name.trim() || new URL(baseUrl).host,
        base_url: baseUrl,
        auth_kind: authKind,
        email: authKind === "session" ? email.trim() || null : null,
        color,
        accept_invalid_certs: insecure,
        ...(authKind === "api_key" && apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      onSaved(saved, !existing);
    } catch (err) {
      setError(toDesktopError(err));
      setBusy(null);
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy("delete");
    try {
      await connectionDelete(existing.id);
      onDeleted(existing.id);
    } catch (err) {
      setError(toDesktopError(err));
      setBusy(null);
    }
  }

  return (
    <Sheet
      eyebrow={existing ? "Edit connection" : "New connection"}
      title={existing ? existing.name : "Add a Kaname panel"}
      onClose={onClose}
      footer={
        <>
          {existing &&
            (confirmDelete ? (
              <button className="btn btn-danger" onClick={remove} disabled={busy !== null}>
                <Trash2 size={14} /> Delete “{existing.name}”
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} /> Delete
              </button>
            ))}
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="connection-form"
            disabled={busy !== null || !url.trim() || (keyRequired && !apiKey.trim())}
          >
            {busy === "save" && <Loader2 size={14} className="spin" />}
            {existing ? "Save" : "Add panel"}
          </button>
        </>
      }
    >
      <form id="connection-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production panel"
            autoFocus
            aria-invalid={fe.name ? true : undefined}
          />
          <FieldError message={fe.name} />
        </label>

        <label className="field">
          <span className="field-label">Panel URL</span>
          <input
            className="mono"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setTest(null);
            }}
            placeholder="https://panel.example.com"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={fe.url ? true : undefined}
          />
          {url.trim() && baseUrl && baseUrl !== url.trim() && (
            <span className="field-hint mono">→ {baseUrl}</span>
          )}
          <FieldError message={fe.url} />
          {urlChanged && (
            <span className="field-hint tone-warn-text">
              Changing the URL signs you out of this panel and closes its terminals.
            </span>
          )}
        </label>

        <div className="field">
          <span className="field-label">Sign in with</span>
          <div className="segmented" role="radiogroup" aria-label="Authentication">
            {(
              [
                ["session", "Email & password"],
                ["api_key", "API key"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={authKind === value}
                className={authKind === value ? "on" : ""}
                onClick={() => setAuthKind(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="field-hint">
            {authKind === "session"
              ? "Full access, including terminals. You sign in after saving."
              : "Read and act through the API. Terminals need a user session."}
          </span>
        </div>

        {authKind === "session" ? (
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
              aria-invalid={fe.email ? true : undefined}
            />
            <FieldError message={fe.email} />
          </label>
        ) : (
          <label className="field">
            <span className="field-label">API key</span>
            <input
              className="mono"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={existing?.has_credential ? "•••••••• stored — leave empty to keep" : "kn_…"}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={fe.apiKey ? true : undefined}
            />
            <FieldError message={fe.apiKey} />
            <span className="field-hint">Stored in the OS keychain, never shown again.</span>
          </label>
        )}

        <div className="field">
          <span className="field-label">Colour</span>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {CONNECTION_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                className={`swatch${color === c ? " on" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <label className="toggle-row">
          <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
          <span className="toggle" aria-hidden />
          <span>
            <span className="toggle-title">Accept self-signed certificate</span>
            <span className="field-hint">Only for panels you reach by IP or a private name.</span>
          </span>
        </label>

        <div className="test-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={runTest} disabled={busy !== null || !url.trim()}>
            {busy === "test" ? <Loader2 size={13} className="spin" /> : null}
            Test connection
          </button>
          {test && (
            <span className={`test-result ${test.reachable ? "tone-ok" : "tone-danger"}`}>
              {test.reachable && <CheckCircle2 size={14} />}
              {test.reachable
                ? `Reachable${test.version ? ` · Kaname ${test.version}` : ""}${test.setup_required ? " · setup not finished" : ""}`
                : "Not reachable"}
            </span>
          )}
        </div>

        {error && <ErrorNotice error={error} compact baseUrl={baseUrl ?? undefined} hideFields />}
        {error?.code === "tls" && !insecure && (
          <div className="test-row">
            <span className="field-hint">Reaching this panel by IP or a private name with its own certificate?</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setInsecure(true);
                setError(null);
              }}
            >
              Accept self-signed certificate
            </button>
          </div>
        )}
      </form>
    </Sheet>
  );
}
