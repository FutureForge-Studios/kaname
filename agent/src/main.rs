//! kanamed — the Kaname agent.
//!
//! Runs as root on a managed host, dials the control plane and serves an
//! enumerated verb list over one multiplexed socket. It binds no port,
//! accepts no shell string, and holds the only private key that proves this
//! machine's identity.

mod conn;
mod enroll;
mod handlers;
mod providers;
mod registry;
mod state;
mod wire;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use clap::{Parser, Subcommand};
use tokio_util::sync::CancellationToken;

use providers::{Ctx, ProviderRef, topic};

/// Stamped by the release build through `KANAMED_VERSION`; a binary nobody
/// stamped says so rather than claiming to be a release it is not — the
/// control plane compares this string against the manifest to decide
/// whether an update landed.
pub const VERSION: &str = match option_env!("KANAMED_VERSION") {
    Some(v) => v,
    None => "0.0.0-dev",
};

const METRICS_INTERVAL: Duration = Duration::from_secs(15);
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A connection that lived this long counts as healthy, so the next failure
/// starts backing off from scratch instead of from the cap.
const BACKOFF_RESET_AFTER: Duration = Duration::from_secs(60);

#[derive(Parser)]
#[command(name = "kanamed", version = VERSION, about = "kanamed — the Kaname agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Enroll this host with a control plane using a single-use token.
    Enroll {
        /// Single-use enrollment token printed by the panel.
        #[arg(long)]
        token: String,
        /// Control plane origin, e.g. https://panel.example.com
        #[arg(long)]
        url: String,
        /// Directory holding the agent's identity.
        #[arg(long)]
        state_dir: Option<PathBuf>,
        #[arg(long, default_value = "info")]
        log_level: String,
    },
    /// Dial the control plane and serve requests (the systemd unit's command).
    Run {
        #[arg(long)]
        state_dir: Option<PathBuf>,
        /// Serve a deterministic fake host instead of this machine.
        #[arg(long)]
        simulate: bool,
        /// Simulator only: send each metrics heartbeat this many seconds
        /// late while the socket stays open and keeps answering pings. It
        /// is how the suite reaches the Degraded state (connected, but
        /// silent past the offline window) without waiting on a real fault.
        #[arg(long, value_name = "SECONDS", requires = "simulate")]
        sim_heartbeat_delay: Option<u64>,
        #[arg(long, default_value = "info")]
        log_level: String,
    },
    /// Print the version and protocol.
    Version,
}

fn main() {
    let cli = Cli::parse();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let result = runtime.block_on(async {
        match cli.command.unwrap_or(Command::Run {
            state_dir: None,
            simulate: false,
            sim_heartbeat_delay: None,
            log_level: "info".into(),
        }) {
            Command::Enroll {
                token,
                url,
                state_dir,
                log_level,
            } => {
                init_logging(&log_level)?;
                run_enroll(token, url, state_dir).await
            }
            Command::Run {
                state_dir,
                simulate,
                sim_heartbeat_delay,
                log_level,
            } => {
                init_logging(&log_level)?;
                let heartbeat = heartbeat_schedule(simulate, sim_heartbeat_delay)?;
                run_agent(state_dir, simulate, heartbeat).await
            }
            Command::Version => {
                println!(
                    "kanamed {VERSION} (protocol {}, {}/{})",
                    wire::PROTOCOL_VERSION,
                    std::env::consts::OS,
                    std::env::consts::ARCH
                );
                Ok(())
            }
        }
    });
    // Handlers that outlive the socket (a shell being torn down) must not
    // keep the process alive past the point where it decided to exit.
    runtime.shutdown_timeout(Duration::from_secs(2));
    if let Err(err) = result {
        eprintln!("kanamed: {err:#}");
        std::process::exit(1);
    }
}

fn init_logging(level: &str) -> anyhow::Result<()> {
    let level = match level.to_ascii_lowercase().as_str() {
        "trace" => "trace",
        "debug" => "debug",
        "info" => "info",
        "warn" | "warning" => "warn",
        "error" => "error",
        other => bail!("unknown log level {other:?}"),
    };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(format!("kanamed={level},warn")));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .try_init()
        .map_err(|e| anyhow::anyhow!("init logging: {e}"))?;
    Ok(())
}

/* -------------------------------- enroll ----------------------------- */

async fn run_enroll(token: String, url: String, state_dir: Option<PathBuf>) -> anyhow::Result<()> {
    let mut store = state::Store::open(state_dir.as_deref())?;
    let host = enroll::hostprobe::probe_host()?;
    enroll::run(
        &mut store,
        enroll::EnrollOptions {
            token,
            control_plane_url: url,
            agent_version: VERSION.into(),
            host,
        },
    )
    .await
}

/* ---------------------------------- run ------------------------------ */

