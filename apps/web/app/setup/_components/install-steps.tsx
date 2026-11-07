"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  Server as ServerIcon,
  ShieldCheck,
  Tag,
  UserRound,
} from "lucide-react";
import {
  assessPassword,
  passwordContext,
  type ComponentHealth,
  type PairingInstructions,
  type SetupHealth,
  type SetupState,
} from "@kaname/contract";
import { Button, FormField, Input, MonoText, Skeleton, cn, useToast } from "@kaname/ui";
import { api } from "@/lib/api";
import { connectEventStream } from "@/lib/events";
import {
  EMAIL_RE,
  Note,
  StepError,
  StepFooter,
  StepForm,
  StepHeading,
  useStepAction,
  type StepProps,
} from "./chrome";

/* ------------------------------------------------------------------ *
 * 1. Welcome — did the install actually work
 * ------------------------------------------------------------------ */

export function WelcomeStep({ state, onAdvance, onStale }: StepProps) {
  const [token, setToken] = React.useState("");
  const [tokenProblem, setTokenProblem] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<SetupHealth | null>(null);
  const [checked, setChecked] = React.useState(false);
  const { pending, error, run } = useStepAction(onStale);
  const needsToken = state.token_required && !state.authorized;

  const loadHealth = React.useCallback(async () => {
    try {
      setHealth(await api.get<SetupHealth>("/setup/health", { allowUnauthenticated: true }));
    } catch {
      // Health is gated until the token is presented; the form explains
      // that far better than an error box would.
      setHealth(null);
    } finally {
      setChecked(true);
    }
  }, []);

  React.useEffect(() => {
    if (needsToken) return;
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 5000);
    return () => window.clearInterval(timer);
  }, [loadHealth, needsToken]);

  if (needsToken) {
    const claim = async () => {
      const value = token.trim();
      if (value.length < 16) {
        setTokenProblem(
          value.length === 0
            ? "Paste the token the installer printed."
            : "That is too short to be a setup token.",
        );
        return;
      }
      setTokenProblem(null);
      const next = await run(() =>
        api.post<SetupState>("/setup/token", { token: value }, { allowUnauthenticated: true }),
      );
      if (next) {
        onAdvance(next);
        void loadHealth();
      }
    };

    return (
      <StepForm onSubmit={() => void claim()}>
        <StepHeading
          icon={KeyRound}
          title="Enter your setup token"
          hint="The installer printed it at the end of its run. It proves you are the person who installed this panel, so nobody else who can reach this address can claim it first."
        />

        <FormField label="Setup token" error={tokenProblem ?? error?.fields.token} required>
          <Input
            name="token"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setTokenProblem(null);
            }}
            autoFocus
            mono
            size="md"
            placeholder="kn_setup_…"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>

        {!state.token_live && (
          <Note tone="warn">
            The installer&rsquo;s token has expired. Restart the control plane to mint a new one —
            it is printed on every boot while no account exists — then reload this page:{" "}
            <MonoText>docker compose -p kaname restart control-plane</MonoText>
          </Note>
        )}

        <StepError error={error} exclude={["token"]} />

        <p className="text-sm text-[var(--kn-text-3)]">
          Lost it? It is logged on every boot while no account exists:{" "}
          <MonoText>docker compose -p kaname logs control-plane | grep setup_token</MonoText>
        </p>

        <StepFooter primary="Continue" icon={ArrowRight} pending={pending} />
      </StepForm>
    );
  }

  const blocked = health?.all_in_one === true && health.agent.status !== "healthy";

  const advance = async () => {
    if (blocked) return;
    const next = await run(() =>
      api.post<SetupState>("/setup/welcome", {}, { allowUnauthenticated: true }),
    );
    if (next) onAdvance(next);
  };

  return (
    <StepForm onSubmit={() => void advance()}>
      <StepHeading
        icon={ShieldCheck}
        title="Checking the install"
        hint="Kaname has two halves: the control plane you are talking to, and an agent on each server. Both have to be answering before anything else is worth doing."
      />

      <div className="flex flex-col gap-2" aria-busy={!checked}>
        <HealthRow
          label="Control plane"
          status={health?.control_plane.status ?? "unknown"}
          detail={
            health
              ? `${health.control_plane.detail} Version ${health.control_plane.version}.`
              : checked
                ? "Could not read the control plane's health."
                : "Checking…"
          }
        />
        <HealthRow
          label="Agent"
          status={health?.agent.status ?? "unknown"}
          detail={health?.agent.detail ?? (checked ? "No answer yet." : "Checking…")}
          remediation={health?.agent.remediation ?? null}
        />
      </div>

      {blocked && (
        <Note tone="warn">
          The installer paired an agent on this host, so setup waits for it. Everything after this
          screen assumes there is a server to manage. This page re-checks every few seconds.
        </Note>
      )}

      <StepError error={error} />

      <StepFooter
        primary="Continue"
        icon={ArrowRight}
        pending={pending}
        disabled={blocked || !checked}
        primaryAutoFocus
        aside={
          <Button type="button" variant="ghost" size="md" icon={RefreshCw} onClick={() => void loadHealth()}>
            Check again
          </Button>
        }
      />
    </StepForm>
  );
}

