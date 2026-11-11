"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { SetupState, SetupStep } from "@kaname/contract";
import { Button, Skeleton, StatusLine } from "@kaname/ui";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/queries";
import { Frame, StepActions, StepHeading, StepShell, toError } from "./_components/chrome";
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
        <StepShell
          heading={
            <StepHeading
              title="The control plane is not answering"
              hint={error.remediation?.summary}
            />
          }
        >
          <div className="flex flex-col gap-5">
            <StatusLine tone="danger">
              {error.message}
            </StatusLine>
            <StepActions>
              <Button
                variant="primary"
                size="lg"
                icon={RefreshCw}
                autoFocus
                onClick={() => {
                  setError(null);
                  void load();
                }}
              >
                Try again
              </Button>
            </StepActions>
          </div>
        </StepShell>
      </Frame>
    );
  }

  if (!state) {
    return (
      <Frame>
        <StepShell
          heading={
            <div className="flex flex-col gap-5">
              <Skeleton className="h-6 w-24" label="Loading setup" />
              <Skeleton className="h-10 w-72 max-w-full" />
              <Skeleton className="h-10 w-56 max-w-full" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
          }
        >
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-6 h-9 w-full" />
          <Skeleton className="mt-4 h-9 w-full" />
          <Skeleton className="mt-8 h-11 w-36" />
        </StepShell>
      </Frame>
    );
  }

  const step: SetupStep = state.token_required && !state.authorized ? "welcome" : state.step;
  const props = { state, onAdvance: setState, onStale: load };

  return (
    <Frame step={step} outcomes={state.outcomes}>
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