async fn run_agent(
    state_dir: Option<PathBuf>,
    simulate: bool,
    heartbeat: HeartbeatSchedule,
) -> anyhow::Result<()> {
    // A fake fleet that can be mistaken for a real one is worse than no
    // fake fleet (KD-010).
    if simulate && std::env::var("KANAME_ENV").as_deref() == Ok("production") {
        bail!("--simulate refuses to run with KANAME_ENV=production");
    }

    let store = state::Store::open(state_dir.as_deref())?;
    if !store.enrolled() {
        bail!(
            "this host is not enrolled: run `kanamed enroll --token <token> --url <panel>` first (state dir: {})",
            store.dir().display()
        );
    }

    let name = if simulate { "sim" } else { "linux" };
    let provider = providers::open(
        name,
        providers::Options {
            agent_version: VERSION.into(),
            state_dir: store.dir().to_path_buf(),
        },
    )
    .await?;

    let capabilities = provider.capabilities();
    let registry = build_registry(&provider, &capabilities, store.dir());

    let tls = store.tls_config()?;
    let key = store.private_key()?;

    tracing::info!(
        version = VERSION,
        server_id = store.state.server_id,
        provider = name,
        capabilities = capabilities.len(),
        methods = registry.names().len(),
        connect_url = store.state.connect_url,
        "starting"
    );

    let stop = CancellationToken::new();
    let signals = stop.clone();
    tokio::spawn(async move {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
        signals.cancel();
    });

    let mut attempt = Backoff::default();
    let mut capabilities = capabilities;
    let mut registry = registry;
    while !stop.is_cancelled() {
        // Re-read each time: a deploy can add one between connections.
        let now = provider.capabilities();
        if now != capabilities {
            tracing::info!(capabilities = ?now, "capabilities changed; announcing them on this connection");
            registry = build_registry(&provider, &now, store.dir());
            capabilities = now;
        }
        let host = provider
            .host(&Ctx::background())
            .await
            .context("read host identity")?;
        let opts = conn::Options {
            server_id: store.state.server_id.clone(),
            control_plane_url: store.state.control_plane_url.clone(),
            connect_url: store.state.connect_url.clone(),
            tls: tls.clone(),
            private_key: key.clone(),
            agent_version: VERSION.into(),
            capabilities: capabilities.clone(),
            host,
            registry: registry.clone(),
        };

        let (lived, ended) = session(&stop, provider.clone(), opts, heartbeat).await;
        if stop.is_cancelled() {
            break;
        }
        let err = match ended {
            // Not a failure: reconnect at once so the new hello goes out.
            SessionEnd::CapabilitiesChanged => continue,
            SessionEnd::Failed(err) => err,
        };
        if lived >= BACKOFF_RESET_AFTER {
            attempt.reset();
        }
        let delay = attempt.next();
        tracing::warn!(error = %err, retry_in = ?delay, "disconnected");
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = stop.cancelled() => {}
        }
    }

    provider.close().await;
    tracing::info!("stopped");
    Ok(())
}

fn build_registry(
    provider: &ProviderRef,
    capabilities: &[String],
    state_dir: &std::path::Path,
) -> Arc<registry::Registry> {
    let mut registry = registry::Registry::new(registry::CapabilityGate::new(capabilities.to_vec()));
    handlers::register_handlers(&mut registry, provider.clone(), &[state_dir]);
    Arc::new(registry)
}

/// How long a connection waits after a capability change before closing,
/// so the response to the call that caused it (a deploy) reaches the
/// control plane first.
const REANNOUNCE_GRACE: Duration = Duration::from_secs(2);

enum SessionEnd {
    CapabilitiesChanged,
    Failed(anyhow::Error),
}

/// Holds one connection open until it fails, the process is asked to stop
/// or the host's capabilities change, and reports how long it lasted.
async fn session(
    stop: &CancellationToken,
    provider: ProviderRef,
    opts: conn::Options,
    heartbeat: HeartbeatSchedule,
) -> (Duration, SessionEnd) {
    let started = Instant::now();
    let url = opts.connect_url.clone();
    let conn = match conn::dial(opts).await {
        Ok(c) => c,
        Err(e) => return (started.elapsed(), SessionEnd::Failed(e)),
    };
    tracing::info!(url, "connected");

    let handle = conn.handle();
    let conn_stop = CancellationToken::new();
    let metrics = tokio::spawn(push_metrics(
        handle.clone(),
        provider.clone(),
        conn_stop.clone(),
        heartbeat,
    ));
    let events = tokio::spawn(forward_events(handle, provider.clone(), conn_stop.clone()));

    // A child of the process token: a shutdown still closes this session,
    // and a capability change closes only this one.
    let session_stop = stop.child_token();
    let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let session_stop = session_stop.clone();
        let changed = changed.clone();
        tokio::spawn(async move {
            providers::capabilities_changed().await;
            changed.store(true, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(REANNOUNCE_GRACE).await;
            session_stop.cancel();
        })
    };

    let outcome = conn.serve(session_stop).await;
    conn_stop.cancel();
    metrics.abort();
    events.abort();
    watcher.abort();
    if changed.load(std::sync::atomic::Ordering::SeqCst) && !stop.is_cancelled() {
        return (started.elapsed(), SessionEnd::CapabilitiesChanged);
    }
    let err = match outcome {
        Ok(()) => anyhow::anyhow!("closed"),
        Err(e) => e,
    };
    (started.elapsed(), SessionEnd::Failed(err))
}