const HEALTH_TONE: Record<ComponentHealth, string> = {
  healthy: "bg-[var(--kn-ok)]",
  degraded: "bg-[var(--kn-warn)]",
  unreachable: "bg-[var(--kn-danger)]",
  unknown: "bg-[var(--kn-text-3)]",
};

const HEALTH_WORD: Record<ComponentHealth, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  unreachable: "Unreachable",
  unknown: "Unknown",
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
    <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", HEALTH_TONE[status])} aria-hidden />
        <span className="font-medium text-[var(--kn-text)]">{label}</span>
        <span className="ml-auto text-sm text-[var(--kn-text-3)]">{HEALTH_WORD[status]}</span>
      </div>
      <p className="mt-1 text-sm text-[var(--kn-text-2)]">{detail}</p>
      {remediation && <p className="mt-1 font-mono text-xs text-[var(--kn-text-3)]">{remediation}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Owner
 * ------------------------------------------------------------------ */

export function OwnerStep({
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
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const { pending, error, run } = useStepAction(onStale);

  /*
   * Live feedback from the same function, over the same context, the
   * control plane runs — so the hint and the verdict cannot disagree.
   * The server still decides; this is a courtesy, not the check.
   */
  const assessment = React.useMemo(
    () => (password ? assessPassword(password, passwordContext(name, email)) : null),
    [email, name, password],
  );

  const problems = {
    name: name.trim().length === 0 ? "Enter your name." : null,
    email: !EMAIL_RE.test(email.trim()) ? "Enter a full email address, like you@example.com." : null,
    password: !assessment
      ? "Choose a password."
      : !assessment.ok
        ? (assessment.problems[0] ?? "That password is not strong enough.")
        : null,
    password_confirmation:
      confirmation.length === 0
        ? "Type the password again."
        : confirmation !== password
          ? "The two passwords do not match."
          : null,
  };
  const show = (key: keyof typeof problems) =>
    (submitted || touched[key]) && problems[key] ? problems[key] : (error?.fields[key] ?? undefined);
  const blur = (key: string) => () => setTouched((t) => ({ ...t, [key]: true }));

  const submit = async () => {
    setSubmitted(true);
    if (Object.values(problems).some(Boolean)) return;
    const next = await run(() =>
      api.post<SetupState>(
        "/setup/owner",
        { name: name.trim(), email: email.trim(), password, password_confirmation: confirmation },
        { allowUnauthenticated: true },
      ),
    );
    if (next) await onAdvance(next);
  };

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={UserRound}
        title="Create your account"
        hint="The first account owns everything: every permission, on every server. You can invite other people later, with less."
      />

      <FormField label="Name" error={show("name")} required>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={blur("name")}
          autoComplete="name"
          autoFocus
          size="md"
        />
      </FormField>

      <FormField label="Email" error={show("email")} required>
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onBlur={blur("email")}
          autoComplete="username"
          size="md"
          mono
          placeholder="you@example.com"
        />
      </FormField>

      <FormField
        label="Password"
        error={submitted ? show("password") : (error?.fields.password ?? undefined)}
        description="At least 12 characters. Four unrelated words beat anything with a number on the end."
        required
      >
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          size="md"
        />
      </FormField>

      {assessment && <PasswordMeter score={assessment.score} problems={assessment.problems} />}

      <FormField label="Confirm password" error={show("password_confirmation")} required>
        <Input
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          onBlur={blur("password_confirmation")}
          autoComplete="new-password"
          size="md"
        />
      </FormField>

      <StepError error={error} exclude={["name", "email", "password", "password_confirmation"]} />

      <StepFooter primary="Create account" icon={ArrowRight} pending={pending} />
    </StepForm>
  );
}

const STRENGTH = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;

function PasswordMeter({ score, problems }: { score: number; problems: string[] }) {
  return (
    <div className="-mt-3" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-[var(--kn-dur)]",
              i < score
                ? score >= 4
                  ? "bg-[var(--kn-ok)]"
                  : score >= 3
                    ? "bg-[var(--kn-accent-500)]"
                    : "bg-[var(--kn-warn)]"
                : "bg-[var(--kn-surface-3)]",
            )}
          />
        ))}
      </div>
      <p className="mt-1.5 text-sm text-[var(--kn-text-3)]">
        {STRENGTH[Math.max(0, Math.min(4, score))]}
        {problems.length > 0 && <> — {problems.join(" ")}</>}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Instance name
 * ------------------------------------------------------------------ */

