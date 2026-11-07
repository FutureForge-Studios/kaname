"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { SetupState, SetupStep } from "@kaname/contract";
import { Button, Skeleton } from "@kaname/ui";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { Card, Frame, StepHeading, toError } from "./_components/chrome";
import { InstanceStep, OwnerStep, ServerStep, WelcomeStep } from "./_components/install-steps";
import {
  AddressStep,
  BackupsStep,
  EmailStep,
  NotificationsStep,
  TeamStep,
  WebsiteStep,
} from "./_components/panel-steps";
import { DoneStep } from "./_components/done-step";

/* ------------------------------------------------------------------ *
 * First run.
 *
 * Four required screens get the instance claimed and a server paired;
 * six optional ones walk the core of the panel — its own address, a
 * first website, email, backups, alerts and a teammate — and a last one
 * reads back what was set up. The flow is driven by GET /setup/state
 * rather than by local step state, so a closed tab, a reload, or
 * finishing from another machine all resume in the right place. The
 * client never decides what is allowed; it renders what the control
 * plane says and shows the reason when a step is refused.
 * ------------------------------------------------------------------ */

export default function SetupPage() {
  const router = useRouter();
  const { refresh } = useSession();

  const [state, setState] = React.useState<SetupState | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(async () => {
    try {
      setState(await api.get<SetupState>("/setup/state", { allowUnauthenticated: true }));
      setError(null);
    } catch (err) {
      setError(toError(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // An instance somebody else finished while this tab was open is not
  // ours to set up. Bounce rather than letting a step fail confusingly —
  // into the panel if this tab holds the session, to sign-in otherwise.
  React.useEffect(() => {
    if (state && !state.needs_onboarding) router.replace(state.authorized ? "/" : "/login");
  }, [router, state]);

  if (error && !state) {
    return (
      <Frame>
        <Card>
          <div className="flex flex-col gap-5">
            <StepHeading
              title="The control plane is not answering"
              hint={
                <>
                  {error.message}
                  {error.remediation?.summary && <> {error.remediation.summary}</>}
                </>
              }
            />
            <div className="flex justify-end border-t border-[var(--kn-border)] pt-5">
              <Button
                variant="primary"
                size="md"
                icon={RefreshCw}
                autoFocus
                onClick={() => {
                  setError(null);
                  void load();
                }}
              >
                Try again
              </Button>
            </div>
          </div>
        </Card>
      </Frame>
    );
  }

  if (!state) {
    return (
      <Frame>
        <Card>
          <Skeleton className="h-6 w-48" label="Loading setup" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-6 h-8 w-full" />
          <Skeleton className="mt-4 h-8 w-full" />
        </Card>
      </Frame>
    );
  }

  const step: SetupStep = state.token_required && !state.authorized ? "welcome" : state.step;
  const props = { state, onAdvance: setState, onStale: load };

  return (
    <Frame step={step}>
      {/* Keyed by step so each one mounts fresh: its first field takes
          focus and no draft from the previous screen leaks into it. */}
      <React.Fragment key={step}>
        {step === "welcome" && <WelcomeStep {...props} />}
        {step === "owner" && (
          <OwnerStep
            onAdvance={async (next) => {
              // The account now exists, so the session the rest of the app
              // reads has to be re-resolved before moving on.
              await refresh();
              setState(next);
            }}
            onStale={load}
          />
        )}
        {step === "instance" && <InstanceStep onAdvance={setState} onStale={load} />}
        {step === "server" && <ServerStep onAdvance={setState} onStale={load} />}
        {step === "address" && <AddressStep {...props} />}
        {step === "website" && <WebsiteStep {...props} />}
        {step === "email" && <EmailStep {...props} />}
        {step === "backups" && <BackupsStep {...props} />}
        {step === "notifications" && <NotificationsStep {...props} />}
        {step === "team" && <TeamStep {...props} />}
        {step === "done" && <DoneStep state={state} onStale={load} />}
      </React.Fragment>
    </Frame>
  );
}
