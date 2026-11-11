"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import {
  APP_CATEGORY_LABELS,
  type AppInstallPlan,
  type AppRecipe,
  type DbEngine,
  type InstallAppInput,
} from "@kaname/contract";
import {
  Button,
  Card,
  CardInset,
  CheckItem,
  CheckList,
  ErrorState,
  FormField,
  Input,
  MonoLabel,
  NumberedSection,
  PropertyList,
  PropertyRow,
  Select,
  StatusLine,
  Switch,
} from "@kaname/ui";
import { followRemediation, type ApiError } from "@/lib/api";
import { useCan, useServers, useSession } from "@/lib/queries";
import { AppMark, versionLabel } from "./AppMark";
import { useInstallApp, usePlanInstall } from "./queries";

/* ------------------------------------------------------------------ *
 * The install flow: 01 App · 02 Where · 03 Details · 04 Review.
 *
 * One page, four numbered sections, read top to bottom — no modal
 * stepper to lose your place in. The Review section is the control
 * plane's own dry run (`POST /apps/installs/plan`): it runs every check
 * the install runs, so a refusal arrives while the form is still open,
 * and it shows the real names it will create. Any edit after a review
 * discards it; Install sends the plan id back so what you reviewed is
 * what you get.
 * ------------------------------------------------------------------ */

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ENGINE_LABELS: Record<DbEngine, string> = {
  mariadb: "MariaDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
};

interface FormState {
  server_id: string;
  domain: string;
  admin_email: string;
  ssl: boolean;
  db_engine: DbEngine | "";
}

export interface InstallWizardProps {
  app: AppRecipe;
}

