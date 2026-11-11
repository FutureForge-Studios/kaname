import { AlertTriangle, ExternalLink, RotateCw } from "lucide-react";
import { openExternal, type DesktopError } from "../lib/ipc";
import { joinPanelUrl } from "../lib/url";

interface ErrorNoticeProps {
  error: DesktopError;
  /** The connection's base_url, for panel-relative remediation links. */
  baseUrl?: string;
  onRetry?(): void;
  compact?: boolean;
  /** The form already shows `fields` inline next to its inputs. */
  hideFields?: boolean;
}

export function ErrorNotice({ error, baseUrl, onRetry, compact, hideFields }: ErrorNoticeProps) {
  const actions = error.remediation?.actions ?? [];
  return (
    <div className={`error-notice${compact ? " compact" : ""}`} role="alert">
      <AlertTriangle size={16} className="error-icon" aria-hidden />
      <div className="error-body">
        <div className="error-message">{error.message}</div>
        {error.remediation?.summary && <div className="error-summary">{error.remediation.summary}</div>}
        {error.fields && !hideFields && Object.keys(error.fields).length > 0 && (
          <ul className="error-fields">
            {Object.entries(error.fields).map(([field, message]) => (
              <li key={field}>
                <span className="mono">{field}</span> {message}
              </li>
            ))}
          </ul>
        )}
        <div className="error-meta mono">
          {error.code}
          {error.status ? ` · HTTP ${error.status}` : ""}
        </div>
        {(actions.length > 0 || onRetry) && (
          <div className="error-actions">
            {onRetry && (
              <button className="btn btn-ghost btn-sm" onClick={onRetry}>
                <RotateCw size={13} /> Retry
              </button>
            )}
            {actions.map((action) => {
              const url = action.href && baseUrl ? joinPanelUrl(baseUrl, action.href) : null;
              if (!url) {
                return (
                  <span key={action.label} className="error-hint">
                    {action.label}
                  </span>
                );
              }
              return (
                <button
                  key={action.label}
                  className="btn btn-ghost btn-sm"
                  title={url}
                  onClick={() => void openExternal(url).catch(() => undefined)}
                >
                  {action.label} <ExternalLink size={12} />
                  <span className="sr-only">(open in browser)</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
