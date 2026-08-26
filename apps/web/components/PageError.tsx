"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorState } from "@kaname/ui";
import type { RemediationAction } from "@kaname/contract";
import { isApiError, type ApiError } from "@/lib/api";

/* ------------------------------------------------------------------ *
 * The one error surface.
 *
 * Every failed query, every error boundary and every list page renders
 * through here, so an operator always gets the machine code, the
 * specific message and whatever the control plane offered as a way
 * forward — never a shrug. Remediation `href`s are routed through the
 * app router rather than a full page load, so the fix lands in context.
 * ------------------------------------------------------------------ */

export interface PageErrorProps {
  error: unknown;
  /** Refetch, reset an error boundary, or re-run the failed action. */
  onRetry?: () => void;
  /** Handles remediation actions with no `href`, e.g. "certificates.retry". */
  onAction?: (action: RemediationAction) => void;
  /** Prepended to the control plane's message when the context matters. */
  context?: string;
  className?: string;
}

interface Normalized {
  code: string;
  message: string;
  remediation: ApiError["remediation"];
  requestId: string | null;
}

function normalize(error: unknown, context?: string): Normalized {
  if (isApiError(error)) {
    return {
      code: error.code,
      message: context ? `${context}: ${error.message}` : error.message,
      remediation: error.remediation,
      requestId: error.requestId,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "internal_error",
    message: context ? `${context}: ${message}` : message,
    remediation: {
      summary:
        "This failed inside the panel rather than on the control plane, so there is nothing queued and nothing changed on any host.",
      actions: [],
    },
    requestId: null,
  };
}

export function PageError({ error, onRetry, onAction, context, className }: PageErrorProps) {
  const router = useRouter();
  const normalized = normalize(error, context);

  const handleAction = React.useCallback(
    (action: RemediationAction) => {
      if (action.href) {
        router.push(action.href);
        return;
      }
      if (action.action === "request.retry") {
        onRetry?.();
        return;
      }
      onAction?.(action);
    },
    [onAction, onRetry, router],
  );

  return (
    <ErrorState
      code={normalized.code}
      message={normalized.message}
      remediation={normalized.remediation}
      onAction={handleAction}
      className={className}
    >
      {(onRetry || normalized.requestId) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          {normalized.requestId && (
            <span className="kn-mono text-xs text-[var(--kn-text-3)]">
              request {normalized.requestId}
            </span>
          )}
        </div>
      )}
    </ErrorState>
  );
}
