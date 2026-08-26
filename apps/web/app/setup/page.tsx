"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  SETUP_STEPS,
  SETUP_STEP_LABELS,
  UPDATE_TIER_LABELS,
  assessPassword,
  updateTier as updateTierEnum,
  type ComponentHealth,
  type PairingInstructions,
  type SetupHealth,
  type SetupState,
  type SetupStep,
  type UpdateTier,
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
  // ours to set up. Bounce rather than letting a step fail confusingly.
  React.useEffect(() => {
    if (state && !state.needs_onboarding) router.replace("/login");
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
      {step === "welcome" && <WelcomeStep state={state} onAdvance={setState} />}
      {step === "owner" && (
        <OwnerStep
          onAdvance={async (next) => {
            // The account now exists, so the session probe the rest of
            // the app reads has to be re-resolved before we move on.
            await refresh();
            setState(next);
          }}
        />
      )}
      {step === "instance" && <InstanceStep onAdvance={setState} />}
      {step === "server" && <ServerStep onAdvance={setState} />}
      {step === "preferences" && <PreferencesStep onAdvance={setState} />}
      {step === "done" && <DoneStep state={state} />}
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

function StepError({ error }: { error: ApiError | null }) {
  if (!error) return null;
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
}: {
  state: SetupState;
  onAdvance: (next: SetupState) => void;
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
      setError(toError(err));
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
      setError(toError(err));
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

          {!error?.fields.token && <StepError error={error} />}

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

function OwnerStep({ onAdvance }: { onAdvance: (next: SetupState) => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  /*
   * Live feedback from the same function the control plane runs, so the
   * hint and the verdict cannot disagree. The server still decides —
   * this is a courtesy, not the check.
   */
  const assessment = React.useMemo(
    () => (password ? assessPassword(password, [name, email]) : null),
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
      setError(toError(err));
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

        {!error?.fields.password && <StepError error={error} />}

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

function InstanceStep({ onAdvance }: { onAdvance: (next: SetupState) => void }) {
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
      setError(toError(err));
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

function ServerStep({ onAdvance }: { onAdvance: (next: SetupState) => void }) {
  const [servers, setServers] = React.useState<SetupServer[] | null>(null);
  const [pairing, setPairing] = React.useState<PairingInstructions | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);
  const [name, setName] = React.useState("server-01");

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
      setError(toError(err));
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
      setError(toError(err));
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
        <WaitingCard key={server.id} server={server} />
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
        <PairingBlock pairing={pairing} />
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

function WaitingCard({ server }: { server: SetupServer }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--kn-r-sm)] border border-dashed border-[var(--kn-border)] px-3 py-2.5">
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--kn-warn)]"
        aria-hidden
      />
      <span className="font-medium text-[var(--kn-text)]">{server.name}</span>
      <span className="text-sm text-[var(--kn-text-2)]" role="status">
        waiting for the agent to connect…
      </span>
    </div>
  );
}

function PairingBlock({ pairing }: { pairing: PairingInstructions }) {
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

  const minutes = Math.max(1, Math.round((Date.parse(pairing.expires_at) - Date.now()) / 60_000));

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

function PreferencesStep({ onAdvance }: { onAdvance: (next: SetupState) => void }) {
  const [tier, setTier] = React.useState<UpdateTier>("notify");
  const [notify, setNotify] = React.useState(false);
  const [address, setAddress] = React.useState("");
  const [acme, setAcme] = React.useState("");
  const [error, setError] = React.useState<ApiError | null>(null);
  const [pending, setPending] = React.useState(false);

  const save = async (skip: boolean) => {
    setPending(true);
    setError(null);
    try {
      onAdvance(
        await api.post<SetupState>("/setup/preferences", {
          update_tier: skip ? "notify" : tier,
          update_interval: "daily",
          ...(!skip && acme.trim() ? { acme_email: acme.trim() } : {}),
          notification:
            !skip && notify && address.trim()
              ? { kind: "email", address: address.trim() }
              : { kind: "none" },
        }),
      );
    } catch (err) {
      setError(toError(err));
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
          <Select
            id="setup-tier"
            className="mt-1.5"
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
          <p className="mt-1 text-xs text-[var(--kn-text-3)]">{UPDATE_TIER_LABELS[tier].detail}</p>
        </div>

        <div>
          <Checkbox
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
            label="Email me when something needs attention"
          />
          {notify && (
            <Input
              className="mt-2"
              boxClassName="w-72"
              type="email"
              mono
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="ops@example.com"
            />
          )}
          <p className="mt-1 text-xs text-[var(--kn-text-3)]">
            Failed jobs, a server going offline, a failed backup, a certificate about to expire.
          </p>
        </div>

        <FormField
          label="ACME contact address"
          hint="Only needed if you will issue certificates from this panel. Let's Encrypt uses it for expiry warnings."
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

        <StepError error={error} />

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            iconRight={ArrowRight}
            loading={pending}
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

function DoneStep({ state }: { state: SetupState }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const finish = async () => {
    setPending(true);
    setError(null);
    try {
      await api.post<SetupState>("/setup/complete");
      router.replace("/");
    } catch (err) {
      setError(toError(err));
      setPending(false);
    }
  };

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
        Open the Command Center
      </Button>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--kn-text-3)]">
        <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          Back up <code className="font-mono">KANAME_MASTER_KEY</code> from the environment file the
          installer wrote. Without it, every credential Kaname stores for you is unrecoverable.
        </span>
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function toError(err: unknown): ApiError {
  return isApiError(err)
    ? err
    : new ApiError({ code: "internal_error", message: String(err), status: 0 });
}
