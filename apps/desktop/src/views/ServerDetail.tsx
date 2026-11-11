import { useState } from "react";
import { ArrowLeft, Box, Play, RotateCw, Square, SquareTerminal } from "lucide-react";
import { useApp } from "../context";
import {
  containerAction,
  getServer,
  getServerMetrics,
  listContainers,
  listProcesses,
  listServices,
  serverAddress,
  serverOs,
  serviceAction,
  type Container,
  type ContainerAction,
  type Server,
  type Service,
  type ServiceAction,
} from "../lib/api";
import { formatBytes, formatDuration, formatPercent, formatRelative } from "../lib/format";
import type { DesktopError } from "../lib/ipc";
import type { Job } from "../lib/jobs";
import { useResource } from "../lib/useResource";
import { ErrorNotice } from "../components/ErrorNotice";
import { HealthBadge, ReachBadge, StateBadge } from "../components/StatusBadges";

type DetailTab = "overview" | "services" | "containers" | "processes";

interface ServerDetailProps {
  connectionId: string;
  serverId: string;
  initial?: Server;
  onBack(): void;
}

export function ServerDetail({ connectionId, serverId, initial, onBack }: ServerDetailProps) {
  const app = useApp();
  const connection = app.connection(connectionId);
  const [tab, setTab] = useState<DetailTab>("overview");
  const server = useResource(connectionId, () => getServer(connectionId, serverId), [serverId], {
    refreshMs: 15_000,
  });
  const s = server.data ?? initial;
  const offline = s?.connection === "disconnected" || s?.connection === "never_enrolled";

  return (
    <div className="page">
      <header className="page-header with-tabs">
        <div className="page-heading">
          <button className="crumb" onClick={onBack}>
            <ArrowLeft size={13} /> Fleet
          </button>
          <h1 className="page-title">{s?.name ?? "Server"}</h1>
          <div className="page-sub mono">
            {s ? [s.hostname, s.address].filter(Boolean).join(" · ") : "…"}
          </div>
          {s && (
            <div className="card-badges">
              <ReachBadge value={s.connection} />
              <HealthBadge value={s.health} reasons={s.health_reasons} />
              {s.health_reasons?.map((r) => (
                <span key={r} className="muted small">
                  {r}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            disabled={!s || offline}
            onClick={() => s && app.openTerminal(connectionId, { serverId: s.id, serverName: s.name })}
          >
            <SquareTerminal size={14} /> Open terminal
          </button>
        </div>
        <nav className="view-tabs" role="tablist">
          {(["overview", "services", "containers", "processes"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "on" : ""}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      <div className="page-body">
        {server.error && !s && (
          <ErrorNotice error={server.error} baseUrl={connection?.base_url} onRetry={server.reload} />
        )}
        {s && tab === "overview" && <Overview connectionId={connectionId} server={s} />}
        {s && tab === "services" && <ServicesTab connectionId={connectionId} server={s} />}
        {s && tab === "containers" && <ContainersTab connectionId={connectionId} server={s} />}
        {s && tab === "processes" && <ProcessesTab connectionId={connectionId} server={s} />}
      </div>
    </div>
  );
}

/* ----------------------------- overview --------------------------- */

function Sparkline({ values, max = 100 }: { values: number[]; max?: number }) {
  if (values.length < 2) return null;
  const w = 320;
  const h = 56;
  const top = Math.max(max, ...values);
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / top) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke="var(--kn-chart-1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Overview({ connectionId, server }: { connectionId: string; server: Server }) {
  const app = useApp();
  const metrics = useResource(connectionId, () => getServerMetrics(connectionId, server.id), [server.id], {
    refreshMs: 30_000,
  });
  const cpu = (metrics.data?.samples ?? [])
    .map((x) => x.cpu_percent)
    .filter((v): v is number => typeof v === "number");
  const latest = server.latest;
  const disk = latest?.disks?.[0];
  const memPct =
    latest?.memory_used !== undefined && (latest.memory_total ?? server.memory_total)
      ? (latest.memory_used / (latest.memory_total ?? server.memory_total ?? 1)) * 100
      : null;

  return (
    <div className="overview">
      <section className="section">
        <SectionTitle index={1} title="Now" caption={latest?.sampled_at ? `sampled ${formatRelative(latest.sampled_at)}` : "no sample yet"} />
        <div className="metrics">
          <Metric label="CPU" value={formatPercent(latest?.cpu_percent)} />
          <Metric
            label="Memory"
            value={formatPercent(memPct)}
            sub={latest ? `${formatBytes(latest.memory_used)} of ${formatBytes(latest.memory_total ?? server.memory_total)}` : undefined}
          />
          <Metric label="Load 1m" value={latest?.load1 !== undefined ? latest.load1.toFixed(2) : "—"} sub={server.cpu_cores ? `${server.cpu_cores} cores` : undefined} />
          <Metric
            label={`Disk ${disk?.mount ?? "/"}`}
            value={disk?.used !== undefined && disk.total ? formatPercent((disk.used / disk.total) * 100) : "—"}
            sub={disk ? `${formatBytes(disk.used)} of ${formatBytes(disk.total)}` : undefined}
          />
          <Metric label="Uptime" value={formatDuration(server.uptime_seconds)} />
        </div>
      </section>

      <section className="section">
        <SectionTitle index={2} title="CPU, last hour" caption={cpu.length ? `${cpu.length} samples` : ""} />
        <div className="chart-card">
          {metrics.error ? (
            <ErrorNotice error={metrics.error} compact baseUrl={app.connection(connectionId)?.base_url} />
          ) : cpu.length > 1 ? (
            <Sparkline values={cpu} />
          ) : (
            <div className="muted small">{metrics.loading ? "Loading…" : "No metrics for this range."}</div>
          )}
        </div>
      </section>

      <section className="section">
        <SectionTitle index={3} title="System" />
        <dl className="kv">
          <dt>Address</dt>
          <dd className="mono">{serverAddress(server)}</dd>
          <dt>OS</dt>
          <dd>{serverOs(server)}</dd>
          <dt>Kernel</dt>
          <dd className="mono">{server.kernel ?? "—"}</dd>
          <dt>CPU</dt>
          <dd>{server.cpu_model ?? "—"}</dd>
          <dt>Arch</dt>
          <dd className="mono">{server.arch ?? "—"}</dd>
          <dt>Agent</dt>
          <dd className="mono">{server.agent_version ? `kanamed ${server.agent_version}` : "—"}</dd>
          <dt>Last seen</dt>
          <dd>{formatRelative(server.last_seen_at)}</dd>
          {server.labels && Object.keys(server.labels).length > 0 && (
            <>
              <dt>Labels</dt>
              <dd className="chips">
                {Object.entries(server.labels).map(([k, v]) => (
                  <span key={k} className="chip mono">
                    {k}={v}
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}

function SectionTitle({ index, title, caption }: { index: number; title: string; caption?: string }) {
  return (
    <div className="section-title">
      <span className="section-index mono">{String(index).padStart(2, "0")}</span>
      <span className="section-name">{title}</span>
      <span className="section-rule" />
      {caption && <span className="section-caption mono">{caption}</span>}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="metric">
      <div className="label-sm">{label}</div>
      <div className="metric-value">{value}</div>
      {sub && <div className="metric-sub mono">{sub}</div>}
    </div>
  );
}

/* --------------------------- mutations ---------------------------- */

/** Runs a host-touching action, tracks the returned job, reports errors. */
function useAction(connectionId: string) {
  const app = useApp();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<DesktopError | null>(null);

  async function run(key: string, fn: () => Promise<Job | null>) {
    setPending(key);
    setError(null);
    try {
      const job = await fn();
      if (job) app.trackJob(connectionId, job);
    } catch (err) {
      setError(app.handleError(connectionId, err));
    } finally {
      setPending(null);
    }
  }
  return { pending, error, run, clearError: () => setError(null) };
}

function ActionButtons<A extends string>({
  actions,
  pendingKey,
  rowKey,
  disabled,
  onRun,
}: {
  actions: { action: A; label: string; Icon: typeof Play; show: boolean }[];
  pendingKey: string | null;
  rowKey: string;
  disabled?: boolean;
  onRun(action: A): void;
}) {
  return (
    <>
      {actions
        .filter((a) => a.show)
        .map(({ action, label, Icon }) => (
          <button
            key={action}
            className="btn btn-ghost btn-sm"
            disabled={disabled || pendingKey !== null}
            onClick={() => onRun(action)}
            title={label}
          >
            {pendingKey === `${rowKey}:${action}` ? <RotateCw size={12} className="spin" /> : <Icon size={12} />}
            {label}
          </button>
        ))}
    </>
  );
}

/* ----------------------------- services --------------------------- */

function ServicesTab({ connectionId, server }: { connectionId: string; server: Server }) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const services = useResource(connectionId, () => listServices(connectionId, server.id), [server.id, app.jobsVersion]);
  const action = useAction(connectionId);
  const offline = server.connection === "disconnected";
  const q = query.trim().toLowerCase();
  const rows = (services.data ?? []).filter(
    (s) => !q || s.unit.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );

  const run = (s: Service, a: ServiceAction) =>
    action.run(`${s.id}:${a}`, () => serviceAction(connectionId, s.id, a));

  return (
    <ListShell
      query={query}
      setQuery={setQuery}
      placeholder="Filter units"
      count={services.data?.length}
      onReload={services.reload}
      loading={services.loading}
      error={action.error ?? services.error}
      baseUrl={app.connection(connectionId)?.base_url}
    >
      {services.data && (
        <table className="table">
          <thead>
            <tr>
              <th>Unit</th>
              <th>State</th>
              <th>Enabled</th>
              <th className="num">PID</th>
              <th className="num">Memory</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const active = s.active_state === "active" || s.active_state === "reloading";
              return (
                <tr key={s.id}>
                  <td>
                    <div className="mono">{s.unit}</div>
                    {s.description && <div className="muted small">{s.description}</div>}
                  </td>
                  <td>
                    <StateBadge value={s.active_state} />
                    {s.sub_state && s.sub_state !== s.active_state && (
                      <span className="mono muted small"> {s.sub_state}</span>
                    )}
                  </td>
                  <td className="muted">{s.enabled === undefined ? "—" : s.enabled ? "enabled" : "disabled"}</td>
                  <td className="num mono">{s.main_pid ?? "—"}</td>
                  <td className="num mono">{formatBytes(s.memory_current)}</td>
                  <td className="row-actions">
                    <ActionButtons<ServiceAction>
                      rowKey={s.id}
                      pendingKey={action.pending}
                      disabled={offline}
                      onRun={(a) => run(s, a)}
                      actions={[
                        { action: "start", label: "Start", Icon: Play, show: !active },
                        { action: "restart", label: "Restart", Icon: RotateCw, show: active },
                        { action: "stop", label: "Stop", Icon: Square, show: active },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ListShell>
  );
}

/* ---------------------------- containers -------------------------- */

function ContainersTab({ connectionId, server }: { connectionId: string; server: Server }) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const containers = useResource(connectionId, () => listContainers(connectionId, server.id), [server.id, app.jobsVersion]);
  const action = useAction(connectionId);
  const offline = server.connection === "disconnected";
  const q = query.trim().toLowerCase();
  const rows = (containers.data ?? []).filter(
    (c) => !q || c.name.toLowerCase().includes(q) || (c.image ?? "").toLowerCase().includes(q),
  );

  const run = (c: Container, a: ContainerAction) =>
    action.run(`${c.id}:${a}`, () => containerAction(connectionId, c.id, a));

  return (
    <ListShell
      query={query}
      setQuery={setQuery}
      placeholder="Filter containers"
      count={containers.data?.length}
      onReload={containers.reload}
      loading={containers.loading}
      error={action.error ?? containers.error}
      baseUrl={app.connection(connectionId)?.base_url}
    >
      {containers.data && containers.data.length === 0 && (
        <div className="empty-inline">No containers on {server.name}.</div>
      )}
      {containers.data && containers.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>State</th>
              <th className="num">CPU</th>
              <th className="num">Memory</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const running = c.state === "running" || c.state === "restarting";
              return (
                <tr key={c.id}>
                  <td>
                    <div className="mono">{c.name}</div>
                    {c.container_id && <div className="mono muted small">{c.container_id.slice(0, 12)}</div>}
                  </td>
                  <td className="mono small">{c.image ?? "—"}</td>
                  <td>
                    <StateBadge value={c.state} />
                    {c.status && <div className="muted small">{c.status}</div>}
                  </td>
                  <td className="num mono">{formatPercent(c.cpu_percent)}</td>
                  <td className="num mono">{formatBytes(c.memory_usage)}</td>
                  <td className="row-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={!running || offline}
                      title="Open a shell inside this container"
                      onClick={() =>
                        app.openTerminal(connectionId, {
                          serverId: server.id,
                          serverName: server.name,
                          containerId: c.id,
                          containerName: c.name,
                        })
                      }
                    >
                      <Box size={12} /> Shell
                    </button>
                    <ActionButtons<ContainerAction>
                      rowKey={c.id}
                      pendingKey={action.pending}
                      disabled={offline}
                      onRun={(a) => run(c, a)}
                      actions={[
                        { action: "start", label: "Start", Icon: Play, show: !running },
                        { action: "restart", label: "Restart", Icon: RotateCw, show: running },
                        { action: "stop", label: "Stop", Icon: Square, show: running },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </ListShell>
  );
}

/* ----------------------------- processes -------------------------- */

function ProcessesTab({ connectionId, server }: { connectionId: string; server: Server }) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const processes = useResource(connectionId, () => listProcesses(connectionId, server.id), [server.id], {
    refreshMs: 10_000,
  });
  const q = query.trim().toLowerCase();
  const rows = (processes.data ?? []).filter(
    (p) =>
      !q ||
      (p.command ?? "").toLowerCase().includes(q) ||
      (p.cmdline ?? "").toLowerCase().includes(q) ||
      (p.user ?? "").toLowerCase().includes(q),
  );

  return (
    <ListShell
      query={query}
      setQuery={setQuery}
      placeholder="Filter processes"
      count={processes.data?.length}
      onReload={processes.reload}
      loading={processes.loading}
      error={processes.error}
      baseUrl={app.connection(connectionId)?.base_url}
      note="Read-only, live from the agent. Refreshes every 10 s."
    >
      {processes.data && (
        <table className="table">
          <thead>
            <tr>
              <th className="num">PID</th>
              <th>User</th>
              <th>Command</th>
              <th>State</th>
              <th className="num">CPU</th>
              <th className="num">RSS</th>
              <th className="num">Threads</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid}>
                <td className="num mono">{p.pid}</td>
                <td className="mono">{p.user ?? "—"}</td>
                <td className="mono ellipsis" title={p.cmdline}>
                  {p.cmdline || p.command}
                </td>
                <td className="muted">{p.state ?? "—"}</td>
                <td className="num mono">{formatPercent(p.cpu_percent)}</td>
                <td className="num mono">{formatBytes(p.memory_rss)}</td>
                <td className="num mono">{p.threads ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ListShell>
  );
}

/* ------------------------------ shell ----------------------------- */

function ListShell({
  query,
  setQuery,
  placeholder,
  count,
  onReload,
  loading,
  error,
  baseUrl,
  note,
  children,
}: {
  query: string;
  setQuery(q: string): void;
  placeholder: string;
  count: number | undefined;
  onReload(): void;
  loading: boolean;
  error: DesktopError | null;
  baseUrl?: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="list-shell">
      <div className="list-toolbar">
        <div className="search-box">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
        </div>
        {count !== undefined && <span className="mono muted small">{count} total</span>}
        {note && <span className="muted small">{note}</span>}
        <span className="spacer" />
        <button className="icon-btn" onClick={onReload} aria-label="Refresh" title="Refresh">
          <RotateCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      {error && <ErrorNotice error={error} baseUrl={baseUrl} onRetry={onReload} />}
      {loading && count === undefined && !error && <div className="skeleton-rows" aria-label="Loading" />}
      <div className="table-wrap">{children}</div>
    </div>
  );
}
