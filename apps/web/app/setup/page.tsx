"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Copy,
  Globe,
  KeyRound,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  SETUP_STEPS,
  SETUP_STEP_LABELS,
  UPDATE_TIER_LABELS,
  assessPassword,
  passwordContext,
  updateCheckInterval as updateCheckIntervalEnum,
  updateTier as updateTierEnum,
  type ComponentHealth,
  type PairingInstructions,
  type SetupHealth,
  type SetupState,
  type SetupStep,
  type UpdateCheckInterval,
  type UpdateTier,
  type NotificationTestResult,
  type SmtpSecurity,
} from "@kaname/contract";
import {
  Button,
  Checkbox,
  FormField,
  InlineError,
  Input,
  Select,
  Skeleton,
  cn,
  useToast,
} from "@kaname/ui";
import {
  domainProblem,
  normalizeDomain,
  type PanelAddress,
  type PanelAddressApplying,
} from "@/lib/address";
import { ApiError, api, isApiError } from "@/lib/api";
import { connectEventStream } from "@/lib/events";
import { useSession } from "@/lib/queries";
import { Wordmark } from "@/components/Logo";

/* ------------------------------------------------------------------ *
 * First run.
 *
 * Six screens, and the whole flow is driven by GET /setup/state rather
 * than by local step state — so a closed tab, a reload, or finishing
 * from a different machine all resume in the right place. The client
 * never decides what is allowed; it renders what the control plane says
 * the state is and shows the reason when a step is refused.
 *
 * Deliberately plain. This is the first thing an operator sees, and
 * what it should communicate is that the thing they just installed is
 * working — not that somebody bought an illustration pack.
 * ------------------------------------------------------------------ */

export default function SetupPage() {
  const router = useRouter();
  const { refresh } = useSession();

  const [state, setState] = React.useState<SetupState | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(async () => {
    try {
      setState(await api.get<SetupState>("/setup/state", { allowUnauthenticated: true }));
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
          <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">
            The control plane is not answering
          </h1>
          <p className="mt-1 text-[var(--kn-text-2)]">{error.message}</p>
          {error.remediation?.summary && (
            <p className="mt-2 text-sm text-[var(--kn-text-3)]">{error.remediation.summary}</p>
          )}
          <Button
            className="mt-4"
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            onClick={() => {
              setError(null);
              void load();
            }}
          >
            Try again
          </Button>
        </Card>
      </Frame>
    );
  }

  if (!state) {
    return (
      <Frame>
        <Card>
          <Skeleton className="h-5 w-40" label="Loading setup" />
          <Skeleton className="mt-5 h-8 w-full" />
          <Skeleton className="mt-4 h-8 w-full" />
        </Card>
      </Frame>
    );
  }

  const step: SetupStep = state.token_required && !state.authorized ? "welcome" : state.step;

  return (
    <Frame step={step}>
      {step === "welcome" && <WelcomeStep state={state} onAdvance={setState} onStale={load} />}
      {step === "owner" && (
        <OwnerStep
          onAdvance={async (next) => {
            // The account now exists, so the session probe the rest of
            // the app reads has to be re-resolved before we move on.
            await refresh();
            setState(next);
          }}
          onStale={load}
        />
      )}
      {step === "instance" && <InstanceStep onAdvance={setState} onStale={load} />}
      {step === "server" && <ServerStep onAdvance={setState} onStale={load} />}
      {step === "preferences" && (
        <PreferencesStep domain={state.pending_domain ?? ""} onAdvance={setState} onStale={load} />
      )}
      {step === "done" && <DoneStep state={state} onStale={load} />}
    </Frame>
  );
}

/* ------------------------------------------------------------------ *
 * Frame
 * ------------------------------------------------------------------ */

function Frame({ children, step }: { children: React.ReactNode; step?: SetupStep }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-7 flex flex-col items-center gap-2 text-center">
          <Wordmark size={28} />
          <p className="text-[var(--kn-text-3)]">Setting up this installation.</p>
        </div>

        {step && <Stepper current={step} />}
        {children}
      </div>
    </main>
  );
}