export function InstanceStep({ onAdvance, onStale }: Omit<StepProps, "state">) {
  const [value, setValue] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const { pending, error, run } = useStepAction(onStale);

  const submit = async () => {
    if (value.trim().length === 0) {
      setProblem("Give it a name — anything you will recognise, like Production.");
      return;
    }
    const next = await run(() =>
      api.post<SetupState>("/setup/instance", { instance_name: value.trim() }),
    );
    if (next) onAdvance(next);
  };

  return (
    <StepForm onSubmit={() => void submit()}>
      <StepHeading
        icon={Tag}
        title="Name this instance"
        hint="Shown in the sidebar, in the browser tab and in two-factor apps. Useful once you run more than one."
      />

      <FormField label="Name" error={problem ?? error?.fields.instance_name} required>
        <Input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
          autoFocus
          size="md"
          placeholder="Production"
          maxLength={80}
        />
      </FormField>

      <StepError error={error} exclude={["instance_name"]} />

      <StepFooter primary="Continue" icon={ArrowRight} pending={pending} />
    </StepForm>
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
  simulated?: boolean;
}

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function ServerStep({ onAdvance, onStale }: Omit<StepProps, "state">) {
  const [servers, setServers] = React.useState<SetupServer[] | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);
  const [pairing, setPairing] = React.useState<PairingInstructions | null>(null);
  const [name, setName] = React.useState("server-01");
  const [nameProblem, setNameProblem] = React.useState<string | null>(null);
  const { pending, error, run } = useStepAction(onStale);
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
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setServers((current) => current ?? []);
    }
  }, []);

  /*
   * The waiting state resolves itself. An agent enrolling publishes on
   * the servers topic, and the same stream the rest of the app runs on
   * carries it here — so nobody has to press refresh to find out
   * whether the command they pasted worked.
   */
  React.useEffect(() => {
    void load();
    const disconnect = connectEventStream({ topics: ["servers"], onMessage: () => void load() });
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      disconnect();
      window.clearInterval(timer);
    };
  }, [load]);

  // Derived from the list this step polls, not from the state the
  // previous step returned: a server that pairs while this screen is
  // open has to enable the button without a round trip.
  const registered = servers?.length ?? 0;
  const connected = (servers ?? []).filter((server) => server.connection === "connected");
  const waiting = (servers ?? []).filter((server) => server.connection !== "connected");
  const showPairForm = servers !== null && servers.length === 0 && !pairing;

  const generate = async () => {
    const trimmed = name.trim();
    if (!SERVER_NAME_RE.test(trimmed)) {
      setNameProblem("Use letters, digits, dots, dashes or underscores, starting with a letter or digit.");
      return;
    }
    setNameProblem(null);
    const issued = await run(() => api.post<PairingInstructions>("/setup/server", { name: trimmed }));
    if (issued) {
      setPairing(issued);
      void load();
    }
  };

  /*
   * A fresh command for a server that is registered but not connected:
   * the previous token expired, or was minted in a tab that is gone.
   */
  const regenerate = async (server: { id: string; name: string }) => {
    const issued = await run(() =>
      api.post<Omit<PairingInstructions, "server_name">>(`/servers/${server.id}/enroll-token`),
    );
    if (issued) setPairing({ ...issued, server_name: server.name });
  };

  const advance = async () => {
    const next = await run(() => api.post<SetupState>("/setup/server/confirm"));
    if (next) onAdvance(next);
  };

  return (
    <StepForm onSubmit={() => void (showPairForm ? generate() : advance())}>
      <StepHeading
        icon={ServerIcon}
        title="Your first server"
        hint="Kaname manages a host through a small agent that dials out from it. Nothing on the server listens inbound for Kaname."
      />

      {servers === null && <Skeleton className="h-20 rounded-[var(--kn-r-md)]" label="Looking for servers" />}

      {(connected.length > 0 || waiting.length > 0) && (
        <div className="flex flex-col gap-2">
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
        </div>
      )}

      {showPairForm && (
        <>
          <p className="text-[var(--kn-text-2)]">
            Nothing is paired yet. Name the server and Kaname will give you one command to run on it.
          </p>
          <FormField
            label="Server name"
            error={nameProblem ?? error?.fields.name}
            description="How it appears in the panel. Usually its hostname."
          >
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameProblem(null);
              }}
              size="md"
              mono
              autoFocus
              spellCheck={false}
            />
          </FormField>
        </>
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

      {listError && (
        <Note tone="warn">The server list could not be read: {listError}. Retrying every few seconds.</Note>
      )}
      <StepError error={error} exclude={["name"]} />

      <StepFooter
        primary={showPairForm ? "Get the pairing command" : "Continue"}
        icon={showPairForm ? undefined : ArrowRight}
        pending={pending}
        disabled={!showPairForm && registered === 0}
        primaryAutoFocus={!showPairForm && registered > 0}
        aside={
          registered > 0 && connected.length === 0 ? (
            <span className="text-sm text-[var(--kn-text-3)]">
              You can continue while the agent connects.
            </span>
          ) : undefined
        }
      />
    </StepForm>
  );
}