/// Relays the provider's state changes onto the socket, so the control
/// plane learns a unit failed without polling for it.
async fn forward_events(handle: conn::ConnHandle, provider: ProviderRef, stop: CancellationToken) {
    let Some(events) = provider.events() else { return };
    let closed = handle.closed();
    loop {
        let mut rx = events.lock().await;
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = closed.cancelled() => return,
            event = rx.recv() => match event {
                Some(event) => {
                    drop(rx);
                    if handle.emit(event.topic, event.data).await.is_err() {
                        return;
                    }
                }
                None => return,
            }
        }
    }
}

/// Feeds the control plane's health axis. A host that cannot sample itself
/// simply stops pushing rather than tearing the connection down: metrics are
/// not why the socket exists.
async fn push_metrics(
    handle: conn::ConnHandle,
    provider: ProviderRef,
    stop: CancellationToken,
    heartbeat: HeartbeatSchedule,
) {
    let ctx = Ctx::new(stop.child_token(), None);
    // A delayed heartbeat is late from the very first one: the connect
    // itself already stamped last-seen, so an on-time first sample would
    // only move the moment the host goes quiet.
    if !heartbeat.first.is_zero() {
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tokio::time::sleep(heartbeat.first) => {}
        }
    }
    let mut ticker = tokio::time::interval(heartbeat.every);
    loop {
        match provider.system().metrics(&ctx).await {
            Ok(sample) => {
                if let Ok(value) = serde_json::to_value(&sample) {
                    if handle.emit(topic::METRICS, value).await.is_err() {
                        return;
                    }
                }
            }
            Err(providers::ProviderError::Unsupported(_)) => return,
            Err(err) => {
                if stop.is_cancelled() {
                    return;
                }
                tracing::warn!(error = %err, "metrics sample failed");
            }
        }
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = ticker.tick() => {}
        }
    }
}

/* ------------------------------ heartbeat ---------------------------- */

/// When metrics — the heartbeat the control plane's last-seen is stamped
/// from — go out: `first` after connecting, then every `every`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HeartbeatSchedule {
    first: Duration,
    every: Duration,
}

/// The normal cadence, or one made late on purpose for a simulated host.
/// Lateness is refused on a real host: there it could only hide a host
/// that is actually in trouble.
fn heartbeat_schedule(simulate: bool, delay_seconds: Option<u64>) -> anyhow::Result<HeartbeatSchedule> {
    match delay_seconds {
        None => Ok(HeartbeatSchedule {
            first: Duration::ZERO,
            every: METRICS_INTERVAL,
        }),
        Some(_) if !simulate => bail!("--sim-heartbeat-delay only applies with --simulate"),
        Some(seconds) => {
            let delay = Duration::from_secs(seconds);
            Ok(HeartbeatSchedule {
                first: delay,
                every: METRICS_INTERVAL + delay,
            })
        }
    }
}

/* -------------------------------- backoff ---------------------------- */

/// Exponential with full jitter, capped so a long outage still retries once
/// a minute rather than drifting into hours.
#[derive(Default)]
struct Backoff {
    attempt: u32,
}

impl Backoff {
    fn next(&mut self) -> Duration {
        let window = BACKOFF_BASE * 2u32.pow(self.attempt.min(6));
        let window = window.min(BACKOFF_MAX);
        self.attempt += 1;
        let half = window / 2;
        let jitter = rand::Rng::gen_range(&mut rand::thread_rng(), 0..=half.as_millis() as u64);
        half + Duration::from_millis(jitter)
    }

    fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeats_keep_the_normal_cadence_by_default() {
        let schedule = heartbeat_schedule(false, None).unwrap();
        assert_eq!(schedule.first, Duration::ZERO);
        assert_eq!(schedule.every, METRICS_INTERVAL);
        assert_eq!(heartbeat_schedule(true, None).unwrap(), schedule);
    }

    #[test]
    fn a_delayed_heartbeat_is_late_from_the_first_one() {
        let schedule = heartbeat_schedule(true, Some(600)).unwrap();
        assert_eq!(schedule.first, Duration::from_secs(600));
        assert_eq!(schedule.every, METRICS_INTERVAL + Duration::from_secs(600));
    }

    #[test]
    fn a_real_host_cannot_be_made_to_go_quiet() {
        assert!(heartbeat_schedule(false, Some(600)).is_err());
        // And the command line says so before anything starts.
        assert!(Cli::try_parse_from(["kanamed", "run", "--sim-heartbeat-delay", "600"]).is_err());
        let parsed = Cli::try_parse_from(["kanamed", "run", "--simulate", "--sim-heartbeat-delay", "600"])
            .expect("accepted with --simulate");
        match parsed.command {
            Some(Command::Run {
                simulate: true,
                sim_heartbeat_delay: Some(600),
                ..
            }) => {}
            _ => panic!("the delay did not reach the run command"),
        }
    }
}