function Stepper({ current }: { current: SetupStep }) {
  const index = SETUP_STEPS.indexOf(current);

  return (
    <ol className="mb-3 flex items-center gap-1.5" aria-label="Setup progress">
      {SETUP_STEPS.map((step, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li
            key={step}
            className="flex min-w-0 flex-1 flex-col gap-1"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={cn(
                "h-0.5 w-full rounded-full transition-colors duration-150",
                done && "bg-[var(--kn-accent-400)]",
                active && "bg-[var(--kn-accent)]",
                !done && !active && "bg-[var(--kn-border)]",
              )}
            />
            <span
              className={cn(
                "truncate text-xs",
                active ? "text-[var(--kn-text-2)]" : "text-[var(--kn-text-3)]",
              )}
            >
              {SETUP_STEP_LABELS[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-[var(--kn-r-lg)] border border-[var(--kn-border)] bg-[var(--kn-surface)] p-5",
        className,
      )}
    >
      {children}
    </div>
  );
}

function StepHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">{title}</h1>
      {hint && <p className="mt-1 text-[var(--kn-text-2)]">{hint}</p>}
    </div>
  );
}

function StepError({ error, exclude = [] }: { error: ApiError | null; exclude?: string[] }) {
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

/* ------------------------------------------------------------------ *
 * 1. Welcome — did the install actually work
 * ------------------------------------------------------------------ */

function WelcomeStep({
  state,
  onAdvance,
  onStale,
}: {
  state: SetupState;
  onAdvance: (next: SetupState) => void;
  onStale: () => void;
}) {
  const [token, setToken] = React.useState("");
  const [health, setHealth] = React.useState<SetupHealth | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);
  const needsToken = state.token_required && !state.authorized;

  const loadHealth = React.useCallback(async () => {
    try {
      setHealth(await api.get<SetupHealth>("/setup/health", { allowUnauthenticated: true }));
    } catch {
      // Health is gated until the token is presented; the form below
      // explains that far better than an error box would.
      setHealth(null);
    }
  }, []);

  React.useEffect(() => {
    if (needsToken) return;
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 5000);
    return () => window.clearInterval(timer);
  }, [loadHealth, needsToken]);

  const claim = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      onAdvance(
        await api.post<SetupState>(
          "/setup/token",
          { token: token.trim() },
          { allowUnauthenticated: true },
        ),
      );
      void loadHealth();
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  const advance = async () => {
    setPending(true);
    setError(null);
    try {
      onAdvance(await api.post<SetupState>("/setup/welcome", {}, { allowUnauthenticated: true }));
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  if (needsToken) {
    return (
      <Card>
        <form onSubmit={claim} noValidate className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]">
              <KeyRound size={14} aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">
                Setup token
              </h1>
              <p className="mt-0.5 text-[var(--kn-text-2)]">
                The installer printed this at the end of its run. It is what stops anyone else who
                can reach this address from claiming the panel first.
              </p>
            </div>
          </div>

          <FormField label="Token" error={error?.fields.token} required>
            <Input
              name="token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoFocus
              required
              mono
              size="md"
              placeholder="kn_setup_…"
              autoComplete="off"
            />
          </FormField>

          {!state.token_live && (
            <p className="rounded-[var(--kn-r-sm)] border border-[var(--kn-warn)] bg-[var(--kn-warn-soft)] px-3 py-2 text-sm text-[var(--kn-text-2)]">
              The installer&rsquo;s token has expired. Restart the control plane to mint a new one
              &mdash; it is printed on every boot while no account exists &mdash; then reload this
              page:{" "}
              <code className="font-mono">docker compose -p kaname restart control-plane</code>
            </p>
          )}

          <StepError error={error} exclude={["token"]} />

          <Button type="submit" variant="primary" size="md" loading={pending} fullWidth>
            Continue
          </Button>

          <p className="text-xs text-[var(--kn-text-3)]">
            Lost it? It is logged on every boot while no account exists:{" "}
            <code className="font-mono">docker compose -p kaname logs control-plane</code>
          </p>
        </form>
      </Card>
    );
  }

  const blocked = health?.all_in_one === true && health.agent.status !== "healthy";

  return (
    <Card>
      <StepHeading
        title="Checking the install"
        hint="Both halves of Kaname have to be talking to each other before anything else is worth doing."
      />

      <div className="flex flex-col gap-2">
        <HealthRow
          label="Control plane"
          status={health?.control_plane.status ?? "unknown"}
          detail={
            health
              ? `${health.control_plane.detail} Version ${health.control_plane.version}.`
              : "Checking…"
          }
        />
        <HealthRow
          label="Agent"
          status={health?.agent.status ?? "unknown"}
          detail={health?.agent.detail ?? "Checking…"}
          remediation={health?.agent.remediation ?? null}
        />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          iconRight={ArrowRight}
          loading={pending}
          disabled={blocked}
          onClick={() => void advance()}
        >
          Continue
        </Button>
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void loadHealth()}>
          Re-check
        </Button>
      </div>

      {blocked && (
        <p className="mt-3 text-sm text-[var(--kn-text-3)]">
          The installer paired an agent on this host, so setup waits for it. Everything after this
          screen assumes there is a server to manage.
        </p>
      )}

      <div className="mt-3">
        <StepError error={error} />
      </div>
    </Card>
  );
}