function ServerCard({ server }: { server: SetupServer }) {
  return (
    <div className="rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-surface-2)] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--kn-ok)]" aria-hidden />
        <span className="font-medium text-[var(--kn-text)]">{server.name}</span>
        <span className="truncate font-mono text-xs text-[var(--kn-text-3)]">{server.hostname}</span>
        <span className="ml-auto shrink-0 text-sm text-[var(--kn-text-3)]">
          {server.simulated ? "Connected · simulated" : "Connected"}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
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
  onRegenerate?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--kn-r-md)] border border-dashed border-[var(--kn-border-strong)] px-4 py-3">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--kn-warn)]" aria-hidden />
      <span className="font-medium text-[var(--kn-text)]">{server.name}</span>
      <span className="text-sm text-[var(--kn-text-2)]" role="status">
        Waiting for the agent to connect…
      </span>
      {onRegenerate && (
        <Button
          type="button"
          className="ml-auto"
          variant="secondary"
          size="xs"
          icon={RefreshCw}
          loading={busy}
          onClick={onRegenerate}
        >
          New command
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
      <Note tone="warn">
        The command for <span className="text-[var(--kn-text)]">{pairing.server_name}</span> expired
        before it was used. Nothing on the server changed.{" "}
        <Button type="button" variant="link" size="sm" loading={busy} onClick={onRegenerate}>
          Get a new command
        </Button>
      </Note>
    );
  }

  const minutes = Math.max(1, Math.round((Date.parse(pairing.expires_at) - now) / 60_000));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[var(--kn-text-2)]">
        Run this as root on <span className="text-[var(--kn-text)]">{pairing.server_name}</span>:
      </p>
      <div className="flex items-start gap-2 rounded-[var(--kn-r-md)] border border-[var(--kn-border)] bg-[var(--kn-bg-inset)] p-3">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-[var(--kn-text-2)]">
          {pairing.command}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          icon={copied ? Check : Copy}
          onClick={() => void copy()}
          aria-label="Copy the pairing command"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-sm text-[var(--kn-text-3)]">
        Works once and expires in about {minutes} minute{minutes === 1 ? "" : "s"}. This page updates
        by itself when the agent connects.
      </p>
    </div>
  );
}
