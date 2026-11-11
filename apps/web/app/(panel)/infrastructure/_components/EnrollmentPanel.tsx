"use client";

import * as React from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import type { EnrollmentInstructions, Server } from "@kaname/contract";
import {
  AgentConnectionIndicator,
  Button,
  CardInset,
  CheckItem,
  CheckList,
  CopyableCode,
  MonoLabel,
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

  const minted = instructions !== null;

  return (
    <div className="flex flex-col gap-3">
      {enroll.error && <PageError error={enroll.error} context="Enrollment token" />}

      <CheckList divided="between">
        <CheckItem
          state={enrolled || minted ? "done" : "current"}
          title="Mint a single-use token"
          description={
            enrolled ? (
              "Spent by the enrollment that just happened."
            ) : minted ? (
              <>
                Bound to this server, expires <RelativeTime value={instructions.expires_at} />.
              </>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Spinner size={12} label="Minting an enrollment token" />
                Minting a single-use token…
              </span>
            )
          }
          action={
            !enrolled && (
              <Button
                variant="ghost"
                size="xs"
                icon={RefreshCw}
                loading={enroll.isPending}
                onClick={() => enroll.mutate({ serverId: server.id })}
              >
                New token
              </Button>
            )
          }
        />

        <CheckItem
          state={enrolled ? "done" : minted ? "current" : "todo"}
          title="Run the command on the host as root"
          description="The agent generates its keypair on the box, so the private key never leaves it."
        >
          {!enrolled && instructions && (
            <CardInset padding="none" className="mt-2.5 overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-[var(--kn-border-subtle)] px-3 py-1.5">
                <MonoLabel size="xs">Install command</MonoLabel>
                <MonoLabel size="xs" tone="subtle">
                  sh · root
                </MonoLabel>
              </div>
              <CopyableCode
                value={instructions.command}
                block
                className="rounded-none border-0 bg-transparent px-1 py-1"
              />
            </CardInset>
          )}
        </CheckItem>

        <CheckItem
          state={enrolled ? "done" : minted ? "current" : "todo"}
          title={enrolled ? "Agent connected" : "Waiting for the agent to connect"}
          description={
            enrolled ? (
              <>
                <MonoText muted>{current.os ?? "unknown os"}</MonoText>
                {current.arch && <MonoText muted> · {current.arch}</MonoText>}
                {current.agent_version && (
                  <MonoText muted> · kanamed {current.agent_version}</MonoText>
                )}
              </>
            ) : (
              "This resolves on its own the moment the agent dials in."
            )
          }
          action={
            <span className="flex items-center gap-2">
              {enrolled ? (
                <CheckCircle2 size={14} className="shrink-0 text-[var(--kn-ok)]" aria-hidden />
              ) : (
                <Spinner size={14} label="Waiting for the agent to connect" />
              )}
              <AgentConnectionIndicator
                connection={current.connection}
                since={current.last_seen_at}
              />
            </span>
          }
        />
      </CheckList>
    </div>
  );
}