const HEALTH_TONE: Record<ComponentHealth, string> = {
  healthy: "bg-[var(--kn-ok)]",
  degraded: "bg-[var(--kn-warn)]",
  unreachable: "bg-[var(--kn-danger)]",
  unknown: "bg-[var(--kn-text-3)]",
};

function HealthRow({
  label,
  status,
  detail,
  remediation,
}: {
  label: string;
  status: ComponentHealth;
  detail: string;
  remediation?: string | null;
}) {
  return (
    <div className="rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", HEALTH_TONE[status])}
          aria-hidden
        />
        <span className="font-medium text-[var(--kn-text)]">{label}</span>
        <span className="ml-auto text-xs text-[var(--kn-text-3)]">{status}</span>
      </div>
      <p className="mt-1 text-sm text-[var(--kn-text-2)]">{detail}</p>
      {remediation && (
        <p className="mt-1 font-mono text-xs text-[var(--kn-text-3)]">{remediation}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Owner
 * ------------------------------------------------------------------ */

function OwnerStep({
  onAdvance,
  onStale,
}: {
  onAdvance: (next: SetupState) => Promise<void>;
  onStale: () => void;
}) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  /*
   * Live feedback from the same function, over the same context, the
   * control plane runs — so the hint and the verdict cannot disagree.
   * The server still decides; this is a courtesy, not the check.
   */
  const assessment = React.useMemo(
    () => (password ? assessPassword(password, passwordContext(name, email)) : null),
    [email, name, password],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const next = await api.post<SetupState>(
        "/setup/owner",
        { name, email, password, password_confirmation: confirmation },
        { allowUnauthenticated: true },
      );
      await onAdvance(next);
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <StepHeading
          title="Create your account"
          hint="The first account owns everything: every permission, on every server."
        />

        <FormField label="Name" error={error?.fields.name} required>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
            autoFocus
            required
            size="md"
          />
        </FormField>

        <FormField label="Email" error={error?.fields.email} required>
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
            size="md"
            mono
            placeholder="you@example.com"
          />
        </FormField>

        <FormField
          label="Password"
          error={error?.fields.password}
          hint="At least 12 characters. A passphrase of four unrelated words beats anything you can remember with a number on the end."
          required
        >
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            required
            size="md"
          />
        </FormField>

        {assessment && <PasswordMeter score={assessment.score} problems={assessment.problems} />}

        <FormField label="Confirm password" error={error?.fields.password_confirmation} required>
          <Input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            required
            size="md"
          />
        </FormField>

        <StepError error={error} exclude={["name", "email", "password", "password_confirmation"]} />

        <Button type="submit" variant="primary" size="md" loading={pending} fullWidth>
          Create account
        </Button>
      </form>
    </Card>
  );
}

function PasswordMeter({ score, problems }: { score: number; problems: string[] }) {
  return (
    <div className="-mt-2">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-0.5 flex-1 rounded-full transition-colors duration-150",
              i < score
                ? score >= 4
                  ? "bg-[var(--kn-ok)]"
                  : score >= 3
                    ? "bg-[var(--kn-accent)]"
                    : "bg-[var(--kn-warn)]"
                : "bg-[var(--kn-border)]",
            )}
          />
        ))}
      </div>
      {problems.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {problems.map((problem) => (
            <li key={problem} className="text-xs text-[var(--kn-text-3)]">
              {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Instance name
 * ------------------------------------------------------------------ */

function InstanceStep({
  onAdvance,
  onStale,
}: {
  onAdvance: (next: SetupState) => void;
  onStale: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      onAdvance(await api.post<SetupState>("/setup/instance", { instance_name: value.trim() }));
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <StepHeading
          title="Name this instance"
          hint="Shown in the sidebar and in two-factor codes. Useful once you run more than one."
        />

        <FormField label="Name" error={error?.fields.instance_name} required>
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            required
            size="md"
            placeholder="Production"
            maxLength={80}
          />
        </FormField>

        <StepError error={error} />

        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={pending}
          disabled={value.trim().length === 0}
          fullWidth
        >
          Continue
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 4. First server
 *
 * The trust moment: this is where an operator sees that the installer,
 * the control plane, the agent and this page are all really connected
 * to each other. So it shows the host, not a checkmark.
 * ------------------------------------------------------------------ */

interface SetupServer {
  id: string;
  name: string;
  hostname: string;
  os: string | null;
  os_version: string | null;
  arch: string | null;
  cpu_cores: number | null;
  memory_total: number | null;
  connection: string;
  agent_version: string | null;
}

function ServerStep({
  onAdvance,
  onStale,
}: {
  onAdvance: (next: SetupState) => void;
  onStale: () => void;
}) {
  const [servers, setServers] = React.useState<SetupServer[] | null>(null);
  const [pairing, setPairing] = React.useState<PairingInstructions | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);
  const [name, setName] = React.useState("server-01");
  // Ticks while a command is on screen, so its countdown is honest and
  // "expired" is noticed here rather than by install.sh on the other box.
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const expired = pairing !== null && Date.parse(pairing.expires_at) <= now;

  const load = React.useCallback(async () => {
    try {
      const result = await api.list<SetupServer>("/servers", { params: { per_page: 20 } });
      setServers(result.data);
    } catch (err) {
      setError(toError(err));
      setServers([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  /*
   * The waiting state resolves itself. An agent enrolling publishes on
   * the servers topic, and the same stream the rest of the app runs on
   * carries it here — so nobody has to press refresh to find out
   * whether the command they pasted worked.
   */
  React.useEffect(() => {
    const disconnect = connectEventStream({
      topics: ["servers"],
      onMessage: () => void load(),
    });
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      disconnect();
      window.clearInterval(timer);
    };
  }, [load]);

  // Derived from the list this step polls, not from the state the
  // previous step returned: a server that pairs while this screen is
  // open has to enable the button without a round trip through the
  // parent.
  const registered = servers?.length ?? 0;
  const connected = (servers ?? []).filter((server) => server.connection === "connected");
  const waiting = (servers ?? []).filter((server) => server.connection !== "connected");

  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      setPairing(await api.post<PairingInstructions>("/setup/server", { name: name.trim() }));
      void load();
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  /*
   * A fresh command for a server that is registered but not connected:
   * the previous token expired, or was minted in a tab that is gone.
   * The route supersedes the old token itself; it just does not echo
   * the name, which the row here already knows.
   */
  const regenerate = async (server: { id: string; name: string }) => {
    setPending(true);
    setError(null);
    try {
      const issued = await api.post<Omit<PairingInstructions, "server_name">>(
        `/servers/${server.id}/enroll-token`,
      );
      setPairing({ ...issued, server_name: server.name });
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  const advance = async () => {
    setPending(true);
    setError(null);
    try {
      onAdvance(await api.post<SetupState>("/setup/server/confirm"));
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <StepHeading
        title="Your first server"
        hint="Kaname manages a host through an agent that dials out from it. Nothing listens inbound."
      />

      {servers === null && <Skeleton className="h-20" label="Looking for servers" />}

      {connected.map((server) => (
        <ServerCard key={server.id} server={server} />
      ))}

      {waiting.map((server) => (
        <WaitingCard
          key={server.id}
          server={server}
          // Offered wherever this tab has no live command for the row:
          // after a reload, or once the one it minted has expired.
          onRegenerate={
            pairing?.server_id === server.id && !expired ? undefined : () => void regenerate(server)
          }
          busy={pending}
        />
      ))}

      {servers !== null && servers.length === 0 && !pairing && (
        <div className="flex flex-col gap-3">
          <p className="text-[var(--kn-text-2)]">
            Nothing is paired yet. Name the server and Kaname will hand you a command to run on it.
          </p>
          <FormField label="Server name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              size="md"
              boxClassName="w-64"
            />
          </FormField>
          <div>
            <Button
              variant="primary"
              size="md"
              icon={Server}
              loading={pending}
              onClick={() => void generate()}
            >
              Generate the pairing command
            </Button>
          </div>
        </div>
      )}

      {/* Once that server is on the socket, the command it needed is
          just clutter — and leaving a live token on screen is worse. */}
      {pairing && !connected.some((server) => server.id === pairing.server_id) && (
        <PairingBlock
          pairing={pairing}
          now={now}
          expired={expired}
          busy={pending}
          onRegenerate={() => void regenerate({ id: pairing.server_id, name: pairing.server_name })}
        />
      )}

      <div className="mt-4">
        <StepError error={error} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          iconRight={ArrowRight}
          loading={pending}
          disabled={registered === 0}
          onClick={() => void advance()}
        >
          Continue
        </Button>
        {registered > 0 && connected.length === 0 && (
          <span className="text-sm text-[var(--kn-text-3)]">
            You can continue while the agent finishes connecting.
          </span>
        )}
      </div>
    </Card>
  );
}

function ServerCard({ server }: { server: SetupServer }) {
  return (
    <div className="rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--kn-ok)]" aria-hidden />
        <span className="font-medium text-[var(--kn-text)]">{server.name}</span>
        <span className="truncate font-mono text-xs text-[var(--kn-text-3)]">
          {server.hostname}
        </span>
        <span className="ml-auto shrink-0 text-xs text-[var(--kn-text-3)]">connected</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Fact label="OS" value={[server.os, server.os_version].filter(Boolean).join(" ") || "—"} />
        <Fact label="Arch" value={server.arch ?? "—"} />
        <Fact label="CPU" value={server.cpu_cores ? `${server.cpu_cores} cores` : "—"} />
        <Fact
          label="Memory"
          value={server.memory_total ? `${Math.round(server.memory_total / 1024 ** 3)} GB` : "—"}
        />
      </dl>
      {server.agent_version && (
        <p className="mt-2 text-xs text-[var(--kn-text-3)]">Agent {server.agent_version}</p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--kn-text-3)]">{label}</dt>
      <dd className="truncate text-[var(--kn-text-2)]">{value}</dd>
    </div>
  );
}

function WaitingCard({
  server,
  onRegenerate,
  busy = false,
}: {
  server: SetupServer;
  /** Present when this tab has no live pairing command for the row. */
  onRegenerate?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--kn-r-sm)] border border-dashed border-[var(--kn-border)] px-3 py-2.5">
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--kn-warn)]"
        aria-hidden
      />
      <span className="font-medium text-[var(--kn-text)]">{server.name}</span>
      <span className="text-sm text-[var(--kn-text-2)]" role="status">
        waiting for the agent to connect…
      </span>
      {onRegenerate && (
        <Button
          className="ml-auto"
          variant="secondary"
          size="xs"
          icon={RefreshCw}
          loading={busy}
          onClick={onRegenerate}
        >
          Generate a new command
        </Button>
      )}
    </div>
  );
}

function PairingBlock({
  pairing,
  now,
  expired,
  busy,
  onRegenerate,
}: {
  pairing: PairingInstructions;
  now: number;
  expired: boolean;
  busy: boolean;
  onRegenerate: () => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairing.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ variant: "error", title: "The browser refused clipboard access." });
    }
  };

  if (expired) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg)] p-3">
        <p className="text-sm text-[var(--kn-text-2)]">
          The command for <span className="text-[var(--kn-text)]">{pairing.server_name}</span> has
          expired before it was used. Nothing on the server changed; mint another and run that
          instead.
        </p>
        <Button
          variant="secondary"
          size="sm"
          icon={RefreshCw}
          loading={busy}
          onClick={onRegenerate}
        >
          Generate a new command
        </Button>
      </div>
    );
  }

  const minutes = Math.max(1, Math.round((Date.parse(pairing.expires_at) - now) / 60_000));

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-[var(--kn-text-2)]">
        Run this as root on <span className="text-[var(--kn-text)]">{pairing.server_name}</span>:
      </p>
      <div className="flex items-start gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] bg-[var(--kn-bg)] p-3">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--kn-text-2)]">
          {pairing.command}
        </code>
        <Button
          variant="ghost"
          size="xs"
          icon={copied ? Check : Copy}
          onClick={() => void copy()}
          aria-label="Copy the pairing command"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-[var(--kn-text-3)]">
        Single-use, and it expires in about {minutes} minute{minutes === 1 ? "" : "s"} — a pairing
        token that lived longer would be a way to join someone else&rsquo;s agent to your fleet.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Preferences — entirely skippable
 * ------------------------------------------------------------------ */

interface SmtpDraft {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  from_address: string;
}

const EMPTY_SMTP: SmtpDraft = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  password: "",
  from_address: "",
};

