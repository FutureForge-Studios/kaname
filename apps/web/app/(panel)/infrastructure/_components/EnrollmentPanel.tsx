"use client";

import * as React from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import type { EnrollmentInstructions, Server } from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Button,
  CopyableCode,
  MonoText,
  RelativeTime,
  Spinner,
} from "@kaname/ui";
import { PageError } from "@/components/PageError";
import { useEnrollmentToken, useServerWatch } from "../_lib/infra";

/* ------------------------------------------------------------------ *
 * Enrollment.
 *
 * The same panel serves "I just created this row" and "this host lost
 * its certificate", because the operator's job is identical in both
 * cases: paste one line on the box and wait. The wait is a real state
 * with a live indicator, not a dialog that closes and leaves you
 * refreshing a table.
 * ------------------------------------------------------------------ */

export interface EnrollmentPanelProps {
  server: Server;
  onEnrolled?: (server: Server) => void;
}

export function EnrollmentPanel({ server, onEnrolled }: EnrollmentPanelProps) {
  const [instructions, setInstructions] = React.useState<EnrollmentInstructions | null>(null);
  const [enrolled, setEnrolled] = React.useState(server.connection === "connected");
  const enroll = useEnrollmentToken(setInstructions);

  const issuedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (issuedFor.current === server.id) return;
    issuedFor.current = server.id;
    enroll.mutate({ serverId: server.id });
    // `mutate` is stable; re-running on the mutation object would loop.
  }, [enroll.mutate, server.id]);

  /* The poll stops the moment the agent lands: a resolved enrollment is
   * not something to keep asking about. */
  const watch = useServerWatch(server.id, !enrolled);
  const current = watch.data ?? server;

  const notify = React.useRef(onEnrolled);
  notify.current = onEnrolled;

  React.useEffect(() => {
    if (current.connection !== "connected") return;
    setEnrolled(true);
    notify.current?.(current);
  }, [current]);

  return (
    <div className="flex flex-col gap-4">
      {enroll.error && <PageError error={enroll.error} context="Enrollment token" />}

      {!enrolled && (
        <div className="flex flex-col gap-2">
          {instructions ? (
            <>
              <CopyableCode value={instructions.command} label="Copy install command" block />
              <p className="text-[var(--kn-text-2)]">
                Run it as root on the host. The token is single-use and expires{" "}
                <RelativeTime value={instructions.expires_at} />; the agent generates its keypair on
                the box, so the private key never leaves it.
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2 text-[var(--kn-text-2)]">
              <Spinner size={14} label="Minting an enrollment token" />
              Minting a single-use token…
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] px-3 py-2.5">
        {enrolled ? (
          <CheckCircle2 size={14} className="shrink-0 text-[var(--kn-ok)]" aria-hidden />
        ) : (
          <Spinner size={14} label="Waiting for the agent to connect" />
        )}

        <div className="min-w-0 flex-1">
          <p className="text-[var(--kn-text)]">
            {enrolled ? "Agent connected" : "Waiting for the agent to connect"}
          </p>
          <p className="min-w-0 truncate text-[var(--kn-text-2)]">
            {enrolled ? (
              <>
                <MonoText muted>{current.os ?? "unknown os"}</MonoText>
                {current.arch && <MonoText muted> · {current.arch}</MonoText>}
                {current.agent_version && (
                  <MonoText muted> · kanamed {current.agent_version}</MonoText>
                )}
              </>
            ) : (
              "This resolves on its own the moment the agent dials in."
            )}
          </p>
        </div>

        <AgentConnectionIndicator connection={current.connection} since={current.last_seen_at} />

        {!enrolled && (
          <Button
            variant="ghost"
            size="xs"
            icon={RefreshCw}
            loading={enroll.isPending}
            onClick={() => enroll.mutate({ serverId: server.id })}
          >
            New token
          </Button>
        )}
      </div>
    </div>
  );
}