export function InstallWizard({ app }: InstallWizardProps) {
  const router = useRouter();
  const can = useCan();
  const { session } = useSession();
  const servers = useServers();
  const plan = usePlanInstall();
  const install = useInstallApp();

  const [form, setForm] = React.useState<FormState>({
    server_id: "",
    domain: "",
    admin_email: session?.user?.email ?? "",
    ssl: true,
    db_engine: "",
  });
  const [touched, setTouched] = React.useState(false);
  const [reviewed, setReviewed] = React.useState<AppInstallPlan | null>(null);

  // Servers this person may install on, connected ones first.
  const serverOptions = React.useMemo(() => {
    const rows = (servers.data?.data ?? []).filter((s) => can("apps.installs:write", s.id));
    return rows
      .slice()
      .sort((a, b) => Number(b.connection === "connected") - Number(a.connection === "connected"))
      .map((s) => ({
        value: s.id,
        label: s.connection === "connected" ? s.name : `${s.name} (${s.connection})`,
      }));
  }, [servers.data, can]);

  // One server: choose it for them.
  React.useEffect(() => {
    if (!form.server_id && serverOptions.length === 1 && serverOptions[0]) {
      setForm((f) => ({ ...f, server_id: serverOptions[0]!.value }));
    }
  }, [serverOptions, form.server_id]);

  React.useEffect(() => {
    if (!form.admin_email && session?.user?.email) {
      setForm((f) => ({ ...f, admin_email: session.user!.email }));
    }
  }, [session?.user, form.admin_email]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setReviewed(null);
    plan.reset();
    install.reset();
  };

  const engines = app.requirements.database?.engines ?? [];
  const domain = form.domain.trim().toLowerCase();
  const errors = {
    server_id: form.server_id ? undefined : "Choose a server.",
    domain: DOMAIN_RE.test(domain) ? undefined : "Enter a domain such as blog.example.com.",
    admin_email: EMAIL_RE.test(form.admin_email.trim()) ? undefined : "Enter an email address.",
  };
  const valid = !errors.server_id && !errors.domain && !errors.admin_email;
  const serverFieldError =
    (plan.error ?? install.error)?.fields?.server_id ?? (touched ? errors.server_id : undefined);
  const domainFieldError =
    (plan.error ?? install.error)?.fields?.domain ?? (touched ? errors.domain : undefined);

  const input = (planId?: string): InstallAppInput => ({
    app_id: app.id,
    server_id: form.server_id,
    domain,
    admin_email: form.admin_email.trim(),
    ssl: form.ssl,
    system_user: "www-data",
    ...(form.db_engine ? { db_engine: form.db_engine } : {}),
    ...(planId ? { plan_id: planId } : {}),
  });

  const onReview = () => {
    setTouched(true);
    if (!valid) return;
    plan.mutate(input(), { onSuccess: (result) => setReviewed(result) });
  };

  const onInstall = () => {
    if (!reviewed) return;
    install.mutate(input(reviewed.plan_id), {
      onSuccess: ({ install: row }) => router.push(`/apps/installs/${row.id}`),
    });
  };

  const error: ApiError | null = install.error ?? plan.error ?? null;
  const allowed = can("apps.installs:write");

  return (
    <div className="flex flex-col gap-10">
      {/* 01 — App */}
      <NumberedSection index={1} title="App" caption="What gets installed.">
        <Card radius="xl" padding="md" className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <CardInset grid className="flex h-24 w-full shrink-0 items-center justify-center text-[var(--kn-accent-400)] sm:w-32">
            <AppMark appId={app.id} size={48} />
          </CardInset>
          <div className="min-w-0 flex-1">
            <MonoLabel size="xs" tone="muted">
              {APP_CATEGORY_LABELS[app.category]} · {versionLabel(app.version)} · {app.license}
            </MonoLabel>
            <p className="kn-title m-0 mt-1 text-lg text-[var(--kn-text)]">{app.name}</p>
            <p className="m-0 mt-1 text-sm text-[var(--kn-text-2)]">{app.description}</p>
          </div>
          <Link
            href="/apps"
            className="kn-label-sm shrink-0 self-start text-[var(--kn-text-3)] outline-none hover:text-[var(--kn-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]"
          >
            Change app
          </Link>
        </Card>
      </NumberedSection>

      {/* 02 — Where */}
      <NumberedSection index={2} title="Where" caption="The server and the address people will visit.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Server"
            required
            error={serverFieldError}
            description={
              serverOptions.length === 0 && !servers.isLoading
                ? "No server you may install on. Add or pair a server first."
                : "Where the files, the database and the website live."
            }
          >
            <Select
              value={form.server_id}
              onChange={(e) => update("server_id", e.target.value)}
              placeholder={servers.isLoading ? "Loading servers…" : "Choose a server"}
              options={serverOptions}
              data-testid="install-server"
            />
          </FormField>
          <FormField
            label="Domain"
            required
            error={domainFieldError}
            description="Point its DNS at the server first, so HTTPS can be issued."
          >
            <Input
              mono
              value={form.domain}
              onChange={(e) => update("domain", e.target.value)}
              placeholder="blog.example.com"
              autoComplete="off"
              spellCheck={false}
              data-testid="install-domain"
            />
          </FormField>
        </div>
      </NumberedSection>

      {/* 03 — Details */}
      <NumberedSection index={3} title="Details" caption="Sensible defaults; change only what you need.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Your email"
            required
            error={touched ? errors.admin_email : undefined}
            description="Let's Encrypt writes here before a certificate would expire."
          >
            <Input
              type="email"
              value={form.admin_email}
              onChange={(e) => update("admin_email", e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </FormField>
          {engines.length > 1 && (
            <FormField
              label="Database"
              description="Leave on automatic to use the first one the server runs."
            >
              <Select
                value={form.db_engine}
                onChange={(e) => update("db_engine", e.target.value as DbEngine | "")}
                options={[
                  { value: "", label: "Automatic" },
                  ...engines.map((engine) => ({ value: engine, label: ENGINE_LABELS[engine] })),
                ]}
              />
            </FormField>
          )}
          <div className="sm:col-span-2">
            <Switch
              checked={form.ssl}
              onChange={(e) => update("ssl", e.target.checked)}
              label="Secure it with HTTPS"
              description="Issue a free Let's Encrypt certificate and renew it automatically."
            />
          </div>
        </div>
      </NumberedSection>

      {/* 04 — Review */}
      <NumberedSection
        index={4}
        title="Review"
        caption="Checked against the server before anything is created."
      >
        {error && (
          <ErrorState
            code={error.code}
            message={error.message}
            remediation={error.remediation}
            onAction={(action) => followRemediation(action)}
          />
        )}

        {reviewed ? (
          <ReviewCard plan={reviewed} />
        ) : (
          <Card radius="xl" padding="md" flat>
            <StatusLine tone="info">
              Review checks the server, the domain and the database engine, and shows the names
              Kaname will use. Nothing is created yet.
            </StatusLine>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {reviewed ? (
            <>
              <Button
                variant="primary"
                size="lg"
                arrow
                loading={install.isPending}
                disabled={!allowed}
                onClick={onInstall}
                data-testid="install-submit"
              >
                Install {app.name}
              </Button>
              <Button size="lg" onClick={onReview} loading={plan.isPending}>
                Check again
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="lg"
              arrow
              loading={plan.isPending}
              disabled={!allowed}
              onClick={onReview}
              data-testid="install-review"
            >
              Review
            </Button>
          )}
          {!allowed && (
            <StatusLine tone="warn">Your role cannot install apps.</StatusLine>
          )}
        </div>
      </NumberedSection>
    </div>
  );
}

function ReviewCard({ plan }: { plan: AppInstallPlan }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="install-plan">
      <Card radius="xl" padding="md" className="min-w-0">
        <MonoLabel size="xs" tone="muted">
          What will be created
        </MonoLabel>
        <PropertyList dense labelWidth="sm" className="mt-2">
          <PropertyRow label="Address" mono>
            {plan.url}
          </PropertyRow>
          <PropertyRow label="Server">{plan.server_name}</PropertyRow>
          <PropertyRow label="Files" mono>
            {plan.webroot}
          </PropertyRow>
          {plan.database && (
            <PropertyRow label="Database" mono>
              {plan.database} · {plan.db_engine}
            </PropertyRow>
          )}
          {plan.db_user && (
            <PropertyRow label="DB user" mono>
              {plan.db_user}
            </PropertyRow>
          )}
        </PropertyList>
        {plan.notices.length > 0 && (
          <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
            {plan.notices.map((notice) => (
              <li key={notice} className="flex gap-2 text-sm text-[var(--kn-text-2)]">
                <Info size={14} className="mt-0.5 shrink-0 text-[var(--kn-info)]" aria-hidden />
                <span>{notice}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card radius="xl" padding="md" className="min-w-0">
        <MonoLabel size="xs" tone="muted">
          {plan.steps.length} steps, in one job
        </MonoLabel>
        <CheckList divided="between" className="mt-1">
          {plan.steps.map((step) => (
            <CheckItem key={step.id} state="todo" title={step.title} description={step.description} />
          ))}
        </CheckList>
      </Card>
    </div>
  );
}