const CHECK_INTERVAL_LABELS: Record<UpdateCheckInterval, string> = {
  hourly: "Check every hour",
  daily: "Check every day",
  weekly: "Check every week",
};

function PreferencesStep({
  domain,
  onAdvance,
  onStale,
}: {
  /** A domain saved on an earlier pass through this screen. */
  domain: string;
  onAdvance: (next: SetupState) => void;
  onStale: () => void;
}) {
  const [tier, setTier] = React.useState<UpdateTier>("notify");
  const [checkInterval, setCheckInterval] = React.useState<UpdateCheckInterval>("daily");
  const [notify, setNotify] = React.useState(false);
  const [address, setAddress] = React.useState("");
  const [addressProblem, setAddressProblem] = React.useState<string | null>(null);
  const [smtp, setSmtp] = React.useState<SmtpDraft>(EMPTY_SMTP);
  const [smtpTest, setSmtpTest] = React.useState<NotificationTestResult | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [acme, setAcme] = React.useState("");
  const [panel, setPanel] = React.useState<PanelAddress | null>(null);
  const [domainDraft, setDomainDraft] = React.useState(domain);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  const nextDomain = normalizeDomain(domainDraft);
  const problem = domainProblem(nextDomain);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.get<PanelAddress>("/settings/address");
        if (!cancelled) setPanel(result);
      } catch {
        // An instance that cannot answer this cannot change its own
        // address either, so the field is simply not offered.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const wantsEmail = notify && address.trim().length > 0;
  const smtpProvided = smtp.host.trim().length > 0;

  const smtpBody = () => ({
    host: smtp.host.trim(),
    port: smtp.port,
    security: smtp.security,
    username: smtp.username.trim(),
    // A sender was not asked for separately: the address that receives
    // the mail is a fine default until Settings says otherwise.
    from_address: smtp.from_address.trim() || address.trim(),
    from_name: "Kaname",
    ...(smtp.password ? { password: smtp.password } : {}),
  });

  const testSmtp = async () => {
    setTesting(true);
    setSmtpTest(null);
    try {
      setSmtpTest(
        await api.post<NotificationTestResult>("/settings/notifications/smtp/test", {
          to: address.trim(),
          smtp: smtpBody(),
        }),
      );
    } catch (err) {
      setSmtpTest({ ok: false, error: toError(err).message, duration_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const save = async (skip: boolean) => {
    // A ticked box with nothing in it is a question, not a "no": sending
    // `none` here would answer it silently and create no channel.
    if (!skip && notify && address.trim().length === 0) {
      setAddressProblem("Enter the address to notify, or untick the box.");
      return;
    }
    setAddressProblem(null);
    setPending(true);
    setError(null);
    try {
      const next = await api.post<SetupState>("/setup/preferences", {
        update_tier: skip ? "notify" : tier,
        // Skipping leaves the contract's default; "off" has no cadence.
        ...(!skip && tier !== "off" ? { update_interval: checkInterval } : {}),
        ...(!skip && acme.trim() ? { acme_email: acme.trim() } : {}),
        notification:
          !skip && wantsEmail ? { kind: "email", address: address.trim() } : { kind: "none" },
        ...(!skip && wantsEmail && smtpProvided ? { smtp: smtpBody() } : {}),
        // Validated now, applied on the last screen — see the description
        // on the field. Stored server-side so a reload does not lose it.
        ...(!skip && nextDomain ? { panel_domain: nextDomain } : {}),
      });
      onAdvance(next);
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <StepHeading
        title="A few preferences"
        hint="All of this is in Administration afterwards. Skipping leaves sensible defaults."
      />

      <div className="flex flex-col gap-5">
        <div>
          <label className="text-sm font-medium text-[var(--kn-text)]" htmlFor="setup-tier">
            Updates
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Select
              id="setup-tier"
              boxClassName="w-72"
              value={tier}
              onChange={(event) => setTier(event.target.value as UpdateTier)}
              options={updateTierEnum.options
                // Applying everything unattended is a decision to make
                // deliberately in Settings, not to click past on day one.
                .filter((option) => option !== "auto_all")
                .map((option) => ({
                  value: option,
                  label: UPDATE_TIER_LABELS[option].label,
                }))}
            />
            {tier !== "off" && (
              <Select
                aria-label="How often to check for updates"
                boxClassName="w-44"
                value={checkInterval}
                onChange={(event) => setCheckInterval(event.target.value as UpdateCheckInterval)}
                options={updateCheckIntervalEnum.options.map((option) => ({
                  value: option,
                  label: CHECK_INTERVAL_LABELS[option],
                }))}
              />
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--kn-text-3)]">{UPDATE_TIER_LABELS[tier].detail}</p>
        </div>

        <div>
          <Checkbox
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
            label="Email me when something needs attention"
          />
          {notify && (
            <FormField
              className="mt-2"
              label="Address"
              error={error?.fields["notification.address"] ?? addressProblem ?? undefined}
              required
            >
              <Input
                boxClassName="w-72"
                type="email"
                mono
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setAddressProblem(null);
                }}
                placeholder="ops@example.com"
              />
            </FormField>
          )}
          <p className="mt-1 text-xs text-[var(--kn-text-3)]">
            Failed jobs, a server going offline, a failed backup, a certificate about to expire, an
            update waiting for you.
          </p>

          {notify && (
            <div className="mt-3 flex flex-col gap-2 rounded-[var(--kn-r-sm)] border border-[var(--kn-border)] p-3">
              <p className="text-sm text-[var(--kn-text)]">
                Outgoing mail server{" "}
                <span className="text-[var(--kn-text-3)]">
                  — nothing is emailed until one is set. You can also do this later in Settings.
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  mono
                  boxClassName="w-64"
                  placeholder="smtp.example.com"
                  spellCheck={false}
                  autoComplete="off"
                  value={smtp.host}
                  onChange={(event) => setSmtp({ ...smtp, host: event.target.value })}
                />
                <Input
                  mono
                  type="number"
                  inputMode="numeric"
                  boxClassName="w-24"
                  aria-label="SMTP port"
                  value={String(smtp.port)}
                  onChange={(event) =>
                    setSmtp({
                      ...smtp,
                      port: Math.max(1, Math.min(65535, Number(event.target.value) || 0)),
                    })
                  }
                />
                <Select
                  aria-label="Connection security"
                  boxClassName="w-36"
                  value={smtp.security}
                  onChange={(event) =>
                    setSmtp({ ...smtp, security: event.target.value as SmtpSecurity })
                  }
                  options={[
                    { value: "starttls", label: "STARTTLS" },
                    { value: "tls", label: "TLS" },
                    { value: "none", label: "None" },
                  ]}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  mono
                  boxClassName="w-56"
                  placeholder="username (optional)"
                  spellCheck={false}
                  autoComplete="off"
                  value={smtp.username}
                  onChange={(event) => setSmtp({ ...smtp, username: event.target.value })}
                />
                <Input
                  mono
                  type="password"
                  boxClassName="w-56"
                  placeholder="password"
                  autoComplete="new-password"
                  value={smtp.password}
                  onChange={(event) => setSmtp({ ...smtp, password: event.target.value })}
                />
                <Input
                  mono
                  type="email"
                  boxClassName="w-64"
                  placeholder="sender (defaults to the address above)"
                  spellCheck={false}
                  autoComplete="off"
                  value={smtp.from_address}
                  onChange={(event) => setSmtp({ ...smtp, from_address: event.target.value })}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  size="xs"
                  icon={Send}
                  loading={testing}
                  disabled={!wantsEmail || !smtpProvided}
                  onClick={() => void testSmtp()}
                >
                  Send a test email
                </Button>
                {smtpTest &&
                  (smtpTest.ok ? (
                    <span className="text-sm text-[var(--kn-ok)]">
                      Delivered in {smtpTest.duration_ms} ms.
                    </span>
                  ) : (
                    <span className="text-sm text-[var(--kn-danger)]">{smtpTest.error}</span>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Offered only where there is nothing to lose: an instance that
            already has a name is one that Settings owns, not this screen. */}
        {panel?.managed && !panel.domain && (
          <FormField
            label="Panel domain"
            hint="optional"
            error={problem ?? undefined}
            description="You are reading this over plain HTTP on this server's IP address. Point an A record at this server, leave ports 80 and 443 open, and Kaname will also serve the panel on that name over HTTPS with a certificate it renews. The IP address keeps working. Applied when you finish setup, not now."
          >
            <Input
              mono
              size="md"
              boxClassName="w-72"
              value={domainDraft}
              onChange={(event) => setDomainDraft(event.target.value)}
              onBlur={() => setDomainDraft(nextDomain)}
              placeholder="panel.example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        )}

        <FormField
          label="ACME contact address"
          hint="Only needed if you will issue certificates from this panel. Let's Encrypt uses it for expiry warnings."
          error={error?.fields.acme_email}
        >
          <Input
            type="email"
            mono
            boxClassName="w-72"
            value={acme}
            onChange={(event) => setAcme(event.target.value)}
            placeholder="ops@example.com"
          />
        </FormField>

        <StepError error={error} exclude={["acme_email", "notification.address"]} />

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            iconRight={ArrowRight}
            loading={pending}
            disabled={problem !== null}
            onClick={() => void save(false)}
          >
            Save and continue
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void save(true)}>
            Skip
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * 6. Done
 * ------------------------------------------------------------------ */

function DoneStep({ state, onStale }: { state: SetupState; onStale: () => void }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [completed, setCompleted] = React.useState(false);
  const [applied, setApplied] = React.useState<PanelAddressApplying | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  // Read once: /setup/complete clears it on the server, and "Try again"
  // after a failed apply still needs to know what to apply.
  const [domain] = React.useState(state.pending_domain ?? "");

  const finish = async () => {
    setPending(true);
    setError(null);
    try {
      // Completing first, because applying the address takes the control
      // plane down: a /setup/complete sent into that restart is the one
      // request that decides whether this instance counts as set up.
      if (!completed) {
        await api.post<SetupState>("/setup/complete");
        setCompleted(true);
      }
      if (domain) {
        setApplied(await api.post<PanelAddressApplying>("/settings/address", { domain }));
        setPending(false);
        return;
      }
      router.replace("/");
    } catch (err) {
      const failure = toError(err);
      setError(failure);
      if (isStale(failure)) onStale();
      setPending(false);
    }
  };

  if (applied) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]">
            <Globe size={14} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">
              Setting up {applied.domain}
            </h1>
            <p className="mt-0.5 text-[var(--kn-text-2)]">
              Kaname is restarting to pick up the name and asking the certificate authority for a
              certificate. That usually lands inside a minute; the first attempt can be slower.
            </p>
          </div>
        </div>

        <p className="mt-3 text-sm text-[var(--kn-text-2)]">
          The address you are on now keeps answering on port 80 throughout, so nothing here depends
          on the certificate arriving. Once it does,{" "}
          <span className="font-mono text-[var(--kn-text)]">{applied.public_url}</span> answers as
          well &mdash; and if the A record is not pointing at this server yet, correct it and the
          request retries on its own.
        </p>

        <p className="mt-2 text-sm text-[var(--kn-text-2)]">
          A session belongs to the address it was opened on, so the new name will ask you to sign in
          once. Signing in here keeps working too. If the name does not answer yet, wait a moment
          and reload.
        </p>

        <Button
          className="mt-4"
          variant="primary"
          size="md"
          iconRight={ArrowRight}
          onClick={() => window.location.assign(applied.public_url)}
          fullWidth
        >
          Open {applied.domain ?? applied.public_url}
        </Button>

        <Button
          className="mt-2"
          variant="ghost"
          size="sm"
          onClick={() => router.replace("/")}
          fullWidth
        >
          Stay on this address
        </Button>

        <MasterKeyNote />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--kn-r-sm)] bg-[var(--kn-accent-soft)] text-[var(--kn-accent-400)]">
          <ShieldCheck size={14} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-medium tracking-tight text-[var(--kn-text)]">
            {state.instance_name ?? "Kaname"} is ready
          </h1>
          <p className="mt-0.5 text-[var(--kn-text-2)]">
            {state.servers_connected === 1
              ? "One server is connected."
              : `${state.servers_connected} servers are connected.`}{" "}
            Every action from here on is recorded in the audit trail.
          </p>
        </div>
      </div>

      {domain && (
        <p className="mt-3 text-sm text-[var(--kn-text-2)]">
          Finishing also names this panel{" "}
          <span className="font-mono text-[var(--kn-text)]">{domain}</span>. Kaname restarts once to
          apply it, and this address keeps working while it does.
        </p>
      )}

      <div className="mt-4">
        <StepError error={error} />
      </div>

      <Button
        className="mt-4"
        variant="primary"
        size="md"
        iconRight={ArrowRight}
        loading={pending}
        onClick={() => void finish()}
        fullWidth
      >
        {error && completed ? "Try again" : "Open the Command Center"}
      </Button>

      {error && completed && (
        <Button
          className="mt-2"
          variant="ghost"
          size="sm"
          onClick={() => router.replace("/")}
          fullWidth
        >
          Continue without the domain
        </Button>
      )}

      <MasterKeyNote />
    </Card>
  );
}

function MasterKeyNote() {
  return (
    <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--kn-text-3)]">
      <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        Back up <code className="font-mono">KANAME_MASTER_KEY</code> from the environment file the
        installer wrote. Without it, every credential Kaname stores for you is unrecoverable.
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ */

function toError(err: unknown): ApiError {
  return isApiError(err)
    ? err
    : new ApiError({ code: "internal_error", message: String(err), status: 0 });
}

/**
 * A refusal that means the state this tab rendered from is no longer
 * true — the setup cookie or token lapsed, or somebody else finished —
 * so the page re-reads it and the right screen comes back instead of a
 * dead end with a form that cannot succeed.
 */
function isStale(error: ApiError): boolean {
  return error.code === "unauthenticated" || error.code === "conflict";
}
